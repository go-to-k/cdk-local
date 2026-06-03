import type { StudioStore } from './studio-store.js';
import type { StudioDispatcher, StudioRunRequest, StudioRunResult } from './studio-dispatch.js';

/** Input for {@link reinvoke}: the source row + the (possibly edited) payload. */
export interface ReinvokeInput {
  /** Id of the recorded invocation to re-run (a past timeline row). */
  invocationId: string;
  /** The payload to re-invoke with — the captured event, edited by the user. */
  payload: unknown;
}

/** Collaborators {@link reinvoke} reads the source from / dispatches through. */
export interface ReinvokeDeps {
  /** The event store holding the recorded invocations (the source lookup). */
  store: StudioStore;
  /** The single-shot dispatcher the re-invoke runs through. */
  dispatcher: StudioDispatcher;
}

/**
 * The target kinds a timeline row can be re-invoked through the dispatcher.
 * Single-shot invoke kinds only — a served request (api / alb / ecs) is
 * re-sent client-side through the request composer + the live front door
 * (issue #322), not re-dispatched here, so the proxy still captures it.
 */
const REINVOKABLE_KINDS = new Set<string>(['lambda', 'agentcore']);

/**
 * Re-invoke a past timeline row with an edited payload (issue #284, studio
 * Phase 3). Resolves the original target from the recorded invocation and
 * re-fires the edited payload through the SAME single-shot dispatcher
 * `POST /api/run` uses, threading `reinvokeOf` so the new row links to its
 * source. The payload REPLACES the original event (the edit IS the point);
 * run options are not carried over (re-invoke edits the payload, not the
 * flags).
 *
 * Only `lambda` / `agentcore` rows are re-invokable here — a served request
 * is re-sent through the request composer instead, so this throws for serve
 * kinds (and for an id that has aged out of the bounded history window).
 *
 * Host-side use case: consumed by `cdkl studio`'s `POST /api/reinvoke`
 * handler; a host CLI embedding the studio building blocks reuses it to wire
 * the same re-invoke route over its own store + dispatcher.
 */
export async function reinvoke(input: ReinvokeInput, deps: ReinvokeDeps): Promise<StudioRunResult> {
  const original = deps.store.invocation(input.invocationId);
  if (!original) {
    throw new Error(
      `No recorded invocation '${input.invocationId}' to re-invoke (it may have aged out of the history window).`
    );
  }
  if (!REINVOKABLE_KINDS.has(original.kind)) {
    throw new Error(
      `Re-invoke from the timeline is server-side only for Lambda / AgentCore targets; ` +
        `re-send a '${original.kind}' request with the request composer instead.`
    );
  }
  const req: StudioRunRequest = {
    targetId: original.target,
    kind: original.kind,
    event: input.payload,
    reinvokeOf: input.invocationId,
  };
  return deps.dispatcher.run(req);
}
