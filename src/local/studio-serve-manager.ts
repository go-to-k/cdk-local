import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StudioEventBus, type StudioServeEvent, type StudioTargetKind } from './studio-events.js';

/** A request to start serving a target, as the studio UI posts it. */
export interface StudioServeRequest {
  /** Target id the user picked (display path or stack-qualified id). */
  targetId: string;
  /** Target kind. Slice C1 supports `'api'` (long-running `start-api`) only. */
  kind: StudioTargetKind;
}

/** A request to stop a running served target. */
export interface StudioStopRequest {
  /** Target id of the serve to stop. */
  targetId: string;
}

/** The public state of one running served target (returned to the UI). */
export interface StudioServeState {
  /** Target id of the served target. */
  targetId: string;
  /** The served target's kind. */
  kind: StudioTargetKind;
  /** Lifecycle status. */
  status: 'starting' | 'running' | 'stopped' | 'error';
  /** Served endpoint URLs, populated once running. */
  endpoints: string[];
  /** Child process id. */
  pid?: number;
  /** Wall-clock epoch ms when the serve started. */
  startedAt: number;
}

/** Config for {@link createStudioServeManager}. */
export interface StudioServeManagerConfig {
  /** Path to the `cdkl` CLI entry (`dist/cli.js`) — usually `process.argv[1]`. */
  cliEntry: string;
  /** The shared event bus; serve + log events are emitted onto it. */
  bus: StudioEventBus;
  /** Working directory for the child serve (defaults to `process.cwd()`). */
  cwd?: string;
  /** `--app` value to thread into the child serve, if studio was given one. */
  app?: string;
  /** `-c key=value` context overrides to thread through. */
  context?: Record<string, string>;
  /** `--profile` to thread through. */
  profile?: string;
  /** `--region` to thread through. */
  region?: string;
  /** Node binary to spawn (defaults to `process.execPath`; injectable for tests). */
  nodeBin?: string;
  /** Spawn implementation (injectable for tests). */
  spawnFn?: typeof nodeSpawn;
  /** Clock (injectable for tests; defaults to `Date.now`). */
  clock?: () => number;
  /**
   * Max ms to wait for the first `Server listening on ...` line before
   * giving up and killing the child. Generous by default to cover the
   * first-run base-image pull `start-api` triggers. Defaults to 120_000.
   */
  readyTimeoutMs?: number;
  /**
   * Ms to wait for a SIGTERM'd child to exit before sending SIGKILL.
   * Defaults to 10_000.
   */
  stopGraceMs?: number;
  /** `setTimeout` (injectable for tests). */
  setTimeoutFn?: typeof setTimeout;
  /** `clearTimeout` (injectable for tests). */
  clearTimeoutFn?: typeof clearTimeout;
}

/** A bound serve manager exposing the start / stop / list surface. */
export interface StudioServeManager {
  /** Start serving a target; resolves once it is listening (or rejects). */
  start: (req: StudioServeRequest) => Promise<StudioServeState>;
  /** Stop a running served target; resolves once the child has exited. */
  stop: (req: StudioStopRequest) => Promise<void>;
  /** Snapshot of every running served target. */
  list: () => StudioServeState[];
  /** Stop every running served target (graceful shutdown). */
  stopAll: () => Promise<void>;
}

/** Kinds the serve manager can start in this build. */
const SERVE_SUPPORTED: readonly StudioTargetKind[] = ['api'];

/** `Server listening on <url>` is the stable ready marker `start-api` prints. */
const LISTENING_RE = /Server listening on (\S+)/;

interface ServeEntry extends StudioServeState {
  child: ChildProcessWithoutNullStreams;
  /**
   * Set by `stop()` when it tears the child down WHILE it is still
   * `starting` (the ready promise has not settled). The child's `close`
   * handler reads it so a user-initiated stop is not misreported as a
   * boot failure (no `error` event, no `start()` reject as a crash).
   */
  stopping?: boolean;
}

