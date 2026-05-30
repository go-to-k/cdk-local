import { setTimeout as delay } from 'node:timers/promises';

/**
 * Client for the Bedrock AgentCore Runtime A2A protocol contract.
 *
 * An A2A-protocol AgentCore Runtime container listens on `0.0.0.0:9000` and
 * serves the Agent2Agent JSON-RPC 2.0 contract at `POST /` (the root). Each
 * call is one JSON-RPC request and one JSON-RPC response. Unlike MCP there is
 * no session lifecycle to negotiate — the request is sent directly. `cdkl
 * invoke-agentcore` POSTs the method/params from `--event` (defaults to
 * `agent/getCard`, the agent's discovery card) and prints the response.
 *
 * Talking to the local container is **vanilla A2A**: the
 * `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header and the inbound OAuth
 * bearer are AgentCore managed-plane concerns the front door layers on top,
 * so a direct local client does not send them.
 */

/** Container port an A2A-protocol AgentCore Runtime listens on. */
export const A2A_CONTAINER_PORT = 9000;
/** HTTP path of the A2A JSON-RPC endpoint. */
export const A2A_PATH = '/';

/** A JSON-RPC request to send to an A2A agent (id + jsonrpc are added). */
export interface A2aJsonRpcRequest {
  method: string;
  params?: unknown;
}

export interface A2aInvokeResult {
  /** True when the JSON-RPC response carried no top-level `error`. */
  ok: boolean;
  /** The JSON-RPC response message, pretty-printed for display. */
  raw: string;
}

export interface A2aInvokeOptions {
  /**
   * Total ms to keep retrying the POST while the container boots (A2A has no
   * dedicated readiness endpoint, so a successful POST IS the readiness
   * signal). Default 30s.
   */
  readyTimeoutMs?: number;
  /** Per-request abort timeout once the server is reachable. Default 120s. */
  requestTimeoutMs?: number;
  /** Injected `fetch` for tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * Send one JSON-RPC request to a local A2A container and return the parsed
 * response. The POST is retried while the container boots (there is no
 * separate readiness endpoint), so this also serves as the wait-for-ready step.
 */
export async function a2aInvokeOnce(
  host: string,
  port: number,
  request: A2aJsonRpcRequest,
  options: A2aInvokeOptions = {}
): Promise<A2aInvokeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `http://${host}:${port}${A2A_PATH}`;
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: request.method,
    ...(request.params !== undefined && { params: request.params }),
  };

  const message = await postWithReadyRetry(fetchImpl, url, body, requestTimeoutMs, readyTimeoutMs);
  const ok = !(message !== null && typeof message === 'object' && 'error' in message);
  return { ok, raw: JSON.stringify(message ?? null, null, 2) };
}

/**
 * POST a JSON-RPC message, retrying transient connect failures + reachable-
 * but-non-2xx responses until the container is up. The retry window is
 * `readyTimeoutMs`; the per-attempt abort during the readiness window is 5s
 * (so a stuck POST doesn't blow the whole window). Once the window expires
 * any further failure is fatal.
 *
 * On the first successful 2xx response the body is parsed and returned. A
 * proper request-level timeout (`requestTimeoutMs`) would only matter once
 * one good POST has completed; in v1 we only have a single round-trip per
 * invocation, so the 5s readiness abort is sufficient — the post-ready
 * timeout is unused here but kept for symmetry with the MCP client API.
 */
async function postWithReadyRetry(
  fetchImpl: typeof fetch,
  url: string,
  body: { jsonrpc: string; id: number; method: string; params?: unknown },
  requestTimeoutMs: number,
  readyTimeoutMs: number
): Promise<unknown> {
  const deadline = Date.now() + readyTimeoutMs;
  let lastDetail = '';

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(5_000, requestTimeoutMs));
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status >= 200 && response.status < 300) {
        return text ? safeJsonParse(text) : undefined;
      }
      // Reachable-but-non-2xx during the readiness window is treated as
      // "framework still wiring its / route" (mirroring MCP); after the
      // window it bubbles out as the final error below.
      lastDetail = `A2A POST returned HTTP ${response.status}`;
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err;
      lastDetail = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    await delay(150);
  }

  throw new Error(
    `A2A server did not become ready on ${url} within ${readyTimeoutMs}ms` +
      `${lastDetail ? `: ${lastDetail}` : ''}. ` +
      `The container may have exited early or may not serve POST ${A2A_PATH} — check 'docker logs'.`
  );
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  if (err.name === 'TypeError' && err.message === 'fetch failed') return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === 'ECONNRESET') return true;
  if (cause?.code === 'ECONNREFUSED') return true;
  if (cause?.code === 'UND_ERR_SOCKET') return true;
  return false;
}
