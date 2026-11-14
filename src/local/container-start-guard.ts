import { CdkLocalError } from '../utils/error-handler.js';
import { removeContainer } from './docker-runner.js';

/**
 * The window between a command's first step and the moment its container id
 * is known (go-to-k/cdk-local#972). A command that registers its SIGINT /
 * SIGTERM handler before synth / build / `docker run` needs two things the
 * handler alone cannot give it:
 *
 * - a `docker run` still in flight when the shutdown starts: the cleanup has
 *   no id yet, and if the process exits now the daemon still creates (and
 *   starts) the container. {@link ContainerStartGuard.stop} waits for that run
 *   and returns its id so the cleanup removes it.
 * - a `docker run` that FAILS: a ^C from a terminal reaches the `docker` child
 *   too, and can kill it after the daemon created the container but before
 *   the id was printed. {@link ContainerStartGuard.run} then removes the
 *   container by the run's `name` before it rejects, and `stop()` waits for
 *   that removal. This is not tied to the shutdown having begun: the child can
 *   die before the cleanup of an owner that reaches its guard only after other
 *   awaits (a `start-api` pool, an ALB Lambda target, go-to-k/cdk-local#973)
 *   looked, and a `docker run -d` that fails after the create leaves a
 *   `Created` container behind anyway.
 * - a run that would START after the shutdown began: the cleanup has already
 *   looked for containers, so {@link ContainerStartGuard.run} refuses it.
 *
 * `stop()` must be called SYNCHRONOUSLY at the start of the cleanup, before
 * its first `await`, so no `run()` can slip in between.
 */
export interface ContainerStartGuard {
  /**
   * Start a container via `start` unless the shutdown has begun. `name` is
   * the `--name` the run passes to docker, if any. Rejects when the shutdown
   * began before the run or while it was in flight (the cleanup then owns
   * the container). A failed run's container is removed by `name` before
   * this rejects, except on a name-conflict refusal.
   */
  run(start: () => Promise<string>, name?: string): Promise<string>;
  /**
   * Mark the shutdown begun, then wait for a run in flight. Resolves its
   * container id, or `undefined` when nothing was in flight or the run failed.
   * Never rejects. For a command with at most one run in flight.
   */
  stop(): Promise<string | undefined>;
  /**
   * {@link stop} for an owner with several runs in flight at once (a
   * `start-api` container pool, go-to-k/cdk-local#973): waits for EVERY run
   * in flight and resolves the ids of those that succeeded. Never rejects.
   */
  stopAll(): Promise<string[]>;
}

export interface ContainerStartGuardOptions {
  /** The error code of the refusal a run gets once the shutdown began. */
  cancelledCode: string;
  /** Test seam; defaults to `removeContainer` (`docker rm -f`). */
  remove?: (nameOrId: string) => Promise<void>;
}

/**
 * A `docker run` refused because the NAME is already taken: the container
 * holding it is not this run's, so it must never be removed by that name.
 */
const NAME_CONFLICT = /is already (?:in use|used) by|Conflict\. The container name/;

export function createContainerStartGuard(
  options: ContainerStartGuardOptions
): ContainerStartGuard {
  const remove = options.remove ?? removeContainer;
  let stopping = false;
  // Each run in flight, as the promise of its outcome: the id, or `undefined`
  // once a failed run's by-name removal has finished.
  const inFlight = new Set<Promise<string | undefined>>();
  const cancelled = (): CdkLocalError =>
    new CdkLocalError('Shutting down: the container is not used.', options.cancelledCode);
  const stopAll = async (): Promise<string[]> => {
    stopping = true;
    const ids = await Promise.all([...inFlight]);
    return ids.filter((id): id is string => id !== undefined);
  };
  return {
    async run(start, name) {
      if (stopping) throw cancelled();
      const started = start();
      const outcome = started.then(
        (id) => id,
        async (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // A name-conflict refusal: the name belongs to someone else.
          if (name !== undefined && !NAME_CONFLICT.test(message)) {
            try {
              await remove(name);
            } catch {
              // Best effort: no container by that name is the usual outcome.
            }
          }
          return undefined;
        }
      );
      inFlight.add(outcome);
      try {
        const id = await started;
        // The shutdown began while `docker run` was in flight: `stop()` hands
        // this id to the cleanup; the caller must not go on to use the
        // container (an invoke would run the handler after the ^C).
        if (stopping) throw cancelled();
        return id;
      } catch (err) {
        await outcome;
        throw err;
      } finally {
        inFlight.delete(outcome);
      }
    },
    async stop() {
      return (await stopAll())[0];
    },
    stopAll,
  };
}
