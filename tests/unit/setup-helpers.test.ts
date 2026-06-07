import { describe, it, expect, vi } from 'vite-plus/test';
import {
  FAST_TERMINATE_KEY,
  LOW_KEEPALIVE_DISPATCHER_OPTS,
  REAL_EXIT_KEY,
  TERMINATE_SIGNALS,
  UNDICI_GLOBAL_DISPATCHER,
  installTerminateGuard,
  pruneForeignSignalListeners,
  reinstallLowKeepAliveDispatcher,
  resolveRealExit,
  type SignalProcessLike,
} from '../setup-helpers.js';

type Listener = (...args: unknown[]) => void;

/** A minimal fake `process` recording prepend / remove against per-signal lists. */
function makeFakeProcess(exit: (code?: number) => never): SignalProcessLike & {
  store: Map<string, Listener[]>;
} {
  const store = new Map<string, Listener[]>();
  return {
    store,
    exit,
    prependListener(signal, listener) {
      const list = store.get(signal) ?? [];
      list.unshift(listener);
      store.set(signal, list);
      return this;
    },
    listeners(signal) {
      return [...(store.get(signal) ?? [])];
    },
    removeListener(signal, listener) {
      const list = store.get(signal) ?? [];
      store.set(
        signal,
        list.filter((l) => l !== listener)
      );
      return this;
    },
  };
}

const noopExit = (() => undefined) as unknown as (code?: number) => never;

describe('resolveRealExit', () => {
  it('captures the real exit on first call and stashes it under REAL_EXIT_KEY', () => {
    const globals: Record<string, unknown> = {};
    const realExit = noopExit;
    const resolved = resolveRealExit(globals, { exit: realExit });
    expect(resolved).toBe(realExit);
    expect(globals[REAL_EXIT_KEY]).toBe(realExit);
  });

  it('returns the FIRST captured exit even when a later file passes the no-op', () => {
    const globals: Record<string, unknown> = {};
    const realExit = (() => undefined) as unknown as (code?: number) => never;
    resolveRealExit(globals, { exit: realExit });

    // Simulate the 2nd file: process.exit has been replaced with a no-op.
    const noop = (() => undefined) as unknown as (code?: number) => never;
    const resolvedSecond = resolveRealExit(globals, { exit: noop });

    expect(resolvedSecond).toBe(realExit);
    expect(resolvedSecond).not.toBe(noop);
  });
});

describe('installTerminateGuard', () => {
  it('prepends a guard on every terminate signal that exits via the real exit', () => {
    const globals: Record<string, unknown> = {};
    const exitSpy = vi.fn();
    const proc = makeFakeProcess(exitSpy as unknown as (code?: number) => never);

    const guard = installTerminateGuard(
      globals,
      proc,
      exitSpy as unknown as (code?: number) => never
    );

    for (const signal of TERMINATE_SIGNALS) {
      expect(proc.listeners(signal)).toContain(guard);
    }

    guard();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('is idempotent per worker — only installs once and returns the same function', () => {
    const globals: Record<string, unknown> = {};
    const proc = makeFakeProcess(noopExit);

    const first = installTerminateGuard(globals, proc, noopExit);
    const second = installTerminateGuard(globals, proc, noopExit);

    expect(second).toBe(first);
    expect(globals[FAST_TERMINATE_KEY]).toBe(first);
    // Only one listener per signal despite two install calls.
    for (const signal of TERMINATE_SIGNALS) {
      expect(proc.listeners(signal)).toHaveLength(1);
    }
  });

  it('runs FIRST (prepended) ahead of a later graceful-shutdown handler', () => {
    const globals: Record<string, unknown> = {};
    const proc = makeFakeProcess(noopExit);
    const guard = installTerminateGuard(globals, proc, noopExit);

    // A CLI command action registers its graceful handler AFTER the guard.
    const graceful: Listener = () => undefined;
    proc.store.get('SIGTERM')?.push(graceful);

    expect(proc.listeners('SIGTERM')[0]).toBe(guard);
  });
});

describe('pruneForeignSignalListeners', () => {
  it('removes foreign handlers but keeps the guard', () => {
    const globals: Record<string, unknown> = {};
    const proc = makeFakeProcess(noopExit);
    const guard = installTerminateGuard(globals, proc, noopExit);

    const foreignA: Listener = () => undefined;
    const foreignB: Listener = () => undefined;
    proc.store.get('SIGTERM')?.push(foreignA);
    proc.store.get('SIGINT')?.push(foreignB);

    pruneForeignSignalListeners(proc, guard);

    expect(proc.listeners('SIGTERM')).toEqual([guard]);
    expect(proc.listeners('SIGINT')).toEqual([guard]);
  });

  it('is a no-op when only the guard is registered', () => {
    const globals: Record<string, unknown> = {};
    const proc = makeFakeProcess(noopExit);
    const guard = installTerminateGuard(globals, proc, noopExit);

    pruneForeignSignalListeners(proc, guard);

    for (const signal of TERMINATE_SIGNALS) {
      expect(proc.listeners(signal)).toEqual([guard]);
    }
  });
});

/** Records the options its constructor was last handed + whether destroy ran. */
class FakeDispatcher {
  static lastOpts: unknown;
  destroyed = false;
  constructor(opts?: unknown) {
    FakeDispatcher.lastOpts = opts;
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

describe('reinstallLowKeepAliveDispatcher', () => {
  it('destroys the current dispatcher and reinstalls one with low-keepalive opts', async () => {
    FakeDispatcher.lastOpts = undefined;
    const slot: Record<symbol, unknown> = {};
    const original = new FakeDispatcher();
    slot[UNDICI_GLOBAL_DISPATCHER] = original;

    const installed = await reinstallLowKeepAliveDispatcher(slot);

    expect(installed).toBe(true);
    expect(original.destroyed).toBe(true);
    const replacement = slot[UNDICI_GLOBAL_DISPATCHER];
    expect(replacement).toBeInstanceOf(FakeDispatcher);
    expect(replacement).not.toBe(original);
    // The replacement was constructed with the keep-alive-minimizing options.
    expect(FakeDispatcher.lastOpts).toEqual(LOW_KEEPALIVE_DISPATCHER_OPTS);
  });

  it('returns false (no-op) when no dispatcher exists yet (no fetch issued)', async () => {
    const slot: Record<symbol, unknown> = {};
    expect(await reinstallLowKeepAliveDispatcher(slot)).toBe(false);
  });

  it('returns false when the slot holds a non-dispatcher (no destroy method)', async () => {
    const slot: Record<symbol, unknown> = { [UNDICI_GLOBAL_DISPATCHER]: {} };
    expect(await reinstallLowKeepAliveDispatcher(slot)).toBe(false);
    // The bogus value is left untouched.
    expect(slot[UNDICI_GLOBAL_DISPATCHER]).toEqual({});
  });

  it('low-keepalive opts close idle sockets immediately (keepAliveTimeout minimal)', () => {
    // Lock the intent: a tiny keepAliveTimeout + no pipelining is what removes
    // the dangling-pooled-socket window the crash variant depends on.
    expect(LOW_KEEPALIVE_DISPATCHER_OPTS.keepAliveTimeout).toBeLessThanOrEqual(1);
    expect(LOW_KEEPALIVE_DISPATCHER_OPTS.keepAliveMaxTimeout).toBeLessThanOrEqual(1);
    expect(LOW_KEEPALIVE_DISPATCHER_OPTS.pipelining).toBe(0);
  });
});
