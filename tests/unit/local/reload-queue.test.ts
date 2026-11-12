import { describe, it, expect, vi } from 'vite-plus/test';

import { createReloadQueue, stopWatchReloads } from '../../../src/local/reload-queue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A `run` whose every call blocks until the test releases it. */
function gatedRun(): {
  run: (paths: readonly string[], signal: AbortSignal) => Promise<void>;
  calls: Array<{ paths: readonly string[]; signal: AbortSignal; release: () => void }>;
} {
  const calls: Array<{ paths: readonly string[]; signal: AbortSignal; release: () => void }> = [];
  return {
    calls,
    run: (paths, signal) => {
      const d = deferred();
      calls.push({ paths, signal, release: d.resolve });
      return d.promise;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('createReloadQueue', () => {
  it('runs a firing at once when idle', async () => {
    const g = gatedRun();
    const q = createReloadQueue({ run: g.run });
    q.schedule(['a']);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]!.paths).toEqual(['a']);
    g.calls[0]!.release();
    await q.idle();
    expect(g.calls).toHaveLength(1);
  });

  it('coalesces every firing during a reload into ONE follow-up run with the union of paths', async () => {
    const g = gatedRun();
    const onCoalesced = vi.fn();
    const q = createReloadQueue({ run: g.run, onCoalesced });
    q.schedule(['a']);
    for (let i = 0; i < 50; i++) q.schedule([`f${i % 3}`, 'shared']);
    expect(g.calls).toHaveLength(1);
    expect(onCoalesced).toHaveBeenCalledTimes(49);
    g.calls[0]!.release();
    await flush();
    expect(g.calls).toHaveLength(2);
    expect([...g.calls[1]!.paths].sort()).toEqual(['f0', 'f1', 'f2', 'shared']);
    g.calls[1]!.release();
    await q.idle();
    expect(g.calls).toHaveLength(2);
  });

  it('keeps going after a run throws, reporting the error', async () => {
    const onError = vi.fn();
    let n = 0;
    const q = createReloadQueue({
      run: async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
      },
      onError,
    });
    q.schedule(['a']);
    q.schedule(['b']);
    await q.idle();
    expect(n).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('boom');
  });

  it('a run that throws synchronously does not wedge the queue', async () => {
    let n = 0;
    const onError = vi.fn();
    const q = createReloadQueue({
      run: ((): Promise<void> => {
        n += 1;
        throw new Error('sync');
      }) as never,
      onError,
    });
    q.schedule(['a']);
    await q.idle();
    q.schedule(['b']);
    await q.idle();
    expect(n).toBe(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('stop() drops the pending batch, aborts the in-flight signal, and resolves only once the in-flight run settles', async () => {
    const g = gatedRun();
    const q = createReloadQueue({ run: g.run });
    q.schedule(['a']);
    q.schedule(['b']);
    q.schedule(['c']);
    let stopped = false;
    const stopping = q.stop().then(() => {
      stopped = true;
    });
    expect(q.stopped).toBe(true);
    expect(g.calls[0]!.signal.aborted).toBe(true);
    await flush();
    expect(stopped).toBe(false);
    g.calls[0]!.release();
    await stopping;
    expect(stopped).toBe(true);
    // The pending b/c batch never ran.
    expect(g.calls).toHaveLength(1);
  });

  it('ignores firings after stop()', async () => {
    const run = vi.fn(async () => undefined);
    const q = createReloadQueue({ run });
    await q.stop();
    q.schedule(['a']);
    await q.idle();
    expect(run).not.toHaveBeenCalled();
  });

  it('stop() resolves at once when idle and is idempotent', async () => {
    const q = createReloadQueue({ run: async () => undefined });
    await q.stop();
    await q.stop();
    expect(q.stopped).toBe(true);
  });

  it('stop() during a run that throws still resolves', async () => {
    const d = deferred();
    const q = createReloadQueue({
      run: async () => {
        await d.promise;
        throw new Error('late');
      },
    });
    q.schedule(['a']);
    const stopping = q.stop();
    d.resolve();
    await expect(stopping).resolves.toBeUndefined();
  });
});

describe('stopWatchReloads (the shutdown stage before container teardown)', () => {
  it('closes the watcher first, then cancels, and resolves only after the in-flight reload — the teardown runs last', async () => {
    const order: string[] = [];
    const g = gatedRun();
    const q = createReloadQueue({
      run: async (paths, signal) => {
        order.push(`run:${paths.join(',')}`);
        await g.run(paths, signal);
        order.push(`run-done:aborted=${signal.aborted}`);
      },
    });
    const watcher = {
      close: vi.fn(async () => {
        order.push('watcher.close');
      }),
    };
    q.schedule(['a']);
    q.schedule(['b']); // pending, must never run
    const stopping = stopWatchReloads({ watcher, queue: q }).then(() => order.push('teardown'));
    await flush();
    expect(order).toEqual(['run:a', 'watcher.close']);
    g.calls[0]!.release();
    await stopping;
    expect(order).toEqual(['run:a', 'watcher.close', 'run-done:aborted=true', 'teardown']);
  });

  it('a watcher.close() failure is reported and does not block the drain', async () => {
    const onWatcherCloseError = vi.fn();
    const q = createReloadQueue({ run: async () => undefined });
    await stopWatchReloads({
      watcher: { close: async () => Promise.reject(new Error('EMFILE')) },
      queue: q,
      onWatcherCloseError,
    });
    expect(onWatcherCloseError).toHaveBeenCalledTimes(1);
    expect(q.stopped).toBe(true);
  });

  it('is a no-op without a watcher or queue (a run without --watch)', async () => {
    await expect(stopWatchReloads({ watcher: undefined, queue: undefined })).resolves.toBeUndefined();
  });
});
