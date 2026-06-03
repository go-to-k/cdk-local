import { describe, it, expect } from 'vite-plus/test';
import {
  StudioEventBus,
  type StudioInvocationEvent,
  type StudioLogEvent,
} from '../../../src/local/studio-events.js';
import { createStudioStore } from '../../../src/local/studio-store.js';

function inv(over: Partial<StudioInvocationEvent> & { id: string }): StudioInvocationEvent {
  return {
    ts: 1000,
    target: 'Stack/Fn',
    kind: 'lambda',
    label: 'invoke',
    ...over,
  };
}

function log(over: Partial<StudioLogEvent> & { line: string }): StudioLogEvent {
  return {
    ts: 1000,
    containerId: 'c1',
    target: 'Stack/Fn',
    stream: 'stdout',
    ...over,
  };
}

describe('createStudioStore', () => {
  it('records invocations + logs from the bus and returns them oldest-first', () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus);

    bus.emit('invocation', inv({ id: 'a', ts: 1 }));
    bus.emit('invocation', inv({ id: 'b', ts: 2 }));
    bus.emit('log', log({ line: 'one', ts: 1 }));
    bus.emit('log', log({ line: 'two', ts: 2 }));

    const h = store.history();
    expect(h.invocations.map((i) => i.id)).toEqual(['a', 'b']);
    expect(h.logs.map((l) => l.line)).toEqual(['one', 'two']);
  });

  it('merges the start/end pair of an invocation into one entry, keeping order', () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus);

    bus.emit('invocation', inv({ id: 'x', ts: 5 })); // start
    bus.emit('invocation', inv({ id: 'y', ts: 6 }));
    bus.emit('invocation', inv({ id: 'x', ts: 5, status: 200, durationMs: 12 })); // end

    const h = store.history();
    expect(h.invocations.map((i) => i.id)).toEqual(['x', 'y']); // x kept its slot
    expect(store.invocation('x')?.status).toBe(200);
    expect(store.invocation('x')?.durationMs).toBe(12);
  });

  it('evicts the oldest invocations past maxInvocations', () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus, { maxInvocations: 2 });

    bus.emit('invocation', inv({ id: 'a' }));
    bus.emit('invocation', inv({ id: 'b' }));
    bus.emit('invocation', inv({ id: 'c' }));

    expect(store.history().invocations.map((i) => i.id)).toEqual(['b', 'c']);
    expect(store.invocation('a')).toBeUndefined();
  });

  it('evicts the oldest logs past maxLogs', () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus, { maxLogs: 2 });

    bus.emit('log', log({ line: '1' }));
    bus.emit('log', log({ line: '2' }));
    bus.emit('log', log({ line: '3' }));

    expect(store.history().logs.map((l) => l.line)).toEqual(['2', '3']);
  });

  it('retains EXACTLY maxLogs / maxInvocations at the boundary (no premature eviction, G2)', () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus, { maxLogs: 3, maxInvocations: 2 });

    bus.emit('log', log({ line: '1' }));
    bus.emit('log', log({ line: '2' }));
    bus.emit('log', log({ line: '3' })); // exactly at cap — none evicted
    bus.emit('invocation', inv({ id: 'a' }));
    bus.emit('invocation', inv({ id: 'b' })); // exactly at cap

    expect(store.history().logs.map((l) => l.line)).toEqual(['1', '2', '3']);
    expect(store.history().invocations.map((i) => i.id)).toEqual(['a', 'b']);
  });

  describe('searchLogs', () => {
    it('matches a case-insensitive substring, newest-first', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus);
      bus.emit('log', log({ line: 'GET /hello 200', ts: 1 }));
      bus.emit('log', log({ line: 'Server LISTENING on http://x', ts: 2 }));
      bus.emit('log', log({ line: 'unrelated', ts: 3 }));

      const hits = store.searchLogs('listening');
      expect(hits.map((l) => l.line)).toEqual(['Server LISTENING on http://x']);
    });

    it('restricts to a target and honors the limit', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus);
      bus.emit('log', log({ line: 'hit a', target: 'A', ts: 1 }));
      bus.emit('log', log({ line: 'hit b', target: 'B', ts: 2 }));
      bus.emit('log', log({ line: 'hit a2', target: 'A', ts: 3 }));

      expect(store.searchLogs('hit', { target: 'A' }).map((l) => l.line)).toEqual([
        'hit a2',
        'hit a',
      ]);
      expect(store.searchLogs('hit', { limit: 1 })).toHaveLength(1);
    });

    it('an empty query returns the most recent lines (no filter)', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus);
      bus.emit('log', log({ line: 'a', ts: 1 }));
      bus.emit('log', log({ line: 'b', ts: 2 }));
      expect(store.searchLogs('').map((l) => l.line)).toEqual(['b', 'a']);
    });
  });

  describe('logsForInvocation (D5 binding)', () => {
    it('binds a Lambda invocation STRICTLY by container id', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus);
      bus.emit('invocation', inv({ id: 'inv-1', kind: 'lambda', ts: 100 }));
      bus.emit('log', log({ line: 'mine', containerId: 'inv-1', ts: 100 }));
      bus.emit('log', log({ line: 'other', containerId: 'inv-2', ts: 100 }));

      expect(store.logsForInvocation('inv-1').map((l) => l.line)).toEqual(['mine']);
    });

    it('binds an AgentCore invocation STRICTLY by container id (issue #309)', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus);
      // Two sequential invokes of the SAME agent at the SAME timestamp — a
      // time-window bind would cross-surface them, so strict container-id
      // binding is required (the dispatcher keys agentcore logs by invocation
      // id, exactly like a Lambda).
      bus.emit('invocation', inv({ id: 'ac-1', kind: 'agentcore', target: 'Stack/Agent', ts: 100 }));
      bus.emit('invocation', inv({ id: 'ac-2', kind: 'agentcore', target: 'Stack/Agent', ts: 100 }));
      bus.emit('log', log({ line: 'first', containerId: 'ac-1', target: 'Stack/Agent', ts: 100 }));
      bus.emit('log', log({ line: 'second', containerId: 'ac-2', target: 'Stack/Agent', ts: 100 }));

      expect(store.logsForInvocation('ac-1').map((l) => l.line)).toEqual(['first']);
      expect(store.logsForInvocation('ac-2').map((l) => l.line)).toEqual(['second']);
    });

    it('binds a captured serve request best-effort by target + time window', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus, { bindGraceMs: 50 });
      // A served request from ts=200 lasting 100ms, against the serve target.
      bus.emit('invocation', inv({ id: 'req-1', kind: 'api', target: 'Stack/Api', ts: 200, durationMs: 100 }));
      // Serve logs are keyed to the long-running serve (containerId=target).
      bus.emit('log', log({ line: 'before', containerId: 'Stack/Api', target: 'Stack/Api', ts: 150 }));
      bus.emit('log', log({ line: 'during', containerId: 'Stack/Api', target: 'Stack/Api', ts: 250 }));
      bus.emit('log', log({ line: 'within-grace', containerId: 'Stack/Api', target: 'Stack/Api', ts: 330 }));
      bus.emit('log', log({ line: 'after', containerId: 'Stack/Api', target: 'Stack/Api', ts: 400 }));
      bus.emit('log', log({ line: 'other-target', containerId: 'Stack/Other', target: 'Stack/Other', ts: 250 }));

      const bound = store.logsForInvocation('req-1').map((l) => l.line);
      expect(bound).toEqual(['during', 'within-grace']); // [200, 200+100+50]
    });

    it('binds a zero-log Lambda to [] and NEVER borrows another invocation logs (G1)', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus, { bindGraceMs: 50 });
      // A Lambda that emitted no logs of its own...
      bus.emit('invocation', inv({ id: 'inv-empty', kind: 'lambda', target: 'Stack/Fn', ts: 100, durationMs: 100 }));
      // ...with a DIFFERENT invocation's log of the SAME function inside its
      // time window. The kind-based bind must NOT fall back to the window.
      bus.emit('log', log({ line: 'other-inv', containerId: 'inv-other', target: 'Stack/Fn', ts: 150 }));
      expect(store.logsForInvocation('inv-empty')).toEqual([]);
    });

    it('the serve time-window bind is INCLUSIVE at exactly from and to (G3)', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus, { bindGraceMs: 50 });
      // window = [200, 200+100+50] = [200, 350]
      bus.emit('invocation', inv({ id: 'req', kind: 'api', target: 'Stack/Api', ts: 200, durationMs: 100 }));
      const at = (line: string, ts: number) =>
        bus.emit('log', log({ line, containerId: 'Stack/Api', target: 'Stack/Api', ts }));
      at('just-before', 199);
      at('at-from', 200);
      at('at-to', 350);
      at('just-after', 351);
      expect(store.logsForInvocation('req').map((l) => l.line)).toEqual(['at-from', 'at-to']);
    });

    it('a serve request with no durationMs uses a [ts, ts+grace] window (G4)', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus, { bindGraceMs: 50 });
      bus.emit('invocation', inv({ id: 'req', kind: 'api', target: 'Stack/Api', ts: 200 })); // no durationMs
      bus.emit('log', log({ line: 'in', containerId: 'Stack/Api', target: 'Stack/Api', ts: 230 })); // <= 250
      bus.emit('log', log({ line: 'out', containerId: 'Stack/Api', target: 'Stack/Api', ts: 260 })); // > 250
      expect(store.logsForInvocation('req').map((l) => l.line)).toEqual(['in']);
    });

    it('returns [] for an unknown invocation', () => {
      const bus = new StudioEventBus();
      const store = createStudioStore(bus);
      expect(store.logsForInvocation('nope')).toEqual([]);
    });
  });

  it('dispose() unsubscribes from the bus', () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus);
    expect(bus.listenerCount('invocation')).toBe(1);
    expect(bus.listenerCount('log')).toBe(1);

    store.dispose();
    expect(bus.listenerCount('invocation')).toBe(0);
    expect(bus.listenerCount('log')).toBe(0);

    // No further recording after dispose.
    bus.emit('log', log({ line: 'late' }));
    expect(store.history().logs).toEqual([]);
  });
});
