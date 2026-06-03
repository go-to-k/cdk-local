import { describe, it, expect, vi } from 'vite-plus/test';
import { reinvoke } from '../../../src/local/studio-reinvoke.js';
import type { StudioStore } from '../../../src/local/studio-store.js';
import type { StudioDispatcher, StudioRunRequest } from '../../../src/local/studio-dispatch.js';
import type { StudioInvocationEvent } from '../../../src/local/studio-events.js';

/** A store stub whose `invocation(id)` returns the supplied record (or none). */
function fakeStore(record: Partial<StudioInvocationEvent> | undefined): StudioStore {
  return {
    history: () => ({ invocations: [], logs: [] }),
    searchLogs: () => [],
    logsForInvocation: () => [],
    invocation: (id: string) =>
      record ? ({ id, ts: 0, label: 'invoke', ...record } as StudioInvocationEvent) : undefined,
    dispose: () => undefined,
  };
}

/** A dispatcher stub that records the request it was handed. */
function fakeDispatcher(): { dispatcher: StudioDispatcher; calls: StudioRunRequest[] } {
  const calls: StudioRunRequest[] = [];
  const dispatcher: StudioDispatcher = {
    run: vi.fn(async (req: StudioRunRequest) => {
      calls.push(req);
      return { invocationId: 'new-inv', ok: true, status: 200, durationMs: 5 };
    }),
  };
  return { dispatcher, calls };
}

describe('reinvoke', () => {
  it('re-dispatches a recorded lambda row with the edited payload + reinvokeOf', async () => {
    const store = fakeStore({ target: 'Stack/Fn', kind: 'lambda', request: { a: 1 } });
    const { dispatcher, calls } = fakeDispatcher();

    const result = await reinvoke({ invocationId: 'src-1', payload: { a: 2 } }, { store, dispatcher });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      targetId: 'Stack/Fn',
      kind: 'lambda',
      event: { a: 2 }, // the EDITED payload replaces the original event
      reinvokeOf: 'src-1',
    });
  });

  it('re-dispatches a recorded agentcore row', async () => {
    const store = fakeStore({ target: 'Stack/Agent', kind: 'agentcore', request: { prompt: 'hi' } });
    const { dispatcher, calls } = fakeDispatcher();

    await reinvoke({ invocationId: 'src-2', payload: { prompt: 'bye' } }, { store, dispatcher });

    expect(calls[0]).toMatchObject({
      targetId: 'Stack/Agent',
      kind: 'agentcore',
      event: { prompt: 'bye' },
      reinvokeOf: 'src-2',
    });
  });

  it('throws when the source invocation has aged out of the store', async () => {
    const store = fakeStore(undefined);
    const { dispatcher, calls } = fakeDispatcher();

    await expect(reinvoke({ invocationId: 'gone', payload: {} }, { store, dispatcher })).rejects.toThrow(
      /No recorded invocation 'gone'/
    );
    expect(calls).toHaveLength(0);
  });

  it('throws for a served (api / alb / ecs) source — re-sent via the composer instead', async () => {
    const store = fakeStore({ target: 'Stack/Api', kind: 'api', request: { method: 'GET', path: '/' } });
    const { dispatcher, calls } = fakeDispatcher();

    await expect(reinvoke({ invocationId: 'src-3', payload: {} }, { store, dispatcher })).rejects.toThrow(
      /server-side only for Lambda \/ AgentCore/
    );
    expect(calls).toHaveLength(0);
  });

  it('passes a null edited payload through verbatim (clearing the event)', async () => {
    const store = fakeStore({ target: 'Stack/Fn', kind: 'lambda', request: { a: 1 } });
    const { dispatcher, calls } = fakeDispatcher();

    await reinvoke({ invocationId: 'src-4', payload: null }, { store, dispatcher });

    expect(calls[0]?.event).toBeNull();
  });
});
