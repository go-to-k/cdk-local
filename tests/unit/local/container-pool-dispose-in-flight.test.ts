import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ContainerSpec } from '../../../src/local/container-pool.js';

// go-to-k/cdk-local#973: `start-api --warm` pre-warms (and a request
// cold-starts) through the pool, so a signal's `dispose()` can land while a
// `docker run` is in flight. Its container must not outlive the dispose.

const { runDetachedMock, removeContainerMock, waitForRieReadyMock } = vi.hoisted(() => ({
  runDetachedMock: vi.fn(),
  removeContainerMock: vi.fn(),
  waitForRieReadyMock: vi.fn(),
}));

vi.mock('../../../src/local/docker-runner.js', () => ({
  runDetached: runDetachedMock,
  pickFreePort: vi.fn(async () => 40001),
  removeContainer: removeContainerMock,
  streamLogs: vi.fn(() => () => undefined),
}));
vi.mock('../../../src/local/rie-client.js', () => ({ waitForRieReady: waitForRieReadyMock }));
vi.mock('../../../src/local/runtime-image.js', () => ({
  resolveRuntimeImage: vi.fn(() => 'public.ecr.aws/lambda/nodejs:20'),
  resolveRuntimeCodeMountPath: vi.fn(() => '/var/task'),
}));

const { createContainerPool } = await import('../../../src/local/container-pool.js');

function spec(logicalId: string): ContainerSpec {
  return {
    kind: 'zip',
    lambda: { logicalId, runtime: 'nodejs20.x', handler: 'index.handler', architecture: 'x86_64' },
    codeDir: '/tmp/code',
    env: {},
    containerHost: '127.0.0.1',
  } as unknown as ContainerSpec;
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe('container pool dispose() with a `docker run` in flight (#973)', () => {
  beforeEach(() => {
    runDetachedMock.mockReset();
    removeContainerMock.mockReset().mockResolvedValue(undefined);
    waitForRieReadyMock.mockReset().mockResolvedValue(undefined);
  });

  it('waits for every run in flight and removes the containers they return', async () => {
    const finishes: Array<(id: string) => void> = [];
    runDetachedMock.mockImplementation(() => new Promise<string>((r) => finishes.push(r)));
    const pool = createContainerPool(new Map([['A', spec('A')], ['B', spec('B')]]), {
      perLambdaConcurrency: 2,
      streamLogs: false,
    });
    // The `--warm` pre-warm: one acquire per Lambda, in parallel.
    const warm = Promise.allSettled([pool.acquire('A'), pool.acquire('B')]);
    await until(() => finishes.length === 2);
    const disposed = pool.dispose();
    finishes[0]!('cid-a');
    finishes[1]!('cid-b');
    await disposed;
    expect(removeContainerMock.mock.calls.map((c) => c[0]).sort()).toEqual(['cid-a', 'cid-b']);
    // The interrupted acquires never hand a container out.
    for (const r of await warm) expect(r.status).toBe('rejected');
    expect(waitForRieReadyMock).not.toHaveBeenCalled();
  });

  it('a run that fails after dispose() began is removed by its cdkl- name', async () => {
    let fail!: (e: Error) => void;
    runDetachedMock.mockImplementation(() => new Promise<string>((_r, j) => (fail = j)));
    const pool = createContainerPool(new Map([['A', spec('A')]]), {
      perLambdaConcurrency: 2,
      streamLogs: false,
    });
    const acquiring = pool.acquire('A').catch((e: unknown) => e);
    await until(() => runDetachedMock.mock.calls.length === 1);
    const name = runDetachedMock.mock.calls[0]![0].name as string;
    const disposed = pool.dispose();
    fail(new Error('docker run failed: exit signal SIGINT'));
    await disposed;
    await acquiring;
    expect(name).toMatch(/^cdkl-A-\d+-\d+$/);
    expect(removeContainerMock.mock.calls.map((c) => c[0])).toEqual([name]);
  });

  it('refuses to start a container once dispose() began', async () => {
    const pool = createContainerPool(new Map([['A', spec('A')]]), {
      perLambdaConcurrency: 2,
      streamLogs: false,
    });
    await pool.dispose();
    await expect(pool.acquire('A')).rejects.toThrow('disposed');
    expect(runDetachedMock).not.toHaveBeenCalled();
  });

  it('a container still in its RIE wait when the in-flight-start wait times out is removed by id', async () => {
    runDetachedMock.mockResolvedValue('cid-booting');
    waitForRieReadyMock.mockImplementation(() => new Promise<void>(() => undefined));
    const pool = createContainerPool(new Map([['A', spec('A')]]), {
      perLambdaConcurrency: 2,
      streamLogs: false,
    });
    void pool.acquire('A').catch(() => undefined);
    await until(() => waitForRieReadyMock.mock.calls.length === 1);
    vi.useFakeTimers();
    try {
      const disposed = pool.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      await disposed;
    } finally {
      vi.useRealTimers();
    }
    expect(removeContainerMock.mock.calls.map((c) => c[0])).toEqual(['cid-booting']);
  });
});
