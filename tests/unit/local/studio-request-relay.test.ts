import { describe, it, expect, vi } from 'vite-plus/test';
import { relayServeRequest } from '../../../src/local/studio-request-relay.js';

/** A minimal Response stand-in for the injected fetchFn. */
function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): Response {
  return {
    status,
    text: () => Promise.resolve(body),
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
  } as unknown as Response;
}

describe('relayServeRequest', () => {
  it('joins base + path, forwards method / headers / body, returns the response', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(fakeResponse(201, 'created', { etag: 'abc' })));
    const clock = (() => {
      let t = 1000;
      return () => (t += 5);
    })();
    const result = await relayServeRequest(
      {
        baseUrl: 'http://127.0.0.1:51234/',
        method: 'post',
        path: 'items',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      },
      fetchFn as unknown as typeof fetch,
      clock
    );

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:51234/items'); // no doubled / dropped slash
    expect(init.method).toBe('POST'); // upper-cased
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.body).toBe('{"a":1}');
    expect(result).toEqual({
      status: 201,
      headers: { etag: 'abc' },
      body: 'created',
      truncated: false,
      durationMs: 5,
    });
  });

  it('defaults the path to / and omits a body on GET', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(fakeResponse(200, 'ok')));
    await relayServeRequest(
      { baseUrl: 'http://127.0.0.1:9/', method: 'GET', body: 'ignored' },
      fetchFn as unknown as typeof fetch
    );
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9/');
    expect('body' in init).toBe(false); // GET never carries the body
  });

  it('returns an HTTP error status as a NORMAL result (does not throw)', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(fakeResponse(503, 'down')));
    const result = await relayServeRequest(
      { baseUrl: 'http://x/', method: 'GET' },
      fetchFn as unknown as typeof fetch
    );
    expect(result.status).toBe(503);
    expect(result.body).toBe('down');
  });

  it('truncates an over-cap response body and flags it', async () => {
    const big = 'x'.repeat(100);
    const fetchFn = vi.fn(() => Promise.resolve(fakeResponse(200, big)));
    const result = await relayServeRequest(
      { baseUrl: 'http://x/', method: 'GET', maxBodyChars: 10 },
      fetchFn as unknown as typeof fetch
    );
    expect(result.truncated).toBe(true);
    expect(result.body).toBe('xxxxxxxxxx\n…[truncated]');
  });

  it('propagates a network / abort error from the fetch', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(
      relayServeRequest({ baseUrl: 'http://x/', method: 'GET' }, fetchFn as unknown as typeof fetch)
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('aborts via the timeout signal when the upstream hangs', async () => {
    // A fetchFn that never resolves until its abort signal fires — exercises
    // the setTimeout -> controller.abort() -> reject path (and clearTimeout in
    // the finally).
    const fetchFn = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    await expect(
      relayServeRequest(
        { baseUrl: 'http://x/', method: 'GET', timeoutMs: 1 },
        fetchFn as unknown as typeof fetch
      )
    ).rejects.toThrow(/aborted/);
  });
});
