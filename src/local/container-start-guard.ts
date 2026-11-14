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
 *   and returns its id so the cleanup removes it. When the run fails — a ^C
 *   from a terminal reaches the `docker` child too, and can kill it after the
 *   daemon created the container but before the id was printed — it removes
 *   the container by the run's `name` instead.
 * - a run that would START after the shutdown began: the cleanup has already
 *   looked for containers, so {@link ContainerStartGuard.run} refuses it.
 *
 * `stop()` must be called SYNCHRONOUSLY at the start of the cleanup, before
 * its first `await`, so no `run()` can slip in between.
 */
export interface ContainerStartGuard {
  /**
   * Start a container via `start` unless the shutdown has begun. `name` is
   * the `--name` the run passes to docker, if any.
   */
  run(start: () => Promise<string>, name?: string): Promise<string>;
  /**
   * Mark the shutdown begun, then wait for a run in flight. Resolves its
   * container id, or `undefined` when nothing was in flight or the run failed.
   * Never rejects.
   */
  stop(): Promise<string | undefined>;
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
  let inFlight: { promise: Promise<string>; name: string | undefined } | undefined;
  return {
    async run(start, name) {
      if (stopping) {
        throw new CdkLocalError(
          'Shutting down: the container was not started.',
          options.cancelledCode
        );
      }
      const entry = { promise: start(), name };
      inFlight = entry;
      try {
        return await entry.promise;
      } finally {
        if (inFlight === entry) inFlight = undefined;
      }
    },
    async stop() {
      stopping = true;
      const entry = inFlight;
      if (!entry) return undefined;
      try {
        return await entry.promise;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (entry.name !== undefined && !NAME_CONFLICT.test(message)) {
          try {
            await remove(entry.name);
          } catch {
            // Best effort: no container by that name is the usual outcome.
          }
        }
        return undefined;
      }
    },
  };
}
