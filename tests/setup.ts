/// <reference types="node" />

import { vi } from 'vite-plus/test';

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

const originalExit = process.exit;

// Replace `process.exit` with a no-op. See module docstring for the why.
(process as unknown as { exit: (code?: number) => never }).exit = ((_code?: number): never => {
  return undefined as never;
}) as never;

// Keep a reference to the real exit in case anything downstream wants it.
(globalThis as Record<string, unknown>).__cdk_local_test_original_exit__ = originalExit;
