import { describe, it, expect, vi } from 'vite-plus/test';
import {
  FAST_TERMINATE_KEY,
  REAL_EXIT_KEY,
  TERMINATE_SIGNALS,
  installTerminateGuard,
  pruneForeignSignalListeners,
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
