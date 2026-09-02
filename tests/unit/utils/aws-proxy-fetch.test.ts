import { createServer as createHttpServer, type Server } from 'node:http';
import {
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket as NetSocket,
} from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { proxyAwareFetch, resetProxySchemeWarnings } from '../../../src/utils/aws-proxy.js';
import { getLogger, setLogger } from '../../../src/utils/logger.js';

/**
 * Issue go-to-k/cdk-local#647 — `proxyAwareFetch` driven against REAL
 * loopback servers rather than a mocked `fetch`, because the whole defect
 * was that the request never went where the code looked like it went. A
 * mock of the thing under test could not have caught it: what has to be
 * observed is which SOCKET the bytes arrive on.
 *
 * Two servers stand in for the two ends:
 *
 *   - an ORIGIN (`node:http`) that records what it received, and
 *   - a PROXY, in the two shapes a forward proxy actually takes — an HTTP
 *     server receiving an absolute-form request line (`GET
 *     http://host:port/path`) for a plain-http target, and a raw TCP
 *     recorder capturing the `CONNECT host:443` a TLS target tunnels
 *     through. The CONNECT recorder answers 502 without opening the
 *     tunnel, exactly like `tests/integration/local-invoke/proxy-recorder.mjs`:
 *     the assertion is that the request TRIED to tunnel, not that anything
 *     was reached.
 */

const PROXY_ENV_KEYS = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

