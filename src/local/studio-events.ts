import { EventEmitter } from 'node:events';

/**
 * The kind of runnable target an invocation ran against. Mirrors the
 * categories `cdkl list` / the studio target list expose.
 */
export type StudioTargetKind = 'lambda' | 'api' | 'alb' | 'ecs' | 'agentcore';

/**
 * One request observed by `cdkl studio` — a single-shot invoke or one
 * request to a served target. Emitted twice per request: once at start
 * (status/durationMs/response absent) and once at end (filled in). The
 * UI threads the two by {@link StudioInvocationEvent.id}.
 *
 * Slice A defines the shape; the dispatch layer that emits populated
 * events lands with the invoke / serve slices.
 */
export interface StudioInvocationEvent {
  /** Correlation id, unique per request. Stable across the start/end pair. */
  id: string;
  /** Wall-clock epoch ms when the request started. */
  ts: number;
  /** Target id the request ran against (stack-qualified or display path). */
  target: string;
  /** The target's kind, for the UI's per-kind affordances. */
  kind: StudioTargetKind;
  /** Short request label for the timeline row (e.g. `GET /orders`). */
  label: string;
  /** The request payload (Lambda event JSON or the HTTP request shape). */
  request?: unknown;
  /** Response payload, set on the end event. */
  response?: unknown;
  /** HTTP status / invoke outcome code, set on the end event. */
  status?: number;
  /** Wall-clock duration in ms, set on the end event. */
  durationMs?: number;
  /**
   * When this invocation is a re-run of an earlier one (Phase 3), the id
   * of the source invocation. The UI links the new row to its origin.
   */
  reinvokeOf?: string;
}

/**
 * One container stdout/stderr line, tagged with its emitting container
 * so the detail panel can scope logs at CloudWatch granularity (Lambda
 * per-invocation, ECS per-container).
 */
export interface StudioLogEvent {
  /** Wall-clock epoch ms when the line was observed. */
  ts: number;
  /** Container id that emitted the line. */
  containerId: string;
  /** Target id the container backs, for the UI grouping. */
  target: string;
  /** The raw log line (without trailing newline). */
  line: string;
  /** Parsed stream, when known. */
  stream?: 'stdout' | 'stderr';
}

/**
 * Map of event name -> listener argument, for the typed wrapper below.
 */
interface StudioEventMap {
  invocation: [StudioInvocationEvent];
  log: [StudioLogEvent];
}

/**
 * In-process event bus that every studio observation flows through. The
 * studio HTTP server subscribes and forwards events to the browser over
 * SSE; the dispatch / log-streaming layers emit onto it.
 *
 * A thin typed wrapper over {@link EventEmitter} so producers and the
 * server agree on the event shapes without `any`. Re-exported from
 * `cdk-local/internal` so a host CLI embedding studio can subscribe.
 */
export class StudioEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // The bus can accumulate many SSE subscribers across a long session;
    // raise the cap so Node does not warn about a suspected leak.
    this.emitter.setMaxListeners(0);
  }

  emit<E extends keyof StudioEventMap>(event: E, ...args: StudioEventMap[E]): void {
    this.emitter.emit(event, ...args);
  }

  on<E extends keyof StudioEventMap>(
    event: E,
    listener: (...args: StudioEventMap[E]) => void
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends keyof StudioEventMap>(
    event: E,
    listener: (...args: StudioEventMap[E]) => void
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }
}
