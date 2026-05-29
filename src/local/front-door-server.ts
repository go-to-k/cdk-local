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
 * declared listener port that, per request, selects a live replica pool
 * (`FrontDoorEndpointPool`) and round-robins across it. Mirrors the
 * `startApiServer` lifecycle in `http-server.ts` (createServer + setNoDelay +
 * listen + close/closeAllConnections).
 *
 * Pool selection is delegated to {@link StartFrontDoorServerOptions.selectPool}:
 *   - single default-forward listener -> a constant pool for every request;
 *   - a listener with `path-pattern` rules -> the matched rule's pool, falling
 *     back to the default-action pool (`undefined` when neither matches, which
 *     the proxy answers with 404 — like an ALB rule miss with no default).
 *
 * The replicas publish their target container port on ephemeral host ports
 * (the daemon-in-a-VM reality on macOS means the host can't reach container
 * IPs directly), so the proxy forwards to `127.0.0.1:<ephemeralPort>` rather
 * than to docker-network addresses — cross-platform by construction.
 *
 * Scope: per-request round-robin, HTTP only, `path-pattern` rule routing. No
 * host-header / weighted routing, no health-check-gated draining, no sticky
 * sessions, no websocket `Upgrade` proxying, no TLS termination (tracked in
 * #123).
 */

export interface StartFrontDoorServerOptions {
  /**
   * Choose the replica pool to serve a request from, given its URL path.
   * Returns `undefined` when no rule matched and there is no default action
   * (the proxy then replies 404).
   */
  selectPool: (requestPath: string) => FrontDoorEndpointPool | undefined;
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
    const pool = opts.selectPool(req.url ?? '/');
    if (!pool) {
      // No rule matched and no default action — mirror an ALB listener with no
      // matching rule and no default (404).
      writeError(
        res,
        404,
        `No listener rule matched '${req.url ?? '/'}' on ${opts.label}, and the listener has no ` +
          'default action forwarding to a local target.'
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