interface OriginHandlerResult {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

interface Origin {
  url: string;
  port: number;
  requests: string[];
  /**
   * `accept-encoding` per request — the observable that tells the two
   * transports apart. undici sends `gzip, deflate…`; the hand-rolled path
   * sends exactly `identity`. Without it, "went direct" and "went through
   * the hand-rolled agent, which then chose direct" look identical.
   */
  acceptEncodings: string[];
  close: () => Promise<void>;
}

async function startOrigin(handler: (path: string) => OriginHandlerResult): Promise<Origin> {
  const requests: string[] = [];
  const acceptEncodings: string[] = [];
  const server: Server = createHttpServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    acceptEncodings.push(String(req.headers['accept-encoding'] ?? ''));
    const out = handler(req.url ?? '/');
    res.writeHead(out.status ?? 200, out.statusText, {
      'content-type': 'text/plain',
      ...(out.headers ?? {}),
    });
    res.end(out.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    acceptEncodings,
    close: () =>
      new Promise<void>((resolve) => {
        // `close()` alone waits for every open connection, and a keep-alive
        // socket is open until the agent decides otherwise — so without this
        // the afterEach hangs to its 10 s timeout and reports the failure
        // against whichever test happened to run last.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A forward proxy for plain-http targets. A proxied client sends the
 * request line in ABSOLUTE form, so `req.url` here is the full target URL —
 * which is exactly the evidence that the request was proxied rather than
 * sent direct.
 */
async function startHttpProxy(handler: (target: string) => OriginHandlerResult): Promise<Origin> {
  return startOrigin(handler);
}

interface ConnectRecorder {
  url: string;
  lines: string[];
  close: () => Promise<void>;
}

/** Records the first request line of every connection, then answers 502. */
async function startConnectRecorder(): Promise<ConnectRecorder> {
  const lines: string[] = [];
  const sockets: NetSocket[] = [];
  const server: TcpServer = createTcpServer((sock) => {
    sockets.push(sock);
    sock.once('data', (buf: Buffer) => {
      lines.push(buf.toString('utf-8').split('\r\n')[0] ?? '');
      sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    lines,
    close: () =>
      new Promise<void>((resolve) => {
        // The stalled-CONNECT case deliberately leaves a socket open, and
        // nothing else will close it — see the http helper above.
        for (const sock of sockets) sock.destroy();
        server.close(() => resolve());
      }),
  };
}

interface RawProxy {
  url: string;
  lines: string[];
  close: () => Promise<void>;
}

/**
 * A forward proxy that answers with RAW BYTES, for responses a `node:http`
 * server refuses to emit — a reason phrase carrying a control character, or
 * no response at all. `reply: null` accepts the connection and stays silent,
 * which is what a hung proxy looks like.
 */
async function startRawProxy(reply: string | null): Promise<RawProxy> {
  const lines: string[] = [];
  const sockets: NetSocket[] = [];
  const server: TcpServer = createTcpServer((sock) => {
    sockets.push(sock);
    sock.once('data', (buf: Buffer) => {
      lines.push(buf.toString('utf-8').split('\r\n')[0] ?? '');
      if (reply !== null) sock.end(reply);
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    lines,
    close: () =>
      new Promise<void>((resolve) => {
        // The stalled-CONNECT case deliberately leaves a socket open, and
        // nothing else will close it — see the http helper above.
        for (const sock of sockets) sock.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('proxyAwareFetch (issue #647)', () => {
  const saved = new Map<string, string | undefined>();
  const closers: (() => Promise<void>)[] = [];

  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    // Module-level memo in `aws-proxy.ts`. Reset HERE rather than inside the
    // one case that asserts a warn count: an inline reset leaves the scheme
    // memoized for every case BELOW it, so a warn-count case added later
    // would silently measure zero.
    resetProxySchemeWarnings();
  });

  afterEach(async () => {
    // `try/finally`: a closer that rejects must not skip the remaining
    // closers OR the env restore, or one failure leaks proxy variables into
    // every later case in this file.
    try {
      for (const close of closers.splice(0)) await close().catch(() => undefined);
    } finally {
      for (const key of PROXY_ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  const track = <T extends { close: () => Promise<void> }>(server: T): T => {
    closers.push(server.close);
    return server;
  };

  it('goes DIRECT to the origin when no proxy variable is set — the unproxied contract', async () => {
    const origin = track(await startOrigin(() => ({ body: 'direct-body' })));
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));

    const response = await proxyAwareFetch(`${origin.url}/jwks.json`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('direct-body');
    expect(origin.requests).toEqual(['GET /jwks.json']);
    expect(proxy.requests).toEqual([]);
    expect(origin.acceptEncodings[0]).toContain('gzip');
  });

  // A NON-loopback target, because loopback is exempt by construction (see
  // `isLoopbackHost`). `.invalid` never resolves, so "went direct" is not
  // merely unobserved here — it is impossible: a direct attempt fails DNS
  // instead of returning the proxy's body.
  const REMOTE = 'http://origin.invalid';

  it('routes an http target THROUGH the proxy, in absolute form, when HTTP_PROXY is set', async () => {
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch(`${REMOTE}/jwks.json`);

    expect(await response.text()).toBe('proxy-body');
    expect(proxy.requests).toEqual([`GET ${REMOTE}/jwks.json`]);
  });

  it('honors the lowercase http_proxy spelling', async () => {
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['http_proxy'] = proxy.url;

    expect(await (await proxyAwareFetch(`${REMOTE}/x`)).text()).toBe('proxy-body');
  });

  it('NO_PROXY exempts the target — same env, request never reaches the proxy', async () => {
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['HTTP_PROXY'] = proxy.url;
    process.env['NO_PROXY'] = 'origin.invalid';

    // Exempt, so it is attempted DIRECTLY and fails DNS. The proxy seeing
    // nothing is the assertion; the rejection is how we know it went direct.
    await expect(proxyAwareFetch(`${REMOTE}/x`)).rejects.toThrow();
    expect(proxy.requests).toEqual([]);
  });

  it('never proxies a LOOPBACK target, even with no NO_PROXY entry — a proxy cannot reach the caller\'s own loopback, and an unreachable JWKS degrades the verifier to accept-all', async () => {
    const origin = track(await startOrigin(() => ({ body: 'direct-body' })));
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['HTTP_PROXY'] = proxy.url;

    expect(await (await proxyAwareFetch(`${origin.url}/jwks.json`)).text()).toBe('direct-body');
    expect(origin.requests).toEqual(['GET /jwks.json']);
    expect(proxy.requests).toEqual([]);
    // Handed back to the platform fetch, not merely routed direct by the
    // agent — see the NO_PROXY case below for why the distinction needs its
    // own observable.
    expect(origin.acceptEncodings[0]).toContain('gzip');
  });

  // Every spelling `URL.hostname` can produce for this machine. The IPv6
  // arms are the ones that mattered: `URL` KEEPS an IPv6 literal's brackets
  // and canonicalises the address inside them, so an earlier revision
  // comparing against a bare `'::1'` matched nothing and an IPv6-loopback
  // issuer was proxied — the silent accept-all downgrade the rule exists to
  // prevent. Bracketed / expanded / IPv4-mapped / trailing-dot forms all
  // reach `isLoopbackHost` looking different from what a reader expects.
  it.each([
    '127.0.0.1',
    '127.4.5.6',
    'localhost',
    'sub.localhost',
    'localhost.',
    '[::1]',
    '[0:0:0:0:0:0:0:1]',
    '[::ffff:127.0.0.1]',
    // A WILDCARD is a bind address, not a destination: connecting to it
    // reaches this machine, and `http://0.0.0.0:8080/realms/x` is an ordinary
    // local-IdP issuer spelling. An earlier revision proxied it.
    '0.0.0.0',
    '[::]',
  ])('treats %s as loopback', async (host) => {
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['HTTP_PROXY'] = proxy.url;
    // Nothing listens, so it fails — but it must fail DIRECTLY, which is
    // what an empty proxy log shows.
    await expect(proxyAwareFetch(`http://${host}:1/x`)).rejects.toThrow();
    expect(proxy.requests).toEqual([]);
  });

  it.each(['example.com', '[::2]', '192.168.0.5', '169.254.169.254'])(
    'does NOT treat %s as loopback — it is proxied like any other host',
    async (host) => {
      const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
      process.env['HTTP_PROXY'] = proxy.url;
      expect(await (await proxyAwareFetch(`http://${host}/x`)).text()).toBe('proxy-body');
      expect(proxy.requests).toHaveLength(1);
    }
  );

  it('bounds a proxy that accepts TCP and never answers CONNECT — req.setTimeout does not arm until the tunnel exists', async () => {
    // The PRODUCTION shape: an https target tunnels, and `https-proxy-agent`
    // assigns the request its socket only after CONNECT completes. A
    // socket-level timeout is therefore never armed here, which is how one
    // looks correct on the plain-http path while leaving the real case
    // unbounded. Measured before the fix: still hanging at 5000 ms.
    const stalling = track(await startRawProxy(null));
    process.env['HTTPS_PROXY'] = stalling.url;

    const started = Date.now();
    await expect(
      proxyAwareFetch('https://cognito-idp.us-east-1.amazonaws.com/pool/.well-known/jwks.json', {
        timeoutMs: 300,
      })
    ).rejects.toThrow('Proxied request stalled for 300 ms with no progress');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('tunnels a TLS target with CONNECT — the shape a JWKS / presigned-S3 read takes', async () => {
    const recorder = track(await startConnectRecorder());
    process.env['HTTPS_PROXY'] = recorder.url;

    const response = await proxyAwareFetch(
      'https://cognito-idp.us-east-1.amazonaws.com/pool/.well-known/jwks.json'
    );

    expect(recorder.lines).toEqual(['CONNECT cognito-idp.us-east-1.amazonaws.com:443 HTTP/1.1']);
    // The tunnel is refused, and `https-proxy-agent` surfaces the proxy's own
    // refusal as the response rather than throwing — which is why the caller
    // sees a non-ok Response here and falls back gracefully.
    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
  });

  it('a NO_PROXY match keeps a TLS target OFF the proxy', async () => {
    const recorder = track(await startConnectRecorder());
    process.env['HTTPS_PROXY'] = recorder.url;
    process.env['NO_PROXY'] = '127.0.0.1';

    // Port 1 on loopback refuses immediately, so the DIRECT attempt fails
    // without DNS and without touching a real host — the assertion is only
    // that it never reached the recorder.
    await expect(proxyAwareFetch('https://127.0.0.1:1/jwks.json')).rejects.toThrow();
    expect(recorder.lines).toEqual([]);
  });

  it('surfaces status / statusText / headers / body like fetch does', async () => {
    const proxy = track(
      await startHttpProxy((target) => ({
        status: 404,
        statusText: 'Not Found',
        headers: { 'x-marker': target },
        body: 'nope',
      }))
    );
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch(`${REMOTE}/missing`);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    expect(response.statusText).toBe('Not Found');
    expect(response.headers.get('x-marker')).toBe(`${REMOTE}/missing`);
    expect(await response.text()).toBe('nope');
  });

  it('decodes a Content-Encoding body — node:http does not, and a still-gzipped layer ZIP would be silent corruption', async () => {
    const payload = 'a'.repeat(200);
    const proxy = track(
      await startHttpProxy(() => ({
        headers: { 'content-encoding': 'gzip' },
        body: gzipSync(Buffer.from(payload, 'utf-8')),
      }))
    );
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/layer.zip');
    expect(await response.text()).toBe(payload);
    // The wire headers no longer describe what the caller holds.
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
  });

  it('leaves a body it cannot decode untouched rather than truncating it', async () => {
    const proxy = track(
      await startHttpProxy(() => ({
        headers: { 'content-encoding': 'exotic-v9' },
        body: 'raw-bytes',
      }))
    );
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/x');
    expect(await response.text()).toBe('raw-bytes');
    expect(response.headers.get('content-encoding')).toBe('exotic-v9');
  });

  it('follows a redirect, resolving a relative Location against the current URL', async () => {
    const proxy = track(
      await startHttpProxy((target) =>
        target.endsWith('/final')
          ? { body: 'final-body' }
          : { status: 302, headers: { location: '/final' }, body: '' }
      )
    );
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/start');
    expect(await response.text()).toBe('final-body');
    expect(proxy.requests).toEqual([
      'GET http://origin.invalid/start',
      'GET http://origin.invalid/final',
    ]);
  });

  it('re-evaluates routing PER HOP — a redirect onto a loopback target leaves the proxy', async () => {
    // The check lives inside the redirect loop precisely so a chain can cross
    // the NO_PROXY / loopback boundary. Hoisting it out leaves every other
    // redirect case green, because they never cross one.
    const origin = track(await startOrigin(() => ({ body: 'origin-direct' })));
    const proxy = track(
      await startHttpProxy(() => ({
        status: 302,
        headers: { location: `${origin.url}/moved` },
        body: '',
      }))
    );
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/start');

    expect(await response.text()).toBe('origin-direct');
    // Hop 1 was proxied; hop 2 landed on loopback and went DIRECT.
    expect(proxy.requests).toEqual(['GET http://origin.invalid/start']);
    expect(origin.requests).toEqual(['GET /moved']);
  });

  it('gives up on a redirect loop instead of spinning, and names no URL in the message', async () => {
    const proxy = track(
      await startHttpProxy(() => ({ status: 302, headers: { location: '/loop' }, body: '' }))
    );
    process.env['HTTP_PROXY'] = proxy.url;

    // A presigned URL carries `X-Amz-Signature` in its query string, so an
    // error message naming the URL is a credential in a log line.
    await expect(proxyAwareFetch('http://origin.invalid/loop?X-Amz-Signature=leak')).rejects.toThrow(
      /Too many redirects \(more than 20\)$/
    );
    expect(proxy.requests).toHaveLength(21);
  });

  it('treats a 204 as a null-body response instead of throwing', async () => {
    const proxy = track(await startHttpProxy(() => ({ status: 204, body: '' })));
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/x');
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it.each([
    ['deflate', (b: Buffer) => deflateSync(b)],
    ['x-deflate', (b: Buffer) => deflateSync(b)],
    ['br', (b: Buffer) => brotliCompressSync(b)],
  ])('decodes a %s body', async (encoding, compress) => {
    const payload = 'b'.repeat(200);
    const proxy = track(
      await startHttpProxy(() => ({
        headers: { 'content-encoding': encoding },
        body: compress(Buffer.from(payload, 'utf-8')),
      }))
    );
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/x');
    expect(await response.text()).toBe(payload);
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it.each([301, 302, 303, 307, 308])(
    'follows a %i redirect — S3 and CloudFront emit 307 / 308',
    async (status) => {
      const proxy = track(
        await startHttpProxy((target) =>
          target.endsWith('/final')
            ? { body: 'final-body' }
            : { status, headers: { location: '/final' }, body: '' }
        )
      );
      process.env['HTTP_PROXY'] = proxy.url;

      expect(await (await proxyAwareFetch('http://origin.invalid/start')).text()).toBe(
        'final-body'
      );
      expect(proxy.requests).toHaveLength(2);
    }
  );

  it('refuses a status outside 200-599 by name — `Response` would throw a bare RangeError', async () => {
    // On the JWKS path an exception is not a failed read, it is the
    // pass-through fallback that accepts every token, so a hostile origin
    // must not be able to reach it through an unnamed error.
    const proxy = track(await startRawProxy('HTTP/1.1 700 Weird\r\nContent-Length: 2\r\n\r\nhi'));
    process.env['HTTP_PROXY'] = proxy.url;

    await expect(proxyAwareFetch('http://origin.invalid/x')).rejects.toThrow(
      'Unsupported HTTP status in response: 700'
    );
  });

  it('does NOT abort a slow-but-progressing transfer — the bound is inactivity, not total time', async () => {
    // A wall-clock TOTAL would kill a 250 MB layer ZIP crossing a corporate
    // proxy that `fetch` would have completed. Six chunks at 60 ms each is
    // 360 ms of transfer under a 400 ms bound: it survives only if the timer
    // re-arms on every chunk. The per-chunk gap is deliberately well under the
    // bound — an event-loop stall makes the interval and the timer due in the
    // same timers phase, and a thin margin lets the timeout win.
    const server: TcpServer = createTcpServer((sock) => {
      sock.once('data', () => {
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n');
        let sent = 0;
        const tick = setInterval(() => {
          sock.write('x');
          if (++sent === 6) {
            clearInterval(tick);
            sock.end();
          }
        }, 60);
      });
      sock.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${port}`;

    const response = await proxyAwareFetch('http://origin.invalid/layer.zip', { timeoutMs: 400 });
    expect(await response.text()).toBe('xxxxxx');
  });

  it('rejects when the proxy itself is DOWN — the commonest misconfiguration', async () => {
    // Nothing listens on port 1, so the agent's connect fails and the request
    // emits `error`. That path (`req.on('error', fail)`) was reachable by no
    // other case, and it is the one that feeds the flattening assertions in
    // `proxy-aware-fetch-bindings.test.ts`.
    process.env['HTTP_PROXY'] = 'http://127.0.0.1:1';
    await expect(proxyAwareFetch('http://origin.invalid/x')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('re-evaluates the SCHEME per hop — a redirect can cross from a speakable proxy to one that is not', async () => {
    // The scheme check sits inside the redirect loop for the same reason the
    // NO_PROXY one does: `getProxyForUrl` picks by the TARGET's scheme, so an
    // http -> https redirect can move from HTTP_PROXY to HTTPS_PROXY and land
    // on a proxy these agents cannot speak. Hoisting the check out of the loop
    // leaves every other redirect case green.
    const proxy = track(
      await startHttpProxy(() => ({
        status: 302,
        headers: { location: 'https://origin.invalid/moved' },
        body: '',
      }))
    );
    process.env['HTTP_PROXY'] = proxy.url;
    process.env['HTTPS_PROXY'] = 'socks5://127.0.0.1:1080';
    const warn = vi.fn();
    const previous = getLogger();
    setLogger({ ...previous, warn, child: () => ({ ...previous, warn }) } as never);
    let err: unknown;
    try {
      err = await proxyAwareFetch('http://origin.invalid/start').catch((e: unknown) => e);
    } finally {
      setLogger(previous);
    }
    // Hop 1 went through the speakable proxy; hop 2's https target resolved to
    // the SOCKS proxy, warned, and was handed to undici, whose DNS lookup of
    // a `.invalid` host fails. Speaking HTTP at the SOCKS port instead would
    // surface ECONNREFUSED from `node:http` and no warn at all.
    expect(proxy.requests).toEqual(['GET http://origin.invalid/start']);
    expect(err).toBeInstanceOf(TypeError);
    expect(warn.mock.calls.map((c) => String(c[0]))).toHaveLength(1);
    expect(String(warn.mock.calls[0]![0])).toContain('socks5');
  });

  it('WARNS once, naming the scheme, when it falls back past a SOCKS proxy', async () => {
    // The fallback used to be silent on this half (issue
    // go-to-k/cdk-local#663 folded both halves onto one
    // `resolveProxyForTarget`, which warns). Silence is what made
    // "refuse loudly" arguable: a user whose direct egress is blocked
    // otherwise gets a transport error pointing at nothing.
    process.env['ALL_PROXY'] = 'socks5://user:s3cr3t@127.0.0.1:1080';
    const warn = vi.fn();
    const previous = getLogger();
    setLogger({ ...previous, warn, child: () => ({ ...previous, warn }) } as never);
    try {
      await proxyAwareFetch('http://origin.invalid/x').catch(() => undefined);
      await proxyAwareFetch('http://origin.invalid/y').catch(() => undefined);
    } finally {
      setLogger(previous);
    }
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('socks5');
    expect(lines[0]).not.toContain('s3cr3t');
  });

  it('falls back to a DIRECT request when the proxy is SOCKS — these agents speak only HTTP CONNECT', async () => {
    // `getProxyForUrl` honours `ALL_PROXY=socks5://...`, but `https-proxy-agent`
    // would construct happily and then talk HTTP at a SOCKS port. Before this
    // seam existed the read went direct and WORKED, and an unreachable JWKS
    // accepts every token — so falling back beats failing.
    // A NON-loopback target, or `isLoopbackHost` decides first and the SOCKS
    // arm is never reached. Both paths then FAIL, so the discriminator is
    // WHOSE failure: undici's `TypeError: fetch failed` (fell back to direct,
    // DNS fails) vs `node:http` connecting to the SOCKS port and getting
    // `ECONNREFUSED` from an HTTP agent that should never have been built.
    process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';

    const err = await proxyAwareFetch('http://origin.invalid/x').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('fetch failed');
  });

  it('sends its own accept / accept-encoding on the PROXIED side too', async () => {
    // These headers are this file's transport discriminator, and only the
    // direct side asserted them — deleting the headers object left every
    // case green.
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['HTTP_PROXY'] = proxy.url;

    await proxyAwareFetch(`${REMOTE}/x`);
    expect(proxy.acceptEncodings).toEqual(['identity']);
  });

  it('decodes an x-gzip body', async () => {
    const proxy = track(
      await startHttpProxy(() => ({
        headers: { 'content-encoding': 'x-gzip' },
        body: gzipSync(Buffer.from('legacy-alias', 'utf-8')),
      }))
    );
    process.env['HTTP_PROXY'] = proxy.url;
    expect(await (await proxyAwareFetch('http://origin.invalid/x')).text()).toBe('legacy-alias');
  });

  it.each([205, 304])('treats %i as a null-body status', async (status) => {
    // `Response` throws when a null-body status is given a body, so getting
    // this wrong turns an ordinary response into an exception.
    const proxy = track(await startRawProxy(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\n\r\n`));
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/x');
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it('refuses a non-http(s) URL naming the PROTOCOL and not the URL', async () => {
    process.env['HTTP_PROXY'] = 'http://127.0.0.1:1';
    await expect(proxyAwareFetch('file:///etc/passwd?X-Amz-Signature=leak')).rejects.toThrow(
      'Unsupported protocol for a proxied request: "file:"'
    );
    await expect(proxyAwareFetch('file:///etc/passwd?X-Amz-Signature=leak')).rejects.toThrow(
      /^(?!.*X-Amz-Signature).*$/s
    );
  });

  it('leaves a body whose declared encoding FAILS to decode untouched — a truncated layer ZIP would be silent corruption', async () => {
    // The header says gzip and the bytes are not. This is the arm that keeps
    // a corrupt download recognisable instead of half-decoded.
    const proxy = track(
      await startHttpProxy(() => ({
        headers: { 'content-encoding': 'gzip' },
        body: 'not-actually-gzip',
      }))
    );
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/layer.zip');
    expect(await response.text()).toBe('not-actually-gzip');
    expect(response.headers.get('content-encoding')).toBe('gzip');
  });

  it('returns a 3xx that carries NO Location instead of trying to follow it', async () => {
    const proxy = track(await startHttpProxy(() => ({ status: 302, body: 'no-location' })));
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/start');
    expect(response.status).toBe(302);
    expect(await response.text()).toBe('no-location');
    expect(proxy.requests).toHaveLength(1);
  });

  it('follows an ABSOLUTE Location onto a different host', async () => {
    const proxy = track(
      await startHttpProxy((target) =>
        target.startsWith('http://second.invalid/')
          ? { body: 'second-host' }
          : { status: 301, headers: { location: 'http://second.invalid/moved' }, body: '' }
      )
    );
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://first.invalid/start');
    expect(await response.text()).toBe('second-host');
    expect(proxy.requests).toEqual([
      'GET http://first.invalid/start',
      'GET http://second.invalid/moved',
    ]);
  });

  it('drops a reason-phrase byte `Response` would reject, instead of turning a 404 into a throw', async () => {
    // node:http accepts a control character in the reason phrase; the
    // `Response` constructor does not ("Invalid statusText"). Without the
    // sanitiser a hostile origin turns any response into an exception.
    const proxy = track(
      await startRawProxy('HTTP/1.1 404 Not\u0001Found\r\nContent-Length: 4\r\n\r\nnope')
    );
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch('http://origin.invalid/missing');
    expect(response.status).toBe(404);
    expect(response.statusText).toBe('NotFound');
    expect(await response.text()).toBe('nope');
  });

  it('gives up on a proxy that accepts the connection and never answers — node:http has no default timeout', async () => {
    const proxy = track(await startRawProxy(null));
    process.env['HTTP_PROXY'] = proxy.url;

    await expect(
      proxyAwareFetch('http://origin.invalid/x?X-Amz-Signature=leak', { timeoutMs: 150 })
    ).rejects.toThrow('Proxied request stalled for 150 ms with no progress');
    // Still no URL in the message.
    await expect(
      proxyAwareFetch('http://origin.invalid/x?X-Amz-Signature=leak', { timeoutMs: 150 })
    ).rejects.toThrow(/^(?!.*X-Amz-Signature).*$/s);
  });

  it('hands a NO_PROXY-exempt NON-loopback target back to the platform fetch', async () => {
    // The target must be NON-loopback, or `isLoopbackHost` decides first and
    // the NO_PROXY arm is never the one under test — which is how an earlier
    // version of this case stayed green with the short-circuit deleted.
    //
    // Nothing resolves `origin.invalid`, so both paths FAIL; the discriminator
    // is WHOSE failure it is. undici raises `TypeError: fetch failed` (the
    // real cause on `.cause`); `node:http` raises a plain `Error:
    // getaddrinfo ENOTFOUND …`. An empty proxy log cannot tell them apart,
    // because `EnvRoutingProxyAgent.connect` consults `getProxyForUrl` too
    // and would also route this direct.
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['HTTP_PROXY'] = proxy.url;
    process.env['NO_PROXY'] = 'origin.invalid';

    const err = await proxyAwareFetch('http://origin.invalid/exempt').catch(
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('fetch failed');
    expect(proxy.requests).toEqual([]);
  });

  it('refuses a redirect that hops to a non-http(s) scheme', async () => {
    const proxy = track(
      await startHttpProxy(() => ({
        status: 302,
        headers: { location: 'file:///etc/passwd' },
        body: '',
      }))
    );
    process.env['HTTP_PROXY'] = proxy.url;

    await expect(proxyAwareFetch('http://origin.invalid/start')).rejects.toThrow(
      'Unsupported protocol for a proxied request: "file:"'
    );
  });
});
