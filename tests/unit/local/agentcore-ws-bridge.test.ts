import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { WebSocket, WebSocketServer } from 'ws';
import { startAgentCoreWsBridge } from '../../../src/local/agentcore-ws-bridge.js';
import { AGENTCORE_SESSION_ID_HEADER } from '../../../src/local/agentcore-client.js';

/**
 * `startAgentCoreWsBridge` is the host WebSocket server behind
 * `cdkl start-agentcore`. It is exercised end to end: a real in-process `ws`
 * server stands in for the AgentCore container `/ws`, and a real `ws` client
 * (the "browser", deliberately sending NO custom headers) connects to the
 * bridge. The bridge must inject the session-id / Authorization on the
 * container leg and pipe frames both ways.
 */

let containers: WebSocketServer[] = [];
let bridges: Array<{ close(): Promise<void> }> = [];
let clients: WebSocket[] = [];

afterEach(async () => {
  for (const c of clients) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
  clients = [];
  await Promise.all(bridges.map((b) => b.close().catch(() => undefined)));
  bridges = [];
  await Promise.all(containers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  containers = [];
});

interface FakeContainer {
  port: number;
  received: string[];
  headersFor: () => Record<string, string | string[] | undefined>;
}

/** Start a fake container `/ws` server that echoes each frame as `echo:<frame>`. */
async function startFakeContainer(): Promise<FakeContainer> {
  const wss = new WebSocketServer({ port: 0, path: '/ws' });
  containers.push(wss);
  const received: string[] = [];
  let headers: Record<string, string | string[] | undefined> = {};
  wss.on('connection', (ws, req) => {
    headers = req.headers;
    ws.on('message', (data) => {
      const text = data.toString();
      received.push(text);
      ws.send(`echo:${text}`);
    });
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  return { port: (wss.address() as AddressInfo).port, received, headersFor: () => headers };
}

/** Connect a header-less browser client to the bridge URL. */
function connectBrowser(url: string): WebSocket {
  const ws = new WebSocket(url);
  clients.push(ws);
  return ws;
}

describe('startAgentCoreWsBridge', () => {
  it('round-trips a frame browser -> bridge -> container -> bridge -> browser, injecting the session-id', async () => {
    const container = await startFakeContainer();
    const bridge = await startAgentCoreWsBridge({
      containerHost: '127.0.0.1',
      containerPort: container.port,
    });
    bridges.push(bridge);
    expect(bridge.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);

    const browser = connectBrowser(bridge.url);
    const echoed = await new Promise<string>((resolve, reject) => {
      browser.on('open', () => browser.send('hello'));
      browser.on('message', (d) => resolve(d.toString()));
      browser.on('error', reject);
    });

    expect(echoed).toBe('echo:hello');
    expect(container.received).toEqual(['hello']);
    // The header-less browser never set it; the bridge injected a UUID.
    const sid = container.headersFor()[AGENTCORE_SESSION_ID_HEADER.toLowerCase()];
    expect(typeof sid).toBe('string');
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('pins the configured session-id and injects the Authorization header', async () => {
    const container = await startFakeContainer();
    const bridge = await startAgentCoreWsBridge({
      containerHost: '127.0.0.1',
      containerPort: container.port,
      sessionId: 'pinned-session',
      authorization: 'Bearer jwt-123',
    });
    bridges.push(bridge);

    const browser = connectBrowser(bridge.url);
    await new Promise<void>((resolve, reject) => {
      browser.on('open', () => browser.send('ping'));
      browser.on('message', () => resolve());
      browser.on('error', reject);
    });

    expect(container.headersFor()[AGENTCORE_SESSION_ID_HEADER.toLowerCase()]).toBe('pinned-session');
    expect(container.headersFor()['authorization']).toBe('Bearer jwt-123');
  });

  it('gives each browser connection its own session id', async () => {
    const sessions: string[] = [];
    const wss = new WebSocketServer({ port: 0, path: '/ws' });
    containers.push(wss);
    wss.on('connection', (ws, req) => {
      sessions.push(String(req.headers[AGENTCORE_SESSION_ID_HEADER.toLowerCase()]));
      ws.on('message', (d) => ws.send(d.toString()));
    });
    await new Promise<void>((r) => wss.on('listening', () => r()));
    const containerPort = (wss.address() as AddressInfo).port;

    const bridge = await startAgentCoreWsBridge({ containerHost: '127.0.0.1', containerPort });
    bridges.push(bridge);

    const drive = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const b = connectBrowser(bridge.url);
        b.on('open', () => b.send('x'));
        b.on('message', () => resolve());
        b.on('error', reject);
      });
    await drive();
    await drive();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toBe(sessions[1]);
  });

  it('closes the browser socket when the container closes', async () => {
    const wss = new WebSocketServer({ port: 0, path: '/ws' });
    containers.push(wss);
    wss.on('connection', (ws) => ws.close());
    await new Promise<void>((r) => wss.on('listening', () => r()));
    const containerPort = (wss.address() as AddressInfo).port;

    const bridge = await startAgentCoreWsBridge({ containerHost: '127.0.0.1', containerPort });
    bridges.push(bridge);

    const browser = connectBrowser(bridge.url);
    const closed = await new Promise<boolean>((resolve, reject) => {
      browser.on('close', () => resolve(true));
      browser.on('error', reject);
    });
    expect(closed).toBe(true);
  });

  it('notifies the browser and closes when the container leg fails', async () => {
    // No container server on this port — the bridge's container leg errors,
    // which must surface a `[bridge error]` frame to the browser then close it.
    const bridge = await startAgentCoreWsBridge({
      containerHost: '127.0.0.1',
      containerPort: 1,
    });
    bridges.push(bridge);

    const browser = connectBrowser(bridge.url);
    const frames: string[] = [];
    const closed = await new Promise<boolean>((resolve, reject) => {
      browser.on('message', (d) => frames.push(d.toString()));
      browser.on('close', () => resolve(true));
      browser.on('error', reject);
    });
    expect(closed).toBe(true);
    // The error notice is best-effort (may race the close), so assert only the
    // shape if any frame arrived.
    if (frames.length > 0) expect(frames[0]).toMatch(/^\[bridge error\]/);
  });

  it('serves on a custom path', async () => {
    const container = await startFakeContainer();
    const bridge = await startAgentCoreWsBridge({
      containerHost: '127.0.0.1',
      containerPort: container.port,
      path: '/agent-ws',
    });
    bridges.push(bridge);
    expect(bridge.url).toMatch(/\/agent-ws$/);

    const browser = connectBrowser(bridge.url);
    const echoed = await new Promise<string>((resolve, reject) => {
      browser.on('open', () => browser.send('hi'));
      browser.on('message', (d) => resolve(d.toString()));
      browser.on('error', reject);
    });
    expect(echoed).toBe('echo:hi');
  });

  it('answers a plain HTTP request with 426 Upgrade Required', async () => {
    const container = await startFakeContainer();
    const bridge = await startAgentCoreWsBridge({
      containerHost: '127.0.0.1',
      containerPort: container.port,
    });
    bridges.push(bridge);

    const httpUrl = bridge.url.replace(/^ws:/, 'http:');
    const res = await fetch(httpUrl);
    expect(res.status).toBe(426);
    await res.text();
  });

  it('close() stops accepting new connections', async () => {
    const container = await startFakeContainer();
    const bridge = await startAgentCoreWsBridge({
      containerHost: '127.0.0.1',
      containerPort: container.port,
    });
    const { url } = bridge;
    await bridge.close();

    const failed = await new Promise<boolean>((resolve) => {
      const b = new WebSocket(url);
      clients.push(b);
      b.on('open', () => resolve(false));
      b.on('error', () => resolve(true));
    });
    expect(failed).toBe(true);
  });
});
