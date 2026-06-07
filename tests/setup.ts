/// <reference types="node" />

import { afterAll, beforeAll, vi } from 'vite-plus/test';
import {
  installTerminateGuard,
  pruneForeignSignalListeners,
  reinstallLowKeepAliveDispatcher,
  resolveRealExit,
  UNDICI_GLOBAL_DISPATCHER,
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
 * Undici (Node global `fetch`) keep-alive defense against the "Worker exited
 * unexpectedly" crash variant (issue #402).
 *
 *   A forked vitest worker is reused across several test files. A test that
 *   `fetch`es a real HTTP server leaves an idle keep-alive socket pooled in
 *   undici's global dispatcher after the response — even when the body is fully
 *   read. The test's `afterEach` closes the SERVER but not that client socket,
 *   so a now-dangling pooled socket lingers. On CI (slower, contended) its
 *   native handle can crash the reused worker ("Worker exited unexpectedly")
 *   AFTER every assertion has already passed — vitest then propagates the crash
 *   as a non-zero exit even though the suite is green. It is intermittent and
 *   not locally reproducible.
 *
 *   Two layers, both via the helper that reuses the dispatcher's own
 *   constructor (so undici need not be imported — it is a transitive dep only):
 *
 *     1. `beforeAll` bootstrap, ONCE per worker: install a keep-alive-minimized
 *        global dispatcher BEFORE the worker's first real test `fetch`, so no
 *        socket is ever pooled long enough to dangle past an `afterEach`
 *        server-close. The dispatcher is created lazily on first `fetch`, so a
 *        throwaway `fetch` to a closed port forces it into existence first.
 *     2. `afterAll` per file: re-destroy + reinstall the low-keep-alive
 *        dispatcher, so any churn during the file leaves a clean slot for the
 *        next file in the reused worker.
 *
 *   Tests that drive raw `node:http` sockets (their own `agent: false` /
 *   `req.destroy()` teardown) are unaffected: they do not use the undici
 *   global dispatcher.
 */
const UNDICI_LOW_KEEPALIVE_KEY = '__cdk_local_test_undici_low_keepalive__';

beforeAll(async () => {
  if (workerGlobals[UNDICI_LOW_KEEPALIVE_KEY]) {
    return;
  }
  workerGlobals[UNDICI_LOW_KEEPALIVE_KEY] = true;
  const slot = globalThis as Record<symbol, unknown>;
  // The global dispatcher is created lazily on the first `fetch`. Force it into
  // existence with a throwaway request to a closed port (fails fast with
  // ECONNREFUSED, pools nothing) so the constructor is available to reuse.
  if (slot[UNDICI_GLOBAL_DISPATCHER] === undefined) {
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 250);
    try {
      await fetch('http://127.0.0.1:1/', { signal: controller.signal });
    } catch {
      // Expected — the connection is refused / aborted; no socket is pooled.
    } finally {
      clearTimeout(guard);
    }
  }
  try {
    await reinstallLowKeepAliveDispatcher(slot);
  } catch {
    // Best-effort — never fail a green suite over dispatcher setup.
  }
});

afterAll(async () => {
  // Prune any SIGTERM / SIGINT handlers a CLI command action registered while
  // driving its parse during this file (issue #402). They accumulate across
  // files in the reused worker (MaxListeners noise) and retain server / socket
  // references that feed the "Worker exited unexpectedly" native-handle crash;
  // our prepended fast-terminate guard is preserved.
  pruneForeignSignalListeners(process, fastTerminate);

  // Destroy + reinstall the low-keep-alive dispatcher so no pooled socket
  // survives into the next file / the worker's teardown. No-op until the
  // worker has issued its first `fetch`.
  try {
    await reinstallLowKeepAliveDispatcher(globalThis as Record<symbol, unknown>);
  } catch {
    // Best-effort teardown — never fail a green suite over pool cleanup.
  }
});
