import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { bridgeAgentCoreWs } from './agentcore-ws-client.js';
import { getLogger } from '../utils/logger.js';

/**
 * Host-side WebSocket bridge in front of an AgentCore runtime's container
 * `/ws` endpoint, the serving primitive behind `cdkl start-agentcore`.
 *
 * Why a bridge instead of pointing a client straight at the published
 * container port: the AgentCore `/ws` upgrade requires the
 * `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header (and `Authorization`
 * under a `customJwtAuthorizer`), but a browser `WebSocket` cannot set custom
 * request headers. So a browser console connects to THIS header-less bridge,
 * and the bridge opens a `ws` connection to the container with the headers
 * injected (via {@link bridgeAgentCoreWs}), piping frames both ways.
 *
 * One container connection per inbound client connection; each inbound client
 * gets its own AgentCore session id (a fresh UUID, unless one is pinned) so a
 * browser tab is its own session — the way the cloud front door scopes them.
 */

const DEFAULT_PATH = '/ws';

export interface AgentCoreWsBridgeServerConfig {
  /** Host the container `/ws` is reachable on (the published-port host). */
  containerHost: string;
  /**
   * Host port the container's `/ws` is published on. A getter resolves the port
   * LIVE per inbound connection — used by the HTTP serve under `--watch`, where
   * a rebuild rotates the container to a new port without re-attaching the
   * bridge (issue #454, slice 4b). A bare number pins it (the standalone
   * bridge).
   */
  containerPort: number | (() => number);
  /** Bind host for the bridge server. Defaults to `127.0.0.1`. */
  host?: string;
  /** Bind port for the bridge server. Defaults to `0` (OS-assigned). */
  port?: number;
  /**
   * Pin a single AgentCore session id for every inbound connection. When
   * omitted, each inbound connection gets a fresh `randomUUID()` so each
   * browser tab is its own session.
   */
  sessionId?: string;
  /** `Authorization: Bearer <jwt>` injected on every container upgrade. */
  authorization?: string;
  /** URL path the bridge accepts upgrades on. Defaults to `/ws`. */
  path?: string;
  /** Injected WebSocket implementation for tests, threaded to the container leg. */
  webSocketImpl?: typeof WebSocket;
}

export interface RunningAgentCoreWsBridge {
  /** `ws://host:port/path` a client (browser) connects to. */
  url: string;
  /** The bound bridge port. */
  port: number;
  /** Close the bridge server + every live bridged connection. */
  close(): Promise<void>;
}

function decodeBrowserFrame(data: RawData, isBinary: boolean): string {
  if (typeof data === 'string') return data;
  const buf = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  // A text frame arrives as bytes too; decode either way (the wire framing over
  // /ws is agent-defined, so we treat everything as UTF-8 text like the client).
  void isBinary;
  return buf.toString('utf-8');
}

/** Handle returned by {@link attachAgentCoreWsBridge}. */
export interface AttachedAgentCoreWsBridge {
  /** URL path the bridge accepts `/ws` upgrades on. */
  path: string;
  /** Close every live bridged connection + the WebSocketServer. */
  close(): Promise<void>;
}

/**
 * Attach the AgentCore `/ws` bridge to an EXISTING `http.Server`: registers a
 * `WebSocketServer` on `config.path` and, for each inbound (header-less)
 * client, opens a container `/ws` leg with the session-id / Authorization
 * headers injected (via {@link bridgeAgentCoreWs}), piping frames both ways.
 *
 * Shared by {@link startAgentCoreWsBridge} (a standalone `/ws`-only bridge) and
 * the HTTP serve (`startAgentCoreHttpServer`, issue #454), which serves the
 * same warm container's `POST /invocations` + `GET /ping` on the SAME port and
 * delegates the `/ws` upgrade here. The caller owns `httpServer.listen()` and
 * the host port; this helper only owns the WebSocket layer.
 */
export function attachAgentCoreWsBridge(
  httpServer: Server,
  config: Omit<AgentCoreWsBridgeServerConfig, 'host' | 'port'>
): AttachedAgentCoreWsBridge {
  const path = config.path ?? DEFAULT_PATH;
  const wss = new WebSocketServer({ server: httpServer, path });
  const liveCloses = new Set<() => void>();

  wss.on('connection', (browser: WebSocket) => {
    const sessionId = config.sessionId ?? randomUUID();
    // Resolve the container port LIVE so a --watch rebuild (which mutates the
    // getter's source) routes a new inbound connection to the new container.
    const containerPort =
      typeof config.containerPort === 'function' ? config.containerPort() : config.containerPort;
    const handle = bridgeAgentCoreWs(config.containerHost, containerPort, {
      sessionId,
      ...(config.authorization && { authorization: config.authorization }),
      ...(config.webSocketImpl && { webSocketImpl: config.webSocketImpl }),
      onMessage: (text) => {
        if (browser.readyState === browser.OPEN) browser.send(text);
      },
      onClose: () => {
        try {
          browser.close();
        } catch {
          /* already closing */
        }
      },
      onError: (err) => {
        // Surface the failure to the console, then drop the connection.
        if (browser.readyState === browser.OPEN) {
          try {
            browser.send(`[bridge error] ${err.message}`);
          } catch {
            /* best effort */
          }
        }
        try {
          browser.close();
        } catch {
          /* already closing */
        }
      },
    });
    liveCloses.add(handle.close);

    browser.on('message', (data: RawData, isBinary: boolean) => {
      handle.send(decodeBrowserFrame(data, isBinary));
    });
    browser.on('close', () => {
      liveCloses.delete(handle.close);
      handle.close();
    });
    browser.on('error', () => {
      liveCloses.delete(handle.close);
      handle.close();
    });
  });

  return {
    path,
    close: () =>
      new Promise<void>((res) => {
        for (const closeLeg of liveCloses) closeLeg();
        liveCloses.clear();
        wss.close(() => res());
      }),
  };
}

/**
 * Start a standalone `/ws`-only bridge server. Resolves once it is listening;
 * the returned handle carries the connectable `url` and a `close()` that tears
 * down the server and every live bridged connection.
 */
export function startAgentCoreWsBridge(
  config: AgentCoreWsBridgeServerConfig
): Promise<RunningAgentCoreWsBridge> {
  const host = config.host ?? '127.0.0.1';
  const httpServer: Server = createServer((_req, res) => {
    // The bridge speaks WebSocket only; a plain HTTP hit gets a hint.
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade required: connect over WebSocket.\n');
  });
  const attached = attachAgentCoreWsBridge(httpServer, config);

  return new Promise<RunningAgentCoreWsBridge>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port ?? 0, host, () => {
      httpServer.removeListener('error', reject);
      // A post-listen server error (rare socket-level failure) on this
      // long-running server must not become an uncaught exception that crashes
      // the process — log it instead. The serve command's signal handlers own
      // teardown; a transient server error does not tear the bridge down.
      httpServer.on('error', (err) =>
        getLogger().debug(`agentcore-ws bridge server error: ${err.message}`)
      );
      const port = (httpServer.address() as AddressInfo).port;
      resolve({
        url: `ws://${host}:${port}${attached.path}`,
        port,
        close: () =>
          new Promise<void>((res) => {
            void attached.close().then(() => httpServer.close(() => res()));
          }),
      });
    });
  });
}
