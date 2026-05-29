import { setTimeout as delay } from 'node:timers/promises';

/**
 * Client for the Bedrock AgentCore Runtime MCP protocol contract.
 *
 * An MCP-protocol AgentCore Runtime container listens on `0.0.0.0:8000` and
 * serves the Model Context Protocol over **Streamable HTTP** at `POST /mcp`
 * (no `GET /ping` — unlike the HTTP protocol). Each JSON-RPC message is its
 * own POST. `cdkl invoke-agentcore` performs the minimal session lifecycle:
 *
 *   1. `initialize`            — negotiate; the server MAY return an
 *                                `Mcp-Session-Id` header to echo thereafter.
 *   2. `notifications/initialized` — required before any request (202, no body).
 *   3. one request             — `tools/list` by default, or the method/params
 *                                from `--event` (e.g. `tools/call`).
 *
 * Talking to the local container is **vanilla MCP**: the
 * `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header and the inbound OAuth
 * bearer are AgentCore managed-plane concerns the front door maps to MCP's own
 * `Mcp-Session-Id`, so a direct local client does not send them.
 */

/** Container port an MCP-protocol AgentCore Runtime listens on. */
export const MCP_CONTAINER_PORT = 8000;
/** HTTP path of the MCP Streamable-HTTP endpoint. */
export const MCP_PATH = '/mcp';
/** MCP protocol version this client negotiates. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const SESSION_ID_HEADER = 'mcp-session-id';
const PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';

/** A JSON-RPC request to send after the handshake (id + jsonrpc are added). */
export interface McpJsonRpcRequest {
  method: string;
  params?: unknown;
}

export interface McpInvokeResult {
  /** True when the JSON-RPC response carried no top-level `error`. */
  ok: boolean;
  /** The JSON-RPC response message, pretty-printed for display. */
  raw: string;
}

export interface McpInvokeOptions {
  /**
   * Total ms to keep retrying the initial `initialize` POST while the
   * container boots (MCP has no `/ping`, so a successful initialize IS the
   * readiness signal). Default 30s.
   */
  readyTimeoutMs?: number;
  /** Per-request abort timeout once the server is reachable. Default 120s. */
  requestTimeoutMs?: number;
  /** Injected `fetch` for tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * Run the MCP session lifecycle against a local container and return the
 * single request's JSON-RPC response. The initial `initialize` POST is
 * retried for `readyTimeoutMs` to absorb container boot (there is no separate
 * readiness endpoint), so this also serves as the wait-for-ready step.
 */
export async function mcpInvokeOnce(
  host: string,
  port: number,
  request: McpJsonRpcRequest,
  options: McpInvokeOptions = {}
): Promise<McpInvokeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `http://${host}:${port}${MCP_PATH}`;
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;

  const sessionId = await initializeWithRetry(fetchImpl, url, options.readyTimeoutMs ?? 30_000);

  await postMcp(
    fetchImpl,
    url,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    sessionId,
    requestTimeoutMs
  );

  const result = await postMcp(
    fetchImpl,
    url,
    {
      jsonrpc: '2.0',
      id: 1,
      method: request.method,
      ...(request.params !== undefined && { params: request.params }),
    },
    sessionId,
    requestTimeoutMs
  );

  const message = result.message;
  const ok = !(message !== null && typeof message === 'object' && 'error' in message);
  return { ok, raw: JSON.stringify(message ?? null, null, 2) };
}

/**
 * POST `initialize`, retrying transient connect failures until the container
 * is up or `readyTimeoutMs` elapses. Returns the `Mcp-Session-Id` the server
 * assigned (undefined for a stateless server that omits it).
 */
async function initializeWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  readyTimeoutMs: number
): Promise<string | undefined> {
  const deadline = Date.now() + readyTimeoutMs;
  const body = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'cdkl', version: '1' },
    },
  };
  let lastDetail = '';

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      await response.text().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) {
        return response.headers.get(SESSION_ID_HEADER) ?? undefined;
      }
      // A reachable-but-non-2xx initialize is treated as "up but not ready to
      // handle the protocol yet" (e.g. a framework still wiring its /mcp
      // route) and retried like a connect error — mirroring how the HTTP
      // path's GET /ping retries a non-2xx while the server warms up. The last
      // status is surfaced in the readiness error if the window expires.
      lastDetail = `initialize returned HTTP ${response.status}`;
      throw new Error(lastDetail);
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        // A non-transient error after the server is reachable is fatal.
        if (lastDetail) {
          throw new Error(
            `MCP initialize at ${url} failed: ${lastDetail}. Check 'docker logs' output.`
          );
        }
        throw err;
      }
      lastDetail = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    await delay(150);
  }

  throw new Error(
    `MCP server did not become ready on ${url} within ${readyTimeoutMs}ms` +
      `${lastDetail ? `: ${lastDetail}` : ''}. ` +
      `The container may have exited early or may not serve POST ${MCP_PATH} — check 'docker logs'.`
  );
}

/**
 * POST one JSON-RPC message and, for a request (one with an `id`), return the
 * parsed JSON-RPC response — handling both an `application/json` body and a
 * `text/event-stream` (the server picks either per the Streamable-HTTP spec).
 * A notification (no `id`) returns 202 with no body and yields no message.
 */
async function postMcp(
  fetchImpl: typeof fetch,
  url: string,
  body: { jsonrpc: string; id?: number; method: string; params?: unknown },
  sessionId: string | undefined,
  timeoutMs: number
): Promise<{ status: number; message?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        [PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION,
        ...(sessionId && { 'Mcp-Session-Id': sessionId }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    // Notification: no response payload to parse (server returns 202).
    if (body.id === undefined) return { status: response.status };

    const contentType = response.headers.get('content-type') ?? '';
    const message = contentType.includes('text/event-stream')
      ? parseSseForJsonRpc(text, body.id)
      : text
        ? safeJsonParse(text)
        : undefined;
    return { status: response.status, message };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(
        `MCP request '${body.method}' at ${url} timed out after ${timeoutMs}ms. ` +
          `The server may be hung; check container logs.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the JSON-RPC message matching `id` from an SSE body. Frames are
 * separated by blank lines; a frame's `data:` lines are concatenated and
 * parsed as JSON. Returns the id-matching message, else the last parseable
 * one (servers typically send a single frame carrying the response).
 */
export function parseSseForJsonRpc(text: string, id: number): unknown {
  let last: unknown;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) continue;
    const parsed = safeJsonParse(data);
    if (parsed === undefined) continue;
    last = parsed;
    if (parsed !== null && typeof parsed === 'object' && (parsed as { id?: unknown }).id === id) {
      return parsed;
    }
  }
  return last;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * `fetch()` failures during container boot manifest as a generic
 * `TypeError: fetch failed` whose `.cause` carries the underlying
 * `ECONNRESET` / `ECONNREFUSED` / `UND_ERR_SOCKET`; an `AbortError` is the
 * per-attempt timeout. Treat all of those — plus the synthetic non-2xx retry
 * — as "not ready, retry".
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  if (err.name === 'TypeError' && err.message === 'fetch failed') return true;
  if (err.message.startsWith('initialize returned HTTP')) return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === 'ECONNRESET') return true;
  if (cause?.code === 'ECONNREFUSED') return true;
  if (cause?.code === 'UND_ERR_SOCKET') return true;
  return false;
}
