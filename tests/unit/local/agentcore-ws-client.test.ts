import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { WebSocketServer, type WebSocket } from 'ws';
import { invokeAgentCoreWs } from '../../../src/local/agentcore-ws-client.js';
import { AGENTCORE_SESSION_ID_HEADER } from '../../../src/local/agentcore-client.js';

/**
 * These tests drive the real `ws` client against a real in-process
 * `WebSocketServer` on an ephemeral port — no mocking of the transport, so the
 * upgrade headers + framing behavior are exercised end to end.
 */

let servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
  servers = [];
});

interface StartedServer {
  port: number;
  /** Upgrade headers seen on the most recent connection. */
  lastHeaders: () => Record<string, string | string[] | undefined>;
}

/** Start a `/ws` server; `onConn` decides how the server replies/closes. */
async function startServer(
  onConn: (ws: WebSocket, firstFrame: string) => void
): Promise<StartedServer> {
  const wss = new WebSocketServer({ port: 0, path: '/ws' });
  servers.push(wss);
  let headers: Record<string, string | string[] | undefined> = {};
  wss.on('connection', (ws, req) => {
    headers = req.headers;
    ws.once('message', (data) => onConn(ws, data.toString()));
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  return { port, lastHeaders: () => headers };
}

describe('invokeAgentCoreWs', () => {
  it('sends the event as the first frame, streams received frames, and resolves with the frame count', async () => {
    const server = await startServer((ws, firstFrame) => {
      // Echo the event back, emit two more frames, then close.
      ws.send(`echo:${firstFrame}`);
      ws.send('frame-2');
      ws.send('frame-3');
      ws.close();
    });

    const received: string[] = [];
    const result = await invokeAgentCoreWs('127.0.0.1', server.port, { prompt: 'hi' }, {
      sessionId: 'sess-abc',
      timeoutMs: 5000,
      onMessage: (t) => received.push(t),
    });

    expect(received).toEqual(['echo:{"prompt":"hi"}', 'frame-2', 'frame-3']);
    expect(result.frames).toBe(3);
  });

  it('sends an empty-object first frame when the event is nullish', async () => {
    let firstFrame = '';
    const server = await startServer((ws, frame) => {
      firstFrame = frame;
      ws.close();
    });

    await invokeAgentCoreWs('127.0.0.1', server.port, undefined, {
      sessionId: 's',
      timeoutMs: 5000,
      onMessage: () => {},
    });

    expect(firstFrame).toBe('{}');
  });

  it('sends the AgentCore session-id header on the upgrade', async () => {
    const server = await startServer((ws) => ws.close());

    await invokeAgentCoreWs('127.0.0.1', server.port, {}, {
      sessionId: 'session-xyz',
      timeoutMs: 5000,
      onMessage: () => {},
    });

    expect(server.lastHeaders()[AGENTCORE_SESSION_ID_HEADER.toLowerCase()]).toBe('session-xyz');
  });

  it('forwards the Authorization header when supplied', async () => {
    const server = await startServer((ws) => ws.close());

    await invokeAgentCoreWs('127.0.0.1', server.port, {}, {
      sessionId: 's',
      timeoutMs: 5000,
      onMessage: () => {},
      authorization: 'Bearer the.jwt.token',
    });

    expect(server.lastHeaders()['authorization']).toBe('Bearer the.jwt.token');
  });

  it('omits the Authorization header when not supplied', async () => {
    const server = await startServer((ws) => ws.close());

    await invokeAgentCoreWs('127.0.0.1', server.port, {}, {
      sessionId: 's',
      timeoutMs: 5000,
      onMessage: () => {},
    });

    expect(server.lastHeaders()['authorization']).toBeUndefined();
  });

  it('rejects on a connection error (nothing listening)', async () => {
    // Port 1 is privileged + unbound in the test sandbox → ECONNREFUSED.
    await expect(
      invokeAgentCoreWs('127.0.0.1', 1, {}, {
        sessionId: 's',
        timeoutMs: 5000,
        onMessage: () => {},
      })
    ).rejects.toThrow();
  });

  it('rejects with a timeout error when the server never closes the stream', async () => {
    // Server accepts + sends one frame but never closes → the client must abort
    // on timeoutMs.
    const server = await startServer((ws) => {
      ws.send('one');
      // intentionally no close()
    });

    await expect(
      invokeAgentCoreWs('127.0.0.1', server.port, {}, {
        sessionId: 's',
        timeoutMs: 150,
        onMessage: () => {},
      })
    ).rejects.toThrow(/timed out after 150ms/);
  });
});
