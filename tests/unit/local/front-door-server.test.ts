import { describe, it, expect, afterEach } from 'vite-plus/test';
import { createServer, get, type IncomingMessage, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FrontDoorEndpointPool } from '../../../src/local/front-door-pool.js';
import {
  startFrontDoorServer,
  type StartedFrontDoorServer,
} from '../../../src/local/front-door-server.js';
import { matchAlbPathRule, type AlbPathRule } from '../../../src/local/alb-path-matcher.js';

interface Upstream {
  server: Server;
  port: number;
  /** Captured `x-forwarded-*` headers from the most recent request. */
  lastHeaders?: IncomingMessage['headers'];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startUpstream(id: string): Promise<Upstream> {
  const up: Upstream = { server: undefined as unknown as Server, port: 0 };
  const server = createServer((req, res) => {
    up.lastHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(id);
  });
  up.server = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  up.port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return up;
}

async function startFront(
  pool: FrontDoorEndpointPool,
  upstreamTimeoutMs?: number
): Promise<StartedFrontDoorServer> {
  return startFrontWith(() => pool, upstreamTimeoutMs);
}

async function startFrontWith(
  selectPool: (requestPath: string) => FrontDoorEndpointPool | undefined,
  upstreamTimeoutMs?: number
): Promise<StartedFrontDoorServer> {
  const front = await startFrontDoorServer({
    selectPool,
    port: 0,
    host: '127.0.0.1',
    listenerPort: 80,
    label: 'listener port 80',
    ...(upstreamTimeoutMs !== undefined && { upstreamTimeoutMs }),
  });
  cleanups.push(() => front.close());
  return front;
}

/** An upstream that accepts the connection but never responds (a hung replica). */
async function startHungUpstream(): Promise<Upstream> {
  const up: Upstream = { server: undefined as unknown as Server, port: 0 };
  const server = createServer(() => {
    /* deliberately never responds */
  });
  up.server = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  up.port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return up;
}

function fetchText(
  port: number,
  path = '/',
  host = '127.0.0.1'
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host, port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('startFrontDoorServer', () => {
  it('round-robins requests across the live replica pool', async () => {
    const a = await startUpstream('replica-A');
    const b = await startUpstream('replica-B');
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: a.port });
    pool.register('svc:r1', { host: '127.0.0.1', port: b.port });
    const front = await startFront(pool);

    const bodies = [
      (await fetchText(front.port)).body,
      (await fetchText(front.port)).body,
      (await fetchText(front.port)).body,
      (await fetchText(front.port)).body,
    ];
    expect(bodies).toEqual(['replica-A', 'replica-B', 'replica-A', 'replica-B']);
  });

  it('injects ALB-style X-Forwarded-* headers', async () => {
    const a = await startUpstream('replica-A');
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: a.port });
    const front = await startFront(pool);

    await fetchText(front.port);
    expect(a.lastHeaders?.['x-forwarded-proto']).toBe('http');
    expect(a.lastHeaders?.['x-forwarded-port']).toBe('80');
    expect(a.lastHeaders?.['x-forwarded-for']).toBeTruthy();
  });

  it('returns 503 when the pool has no live replica', async () => {
    const pool = new FrontDoorEndpointPool();
    const front = await startFront(pool);
    const res = await fetchText(front.port);
    expect(res.status).toBe(503);
    expect(res.body).toMatch(/No running replicas/);
  });

  it('returns 502 when the chosen upstream is unreachable', async () => {
    // Start + immediately stop an upstream to get a port nothing listens on.
    const dead = await startUpstream('dead');
    await new Promise<void>((r) => dead.server.close(() => r()));
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: dead.port });
    const front = await startFront(pool);

    const res = await fetchText(front.port);
    expect(res.status).toBe(502);
  });

  it('returns 504 when the upstream accepts but never responds (no infinite hang)', async () => {
    const hung = await startHungUpstream();
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: hung.port });
    const front = await startFront(pool, 150); // short upstream timeout for the test

    const res = await fetchText(front.port);
    expect(res.status).toBe(504);
  });

  it('path-routes each request to the pool selectPool returns', async () => {
    const web = await startUpstream('web');
    const api = await startUpstream('api');
    const webPool = new FrontDoorEndpointPool();
    webPool.register('web:r0', { host: '127.0.0.1', port: web.port });
    const apiPool = new FrontDoorEndpointPool();
    apiPool.register('api:r0', { host: '127.0.0.1', port: api.port });
    // `/api/*` -> apiPool, everything else -> webPool (the default).
    const front = await startFrontWith((path) =>
      path.startsWith('/api/') ? apiPool : webPool
    );

    expect((await fetchText(front.port, '/')).body).toBe('web');
    expect((await fetchText(front.port, '/index.html')).body).toBe('web');
    expect((await fetchText(front.port, '/api/users')).body).toBe('api');
  });

  it('returns 404 when selectPool finds no matching rule and no default', async () => {
    const front = await startFrontWith(() => undefined);
    const res = await fetchText(front.port, '/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatch(/No listener rule matched/);
  });

  it('routes through the real matchAlbPathRule honoring rule priority (no default -> 404)', async () => {
    const admin = await startUpstream('admin');
    const api = await startUpstream('api');
    const adminPool = new FrontDoorEndpointPool();
    adminPool.register('admin:r0', { host: '127.0.0.1', port: admin.port });
    const apiPool = new FrontDoorEndpointPool();
    apiPool.register('api:r0', { host: '127.0.0.1', port: api.port });
    // /api/admin/* (priority 10) must win over /api/* (priority 20) for an
    // overlapping path — the exact integration the matcher guarantees.
    const rules: AlbPathRule<FrontDoorEndpointPool>[] = [
      { priority: 20, pathPatterns: ['/api/*'], target: apiPool },
      { priority: 10, pathPatterns: ['/api/admin/*'], target: adminPool },
    ];
    const front = await startFrontWith((path) => matchAlbPathRule(path, rules));

    expect((await fetchText(front.port, '/api/admin/users')).body).toBe('admin');
    expect((await fetchText(front.port, '/api/orders')).body).toBe('api');
    expect((await fetchText(front.port, '/')).status).toBe(404); // no default action
  });

  it('strips hop-by-hop request headers, including those named in Connection', async () => {
    const up = await startUpstream('up');
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: up.port });
    const front = await startFront(pool);

    // `Connection: x-hop` marks `x-hop` itself as hop-by-hop -> both must be
    // dropped before forwarding; an ordinary header passes through. (Node
    // re-adds its own `Connection` for the upstream hop, so we don't assert on
    // `connection` directly — we assert the token-listed header is gone.)
    await new Promise<void>((resolve, reject) => {
      const req = get(
        {
          host: '127.0.0.1',
          port: front.port,
          path: '/',
          headers: { connection: 'x-hop', 'x-hop': 'secret', 'x-keep': 'kept' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
    });
    expect(up.lastHeaders?.['x-hop']).toBeUndefined();
    expect(up.lastHeaders?.['x-keep']).toBe('kept');
  });

  it('strips hop-by-hop headers from the upstream response', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        // `proxy-authenticate` is hop-by-hop and is neither added nor stripped
        // by Node's own server machinery (unlike `connection` / `keep-alive`),
        // so it is a clean signal that the proxy removed it.
        'proxy-authenticate': 'Basic',
        'x-app': 'kept',
        'content-type': 'text/plain',
      });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const upPort = (server.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upPort });
    const front = await startFront(pool);

    const headers = await new Promise<IncomingMessage['headers']>((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port: front.port, path: '/' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers));
      });
      req.on('error', reject);
    });
    expect(headers['proxy-authenticate']).toBeUndefined();
    expect(headers['x-app']).toBe('kept'); // non-hop-by-hop headers pass through
  });
});
