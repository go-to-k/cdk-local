import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AGENTCORE_SESSION_ID_HEADER,
  invokeAgentCore,
  waitForAgentCorePing,
  waitForAgentCoreHttpReady,
} from '../../../src/local/agentcore-client.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Build a `text/event-stream` Response whose body emits `chunks` in order. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

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

describe('waitForAgentCoreHttpReady', () => {
  it('POSTs the probe path and returns once ANY HTTP status is received', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:8000/mcp');
      expect(init.method).toBe('POST');
      // A 4xx for the probe's empty body still proves the server is up.
      return new Response('bad request', { status: 400 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForAgentCoreHttpReady('127.0.0.1', 8000, '/mcp', 2000)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('retries transient connection errors until an HTTP response arrives', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new TypeError('fetch failed');
        (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForAgentCoreHttpReady('127.0.0.1', 9000, '/', 2000)).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('throws on timeout when the container never accepts a connection', async () => {
    const fetchMock = vi.fn(async () => {
      const err = new TypeError('fetch failed');
      (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      throw err;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForAgentCoreHttpReady('127.0.0.1', 8000, '/mcp', 250)).rejects.toThrow(
      /did not become ready/
    );
  });

  it('rethrows a non-transient error immediately without retrying', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('boom: not a connect error');
    });
    vi.stubGlobal('fetch', fetchMock);
    // A non-transient failure is fatal — it propagates as-is (not wrapped in
    // "did not become ready") and the probe does not keep retrying.
    await expect(waitForAgentCoreHttpReady('127.0.0.1', 8000, '/mcp', 2000)).rejects.toThrow(
      /boom: not a connect error/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(result.streamed).toBe(false);
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

  it('buffers a JSON response into raw (streamed=false) even when an onChunk sink is given', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"response":"hi"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const received: string[] = [];
    const result = await invokeAgentCore('127.0.0.1', 9000, {}, {
      sessionId: 's',
      timeoutMs: 5000,
      onChunk: (t) => received.push(t),
    });

    expect(received).toEqual([]); // non-SSE → not streamed
    expect(result.streamed).toBe(false);
    expect(result.raw).toBe('{"response":"hi"}');
  });

  it('streams an SSE body chunk-by-chunk through onChunk in arrival order', async () => {
    const chunks = ['data: {"token":"a"}\n\n', 'data: {"token":"b"}\n\n', 'data: [DONE]\n\n'];
    const fetchMock = vi.fn(async () => sseResponse(chunks));
    vi.stubGlobal('fetch', fetchMock);

    const received: string[] = [];
    const result = await invokeAgentCore('127.0.0.1', 9000, {}, {
      sessionId: 's',
      timeoutMs: 5000,
      onChunk: (t) => received.push(t),
    });

    expect(received).toEqual(chunks);
    expect(result.streamed).toBe(true);
    expect(result.raw).toBe('');
    expect(result.contentType).toBe('text/event-stream');
  });

  it('buffers an SSE body into raw (streamed=false) when no onChunk sink is given', async () => {
    const sse = 'data: {"event":"a"}\ndata: {"event":"b"}\n';
    const fetchMock = vi.fn(async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await invokeAgentCore('127.0.0.1', 9000, {}, { sessionId: 's', timeoutMs: 5000 });
    expect(result.contentType).toBe('text/event-stream');
    expect(result.raw).toBe(sse);
    expect(result.streamed).toBe(false);
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
