import { describe, it, expect } from 'vite-plus/test';
import {
  StudioEventBus,
  type StudioInvocationEvent,
  type StudioLogEvent,
} from '../../../src/local/studio-events.js';

describe('StudioEventBus', () => {
  it('delivers invocation events to a subscribed listener', () => {
    const bus = new StudioEventBus();
    const received: StudioInvocationEvent[] = [];
    bus.on('invocation', (ev) => received.push(ev));

    const ev: StudioInvocationEvent = {
      id: 'a1',
      ts: 1000,
      target: 'Stack:Handler',
      kind: 'lambda',
      label: 'invoke',
    };
    bus.emit('invocation', ev);

    expect(received).toEqual([ev]);
  });

  it('delivers log events to a subscribed listener', () => {
    const bus = new StudioEventBus();
    const received: StudioLogEvent[] = [];
    bus.on('log', (ev) => received.push(ev));

    const ev: StudioLogEvent = {
      ts: 2000,
      containerId: 'c1',
      target: 'Stack:Svc',
      line: 'hello',
      stream: 'stdout',
    };
    bus.emit('log', ev);

    expect(received).toEqual([ev]);
  });

  it('keeps invocation and log channels independent', () => {
    const bus = new StudioEventBus();
    let invocations = 0;
    let logs = 0;
    bus.on('invocation', () => (invocations += 1));
    bus.on('log', () => (logs += 1));

    bus.emit('invocation', { id: 'x', ts: 0, target: 't', kind: 'api', label: 'GET /' });
    expect(invocations).toBe(1);
    expect(logs).toBe(0);
  });

  it('stops delivering after off()', () => {
    const bus = new StudioEventBus();
    let count = 0;
    const listener = (): void => {
      count += 1;
    };
    bus.on('invocation', listener);
    bus.emit('invocation', { id: '1', ts: 0, target: 't', kind: 'lambda', label: 'a' });
    bus.off('invocation', listener);
    bus.emit('invocation', { id: '2', ts: 0, target: 't', kind: 'lambda', label: 'b' });

    expect(count).toBe(1);
  });

  it('supports many concurrent subscribers without a max-listener warning', () => {
    const bus = new StudioEventBus();
    const counts = Array.from({ length: 50 }, () => 0);
    counts.forEach((_, i) => bus.on('invocation', () => (counts[i] += 1)));
    bus.emit('invocation', { id: 'm', ts: 0, target: 't', kind: 'ecs', label: 'x' });
    expect(counts.every((c) => c === 1)).toBe(true);
  });
});
