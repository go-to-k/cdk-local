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
 * Issue #86 v1 — host-side ALB front-door. A plain HTTP reverse proxy bound to
 * the ALB's declared listener port that round-robins each request across the
 * service's live replica pool (`FrontDoorEndpointPool`). Mirrors the
 * `startApiServer` lifecycle in `http-server.ts` (createServer + setNoDelay +
 * listen + close/closeAllConnections).
 *
 * The replicas publish their target container port on ephemeral host ports
 * (the daemon-in-a-VM reality on macOS means the host can't reach container
 * IPs directly), so the proxy forwards to `127.0.0.1:<ephemeralPort>` rather
 * than to docker-network addresses — cross-platform by construction.
 *
 * v1 scope: per-request round-robin, HTTP only. No listener-rule routing
 * (#123), no health-check-gated draining, no sticky sessions, no websocket
 * `Upgrade` proxying, no TLS termination.
 */

export interface StartFrontDoorServerOptions {
  /** Live replica endpoint pool fed by the service runner. */
  pool: FrontDoorEndpointPool;
  /** Host port to bind (the listener port, or its `--lb-port` override). */
  port: number;
  /** Host interface to bind. Defaults to `127.0.0.1`. */
  host?: string;
  /** ALB listener port (for the `X-Forwarded-Port` header / logs). */
  listenerPort: number;
  /** Service name for log lines. */
  serviceName: string;
}

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
    const endpoint = opts.pool.next();
    if (!endpoint) {
      // No live replica — mirror an ALB with no healthy targets (503).
      writeError(
        res,
        503,
        `No running replicas for service '${opts.serviceName}'. The front-door has no healthy ` +
          'target to forward to.'
      );
      resolve();
      return;
    }

    const headers = { ...req.headers };
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
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on('end', () => resolve());
        proxyRes.on('error', () => {
          if (!res.writableEnded) res.end();
          resolve();
        });
      }
    );

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        writeError(
          res,
          502,
          `Failed to reach replica ${endpoint.host}:${endpoint.port} for service ` +
            `'${opts.serviceName}'.`
        );
      } else if (!res.writableEnded) {
        res.end();
      }
      resolve();
    });

    req.pipe(proxyReq);
  });
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
