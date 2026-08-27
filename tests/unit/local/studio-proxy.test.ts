import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vite-plus/test';
import { StudioEventBus, type StudioInvocationEvent } from '../../../src/local/studio-events.js';
import {
  describeEndpointForMessage,
  isLoopbackHostname,
  isWildcardHostname,
  normalizeLocalUpstream,
  startStudioProxy,
  type RunningStudioProxy,
} from '../../../src/local/studio-proxy.js';

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

/**
 * Boot a throwaway upstream HTTP server with the given handler, bound to
 * `host` (default `127.0.0.1`). Resolves the URL it is REACHABLE at, which is
 * not always the URL a test addresses it by - the wildcard / IPv6 cases below
 * deliberately address it by a different spelling and assert it is still hit.
 */
function bootUpstream(
  handler: Parameters<typeof createServer>[1],
  host = '127.0.0.1'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    upstreams.push(server);
    server.once('error', reject);
    server.listen(0, host, () => {
      const port = (server.address() as AddressInfo).port;
      const authority = host.includes(':') ? `[${host}]` : host;
      resolve(`http://${authority}:${port}`);
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
        // A mid-stream upstream death destroys this response socket; handle
        // its 'error' so it never propagates as an unhandled rejection (which
        // would crash the test worker) and resolve with whatever arrived.
        res.on('error', () =>
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
    const ends: StudioInvocationEvent[] = [];
    // Resolve the moment the (first) terminal event fires — deterministic,
    // no fixed sleep — then a microtask later assert no SECOND one slipped in.
    const firstEnd = new Promise<void>((resolve) => {
      bus.on('invocation', (e) => {
        if (e.status != null) {
          ends.push(e);
          resolve();
        }
      });
    });
    const upstream = await bootUpstream((_req, res) => {
      res.writeHead(200);
      res.write('partial');
      // Kill the socket mid-body: the upstream response stream errors AND
      // the request can error — the dedup guard must keep it to one event.
      res.socket?.destroy();
    });
    const proxy = await boot(bus, upstream);

    await httpReq(`${proxy.url}/die`).catch(() => undefined); // client may see a reset
    await firstEnd;
    await new Promise((r) => setImmediate(r)); // let any (wrongly) queued second end fire
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

// ---------------------------------------------------------------------------
// Issue #578 - the proxy forwards the developer's request (headers + body) to
// whatever host its upstream names, so it enforces the loopback bound itself
// rather than trusting the caller to have checked.
// ---------------------------------------------------------------------------

describe('isLoopbackHostname (issue #578)', () => {
  it('accepts every spelling of this machine', () => {
    for (const h of [
      '127.0.0.1',
      '127.0.0.53',
      '127.5.5.5',
      'localhost',
      'LOCALHOST',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '[::ffff:7f00:1]',
    ]) {
      expect(isLoopbackHostname(h), h).toBe(true);
    }
  });

  it('refuses every other host, including the near-misses', () => {
    for (const h of [
      '0.0.0.0',
      '192.168.0.5',
      '169.254.169.254',
      '10.0.0.1',
      'attacker.example',
      'localhost.attacker.example',
      'my-localhost',
      '127.0.0.1.attacker.example',
      '2130706433.attacker.example',
      '999.0.0.1',
      '[2001:db8::1]',
      '::ffff:169.254.169.254',
      '',
    ]) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });
});

describe('describeEndpointForMessage (issue #578)', () => {
  it('flattens control characters so a quoted endpoint cannot forge output', () => {
    expect(describeEndpointForMessage('http://a.example/\u001b[31m\r\nWARN: fake')).toBe(
      'http://a.example/?[31m??WARN: fake'
    );
  });

  it('caps the length', () => {
    const long = `http://${'a'.repeat(400)}.example/`;
    const out = describeEndpointForMessage(long);
    expect(out.length).toBe(123);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('startStudioProxy upstream bound (issue #578)', () => {
  it('refuses a non-loopback upstream', () => {
    for (const upstream of [
      'http://attacker.example/',
      'http://169.254.169.254:80',
      'http://localhost.attacker.example:8080',
    ]) {
      // Thrown synchronously, like the `new URL(upstream)` parse failure right
      // above it - both are refusals to even attempt a proxy, and every caller
      // reaches this inside a try / catch.
      expect(
        () =>
          startStudioProxy({
            bus: new StudioEventBus(),
            target: 'MyApi',
            kind: 'api',
            upstream,
          }),
        upstream
      ).toThrow(/non-loopback upstream/);
    }
  });

  it('still fronts a loopback upstream', async () => {
    const bus = new StudioEventBus();
    const upstream = await bootUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const proxy = await boot(bus, upstream);
    const res = await httpReq(`${proxy.url}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
  });
});

describe('isWildcardHostname (issue #578)', () => {
  it('recognises every spelling of the unspecified address', () => {
    for (const h of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '[::ffff:0:0]']) {
      expect(isWildcardHostname(h), h).toBe(true);
    }
  });

  it('is not fooled by a host that merely starts with a zero', () => {
    for (const h of ['0.0.0.1', '10.0.0.0', '0.0.0.0.attacker.example', '127.0.0.1', '']) {
      expect(isWildcardHostname(h), h).toBe(false);
    }
  });
});

describe('normalizeLocalUpstream (issue #578)', () => {
  it('accepts every loopback spelling a URL can normalise, including the compressed and integer forms', () => {
    expect(normalizeLocalUpstream('http://127.0.0.1:51234')).toBe('http://127.0.0.1:51234');
    expect(normalizeLocalUpstream('ws://localhost:49160/ws')).toBe('ws://localhost:49160/ws');
    expect(normalizeLocalUpstream('http://[::1]:51234/x')).toBe('http://[::1]:51234/x');
    // `URL` normalises both of these to the hostname `127.0.0.1`, so they are
    // loopback despite not looking like it.
    expect(normalizeLocalUpstream('http://127.1:8080')).toBe('http://127.1:8080');
    expect(normalizeLocalUpstream('http://2130706433:8080')).toBe('http://2130706433:8080');
  });

  it('rewrites a wildcard bind address to loopback, host token only', () => {
    expect(normalizeLocalUpstream('http://0.0.0.0:51234')).toBe('http://127.0.0.1:51234');
    expect(normalizeLocalUpstream('http://[::]:51234')).toBe('http://127.0.0.1:51234');
    expect(normalizeLocalUpstream('http://[0:0:0:0:0:0:0:0]:51234')).toBe('http://127.0.0.1:51234');
    expect(normalizeLocalUpstream('http://[::ffff:0.0.0.0]:51234')).toBe('http://127.0.0.1:51234');
    // Scheme / port / path / query ride through unchanged.
    expect(normalizeLocalUpstream('ws://[::]:49160/ws')).toBe('ws://127.0.0.1:49160/ws');
    expect(normalizeLocalUpstream('https://0.0.0.0:8443/a/b?q=1#f')).toBe(
      'https://127.0.0.1:8443/a/b?q=1#f'
    );
    expect(normalizeLocalUpstream('http://0.0.0.0')).toBe('http://127.0.0.1');
  });

  it('returns a loopback upstream byte-for-byte (no re-serialisation)', () => {
    for (const u of ['http://127.0.0.1:51234', 'ws://localhost:49160/ws', 'http://[::1]:8080/x']) {
      expect(normalizeLocalUpstream(u), u).toBe(u);
    }
  });

  it('still refuses a foreign or unparseable upstream', () => {
    for (const u of [
      'http://attacker.example/',
      'http://169.254.169.254:80',
      'http://192.168.0.5:3000',
      'http://localhost.attacker.example:8080',
      'http://127.0.0.1.attacker.example:8080',
      'not-a-url',
      '',
    ]) {
      expect(normalizeLocalUpstream(u), u).toBeUndefined();
    }
  });

  it('carries userinfo through byte-for-byte on the wildcard rewrite', () => {
    // The DECISION taken here: userinfo is preserved rather than dropped or
    // refused. It is preservable safely because the post-condition re-parses
    // the result and proves the host it actually names - so `tok@` riding
    // along cannot move the destination without the check catching it.
    // Dropping it instead would silently strip a credential the child put on
    // the URL and turn a working upstream into a 401.
    expect(normalizeLocalUpstream('http://tok@0.0.0.0:51234/')).toBe(
      'http://tok@127.0.0.1:51234/'
    );
    expect(normalizeLocalUpstream('http://u:p@0.0.0.0:8080/x')).toBe(
      'http://u:p@127.0.0.1:8080/x'
    );
    expect(normalizeLocalUpstream('http://u:p@[::]:8080/x?q=1#f')).toBe(
      'http://u:p@127.0.0.1:8080/x?q=1#f'
    );
  });

  it('refuses a rewrite whose RESULT is not loopback (the `\\` authority terminator)', () => {
    // `\` ends the authority for the WHATWG parser but not for the `[/?#]`
    // scan, so the host token the rewrite lands on is the wrong one and the
    // result re-parses to host `0.0.0.0`. Caught by the post-condition rather
    // than by adding `\` to the cut set - which would fix this one spelling
    // and leave the next terminator open.
    expect(normalizeLocalUpstream('http://0.0.0.0\\@attacker.example/')).toBeUndefined();
    expect(normalizeLocalUpstream('http://0.0.0.0:8080\\@evil.example/')).toBeUndefined();
    expect(normalizeLocalUpstream('ws://0.0.0.0\\@evil.example/ws')).toBeUndefined();
  });

  it('POST-CONDITION: every accepted result re-parses to a loopback host', () => {
    // The property the function actually promises, asserted over the value it
    // HANDS BACK rather than over the one it inspected on the way in - so a
    // spelling nobody enumerated cannot slip a non-loopback destination out.
    const INPUTS = [
      // loopback, wildcard, and the odd spellings of each
      'http://127.0.0.1:51234',
      'http://127.1:8080',
      'http://2130706433:8080',
      'http://0177.0.0.1/',
      'http://LOCALHOST:3000/',
      'http://[::1]:51234/x',
      'ws://localhost:49160/ws',
      'http://0.0.0.0:51234',
      'https://0.0.0.0:8443/a/b?q=1#f',
      'http://[::]:51234',
      'http://[0:0:0:0:0:0:0:0]:51234',
      'http://[::ffff:0.0.0.0]:51234',
      'http://tok@0.0.0.0:51234/',
      'http://u:p@0.0.0.0:8080/x',
      // things that must be refused rather than returned
      'http://attacker.example/',
      'http://0.0.0.0\\@attacker.example/',
      'http://0.0.0.0:8080\\@evil.example/',
      'http://127.0.0.1@attacker.example/',
      'http://2852039166/',
      'http://169.254.169.254:80',
      'http://[2001:db8::1]:3000',
      'http://:::8080',
      'not-a-url',
      '',
    ];
    let accepted = 0;
    for (const input of INPUTS) {
      const out = normalizeLocalUpstream(input);
      if (out === undefined) continue;
      accepted += 1;
      // Must parse, and must name this machine.
      const parsed = new URL(out);
      expect(isLoopbackHostname(parsed.hostname), `${input} -> ${out}`).toBe(true);
    }
    // Guard the guard: a mutant that refuses everything would satisfy the
    // loop vacuously.
    expect(accepted).toBe(14);
  });

  it('delegates host judgement to `URL`, so its normalisations are the ones that count', () => {
    const CASES: Array<[string, string | undefined]> = [
      // userinfo `@` does NOT make the credential the host
      ['http://127.0.0.1@attacker.example/', undefined],
      // decimal integer form of 169.254.169.254
      ['http://2852039166/', undefined],
      // OCTAL 0177 == 127, which `URL` resolves to 127.0.0.1
      ['http://0177.0.0.1/', 'http://0177.0.0.1/'],
      // a rooted (trailing-dot) IPv4 still parses as the IPv4 literal
      ['http://127.0.0.1./', 'http://127.0.0.1./'],
      // ...but a rooted NAME is a name, and `localhost.` is not the literal
      ['http://localhost./', undefined],
      // hostnames are case-insensitive; `URL` lowercases them
      ['http://LOCALHOST:3000/', 'http://LOCALHOST:3000/'],
      ['HTTP://127.0.0.1:3000/', 'HTTP://127.0.0.1:3000/'],
      // an UNBRACKETED IPv6 authority is not a URL at all
      ['http://:::8080', undefined],
    ];
    for (const [input, expected] of CASES) {
      expect(normalizeLocalUpstream(input), input).toBe(expected);
    }
  });
});

describe('startStudioProxy wildcard upstream (issue #578)', () => {
  it('accepts the `0.0.0.0` wildcard and forwards it', async () => {
    // `0.0.0.0` is the ordinary `--container-host` spelling, so ACCEPTING it
    // is the property under test here - and only that. It does NOT prove the
    // rewrite: `connect()` to `0.0.0.0` reaches a `127.0.0.1`-only listener on
    // this platform anyway, so a proxy forwarding `config.upstream` RAW passes
    // this case too. (It was written claiming otherwise; the `::` case below
    // is the one that discriminates.)
    const bus = new StudioEventBus();
    const upstream = await bootUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('via-loopback');
    });
    const port = new URL(upstream).port;
    const proxy = await boot(bus, `http://0.0.0.0:${port}`);
    const res = await httpReq(`${proxy.url}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('via-loopback');
  });

  it('rewrites the `::` wildcard to loopback, which is the only way this lands', async () => {
    // The discriminating spelling. `::` against a `127.0.0.1`-only listener is
    // ECONNREFUSED, so a 200 here can ONLY come from the destination having
    // been rewritten to `127.0.0.1` before the forward - a proxy that hands
    // `config.upstream` through raw 502s instead.
    const bus = new StudioEventBus();
    const upstream = await bootUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('via-loopback');
    });
    const port = new URL(upstream).port;
    const proxy = await boot(bus, `http://[::]:${port}`);
    const res = await httpReq(`${proxy.url}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('via-loopback');
  });
});

describe('startStudioProxy IPv6 loopback upstream (issue #578 review)', () => {
  it('forwards to a `[::1]` upstream instead of 502ing on the brackets', async (ctx) => {
    // `isLoopbackHostname` tolerates the brackets `URL.hostname` keeps on an
    // IPv6 literal, so `http://[::1]:<port>` is ACCEPTED - and `node:http`
    // then looks `[::1]` up as a NAME and fails `ENOTFOUND`, making every
    // request through such a proxy a 502. Accepted-then-broken is the worst of
    // the three outcomes, and `--host ::1` reaches it through a serve's raw
    // extra args. Asserts the BODY, so it can only pass on a real round trip.
    let upstream: string;
    try {
      upstream = await bootUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('via-ipv6-loopback');
      }, '::1');
    } catch {
      // No IPv6 loopback on this host: there is nothing to bind, so there is no
      // claim to make either way. Report it as SKIPPED rather than returning --
      // a bare `return` passes with ZERO assertions, which is indistinguishable
      // from a real pass, and that is precisely the "passed for the wrong
      // reason" failure this file's `[::]` case exists to correct.
      ctx.skip();
      return;
    }
    const bus = new StudioEventBus();
    const proxy = await boot(bus, upstream);
    const res = await httpReq(`${proxy.url}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('via-ipv6-loopback');
  });
});
