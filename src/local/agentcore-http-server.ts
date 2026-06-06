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
import type { AgentCoreServeAuthCheck } from './agentcore-serve-auth.js';
import { getLogger } from '../utils/logger.js';

/**
 * Host HTTP serve in front of a warm AgentCore runtime container, the serving
 * primitive behind `cdkl start-agentcore` for ALL four protocols (issue #454).
 * Unlike the single-shot `cdkl invoke-agentcore` — which boots a container,
 * POSTs ONE request, and tears it down — this keeps the container warm and
 * serves its native HTTP contract until `^C`, so a client can hit the agent
 * repeatedly against the SAME warm container. That mirrors AgentCore's
 * deployed model, where many `InvokeAgentRuntime` calls on the same
 * `runtimeSessionId` reuse one warm microVM.
 *
 * The serve is protocol-aware via {@link AgentCoreHttpServerConfig.routes} +
 * {@link AgentCoreHttpServerConfig.attachWs} — the proxy itself is
 * protocol-agnostic, only the routing table and the `/ws`-attach decision
 * change:
 *  - HTTP / AGUI (default): `POST /invocations` + `GET /ping`, plus the `/ws`
 *    upgrade bridged on the same port ({@link attachAgentCoreWsBridge}), so a
 *    header-less browser `WebSocket` works exactly as before.
 *  - MCP: `POST /mcp` (container port 8000), no `/ws`.
 *  - A2A: `POST /` (container port 9000), no `/ws`.
 * Each declared route is forwarded verbatim to the warm container; MCP / A2A
 * are pure pass-through (the client drives the handshake / JSON-RPC — the serve
 * does not interpret the protocol).
 *
 * Auth parity: the boot-resolved `authorization` (the `--bearer-token`
 * validated once at boot under a `customJwtAuthorizer`, or the `--sigv4`
 * header set) is injected on every forwarded request — the same model the
 * `/ws` bridge uses. Per-request inbound JWT verification is out of scope for
 * this slice.
 */

const PING_PATH = '/ping';
const INVOCATIONS_PATH = '/invocations';

/** A `{method, path}` the serve forwards verbatim to the warm container. */
export interface AgentCoreServeRoute {
  /** HTTP method to match (e.g. `GET`, `POST`). */
  method: string;
  /** Inbound path to match; forwarded verbatim as the upstream path. */
  path: string;
}

/**
 * Compute the SigV4 header overlay for one forwarded `POST` request (the
 * `--sigv4` serve path, issue #454). Called with the buffered request body and
 * the per-request session id; returns the `Authorization` + `X-Amz-*` headers
 * to inject so the warm container sees the same signed header set the cloud
 * AgentCore Runtime would. Requires buffering the body (so the proxy switches
 * off streaming for the signed path).
 */
export type AgentCoreServeSignRequest = (opts: {
  method: string;
  path: string;
  body: Buffer;
  sessionId: string;
}) => Promise<Record<string, string>>;

/** Default routing table — the HTTP / AGUI contract (POST /invocations + GET /ping). */
const DEFAULT_ROUTES: AgentCoreServeRoute[] = [
  { method: 'POST', path: INVOCATIONS_PATH },
  { method: 'GET', path: PING_PATH },
];

export interface AgentCoreHttpServerConfig {
  /** Host the warm container is reachable on (the published-port host). */
  containerHost: string;
  /** Host port the container's contract port is published on. */
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
  /**
   * The `{method, path}` pairs forwarded to the warm container. Defaults to
   * the HTTP / AGUI contract ({@link DEFAULT_ROUTES}); MCP / A2A pass a single
   * route (`POST /mcp` / `POST /`).
   */
  routes?: AgentCoreServeRoute[];
  /**
   * Attach the header-injecting `/ws` bridge on the same port (HTTP / AGUI
   * only — MCP / A2A have no `/ws`). Defaults to `true`.
   */
  attachWs?: boolean;
  /**
   * Per-request inbound-JWT gate (issue #454). When set, every `POST` contract
   * request is verified against the runtime's `customJwtAuthorizer` before being
   * forwarded — 401 (missing token) / 403 (invalid) on deny. `GET /ping` is a
   * health check and is never gated. On allow, the check's returned
   * `authorization` is forwarded (overriding {@link authorization}). Absent for
   * a runtime with no authorizer (or under `--no-verify-auth`, where the check
   * always allows).
   */
  authCheck?: AgentCoreServeAuthCheck;
  /**
   * Per-request SigV4 signer for the `--sigv4` serve path (issue #454). When
   * set, every `POST` contract request's body is buffered and signed; the
   * returned headers are injected so the warm container sees the same signed
   * header set the cloud receives. Mutually exclusive with a
   * `customJwtAuthorizer` (the JWT path wins) and with {@link authorization}.
   */
  signRequest?: AgentCoreServeSignRequest;
}

