import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, type Socket as NetSocket } from 'node:net';
import type { Duplex } from 'node:stream';
import { getLogger } from '../utils/logger.js';
import type { FrontDoorEndpointPool } from './front-door-pool.js';
import {
  buildAlbLambdaEvent,
  snapshotFromIncoming,
  translateAlbLambdaResponse,
  type TranslatedAlbResponse,
} from './alb-lambda-event.js';

/**
 * Host-side ALB front-door. A plain HTTP reverse proxy bound to the ALB's
 * declared listener port that, per request, resolves a {@link RouteAction} and
 * serves it: a `forward` action round-robins a (weighted) replica pool set, a
 * `redirect` answers a 301 / 302 with a synthesized `Location`, and a
 * `fixed-response` answers a synthesized status / body — mirroring what a real
 * ALB does for the matched rule / default action. Lifecycle mirrors
 * `startApiServer` in `http-server.ts`.
 *
 * Route selection is delegated to {@link StartFrontDoorServerOptions.route},
 * which receives the request path AND its `Host` header (host-header rules need
 * the latter):
 *   - single default-forward listener -> a constant `forward` action;
 *   - a listener with rules -> the matched rule's action, falling back to the
 *     default action (`undefined` when neither matches, which the proxy answers
 *     with 404 — like an ALB rule miss with no default).
 *
 * A weighted `forward` action's targets are EITHER an ECS replica pool
 * ({@link FrontDoorEndpointPool}) OR a Lambda invoker (#123 Lambda-target slice),
 * and a single forward may mix both. The weighted pick selects one target per
 * request. For an ECS pool, the proxy round-robins a live replica and
 * reverse-proxies the raw HTTP request to `127.0.0.1:<ephemeralPort>` (the
 * daemon-in-a-VM reality on macOS means the host can't reach container IPs
 * directly, so replicas publish their target port on ephemeral host ports). For
 * a Lambda target, the proxy translates the request into the ALB Lambda-target
 * event, invokes the function locally, and translates the response back — a
 * malformed handler response yields 502, mirroring a real ALB.
 *
 * Callers that only ever route to a single ECS-or-Lambda target per path may use
 * the simpler {@link StartFrontDoorServerOptions.selectTarget} /
 * {@link StartFrontDoorServerOptions.selectPool} selectors instead of `route`.
 *
 * Scope: per-request round-robin + weighted forward (ECS pools and/or Lambda
 * invokers), redirect / fixed-response synthesis, every ALB rule-condition
 * field. HTTP and HTTPS listeners are both served — HTTPS termination uses
 * the {@link StartFrontDoorServerOptions.tls} materials (a user-supplied or
 * auto-generated self-signed cert/key pair). `X-Forwarded-Proto` and the
 * redirect `#{protocol}` default come from
 * {@link StartFrontDoorServerOptions.forwardedProto}, which is decoupled from
 * the wire so a cloud-HTTPS listener can be served over plain HTTP locally
 * while still presenting `https` upstream (the wire defaults to TLS presence
 * when the override is omitted).
 *
 * **WebSocket Upgrade** is proxied for ECS forward targets: an inbound
 * `Connection: Upgrade` request goes through the same `route()` callback
 * (so listener rules + auth gates apply identically), then the client's
 * raw TCP socket is bridged to a `net.connect`-opened upstream socket on
 * the picked replica. `Upgrade` / `Sec-WebSocket-*` headers are forwarded
 * verbatim (per RFC 6455 they are NOT hop-by-hop in the proxy sense), with
 * `X-Forwarded-*` injection. Lambda target groups answer 502 on upgrade
 * (mirrors ALB itself — Lambda TGs do not support WebSocket). Redirect /
 * fixed-response actions answer with a regular HTTP/1.1 response over the
 * raw socket (no upgrade). No health-check-gated draining; no sticky
 * sessions.
 */

/**
 * A Lambda forward target the front-door invokes locally per request. The
 * `invoke` callback boots-lazily / reuses a warm RIE container under the hood
 * (see `front-door-lambda-runner.ts`); this interface keeps the server decoupled
 * from the container machinery for testability.
 */
export interface FrontDoorLambdaTarget {
  /** The resolved target-group ARN-or-id surfaced under `requestContext.elb`. */
  targetGroupArn: string;
  /** Whether the TG has `lambda.multi_value_headers.enabled=true`. */
  multiValueHeaders: boolean;
  /** Invoke the backing Lambda with the ALB event; resolves the parsed payload. */
  invoke: (event: Record<string, unknown>) => Promise<unknown>;
  /** Human label for log lines (e.g. the Lambda logical id). */
  label: string;
}

/** A resolved front-door dispatch target: an ECS replica pool or a Lambda invoker. */
export type FrontDoorDispatchTarget =
  | { kind: 'pool'; pool: FrontDoorEndpointPool }
  | { kind: 'lambda'; lambda: FrontDoorLambdaTarget };

/** One weighted member of a forward action backed by an ECS replica pool. */
export interface WeightedPool {
  /** The live-replica pool for one (service, container, port) target group. */
  pool: FrontDoorEndpointPool;
  /** Forward weight (>= 0; weight 0 is never selected, per ALB semantics). */
  weight: number;
}

/** One weighted member of a forward action backed by a Lambda invoker (#123). */
export interface WeightedLambda {
  /** The Lambda invoker for one `TargetType: lambda` target group. */
  lambda: FrontDoorLambdaTarget;
  /** Forward weight (>= 0; weight 0 is never selected, per ALB semantics). */
  weight: number;
}

/** One weighted forward target: an ECS pool OR a Lambda invoker. */
export type WeightedForwardTarget = WeightedPool | WeightedLambda;

/**
 * Optional auth guard the front-door enforces before serving a route action.
 * An ALB `authenticate-cognito` / `authenticate-oidc` action is resolved into
 * one of these by `front-door-auth`. Failing the check answers 401 with a
 * `WWW-Authenticate: Bearer realm="..."` header instead of forwarding.
 */
