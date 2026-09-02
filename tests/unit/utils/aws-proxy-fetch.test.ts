import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { proxyAwareFetch } from '../../../src/utils/aws-proxy.js';

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
  close: () => Promise<void>;
}

async function startOrigin(handler: (path: string) => OriginHandlerResult): Promise<Origin> {
  const requests: string[] = [];
  const server: Server = createHttpServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
  const server: TcpServer = createTcpServer((sock) => {
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    for (const key of PROXY_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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
  });

  it('routes an http target THROUGH the proxy, in absolute form, when HTTP_PROXY is set', async () => {
    const origin = track(await startOrigin(() => ({ body: 'direct-body' })));
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch(`${origin.url}/jwks.json`);

    expect(await response.text()).toBe('proxy-body');
    expect(proxy.requests).toEqual([`GET ${origin.url}/jwks.json`]);
    // The whole defect, inverted: the origin must NOT have been reached
    // directly.
    expect(origin.requests).toEqual([]);
  });

  it('honors the lowercase http_proxy spelling', async () => {
    const origin = track(await startOrigin(() => ({ body: 'direct-body' })));
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['http_proxy'] = proxy.url;

    expect(await (await proxyAwareFetch(`${origin.url}/x`)).text()).toBe('proxy-body');
    expect(origin.requests).toEqual([]);
  });

  it('NO_PROXY exempts the target — same env, request goes direct', async () => {
    const origin = track(await startOrigin(() => ({ body: 'direct-body' })));
    const proxy = track(await startHttpProxy(() => ({ body: 'proxy-body' })));
    process.env['HTTP_PROXY'] = proxy.url;
    process.env['NO_PROXY'] = '127.0.0.1';

    expect(await (await proxyAwareFetch(`${origin.url}/x`)).text()).toBe('direct-body');
    expect(proxy.requests).toEqual([]);
    expect(origin.requests).toEqual(['GET /x']);
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
    const origin = track(
      await startOrigin(() => ({
        status: 404,
        statusText: 'Not Found',
        headers: { 'x-marker': 'origin' },
        body: 'nope',
      }))
    );
    const proxy = track(await startHttpProxy((target) => ({
      status: 404,
      statusText: 'Not Found',
      headers: { 'x-marker': target },
      body: 'nope',
    })));
    process.env['HTTP_PROXY'] = proxy.url;

    const response = await proxyAwareFetch(`${origin.url}/missing`);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    expect(response.statusText).toBe('Not Found');
    expect(response.headers.get('x-marker')).toBe(`${origin.url}/missing`);
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

  it('refuses a non-http(s) URL naming the PROTOCOL and not the URL', async () => {
    process.env['HTTP_PROXY'] = 'http://127.0.0.1:1';
    await expect(proxyAwareFetch('file:///etc/passwd?X-Amz-Signature=leak')).rejects.toThrow(
      'Unsupported protocol for a proxied request: "file:"'
    );
    await expect(proxyAwareFetch('file:///etc/passwd?X-Amz-Signature=leak')).rejects.toThrow(
      /^(?!.*X-Amz-Signature).*$/s
    );
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
