import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  StudioEventBus,
  type StudioInvocationEvent,
  type StudioLogEvent,
  type StudioServeEvent,
} from './studio-events.js';
import { renderStudioHtml } from './studio-ui.js';
import type { StudioStore } from './studio-store.js';
import type { TargetListing } from './target-lister.js';

/** One target as the studio UI consumes it (`GET /api/targets`). */
export interface StudioTarget {
  /** Stable target id — the display path when available, else qualified id. */
  id: string;
  /** Stack-qualified `<Stack>:<LogicalId>` for disambiguation. */
  qualifiedId: string;
  /** API surface kind (REST v1 / HTTP v2 / ...), only for `api` entries. */
  surface?: string;
  /**
   * Within a kind whose entries are not uniformly runnable, marks the ones
   * that are. Used for the `ecs` group, which folds servable ECS *services*
   * (`start-service`) together with ECS *task definitions* (run-task, not a
   * serve target): only services carry `servable: true`.
   */
  servable?: boolean;
  /**
   * Set on a servable `ecs` service OR an `ecs-task` task definition whose
   * image is a deployed-registry pin (ECR / public) rather than a local CDK
   * asset (issue #301 / #388). Local source edits do NOT take effect for a
   * pinned image, so the composer offers a Dockerfile picker that threads
   * `--image-override` to the spawned `start-service` (ecs) / `run-task`
   * (ecs-task). A local-asset target (which already rebuilds locally) is not
   * marked and gets no picker.
   */
  pinned?: boolean;
  /**
   * Set on an `alb` entry: the deployed-registry-pinned ECS services this ALB
   * fronts (issue #384). `start-alb` boots the ALB's backing services, so a
   * pinned backing service has the same "local edits do not take effect"
   * problem a standalone pinned `ecs` service does — the alb composer offers a
   * per-service Dockerfile picker that threads
   * `--image-override <service-qualified-id>=<dockerfile>` to the spawned
   * `start-alb` (the `<service-qualified-id>` is `start-alb`'s own
   * `Stack:LogicalId` service-boot target). Each entry's `id` is that
   * `--image-override` key; `label` is a human-readable service name. Absent /
   * empty when the ALB fronts no pinned service.
   */
  backingPinnedServices?: { id: string; label: string }[];
}

/** A category of targets, grouped by the studio kind that runs them. */
export interface StudioTargetGroup {
  /** Studio kind discriminator shared with {@link StudioInvocationEvent}. */
  kind: 'lambda' | 'api' | 'alb' | 'ecs' | 'ecs-task' | 'cloudfront' | 'agentcore' | 'agentcore-ws';
  /** Human-readable group heading. */
  title: string;
  entries: StudioTarget[];
}

/**
 * Project a {@link TargetListing} (the same enumeration `cdkl list`
 * prints) into the grouped shape the studio UI renders. ECS services and
 * task definitions are folded into one `ecs` group; everything else maps
 * one category to one group. Exported so a unit test can assert the
 * projection without booting the server.
 */
