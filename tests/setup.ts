/// <reference types="node" />

import { afterAll, vi } from 'vite-plus/test';
import {
  installTerminateGuard,
  pruneForeignSignalListeners,
  resolveRealExit,
} from './setup-helpers.js';

/**
 * Global vitest setup — defenses against Node 24 + vitest 1.6.1 surfacing
 * stray unhandled rejections from CLI action handlers wrapped in async
 * error-handling.
 *
 * Background:
 *
 *   Test files construct a Commander `Command` via a `create*Command()`
 *   factory and call `cmd.parse([...])` to exercise option parsing.
 *   Commander invokes the registered action as part of `parse()`. The
 *   action body wraps errors and calls `process.exit`. Because the action
 *   is async, the rejection propagates as an unhandled rejection on the
 *   `parse()` Promise — which vitest does not await. On Node 20 / 22 the
 *   runtime swallows it silently; Node 24 surfaces it to the test runner
 *   as an "Unhandled error" annotation, failing CI.
 *
 *   The unhandled rejection from one test file can bubble up while a
 *   different test file is "currently running" in the same worker,
 *   defeating per-file workarounds (vitest attributes the error to the
 *   active file, not the source).
 *
 *   Two-layer global defense:
 *
 *     1. Replace `process.exit` with a no-op. The action's async wrapper
 *        that calls the exit then resumes after the supposed-fatal call,
 *        the wrapper's Promise resolves cleanly, and no unhandled
 *        rejection leaks into vitest's reporter.
 *     2. Make `vi.fn(impl)` resilient to non-constructable implementations
 *        so test factories that mock class constructors don't crash.
 *
 *   Tests that explicitly assert on `process.exit` install their own
 *   `vi.spyOn(process, 'exit')` inside the test scope; `vi.spyOn` replaces
 *   the implementation atomically and `mockRestore` returns to whatever
 *   value was current — i.e. our wrapper — so the per-test spies still
 *   work as before.
 */

const originalViFn = vi.fn.bind(vi);
type MockableImplementation =
  | ((this: unknown, ...args: any[]) => any)
  | (new (...args: any[]) => any);

const isConstructable = (
  fn: MockableImplementation
): fn is new (...args: any[]) => any => {
  try {
    Reflect.construct(function () {}, [], fn);
    return true;
  } catch {
    return false;
  }
};

const wrapConstructableImplementation = (
  implementation: MockableImplementation
): MockableImplementation => {
  if (isConstructable(implementation)) {
    return implementation;
  }

  return function (this: unknown, ...args: unknown[]) {
    return implementation.apply(this, args);
  };
};

const wrapMockImplementationSetters = <T extends ReturnType<typeof originalViFn>>(mock: T): T => {
  const mockImplementation = mock.mockImplementation.bind(mock);
  type MockImplementationArg = Parameters<typeof mockImplementation>[0];
  mock.mockImplementation = ((implementation: MockImplementationArg) =>
    mockImplementation(
      wrapConstructableImplementation(implementation) as MockImplementationArg
    )) as T['mockImplementation'];

  const mockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  type MockImplementationOnceArg = Parameters<typeof mockImplementationOnce>[0];
  mock.mockImplementationOnce = ((implementation: MockImplementationOnceArg) =>
    mockImplementationOnce(
      wrapConstructableImplementation(implementation) as MockImplementationOnceArg
    )) as T['mockImplementationOnce'];

  return mock;
};

vi.fn = ((implementation?: MockableImplementation) => {
  if (typeof implementation === 'function' && !isConstructable(implementation)) {
    return wrapMockImplementationSetters(
      originalViFn(wrapConstructableImplementation(implementation) as never)
    );
  }

  return wrapMockImplementationSetters(originalViFn(implementation as never));
}) as typeof vi.fn;

