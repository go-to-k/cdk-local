import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vite-plus/test';
import { createServer, get, request, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { FrontDoorEndpointPool } from '../../../src/local/front-door-pool.js';
import {
  startFrontDoorServer,
  buildRedirectLocation,
  pickWeightedPool,
  type StartedFrontDoorServer,
  type RouteAction,
  type RedirectRouteAction,
} from '../../../src/local/front-door-server.js';
import { matchAlbPathRule, type AlbPathRule } from '../../../src/local/alb-path-matcher.js';
import {
  resolveFrontDoorTlsMaterials,
  type FrontDoorTlsMaterials,
} from '../../../src/local/front-door-tls.js';

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

/** Wrap a single pool into a constant forward route (the default-action case). */
function forward(pool: FrontDoorEndpointPool): RouteAction {
  return { kind: 'forward', pools: [{ pool, weight: 1 }] };
}

async function startFront(
  pool: FrontDoorEndpointPool,
  upstreamTimeoutMs?: number
): Promise<StartedFrontDoorServer> {
  return startFrontWith(() => forward(pool), upstreamTimeoutMs);
}

async function startFrontWith(
  route: (req: {
    path: string;
    host?: string;
    headers?: NodeJS.Dict<string | string[]>;
    method?: string;
    sourceIp?: string;
  }) => RouteAction | undefined,
  upstreamTimeoutMs?: number
): Promise<StartedFrontDoorServer> {
  const front = await startFrontDoorServer({
    route,
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

/** Like `fetchText` but sends an explicit `Host` header (for host-header rule tests). */
function fetchTextWithHost(
  port: number,
  path: string,
  hostHeader: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, headers: { host: hostHeader } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

/** Issue a request and capture the status + `Location` header (for redirect tests). */
function fetchHead(
  port: number,
  path: string,
  hostHeader: string
): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: hostHeader } },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(typeof res.headers.location === 'string' && { location: res.headers.location }),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
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

  it('path-routes each request to the action route() returns', async () => {
    const web = await startUpstream('web');
    const api = await startUpstream('api');
    const webPool = new FrontDoorEndpointPool();
    webPool.register('web:r0', { host: '127.0.0.1', port: web.port });
    const apiPool = new FrontDoorEndpointPool();
    apiPool.register('api:r0', { host: '127.0.0.1', port: api.port });
    // `/api/*` -> apiPool, everything else -> webPool (the default).
    const front = await startFrontWith(({ path }) =>
      path.startsWith('/api/') ? forward(apiPool) : forward(webPool)
    );

    expect((await fetchText(front.port, '/')).body).toBe('web');
    expect((await fetchText(front.port, '/index.html')).body).toBe('web');
    expect((await fetchText(front.port, '/api/users')).body).toBe('api');
  });

  it('returns 404 when route() finds no matching rule and no default', async () => {
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
    const rules: AlbPathRule<RouteAction>[] = [
      { priority: 20, pathPatterns: ['/api/*'], target: forward(apiPool) },
      { priority: 10, pathPatterns: ['/api/admin/*'], target: forward(adminPool) },
    ];
    const front = await startFrontWith((req) => matchAlbPathRule(req, rules));

    expect((await fetchText(front.port, '/api/admin/users')).body).toBe('admin');
    expect((await fetchText(front.port, '/api/orders')).body).toBe('api');
    expect((await fetchText(front.port, '/')).status).toBe(404); // no default action
  });

  it('host-routes through the real matchAlbPathRule (Host header -> the matching pool)', async () => {
    const apiHost = await startUpstream('api-host');
    const webHost = await startUpstream('web-host');
    const apiPool = new FrontDoorEndpointPool();
    apiPool.register('api:r0', { host: '127.0.0.1', port: apiHost.port });
    const webPool = new FrontDoorEndpointPool();
    webPool.register('web:r0', { host: '127.0.0.1', port: webHost.port });
    // host-header api.example.com -> apiPool; default -> webPool.
    const rules: AlbPathRule<RouteAction>[] = [
      { priority: 10, pathPatterns: [], hostPatterns: ['api.example.com'], target: forward(apiPool) },
    ];
    const front = await startFrontWith((req) => matchAlbPathRule(req, rules) ?? forward(webPool));

    expect((await fetchTextWithHost(front.port, '/', 'api.example.com')).body).toBe('api-host');
    // The case-insensitive host comparison still matches.
    expect((await fetchTextWithHost(front.port, '/', 'API.EXAMPLE.COM')).body).toBe('api-host');
    expect((await fetchTextWithHost(front.port, '/', 'other.example.com')).body).toBe('web-host');
  });

  it('threads method / headers / sourceIp into the route() callback (binding)', async () => {
    const upstream = await startUpstream('match');
    const pool = new FrontDoorEndpointPool();
    pool.register('r0', { host: '127.0.0.1', port: upstream.port });

    const seenReqs: Array<{
      path: string;
      host?: string;
      method?: string;
      sourceIp?: string;
      hasHeaders: boolean;
    }> = [];
    const front = await startFrontWith((req) => {
      seenReqs.push({
        path: req.path,
        ...(req.host !== undefined && { host: req.host }),
        ...(req.method !== undefined && { method: req.method }),
        ...(req.sourceIp !== undefined && { sourceIp: req.sourceIp }),
        hasHeaders: Object.keys(req.headers ?? {}).length > 0,
      });
      return forward(pool);
    });

    await fetchText(front.port, '/probe');
    expect(seenReqs).toHaveLength(1);
    const seen = seenReqs[0]!;
    expect(seen.path).toBe('/probe');
    expect(seen.method).toBe('GET');
    expect(seen.hasHeaders).toBe(true);
    expect(seen.sourceIp).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
  });

  it('synthesizes a fixed-response action without an upstream', async () => {
    const front = await startFrontWith(() => ({
      kind: 'fixed-response',
      statusCode: 410,
      contentType: 'application/json',
      messageBody: '{"gone":true}',
    }));
    const res = await fetchText(front.port, '/gone/x');
    expect(res.status).toBe(410);
    expect(res.body).toBe('{"gone":true}');
  });

  it('synthesizes a 301 redirect with a Location built from the request', async () => {
    const action: RedirectRouteAction = {
      kind: 'redirect',
      statusCode: 301,
      protocol: 'HTTPS',
      host: 'new.example.com',
      port: '443',
      path: '/#{path}',
      query: '#{query}',
    };
    const front = await startFrontWith(() => action);
    const res = await fetchHead(front.port, '/old/page?x=1', 'orig.example.com');
    expect(res.status).toBe(301);
    expect(res.location).toBe('https://new.example.com/old/page?x=1');
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

  it('distributes a weighted forward across pools roughly by weight', async () => {
    const heavy = await startUpstream('heavy');
    const light = await startUpstream('light');
    const heavyPool = new FrontDoorEndpointPool();
    heavyPool.register('heavy:r0', { host: '127.0.0.1', port: heavy.port });
    const lightPool = new FrontDoorEndpointPool();
    lightPool.register('light:r0', { host: '127.0.0.1', port: light.port });
    const action: RouteAction = {
      kind: 'forward',
      pools: [
        { pool: heavyPool, weight: 90 },
        { pool: lightPool, weight: 10 },
      ],
    };
    const front = await startFrontWith(() => action);

    const counts: Record<string, number> = { heavy: 0, light: 0 };
    for (let i = 0; i < 200; i++) {
      const body = (await fetchText(front.port)).body;
      counts[body] = (counts[body] ?? 0) + 1;
    }
    // 90/10 split: the heavy pool should dominate by a wide margin. The bound is
    // loose enough to be robust to the random sample but still proves weighting.
    expect(counts['heavy']!).toBeGreaterThan(counts['light']!);
    expect(counts['heavy']!).toBeGreaterThan(120);
    expect(counts['light']!).toBeGreaterThan(0); // weight 10 is still occasionally hit
  });

  it('never routes to a weight-0 pool in a weighted forward', async () => {
    const live = await startUpstream('live');
    const livePool = new FrontDoorEndpointPool();
    livePool.register('live:r0', { host: '127.0.0.1', port: live.port });
    const zeroPool = new FrontDoorEndpointPool();
    zeroPool.register('zero:r0', { host: '127.0.0.1', port: live.port }); // would also answer
    const action: RouteAction = {
      kind: 'forward',
      pools: [
        { pool: livePool, weight: 100 },
        { pool: zeroPool, weight: 0 },
      ],
    };
    const front = await startFrontWith(() => action);
    for (let i = 0; i < 20; i++) {
      expect((await fetchText(front.port)).body).toBe('live');
    }
  });

  it('returns 502 when every weighted forward pool has weight 0', async () => {
    const dead = new FrontDoorEndpointPool();
    const action: RouteAction = { kind: 'forward', pools: [{ pool: dead, weight: 0 }] };
    const front = await startFrontWith(() => action);
    const res = await fetchText(front.port);
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/weight 0/);
  });
});

describe('pickWeightedPool', () => {
  const a = new FrontDoorEndpointPool();
  const b = new FrontDoorEndpointPool();

  it('returns the single pool when its weight is positive', () => {
    expect(pickWeightedPool([{ pool: a, weight: 1 }])).toBe(a);
  });

  it('returns undefined for an empty set or all-zero weights', () => {
    expect(pickWeightedPool([])).toBeUndefined();
    expect(pickWeightedPool([{ pool: a, weight: 0 }])).toBeUndefined();
    expect(
      pickWeightedPool([
        { pool: a, weight: 0 },
        { pool: b, weight: 0 },
      ])
    ).toBeUndefined();
  });

  it('skips weight-0 members and only ever returns a positive-weight pool', () => {
    for (let i = 0; i < 50; i++) {
      expect(
        pickWeightedPool([
          { pool: a, weight: 0 },
          { pool: b, weight: 5 },
        ])
      ).toBe(b);
    }
  });
});

describe('buildRedirectLocation', () => {
  const req = (url: string, host = 'orig.example.com'): { url: string; headers: { host: string } } => ({
    url,
    headers: { host },
  });

  it('fills #{path} / #{query} from the request and omits a default port', () => {
    const action: RedirectRouteAction = {
      kind: 'redirect',
      statusCode: 301,
      protocol: 'HTTPS',
      host: 'new.example.com',
      port: '443',
      path: '/#{path}',
      query: '#{query}',
    };
    expect(buildRedirectLocation(action, req('/old/page?a=1&b=2'), 80)).toBe(
      'https://new.example.com/old/page?a=1&b=2'
    );
    expect(buildRedirectLocation(action, req('/old/page'), 80)).toBe(
      'https://new.example.com/old/page'
    );
  });

  it('defaults to the request host/path/query and the listener port when unset', () => {
    // A bare redirect to HTTPS keeps host + path; the listener port 80 is the
    // default for http, so a same-scheme redirect would carry it, but here the
    // protocol is unset (defaults to http) and port 8080 is non-default -> kept.
    const action: RedirectRouteAction = { kind: 'redirect', statusCode: 302 };
    expect(buildRedirectLocation(action, req('/a/b?x=1'), 8080)).toBe(
      'http://orig.example.com:8080/a/b?x=1'
    );
  });

  it('keeps a non-default explicit port and honors a literal host/path', () => {
    const action: RedirectRouteAction = {
      kind: 'redirect',
      statusCode: 302,
      protocol: 'HTTPS',
      host: 'cdn.example.com',
      port: '8443',
      path: '/static/index.html',
      query: '',
    };
    expect(buildRedirectLocation(action, req('/whatever?drop=me'), 80)).toBe(
      'https://cdn.example.com:8443/static/index.html'
    );
  });
});

import { request as httpRequest } from 'node:http';
import type { FrontDoorDispatchTarget } from '../../../src/local/front-door-server.js';

/** POST a request and capture status / headers / body. */
function postRequest(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function startFrontTarget(
  selectTarget: (requestPath: string) => FrontDoorDispatchTarget | undefined
): Promise<StartedFrontDoorServer> {
  const front = await startFrontDoorServer({
    selectTarget,
    port: 0,
    host: '127.0.0.1',
    listenerPort: 80,
    label: 'listener port 80',
  });
  cleanups.push(() => front.close());
  return front;
}

describe('startFrontDoorServer — Lambda dispatch (#123)', () => {
  it('translates the request -> ALB event, invokes the Lambda, and writes the response', async () => {
    let capturedEvent: Record<string, unknown> | undefined;
    const front = await startFrontTarget(() => ({
      kind: 'lambda',
      lambda: {
        targetGroupArn: 'tg-arn',
        multiValueHeaders: false,
        label: 'EchoFn',
        invoke: async (event) => {
          capturedEvent = event;
          return {
            statusCode: 201,
            statusDescription: '201 Created',
            headers: { 'content-type': 'application/json', 'x-echo': 'yes' },
            body: '{"ok":true}',
          };
        },
      },
    }));

    const res = await postRequest(front.port, '/items?a=1', '{"hello":"world"}', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['x-echo']).toBe('yes');
    expect(res.body).toBe('{"ok":true}');

    // The event the handler saw is the ALB Lambda-target shape.
    expect(capturedEvent!['requestContext']).toEqual({ elb: { targetGroupArn: 'tg-arn' } });
    expect(capturedEvent!['httpMethod']).toBe('POST');
    expect(capturedEvent!['path']).toBe('/items');
    expect(capturedEvent!['queryStringParameters']).toEqual({ a: '1' });
    expect(capturedEvent!['body']).toBe('{"hello":"world"}');
    // ALB stamps x-forwarded-* onto the event headers.
    const evHeaders = capturedEvent!['headers'] as Record<string, string>;
    expect(evHeaders['x-forwarded-proto']).toBe('http');
    expect(evHeaders['x-forwarded-port']).toBe('80');
  });

  it('returns 502 when the Lambda returns a malformed response', async () => {
    const front = await startFrontTarget(() => ({
      kind: 'lambda',
      lambda: {
        targetGroupArn: 'tg-arn',
        multiValueHeaders: false,
        label: 'BadFn',
        invoke: async () => ({ body: 'no statusCode' }),
      },
    }));
    const res = await postRequest(front.port, '/', '');
    expect(res.status).toBe(502);
  });

  it('returns 502 when the Lambda invoke throws', async () => {
    const front = await startFrontTarget(() => ({
      kind: 'lambda',
      lambda: {
        targetGroupArn: 'tg-arn',
        multiValueHeaders: false,
        label: 'ThrowFn',
        invoke: async () => {
          throw new Error('container gone');
        },
      },
    }));
    const res = await postRequest(front.port, '/', '');
    expect(res.status).toBe(502);
  });

  it('emits multiple Set-cookie lines from a multiValueHeaders response', async () => {
    const front = await startFrontTarget(() => ({
      kind: 'lambda',
      lambda: {
        targetGroupArn: 'tg-arn',
        multiValueHeaders: true,
        label: 'CookieFn',
        invoke: async () => ({
          statusCode: 200,
          multiValueHeaders: { 'set-cookie': ['a=1', 'b=2'] },
          body: 'ok',
        }),
      },
    }));
    const res = await postRequest(front.port, '/', '');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
  });

  it('returns 404 when selectTarget yields nothing (rule miss, no default)', async () => {
    const front = await startFrontTarget(() => undefined);
    const res = await postRequest(front.port, '/nope', '');
    expect(res.status).toBe(404);
  });

  it('stamps X-Forwarded-Proto from forwardedProto on the ALB Lambda event (#198 degraded HTTPS)', async () => {
    // Companion to the pool / redirect / WS tests below: when a cloud-HTTPS
    // listener serves over plain HTTP locally (`forwardedProto: 'https'` set
    // without `tls`), the synthesized ALB Lambda event MUST carry
    // `x-forwarded-proto: https` so handler logic that inspects it (Secure
    // cookie flag, OAuth callback URL synthesis) still sees the deployed
    // listener protocol.
    let capturedEvent: Record<string, unknown> | undefined;
    const front = await startFrontDoorServer({
      selectTarget: () => ({
        kind: 'lambda',
        lambda: {
          targetGroupArn: 'tg',
          multiValueHeaders: false,
          label: 'EchoFn',
          invoke: async (event) => {
            capturedEvent = event;
            return { statusCode: 200 };
          },
        },
      }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 443,
      label: 'listener port 443',
      forwardedProto: 'https',
    });
    cleanups.push(() => front.close());

    await postRequest(front.port, '/', '');
    const headers = capturedEvent!['headers'] as Record<string, string>;
    expect(headers['x-forwarded-proto']).toBe('https');
    expect(headers['x-forwarded-port']).toBe('443');
  });
});

describe('startFrontDoorServer — weighted forward mixing ECS + Lambda (#123)', () => {
  it('dispatches an ECS pool target or a Lambda target by weight via route()', async () => {
    const ecs = await startUpstream('ecs-replica');
    const ecsPool = new FrontDoorEndpointPool();
    ecsPool.register('ecs:r0', { host: '127.0.0.1', port: ecs.port });
    let lambdaHits = 0;
    // A weighted forward whose targets are an ECS pool AND a Lambda invoker;
    // both have positive weight, so over many requests both are exercised.
    const action: RouteAction = {
      kind: 'forward',
      pools: [
        { pool: ecsPool, weight: 50 },
        {
          lambda: {
            targetGroupArn: 'tg-arn',
            multiValueHeaders: false,
            label: 'MixFn',
            invoke: async () => {
              lambdaHits += 1;
              return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'lambda' };
            },
          },
          weight: 50,
        },
      ],
    };
    const front = await startFrontWith(() => action);

    const counts: Record<string, number> = { 'ecs-replica': 0, lambda: 0 };
    for (let i = 0; i < 60; i++) {
      const body = (await fetchText(front.port)).body;
      counts[body] = (counts[body] ?? 0) + 1;
    }
    // Both backends answered (a 50/50 split makes a zero on either side
    // astronomically unlikely), proving ECS-pool and Lambda dispatch coexist in
    // one weighted forward.
    expect(counts['ecs-replica']!).toBeGreaterThan(0);
    expect(counts['lambda']!).toBeGreaterThan(0);
    expect(counts['ecs-replica']! + counts['lambda']!).toBe(60);
    expect(lambdaHits).toBe(counts['lambda']);
  });

  it('never routes to a weight-0 Lambda target in a mixed weighted forward', async () => {
    const ecs = await startUpstream('ecs-only');
    const ecsPool = new FrontDoorEndpointPool();
    ecsPool.register('ecs:r0', { host: '127.0.0.1', port: ecs.port });
    let lambdaHits = 0;
    const action: RouteAction = {
      kind: 'forward',
      pools: [
        { pool: ecsPool, weight: 100 },
        {
          lambda: {
            targetGroupArn: 'tg-arn',
            multiValueHeaders: false,
            label: 'ZeroFn',
            invoke: async () => {
              lambdaHits += 1;
              return { statusCode: 200, body: 'lambda' };
            },
          },
          weight: 0,
        },
      ],
    };
    const front = await startFrontWith(() => action);
    for (let i = 0; i < 20; i++) {
      expect((await fetchText(front.port)).body).toBe('ecs-only');
    }
    expect(lambdaHits).toBe(0);
  });
});

describe('startFrontDoorServer — HTTPS termination', () => {
  let tls: FrontDoorTlsMaterials;
  let tlsCacheDir: string;

  beforeAll(async () => {
    tlsCacheDir = mkdtempSync(join(tmpdir(), 'cdkl-front-door-tls-'));
    tls = await resolveFrontDoorTlsMaterials({
      certPath: undefined,
      keyPath: undefined,
      cacheDir: tlsCacheDir,
    });
  });

  afterAll(() => {
    rmSync(tlsCacheDir, { recursive: true, force: true });
  });

  function fetchHttpsText(port: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/',
          method: 'GET',
          rejectUnauthorized: false, // self-signed cert
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('binds an HTTPS server when tls materials are supplied (scheme=https)', async () => {
    const upstream = await startUpstream('https-upstream');
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstream.port });
    const front = await startFrontDoorServer({
      route: () => forward(pool),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 443,
      label: 'listener port 443',
      tls,
    });
    cleanups.push(() => front.close());

    expect(front.scheme).toBe('https');
    const res = await fetchHttpsText(front.port);
    expect(res.status).toBe(200);
    expect(res.body).toBe('https-upstream');
  });

  it('stamps X-Forwarded-Proto: https on the upstream request when tls is set', async () => {
    const upstream = await startUpstream('xfwd-proto');
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstream.port });
    const front = await startFrontDoorServer({
      route: () => forward(pool),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 443,
      label: 'listener port 443',
      tls,
    });
    cleanups.push(() => front.close());

    await fetchHttpsText(front.port);
    expect(upstream.lastHeaders?.['x-forwarded-proto']).toBe('https');
    expect(upstream.lastHeaders?.['x-forwarded-port']).toBe('443');
  });

  it('defaults a redirect action `#{protocol}` to https when the listener is HTTPS', async () => {
    const action: RedirectRouteAction = {
      kind: 'redirect',
      statusCode: 301,
      // `#{protocol}` left to default — must resolve to `https` for an HTTPS listener.
      host: 'new.example.com',
    };
    const front = await startFrontDoorServer({
      route: () => action,
      port: 0,
      host: '127.0.0.1',
      listenerPort: 443,
      label: 'listener port 443',
      tls,
    });
    cleanups.push(() => front.close());

    const result = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: front.port,
          path: '/',
          method: 'GET',
          headers: { host: 'old.example.com' },
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              ...(typeof res.headers.location === 'string' && { location: res.headers.location }),
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(result.status).toBe(301);
    expect(result.location).toMatch(/^https:\/\/new\.example\.com\//);
  });

  it('falls back to HTTP (scheme=http) and X-Forwarded-Proto: http when tls is omitted', async () => {
    // Regression for the boolean toggle: an HTTP listener side by side with the
    // HTTPS one must still stamp `http`.
    const upstream = await startUpstream('plain-http');
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstream.port });
    const front = await startFrontDoorServer({
      route: () => forward(pool),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
    });
    cleanups.push(() => front.close());

    expect(front.scheme).toBe('http');
    await fetchText(front.port);
    expect(upstream.lastHeaders?.['x-forwarded-proto']).toBe('http');
  });

  it('honors an explicit forwardedProto=https override over a plain-HTTP wire', async () => {
    // Cloud-HTTPS-but-local-HTTP degradation (#198): the wire is HTTP (no
    // tls materials), but `forwardedProto: 'https'` lets the caller preserve
    // the deployed listener protocol on `X-Forwarded-Proto`, so the upstream
    // app still observes `https` and a redirect's `#{protocol}` resolves to
    // `https` by default.
    const upstream = await startUpstream('degraded-https');
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstream.port });
    const front = await startFrontDoorServer({
      route: () => forward(pool),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 443,
      label: 'listener port 443',
      forwardedProto: 'https',
    });
    cleanups.push(() => front.close());

    expect(front.scheme).toBe('http');
    await fetchText(front.port);
    expect(upstream.lastHeaders?.['x-forwarded-proto']).toBe('https');
    expect(upstream.lastHeaders?.['x-forwarded-port']).toBe('443');
  });

  it('defaults a redirect `#{protocol}` to forwardedProto on a degraded HTTPS listener', async () => {
    // Companion to the wire-vs-forwarded test above: redirect synthesis must
    // also follow `forwardedProto`, not the wire scheme, so an HTTPS-in-cloud
    // listener served over plain HTTP still emits `https://...` Location.
    const action: RedirectRouteAction = {
      kind: 'redirect',
      statusCode: 301,
      host: 'new.example.com',
    };
    const front = await startFrontDoorServer({
      route: () => action,
      port: 0,
      host: '127.0.0.1',
      listenerPort: 443,
      label: 'listener port 443',
      forwardedProto: 'https',
    });
    cleanups.push(() => front.close());

    const result = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const req = get(
        {
          host: '127.0.0.1',
          port: front.port,
          path: '/',
          headers: { host: 'old.example.com' },
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              ...(typeof res.headers.location === 'string' && { location: res.headers.location }),
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(result.status).toBe(301);
    expect(result.location).toMatch(/^https:\/\/new\.example\.com\//);
  });
});

describe('startFrontDoorServer — auth gate', () => {
  /** Fetch a path and capture status + the `WWW-Authenticate` header. */
  function fetchWithAuth(
    port: number,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: string; wwwAuth?: string }> {
    return new Promise((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            ...(typeof res.headers['www-authenticate'] === 'string' && {
              wwwAuth: res.headers['www-authenticate'],
            }),
          })
        );
      });
      req.on('error', reject);
    });
  }

  it('answers 401 with WWW-Authenticate when the auth check denies', async () => {
    const upstream = await startUpstream('protected');
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstream.port });
    const front = await startFrontDoorServer({
      route: () => ({
        kind: 'forward',
        pools: [{ pool, weight: 1 }],
        auth: {
          realm: 'authenticate-cognito (UserPool=us-east-1_abcDEF)',
          check: async () => ({ allow: false, reason: 'Bearer rejected' }),
        },
      }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
    });
    cleanups.push(() => front.close());

    const result = await fetchWithAuth(front.port);
    expect(result.status).toBe(401);
    expect(result.body).toContain('Bearer rejected');
    expect(result.wwwAuth).toBe(
      'Bearer realm="authenticate-cognito (UserPool=us-east-1_abcDEF)"'
    );
  });

  it('serves the wrapped action when the auth check allows', async () => {
    const upstream = await startUpstream('allowed');
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstream.port });
    const front = await startFrontDoorServer({
      route: () => ({
        kind: 'forward',
        pools: [{ pool, weight: 1 }],
        auth: { realm: 'r', check: async () => ({ allow: true }) },
      }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
    });
    cleanups.push(() => front.close());

    const result = await fetchWithAuth(front.port, { authorization: 'Bearer token' });
    expect(result.status).toBe(200);
    expect(result.body).toBe('allowed');
  });

  it('also enforces auth on a redirect action (does not bypass the gate)', async () => {
    const front = await startFrontDoorServer({
      route: () => ({
        kind: 'redirect',
        statusCode: 302,
        host: 'somewhere.example.com',
        auth: { realm: 'r', check: async () => ({ allow: false }) },
      }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
    });
    cleanups.push(() => front.close());

    const result = await fetchWithAuth(front.port);
    expect(result.status).toBe(401);
  });

  it('also enforces auth on a fixed-response action (does not bypass the gate)', async () => {
    const front = await startFrontDoorServer({
      route: () => ({
        kind: 'fixed-response',
        statusCode: 200,
        messageBody: 'should not be served',
        auth: { realm: 'r', check: async () => ({ allow: false }) },
      }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
    });
    cleanups.push(() => front.close());

    const result = await fetchWithAuth(front.port);
    expect(result.status).toBe(401);
    expect(result.body).not.toContain('should not be served');
  });

  it('answers 401 with `Unauthorized` body when the check denies without a reason', async () => {
    const front = await startFrontDoorServer({
      route: () => ({
        kind: 'forward',
        pools: [{ pool: new FrontDoorEndpointPool(), weight: 1 }],
        auth: { realm: 'r', check: async () => ({ allow: false }) },
      }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
    });
    cleanups.push(() => front.close());

    const result = await fetchWithAuth(front.port);
    expect(result.status).toBe(401);
    expect(result.body.trim()).toBe('Unauthorized');
  });

  it('answers 401 (not 500) when the auth check throws', async () => {
    const front = await startFrontDoorServer({
      route: () => ({
        kind: 'forward',
        pools: [{ pool: new FrontDoorEndpointPool(), weight: 1 }],
        auth: {
          realm: 'r',
          check: async () => {
            throw new Error('boom');
          },
        },
      }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
    });
    cleanups.push(() => front.close());

    const result = await fetchWithAuth(front.port);
    expect(result.status).toBe(401);
  });
});

describe('startFrontDoorServer — WebSocket Upgrade', () => {
  /** Spin a plain-HTTP upstream that runs a `ws` echo server. */
  async function startWsEchoUpstream(): Promise<{ port: number }> {
    const { WebSocketServer } = await import('ws');
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => ws.send(data));
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const port = (httpServer.address() as AddressInfo).port;
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          wss.close(() => httpServer.close(() => r()));
        })
    );
    return { port };
  }

  async function startFrontDoorRoute(
    route: NonNullable<Parameters<typeof startFrontDoorServer>[0]['route']>,
    extra?: { tls?: Parameters<typeof startFrontDoorServer>[0]['tls'] }
  ): Promise<StartedFrontDoorServer> {
    const front = await startFrontDoorServer({
      route,
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
      ...(extra?.tls && { tls: extra.tls }),
    });
    cleanups.push(() => front.close());
    return front;
  }

  /** Connect via `ws`, send one message, await the echoed reply, close. */
  async function wsEchoRoundtrip(url: string, message: string): Promise<string> {
    const { WebSocket } = await import('ws');
    return new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url, { rejectUnauthorized: false });
      ws.on('open', () => ws.send(message));
      ws.on('message', (data) => {
        ws.close();
        resolve(data.toString());
      });
      ws.on('error', reject);
    });
  }

  /** Expect a non-101 response from the front-door (the upgrade is refused). */
  async function wsExpectReject(
    url: string
  ): Promise<{ statusCode?: number; wwwAuth?: string }> {
    const { WebSocket } = await import('ws');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { rejectUnauthorized: false });
      ws.on('unexpected-response', (_req, res) => {
        const wwwAuth = res.headers['www-authenticate'];
        resolve({
          ...(typeof res.statusCode === 'number' && { statusCode: res.statusCode }),
          ...(typeof wwwAuth === 'string' && { wwwAuth }),
        });
        res.resume();
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('expected the front-door to reject the upgrade, but it succeeded'));
      });
      ws.on('error', () => {
        /* swallowed; `unexpected-response` resolves the promise first */
      });
    });
  }

  it('proxies a WebSocket handshake to an ECS pool and round-trips a message', async () => {
    const upstream = await startWsEchoUpstream();
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstream.port });
    const front = await startFrontDoorRoute(() => ({
      kind: 'forward',
      pools: [{ pool, weight: 1 }],
    }));

    const echoed = await wsEchoRoundtrip(`ws://127.0.0.1:${front.port}/`, 'hello-ws');
    expect(echoed).toBe('hello-ws');
  });

  it('answers 404 over the raw socket when no rule matches the upgrade', async () => {
    const front = await startFrontDoorRoute(() => undefined);
    const result = await wsExpectReject(`ws://127.0.0.1:${front.port}/nope`);
    expect(result.statusCode).toBe(404);
  });

  it('answers 503 when the pool has no live replica', async () => {
    const pool = new FrontDoorEndpointPool();
    const front = await startFrontDoorRoute(() => ({
      kind: 'forward',
      pools: [{ pool, weight: 1 }],
    }));
    const result = await wsExpectReject(`ws://127.0.0.1:${front.port}/`);
    expect(result.statusCode).toBe(503);
  });

  it('answers 502 when the picked forward target is a Lambda target (Lambda TG does not support WS)', async () => {
    const front = await startFrontDoorRoute(() => ({
      kind: 'forward',
      pools: [
        {
          lambda: {
            targetGroupArn: 'tg',
            multiValueHeaders: false,
            label: 'EchoFn',
            invoke: async () => ({ statusCode: 200 }),
          },
          weight: 1,
        },
      ],
    }));
    const result = await wsExpectReject(`ws://127.0.0.1:${front.port}/`);
    expect(result.statusCode).toBe(502);
  });

  it('runs the auth gate before bridging: deny -> 401 with WWW-Authenticate', async () => {
    const upstream = await startWsEchoUpstream();
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstream.port });
    const front = await startFrontDoorRoute(() => ({
      kind: 'forward',
      pools: [{ pool, weight: 1 }],
      auth: {
        realm: 'authenticate-cognito (UserPool=us-east-1_test)',
        check: async () => ({ allow: false }),
      },
    }));
    const result = await wsExpectReject(`ws://127.0.0.1:${front.port}/`);
    expect(result.statusCode).toBe(401);
    expect(result.wwwAuth).toBe(
      'Bearer realm="authenticate-cognito (UserPool=us-east-1_test)"'
    );
  });

  it('runs the auth gate before bridging: allow -> handshake succeeds', async () => {
    const upstream = await startWsEchoUpstream();
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstream.port });
    const front = await startFrontDoorRoute(() => ({
      kind: 'forward',
      pools: [{ pool, weight: 1 }],
      auth: { realm: 'r', check: async () => ({ allow: true }) },
    }));
    const echoed = await wsEchoRoundtrip(`ws://127.0.0.1:${front.port}/`, 'allowed-ws');
    expect(echoed).toBe('allowed-ws');
  });

  it('bridges the upgrade with X-Forwarded-Proto: https when forwardedProto is set on a plain-HTTP wire (#198)', async () => {
    // Cloud-HTTPS WS listener served over plain HTTP locally: the upgrade
    // request reaching the upstream replica must still carry
    // `x-forwarded-proto: https` so an app inspecting the header on the
    // upgrade frame matches its deployed-ALB behavior.
    const { WebSocketServer } = await import('ws');
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    let capturedProto: string | string[] | undefined;
    wss.on('connection', (ws, req) => {
      capturedProto = req.headers['x-forwarded-proto'];
      ws.on('message', (data) => ws.send(data));
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const upstreamPort = (httpServer.address() as AddressInfo).port;
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          wss.close(() => httpServer.close(() => r()));
        })
    );

    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstreamPort });
    const front = await startFrontDoorServer({
      route: () => ({ kind: 'forward', pools: [{ pool, weight: 1 }] }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 443,
      label: 'listener port 443',
      forwardedProto: 'https',
    });
    cleanups.push(() => front.close());

    const echoed = await wsEchoRoundtrip(`ws://127.0.0.1:${front.port}/`, 'degraded-ws');
    expect(echoed).toBe('degraded-ws');
    expect(capturedProto).toBe('https');
  });

  it('redirects an upgrade with a https:// Location when forwardedProto is set on a plain-HTTP wire (#198)', async () => {
    // Companion to the regular-HTTP redirect path: the WS-upgrade branch
    // synthesizes its own redirect over the raw socket (writeRawHttpRedirect),
    // and the `#{protocol}` default must follow forwardedProto so a
    // cloud-HTTPS listener served over plain HTTP still emits `https://...`
    // in the upgrade-rejection Location header.
    const action: RedirectRouteAction = {
      kind: 'redirect',
      statusCode: 301,
      host: 'new.example.com',
    };
    const front = await startFrontDoorServer({
      route: () => action,
      port: 0,
      host: '127.0.0.1',
      listenerPort: 443,
      label: 'listener port 443',
      forwardedProto: 'https',
    });
    cleanups.push(() => front.close());

    // The upgrade fails (the server answers a 301 instead of 101); read the
    // synthesized `Location` from the same `unexpected-response` channel
    // wsExpectReject uses for 404 / 401 / 502 / 503.
    const { WebSocket } = await import('ws');
    const result = await new Promise<{ status?: number; location?: string }>(
      (resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${front.port}/`);
        ws.on('unexpected-response', (_req, res) => {
          const loc = res.headers.location;
          resolve({
            ...(typeof res.statusCode === 'number' && { status: res.statusCode }),
            ...(typeof loc === 'string' && { location: loc }),
          });
          res.resume();
        });
        ws.on('open', () => {
          ws.close();
          reject(new Error('expected the front-door to redirect the upgrade'));
        });
        ws.on('error', () => {
          /* swallowed; `unexpected-response` resolves the promise first */
        });
      }
    );
    expect(result.status).toBe(301);
    expect(result.location).toMatch(/^https:\/\/new\.example\.com\//);
  });
});

describe('startFrontDoorServer — WebSocket Upgrade over HTTPS', () => {
  let tls: FrontDoorTlsMaterials;
  let tlsCacheDir: string;

  beforeAll(async () => {
    tlsCacheDir = mkdtempSync(join(tmpdir(), 'cdkl-front-door-ws-tls-'));
    tls = await resolveFrontDoorTlsMaterials({
      certPath: undefined,
      keyPath: undefined,
      cacheDir: tlsCacheDir,
    });
  });

  afterAll(() => {
    rmSync(tlsCacheDir, { recursive: true, force: true });
  });

  it('terminates TLS locally and bridges the WS upgrade to a plain HTTP upstream', async () => {
    const { WebSocketServer, WebSocket } = await import('ws');
    const upstreamHttp = createServer();
    const wss = new WebSocketServer({ server: upstreamHttp });
    wss.on('connection', (ws) => ws.on('message', (m) => ws.send(m)));
    await new Promise<void>((r) => upstreamHttp.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstreamHttp.address() as AddressInfo).port;
    cleanups.push(
      () => new Promise<void>((r) => wss.close(() => upstreamHttp.close(() => r())))
    );

    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstreamPort });
    const front = await startFrontDoorServer({
      route: () => ({ kind: 'forward', pools: [{ pool, weight: 1 }] }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 443,
      label: 'listener port 443',
      tls,
    });
    cleanups.push(() => front.close());

    const echoed = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${front.port}/`, { rejectUnauthorized: false });
      ws.on('open', () => ws.send('tls-ws'));
      ws.on('message', (data) => {
        ws.close();
        resolve(data.toString());
      });
      ws.on('error', reject);
    });
    expect(echoed).toBe('tls-ws');
  });
});