export function toStudioTargetGroups(listing: TargetListing): StudioTargetGroup[] {
  const map = (
    entries: TargetListing['lambdas'],
    opts: { servable?: boolean } = {}
  ): StudioTarget[] =>
    entries.map((e) => {
      const t: StudioTarget = { id: e.displayPath ?? e.qualifiedId, qualifiedId: e.qualifiedId };
      if (e.kind) t.surface = e.kind;
      if (opts.servable !== undefined) t.servable = opts.servable;
      return t;
    });
  return [
    { kind: 'lambda', title: 'Lambda Functions', entries: map(listing.lambdas) },
    { kind: 'api', title: 'APIs', entries: map(listing.apis) },
    // ECS services and task definitions are SEPARATE groups (issue #352),
    // matching `cdkl list`. Services are the `ecs` serve kind (start-service ->
    // Start). Task definitions are the `ecs-task` kind (issue #366): a [Run]
    // control that runs `cdkl run-task` as a long-running run (server task
    // defs stream logs until stopped; batch tasks exit). The `ecs` services
    // group stays FIRST so `annotatePinnedEcsTargets` (which finds the first
    // `ecs`-kind group) annotates the servable services and NOT the task defs.
    { kind: 'ecs', title: 'ECS Services', entries: map(listing.ecsServices, { servable: true }) },
    { kind: 'ecs-task', title: 'ECS Task Definitions', entries: map(listing.ecsTaskDefinitions) },
    { kind: 'agentcore', title: 'AgentCore Runtimes', entries: map(listing.agentCoreRuntimes) },
    // The same runtimes that have a /ws endpoint (HTTP / AGUI — MCP / A2A
    // don't) ALSO appear as an `agentcore-ws` serve group: a [Start]/[Stop]
    // control that runs `cdkl start-agentcore` and renders an interactive
    // WebSocket console (like the API Gateway WebSocket console). The dual
    // listing mirrors the ecs / ecs-task split — invoke once vs hold a live
    // session are genuinely different operations.
    {
      kind: 'agentcore-ws',
      title: 'AgentCore WebSocket',
      entries: map(listing.agentCoreRuntimes.filter((e) => e.agentCoreHasWs)),
    },
    { kind: 'alb', title: 'Application Load Balancers', entries: map(listing.loadBalancers) },
    // CloudFront distributions are a serve target (start-cloudfront -> Start),
    // like api / alb — they expose a host HTTP endpoint (issue #367 / #363).
    {
      kind: 'cloudfront',
      title: 'CloudFront Distributions',
      entries: map(listing.cloudFrontDistributions),
    },
  ];
}

/**
 * Annotate the servable `ecs` service entries of `groups` with `pinned: true`
 * when `classify(targetId)` returns true (issue #301). `classify` decides
 * pinned (deployed-registry image) vs local CDK asset for one service id; the
 * caller supplies it (studio's boot does `resolveEcsServiceTarget` +
 * `isLocalCdkAssetImage`, swallowing resolution failures as "not pinned").
 * Mutates the entries in place and returns whether ANY service was pinned, so
 * the caller can skip the (otherwise pointless) Dockerfile scan for an
 * all-local-asset app. Non-ecs groups and non-servable entries (task defs) are
 * left untouched. Exported so a host CLI building its own studio can reuse the
 * same pinned-target annotation, and so the boot logic is unit-testable
 * without a real synth.
 */
export function annotatePinnedEcsTargets(
  groups: StudioTargetGroup[],
  classify: (targetId: string) => boolean
): boolean {
  let anyPinned = false;
  for (const group of groups) {
    if (group.kind !== 'ecs') continue;
    for (const entry of group.entries) {
      if (!entry.servable) continue;
      if (classify(entry.id)) {
        entry.pinned = true;
        anyPinned = true;
      }
    }
  }
  return anyPinned;
}

/**
 * Annotate the `ecs-task` task-definition entries of `groups` with
 * `pinned: true` when `classify(targetId)` returns true (issue #388). The
 * counterpart of {@link annotatePinnedEcsTargets} for the `ecs-task` kind: a
 * task definition whose representative container image is a deployed-registry
 * pin gets the same image-override Dockerfile picker (the `ecs-task` composer
 * spawns `cdkl run-task`, which now accepts `--image-override`). `classify`
 * decides pinned vs local CDK asset for one task-def id (studio's boot resolves
 * the task via `resolveEcsTaskTarget` and checks the representative container's
 * image kind). Unlike the `ecs` group there is no `servable` gate — every
 * task-def entry is run via run-task. Mutates the entries in place and returns
 * whether ANY task definition was pinned, so the caller can include the
 * Dockerfile scan even when no standalone `ecs` service was pinned. Non-ecs-task
 * groups are left untouched. Exported so a host CLI can reuse it + so the boot
 * logic is unit-testable without a real synth.
 */
export function annotateEcsTaskPinnedTargets(
  groups: StudioTargetGroup[],
  classify: (targetId: string) => boolean
): boolean {
  let anyPinned = false;
  for (const group of groups) {
    if (group.kind !== 'ecs-task') continue;
    for (const entry of group.entries) {
      if (classify(entry.id)) {
        entry.pinned = true;
        anyPinned = true;
      }
    }
  }
  return anyPinned;
}