export interface AuthCheck {
  /** Realm for the `WWW-Authenticate: Bearer realm="..."` header on 401. */
  realm: string;
  /**
   * Verify the request. Resolves `{ allow: true }` to serve the action, or
   * `{ allow: false, reason? }` to answer 401 (reason becomes the body when
   * present; otherwise the body is `Unauthorized`).
   */
  check: (headers: NodeJS.Dict<string | string[]>) => Promise<{ allow: boolean; reason?: string }>;
}

/**
 * A resolved forward action: pick a target by weight, then dispatch it (an ECS
 * pool round-robins a replica; a Lambda invoker is invoked locally). A single
 * forward may mix ECS and Lambda targets.
 */
export interface ForwardRouteAction {
  kind: 'forward';
  /** Weighted targets (length >= 1; a single-target forward is one entry, weight 1). */
  pools: WeightedForwardTarget[];
  /** Optional auth guard enforced before serving (set when the rule wrapped an authenticate-* action). */
  auth?: AuthCheck;
}

/** A resolved redirect action: synthesize a 301 / 302 with a `Location` header. */
export interface RedirectRouteAction {
  kind: 'redirect';
  statusCode: 301 | 302;
  protocol?: string;
  host?: string;
  port?: string;
  path?: string;
  query?: string;
  /** Optional auth guard enforced before serving (see {@link ForwardRouteAction.auth}). */
  auth?: AuthCheck;
}

/** A resolved fixed-response action: synthesize the whole response. */
export interface FixedResponseRouteAction {
  kind: 'fixed-response';
  statusCode: number;
  contentType?: string;
  messageBody?: string;
  /** Optional auth guard enforced before serving (see {@link ForwardRouteAction.auth}). */
  auth?: AuthCheck;
}

/** What the front-door does for a request: forward / redirect / fixed-response. */
export type RouteAction = ForwardRouteAction | RedirectRouteAction | FixedResponseRouteAction;

/**
 * The request facts the route resolver is handed (path + Host header + all
 * other ALB-condition-relevant fields). The matcher strips the query for
 * path-pattern matching but uses it for query-string conditions.
 */
export interface FrontDoorRouteRequest {
  /** Request URL (path + query); the matcher strips the query for path-pattern. */
  path: string;
  /** Request `Host` header (for host-header rule matching). */
  host?: string;
  /** Raw incoming request headers (for http-header rule matching). */
  headers?: NodeJS.Dict<string | string[]>;
  /** Request method (e.g. `GET`) for http-request-method rule matching. */
  method?: string;
  /** Connection source IP for source-ip rule matching. */
  sourceIp?: string;
}

/**
 * One condition row of a {@link FrontDoorRuleSummary}, surfaced in the
 * no-rule-matched 404 body so the user can see at a glance what each rule
 * expects on every ALB condition field. `field` names the ALB condition
 * field; `values` are the human-readable match values for it (the call site
 * pre-formats them — e.g. `["X-API: v1, v2"]` for an `http-header` row,
 * `["k=v"]` for a `query-string` row).
 */
export interface FrontDoorRuleConditionSummary {
  /** The ALB condition field this row describes. */
  field:
    | 'path-pattern'
    | 'host-header'
    | 'http-header'
    | 'http-request-method'
    | 'query-string'
    | 'source-ip';
  /** Pre-formatted match values for the field (length >= 1). */
  values: string[];
}

/**
 * A summary of one listener rule, surfaced in the no-rule-matched 404 body so
 * the user can spot at a glance which rule they were close to matching and on
 * which ALB condition field. The call site fills this in once at server start;
 * the front-door reads it at 404 time. Diagnostics-only — the matcher itself
 * does not consume this.
 */
export interface FrontDoorRuleSummary {
  /** Rule priority (lower = evaluated first). */
  priority: number;
  /** One entry per ALB condition field the rule constrains (empty = catch-all). */
  conditions: FrontDoorRuleConditionSummary[];
  /**
   * Pre-formatted action target (e.g. `forward to <ECS: BackendApi>`,
   * `redirect 301`, `fixed-response 404`). The call site produces this so the
   * front-door does not need to know the planner's target-naming convention.
   */
  action: string;
}

export interface StartFrontDoorServerOptions {
  /**
   * Resolve the action to serve a request, given its path + Host header.
   * Returns `undefined` when no rule matched and there is no default action
   * (the proxy then replies 404). This is the full router: a `forward` action's
   * weighted targets may mix ECS pools and Lambda invokers, plus `redirect` /
   * `fixed-response` actions and host-header matching. Takes precedence over the
   * single-target {@link selectTarget} / {@link selectPool} selectors.
   */
  route?: (req: FrontDoorRouteRequest) => RouteAction | undefined;
  /**
   * Single-target selector (ECS pool only) for a request path. Returns
   * `undefined` -> 404. A convenience for callers that never weight / redirect.
   */
  selectPool?: (requestPath: string) => FrontDoorEndpointPool | undefined;
  /**
   * Generalized single-target selection (#123): choose either an ECS pool or a
   * Lambda invoker for a request path. Returns `undefined` -> 404. When several
   * selectors are provided, `route` wins, then `selectTarget`, then `selectPool`.
   */
  selectTarget?: (requestPath: string) => FrontDoorDispatchTarget | undefined;
  /** Host port to bind (the listener port, or its `--lb-port` override). */
  port: number;
  /** Host interface to bind. Defaults to `127.0.0.1`. */
  host?: string;
  /** ALB listener port (for the `X-Forwarded-Port` header / logs). */
  listenerPort: number;
  /** Human label for log / error lines (e.g. `listener port 80`). */
  label: string;
  /**
   * When set, the front-door listens over HTTPS using these PEM materials
   * (server cert + private key). Absent = plain HTTP listener (the default).
   */
  tls?: { certPem: Buffer; keyPem: Buffer };
  /**
   * Explicit scheme stamped onto `X-Forwarded-Proto` and used as the default
   * for redirect `#{protocol}` placeholders. Decouples the deployed-listener
   * protocol from the local wire so a cloud-HTTPS listener can be served
   * over plain HTTP locally while still presenting `https` to the upstream
   * app. Defaults to `'https'` when {@link tls} is set, otherwise `'http'`.
   */
  forwardedProto?: 'http' | 'https';
  /**
   * Per-request upstream timeout (ms). A replica that accepts the connection
   * but never responds (deadlocked app, half-open socket) must not hang the
   * request forever; on timeout the upstream socket is destroyed and the
   * client gets a 504. Defaults to {@link DEFAULT_UPSTREAM_TIMEOUT_MS}.
   */
  upstreamTimeoutMs?: number;
  /**
   * Per-listener rule summary, surfaced in the no-rule-matched 404 body so the
   * 404 body spells out which fields were evaluated (method, host, path) AND
   * every rule's priority + conditions + action target. Without this the body
   * only names the request path, which misleads a debugging user when the
   * actual non-matching condition was the Host header, an HTTP method, a query
   * string, or a source IP (see issue #228). Optional — when absent, the 404
   * body falls back to the original path-only shape.
   */
  rulesSummary?: FrontDoorRuleSummary[];
}