/**
 * Build the studio serve manager. Slice C1 drives a long-running
 * `cdkl start-api <target>` child — studio is a control plane over the
 * CLI (the same pattern as the single-shot invoke dispatcher), so it
 * spawns the SAME headless serve command rather than re-wiring its
 * internals. This preserves byte-for-byte parity and isolates the
 * server's process-global behavior in a child.
 *
 * `start()` spawns the child with `--port 0` (OS-assigned, collision
 * free), streams its stdout/stderr onto the bus as `log` events keyed by
 * the target id, and resolves once the child prints its first
 * `Server listening on <url>` line — emitting a `serve` `running` event
 * with the discovered endpoints. `stop()` SIGTERMs the child (SIGKILL
 * after a grace window) and emits `stopped`.
 *
 * Request capture for traffic to the served port (decision D4a / D5) and
 * full-text log search arrive in slice C2; C1 is lifecycle + log
 * streaming only.
 */
export function createStudioServeManager(config: StudioServeManagerConfig): StudioServeManager {
  const spawnFn = config.spawnFn ?? nodeSpawn;
  const nodeBin = config.nodeBin ?? process.execPath;
  const clock = config.clock ?? Date.now;
  const readyTimeoutMs = config.readyTimeoutMs ?? 120_000;
  const stopGraceMs = config.stopGraceMs ?? 10_000;
  const setTimeoutFn = config.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = config.clearTimeoutFn ?? clearTimeout;
  const cwd = config.cwd ?? process.cwd();

  const entries = new Map<string, ServeEntry>();

  function publicState(e: ServeEntry): StudioServeState {
    const s: StudioServeState = {
      targetId: e.targetId,
      kind: e.kind,
      status: e.status,
      endpoints: [...e.endpoints],
      startedAt: e.startedAt,
    };
    if (e.pid !== undefined) s.pid = e.pid;
    return s;
  }

  function emitServe(e: ServeEntry, message?: string): void {
    const ev: StudioServeEvent = {
      ts: clock(),
      target: e.targetId,
      kind: e.kind,
      status: e.status,
      endpoints: [...e.endpoints],
    };
    if (e.pid !== undefined) ev.pid = e.pid;
    if (message !== undefined) ev.message = message;
    config.bus.emit('serve', ev);
  }

  function buildArgs(targetId: string): string[] {
    const args = ['start-api', targetId, '--port', '0', '--host', '127.0.0.1'];
    if (config.app) args.push('--app', config.app);
    if (config.profile) args.push('--profile', config.profile);
    if (config.region) args.push('--region', config.region);
    for (const [k, v] of Object.entries(config.context ?? {})) {
      args.push('-c', `${k}=${v}`);
    }
    return args;
  }

  async function start(req: StudioServeRequest): Promise<StudioServeState> {
    if (!SERVE_SUPPORTED.includes(req.kind)) {
      throw new Error(
        `Serving '${req.kind}' targets from studio is not supported yet (API only in this build).`
      );
    }
    const existing = entries.get(req.targetId);
    if (existing && existing.status !== 'stopped' && existing.status !== 'error') {
      throw new Error(`'${req.targetId}' is already running.`);
    }

    const startedAt = clock();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(nodeBin, [config.cliEntry, ...buildArgs(req.targetId)], { cwd });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    const entry: ServeEntry = {
      targetId: req.targetId,
      kind: req.kind,
      status: 'starting',
      endpoints: [],
      startedAt,
      child,
    };
    if (child.pid !== undefined) entry.pid = child.pid;
    entries.set(req.targetId, entry);
    emitServe(entry);

    return new Promise<StudioServeState>((resolve, reject) => {
      let settled = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      const timer = setTimeoutFn(() => {
        if (settled) return;
        settled = true;
        entry.status = 'error';
        emitServe(entry, `Timed out after ${readyTimeoutMs}ms waiting for the server to listen.`);
        // Graceful SIGTERM -> SIGKILL (NOT an immediate SIGKILL): `start-api`
        // traps SIGTERM to tear down its RIE containers, so a hard kill on a
        // half-booted child would orphan those containers.
        void stopChild(child, stopGraceMs, setTimeoutFn, clearTimeoutFn);
        entries.delete(req.targetId);
        reject(new Error(`'${req.targetId}' did not start within ${readyTimeoutMs}ms.`));
      }, readyTimeoutMs);
      timer.unref?.();

      const becomeRunning = (): void => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        entry.status = 'running';
        emitServe(entry);
        resolve(publicState(entry));
      };

      streamLines(child.stdout, (line) => {
        const m = LISTENING_RE.exec(line);
        if (m?.[1]) {
          if (!entry.endpoints.includes(m[1])) entry.endpoints.push(m[1]);
          // First listening line flips the serve to running; later lines
          // (multi-listener apps) append + re-emit so the UI's endpoint
          // list fills in.
          if (settled) emitServe(entry);
          else becomeRunning();
        }
        emitLog(config.bus, clock, req.targetId, line, 'stdout');
      });
      streamLines(child.stderr, (line) => {
        emitLog(config.bus, clock, req.targetId, line, 'stderr');
      });

      child.on('error', (err) => {
        if (settled) {
          // Post-ready spawn error: mark the entry errored for the UI.
          entry.status = 'error';
          emitServe(entry, err.message);
          entries.delete(req.targetId);
          return;
        }
        settled = true;
        clearTimeoutFn(timer);
        entry.status = 'error';
        emitServe(entry, err.message);
        entries.delete(req.targetId);
        reject(err);
      });

      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeoutFn(timer);
          if (entry.stopping) {
            // A user `stop()` raced the still-starting child: not a boot
            // failure. `stop()` emits the `stopped` event + resolves itself,
            // so here we only reject the pending `start()` (the /api/run POST)
            // with an honest "cancelled" message and emit nothing.
            reject(new Error(`'${req.targetId}' was stopped before it finished starting.`));
            return;
          }
          // Exited before ever listening — a boot failure.
          entry.status = 'error';
          const msg = `Server exited before listening (code ${code ?? 'null'}).`;
          emitServe(entry, msg);
          entries.delete(req.targetId);
          reject(new Error(msg));
          return;
        }
        // Exited while running (crash or our own stop()). If still tracked
        // as running, surface it as stopped; stop() removes the entry
        // itself before this fires in the graceful path.
        const tracked = entries.get(req.targetId);
        if (tracked === entry && entry.status === 'running') {
          entry.status = 'stopped';
          emitServe(entry, `Server process exited (code ${code ?? 'null'}).`);
          entries.delete(req.targetId);
        }
      });
    });
  }

  async function stop(req: StudioStopRequest): Promise<void> {
    const entry = entries.get(req.targetId);
    if (!entry) {
      throw new Error(`'${req.targetId}' is not running.`);
    }
    // Flag so the child's `close` handler treats this as a user stop, not a
    // boot failure, when the serve was still `starting` (#1).
    entry.stopping = true;
    entries.delete(req.targetId);
    await stopChild(entry.child, stopGraceMs, setTimeoutFn, clearTimeoutFn);
    entry.status = 'stopped';
    emitServe(entry);
  }

  function list(): StudioServeState[] {
    return [...entries.values()].map(publicState);
  }

  async function stopAll(): Promise<void> {
    const targets = [...entries.keys()];
    // `stop()` itself always resolves for a tracked target (stopChild
    // escalates SIGTERM -> SIGKILL and resolves on close); the only reject
    // path is the "not running" race if a sibling stop already evicted the
    // key. The catch keeps one such race from aborting the rest of the
    // shutdown sweep.
    await Promise.all(targets.map((targetId) => stop({ targetId }).catch(() => undefined)));
  }

  return { start, stop, list, stopAll };
}

