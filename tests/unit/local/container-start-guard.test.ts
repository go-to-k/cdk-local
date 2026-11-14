import { describe, expect, it, vi } from 'vite-plus/test';
import { createContainerStartGuard } from '../../../src/local/container-start-guard.js';

// go-to-k/cdk-local#972: the cleanup of a command whose signal handler is armed
// before `docker run` learns the id of a run still in flight, and no run may
// start once that cleanup has looked.

function setup() {
  const removed: string[] = [];
  const guard = createContainerStartGuard({
    cancelledCode: 'TEST_CANCELLED',
    remove: vi.fn(async (n: string) => {
      removed.push(n);
    }),
  });
  return { guard, removed };
}

describe('createContainerStartGuard', () => {
  it('stop() with nothing in flight resolves undefined and removes nothing', async () => {
    const { guard, removed } = setup();
    await expect(guard.stop()).resolves.toBeUndefined();
    expect(removed).toEqual([]);
  });

  it('a finished run is not in flight any more', async () => {
    const { guard } = setup();
    await expect(guard.run(async () => 'cid', 'n')).resolves.toBe('cid');
    await expect(guard.stop()).resolves.toBeUndefined();
  });

  it('stop() waits for a run in flight, returns its id, and the run itself is refused', async () => {
    const { guard, removed } = setup();
    let finish!: (id: string) => void;
    const run = guard.run(() => new Promise<string>((r) => (finish = r)), 'n');
    const stopped = guard.stop();
    finish('cid');
    await expect(stopped).resolves.toBe('cid');
    // The cleanup owns the container now: the caller must not go on to use it.
    await expect(run).rejects.toMatchObject({ code: 'TEST_CANCELLED' });
    expect(removed).toEqual([]);
  });

  it('a run that fails after stop() is removed by its name', async () => {
    const { guard, removed } = setup();
    let fail!: (e: Error) => void;
    const run = guard.run(() => new Promise<string>((_r, j) => (fail = j)), 'cdkl-x-1-abc');
    const stopped = guard.stop();
    fail(new Error('docker run failed: killed'));
    await expect(stopped).resolves.toBeUndefined();
    await expect(run).rejects.toThrow('killed');
    expect(removed).toEqual(['cdkl-x-1-abc']);
  });

  it('a run refused for a NAME CONFLICT never removes the container holding that name', async () => {
    const { guard, removed } = setup();
    let fail!: (e: Error) => void;
    const run = guard.run(() => new Promise<string>((_r, j) => (fail = j)), 'cdkl-x-1-abc');
    const stopped = guard.stop();
    fail(
      new Error(
        'docker run failed: Conflict. The container name "/cdkl-x-1-abc" is already in use by container "f00".'
      )
    );
    await expect(stopped).resolves.toBeUndefined();
    await expect(run).rejects.toThrow('Conflict');
    expect(removed).toEqual([]);
  });

  it('an unnamed failed run removes nothing', async () => {
    const { guard, removed } = setup();
    let fail!: (e: Error) => void;
    const run = guard.run(() => new Promise<string>((_r, j) => (fail = j)));
    const stopped = guard.stop();
    fail(new Error('boom'));
    await expect(stopped).resolves.toBeUndefined();
    await expect(run).rejects.toThrow('boom');
    expect(removed).toEqual([]);
  });

  it('refuses a run after stop() without calling start', async () => {
    const { guard } = setup();
    await guard.stop();
    const start = vi.fn(async () => 'cid');
    await expect(guard.run(start, 'n')).rejects.toMatchObject({ code: 'TEST_CANCELLED' });
    expect(start).not.toHaveBeenCalled();
  });

  // go-to-k/cdk-local#973: a container pool has several runs in flight at once.
  it('stopAll() waits for EVERY run in flight: ids of the ones that succeeded, the failed one removed by name', async () => {
    const { guard, removed } = setup();
    let finishA!: (id: string) => void;
    let failB!: (e: Error) => void;
    let finishC!: (id: string) => void;
    const a = guard.run(() => new Promise<string>((r) => (finishA = r)), 'cdkl-a');
    const b = guard.run(() => new Promise<string>((_r, j) => (failB = j)), 'cdkl-b');
    const c = guard.run(() => new Promise<string>((r) => (finishC = r)), 'cdkl-c');
    const stopped = guard.stopAll();
    finishC('cid-c');
    failB(new Error('docker run failed: killed'));
    finishA('cid-a');
    await expect(stopped).resolves.toEqual(['cid-a', 'cid-c']);
    expect(removed).toEqual(['cdkl-b']);
    for (const run of [a, c]) await expect(run).rejects.toMatchObject({ code: 'TEST_CANCELLED' });
    await expect(b).rejects.toThrow('killed');
    const late = vi.fn(async () => 'cid-d');
    await expect(guard.run(late, 'cdkl-d')).rejects.toMatchObject({ code: 'TEST_CANCELLED' });
    expect(late).not.toHaveBeenCalled();
  });

  // #973: the `docker` child can die from the terminal's ^C BEFORE an owner's
  // cleanup reaches `stop()` (a pool is disposed only after its server closed).
  it('a run that fails with no shutdown begun is removed by its name before it rejects', async () => {
    const { guard, removed } = setup();
    await expect(
      guard.run(() => Promise.reject(new Error('docker run failed: killed')), 'cdkl-x-1-abc')
    ).rejects.toThrow('killed');
    expect(removed).toEqual(['cdkl-x-1-abc']);
    await expect(guard.stopAll()).resolves.toEqual([]);
  });
});
