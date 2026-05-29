import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { getLogger } from '../utils/logger.js';
import type { FrontDoorEndpointPool } from './front-door-pool.js';

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
 * The replicas publish their target container port on ephemeral host ports
 * (the daemon-in-a-VM reality on macOS means the host can't reach container
 * IPs directly), so the proxy forwards to `127.0.0.1:<ephemeralPort>` rather
 * than to docker-network addresses — cross-platform by construction.
 *
 * Scope: per-request round-robin + weighted forward, redirect / fixed-response
 * synthesis, HTTP only, `path-pattern` + `host-header` rule routing. No
 * health-check-gated draining, no sticky sessions, no websocket `Upgrade`
 * proxying, no TLS termination (tracked in #123).
 */

/** One weighted member of a forward action's pool set. */
export interface WeightedPool {
  /** The live-replica pool for one (service, container, port) target group. */
  pool: FrontDoorEndpointPool;
  /** Forward weight (>= 0; weight 0 is never selected, per ALB semantics). */
  weight: number;
}

/** A resolved forward action: pick a pool by weight, then round-robin its replicas. */
export interface ForwardRouteAction {
  kind: 'forward';
  /** Weighted pools (length >= 1; a single-target forward is one entry, weight 1). */
  pools: WeightedPool[];
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
}

/** A resolved fixed-response action: synthesize the whole response. */
export interface FixedResponseRouteAction {
  kind: 'fixed-response';
  statusCode: number;
  contentType?: string;
  messageBody?: string;
}

/** What the front-door does for a request: forward / redirect / fixed-response. */
export type RouteAction = ForwardRouteAction | RedirectRouteAction | FixedResponseRouteAction;

/** The request facts the route resolver is handed (path + Host header). */
export interface FrontDoorRouteRequest {
  /** Request URL (path + query); the matcher strips the query for path-pattern. */
  path: string;
  /** Request `Host` header (for host-header rule matching). */
  host?: string;
}

export interface StartFrontDoorServerOptions {
  /**
   * Resolve the action to serve a request, given its path + Host header.
   * Returns `undefined` when no rule matched and there is no default action
   * (the proxy then replies 404).
   */
  route: (req: FrontDoorRouteRequest) => RouteAction | undefined;
  /** Host port to bind (the listener port, or its `--lb-port` override). */
  port: number;
  /** Host interface to bind. Defaults to `127.0.0.1`. */
  host?: string;
  /** ALB listener port (for the `X-Forwarded-Port` header / logs). */
  listenerPort: number;
  /** Human label for log / error lines (e.g. `listener port 80`). */
  label: string;
  /**
   * Per-request upstream timeout (ms). A replica that accepts the connection
   * but never responds (deadlocked app, half-open socket) must not hang the
   * request forever; on timeout the upstream socket is destroyed and the
   * client gets a 504. Defaults to {@link DEFAULT_UPSTREAM_TIMEOUT_MS}.
   */
  upstreamTimeoutMs?: number;
}

/** Default per-request upstream timeout — a hung replica yields a 504, not a hang. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

export interface StartedFrontDoorServer {
  /** Actual bound port (equals `opts.port`; surfaced for symmetry / tests). */
  port: number;
  /** Actual bound host. */
  host: string;
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

  const server = createServer((req, res) => {
    handleProxyRequest(req, res, opts).catch((err) => {
      logger.debug(`front-door request error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) writeError(res, 502, 'Bad Gateway');
    });
  });
  server.on('connection', (socket) => socket.setNoDelay(true));

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

function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartFrontDoorServerOptions
): Promise<void> {
  return new Promise<void>((resolve) => {
    const url = req.url ?? '/';
    const action = opts.route({ path: url, ...hostHeader(req) });
    if (!action) {
      // No rule matched and no default action — mirror an ALB listener with no
      // matching rule and no default (404).
      writeError(
        res,
        404,
        `No listener rule matched '${url}' on ${opts.label}, and the listener has no ` +
          'default action forwarding to a local target.'
      );
      resolve();
      return;
    }

    if (action.kind === 'redirect') {
      writeRedirect(res, action, req, opts.listenerPort);
      resolve();
      return;
    }
    if (action.kind === 'fixed-response') {
      writeFixedResponse(res, action);
      resolve();
      return;
    }

    const pool = pickWeightedPool(action.pools);
    if (!pool) {
      // Every pool has weight 0 (or none) — mirror an ALB whose rule forwards
      // nowhere usable (502, like a misconfigured forward).
      writeError(
        res,
        502,
        `No forward target selected behind ${opts.label} (every weighted target has weight 0).`
      );
      resolve();
      return;
    }
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
    appendForwardedHeaders(headers, req, opts.listenerPort);

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
 * Pick one pool from a weighted set: weighted random over the non-zero weights.
 * A single-entry set short-circuits to that pool. Returns `undefined` when
 * every weight is 0 (an ALB-valid but un-routable forward).
 */
export function pickWeightedPool(
  pools: readonly WeightedPool[]
): FrontDoorEndpointPool | undefined {
  if (pools.length === 0) return undefined;
  if (pools.length === 1) return pools[0]!.weight > 0 ? pools[0]!.pool : undefined;
  const total = pools.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
  if (total <= 0) return undefined;
  let roll = Math.random() * total;
  for (const p of pools) {
    const w = Math.max(0, p.weight);
    if (w === 0) continue;
    roll -= w;
    if (roll < 0) return p.pool;
  }
  // Floating-point edge: roll landed exactly at the total. Return the last
  // non-zero-weight pool.
  for (let i = pools.length - 1; i >= 0; i--) {
    if (Math.max(0, pools[i]!.weight) > 0) return pools[i]!.pool;
  }
  return undefined;
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
  listenerPort: number
): void {
  const location = buildRedirectLocation(action, req, listenerPort);
  res.writeHead(action.statusCode, {
    location,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': '0',
  });
  res.end();
}

/** Build the `Location` URL for a redirect action, resolving ALB `#{...}` placeholders. */
export function buildRedirectLocation(
  action: RedirectRouteAction,
  req: { url?: string | undefined; headers: NodeJS.Dict<string | string[]> },
  listenerPort: number
): string {
  const url = req.url ?? '/';
  const qIndex = url.indexOf('?');
  const reqPath = qIndex === -1 ? url : url.slice(0, qIndex);
  const reqQuery = qIndex === -1 ? '' : url.slice(qIndex + 1);
  const rawHost = req.headers['host'];
  const hostHeaderValue = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  const reqHostName = (hostHeaderValue ?? '').split(':')[0] ?? '';

  const placeholders: Record<string, string> = {
    protocol: 'http',
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
 * Inject the ALB-style forwarding headers a downstream app may read. Appends
 * the client IP to any existing `X-Forwarded-For` chain (ALB appends rather
 * than replaces) and stamps the scheme / listener port.
 */
function appendForwardedHeaders(
  headers: NodeJS.Dict<string | string[]>,
  req: IncomingMessage,
  listenerPort: number
): void {
  const clientIp = req.socket.remoteAddress ?? '';
  const existing = headers['x-forwarded-for'];
  const chain = Array.isArray(existing) ? existing.join(', ') : existing;
  headers['x-forwarded-for'] = chain ? `${chain}, ${clientIp}` : clientIp;
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-port'] = String(listenerPort);
}

function writeError(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}
