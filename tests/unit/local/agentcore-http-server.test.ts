import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  startAgentCoreHttpServer,
  type RunningAgentCoreHttpServer,
} from '../../../src/local/agentcore-http-server.js';

interface FakeContainer {
  server: Server;
  port: number;
  invocations: Array<{ body: string; sessionId?: string; authorization?: string }>;
}

// A stand-in for the warm AgentCore container: serves GET /ping and
// POST /invocations (echoing the body + the injected session-id / auth headers
// + a running invocation count, so a test can prove repeated requests hit the
// SAME warm "container").
function startFakeContainer(): Promise<FakeContainer> {
  const invocations: FakeContainer['invocations'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'Healthy' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/invocations') {
        const sessionId = req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as
          | string
          | undefined;
        const authorization = req.headers['authorization'] as string | undefined;
        invocations.push({ body, sessionId, authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echo: body, sessionId, authorization, count: invocations.length }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port, invocations })
    )
  );
}

function httpReq(
  opts: { host: string; port: number; path: string; method: string },
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('startAgentCoreHttpServer', () => {
  let fake: FakeContainer | undefined;
  let serve: RunningAgentCoreHttpServer | undefined;

  afterEach(async () => {
    if (serve) await serve.close().catch(() => undefined);
    if (fake) await new Promise<void>((res) => fake!.server.close(() => res()));
    serve = undefined;
    fake = undefined;
  });

  async function boot(
    extra: Partial<Parameters<typeof startAgentCoreHttpServer>[0]> = {}
  ): Promise<RunningAgentCoreHttpServer> {
    fake = await startFakeContainer();
    serve = await startAgentCoreHttpServer({
      containerHost: '127.0.0.1',
      containerPort: fake.port,
      host: '127.0.0.1',
      ...extra,
    });
    return serve;
  }

  it('proxies POST /invocations to the warm container, repeated requests hit the SAME one', async () => {
    const s = await boot();
    const r1 = await httpReq(
      { host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' },
      '{"turn":1}'
    );
    const r2 = await httpReq(
      { host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' },
      '{"turn":2}'
    );
    expect(r1.status).toBe(200);
    expect(JSON.parse(r1.body).echo).toBe('{"turn":1}');
    expect(JSON.parse(r1.body).count).toBe(1);
    // Second request increments the same container's counter (warm reuse).
    expect(JSON.parse(r2.body).count).toBe(2);
    expect(fake!.invocations).toHaveLength(2);
  });

  it('injects a session-id header (fresh per request when not pinned)', async () => {
    const s = await boot();
    await httpReq({ host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' }, '{}');
    await httpReq({ host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' }, '{}');
    const [a, b] = fake!.invocations;
    expect(a?.sessionId).toBeTruthy();
    expect(b?.sessionId).toBeTruthy();
    expect(a?.sessionId).not.toBe(b?.sessionId);
  });

  it('pins the session-id on every request when sessionId is set', async () => {
    const s = await boot({ sessionId: 'pinned-session-1234567890' });
    await httpReq({ host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' }, '{}');
    await httpReq({ host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' }, '{}');
    expect(fake!.invocations.map((i) => i.sessionId)).toEqual([
      'pinned-session-1234567890',
      'pinned-session-1234567890',
    ]);
  });

  it('injects the Authorization header when configured', async () => {
    const s = await boot({ authorization: 'Bearer test-token' });
    await httpReq({ host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' }, '{}');
    expect(fake!.invocations[0]?.authorization).toBe('Bearer test-token');
  });

  it('proxies GET /ping', async () => {
    const s = await boot();
    const r = await httpReq({ host: '127.0.0.1', port: s.port, path: '/ping', method: 'GET' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).status).toBe('Healthy');
  });

  it('returns 404 with a hint for an unknown path', async () => {
    const s = await boot();
    const r = await httpReq({ host: '127.0.0.1', port: s.port, path: '/nope', method: 'GET' });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).hint).toMatch(/invocations/);
  });

  it('exposes an http:// base and a ws:// /ws endpoint on the same port', async () => {
    const s = await boot();
    expect(s.httpUrl).toBe(`http://127.0.0.1:${s.port}`);
    expect(s.wsUrl).toBe(`ws://127.0.0.1:${s.port}/ws`);
  });
});
