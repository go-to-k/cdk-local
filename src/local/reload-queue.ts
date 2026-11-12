/**
 * Serializes and coalesces `--watch` reloads, and lets shutdown cancel them
 * (issue #882).
 *
 * Every `--watch` runner used to chain each watcher firing onto the previous
 * reload (`chain = chain.then(reload)`). A watched directory that keeps
 * changing while a reload runs (an app writing its own log file into the
 * project, a build tool emitting output) queued one reload per firing, without
 * bound, and the shutdown path awaited that whole chain: a SIGTERM kept the
 * process booting shadow generations for minutes after `Stopping...` printed.
 *
 * This queue holds AT MOST one reload in flight plus ONE pending batch. A
 * firing that lands while a reload runs merges its paths into the pending
 * batch (union, so a classifier sees every path that changed), and the batch
 * runs once the in-flight reload settles.
 *
 * {@link ReloadQueue.stop} is the shutdown half: it refuses new firings, drops
 * the pending batch, aborts the {@link AbortSignal} the in-flight reload was
 * given (a reload checks it between steps and bails before any further Docker
 * work), and resolves once that in-flight reload has settled. A runner calls
 * it after closing the watcher and BEFORE tearing down containers, so the
 * teardown sees the final container set and no reload starts after it.
 */

export interface ReloadQueue {
  /**
   * Request a reload for the paths of one watcher firing. Runs at once when
   * idle; otherwise merges into the single pending batch. A no-op after
   * {@link ReloadQueue.stop}.
   */
  schedule(changedPaths: readonly string[]): void;
  /**
   * Stop for shutdown: refuse new firings, drop the pending batch, abort the
   * in-flight reload's signal, and resolve when that reload has settled.
   * Idempotent; never rejects.
   */
  stop(): Promise<void>;
  /** Resolve when nothing is running and nothing is pending. Never rejects. */
  idle(): Promise<void>;
  /** True once {@link ReloadQueue.stop} has been called. */
  readonly stopped: boolean;
}

export interface ReloadQueueOptions {
  /**
   * The reload body. `signal` aborts when shutdown starts: check
   * `signal.aborted` between steps and return before starting further work.
   */
  run: (changedPaths: readonly string[], signal: AbortSignal) => Promise<void>;
  /** Called with a throw / rejection from `run`. The queue keeps going. */
  onError?: (err: unknown) => void;
  /** Called when a firing merges into an already-pending batch. */
  onCoalesced?: (pendingPathCount: number) => void;
}

/**
 * The first stage of every `--watch` runner's shutdown: close the watcher
 * (its `closed` latch is set synchronously, so no new firing reaches the
 * queue), then stop the queue (drop the pending batch, abort the in-flight
 * reload), and resolve once both have settled. Only then may the caller tear
 * down containers, forwarders and networks: the in-flight reload's container
 * swaps are finished, and no reload can start after the teardown.
 */
export async function stopWatchReloads(args: {
  watcher: { close(): Promise<void> } | undefined;
  queue: ReloadQueue | undefined;
  onWatcherCloseError?: (err: unknown) => void;
}): Promise<void> {
  const closing = args.watcher
    ? args.watcher.close().catch((err: unknown) => args.onWatcherCloseError?.(err))
    : Promise.resolve();
  const draining = args.queue ? args.queue.stop() : Promise.resolve();
  await closing;
  await draining;
}

export function createReloadQueue(options: ReloadQueueOptions): ReloadQueue {
  const abort = new AbortController();
  let stopped = false;
  let running: Promise<void> | undefined;
  let pending: Set<string> | undefined;

  const start = (paths: readonly string[]): void => {
    // The body always yields at its first `await` (a synchronous throw from
    // `run` becomes a rejection of the inner async call), so `running` is
    // assigned before the body's final `running = undefined`.
    running = (async () => {
      let next: readonly string[] | undefined = paths;
      while (next) {
        const batch: readonly string[] = next;
        try {
          await (async () => options.run(batch, abort.signal))();
        } catch (err) {
          options.onError?.(err);
        }
        next = !stopped && pending ? [...pending] : undefined;
        pending = undefined;
      }
      running = undefined;
    })();
  };

  const idle = async (): Promise<void> => {
    // `running` is reassigned when the pending batch starts, so re-check after
    // each settle until the queue is drained.
    while (running) await running;
  };

  return {
    schedule(changedPaths) {
      if (stopped) return;
      if (!running) {
        start(changedPaths);
        return;
      }
      const wasPending = pending !== undefined;
      pending ??= new Set<string>();
      for (const p of changedPaths) pending.add(p);
      if (wasPending) options.onCoalesced?.(pending.size);
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        pending = undefined;
        abort.abort();
      }
      await idle();
    },
    idle,
    get stopped() {
      return stopped;
    },
  };
}
