import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  buildOriginRequestHeaders,
  serveWebFunctionOrigin,
} from '../../../src/local/cloudfront-web-function-origin.js';

// A plain HTTP server standing in for the web function revision's server.
let upstream: Server;
let port: number;
const seen: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }[] =
  [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/slow') return; // never answers
      res.statusCode = 201;
      res.setHeader('content-type', 'text/plain');
      res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
      res.setHeader('x-multi', ['one', 'two']);
      res.setHeader('connection', 'close');
      res.end(`echo:${req.method}`);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const addr = upstream.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('serveWebFunctionOrigin', () => {
  it('forwards method, path, query, body and the viewer headers; flattens the response', async () => {
    const result = await serveWebFunctionOrigin({
      target: { host: '127.0.0.1', port },
      request: {
        method: 'POST',
        uri: '/api/items',
        querystring: 'q=1&r=2',
        headers: {
          host: 'd111.cloudfront.net',
          'x-custom': 'yes',
          'x-forwarded-for': '10.0.0.1',
          connection: 'keep-alive, x-drop-me',
          'x-drop-me': 'gone',
          'transfer-encoding': 'chunked',
          'content-length': '999',
        },
        body: Buffer.from('payload'),
        sourceIp: '192.0.2.7',
      },
    });
    const req = seen.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/items?q=1&r=2');
    expect(req.body).toBe('payload');
    expect(req.headers['host']).toBe(`127.0.0.1:${port}`);
    expect(req.headers['x-custom']).toBe('yes');
    expect(req.headers['x-forwarded-for']).toBe('10.0.0.1, 192.0.2.7');
    expect(req.headers['x-drop-me']).toBeUndefined();
    expect(req.headers['transfer-encoding']).toBeUndefined();
    expect(req.headers['content-length']).toBe('7');

    expect(result.statusCode).toBe(201);
    expect(result.body.toString('utf8')).toBe('echo:POST');
    expect(result.cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(result.headers['content-type']).toBe('text/plain');
    expect(result.headers['x-multi']).toBe('one, two');
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['connection']).toBeUndefined();
    expect(result.headers['content-length']).toBeUndefined();
  });

  it('sends no body on a bodiless request', async () => {
    await serveWebFunctionOrigin({
      target: { host: '127.0.0.1', port },
      request: { method: 'GET', uri: '/', querystring: '', headers: {}, body: Buffer.alloc(0) },
    });
    const req = seen.at(-1)!;
    expect(req.url).toBe('/');
    expect(req.body).toBe('');
    expect(req.headers['content-length']).toBeUndefined();
    expect(req.headers['x-forwarded-for']).toBeUndefined();
  });

  it('answers 502 when nothing listens on the target', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const addr = closed.address();
    const deadPort = typeof addr === 'object' && addr ? addr.port : 0;
    await new Promise<void>((r) => closed.close(() => r()));
    const result = await serveWebFunctionOrigin({
      target: { host: '127.0.0.1', port: deadPort },
      request: { method: 'GET', uri: '/', querystring: '', headers: {}, body: Buffer.alloc(0) },
    });
    expect(result.statusCode).toBe(502);
    expect(result.body.toString('utf8')).toMatch(/^Bad Gateway: /);
  });

  it('answers 504 when the server does not answer within the read timeout', async () => {
    const result = await serveWebFunctionOrigin({
      target: { host: '127.0.0.1', port },
      request: { method: 'GET', uri: '/slow', querystring: '', headers: {}, body: Buffer.alloc(0) },
      readTimeoutSeconds: 0.2,
    });
    expect(result.statusCode).toBe(504);
    expect(result.body.toString('utf8')).toContain('origin read timeout (0.2s)');
  });
});

describe('buildOriginRequestHeaders', () => {
  it('brackets an IPv6 target in Host and keeps an array header', () => {
    const headers = buildOriginRequestHeaders(
      { headers: { accept: ['a', 'b'] } },
      { host: '::1', port: 8080 }
    );
    expect(headers).toEqual({ accept: ['a', 'b'], host: '[::1]:8080' });
  });
});
