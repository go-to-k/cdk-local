import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AGENTCORE_SESSION_ID_HEADER,
  invokeAgentCore,
  waitForAgentCorePing,
} from '../../../src/local/agentcore-client.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('waitForAgentCorePing', () => {
  it('returns once GET /ping responds 200', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:9000/ping');
      return new Response('{"status":"Healthy"}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForAgentCorePing('127.0.0.1', 9000, 2000)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('keeps polling while /ping is non-2xx, then throws on timeout', async () => {
    const fetchMock = vi.fn(async () => new Response('warming', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForAgentCorePing('127.0.0.1', 9000, 250)).rejects.toThrow(
      /did not become ready/
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it('retries transient connection errors', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new TypeError('fetch failed');
        (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      return new Response('{"status":"Healthy"}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForAgentCorePing('127.0.0.1', 9000, 2000)).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('invokeAgentCore', () => {
  it('POSTs the event with the session-id header + JSON content type and returns the body', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response('{"response":"hi","status":"success"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await invokeAgentCore('127.0.0.1', 9000, { prompt: 'hello' }, {
      sessionId: 'session-1234567890abcdefghijklmnopqrstuv',
      timeoutMs: 5000,
    });

    expect(captured?.url).toBe('http://127.0.0.1:9000/invocations');
    expect(captured?.init.method).toBe('POST');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers[AGENTCORE_SESSION_ID_HEADER]).toBe(
      'session-1234567890abcdefghijklmnopqrstuv'
    );
    expect(captured?.init.body).toBe('{"prompt":"hello"}');
    expect(headers['Authorization']).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/json');
    expect(result.raw).toBe('{"response":"hi","status":"success"}');
  });

  it('forwards the Authorization header when supplied', async () => {
    let captured: { init: RequestInit } | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      captured = { init };
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await invokeAgentCore('127.0.0.1', 9000, {}, {
      sessionId: 's',
      timeoutMs: 5000,
      authorization: 'Bearer the.jwt.token',
    });

    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer the.jwt.token');
  });

  it('passes an SSE response body through verbatim', async () => {
    const sse = 'data: {"event":"a"}\ndata: {"event":"b"}\n';
    const fetchMock = vi.fn(async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await invokeAgentCore('127.0.0.1', 9000, {}, { sessionId: 's', timeoutMs: 5000 });
    expect(result.contentType).toBe('text/event-stream');
    expect(result.raw).toBe(sse);
  });

  it('maps an aborted request (timeout) to a clear timeout error', async () => {
    // The abort fires while the request (or its body read) is in flight; the
    // client surfaces it as a timeout rather than a raw AbortError.
    const fetchMock = vi.fn(async () => {
      const err = new Error('The operation was aborted');
      (err as { name?: string }).name = 'AbortError';
      throw err;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      invokeAgentCore('127.0.0.1', 9000, {}, { sessionId: 's', timeoutMs: 50 })
    ).rejects.toThrow(/timed out after 50ms/);
  });
});
