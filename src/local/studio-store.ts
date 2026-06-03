import {
  StudioEventBus,
  type StudioInvocationEvent,
  type StudioLogEvent,
} from './studio-events.js';

/** Options for {@link createStudioStore}. */
export interface StudioStoreOptions {
  /** Max invocations retained (newest-wins eviction). Defaults to 200. */
  maxInvocations?: number;
  /** Max log lines retained (newest-wins eviction). Defaults to 5000. */
  maxLogs?: number;
  /**
   * Grace window (ms) added after an invocation's duration when binding
   * serve-request logs by time window — container lines often flush a beat
   * after the response. Defaults to 250.
   */
  bindGraceMs?: number;
}

/** A point-in-time snapshot of the retained events. */
export interface StudioHistory {
  /** Retained invocations, oldest first. */
  invocations: StudioInvocationEvent[];
  /** Retained log lines, oldest first. */
  logs: StudioLogEvent[];
}

/** Options for {@link StudioStore.searchLogs}. */
export interface StudioLogSearchOptions {
  /** Restrict to one target id. */
  target?: string;
  /** Max matches returned (newest first). Defaults to 200. */
  limit?: number;
}

/**
 * The in-memory event store behind `cdkl studio`. Subscribes to the event
 * bus and retains a bounded, newest-wins window of invocations + log
 * lines so the UI can render history on (re)connect, run a full-text log
 * search across the whole session, and bind a request's logs at
 * CloudWatch granularity (decision D5).
 */
export interface StudioStore {
  /** Snapshot of the retained invocations + logs (oldest first). */
  history: () => StudioHistory;
  /**
   * Full-text (case-insensitive substring) search over retained log
   * lines. Returns the newest matches first, capped by `opts.limit`.
   */
  searchLogs: (query: string, opts?: StudioLogSearchOptions) => StudioLogEvent[];
  /**
   * Logs bound to one invocation at CloudWatch granularity (decision D5):
   * a Lambda invocation binds STRICTLY by container id (the dispatcher
   * keys each line to the invocation); a captured serve request — whose
   * logs are keyed to the long-running serve, not the request — binds
   * best-effort by the request's `target` + time window.
   */
  logsForInvocation: (id: string) => StudioLogEvent[];
  /** The retained invocation with `id`, if still in the window. */
  invocation: (id: string) => StudioInvocationEvent | undefined;
  /** Stop subscribing to the bus (idempotent). */
  dispose: () => void;
}

/**
 * Build the studio store and subscribe it to `bus`. The store merges the
 * start/end pair of each invocation (keyed by id) and keeps a ring of log
 * lines; both windows evict oldest-first past their caps.
 */
export function createStudioStore(
  bus: StudioEventBus,
  options: StudioStoreOptions = {}
): StudioStore {
  const maxInvocations = options.maxInvocations ?? 200;
  const maxLogs = options.maxLogs ?? 5000;
  const bindGraceMs = options.bindGraceMs ?? 250;

  // Insertion-ordered map: re-setting an existing id (the end event) keeps
  // its original position, so the start/end pair stays one entry.
  const invocations = new Map<string, StudioInvocationEvent>();
  const logs: StudioLogEvent[] = [];

  const onInvocation = (ev: StudioInvocationEvent): void => {
    invocations.set(ev.id, { ...invocations.get(ev.id), ...ev });
    if (invocations.size > maxInvocations) {
      // Evict the oldest (first-inserted) entry.
      const oldest = invocations.keys().next().value;
      if (oldest !== undefined) invocations.delete(oldest);
    }
  };

  const onLog = (ev: StudioLogEvent): void => {
    logs.push(ev);
    if (logs.length > maxLogs) logs.shift();
  };

  bus.on('invocation', onInvocation);
  bus.on('log', onLog);

  let disposed = false;

  return {
    history: (): StudioHistory => ({
      invocations: [...invocations.values()],
      logs: [...logs],
    }),

    searchLogs: (query, opts = {}): StudioLogEvent[] => {
      const needle = query.toLowerCase();
      const limit = opts.limit ?? 200;
      const matches: StudioLogEvent[] = [];
      // Walk newest-first so a tight limit keeps the most recent matches.
      for (let i = logs.length - 1; i >= 0 && matches.length < limit; i -= 1) {
        const log = logs[i];
        if (!log) continue;
        if (opts.target !== undefined && log.target !== opts.target) continue;
        if (needle === '' || log.line.toLowerCase().includes(needle)) matches.push(log);
      }
      return matches;
    },

    logsForInvocation: (id): StudioLogEvent[] => {
      const inv = invocations.get(id);
      if (!inv) return [];
      // Bind by KIND, not by "did the strict filter match anything". The
      // single-shot invoke kinds (lambda + agentcore, issue #303) key every
      // log line to the invocation id (the dispatcher's runChild emits each
      // with `containerId: invocationId`), so bind STRICTLY by container id —
      // even when the invocation emitted none (an empty result is correct;
      // falling back to a time window would surface a DIFFERENT invocation's
      // logs of the same target, e.g. two sequential invokes of one agent).
      if (inv.kind === 'lambda' || inv.kind === 'agentcore') {
        return logs.filter((l) => l.containerId === id);
      }
      // A captured serve request's logs are keyed to the long-running serve
      // (not the request), so bind best-effort by target + the request's
      // time window (D5).
      const from = inv.ts;
      const to = inv.ts + (inv.durationMs ?? 0) + bindGraceMs;
      return logs.filter((l) => l.target === inv.target && l.ts >= from && l.ts <= to);
    },

    invocation: (id): StudioInvocationEvent | undefined => invocations.get(id),

    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      bus.off('invocation', onInvocation);
      bus.off('log', onLog);
    },
  };
}
