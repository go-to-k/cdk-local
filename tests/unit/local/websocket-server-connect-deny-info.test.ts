import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Issue #246 site 3 — `$connect` authorizer deny used to log at
 * `logger.debug`, so the local-dev user saw a closed WebSocket (code
 * 1008) but no signal in the cdkl tail explaining why. Lock the bump
 * to `logger.info` so the deny appears next to the normal
 * `$connect` / `$disconnect` lines.
 */
vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(),
}));

import * as rieClient from '../../../src/local/rie-client.js';
import { attachWebSocketServer } from '../../../src/local/websocket-server.js';
import type { DiscoveredWebSocketApi } from '../../../src/local/websocket-route-discovery.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';

const invokeRieMock = rieClient.invokeRie as unknown as ReturnType<typeof vi.fn>;

function buildApi(): DiscoveredWebSocketApi {
  return {
    apiLogicalId: 'WsApi',
    apiStackName: 'AppStack',
    declaredAt: 'AppStack/WsApi',
    routeSelectionExpression: '$request.body.action',
    stage: 'local',
    routes: [
      {
        routeKey: '$connect',
        targetLambdaLogicalId: 'ConnectFn',
        lambdaStackName: 'AppStack',
        declaredAt: 'AppStack/ConnectRoute',
      },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakePool(): any {
  return {
    acquire: async () => ({ containerHost: '127.0.0.1', hostPort: 1234 }),
    release: () => {},
    dispose: async () => {},
  };
}

describe('attachWebSocketServer — $connect deny surfaces at info (issue #246)', () => {
  let httpServer: HttpServer;
  let port: number;
  let close: undefined | (() => Promise<void>);

  beforeEach(async () => {
    invokeRieMock.mockReset();
    httpServer = createServer();
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (close) await close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  it("logs the $connect deny at info (not debug) so the user sees it in default-level cdkl output", async () => {
    // Spy on the prototype so both the global logger and any child loggers
    // (the websocket-server uses `getLogger().child('start-api/ws')`)
    // trip the spy.
    const infoSpy = vi
      .spyOn(ConsoleLogger.prototype, 'info')
      .mockImplementation(() => {});
    const debugSpy = vi
      .spyOn(ConsoleLogger.prototype, 'debug')
      .mockImplementation(() => {});

    // Authorizer returns 403 → invokeRouteAndDecideAuth returns false → deny path.
    invokeRieMock.mockResolvedValue({ payload: { statusCode: 403 } });

    const attached = attachWebSocketServer({
      httpServer,
      apis: [{ api: buildApi(), apiPath: '/' }],
      pool: fakePool(),
      rieTimeoutMs: 5_000,
    });
    close = () => attached.close();

    const { WebSocket } = await import('ws');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      ws.on('close', (code) => {
        // Deny closes with 1008 (policy violation).
        try {
          expect(code).toBe(1008);
          resolve();
        } catch (err) {
          reject(err as Error);
        }
      });
      ws.on('error', () => {
        /* ignore — close handler resolves first */
      });
    });

    // Find the info log message naming the deny — there is exactly one
    // per denied connection.
    const infoLines = infoSpy.mock.calls.map((c) => String(c[0]));
    const denyLine = infoLines.find((l) => l.includes('$connect denied'));
    expect(denyLine).toBeDefined();
    expect(denyLine!).toContain('AppStack/WsApi');
    expect(denyLine!).toContain('code 1008');

    // The pre-fix debug path is gone.
    const debugLines = debugSpy.mock.calls.map((c) => String(c[0]));
    expect(debugLines.some((l) => l.includes('$connect denied'))).toBe(false);
  });
});
