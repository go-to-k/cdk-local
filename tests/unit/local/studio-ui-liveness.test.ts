import { describe, it, expect, afterEach } from 'vite-plus/test';
import { createStudioHarness, type StudioHarness } from './studio-ui-harness.js';

/**
 * Execution coverage for the studio UI connection-liveness logic (the `● live`
 * / `● disconnected` indicator). The embedded `connect()` must:
 *
 *   - bind to the FIRST server `hello` instanceId it sees, and
 *   - flip to disconnected (and stay there) when a reconnect lands on a
 *     DIFFERENT studio process that reused the port — so a second
 *     `cdkl studio` cannot keep an orphaned UI reading "live", and
 *   - flip to disconnected via a heartbeat watchdog when the originating
 *     server simply dies and no events arrive, even if the dropped socket
 *     never surfaces an `error` event.
 *
 * The harness exposes `connect` via an epilogue and the test drives a
 * controllable in-memory `EventSource`, so no real network / timers are used
 * for the event-driven cases.
 */

let harness: StudioHarness;

afterEach(() => {
  harness?.close();
});

/** A controllable in-memory EventSource: records listeners + lets a test fire events. */
class FakeES {
  static last: FakeES | undefined;
  listeners: Record<string, Array<(e: { data?: string }) => void>> = {};
  closed = false;
  constructor(public url: string) {
    FakeES.last = this;
  }
  addEventListener(type: string, fn: (e: { data?: string }) => void): void {
    (this.listeners[type] ||= []).push(fn);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: string): void {
    (this.listeners[type] || []).forEach((fn) => fn({ data }));
  }
}

function bootHarness(): { connect: () => void; win: Record<string, unknown> } {
  harness = createStudioHarness({ epilogue: 'window.__connect = connect;' });
  const win = harness.window as unknown as Record<string, unknown>;
  FakeES.last = undefined;
  win.EventSource = FakeES;
  return { connect: win.__connect as () => void, win };
}

function connText(): string {
  return harness.document.getElementById('conn')!.textContent ?? '';
}

describe('studio UI connection liveness', () => {
  it('goes live on the first hello and stays live on a same-instance ping', () => {
    const { connect } = bootHarness();
    connect();
    const es = FakeES.last!;
    es.emit('hello', JSON.stringify({ instanceId: 'A' }));
    expect(connText()).toBe('● live');
    es.emit('error');
    expect(connText()).toBe('● disconnected');
    es.emit('ping');
    expect(connText()).toBe('● live');
  });

  it('disconnects (latched) when a reconnect lands on a DIFFERENT instance', () => {
    const { connect } = bootHarness();
    connect();
    const es = FakeES.last!;
    es.emit('hello', JSON.stringify({ instanceId: 'A' }));
    expect(connText()).toBe('● live');

    // A second studio process reused the port; the stream now announces a
    // different instanceId. The UI must drop to disconnected and stop listening.
    es.emit('hello', JSON.stringify({ instanceId: 'B' }));
    expect(connText()).toBe('● disconnected');
    expect(es.closed).toBe(true);

    // Latched: a stray later event from the wrong server cannot revive it.
    es.emit('ping');
    expect(connText()).toBe('● disconnected');
  });

  it('disconnects via the watchdog when heartbeats stop arriving', () => {
    const captured: Array<() => void> = [];
    harness = createStudioHarness({ epilogue: 'window.__connect = connect;' });
    const win = harness.window as unknown as Record<string, unknown>;
    FakeES.last = undefined;
    win.EventSource = FakeES;
    // Capture the watchdog interval callback instead of relying on real time.
    win.setInterval = ((fn: () => void) => {
      captured.push(fn);
      return captured.length;
    }) as unknown as typeof setInterval;

    (win.__connect as () => void)();
    const es = FakeES.last!;
    es.emit('hello', JSON.stringify({ instanceId: 'A' }));
    expect(connText()).toBe('● live');

    const realNow = (win.Date as DateConstructor).now;
    try {
      // Advance the clock past the liveness window; the watchdog must fire.
      (win.Date as unknown as { now: () => number }).now = () => realNow() + 46_000;
      captured.forEach((fn) => fn());
    } finally {
      (win.Date as unknown as { now: () => number }).now = realNow;
    }
    expect(connText()).toBe('● disconnected');
  });
});
