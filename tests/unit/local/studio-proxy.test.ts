import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vite-plus/test';
import { StudioEventBus, type StudioInvocationEvent } from '../../../src/local/studio-events.js';
import { startStudioProxy, type RunningStudioProxy } from '../../../src/local/studio-proxy.js';

const upstreams: Server[] = [];
const proxies: RunningStudioProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()));
  await Promise.all(
    upstreams.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.close(() => r());
          // Force-destroy any lingering connections (e.g. a hijacked
          // WebSocket upgrade socket) so close() does not hang.
          s.closeAllConnections?.();
        })
    )
  );
});

/** Boot a throwaway upstream HTTP server with the given handler. */
function bootUpstream(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    upstreams.push(server);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * A keep-alive-free HTTP client (`agent: false`) so each request uses a
 * fresh socket that closes — sidesteps undici's connection pool entirely
 * (no `closeAllConnections`-vs-pooled-socket worker crash).
 */
function httpReq(
  url: string,
  opts: { method?: string; body?: string } = {}
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        agent: false,
        headers: opts.body != null ? { 'content-type': 'text/plain' } : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers })
        );
      }
    );
    req.on('error', reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function collect(bus: StudioEventBus): StudioInvocationEvent[] {
  const evs: StudioInvocationEvent[] = [];
  bus.on('invocation', (e) => evs.push(e));
  return evs;
}

async function boot(
  bus: StudioEventBus,
  upstream: string,
  overrides: Partial<Parameters<typeof startStudioProxy>[0]> = {}
): Promise<RunningStudioProxy> {
  const proxy = await startStudioProxy({
    bus,
    target: 'MyApi',
    kind: 'api',
    upstream,
    idFactory: () => 'req-1',
    ...overrides,
  });
  proxies.push(proxy);
  return proxy;
}

describe('startStudioProxy', () => {
  it('forwards a GET and captures request + response as start/end invocation events', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    const upstream = await bootUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    const proxy = await boot(bus, upstream);

    const resp = await httpReq(`${proxy.url}/hello?q=1`);
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('hello');

    // Two events keyed by the same id: a start (no status) then an end.
    expect(evs).toHaveLength(2);
    expect(evs[0].id).toBe('req-1');
    expect(evs[0].status).toBeUndefined();
    expect(evs[0].label).toBe('GET /hello'); // query stripped from the label
    expect(evs[1].id).toBe('req-1');
    expect(evs[1].status).toBe(200);
    expect(evs[1].durationMs).toBeGreaterThanOrEqual(0);
    const req = evs[1].request as { method: string; path: string };
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/hello?q=1');
    const res = evs[1].response as { status: number; body: string };
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello');
  });

  it('forwards + captures a POST request body', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    const upstream = await bootUpstream((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.writeHead(200);
        res.end(`echo:${b}`);
      });
    });
    const proxy = await boot(bus, upstream);

    const resp = await httpReq(`${proxy.url}/submit`, { method: 'POST', body: 'ping' });
    expect(resp.body).toBe('echo:ping');

    const end = evs.find((e) => e.status != null)!;
    expect((end.request as { body: string }).body).toBe('ping');
    expect((end.response as { body: string }).body).toBe('echo:ping');
  });

  it('carries a non-2xx upstream status onto the timeline', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    const upstream = await bootUpstream((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    const proxy = await boot(bus, upstream);

    const resp = await httpReq(`${proxy.url}/missing`);
    expect(resp.status).toBe(404);
    expect(evs.find((e) => e.status != null)?.status).toBe(404);
  });

  it('answers 502 + emits an error end event when the upstream is unreachable', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    // Boot an upstream to grab a real URL, then close it so the port is dead.
    const deadUrl = await bootUpstream((_req, res) => res.end());
    const dead = upstreams.pop()!;
    await new Promise<void>((r) => dead.close(() => r()));
    const proxy = await boot(bus, deadUrl);

    const resp = await httpReq(`${proxy.url}/x`);
    expect(resp.status).toBe(502);
    const end = evs.find((e) => e.status != null);
    expect(end?.status).toBe(502);
    expect(String(end?.response)).toMatch(/upstream error/i);
  });

  it('bounds the CAPTURED body but streams the full body through', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    const big = 'x'.repeat(1000);
    const upstream = await bootUpstream((_req, res) => {
      res.writeHead(200);
      res.end(big);
    });
    const proxy = await boot(bus, upstream, { maxCaptureBytes: 10 });

    const resp = await httpReq(`${proxy.url}/big`);
    // The CLIENT still receives the full body.
    expect(resp.body).toBe(big);
    // The CAPTURED copy is truncated.
    const captured = (evs.find((e) => e.status != null)?.response as { body: string }).body;
    expect(captured.startsWith('xxxxxxxxxx')).toBe(true);
    expect(captured).toMatch(/truncated/);
    expect(captured.length).toBeLessThan(big.length);
  });

  it('captures a body exactly at the cap WITHOUT marking it truncated', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    const exact = 'abcdefghij'; // exactly 10 bytes
    const upstream = await bootUpstream((_req, res) => {
      res.writeHead(200);
      res.end(exact);
    });
    const proxy = await boot(bus, upstream, { maxCaptureBytes: 10 });

    await httpReq(`${proxy.url}/exact`);
    const captured = (evs.find((e) => e.status != null)?.response as { body: string }).body;
    expect(captured).toBe(exact); // no "(truncated)" suffix at the boundary
  });

  it('truncates the REQUEST body too (not just the response)', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    const upstream = await bootUpstream((req, res) => {
      req.resume(); // drain
      req.on('end', () => res.end('ok'));
    });
    const proxy = await boot(bus, upstream, { maxCaptureBytes: 5 });

    await httpReq(`${proxy.url}/up`, { method: 'POST', body: 'abcdefghij' });
    const capturedReq = (evs.find((e) => e.status != null)?.request as { body: string }).body;
    expect(capturedReq.startsWith('abcde')).toBe(true);
    expect(capturedReq).toMatch(/truncated/);
  });

  it('does NOT forward hop-by-hop response headers to the client', async () => {
    const bus = new StudioEventBus();
    const upstream = await bootUpstream((_req, res) => {
      res.setHeader('keep-alive', 'timeout=5');
      res.setHeader('x-kept', 'yes');
      res.writeHead(200);
      res.end('h');
    });
    const proxy = await boot(bus, upstream);

    const resp = await httpReq(`${proxy.url}/h`);
    // `keep-alive` is hop-by-hop and must be stripped; an ordinary header
    // is preserved.
    expect(resp.headers['keep-alive']).toBeUndefined();
    expect(resp.headers['x-kept']).toBe('yes');
  });

  it('emits exactly ONE end event when the upstream dies mid-response', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    const upstream = await bootUpstream((_req, res) => {
      res.writeHead(200);
      res.write('partial');
      // Kill the socket mid-body: the upstream response stream errors AND
      // the request can error — the dedup guard must keep it to one event.
      res.socket?.destroy();
    });
    const proxy = await boot(bus, upstream);

    await httpReq(`${proxy.url}/die`).catch(() => undefined); // client may see a reset
    await new Promise((r) => setTimeout(r, 50));
    const ends = evs.filter((e) => e.status != null);
    expect(ends).toHaveLength(1);
  });

  it('keeps captured bodies isolated across concurrent requests', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    const upstream = await bootUpstream((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => res.end(`got:${b}`));
    });
    let n = 0;
    const proxy = await boot(bus, upstream, { idFactory: () => `req-${(n += 1)}` });

    await Promise.all([
      httpReq(`${proxy.url}/a`, { method: 'POST', body: 'aaa' }),
      httpReq(`${proxy.url}/b`, { method: 'POST', body: 'bbb' }),
    ]);

    const ends = evs.filter((e) => e.status != null);
    expect(ends).toHaveLength(2);
    const bodies = ends.map((e) => (e.request as { body: string }).body).sort();
    expect(bodies).toEqual(['aaa', 'bbb']); // no cross-talk between the two
    expect(new Set(ends.map((e) => e.id)).size).toBe(2); // distinct ids
  });

  // NOTE: the WebSocket `Upgrade` raw-socket bridge (`bridgeUpgrade`) is
  // intentionally NOT unit-tested here. A raw `net` client driving an
  // upgrade handshake against an in-process server does not round-trip
  // under this test runner's worker (the HTTP path above works because it
  // uses a full `http` client), so the assertion is unreliable. The bridge
  // is verified out-of-band (a standalone handshake + echo round-trip
  // passes) and mirrors the already-tested `front-door-server` WS bridge;
  // the gap is tracked as an accepted known cost in the PR body.
});