/**
 * Annotate each `alb` entry of `groups` with the deployed-registry-pinned ECS
 * services that ALB fronts (issue #384), so the alb composer can offer a
 * per-service image-override Dockerfile picker. `resolveBackingPinned` maps one
 * ALB entry to its pinned backing services (`{ id, label }`, where `id` is the
 * `--image-override` key — `start-alb`'s `Stack:LogicalId` service-boot
 * target); the caller supplies it (studio's boot resolves the ALB via
 * `resolveAlbFrontDoor` and intersects the backing services with the already-
 * classified pinned `ecs` set). Mutates the entries in place and returns whether
 * ANY ALB fronts a pinned service, so the caller can include the Dockerfile
 * scan even when no standalone `ecs` service was pinned. Non-alb groups are
 * left untouched. Exported so a host CLI can reuse it + so the boot logic is
 * unit-testable without a real synth.
 */
export function annotateAlbPinnedBackingServices(
  groups: StudioTargetGroup[],
  resolveBackingPinned: (albEntry: StudioTarget) => { id: string; label: string }[]
): boolean {
  let any = false;
  for (const group of groups) {
    if (group.kind !== 'alb') continue;
    for (const entry of group.entries) {
      const pinned = resolveBackingPinned(entry);
      if (pinned.length > 0) {
        entry.backingPinnedServices = pinned;
        any = true;
      }
    }
  }
  return any;
}

/** Compile a `*` / `?` glob to an anchored RegExp matched against a target id. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Filter the studio target groups to the entries whose id matches ANY of
 * the `--stack` globs (issue #301 slice 4). A target id is `Stack/Construct`,
 * so `dev/*` keeps stack `dev`'s targets and `dev*` keeps any stack whose
 * name starts `dev`. This is **display-only** — it scopes the targets LISTED
 * in the UI, NOT the synth (the whole CDK app is still synthesized; use the
 * app's own `-c` context gating / a committed `cdk.context.json` to scope
 * synth). No globs returns the groups unchanged.
 */
export function filterStudioTargetGroups(
  groups: StudioTargetGroup[],
  globs: string[] | undefined
): StudioTargetGroup[] {
  if (!globs || globs.length === 0) return groups;
  const matchers = globs.map(globToRegExp);
  return groups.map((g) => ({
    ...g,
    entries: g.entries.filter((e) => matchers.some((r) => r.test(e.id))),
  }));
}

