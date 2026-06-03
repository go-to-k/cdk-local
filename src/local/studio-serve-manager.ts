import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioEventBus, type StudioServeEvent, type StudioTargetKind } from './studio-events.js';
import {
  startStudioProxy,
  type RunningStudioProxy,
  type StudioProxyConfig,
} from './studio-proxy.js';
import { buildSharedChildArgs, type SharedChildConfig } from './studio-child-args.js';
import { buildPerRunArgs, resolveEnvVars, type OptionValues } from './studio-option-specs.js';
import { tokenizeRawArgs } from './studio-option-catalog.js';

/** A request to start serving a target, as the studio UI posts it. */
export interface StudioServeRequest {
  /** Target id the user picked (display path or stack-qualified id). */
  targetId: string;
  /** Target kind — a serve kind (`api` / `alb` / `ecs`); see SERVE_SPECS. */
  kind: StudioTargetKind;
  /** Per-run option values (issue #301 slice 2), keyed by option flag. */
  options?: OptionValues;
  /**
   * Raw extra args from the "All options" section — tokenized (quote-aware)
   * and appended verbatim to the spawned serve child, so a flag the curated
   * controls don't expose can still be passed.
   */
  rawArgs?: string;
  /**
   * Dockerfile path picked for a pinned `ecs` service (issue #301) — appended
   * as `--image-override <path>` so `start-service` rebuilds the
   * deployed-registry-pinned image from local source. Bare (picker) form: the
   * single booted service is the override target. Ignored when blank.
   */
  imageOverride?: string;
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
  /**
   * Direct host URL for an `ecs` serve published via `--host-port` (issue
   * #322). Unlike `endpoints` (api / alb capture-proxy URLs), this is the
   * replica's own host port with NO proxy in front — so the in-workspace
   * request composer can target it, but a request to it is NOT captured on
   * the timeline. Absent for api / alb (use `endpoints`) and for an ecs
   * serve started without `--host-port`.
   */
  hostUrl?: string;
  /** Child process id. */
  pid?: number;
  /** Wall-clock epoch ms when the serve started. */
  startedAt: number;
}

