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

  it('returns a clean 502 (no crash) when the upstream container is unreachable', async () => {
    // Grab a free port, then close the listener so nothing is there: the
    // forwarded request hits ECONNREFUSED -> the upstream `error` handler.
    const dead = await startFakeContainer();
    const deadPort = dead.port;
    await new Promise<void>((res) => dead.server.close(() => res()));
    serve = await startAgentCoreHttpServer({
      containerHost: '127.0.0.1',
      containerPort: deadPort,
      host: '127.0.0.1',
    });
    const r = await httpReq(
      { host: '127.0.0.1', port: serve.port, path: '/invocations', method: 'POST' },
      '{}'
    );
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error).toMatch(/upstream error/);
    // The serve survived — a second request also gets a clean 502, not a crash.
    const r2 = await httpReq({ host: '127.0.0.1', port: serve.port, path: '/ping', method: 'GET' });
    expect(r2.status).toBe(502);
  });
});

interface ProtocolFake {
  server: Server;
  port: number;
  requests: Array<{ method: string; path: string; body: string; sessionId?: string }>;
}

// A stand-in for an MCP / A2A warm container: echoes the request path + a
// running count back so a test can prove repeated POSTs hit the SAME warm
// "container" and that the serve forwarded the protocol path verbatim.
function startProtocolFake(): Promise<ProtocolFake> {
  const requests: ProtocolFake['requests'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const sessionId = req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as
        | string
        | undefined;
      requests.push({ method: req.method ?? '', path: req.url ?? '', body, sessionId });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { path: req.url, count: requests.length } }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port, requests })
    )
  );
}

interface RecordingContainer {
  server: Server;
  port: number;
  requests: Array<{ method: string; url: string; body: string; headers: Record<string, string> }>;
}

// A fake container that records the full header set + body of every request, so
// the auth-gate + sigv4 tests can assert exactly what reached the warm container.
function startRecordingContainer(): Promise<RecordingContainer> {
  const requests: RecordingContainer['requests'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        headers: req.headers as Record<string, string>,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port, requests })
    )
  );
}

