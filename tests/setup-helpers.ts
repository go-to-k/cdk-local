/// <reference types="node" />

/**
 * Pure, side-effect-free helpers used by `tests/setup.ts` to make a reused
 * vitest forks worker tear down cleanly (issue #402). Kept in their own module
 * so they can be unit-tested with a fake process / globals bag WITHOUT
 * signalling the real worker process (which would kill the test run) and
 * WITHOUT re-triggering `tests/setup.ts`'s global side effects on import.
 */

/** The minimal `process`-shaped surface these helpers touch. */
export interface SignalProcessLike {
  exit: (code?: number) => never;
  prependListener: (signal: string, listener: (...args: unknown[]) => void) => unknown;
  listeners: (signal: string) => Array<(...args: unknown[]) => void>;
  removeListener: (signal: string, listener: (...args: unknown[]) => void) => unknown;
}

/** Worker-global keys (stashed on `globalThis`, shared across files in a worker). */
export const REAL_EXIT_KEY = '__cdk_local_test_original_exit__';
export const FAST_TERMINATE_KEY = '__cdk_local_test_fast_terminate__';

/** Signals tinypool / a Ctrl-C may use to terminate a worker. */
export const TERMINATE_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

type GlobalsBag = Record<string, unknown>;

/**
 * Capture the REAL `process.exit` ONCE per worker.
 *
 * setupFiles re-run per test file (vitest isolates the module registry), but
 * `process` is a true global shared across files in the reused worker — so on
 * the 2nd+ file `process.exit` is ALREADY the no-op installed by the 1st file.
 * Stash the genuine exit on a worker-global the first time only, and read it
 * back everywhere so the fast-terminate guard never calls the no-op.
 */
export function resolveRealExit(
  globals: GlobalsBag,
  proc: Pick<SignalProcessLike, 'exit'>
): (code?: number) => never {
  if (typeof globals[REAL_EXIT_KEY] !== 'function') {
    globals[REAL_EXIT_KEY] = proc.exit;
  }
  return globals[REAL_EXIT_KEY] as (code?: number) => never;
}

/**
 * Install a fast-terminate guard, PREPENDED so it runs FIRST on SIGTERM /
 * SIGINT and exits immediately via the supplied real (un-stubbed) exit.
 *
 * tinypool terminates a REUSED forks worker by sending it SIGTERM
 * (`ProcessWorker.terminate()` -> `child.kill()`). CLI command actions
 * exercised by unit tests register graceful-shutdown
 * `process.on('SIGTERM' | 'SIGINT', ...)` handlers (docker / server / front-door
 * teardown) that never resolve under mocks. A registered SIGTERM listener
 * SUPPRESSES Node's default terminate-on-signal, so at worker teardown the
 * leftover graceful handler runs and stalls — vitest reports "Timeout
 * terminating forks worker" and fails an otherwise-green suite.
 *
 * Running first + exiting beats every leftover handler to the punch. Installed
 * once per worker (guarded on a worker-global, since setupFiles re-run per
 * file) and the SAME function object is reused across files so
 * {@link pruneForeignSignalListeners} can tell it apart from foreign handlers.
 * Returns the stable guard function.
 */
export function installTerminateGuard(
  globals: GlobalsBag,
  proc: SignalProcessLike,
  realExit: (code?: number) => never
): (...args: unknown[]) => void {
  const existing = globals[FAST_TERMINATE_KEY] as ((...args: unknown[]) => void) | undefined;
  if (existing) {
    return existing;
  }

  const fastTerminate = (): void => {
    realExit(0);
  };
  globals[FAST_TERMINATE_KEY] = fastTerminate;
  for (const signal of TERMINATE_SIGNALS) {
    proc.prependListener(signal, fastTerminate);
  }
  return fastTerminate;
}

/**
 * Remove every SIGTERM / SIGINT listener EXCEPT the fast-terminate guard.
 *
 * CLI command actions register a fresh graceful-shutdown handler each time a
 * test drives them; across many files in a reused worker these accumulate
 * (MaxListeners noise) and retain references to servers / sockets that can
 * contribute to the "Worker exited unexpectedly" native-handle crash. Pruning
 * at each file boundary keeps only our guard so the worker stays lean and
 * terminates cleanly.
 */
export function pruneForeignSignalListeners(
  proc: SignalProcessLike,
  keep: (...args: unknown[]) => void
): void {
  for (const signal of TERMINATE_SIGNALS) {
    for (const listener of proc.listeners(signal)) {
      if (listener !== keep) {
        proc.removeListener(signal, listener);
      }
    }
  }
}
