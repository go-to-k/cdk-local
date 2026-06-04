import { EventEmitter } from 'node:events';

/**
 * The kind of runnable target an invocation ran against. Mirrors the
 * categories `cdkl list` / the studio target list expose.
 */
export type StudioTargetKind =
  | 'lambda'
  | 'api'
  | 'alb'
  | 'ecs'
  | 'ecs-task'
  | 'cloudfront'
  | 'agentcore'
  | 'agentcore-ws';

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
 * Lifecycle of a long-running served target (`api` / `alb` / `ecs`
 * service) the studio started. Unlike {@link StudioInvocationEvent}
 * (one per request), a serve emits one event per status TRANSITION:
 * `starting` when the child is spawned, `running` once it is listening
 * (with the served endpoints), `stopped` after a clean stop, `error`
 * when it failed to come up or crashed. The UI keys these by
 * {@link StudioServeEvent.target} to drive the per-target `running ●
 * :port [Stop]` affordance.
 */
export interface StudioServeEvent {
  /** Wall-clock epoch ms when the status was observed. */
  ts: number;
  /** Target id of the served target (stack-qualified or display path). */
  target: string;
  /** The served target's kind. */
  kind: StudioTargetKind;
  /** Lifecycle status this event reports. */
  status: 'starting' | 'running' | 'stopped' | 'error';
  /**
   * Served endpoint URLs, present on `running` (e.g.
   * `['http://127.0.0.1:51234']`). A single served target can expose
   * several (multiple APIs / WebSocket listeners), so this is a list.
   */
  endpoints?: string[];
  /**
   * Direct host URL for an `ecs` serve published via `--host-port` (issue
   * #322) — no proxy in front (so a request to it is not captured). Absent for
   * api / alb (use `endpoints`) and for an ecs serve without `--host-port`.
   */
  hostUrl?: string;
  /** Child process id, present from `starting` onward. */
  pid?: number;
  /** Status / error detail (e.g. the failure reason on `error`). */
  message?: string;
}

/**
 * Map of event name -> listener argument, for the typed wrapper below.
 */
interface StudioEventMap {
  invocation: [StudioInvocationEvent];
  log: [StudioLogEvent];
  serve: [StudioServeEvent];
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

  /**
   * Number of listeners currently subscribed to `event`. Exposed so the
   * SSE server's subscribe / unsubscribe symmetry can be asserted (a
   * dropped client must not leak a listener).
   */
  listenerCount<E extends keyof StudioEventMap>(event: E): number {
    return this.emitter.listenerCount(event);
  }
}