/** Inputs to {@link startStudioServer}. */
export interface StudioServerOptions {
  /** Preferred listen port; bumps on collision (decision: collision-safe). */
  port: number;
  /** Listen host. Defaults to `127.0.0.1` (localhost-only). */
  host?: string;
  /** The shared event bus the SSE stream forwards. */
  bus: StudioEventBus;
  /** Target groups to serve at `GET /api/targets`. */
  targetGroups: StudioTargetGroup[];
  /**
   * Dockerfiles discovered under the app directory at boot (issue #301),
   * served alongside the target groups at `GET /api/targets`. The serve
   * composer of a pinned `ecs` service offers them in an image-override
   * picker. Empty / omitted => no picker options.
   */
  dockerfiles?: string[];
  /** Header label for the running app / stack context. */
  appLabel: string;
  /** CLI brand name (`cdkl`, or a host rebrand). */
  cliName: string;
  /**
   * Max consecutive ports to try on `EADDRINUSE` before giving up.
   * Defaults to 20.
   */
  maxPortBump?: number;
  /**
   * Handler for `POST /api/run` — runs a target (single-shot Lambda
   * invoke, or start a long-running serve target) and returns the
   * result. When omitted, `/api/run` answers 501 (the observe-only
   * shell). The body is the parsed JSON request; the handler emits its
   * own invocation / serve / log events onto the bus, so the UI's
   * timeline + running state update over SSE independently of the
   * response.
   */
  onRun?: (body: unknown) => Promise<unknown>;
  /**
   * Handler for `POST /api/stop` — stop a running serve target. When
   * omitted, `/api/stop` answers 501. The body identifies the target.
   */
  onStop?: (body: unknown) => Promise<unknown>;
  /**
   * Handler for `POST /api/request` (issue #322) — relay a composed HTTP
   * request to a RUNNING serve target's endpoint, server-side, and return the
   * response. The browser composer posts here (same-origin) so it never hits
   * the served port cross-origin. When omitted, `/api/request` answers 501.
   */
  onServeRequest?: (body: unknown) => Promise<unknown>;
  /**
   * Handler for `POST /api/reinvoke` (issue #284) — re-run a past timeline
   * row with an edited payload. Body `{ invocationId, payload }`; resolves the
   * source target from the store and re-dispatches the edited payload (Lambda /
   * AgentCore only). When omitted, `/api/reinvoke` answers 501.
   */
  onReinvoke?: (body: unknown) => Promise<unknown>;
  /**
   * Snapshot of the currently-running serve targets, served at
   * `GET /api/running`. When omitted, the endpoint returns an empty
   * list (the observe-only shell never runs anything).
   */
  getRunning?: () => unknown;
  /**
   * In-memory event/log store (slice C3) backing the history + log-search
   * + per-request-log endpoints (`GET /api/history`, `GET /api/logs`,
   * `GET /api/invocations/<id>/logs`). When omitted those endpoints return
   * empty results.
   */
  store?: StudioStore;
  /**
   * Session config snapshot served at `GET /api/config` (issue #301 slice 3)
   * — the read-only synth-time context (profile / region / app) plus the
   * editable run-time bindings (from-cfn-stack / assume-role). When omitted
   * the endpoint returns an empty config.
   */
  getConfig?: () => unknown;
  /**
   * Handler for `PATCH /api/config` — update the editable run-time bindings
   * (from-cfn-stack / assume-role); the change applies to subsequent runs.
   * Returns the updated config. When omitted, `/api/config` is read-only and
   * a PATCH answers 501.
   */
  patchConfig?: (body: unknown) => Promise<unknown>;
}

/** A running studio server. */
export interface RunningStudioServer {
  /** The URL the UI is served at, e.g. `http://127.0.0.1:9999`. */
  url: string;
  /** The actually-bound port (may differ from the requested one). */
  port: number;
  /** Stop the server and release the port. */
  close: () => Promise<void>;
  /**
   * Replace the target list served at `GET /api/targets` under the live socket
   * (issue #385). studio calls this when the Session-bar `--from-cfn-stack`
   * binding changes and the ECS image-pin classification is re-run, so the
   * image-override pickers appear without restarting studio. The next
   * `GET /api/targets` returns the new groups + dockerfiles.
   */
  setTargets: (groups: StudioTargetGroup[], dockerfiles?: string[]) => void;
}

const SSE_HEARTBEAT_MS = 15_000;

/**
 * Boot the studio HTTP server: serves the embedded UI at `/`, the target
 * list at `/api/targets`, and a Server-Sent-Events stream of the bus's
 * `invocation` / `log` events at `/api/events`. Localhost-only by
 * default. Resolves once the socket is listening.
 */