describe('startAgentCoreHttpServer (per-request inbound auth + sigv4, issue #454)', () => {
  let fake: RecordingContainer | undefined;
  let serve: RunningAgentCoreHttpServer | undefined;

  afterEach(async () => {
    if (serve) await serve.close().catch(() => undefined);
    if (fake) await new Promise<void>((res) => fake!.server.close(() => res()));
    serve = undefined;
    fake = undefined;
  });

  async function boot(
    extra: Partial<Parameters<typeof startAgentCoreHttpServer>[0]>
  ): Promise<RunningAgentCoreHttpServer> {
    fake = await startRecordingContainer();
    serve = await startAgentCoreHttpServer({
      containerHost: '127.0.0.1',
      containerPort: fake.port,
      host: '127.0.0.1',
      ...extra,
    });
    return serve;
  }

  it('returns the authCheck deny status (401) and does NOT forward to the container', async () => {
    const s = await boot({
      authCheck: async () => ({ allow: false, status: 401, message: 'missing token' }),
    });
    const r = await httpReq(
      { host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' },
      '{}'
    );
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error).toBe('missing token');
    expect(fake!.requests).toHaveLength(0);
  });

  it('returns 403 when the authCheck rejects the token', async () => {
    const s = await boot({
      authCheck: async () => ({ allow: false, status: 403, message: 'invalid token' }),
    });
    const r = await httpReq(
      { host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' },
      '{}'
    );
    expect(r.status).toBe(403);
    expect(fake!.requests).toHaveLength(0);
  });

  it('forwards the authCheck-returned Authorization when it allows', async () => {
    const s = await boot({
      authorization: 'Bearer boot-default',
      authCheck: async () => ({ allow: true, authorization: 'Bearer verified-per-request' }),
    });
    const r = await httpReq(
      { host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' },
      '{"turn":1}'
    );
    expect(r.status).toBe(200);
    // The per-request verified Authorization wins over the static boot default.
    expect(fake!.requests[0]?.headers['authorization']).toBe('Bearer verified-per-request');
    expect(fake!.requests[0]?.body).toBe('{"turn":1}');
  });

  it('does NOT gate GET /ping even when authCheck is set (health is unauthenticated)', async () => {
    let pingChecked = false;
    const s = await boot({
      authCheck: async () => {
        pingChecked = true;
        return { allow: false, status: 401 };
      },
    });
    const r = await httpReq({ host: '127.0.0.1', port: s.port, path: '/ping', method: 'GET' });
    expect(r.status).toBe(200);
    expect(pingChecked).toBe(false);
    expect(fake!.requests.map((q) => q.url)).toEqual(['/ping']);
  });

  it('buffers + signs the POST body and injects the signed headers when signRequest is set', async () => {
    let signed: { method: string; path: string; body: string; sessionId: string } | undefined;
    const s = await boot({
      signRequest: async ({ method, path, body, sessionId }) => {
        signed = { method, path, body: body.toString('utf-8'), sessionId };
        return {
          Authorization: 'AWS4-HMAC-SHA256 Credential=AKIA.../bedrock-agentcore',
          'X-Amz-Date': '20260101T000000Z',
          'X-Amz-Content-Sha256': 'abc123',
        };
      },
    });
    const r = await httpReq(
      { host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' },
      '{"q":"hi"}'
    );
    expect(r.status).toBe(200);
    // signRequest saw the full buffered body + the same session id the proxy
    // forwarded, on the contract path.
    expect(signed?.body).toBe('{"q":"hi"}');
    expect(signed?.path).toBe('/invocations');
    expect(signed?.sessionId).toBeTruthy();
    // The container received the signed headers + the body + the same session id.
    const got = fake!.requests[0];
    expect(got?.headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIA.../bedrock-agentcore'
    );
    expect(got?.headers['x-amz-date']).toBe('20260101T000000Z');
    expect(got?.headers['x-amz-content-sha256']).toBe('abc123');
    expect(got?.body).toBe('{"q":"hi"}');
    expect(got?.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(signed?.sessionId);
  });

  it('returns 500 (no crash) when signRequest throws', async () => {
    const s = await boot({
      signRequest: async () => {
        throw new Error('no creds');
      },
    });
    const r = await httpReq(
      { host: '127.0.0.1', port: s.port, path: '/invocations', method: 'POST' },
      '{}'
    );
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body).error).toMatch(/sigv4 signing failed: no creds/);
    expect(fake!.requests).toHaveLength(0);
  });
});

describe('startAgentCoreHttpServer (MCP / A2A routing)', () => {
  let fake: ProtocolFake | undefined;
  let serve: RunningAgentCoreHttpServer | undefined;

  afterEach(async () => {
    if (serve) await serve.close().catch(() => undefined);
    if (fake) await new Promise<void>((res) => fake!.server.close(() => res()));
    serve = undefined;
    fake = undefined;
  });

  it('forwards POST /mcp to the warm container (no /ws), repeated POSTs hit the SAME one', async () => {
    fake = await startProtocolFake();
    serve = await startAgentCoreHttpServer({
      containerHost: '127.0.0.1',
      containerPort: fake.port,
      host: '127.0.0.1',
      routes: [{ method: 'POST', path: '/mcp' }],
      attachWs: false,
    });
    const r1 = await httpReq(
      { host: '127.0.0.1', port: serve.port, path: '/mcp', method: 'POST' },
      '{"method":"tools/list"}'
    );
    const r2 = await httpReq(
      { host: '127.0.0.1', port: serve.port, path: '/mcp', method: 'POST' },
      '{"method":"tools/list"}'
    );
    expect(r1.status).toBe(200);
    expect(JSON.parse(r1.body).result.path).toBe('/mcp');
    expect(JSON.parse(r1.body).result.count).toBe(1);
    expect(JSON.parse(r2.body).result.count).toBe(2); // warm reuse
    expect(fake.requests.every((q) => q.path === '/mcp' && q.method === 'POST')).toBe(true);
    // MCP has no /ws.
    expect(serve.wsUrl).toBeUndefined();
    expect(serve.httpUrl).toBe(`http://127.0.0.1:${serve.port}`);
  });

  it('forwards POST / to the warm container for A2A (no /ws) and injects the session-id', async () => {
    fake = await startProtocolFake();
    serve = await startAgentCoreHttpServer({
      containerHost: '127.0.0.1',
      containerPort: fake.port,
      host: '127.0.0.1',
      routes: [{ method: 'POST', path: '/' }],
      attachWs: false,
    });
    const r = await httpReq(
      { host: '127.0.0.1', port: serve.port, path: '/', method: 'POST' },
      '{"method":"agent/getCard"}'
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).result.path).toBe('/');
    expect(fake.requests[0]?.sessionId).toBeTruthy();
    expect(serve.wsUrl).toBeUndefined();
  });

  it('404s a non-served path with a hint naming only the served route (no /ws pointer)', async () => {
    fake = await startProtocolFake();
    serve = await startAgentCoreHttpServer({
      containerHost: '127.0.0.1',
      containerPort: fake.port,
      host: '127.0.0.1',
      routes: [{ method: 'POST', path: '/mcp' }],
      attachWs: false,
    });
    const r = await httpReq({ host: '127.0.0.1', port: serve.port, path: '/ping', method: 'GET' });
    expect(r.status).toBe(404);
    const hint = JSON.parse(r.body).hint;
    expect(hint).toBe('POST /mcp');
    expect(hint).not.toMatch(/WebSocket/);
  });
});