export interface RunningAgentCoreHttpServer {
  /** `http://host:port` — the HTTP contract base. */
  httpUrl: string;
  /**
   * `ws://host:port/ws` — the bridged WebSocket endpoint on the same port.
   * Present only when the `/ws` bridge is attached (HTTP / AGUI).
   */
  wsUrl?: string;
  /** The bound host port. */
  port: number;
  /** Close the server, the `/ws` bridge (if any), and every live connection. */
  close(): Promise<void>;
}

/**
 * Wire an upstream (container-leg) request's response back to the inbound
 * client, piping the body so an SSE (`text/event-stream`) stream stays
 * incremental, and mapping an upstream error to a `502`. Shared by the
 * streaming and buffered (`--sigv4`) proxy paths.
 */
function wireUpstreamResponse(
  upstream: ReturnType<typeof httpRequest>,
  clientRes: ServerResponse
): void {
  upstream.on('response', (upRes) => {
    clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers);
    // A mid-stream upstream drop (e.g. while an SSE response is in flight)
    // errors `upRes` AFTER headers are sent; `pipe` does not forward that, so
    // without this the unhandled `error` crashes the long-running serve. Tear
    // the inbound socket down instead.
    upRes.on('error', () => clientRes.destroy());
    upRes.pipe(clientRes);
  });
  upstream.on('error', (err) => {
    getLogger().debug(`agentcore http serve upstream error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
    }
    clientRes.end(JSON.stringify({ error: `upstream error: ${err.message}` }));
  });
}

/**
 * Proxy one inbound HTTP request to the warm container, injecting the
 * session-id + Authorization (+ any per-request / signed) headers, and stream
 * the response back. Used for both `GET /ping` and `POST /invocations`; piping
 * the response preserves an SSE (`text/event-stream`) stream.
 *
 * `perRequest.authorization` overrides {@link AgentCoreHttpServerConfig.authorization}
 * with the value the per-request inbound-JWT gate verified / injected (issue
 * #454). When {@link AgentCoreHttpServerConfig.signRequest} is set and this is a
 * `POST`, the body is buffered, signed (SigV4), and forwarded — signing needs
 * the whole body, so the streaming fast-path is bypassed for that case only.
 */
function proxyToContainer(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  config: AgentCoreHttpServerConfig,
  upstreamPath: string,
  perRequest?: { authorization?: string }
): void {
  const sessionId = config.sessionId ?? randomUUID();
  const headers: OutgoingHttpHeaders = { ...clientReq.headers };
  // `host` must reflect the upstream, not the inbound serve; drop it so node
  // sets it for the container leg.
  delete headers['host'];
  headers[AGENTCORE_SESSION_ID_HEADER] = sessionId;
  const authorization = perRequest?.authorization ?? config.authorization;
  if (authorization) headers['authorization'] = authorization;

  // --sigv4: buffer the POST body, sign it, inject the signed headers, then
  // forward the buffered body. Signing needs the whole body, so this path does
  // not stream the request (the response is still piped — SSE-safe).
  if (config.signRequest && clientReq.method === 'POST') {
    const signRequest = config.signRequest;
    const chunks: Buffer[] = [];
    clientReq.on('data', (c: Buffer) => chunks.push(c));
    clientReq.on('error', (err) => {
      getLogger().debug(`agentcore http serve client error: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(400, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ error: `client error: ${err.message}` }));
      }
    });
    clientReq.on('end', () => {
      const body = Buffer.concat(chunks);
      void signRequest({ method: 'POST', path: upstreamPath, body, sessionId })
        .then((signed) => {
          const signedHeaders: OutgoingHttpHeaders = { ...headers, ...signed };
          // The body is now buffered + sent fixed-length, so drop any inbound
          // `transfer-encoding: chunked` (illegal alongside `content-length` —
          // the upstream would 400) and declare the real length.
          delete signedHeaders['transfer-encoding'];
          signedHeaders['content-length'] = String(body.length);
          const upstream = httpRequest({
            host: config.containerHost,
            port: config.containerPort,
            path: upstreamPath,
            method: 'POST',
            headers: signedHeaders,
          });
          wireUpstreamResponse(upstream, clientRes);
          upstream.end(body);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          getLogger().debug(`agentcore http serve sigv4 sign error: ${msg}`);
          if (!clientRes.headersSent) {
            clientRes.writeHead(500, { 'content-type': 'application/json' });
            clientRes.end(JSON.stringify({ error: `sigv4 signing failed: ${msg}` }));
          }
        });
    });
    return;
  }

  const upstream = httpRequest({
    host: config.containerHost,
    port: config.containerPort,
    path: upstreamPath,
    method: clientReq.method,
    headers,
  });
  wireUpstreamResponse(upstream, clientRes);
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
  const routes = config.routes ?? DEFAULT_ROUTES;
  const attachWs = config.attachWs ?? true;
  const notFoundHint = buildNotFoundHint(routes, attachWs);

  const httpServer: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const match = routes.find((r) => r.method === req.method && r.path === path);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', hint: notFoundHint }));
      return;
    }
    // Per-request inbound-JWT gate (issue #454). Only the contract POST is
    // gated — `GET /ping` is an unauthenticated health check, matching the
    // cloud (the customJwtAuthorizer guards InvokeAgentRuntime, not the health
    // probe). On allow, forward the verified / injected Authorization.
    if (config.authCheck && req.method === 'POST') {
      // The gate is async (a JWKS / discovery round-trip), so the request may
      // be in flight while we await. A client that aborts mid-upload errors
      // `req`; with no listener that is an unhandled `error` that crashes the
      // long-running serve (the streaming path guards the same way). On the
      // allow path proxyToContainer re-attaches its own listener.
      req.on('error', (err) =>
        getLogger().debug(`agentcore http serve client error (auth gate): ${err.message}`)
      );
      void config
        .authCheck(req.headers)
        .then((result) => {
          if (!result.allow) {
            // Drain the unconsumed request body so the socket can close cleanly
            // instead of half-open until the client gives up.
            req.resume();
            res.writeHead(result.status ?? 403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: result.message ?? 'forbidden' }));
            return;
          }
          proxyToContainer(req, res, config, match.path, {
            ...(result.authorization && { authorization: result.authorization }),
          });
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          getLogger().debug(`agentcore http serve auth-check error: ${msg}`);
          req.resume();
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `auth check failed: ${msg}` }));
          }
        });
      return;
    }
    proxyToContainer(req, res, config, match.path);
  });

  // MCP / A2A have no `/ws` — the bridge is attached for HTTP / AGUI only.
  const bridge = attachWs
    ? attachAgentCoreWsBridge(httpServer, {
        containerHost: config.containerHost,
        containerPort: config.containerPort,
        ...(config.sessionId && { sessionId: config.sessionId }),
        ...(config.authorization && { authorization: config.authorization }),
      })
    : undefined;

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
        ...(bridge && { wsUrl: `ws://${host}:${port}${bridge.path}` }),
        port,
        close: () =>
          new Promise<void>((res) => {
            if (bridge) {
              void bridge.close().then(() => httpServer.close(() => res()));
            } else {
              httpServer.close(() => res());
            }
          }),
      });
    });
  });
}

/**
 * Build the 404 hint from the served routes, appending the `/ws` pointer when
 * the WebSocket bridge is attached. e.g. HTTP / AGUI ->
 * `POST /invocations or GET /ping (WebSocket: connect to /ws)`; MCP ->
 * `POST /mcp`.
 */
function buildNotFoundHint(routes: AgentCoreServeRoute[], attachWs: boolean): string {
  const base = routes.map((r) => `${r.method} ${r.path}`).join(' or ');
  return attachWs ? `${base} (WebSocket: connect to /ws)` : base;
}