export async function startStudioServer(
  options: StudioServerOptions
): Promise<RunningStudioServer> {
  const host = options.host ?? '127.0.0.1';
  const maxBump = options.maxPortBump ?? 20;
  const html = renderStudioHtml(options.appLabel, options.cliName);
  // A per-boot identity so the browser can tell THIS server instance apart
  // from any other studio process. The SSE stream announces it in a `hello`
  // event on connect; the UI flips to "disconnected" if a reconnect ever
  // lands on a DIFFERENT instance (e.g. a second `cdkl studio` that reused
  // this port after the originating process exited). Without it, liveness
  // tracked only the TCP socket + port, so the UI could read as "live"
  // against the wrong server.
  const instanceId = randomUUID();
  // The served target list is mutable (issue #385): a Session-bar
  // `--from-cfn-stack` change re-runs the ECS pin classification and pushes a
  // fresh groups + dockerfiles set in via `setTargets`. Held as a
  // pre-stringified cell read per `GET /api/targets`, so the swap is atomic
  // (one assignment) and a request reads either the old or the new JSON whole.
  let targetsJson = JSON.stringify({
    groups: options.targetGroups,
    dockerfiles: options.dockerfiles ?? [],
  });

  const server = createServer((req, res) =>
    handleRequest(req, res, options.bus, html, () => targetsJson, options, instanceId)
  );

  const boundPort = await listenWithBump(server, host, options.port, maxBump);

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
        // closeAllConnections exists on Node 18.2+; SSE keeps sockets open
        // so without this `close()` would hang on live EventSource clients.
        server.closeAllConnections?.();
      }),
    setTargets: (groups, dockerfiles) => {
      targetsJson = JSON.stringify({ groups, dockerfiles: dockerfiles ?? [] });
    },
  };
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bus: StudioEventBus,
  html: string,
  getTargetsJson: () => string,
  options: StudioServerOptions,
  instanceId: string
): void {
  const url = req.url ?? '/';
  const path = url.split('?')[0];

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.method === 'GET' && path === '/api/targets') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(getTargetsJson());
    return;
  }
  if (req.method === 'GET' && path === '/api/running') {
    const running = options.getRunning ? options.getRunning() : { running: [] };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(running));
    return;
  }
  if (req.method === 'GET' && path === '/api/history') {
    const history = options.store ? options.store.history() : { invocations: [], logs: [] };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(history));
    return;
  }
  if (req.method === 'GET' && path === '/api/logs') {
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    const query = params.get('q') ?? '';
    // `|| undefined`: a bare `target=` (empty) means "no filter", not
    // "logs whose target is the empty string".
    const target = params.get('target') || undefined;
    const logs = options.store
      ? options.store.searchLogs(query, target !== undefined ? { target } : {})
      : [];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ logs }));
    return;
  }
  // `GET /api/invocations/<id>/logs` — the request's logs at CloudWatch
  // granularity (decision D5).
  const invLogsMatch = /^\/api\/invocations\/([^/]+)\/logs$/.exec(path ?? '');
  if (req.method === 'GET' && invLogsMatch) {
    const id = decodeURIComponent(invLogsMatch[1] ?? '');
    const logs = options.store ? options.store.logsForInvocation(id) : [];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ logs }));
    return;
  }
  if (req.method === 'GET' && path === '/api/config') {
    const config = options.getConfig ? options.getConfig() : {};
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(config));
    return;
  }
  if (req.method === 'PATCH' && path === '/api/config') {
    void handleDispatch(req, res, options.patchConfig);
    return;
  }
  if (req.method === 'GET' && path === '/api/events') {
    serveSse(req, res, bus, instanceId);
    return;
  }
  if (req.method === 'POST' && path === '/api/run') {
    void handleDispatch(req, res, options.onRun);
    return;
  }
  if (req.method === 'POST' && path === '/api/reinvoke') {
    void handleDispatch(req, res, options.onReinvoke);
    return;
  }
  if (req.method === 'POST' && path === '/api/request') {
    void handleDispatch(req, res, options.onServeRequest);
    return;
  }
  if (req.method === 'POST' && path === '/api/stop') {
    void handleDispatch(req, res, options.onStop);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

const MAX_RUN_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Reply to a JSON POST endpoint (`/api/run` / `/api/stop`): parse the
 * bounded JSON body and dispatch via `handler`. 501 when no handler is
 * wired (the observe-only shell), 400 on a malformed body, 500 when the
 * handler throws.
 */
async function handleDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  handler?: (body: unknown) => Promise<unknown>
): Promise<void> {
  const sendJson = (statusCode: number, payload: unknown): void => {
    res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };

  if (!handler) {
    // The observe-only shell (no dispatcher wired) cannot run targets.
    sendJson(501, { error: 'Running targets is not supported by this studio server.' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  try {
    const result = await handler(body);
    sendJson(200, result);
  } catch (err) {
    sendJson(500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Read + JSON-parse a request body, bounded to {@link MAX_RUN_BODY_BYTES}. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolveBody, reject) => {
    let raw = '';
    let bytes = 0;
    // Single-flight: once the promise settles (over-limit / end / error) the
    // handlers short-circuit so a late chunk or the destroy-triggered `error`
    // cannot re-settle it.
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      fn();
    };
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RUN_BODY_BYTES) {
        settle(() => reject(new Error('Request body too large.')));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      settle(() => {
        if (raw.trim() === '') {
          resolveBody(undefined);
          return;
        }
        try {
          resolveBody(JSON.parse(raw));
        } catch {
          reject(new Error('Invalid JSON body.'));
        }
      });
    });
    req.on('error', (err) => settle(() => reject(err)));
  });
}

