import { describe, expect, it, vi } from 'vite-plus/test';
import {
  mcpInvokeOnce,
  parseSseForJsonRpc,
  MCP_PATH,
} from '../../../src/local/agentcore-mcp-client.js';

interface Captured {
  url: string;
  body: { jsonrpc: string; id?: number; method: string; params?: unknown };
  headers: Record<string, string>;
}

/**
 * A minimal in-memory MCP Streamable-HTTP server. Replies to `initialize`
 * (optionally assigning a session id), `notifications/initialized` (202), and
 * the request method (JSON or SSE), capturing every call for assertions.
 */
function makeServer(opts: {
  sessionId?: string;
  sse?: boolean;
  requestResponse?: unknown;
  failInitializeTimes?: number;
}): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let initFailsLeft = opts.failInitializeTimes ?? 0;

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> });

    if (body.method === 'initialize') {
      if (initFailsLeft > 0) {
        initFailsLeft -= 1;
        const err = new TypeError('fetch failed');
        (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18' } }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(opts.sessionId ? { 'mcp-session-id': opts.sessionId } : {}),
          },
        }
      );
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    const payload = opts.requestResponse ?? {
      jsonrpc: '2.0',
      id: body.id,
      result: { tools: [{ name: 'add_numbers' }] },
    };
    if (opts.sse) {
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

describe('mcpInvokeOnce', () => {
  it('runs initialize -> notifications/initialized -> request and returns the JSON response', async () => {
    const { fetchImpl, calls } = makeServer({ sessionId: 'sess-123' });

    const result = await mcpInvokeOnce(
      '127.0.0.1',
      8000,
      { method: 'tools/list', params: {} },
      { fetchImpl }
    );

    expect(result.ok).toBe(true);
    expect(result.raw).toContain('add_numbers');

    // Three POSTs, all to /mcp, in lifecycle order.
    expect(calls.map((c) => c.body.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(calls.every((c) => c.url.endsWith(MCP_PATH))).toBe(true);

    // initialize MUST NOT carry a session id (none exists yet).
    expect(calls[0]?.headers['Mcp-Session-Id']).toBeUndefined();
    // Post-initialize calls echo the assigned session id + the protocol version.
    expect(calls[1]?.headers['Mcp-Session-Id']).toBe('sess-123');
    expect(calls[2]?.headers['Mcp-Session-Id']).toBe('sess-123');
    expect(calls[2]?.headers['MCP-Protocol-Version']).toBe('2025-06-18');

    // The request body is a well-formed JSON-RPC request with an id.
    expect(calls[2]?.body).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  });

  it('parses a text/event-stream response (server may pick SSE)', async () => {
    const { fetchImpl } = makeServer({ sessionId: 'sess-1', sse: true });
    const result = await mcpInvokeOnce('127.0.0.1', 8000, { method: 'tools/list' }, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.raw).toContain('add_numbers');
  });

  it('works against a stateless server that omits Mcp-Session-Id', async () => {
    const { fetchImpl, calls } = makeServer({}); // no sessionId
    const result = await mcpInvokeOnce('127.0.0.1', 8000, { method: 'tools/list' }, { fetchImpl });
    expect(result.ok).toBe(true);
    // No session id was assigned, so none is echoed.
    expect(calls[2]?.headers['Mcp-Session-Id']).toBeUndefined();
  });

  it('forwards a tools/call method + params verbatim', async () => {
    const { fetchImpl, calls } = makeServer({ sessionId: 's' });
    await mcpInvokeOnce(
      '127.0.0.1',
      8000,
      { method: 'tools/call', params: { name: 'add_numbers', arguments: { a: 1, b: 2 } } },
      { fetchImpl }
    );
    expect(calls[2]?.body).toMatchObject({
      method: 'tools/call',
      params: { name: 'add_numbers', arguments: { a: 1, b: 2 } },
    });
  });

  it('reports a JSON-RPC error response as not ok', async () => {
    const { fetchImpl } = makeServer({
      sessionId: 's',
      requestResponse: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
    });
    const result = await mcpInvokeOnce('127.0.0.1', 8000, { method: 'bogus' }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.raw).toContain('Method not found');
  });

  it('retries a transient connect failure on initialize while the container boots', async () => {
    const { fetchImpl, calls } = makeServer({ sessionId: 's', failInitializeTimes: 1 });
    const result = await mcpInvokeOnce('127.0.0.1', 8000, { method: 'tools/list' }, { fetchImpl });
    expect(result.ok).toBe(true);
    // Two initialize attempts (one refused, one ok) + initialized + request.
    expect(calls.filter((c) => c.body.method === 'initialize').length).toBe(2);
  });

  it('throws a clear readiness error when initialize never succeeds in time', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new TypeError('fetch failed');
      (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      throw err;
    }) as unknown as typeof fetch;
    await expect(
      mcpInvokeOnce('127.0.0.1', 8000, { method: 'tools/list' }, { fetchImpl, readyTimeoutMs: 200 })
    ).rejects.toThrow(/did not become ready/);
  });
});

describe('parseSseForJsonRpc', () => {
  it('returns the frame whose JSON-RPC id matches', () => {
    const text =
      'event: message\ndata: {"jsonrpc":"2.0","id":9,"result":{"v":1}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"v":2}}\n\n';
    expect(parseSseForJsonRpc(text, 1)).toMatchObject({ id: 1, result: { v: 2 } });
  });

  it('falls back to the last parseable frame when no id matches', () => {
    const text = 'data: {"jsonrpc":"2.0","id":7,"result":{"v":3}}\n\n';
    expect(parseSseForJsonRpc(text, 1)).toMatchObject({ id: 7 });
  });

  it('ignores non-JSON data lines', () => {
    const text = 'data: : keep-alive\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    expect(parseSseForJsonRpc(text, 1)).toMatchObject({ id: 1 });
  });
});
