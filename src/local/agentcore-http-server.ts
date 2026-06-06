import { randomUUID } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachAgentCoreWsBridge } from './agentcore-ws-bridge.js';
import { AGENTCORE_SESSION_ID_HEADER } from './agentcore-client.js';
import { getLogger } from '../utils/logger.js';

/**
 * Host HTTP serve in front of a warm AgentCore runtime container, the serving
 * primitive behind `cdkl start-agentcore` for HTTP / AGUI protocols (issue
 * #454). Unlike the single-shot `cdkl invoke-agentcore` — which boots a
 * container, POSTs ONE `/invocations`, and tears it down — this keeps the
 * container warm and serves its native HTTP contract until `^C`, so a client
 * can hit `POST /invocations` (and `GET /ping`) repeatedly against the SAME
 * warm container. That mirrors AgentCore's deployed model, where many
 * `InvokeAgentRuntime` calls on the same `runtimeSessionId` reuse one warm
 * microVM.
 *
 * One host `http.Server` serves all three:
 *  - `GET  /ping`         -> proxied to the container's `/ping`
 *  - `POST /invocations`  -> proxied to the container's `/invocations`
 *    (request body streamed up, response — JSON or SSE — streamed back)
 *  - `/ws` upgrade        -> the existing header-injecting bridge
 *    ({@link attachAgentCoreWsBridge}) on the same port, so a header-less
 *    browser `WebSocket` still works exactly as before.
 *
 * Auth parity: the boot-resolved `authorization` (the `--bearer-token`
 * validated once at boot under a `customJwtAuthorizer`, or the `--sigv4`
 * header set) is injected on every forwarded request — the same model the
 * `/ws` bridge uses. Per-request inbound JWT verification is out of scope for
 * this slice.
 */

const PING_PATH = '/ping';
const INVOCATIONS_PATH = '/invocations';

export interface AgentCoreHttpServerConfig {
  /** Host the warm container is reachable on (the published-port host). */
  containerHost: string;
  /** Host port the container's 8080 contract is published on. */
  containerPort: number;
  /** Bind host for the serve. Defaults to `127.0.0.1`. */
  host?: string;
  /** Bind port for the serve. Defaults to `0` (OS-assigned). */
  port?: number;
  /**
   * Pin a single AgentCore session id for every forwarded request / `/ws`
   * connection. When omitted, each gets a fresh `randomUUID()`.
   */
  sessionId?: string;
  /** `Authorization` header injected on every forwarded request + `/ws` leg. */
  authorization?: string;
}

export interface RunningAgentCoreHttpServer {
  /** `http://host:port` — the HTTP contract base (POST /invocations, GET /ping). */
  httpUrl: string;
  /** `ws://host:port/ws` — the bridged WebSocket endpoint on the same port. */
  wsUrl: string;
  /** The bound host port. */
  port: number;
  /** Close the server, the `/ws` bridge, and every live bridged connection. */
  close(): Promise<void>;
}

/**
 * Proxy one inbound HTTP request to the warm container, injecting the
 * session-id + Authorization (+ any extra) headers, and stream the response
 * back. Used for both `GET /ping` and `POST /invocations`; piping the response
 * preserves an SSE (`text/event-stream`) stream.
 */
function proxyToContainer(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  config: AgentCoreHttpServerConfig,
  upstreamPath: string
): void {
  const headers: OutgoingHttpHeaders = { ...clientReq.headers };
  // `host` must reflect the upstream, not the inbound serve; drop it so node
  // sets it for the container leg.
  delete headers['host'];
  headers[AGENTCORE_SESSION_ID_HEADER] = config.sessionId ?? randomUUID();
  if (config.authorization) headers['authorization'] = config.authorization;

  const upstream = httpRequest(
    {
      host: config.containerHost,
      port: config.containerPort,
      path: upstreamPath,
      method: clientReq.method,
      headers,
    },
    (upRes) => {
      clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers);
      // A mid-stream upstream drop (e.g. while an SSE response is in flight)
      // errors `upRes` AFTER headers are sent; `pipe` does not forward that, so
      // without this the unhandled `error` crashes the long-running serve. Tear
      // the inbound socket down instead.
      upRes.on('error', () => clientRes.destroy());
      upRes.pipe(clientRes);
    }
  );
  upstream.on('error', (err) => {
    getLogger().debug(`agentcore http serve upstream error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
    }
    clientRes.end(JSON.stringify({ error: `upstream error: ${err.message}` }));
  });
  // A client that aborts mid-upload errors `clientReq`; with no listener that
  // is an unhandled `error` that crashes the serve. Abort the upstream leg.
  clientReq.on('error', (err) => {
    getLogger().debug(`agentcore http serve client error: ${err.message}`);
    upstream.destroy();
  });
  clientReq.pipe(upstream);
}

/**
 * Start the HTTP serve. Resolves once it is listening; the returned handle
 * carries the connectable `httpUrl` / `wsUrl` and a `close()` that tears down
 * the server + the `/ws` bridge + every live bridged connection.
 */
export function startAgentCoreHttpServer(
  config: AgentCoreHttpServerConfig
): Promise<RunningAgentCoreHttpServer> {
  const host = config.host ?? '127.0.0.1';
  const httpServer: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === PING_PATH) {
      return proxyToContainer(req, res, config, PING_PATH);
    }
    if (req.method === 'POST' && path === INVOCATIONS_PATH) {
      return proxyToContainer(req, res, config, INVOCATIONS_PATH);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'not found',
        hint: 'POST /invocations or GET /ping (WebSocket: connect to /ws)',
      })
    );
  });

  const bridge = attachAgentCoreWsBridge(httpServer, {
    containerHost: config.containerHost,
    containerPort: config.containerPort,
    ...(config.sessionId && { sessionId: config.sessionId }),
    ...(config.authorization && { authorization: config.authorization }),
  });

  return new Promise<RunningAgentCoreHttpServer>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port ?? 0, host, () => {
      httpServer.removeListener('error', reject);
      // A post-listen server error on this long-running server must not become
      // an uncaught exception — log it; the serve command's signal handlers own
      // teardown.
      httpServer.on('error', (err) =>
        getLogger().debug(`agentcore http serve server error: ${err.message}`)
      );
      const port = (httpServer.address() as AddressInfo).port;
      resolve({
        httpUrl: `http://${host}:${port}`,
        wsUrl: `ws://${host}:${port}${bridge.path}`,
        port,
        close: () =>
          new Promise<void>((res) => {
            void bridge.close().then(() => httpServer.close(() => res()));
          }),
      });
    });
  });
}