function serveSse(
  req: IncomingMessage,
  res: ServerResponse,
  bus: StudioEventBus,
  instanceId: string
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  let closed = false;
  // A JS-VISIBLE heartbeat (a named `ping` event, not an SSE `:comment`):
  // the browser EventSource layer cannot observe comments, so the UI runs a
  // client-side watchdog that flips to "disconnected" when these stop
  // arriving — catching a dead server even when the TCP close is never
  // surfaced as an `error` event (a backgrounded tab / a missed FIN).
  const heartbeat = setInterval(() => safeWrite(`event: ping\ndata: {}\n\n`), SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const onInvocation = (ev: StudioInvocationEvent): void => {
    safeWrite(`event: invocation\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const onLog = (ev: StudioLogEvent): void => {
    safeWrite(`event: log\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const onServe = (ev: StudioServeEvent): void => {
    safeWrite(`event: serve\ndata: ${JSON.stringify(ev)}\n\n`);
  };

  // Idempotent teardown: unsubscribe from the bus + stop the heartbeat so
  // a dropped EventSource client never leaks a listener.
  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    bus.off('invocation', onInvocation);
    bus.off('log', onLog);
    bus.off('serve', onServe);
  }

  // Guard every write: on shutdown `close()` destroys live SSE sockets
  // (closeAllConnections), and a bus emit / heartbeat tick can race that
  // destroy. Writing to a destroyed socket emits an unhandled `error` on
  // the response — which, with no top-level uncaughtException handler on
  // the studio path, would crash the process on Ctrl-C. Drop the write
  // (and tear down) instead.
  function safeWrite(chunk: string): void {
    if (closed || res.writableEnded || res.destroyed) {
      cleanup();
      return;
    }
    res.write(chunk);
  }

  bus.on('invocation', onInvocation);
  bus.on('log', onLog);
  bus.on('serve', onServe);

  // `close` fires on client disconnect AND on server-side socket destroy;
  // `error` fires if a write loses the race with the destroy. All three
  // route through the idempotent cleanup so the bus listeners + heartbeat
  // never leak and a write error never propagates as uncaught.
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  // Open the stream so EventSource fires `open` immediately, and announce
  // this server's per-boot instance id as the first event. The UI records
  // the first `hello` it sees and treats a later, DIFFERENT id (a reconnect
  // that landed on another studio process reusing this port) as a
  // disconnect from the originating server.
  safeWrite(`event: hello\ndata: ${JSON.stringify({ instanceId })}\n\n`);
}

/**
 * Listen on `port`, retrying `port+1`, `port+2`, ... on `EADDRINUSE` up
 * to `maxBump` extra attempts. Resolves with the bound port.
 */
function listenWithBump(
  server: Server,
  host: string,
  port: number,
  maxBump: number
): Promise<number> {
  return new Promise<number>((resolveListen, reject) => {
    let attempt = 0;
    const tryListen = (p: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === 'EADDRINUSE' && attempt < maxBump) {
          attempt += 1;
          server.removeListener('error', onError);
          tryListen(p + 1);
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(p, host, () => {
        server.removeListener('error', onError);
        // Resolve with the ACTUAL bound port from the socket — when the
        // requested port is 0 the OS assigns a free one, which `p` does
        // not reflect.
        resolveListen((server.address() as AddressInfo).port);
      });
    };
    tryListen(port);
  });
}