/** Config for {@link createStudioServeManager}. */
export interface StudioServeManagerConfig extends SharedChildConfig {
  /** Path to the `cdkl` CLI entry (`dist/cli.js`) — usually `process.argv[1]`. */
  cliEntry: string;
  /** The shared event bus; serve + log events are emitted onto it. */
  bus: StudioEventBus;
  /**
   * When true, append `--watch` to each spawned serve child (`start-api` /
   * `start-alb` / `start-service`) so a serve started from the studio UI
   * re-synths + rolling-reloads on CDK source changes — `cdkl studio --watch`
   * (issue #301). Read per-`start()` off this (mutable) config object, so a
   * `PATCH /api/config` toggle applies to subsequently-started serves. Has NO
   * effect on single-shot invokes (the dispatcher re-synths every run anyway).
   */
  watch?: boolean;
  /** Working directory for the child serve (defaults to `process.cwd()`). */
  cwd?: string;
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
   * Generous by default so a serve command running its OWN teardown
   * completes first — `start-alb` / `start-service` drain + remove their
   * ECS replicas + the shared docker network, which can take well over
   * 10s; a premature SIGKILL would orphan those containers/network.
   * Defaults to 45_000.
   */
  stopGraceMs?: number;
  /** `setTimeout` (injectable for tests). */
  setTimeoutFn?: typeof setTimeout;
  /** `clearTimeout` (injectable for tests). */
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * Factory for the capture proxy fronting each HTTP serve endpoint
   * (slice C2). Injectable for tests; defaults to {@link startStudioProxy}.
   * When `captureRequests` is false this is never called.
   */
  proxyFactory?: (config: StudioProxyConfig) => Promise<RunningStudioProxy>;
  /**
   * Front each HTTP serve endpoint with a capture proxy so every request
   * to the served port lands on the studio timeline (decision D4a).
   * Defaults to true; set false to hand the child's port through
   * unproxied (the slice C1 behavior).
   */
  captureRequests?: boolean;
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

/** How the serve manager drives one long-running serve kind. */
interface ServeKindSpec {
  /** Headless subcommand spawned (e.g. `start-api`). */
  command: string;
  /** Port / host flags this command accepts (start-api binds an HTTP port). */
  portArgs: readonly string[];
  /**
   * The stdout line that signals readiness. Capture group 1, when present,
   * is the served endpoint URL (api / alb); a kind with no host endpoint
   * (ecs service — pure compute) matches with NO capture group.
   */
  readyRe: RegExp;
  /** Front each HTTP endpoint with a capture proxy (api / alb yes, ecs no). */
  capturesHttp: boolean;
}

/**
 * The serve lifecycle per kind. `api` + `alb` expose host HTTP endpoints
 * the studio capture proxy fronts; `ecs` (start-service) is pure compute
 * with no host port, so it has no endpoint and no capture — studio just
 * runs the replicas + streams their logs.
 */
const SERVE_SPECS: Partial<Record<StudioTargetKind, ServeKindSpec>> = {
  api: {
    command: 'start-api',
    portArgs: ['--port', '0', '--host', '127.0.0.1'],
    readyRe: /Server listening on (\S+)/,
    capturesHttp: true,
  },
  alb: {
    // start-alb binds the deployed listener ports directly (no --port);
    // its front-door line carries the bound URL. Anchor the capture on a
    // URL scheme: under --tls start-alb also logs `ALB front-door:
    // generated self-signed cert at ...`, which a bare `(\S+)` would match
    // (capturing `generated`) and flip the serve to running prematurely.
    command: 'start-alb',
    portArgs: [],
    readyRe: /ALB front-door: (https?:\/\/\S+)/,
    capturesHttp: true,
  },
  ecs: {
    // start-service runs the service replicas only — no host port, no
    // capture. `Service(s) running:` is its stable ready marker.
    command: 'start-service',
    portArgs: [],
    readyRe: /Service\(s\) running:/,
    capturesHttp: false,
  },
  'ecs-task': {
    // run-task runs a task definition's containers once (issue #366). For a
    // server task def the containers stream logs until stopped (the serve
    // lifecycle); a batch task exits and the run flips to stopped. No host
    // port, no capture. `Task running (family=...)` (the run-task onReady
    // banner) is its stable ready marker.
    command: 'run-task',
    portArgs: [],
    readyRe: /Task running \(family=/,
    capturesHttp: false,
  },
  cloudfront: {
    // start-cloudfront serves the distribution's S3 origin + CloudFront
    // Functions over a local HTTP port (issue #363 / #367). It binds an
    // OS-assigned port with --port 0 and logs `CloudFront distribution
    // serving on <url>`; front it with a capture proxy like api / alb so
    // requests land on the timeline.
    command: 'start-cloudfront',
    portArgs: ['--port', '0', '--host', '127.0.0.1'],
    readyRe: /CloudFront distribution serving on (https?:\/\/\S+)/,
    capturesHttp: true,
  },
};

interface ServeEntry extends StudioServeState {
  child: ChildProcessWithoutNullStreams;
  /** Capture proxies fronting this serve's HTTP endpoints (slice C2). */
  proxies: RunningStudioProxy[];
  /**
   * Temp dir holding the `--env-vars` SAM-shape file (issue #355), when the
   * serve was started with env-var overrides. Removed on teardown (the file
   * must outlive a `--watch` serve's reloads, which re-read it, so it is
   * cleaned up only when the serve stops — not after spawn).
   */
  envDir?: string;
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
 * Slice C2 fronts each HTTP serve endpoint with a capture proxy
 * ({@link startStudioProxy}) so every request to the served port lands
 * on the studio timeline (decision D4a); the `endpoints` the UI is
 * handed are the proxy URLs. The serve-kinds slice generalized this to a
 * per-kind {@link ServeKindSpec}: `api` (`start-api`) + `alb`
 * (`start-alb`) expose host HTTP endpoints the proxy captures, while
 * `ecs` (`start-service`) is pure compute — no host port, no capture,
 * just the running replicas + their streamed logs.
 */
export function createStudioServeManager(config: StudioServeManagerConfig): StudioServeManager {
  const spawnFn = config.spawnFn ?? nodeSpawn;
  const nodeBin = config.nodeBin ?? process.execPath;
  const clock = config.clock ?? Date.now;
  const readyTimeoutMs = config.readyTimeoutMs ?? 120_000;
  const stopGraceMs = config.stopGraceMs ?? 45_000;
  const setTimeoutFn = config.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = config.clearTimeoutFn ?? clearTimeout;
  const cwd = config.cwd ?? process.cwd();
  const proxyFactory = config.proxyFactory ?? startStudioProxy;
  const captureRequests = config.captureRequests ?? true;

  const entries = new Map<string, ServeEntry>();

  /**
   * Release every per-serve resource fronting `e` (best-effort; idempotent):
   * its capture proxies (slice C2) and the `--env-vars` temp dir (issue #355).
   * Called at every teardown path so neither a proxy socket nor the env file
   * leaks when a serve stops / errors / times out.
   */
  async function closeProxies(e: ServeEntry): Promise<void> {
    const proxies = e.proxies.splice(0);
    await Promise.all(proxies.map((p) => p.close().catch(() => undefined)));
    if (e.envDir) {
      try {
        rmSync(e.envDir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup — a leftover temp dir is harmless */
      }
      delete e.envDir;
    }
  }

  function publicState(e: ServeEntry): StudioServeState {
    const s: StudioServeState = {
      targetId: e.targetId,
      kind: e.kind,
      status: e.status,
      endpoints: [...e.endpoints],
      startedAt: e.startedAt,
    };
    if (e.pid !== undefined) s.pid = e.pid;
    if (e.hostUrl !== undefined) s.hostUrl = e.hostUrl;
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
    if (e.hostUrl !== undefined) ev.hostUrl = e.hostUrl;
    if (message !== undefined) ev.message = message;
    config.bus.emit('serve', ev);
  }

  function buildArgs(req: StudioServeRequest, spec: ServeKindSpec, envFile?: string): string[] {
    // A `--watch` serve MUST re-synth on source changes, so it keeps
    // `--app <app>`; a non-watch serve reuses the boot-synthesized cloud
    // assembly studio captured (issue #324) and skips its own synth. Read
    // `config.watch` per start (mutable — a Session-bar toggle applies to
    // the next serve), matching the `--watch` flag append below.
    const preferAssembly = config.watch !== true;
    // `cloudfront` runs no container / makes no AWS call, so start-cloudfront
    // declares neither `--from-cfn-stack` nor `--assume-role`; do not forward
    // the session bindings to it (issue #367).
    const omitStateBindings = req.kind === 'cloudfront';
    return [
      spec.command,
      req.targetId,
      ...spec.portArgs,
      ...buildSharedChildArgs(config, { preferAssembly, omitStateBindings }),
      ...buildPerRunArgs(req.kind, req.options),
      // The `--env-vars` per-run option takes a FILE (issue #355) — the env-kv
      // KV rows / JSON were materialized into a SAM-shape temp file by the
      // caller; point start-service / start-alb at it so the override applies
      // to the backing ECS task containers.
      ...(envFile ? ['--env-vars', envFile] : []),
      // Image-override picker (issue #301): a pinned ecs service rebuilds from
      // the chosen local Dockerfile. The EXPLICIT `<target>=<dockerfile>` form
      // is used (not the bare picker form) because studio spawns the child
      // WITHOUT a TTY — the engine skips bare picker-form paths when
      // non-interactive, but the explicit form maps deterministically. The
      // target key is the same id passed as the start-service target arg.
      ...(req.imageOverride && req.imageOverride.trim() !== ''
        ? ['--image-override', req.targetId + '=' + req.imageOverride.trim()]
        : []),
      // `cdkl studio --watch` (issue #301): every serve kind (start-api /
      // start-alb / start-service) implements `--watch` rolling reload, so
      // forwarding the bare flag makes a UI-started serve hot-reload on source
      // changes. Read off the (mutable) config per start so a Session-bar
      // toggle applies to the next serve.
      ...(config.watch === true ? ['--watch'] : []),
      // Raw extra args go LAST so a user can override an earlier flag if they
      // mean to (Commander takes the last value for a scalar flag).
      ...tokenizeRawArgs(req.rawArgs),
    ];
  }

  async function start(req: StudioServeRequest): Promise<StudioServeState> {
    const spec = SERVE_SPECS[req.kind];
    if (!spec) {
      throw new Error(
        `Serving '${req.kind}' targets from studio is not supported (serve kinds: ${Object.keys(SERVE_SPECS).join(', ')}).`
      );
    }
    const existing = entries.get(req.targetId);
    if (existing && existing.status !== 'stopped' && existing.status !== 'error') {
      throw new Error(`'${req.targetId}' is already running.`);
    }

    const startedAt = clock();

    // Materialize the `--env-vars` env-kv option (issue #355) into a SAM-shape
    // temp file the serve child reads. Computed BEFORE spawn so a malformed
    // JSON value throws as a clean /api/run boundary error rather than after a
    // child is already running. The dir outlives the child (a `--watch` serve
    // re-reads the file on reload) and is removed on teardown via closeProxies.
    let envDir: string | undefined;
    const envVars = resolveEnvVars(req.kind, req.options);
    if (envVars) {
      envDir = mkdtempSync(join(tmpdir(), 'cdkl-studio-env-'));
      writeFileSync(join(envDir, 'env-vars.json'), JSON.stringify(envVars));
    }
    const envFile = envDir ? join(envDir, 'env-vars.json') : undefined;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(nodeBin, [config.cliEntry, ...buildArgs(req, spec, envFile)], { cwd });
    } catch (err) {
      // Spawn never happened — drop the env temp dir so it does not leak.
      if (envDir) {
        try {
          rmSync(envDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    const entry: ServeEntry = {
      targetId: req.targetId,
      kind: req.kind,
      status: 'starting',
      endpoints: [],
      startedAt,
      child,
      proxies: [],
    };
    if (child.pid !== undefined) entry.pid = child.pid;
    // Bind the env temp dir to the entry so closeProxies removes it on teardown.
    if (envDir) entry.envDir = envDir;
    // An ecs serve published via `--host-port` is reachable on the host (issue
    // #322); surface its host URL so the in-workspace request composer can
    // target it (the first mapping's host port). No proxy fronts it, so a
    // request to it is not captured on the timeline.
    if (req.kind === 'ecs') {
      const hp = req.options?.['--host-port'];
      if (Array.isArray(hp)) {
        const first = hp.find(
          (r) => r && typeof r === 'object' && typeof r.right === 'string' && r.right.trim() !== ''
        );
        if (first) entry.hostUrl = 'http://127.0.0.1:' + first.right.trim();
      }
    }
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
        emitServe(entry, `Timed out after ${readyTimeoutMs}ms waiting for the serve to be ready.`);
        // Graceful SIGTERM -> SIGKILL (NOT an immediate SIGKILL): the serve
        // commands trap SIGTERM to tear down their containers, so a hard kill
        // on a half-booted child would orphan those containers.
        void stopChild(child, stopGraceMs, setTimeoutFn, clearTimeoutFn);
        void closeProxies(entry);
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

      // Handle a child ready line. `childUrl` (capture group 1) is the
      // served endpoint for api / alb — fronted with a capture proxy (slice
      // C2 / decision D4a) when `capturesHttp` so every request to it lands
      // on the timeline; ws:// (and capture-off) endpoints pass straight
      // through. An ecs service has NO endpoint (`childUrl` undefined): it
      // just flips to running with no endpoint + no proxy. The FIRST ready
      // line flips the serve to running; later ones append + re-emit.
      const onReady = async (childUrl?: string): Promise<void> => {
        let endpoint = childUrl;
        if (childUrl && spec.capturesHttp && captureRequests && /^https?:/i.test(childUrl)) {
          try {
            const proxy = await proxyFactory({
              bus: config.bus,
              target: req.targetId,
              kind: req.kind,
              upstream: childUrl,
            });
            entry.proxies.push(proxy);
            endpoint = proxy.url;
          } catch {
            // Proxy failed to bind — fall back to the direct child URL so
            // the serve is still usable (just uncaptured).
            endpoint = childUrl;
          }
        }
        // A stop() may have raced the async proxy startup; if so, drop the
        // now-orphan proxy and do not resurrect the torn-down serve.
        if (entry.stopping || (settled && !entries.has(req.targetId))) {
          await closeProxies(entry);
          return;
        }
        if (endpoint && !entry.endpoints.includes(endpoint)) entry.endpoints.push(endpoint);
        if (settled) emitServe(entry);
        else becomeRunning();
      };

      streamLines(child.stdout, (line) => {
        const m = spec.readyRe.exec(line);
        // m[1] is the endpoint URL for api / alb; undefined for ecs (no
        // capture group) — a ready line with no host endpoint.
        if (m) void onReady(m[1]);
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
          void closeProxies(entry);
          entries.delete(req.targetId);
          return;
        }
        settled = true;
        clearTimeoutFn(timer);
        entry.status = 'error';
        emitServe(entry, err.message);
        void closeProxies(entry);
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
          void closeProxies(entry);
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
          void closeProxies(entry);
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
    // Tear down the capture proxies and SIGTERM the child concurrently —
    // both are initiated synchronously (stopChild attaches its `close`
    // listener + sends SIGTERM in the same tick) so neither races the
    // child's exit.
    await Promise.all([
      closeProxies(entry),
      stopChild(entry.child, stopGraceMs, setTimeoutFn, clearTimeoutFn),
    ]);
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