// Capture the REAL `process.exit` ONCE per worker (stashed on a worker-global
// keyed by REAL_EXIT_KEY). setupFiles re-run per test file, but `process` is a
// true global shared across files in the reused worker — so on the 2nd+ file
// `process.exit` is ALREADY the no-op installed by the 1st file. resolveRealExit
// stores + returns the genuine exit so neither the no-op replacement below nor
// the terminate guard ever loses the real one.
const workerGlobals = globalThis as Record<string, unknown>;
const realProcessExit = resolveRealExit(workerGlobals, process);

// Replace `process.exit` with a no-op. See module docstring for the why. The
// real exit stays available to anything reading `globalThis[REAL_EXIT_KEY]`
// (the previously-named `__cdk_local_test_original_exit__` global).
(process as unknown as { exit: (code?: number) => never }).exit = ((_code?: number): never => {
  return undefined as never;
}) as never;

// Install the per-worker fast-terminate guard (issue #402, hang variant). It is
// PREPENDED so it wins the SIGTERM / SIGINT race against any graceful-shutdown
// handler a CLI command action registered during a test, exiting the worker
// immediately on teardown via the real (un-stubbed) exit. See setup-helpers.ts.
const fastTerminate = installTerminateGuard(workerGlobals, process, realProcessExit);

/**
 * Per-file teardown: destroy the undici (Node global `fetch`) keep-alive pool
 * so no pooled socket survives into the forked worker's teardown.
 *
 * Background (issue #402):
 *
 *   A forked vitest worker is reused across several test files. Tests that
 *   drive a real HTTP server with the global `fetch` leave an idle keep-alive
 *   socket pooled in undici's global dispatcher after the request finishes.
 *   When the worker process is later told to exit, that pooled socket's
 *   native handle can crash the worker ("Worker exited unexpectedly") AFTER
 *   every assertion has already passed — vitest then propagates the crash as
 *   a non-zero exit even though the suite is green. The crash is intermittent
 *   (timing-dependent)
 *   and not locally reproducible, so the only robust defense is to guarantee
 *   the pool is empty at every file boundary.
 *
 *   Node stores the global dispatcher on a well-known global symbol
 *   (`Symbol.for('undici.globalDispatcher.1')`) — the same slot the public
 *   `undici` package reads/writes — so we can clear it WITHOUT adding undici
 *   as a dependency. We `destroy()` the current dispatcher (forcibly aborting
 *   any leftover/idle socket) and install a fresh `Agent` of the same
 *   constructor so subsequent files in the same worker get a clean pool. The
 *   symbol slot is non-configurable but writable, so reassignment is allowed;
 *   reusing the existing dispatcher's constructor avoids importing `Agent`.
 *
 *   This is a per-FILE hook (`afterAll`), not per-test, so within-file
 *   connection reuse is unchanged — only the file boundary resets the pool.
 *   Tests that drive raw `node:http` sockets (their own `agent: false` /
 *   `req.destroy()` teardown) are unaffected: they do not use the undici
 *   global dispatcher.
 */
const UNDICI_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

interface UndiciDispatcher {
  destroy(): Promise<void>;
  constructor: new () => UndiciDispatcher;
}

afterAll(async () => {
  // Prune any SIGTERM / SIGINT handlers a CLI command action registered while
  // driving its parse during this file (issue #402). They accumulate across
  // files in the reused worker (MaxListeners noise) and retain server / socket
  // references that feed the "Worker exited unexpectedly" native-handle crash;
  // our prepended fast-terminate guard is preserved.
  pruneForeignSignalListeners(process, fastTerminate);

  const slot = globalThis as Record<symbol, unknown>;
  const dispatcher = slot[UNDICI_GLOBAL_DISPATCHER] as UndiciDispatcher | undefined;
  // Undefined until the worker issues its first `fetch`; nothing to clear.
  if (!dispatcher || typeof dispatcher.destroy !== 'function') {
    return;
  }

  try {
    await dispatcher.destroy();
    slot[UNDICI_GLOBAL_DISPATCHER] = new dispatcher.constructor();
  } catch {
    // Best-effort teardown — never fail a green suite over pool cleanup.
  }
});
