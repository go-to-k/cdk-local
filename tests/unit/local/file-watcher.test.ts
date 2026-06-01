import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));

vi.mock('chokidar', () => ({ watch: watchMock }));

import { createFileWatcher } from '../../../src/local/file-watcher.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';

interface FakeWatcher {
  capturedPaths: unknown;
  capturedOptions: Record<string, unknown>;
  on(event: string, cb: (p: string) => void): FakeWatcher;
  add: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emit(event: string, p: string): void;
}

function makeFakeWatcher(): FakeWatcher {
  const handlers: Record<string, (p: string) => void> = {};
  const fake: FakeWatcher = {
    capturedPaths: undefined,
    capturedOptions: {},
    on(event, cb) {
      handlers[event] = cb;
      return fake;
    },
    add: vi.fn(),
    unwatch: vi.fn(),
    close: vi.fn(async () => undefined),
    emit(event, p) {
      handlers[event]?.(p);
    },
  };
  return fake;
}

describe('createFileWatcher', () => {
  let fake: FakeWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = makeFakeWatcher();
    watchMock.mockReset();
    watchMock.mockImplementation((paths: unknown, options: Record<string, unknown>) => {
      fake.capturedPaths = paths;
      fake.capturedOptions = options;
      return fake;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the watched paths and the ignored predicate to chokidar', () => {
    const ignored = (p: string): boolean => p.endsWith('/cdk.out');
    createFileWatcher({ paths: ['/root'], onChange: () => {}, ignored });
    expect(fake.capturedPaths).toEqual(['/root']);
    expect(fake.capturedOptions['ignored']).toBe(ignored);
    expect(fake.capturedOptions['ignoreInitial']).toBe(true);
  });

  it('omits the ignored option when not provided', () => {
    createFileWatcher({ paths: ['/root'], onChange: () => {} });
    expect('ignored' in fake.capturedOptions).toBe(false);
  });

  it('fires onChange (debounced) on a change event', () => {
    const onChange = vi.fn();
    createFileWatcher({ paths: ['/root'], onChange, debounceMs: 10 });
    fake.emit('change', '/root/src/handler.ts');
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of events into a single onChange', () => {
    const onChange = vi.fn();
    createFileWatcher({ paths: ['/root'], onChange, debounceMs: 10 });
    fake.emit('add', '/root/a.ts');
    fake.emit('change', '/root/b.ts');
    fake.emit('unlink', '/root/c.ts');
    vi.advanceTimersByTime(10);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('drops events rejected by shouldTrigger', () => {
    const onChange = vi.fn();
    createFileWatcher({
      paths: ['/root'],
      onChange,
      debounceMs: 10,
      shouldTrigger: (p) => p.endsWith('.ts'),
    });
    fake.emit('change', '/root/README.md');
    vi.advanceTimersByTime(10);
    expect(onChange).not.toHaveBeenCalled();

    fake.emit('change', '/root/src/handler.ts');
    vi.advanceTimersByTime(10);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not fire onChange after close(), even with a timer armed', async () => {
    const onChange = vi.fn();
    const watcher = createFileWatcher({ paths: ['/root'], onChange, debounceMs: 10 });
    fake.emit('change', '/root/a.ts');
    await watcher.close();
    vi.advanceTimersByTime(10);
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalled();
  });

  // Phase 4 of issue #214 — the source-change classifier needs the
  // SET of paths that fired in the debounce window. Locks the
  // de-dup + ordering contract the classifier depends on.
  it('passes the de-duplicated set of changed paths to onChange', () => {
    const onChange = vi.fn();
    createFileWatcher({ paths: ['/root'], onChange, debounceMs: 10 });
    fake.emit('add', '/root/a.ts');
    fake.emit('change', '/root/b.ts');
    fake.emit('change', '/root/a.ts'); // duplicate of the first add
    fake.emit('unlink', '/root/c.ts');
    vi.advanceTimersByTime(10);
    expect(onChange).toHaveBeenCalledTimes(1);
    const paths = onChange.mock.calls[0]![0] as readonly string[];
    expect([...paths].sort()).toEqual(['/root/a.ts', '/root/b.ts', '/root/c.ts']);
  });

  it('starts a fresh pending set on the next debounce window', () => {
    const onChange = vi.fn();
    createFileWatcher({ paths: ['/root'], onChange, debounceMs: 10 });
    fake.emit('change', '/root/a.ts');
    vi.advanceTimersByTime(10);
    fake.emit('change', '/root/b.ts');
    vi.advanceTimersByTime(10);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[0]![0]).toEqual(['/root/a.ts']);
    expect(onChange.mock.calls[1]![0]).toEqual(['/root/b.ts']);
  });

  // Issue #246 site 5 — chokidar 'error' events (EMFILE on macOS when
  // nesting deep, watch root unmounted, etc.) used to log at
  // `logger.debug`. The user would see `--watch active` at boot but no
  // reload ever fired; default-level cdkl output stayed quiet. Lock
  // the bump to `logger.warn` so the user gets a visible signal +
  // mention that --watch may be degraded for the rest of the session.
  it('logs chokidar error events at warn (not debug) so --watch degradation is visible', () => {
    // Spy on the prototype so the file-watcher's own
    // `getLogger().child('start-api-watch')` (a fresh child instance)
    // trips the spy.
    const warnSpy = vi
      .spyOn(ConsoleLogger.prototype, 'warn')
      .mockImplementation(() => {});
    const debugSpy = vi
      .spyOn(ConsoleLogger.prototype, 'debug')
      .mockImplementation(() => {});

    createFileWatcher({ paths: ['/root'], onChange: () => {} });

    // Drive the chokidar error path with a representative EMFILE error.
    const err = new Error('EMFILE: too many open files');
    // The on('error', ...) callback is registered on the fake.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).emit('error', err as any);

    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    const errLine = warns.find((w) => w.includes('chokidar error'));
    expect(errLine).toBeDefined();
    expect(errLine!).toContain('EMFILE');
    expect(errLine!).toContain('--watch');

    // The pre-fix debug path is gone.
    const debugs = debugSpy.mock.calls.map((c) => String(c[0]));
    expect(debugs.some((d) => d.includes('chokidar error'))).toBe(false);
  });

  it('drops shouldTrigger-rejected paths from the changed-set the callback sees', () => {
    const onChange = vi.fn();
    createFileWatcher({
      paths: ['/root'],
      onChange,
      debounceMs: 10,
      shouldTrigger: (p) => !p.endsWith('.md'),
    });
    fake.emit('change', '/root/README.md');
    fake.emit('change', '/root/handler.ts');
    vi.advanceTimersByTime(10);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual(['/root/handler.ts']);
  });
});
