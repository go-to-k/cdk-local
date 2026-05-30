import { describe, expect, it, vi } from 'vite-plus/test';
import {
  a2aInvokeOnce,
  A2A_CONTAINER_PORT,
  A2A_PATH,
} from '../../../src/local/agentcore-a2a-client.js';

describe('a2aInvokeOnce', () => {
  it('POSTs the JSON-RPC request to / and returns the parsed JSON response', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`http://127.0.0.1:${A2A_CONTAINER_PORT}${A2A_PATH}`);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      const sent = JSON.parse(String(init?.body));
      expect(sent.jsonrpc).toBe('2.0');
      expect(sent.method).toBe('agent/getCard');
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { name: 'my-agent', version: '1' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const result = await a2aInvokeOnce(
      '127.0.0.1',
      A2A_CONTAINER_PORT,
      { method: 'agent/getCard' },
      { fetchImpl }
    );
    expect(result.ok).toBe(true);
    expect(result.raw).toContain('"name": "my-agent"');
  });

  it('reports ok=false when the response carries a top-level JSON-RPC error', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'method not found' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const result = await a2aInvokeOnce(
      '127.0.0.1',
      A2A_CONTAINER_PORT,
      { method: 'bogus' },
      { fetchImpl }
    );
    expect(result.ok).toBe(false);
    expect(result.raw).toContain('"method not found"');
  });

  it('retries transient TypeError "fetch failed" during the readiness window', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt < 2) {
        const err = new TypeError('fetch failed');
        (err as { cause?: { code?: string } }).cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await a2aInvokeOnce(
      '127.0.0.1',
      A2A_CONTAINER_PORT,
      { method: 'agent/getCard' },
      { fetchImpl, readyTimeoutMs: 5_000 }
    );
    expect(result.ok).toBe(true);
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  it('throws with a clear "did not become ready" message when the readiness window expires', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new TypeError('fetch failed');
      (err as { cause?: { code?: string } }).cause = { code: 'ECONNREFUSED' };
      throw err;
    });
    await expect(
      a2aInvokeOnce(
        '127.0.0.1',
        A2A_CONTAINER_PORT,
        { method: 'agent/getCard' },
        { fetchImpl, readyTimeoutMs: 200 }
      )
    ).rejects.toThrow(/did not become ready/);
  });

  it('retries while the server returns 5xx during the readiness window', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt < 2) {
        return new Response('starting', { status: 503 });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ready' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await a2aInvokeOnce(
      '127.0.0.1',
      A2A_CONTAINER_PORT,
      { method: 'agent/getCard' },
      { fetchImpl, readyTimeoutMs: 5_000 }
    );
    expect(result.ok).toBe(true);
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  it('omits params from the JSON-RPC body when not supplied', async () => {
    let sent: { params?: unknown } = {};
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await a2aInvokeOnce(
      '127.0.0.1',
      A2A_CONTAINER_PORT,
      { method: 'agent/getCard' },
      { fetchImpl }
    );
    expect('params' in sent).toBe(false);
  });
});
