/**
 * go-to-k/cdk-local#948: while a debugger is attached the RIE invoke deadline
 * is lifted far past undici's 300 s `headersTimeout` / `bodyTimeout`, which
 * Node's global `fetch` would hit at a long breakpoint pause (a `fetch failed`
 * the startup retry would then re-POST). A deadline past 300 s goes through
 * `node:http` instead, which has no client-side timeout; a shorter one keeps
 * `fetch`.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { invokeRie, invokeRieStreaming } from '../../../src/local/rie-client.js';

let server: Server;
let port: number;
const seen: { method?: string; body?: string; mode?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({
        method: req.method,
        body,
        mode: req.headers['lambda-runtime-function-response-mode'] as string | undefined,
      });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  seen.length = 0;
});

describe('RIE invoke transport by deadline', () => {
  it('a deadline past 300 s does not use fetch, and still returns the payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await invokeRie('127.0.0.1', port, { a: 1 }, 72_000_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.payload).toEqual({ ok: true });
    expect(seen).toEqual([{ method: 'POST', body: '{"a":1}', mode: undefined }]);
  });

  it('the streaming invoke past 300 s does not use fetch either and keeps its header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await invokeRieStreaming('127.0.0.1', port, {}, 72_000_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen[0]?.mode).toBe('streaming');
  });

  it('a regular deadline keeps fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await invokeRie('127.0.0.1', port, {}, 30_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.payload).toEqual({ ok: true });
  });
});