/** Default per-request upstream timeout — a hung replica yields a 504, not a hang. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

export interface StartedFrontDoorServer {
  /** Actual bound port (equals `opts.port`; surfaced for symmetry / tests). */
  port: number;
  /** Actual bound host. */
  host: string;
  /** `'https'` when started with `tls`, otherwise `'http'`. Used by log banners. */
  scheme: 'http' | 'https';
  /** Underlying server (for diagnostics). */
  server: Server;
  /** Drain + close. Idempotent. */
  close: () => Promise<void>;
}

export async function startFrontDoorServer(
  opts: StartFrontDoorServerOptions
): Promise<StartedFrontDoorServer> {
  const logger = getLogger().child('front-door');
  const host = opts.host ?? '127.0.0.1';

  const forwardedProto: 'http' | 'https' = opts.forwardedProto ?? (opts.tls ? 'https' : 'http');
  const effectiveOpts: StartFrontDoorServerOptions = { ...opts, forwardedProto };
  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    handleProxyRequest(req, res, effectiveOpts).catch((err) => {
      logger.debug(`front-door request error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) writeError(res, 502, 'Bad Gateway');
    });
  };
  // HTTPS branch: `https.createServer` with the supplied PEM materials. The
  // request handler is the same — TLS only adds the handshake at the socket
  // layer. `X-Forwarded-Proto` is stamped from {@link forwardedProto}, which
  // defaults to the wire scheme but may be overridden so a cloud-HTTPS
  // listener served over plain HTTP still presents `https` upstream.
  const server: Server = opts.tls
    ? (createHttpsServer(
        { cert: opts.tls.certPem, key: opts.tls.keyPem },
        requestHandler
      ) as unknown as Server)
    : createServer(requestHandler);
  const scheme: 'http' | 'https' = opts.tls ? 'https' : 'http';
  server.on('connection', (socket) => socket.setNoDelay(true));
  server.on('upgrade', (req, clientSocket, head) => {
    handleUpgrade(req, clientSocket, head, effectiveOpts).catch((err) => {
      logger.debug(`front-door upgrade error: ${err instanceof Error ? err.message : String(err)}`);
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Could not determine front-door listening address'));
        return;
      }
      resolve(addr.port);
    });
  });

  let closed = false;
  return {
    port: boundPort,
    host,
    scheme,
    server,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * Resolve the dispatch target for a request path from whichever selector the
 * caller supplied. `selectTarget` (#123, ECS-or-Lambda) wins over the
 * pool-only `selectPool`; a `selectPool` hit is adapted to a `kind: 'pool'`
 * target so the request handler has a single code path.
 */
function resolveDispatchTarget(
  opts: StartFrontDoorServerOptions,
  requestPath: string
): FrontDoorDispatchTarget | undefined {
  if (opts.selectTarget) return opts.selectTarget(requestPath);
  if (opts.selectPool) {
    const pool = opts.selectPool(requestPath);
    return pool ? { kind: 'pool', pool } : undefined;
  }
  return undefined;
}

function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartFrontDoorServerOptions
): Promise<void> {
  const url = req.url ?? '/';

  // The full router path (host-header rules, weighted forward, redirect /
  // fixed-response) takes precedence. The single-target selectors are a
  // convenience for callers that never weight / redirect.
  if (opts.route) {
    const action = opts.route({
      path: url,
      ...hostHeader(req),
      headers: req.headers,
      ...(req.method !== undefined && { method: req.method }),
      ...(req.socket.remoteAddress !== undefined && { sourceIp: req.socket.remoteAddress }),
    });
    if (!action) return reply404(req, res, opts);

    // Auth gate: when the action wraps an authenticate-* guard, evaluate it
    // before serving. Failure -> 401 + `WWW-Authenticate: Bearer realm`.
    // The gate runs BEFORE redirect / fixed-response so a deny-by-default
    // listener stays locked even for synthesized responses.
    if (action.auth) {
      const auth = action.auth;
      return auth
        .check(req.headers)
        .then((result) => {
          if (!result.allow) {
            req.resume();
            writeUnauthorized(res, auth.realm, result.reason);
            return;
          }
          return serveAction(req, res, action, opts);
        })
        .catch((err) => {
          getLogger()
            .child('front-door')
            .debug(`auth gate error: ${err instanceof Error ? err.message : String(err)}`);
          req.resume();
          writeUnauthorized(res, auth.realm, 'auth check failed');
        });
    }
    return serveAction(req, res, action, opts);
  }

  const target = resolveDispatchTarget(opts, url);
  if (!target) return reply404(req, res, opts);
  if (target.kind === 'lambda') {
    return handleLambdaRequest(req, res, target.lambda, opts);
  }
  return handlePoolRequest(req, res, target.pool, opts);
}

/**
 * Dispatch a resolved {@link RouteAction} — the path the route resolver
 * returned (after any auth gate). Splits forward (ECS pool or Lambda invoker)
 * from redirect / fixed-response, mirroring what the inline logic used to do.
 */
function serveAction(
  req: IncomingMessage,
  res: ServerResponse,
  action: RouteAction,
  opts: StartFrontDoorServerOptions
): Promise<void> {
  if (action.kind === 'redirect' || action.kind === 'fixed-response') {
    // Drain any request body (ALB serves redirect / fixed-response for every
    // method, incl. POST) so an unconsumed body doesn't stall HTTP/1.1
    // keep-alive socket reuse, then synthesize the response with no backend.
    req.resume();
    if (action.kind === 'redirect') {
      writeRedirect(res, action, req, opts.listenerPort, resolveForwardedProto(opts));
    } else {
      writeFixedResponse(res, action);
    }
    return Promise.resolve();
  }

  const picked = pickWeightedTarget(action.pools);
  if (!picked) {
    // Every target has weight 0 (or none) — mirror an ALB whose rule forwards
    // nowhere usable (502, like a misconfigured forward).
    writeError(
      res,
      502,
      `No forward target selected behind ${opts.label} (every weighted target has weight 0).`
    );
    return Promise.resolve();
  }
  if ('lambda' in picked) return handleLambdaRequest(req, res, picked.lambda, opts);
  return handlePoolRequest(req, res, picked.pool, opts);
}

/**
 * Write a 401 with `WWW-Authenticate: Bearer realm="..."`. ALB itself would
 * redirect to the IdP's authorize endpoint; for local dev parity we deny
 * loudly so the user notices and either supplies `--bearer-token` / passes a
 * fresh Authorization header / disables the guard with `--no-verify-auth`.
 */
function writeUnauthorized(res: ServerResponse, realm: string, reason?: string): void {
  const body = reason && reason !== '' ? reason : 'Unauthorized';
  res.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(`${body}\n`)),
    'www-authenticate': `Bearer realm="${escapeRealmQuotes(realm)}"`,
  });
  res.end(`${body}\n`);
}

/** Escape `"` in the realm so the `WWW-Authenticate` header parses cleanly. */
function escapeRealmQuotes(realm: string): string {
  return realm.replace(/"/g, '\\"');
}

/** Reply 404 — an ALB listener with no matching rule and no default action. */
function reply404(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartFrontDoorServerOptions
): Promise<void> {
  writeError(res, 404, buildNoRuleMatched404Body(req, opts));
  return Promise.resolve();
}

/**
 * Build the no-rule-matched 404 body. When the call site supplied a
 * {@link StartFrontDoorServerOptions.rulesSummary}, the body lists every
 * ALB condition field that WAS evaluated (method, host, path) plus every
 * configured rule's priority + conditions + action target — so a user
 * whose request missed on, say, the Host header can spot the mismatch
 * without inspecting the synthesized template. Header conditions are
 * NOT spelled out in the evaluated section (too noisy) but ARE listed
 * in each rule's condition row when the rule constrains them. Without a
 * summary the body falls back to the original path-only shape (preserves
 * the behavior for direct callers that wire the proxy with just a
 * `selectPool` / `selectTarget`).
 */
function buildNoRuleMatched404Body(
  req: IncomingMessage,
  opts: StartFrontDoorServerOptions
): string {
  const requestPath = req.url ?? '/';
  const summary = opts.rulesSummary;
  if (!summary) {
    return (
      `No listener rule matched '${requestPath}' on ${opts.label}, and the listener has no ` +
      'default action forwarding to a local target.'
    );
  }

  const rawHost = req.headers.host;
  const hostValue = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  const lines: string[] = [];
  lines.push(
    `No listener rule matched the request on ${opts.label}, and the listener has no ` +
      'default action forwarding to a local target.'
  );
  lines.push('');
  lines.push('  Evaluated:');
  lines.push(`    Method:  ${req.method ?? '(unknown)'}`);
  lines.push(`    Host:    ${hostValue ?? '(no Host header)'}`);
  lines.push(`    Path:    ${requestPath}`);
  lines.push('');

  if (summary.length === 0) {
    lines.push('  Listener has 0 rule(s).');
  } else {
    lines.push(`  Listener has ${summary.length} rule(s):`);
    // Display by priority order so the user reads them in evaluation order;
    // ties keep the supplied order (stable sort).
    const ordered = [...summary].sort((a, b) => a.priority - b.priority);
    for (const rule of ordered) {
      const conditions =
        rule.conditions.length === 0
          ? '(no condition)'
          : rule.conditions.map(formatRuleConditionSummary).join(' AND ');
      lines.push(`    [priority=${rule.priority}] ${conditions}  -> ${rule.action}`);
    }
  }
  return lines.join('\n');
}

/** Format one condition row of a {@link FrontDoorRuleSummary} for the 404 body. */
function formatRuleConditionSummary(c: FrontDoorRuleConditionSummary): string {
  return `${c.field} in [${c.values.join(', ')}]`;
}

function handlePoolRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pool: FrontDoorEndpointPool,
  opts: StartFrontDoorServerOptions
): Promise<void> {
  return new Promise<void>((resolve) => {
    const endpoint = pool.next();
    if (!endpoint) {
      // No live replica — mirror an ALB with no healthy targets (503).
      writeError(
        res,
        503,
        `No running replicas behind ${opts.label} for the matched target. The front-door has no ` +
          'healthy target to forward to.'
      );
      resolve();
      return;
    }

    // `settled` makes the resolve idempotent — the timeout, upstream error,
    // client-disconnect, and normal-end paths can race, and only the first
    // should settle the request.
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const headers = { ...req.headers };
    stripHopByHopHeaders(headers);
    appendForwardedHeaders(headers, req, opts.listenerPort, resolveForwardedProto(opts));

    const proxyReq = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (proxyRes) => {
        const resHeaders = { ...proxyRes.headers };
        stripHopByHopHeaders(resHeaders);
        res.writeHead(proxyRes.statusCode ?? 502, resHeaders);
        proxyRes.pipe(res);
        proxyRes.on('end', done);
        proxyRes.on('error', () => {
          // Upstream reset mid-body (headers already sent): destroy rather than
          // cleanly end so the client sees a broken transfer, not a truncated 200.
          if (!res.writableEnded) res.destroy();
          done();
        });
      }
    );

    // A replica that accepts the connection but never responds must not hang
    // the request forever — destroy the upstream and surface a 504.
    proxyReq.setTimeout(opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS, () => {
      if (!res.headersSent) {
        writeError(
          res,
          504,
          `Replica ${endpoint.host}:${endpoint.port} behind ${opts.label} did not respond in time.`
        );
      } else if (!res.writableEnded) {
        res.destroy();
      }
      proxyReq.destroy();
      done();
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        writeError(
          res,
          502,
          `Failed to reach replica ${endpoint.host}:${endpoint.port} behind ${opts.label}.`
        );
      } else if (!res.writableEnded) {
        res.destroy();
      }
      done();
    });

    // Client disconnected before the upstream finished — tear the upstream
    // request down so its socket doesn't leak against the replica.
    res.on('close', () => {
      if (!res.writableEnded) proxyReq.destroy();
    });

    req.pipe(proxyReq);
  });
}

/** Extract the request `Host` header (string) for host-header rule matching. */
function hostHeader(req: IncomingMessage): { host?: string } {
  const raw = req.headers.host;
  const host = Array.isArray(raw) ? raw[0] : raw;
  return host ? { host } : {};
}

/**
 * Pick one weighted target from a forward set: weighted random over the
 * non-zero weights. A single-entry set short-circuits to that entry. Returns
 * `undefined` when every weight is 0 (an ALB-valid but un-routable forward).
 * Used for forwards that may mix ECS pools and Lambda invokers.
 */
export function pickWeightedTarget(
  targets: readonly WeightedForwardTarget[]
): WeightedForwardTarget | undefined {
  if (targets.length === 0) return undefined;
  if (targets.length === 1) return targets[0]!.weight > 0 ? targets[0]! : undefined;
  const total = targets.reduce((sum, t) => sum + Math.max(0, t.weight), 0);
  if (total <= 0) return undefined;
  let roll = Math.random() * total;
  for (const t of targets) {
    const w = Math.max(0, t.weight);
    if (w === 0) continue;
    roll -= w;
    if (roll < 0) return t;
  }
  // Floating-point edge: roll landed exactly at the total. Return the last
  // non-zero-weight target.
  for (let i = targets.length - 1; i >= 0; i--) {
    if (Math.max(0, targets[i]!.weight) > 0) return targets[i]!;
  }
  return undefined;
}

/**
 * Pick one pool from a weighted pool set (ECS-only forwards): a convenience
 * over {@link pickWeightedTarget} that returns just the pool. Returns
 * `undefined` when every weight is 0.
 */
export function pickWeightedPool(
  pools: readonly WeightedPool[]
): FrontDoorEndpointPool | undefined {
  const picked = pickWeightedTarget(pools);
  return picked && 'pool' in picked ? picked.pool : undefined;
}

/**
 * Synthesize an ALB-style redirect (301 / 302). ALB builds the `Location` from
 * the action fields with `#{protocol}` / `#{host}` / `#{port}` / `#{path}` /
 * `#{query}` placeholders filled from the incoming request. We resolve those
 * placeholders against the request the front-door received.
 */
function writeRedirect(
  res: ServerResponse,
  action: RedirectRouteAction,
  req: IncomingMessage,
  listenerPort: number,
  scheme: 'http' | 'https'
): void {
  const location = buildRedirectLocation(action, req, listenerPort, scheme);
  res.writeHead(action.statusCode, {
    location,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': '0',
  });
  res.end();
}

/**
 * Build the `Location` URL for a redirect action, resolving ALB `#{...}`
 * placeholders. `scheme` is the receiving listener's protocol — it sets the
 * default for `#{protocol}` so an HTTPS listener redirects to `https://...`
 * by default, matching what a real ALB does.
 */
export function buildRedirectLocation(
  action: RedirectRouteAction,
  req: { url?: string | undefined; headers: NodeJS.Dict<string | string[]> },
  listenerPort: number,
  scheme: 'http' | 'https' = 'http'
): string {
  const url = req.url ?? '/';
  const qIndex = url.indexOf('?');
  const reqPath = qIndex === -1 ? url : url.slice(0, qIndex);
  const reqQuery = qIndex === -1 ? '' : url.slice(qIndex + 1);
  const rawHost = req.headers['host'];
  const hostHeaderValue = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  const reqHostName = (hostHeaderValue ?? '').split(':')[0] ?? '';

  const placeholders: Record<string, string> = {
    protocol: scheme,
    host: reqHostName,
    port: String(listenerPort),
    path: reqPath.replace(/^\//, ''), // ALB's #{path} excludes the leading slash
    query: reqQuery,
  };
  const fill = (template: string): string =>
    template.replace(
      /#\{(protocol|host|port|path|query)\}/g,
      (_m, key: string) => placeholders[key] ?? ''
    );

  const protocol = (
    action.protocol ? fill(action.protocol) : placeholders['protocol']!
  ).toLowerCase();
  const host = action.host ? fill(action.host) : placeholders['host']!;
  const port = action.port ? fill(action.port) : placeholders['port']!;
  // ALB Path defaults to `/#{path}`; it always starts with a `/`.
  const pathTemplate = action.path ?? '/#{path}';
  const path = fill(pathTemplate);
  const queryTemplate = action.query ?? '#{query}';
  const query = fill(queryTemplate);

  // Omit the port when it is the protocol default (80/http, 443/https), matching
  // how an ALB-built Location reads.
  const isDefaultPort =
    (protocol === 'http' && port === '80') || (protocol === 'https' && port === '443');
  const authority = isDefaultPort || port === '' ? host : `${host}:${port}`;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const queryPart = query ? `?${query}` : '';
  return `${protocol}://${authority}${normalizedPath}${queryPart}`;
}

/** Synthesize an ALB-style fixed-response. */
function writeFixedResponse(res: ServerResponse, action: FixedResponseRouteAction): void {
  const body = action.messageBody ?? '';
  res.writeHead(action.statusCode, {
    'content-type': action.contentType ?? 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

/** Maximum request body the ALB Lambda-target path buffers (ALB's own limit is 1 MB). */
const ALB_LAMBDA_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Serve a request that resolved to a Lambda forward target (#123). Buffers the
 * request body (ALB caps the Lambda-target request body at 1 MB), translates
 * the request into the ALB Lambda-target event, invokes the function locally,
 * and writes the translated response. A malformed handler response or an
 * invoke failure surfaces as 502 — mirroring a real ALB.
 */
function handleLambdaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  lambda: FrontDoorLambdaTarget,
  opts: StartFrontDoorServerOptions
): Promise<void> {
  const logger = getLogger().child('front-door');
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > ALB_LAMBDA_MAX_BODY_BYTES) {
        aborted = true;
        // ALB returns 413 when the request body exceeds the 1 MB Lambda-target
        // limit; mirror that locally.
        writeError(
          res,
          413,
          `Request body exceeds the ${ALB_LAMBDA_MAX_BODY_BYTES}-byte Lambda-target limit on ${opts.label}.`
        );
        req.destroy();
        done();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      if (!res.headersSent) writeError(res, 400, `Failed to read request body on ${opts.label}.`);
      done();
    });

    req.on('end', () => {
      if (aborted) return;
      // Self-contained async task; every failure path (invoke rejection,
      // unexpected synchronous throw) lands on a 502 + `done()` INSIDE the
      // function via the surrounding try/catch, so it never rejects — invoked
      // with `void`, no promise callback the linter would flag.
      const serveLambda = async (): Promise<void> => {
        try {
          const body = Buffer.concat(chunks);
          // ALB stamps the x-forwarded-* set onto the Lambda event; reuse the
          // same header injection as the ECS proxy path so the event a handler
          // sees locally matches production.
          const forwardHeaders: NodeJS.Dict<string | string[]> = { ...req.headers };
          // Strip hop-by-hop headers (as the ECS proxy path does) so the Lambda
          // event's headers match what a real ALB forwards — no connection /
          // transfer-encoding / keep-alive leaking into the handler.
          stripHopByHopHeaders(forwardHeaders);
          appendForwardedHeaders(
            forwardHeaders,
            req,
            opts.listenerPort,
            resolveForwardedProto(opts)
          );
          const snapshot = snapshotFromIncoming(req, body);
          for (const [name, value] of Object.entries(forwardHeaders)) {
            if (value === undefined) continue;
            snapshot.headers[name] = Array.isArray(value) ? value : [value];
          }
          const event = buildAlbLambdaEvent(snapshot, {
            targetGroupArn: lambda.targetGroupArn,
            multiValueHeaders: lambda.multiValueHeaders,
          });

          const payload = await lambda.invoke(event);
          const translated: TranslatedAlbResponse = translateAlbLambdaResponse(payload);

          if (res.headersSent || res.writableEnded) {
            done();
            return;
          }
          const outHeaders: Record<string, string | string[]> = {};
          for (const [name, values] of Object.entries(translated.headers)) {
            outHeaders[name] = values.length === 1 ? values[0]! : values;
          }
          if (translated.statusDescription) {
            res.writeHead(translated.statusCode, translated.statusDescription, outHeaders);
          } else {
            res.writeHead(translated.statusCode, outHeaders);
          }
          res.end(translated.body);
          done();
        } catch (err) {
          logger.debug(
            `Lambda target '${lambda.label}' request failed: ${err instanceof Error ? err.message : String(err)}`
          );
          if (!res.headersSent) {
            writeError(res, 502, `Lambda target '${lambda.label}' behind ${opts.label} failed.`);
          } else if (!res.writableEnded) {
            res.destroy();
          }
          done();
        }
      };
      void serveLambda();
    });
  });
}

/** Standard hop-by-hop headers (RFC 7230 §6.1) — a proxy must not forward these. */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Strip hop-by-hop headers before relaying a request to / a response from the
 * upstream, mirroring what a real ALB does. Forwarding the upstream's
 * `Transfer-Encoding` / `Connection` verbatim while Node re-frames the body can
 * produce a malformed response; the headers named in a `Connection` token list
 * are also hop-by-hop and removed. Mutates `headers` in place.
 */
function stripHopByHopHeaders(headers: NodeJS.Dict<string | string[]>): void {
  const connection = headers['connection'];
  const connectionValue = Array.isArray(connection) ? connection.join(',') : connection;
  if (connectionValue) {
    for (const token of connectionValue.split(',')) {
      const name = token.trim().toLowerCase();
      if (name) delete headers[name];
    }
  }
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
}

/**
 * Resolve the scheme to stamp on `X-Forwarded-Proto` and to default
 * redirect `#{protocol}` to: an explicit {@link StartFrontDoorServerOptions.forwardedProto}
 * override wins, otherwise it follows the wire (TLS = `https`, no TLS = `http`).
 */
function resolveForwardedProto(opts: StartFrontDoorServerOptions): 'http' | 'https' {
  return opts.forwardedProto ?? (opts.tls ? 'https' : 'http');
}

/**
 * Inject the ALB-style forwarding headers a downstream app may read. Appends
 * the client IP to any existing `X-Forwarded-For` chain (ALB appends rather
 * than replaces) and stamps the scheme / listener port. `scheme` follows the
 * listener's protocol so an HTTPS listener stamps `x-forwarded-proto: https`.
 */
function appendForwardedHeaders(
  headers: NodeJS.Dict<string | string[]>,
  req: IncomingMessage,
  listenerPort: number,
  scheme: 'http' | 'https'
): void {
  const clientIp = req.socket.remoteAddress ?? '';
  const existing = headers['x-forwarded-for'];
  const chain = Array.isArray(existing) ? existing.join(', ') : existing;
  headers['x-forwarded-for'] = chain ? `${chain}, ${clientIp}` : clientIp;
  headers['x-forwarded-proto'] = scheme;
  headers['x-forwarded-port'] = String(listenerPort);
}

function writeError(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

/**
 * Handle an HTTP `Upgrade` request (WebSocket). Goes through the same
 * `route()` callback so listener-rule matching + auth gates apply
 * identically. ECS forward targets get a raw TCP bridge to the picked
 * replica; Lambda forward targets answer 502 (Lambda TGs do not support
 * WS); redirect / fixed-response actions synthesize a regular HTTP/1.1
 * response over the upgrade socket and close. Errors at every stage
 * destroy the client socket cleanly.
 */
function handleUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  opts: StartFrontDoorServerOptions
): Promise<void> {
  // `Duplex` does not declare `setNoDelay`, but the runtime instance under
  // `http.Server.on('upgrade', ...)` is always a `net.Socket` (or
  // `tls.TLSSocket` on the HTTPS branch), both of which expose it.
  const maybeNetSocket = clientSocket as Duplex & { setNoDelay?: (b: boolean) => unknown };
  maybeNetSocket.setNoDelay?.(true);
  if (!opts.route) {
    writeRawHttpError(clientSocket, 404, 'Not Found');
    return Promise.resolve();
  }
  const action = opts.route({
    path: req.url ?? '/',
    ...hostHeader(req),
    headers: req.headers,
    ...(req.method !== undefined && { method: req.method }),
    ...(req.socket.remoteAddress !== undefined && { sourceIp: req.socket.remoteAddress }),
  });
  if (!action) {
    writeRawHttpError(clientSocket, 404, 'No listener rule matched the upgrade request.');
    return Promise.resolve();
  }

  const proceed = (): Promise<void> => {
    if (action.kind === 'redirect') {
      writeRawHttpRedirect(
        clientSocket,
        action,
        req,
        opts.listenerPort,
        resolveForwardedProto(opts)
      );
      return Promise.resolve();
    }
    if (action.kind === 'fixed-response') {
      writeRawHttpFixedResponse(clientSocket, action);
      return Promise.resolve();
    }

    // forward
    const picked = pickWeightedTarget(action.pools);
    if (!picked) {
      writeRawHttpError(
        clientSocket,
        502,
        `No forward target selected behind ${opts.label} (every weighted target has weight 0).`
      );
      return Promise.resolve();
    }
    if ('lambda' in picked) {
      // ALB itself does not support WebSocket to Lambda target groups, so
      // refuse the upgrade with a 502 mirroring the cloud-side behavior.
      writeRawHttpError(
        clientSocket,
        502,
        `WebSocket upgrade is not supported for Lambda target groups (${picked.lambda.label}).`
      );
      return Promise.resolve();
    }
    return bridgeWebSocket(req, clientSocket, head, picked.pool, opts);
  };

  if (action.auth) {
    const auth = action.auth;
    return auth
      .check(req.headers)
      .then((result) => {
        if (!result.allow) {
          writeRawHttpUnauthorized(clientSocket, auth.realm, result.reason);
          return;
        }
        return proceed();
      })
      .catch((err) => {
        getLogger()
          .child('front-door')
          .debug(`upgrade auth gate error: ${err instanceof Error ? err.message : String(err)}`);
        writeRawHttpUnauthorized(clientSocket, auth.realm, 'auth check failed');
      });
  }
  return proceed();
}

/**
 * Bridge a WebSocket upgrade onto an ECS replica. Opens a raw TCP socket
 * to the picked endpoint, replays the upgrade request (with `X-Forwarded-*`
 * stamped on), forwards any pre-read `head` bytes, then pipes the two
 * sockets in both directions. `Upgrade` / `Connection: Upgrade` / the
 * `Sec-WebSocket-*` headers are forwarded verbatim — RFC 7230 marks
 * `Upgrade` as hop-by-hop, but for the upgrade handshake itself the proxy
 * MUST preserve them (nginx / haproxy / ALB all do).
 */
function bridgeWebSocket(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  pool: FrontDoorEndpointPool,
  opts: StartFrontDoorServerOptions
): Promise<void> {
  const logger = getLogger().child('front-door');
  return new Promise<void>((resolve) => {
    const endpoint = pool.next();
    if (!endpoint) {
      writeRawHttpError(
        clientSocket,
        503,
        `No running replicas behind ${opts.label} for the matched target.`
      );
      resolve();
      return;
    }

    const upstream: NetSocket = netConnect({ host: endpoint.host, port: endpoint.port });
    upstream.setNoDelay(true);

    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Tracks whether the upstream `connect` event has fired. Before connect,
    // an error means the bridge never opened and a synthetic 502 over the
    // client socket is safe (no WS frames flowed yet). After connect, the
    // bridge is pipe-streaming bytes either way — injecting a synthetic
    // `HTTP/1.1 502` block would corrupt the live WebSocket frame channel.
    let upstreamConnected = false;

    upstream.on('connect', () => {
      upstreamConnected = true;
      const headers: NodeJS.Dict<string | string[]> = { ...req.headers };
      // Do NOT strip hop-by-hop: `Upgrade` / `Connection: Upgrade` are the
      // whole point of this code path. Only stamp the X-Forwarded-* set.
      appendForwardedHeaders(headers, req, opts.listenerPort, resolveForwardedProto(opts));

      const requestLine = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`;
      const lines: string[] = [requestLine];
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) lines.push(`${name}: ${v}`);
        } else {
          lines.push(`${name}: ${value}`);
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);

      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on('error', (err) => {
      logger.debug(
        `WS upstream error (${endpoint.host}:${endpoint.port}): ${err instanceof Error ? err.message : String(err)}`
      );
      if (!clientSocket.destroyed) {
        // Only synthesize a 502 BEFORE the bridge pipe started. After
        // connect the WS frame channel is live, and writing HTTP text
        // into it would corrupt the WebSocket parser on the client.
        if (!upstreamConnected) {
          try {
            writeRawHttpError(
              clientSocket,
              502,
              `Failed to reach replica ${endpoint.host}:${endpoint.port} behind ${opts.label}.`
            );
          } catch {
            /* socket already partially written / closed */
          }
        }
        clientSocket.destroy();
      }
      done();
    });

    upstream.on('close', () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      done();
    });
    clientSocket.on('error', () => {
      if (!upstream.destroyed) upstream.destroy();
      done();
    });
    clientSocket.on('close', () => {
      if (!upstream.destroyed) upstream.destroy();
      done();
    });
  });
}

/**
 * Write a minimal HTTP/1.1 error response over a raw upgrade socket and
 * close it. Used for the pre-101-Switching-Protocols failure paths
 * (no rule match, no replica, Lambda target, etc.).
 */
function writeRawHttpError(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  const statusText = STATUS_TEXT[statusCode] ?? 'Error';
  const lines = [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    'content-type: text/plain; charset=utf-8',
    `content-length: ${Buffer.byteLength(body)}`,
    'connection: close',
    '',
    '',
  ];
  try {
    socket.write(lines.join('\r\n') + body);
  } catch {
    /* socket may have errored mid-write; the end() below still tries */
  }
  socket.end();
}

/** Write a 401 over a raw upgrade socket with the WS-aware `WWW-Authenticate` header. */
function writeRawHttpUnauthorized(socket: Duplex, realm: string, reason?: string): void {
  if (socket.destroyed) return;
  const body = `${reason && reason !== '' ? reason : 'Unauthorized'}\n`;
  const lines = [
    'HTTP/1.1 401 Unauthorized',
    'content-type: text/plain; charset=utf-8',
    `content-length: ${Buffer.byteLength(body)}`,
    `www-authenticate: Bearer realm="${escapeRealmQuotes(realm)}"`,
    'connection: close',
    '',
    '',
  ];
  try {
    socket.write(lines.join('\r\n') + body);
  } catch {
    /* see writeRawHttpError */
  }
  socket.end();
}

/** Write an ALB-style 301 / 302 redirect over a raw upgrade socket. */
function writeRawHttpRedirect(
  socket: Duplex,
  action: RedirectRouteAction,
  req: IncomingMessage,
  listenerPort: number,
  scheme: 'http' | 'https'
): void {
  if (socket.destroyed) return;
  const location = buildRedirectLocation(action, req, listenerPort, scheme);
  const statusText = action.statusCode === 301 ? 'Moved Permanently' : 'Found';
  const lines = [
    `HTTP/1.1 ${action.statusCode} ${statusText}`,
    `location: ${location}`,
    'content-type: text/plain; charset=utf-8',
    'content-length: 0',
    'connection: close',
    '',
    '',
  ];
  try {
    socket.write(lines.join('\r\n'));
  } catch {
    /* see writeRawHttpError */
  }
  socket.end();
}

/** Write an ALB-style fixed-response over a raw upgrade socket. */
function writeRawHttpFixedResponse(socket: Duplex, action: FixedResponseRouteAction): void {
  if (socket.destroyed) return;
  const body = action.messageBody ?? '';
  const statusText = STATUS_TEXT[action.statusCode] ?? '';
  // CRLF in `contentType` (sourced from a CFn-literal `ContentType` field)
  // would inject extra response headers when raw-written below. Strip any
  // control bytes defensively — Node's `res.writeHead` does this on the
  // regular HTTP path; the raw-socket path mirrors it.
  const contentType = sanitizeRawHeaderValue(action.contentType ?? 'text/plain; charset=utf-8');
  const lines = [
    // RFC 7230 status-line: `HTTP-version SP Status-Code SP Reason-Phrase
    // CRLF`. The SP after the status-code is required even when the
    // reason-phrase is empty.
    `HTTP/1.1 ${action.statusCode} ${statusText}`,
    `content-type: ${contentType}`,
    `content-length: ${Buffer.byteLength(body)}`,
    'connection: close',
    '',
    '',
  ];
  try {
    socket.write(lines.join('\r\n') + body);
  } catch {
    /* see writeRawHttpError */
  }
  socket.end();
}

/** Strip CR / LF / NUL from a raw HTTP header value to prevent header injection. */
function sanitizeRawHeaderValue(value: string): string {
  // The ` ` literal in the class is the NUL byte; CRLF + NUL are the
  // three header-injection-relevant control bytes that bypass the header
  // grammar when raw-written over the upgrade socket.
  return value.replace(/[\r\n ]/g, ' ');
}

/** Minimal HTTP/1.1 status text map for the codes the raw writers emit. */
const STATUS_TEXT: Record<number, string> = {
  301: 'Moved Permanently',
  302: 'Found',
  401: 'Unauthorized',
  404: 'Not Found',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};
