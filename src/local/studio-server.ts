import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  StudioEventBus,
  type StudioInvocationEvent,
  type StudioLogEvent,
} from './studio-events.js';
import { renderStudioHtml } from './studio-ui.js';
import type { TargetListing } from './target-lister.js';

/** One target as the studio UI consumes it (`GET /api/targets`). */
export interface StudioTarget {
  /** Stable target id — the display path when available, else qualified id. */
  id: string;
  /** Stack-qualified `<Stack>:<LogicalId>` for disambiguation. */
  qualifiedId: string;
  /** API surface kind (REST v1 / HTTP v2 / ...), only for `api` entries. */
  surface?: string;
}

/** A category of targets, grouped by the studio kind that runs them. */
export interface StudioTargetGroup {
  /** Studio kind discriminator shared with {@link StudioInvocationEvent}. */
  kind: 'lambda' | 'api' | 'alb' | 'ecs' | 'agentcore';
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
  const map = (entries: TargetListing['lambdas']): StudioTarget[] =>
    entries.map((e) => {
      const t: StudioTarget = { id: e.displayPath ?? e.qualifiedId, qualifiedId: e.qualifiedId };
      if (e.kind) t.surface = e.kind;
      return t;
    });
  return [
    { kind: 'lambda', title: 'Lambda Functions', entries: map(listing.lambdas) },
    { kind: 'api', title: 'APIs', entries: map(listing.apis) },
    {
      kind: 'ecs',
      title: 'ECS Services / Tasks',
      entries: [...map(listing.ecsServices), ...map(listing.ecsTaskDefinitions)],
    },
    { kind: 'agentcore', title: 'AgentCore Runtimes', entries: map(listing.agentCoreRuntimes) },
    { kind: 'alb', title: 'Load Balancers', entries: map(listing.loadBalancers) },
  ];
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
  /** Header label for the running app / stack context. */
  appLabel: string;
  /** CLI brand name (`cdkl`, or a host rebrand). */
  cliName: string;
  /**
   * Max consecutive ports to try on `EADDRINUSE` before giving up.
   * Defaults to 20.
   */
  maxPortBump?: number;
}

/** A running studio server. */
export interface RunningStudioServer {
  /** The URL the UI is served at, e.g. `http://127.0.0.1:9999`. */
  url: string;
  /** The actually-bound port (may differ from the requested one). */
  port: number;
  /** Stop the server and release the port. */
  close: () => Promise<void>;
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
  const targetsJson = JSON.stringify({ groups: options.targetGroups });

  const server = createServer((req, res) =>
    handleRequest(req, res, options.bus, html, targetsJson)
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
  };
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bus: StudioEventBus,
  html: string,
  targetsJson: string
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
    res.end(targetsJson);
    return;
  }
  if (req.method === 'GET' && path === '/api/events') {
    serveSse(req, res, bus);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function serveSse(req: IncomingMessage, res: ServerResponse, bus: StudioEventBus): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  // Open the stream so EventSource fires `open` immediately.
  res.write(':ok\n\n');

  const onInvocation = (ev: StudioInvocationEvent): void => {
    res.write(`event: invocation\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const onLog = (ev: StudioLogEvent): void => {
    res.write(`event: log\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  bus.on('invocation', onInvocation);
  bus.on('log', onLog);

  const heartbeat = setInterval(() => res.write(':hb\n\n'), SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    bus.off('invocation', onInvocation);
    bus.off('log', onLog);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
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