/** Emit one container log line onto the bus, keyed by the serve target id. */
function emitLog(
  bus: StudioEventBus,
  clock: () => number,
  target: string,
  line: string,
  stream: 'stdout' | 'stderr'
): void {
  bus.emit('log', { ts: clock(), containerId: target, target, line, stream });
}

/**
 * Line-buffer a child stream and invoke `onLine` per complete line
 * (trailing newline stripped, blank lines dropped). Flushes any partial
 * final line on stream end.
 */
function streamLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = '';
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.length > 0) onLine(line);
      nl = buf.indexOf('\n');
    }
  });
  stream.on('end', () => {
    const line = buf.replace(/\r$/, '');
    if (line.length > 0) onLine(line);
    buf = '';
  });
}

/**
 * SIGTERM a child and resolve once it exits, escalating to SIGKILL after
 * `graceMs`. Resolves immediately if the child has already exited.
 */
function stopChild(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (kill) clearTimeoutFn(kill);
      resolve();
    };
    // Attach the `close` listener BEFORE the already-exited check so a child
    // that exits in the window between the check and the listener attach is
    // not missed (which would leave the promise pending forever). #4
    child.once('close', finish);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    kill = setTimeoutFn(() => {
      if (!done) child.kill('SIGKILL');
    }, graceMs);
    kill.unref?.();
    child.kill('SIGTERM');
  });
}