describe('startFrontDoorServer — WebSocket Upgrade resilience', () => {
  it('does NOT inject HTTP/1.1 502 text into the WS frame stream when the upstream RSTs mid-stream', async () => {
    // Spin a vanilla `ws` upstream that completes the handshake but then
    // destroys the TCP socket the instant the client sends a frame. Without
    // the upstreamConnected guard the front-door would write `HTTP/1.1 502
    // Bad Gateway...` into the live WS frame channel; the assertion below
    // sniffs the client-side bytes and fails if that text appears.
    const { WebSocketServer, WebSocket } = await import('ws');
    const upstreamHttp = createServer();
    const wss = new WebSocketServer({ server: upstreamHttp });
    wss.on('connection', (ws, req) => {
      // Destroy the underlying socket immediately on any message — emulates
      // a backend that crashed mid-session.
      ws.on('message', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req.socket as unknown as { destroy: () => void }).destroy();
      });
    });
    await new Promise<void>((r) => upstreamHttp.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstreamHttp.address() as AddressInfo).port;
    cleanups.push(
      () => new Promise<void>((r) => wss.close(() => upstreamHttp.close(() => r())))
    );

    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: upstreamPort });
    const front = await startFrontDoorServer({
      route: () => ({ kind: 'forward', pools: [{ pool, weight: 1 }] }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
    });
    cleanups.push(() => front.close());

    // Sniff the raw bytes received from the front-door after the upgrade.
    const received: Buffer[] = [];
    const closed = new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${front.port}/`);
      ws.on('open', () => {
        // Hook the underlying socket to capture every byte AFTER the 101.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = (ws as unknown as { _socket: NodeJS.ReadableStream })._socket;
        raw.on('data', (chunk: Buffer) => received.push(chunk));
        ws.send('trigger-rst');
      });
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
    await closed;

    const bytes = Buffer.concat(received).toString('utf-8');
    expect(bytes).not.toContain('HTTP/1.1 502');
    expect(bytes).not.toContain('Failed to reach replica');
  });

  it('sanitizes CR / LF in a fixed-response contentType so it cannot inject extra headers', async () => {
    const front = await startFrontDoorServer({
      route: () => ({
        kind: 'fixed-response',
        statusCode: 200,
        contentType: 'text/plain\r\nx-injected: yes',
        messageBody: 'ok',
      }),
      port: 0,
      host: '127.0.0.1',
      listenerPort: 80,
      label: 'listener port 80',
    });
    cleanups.push(() => front.close());

    // Hit the upgrade path (which uses the raw socket writer) and capture
    // the raw response bytes from the front-door.
    const sock = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const s = (
        require('node:net') as typeof import('node:net')
      ).connect({ port: front.port, host: '127.0.0.1' }, () => resolve(s));
      s.on('error', reject);
    });
    sock.write(
      [
        'GET / HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n')
    );
    const raw = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      sock.on('data', (c: Buffer) => chunks.push(c));
      sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });

    expect(raw).toContain('content-type: text/plain  x-injected: yes');
    // The injection attempt MUST NOT produce a separate header line.
    expect(raw).not.toMatch(/^x-injected: yes/m);
  });
});
