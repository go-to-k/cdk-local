import { setTimeout as delay } from 'node:timers/promises';

/**
 * HTTP client for the Bedrock AgentCore Runtime container contract.
 *
 * An AgentCore agent container listens on `0.0.0.0:8080` and exposes two
 * endpoints (AgentCore contract constants — they are NOT in the CFn
 * template):
 *
 *   GET  /ping         → 200 + `{"status":"Healthy"|"HealthyBusy",...}`
 *   POST /invocations  → JSON or SSE response for an arbitrary JSON body
 *
 * Unlike the Lambda path there is no Runtime Interface Emulator — this is
 * plain HTTP. `cdkl invoke-agentcore` runs the container, waits for `/ping`,
 * then POSTs one event to `/invocations` (invoke-once).
 */

const PING_PATH = '/ping';
const INVOCATIONS_PATH = '/invocations';

/**
 * Header AgentCore Runtime uses to carry the session id to the container.
 * Real AgentCore always sends it; we generate one (or pass the user's
 * `--session-id`) so agents that read it behave as they do in the cloud.
 */
export const AGENTCORE_SESSION_ID_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';

export interface AgentCoreInvokeResult {
  /** HTTP status code of the `/invocations` response. */
  status: number;
  /** Response `Content-Type` (e.g. `application/json` or `text/event-stream`), or null. */
  contentType: string | null;
  /**
   * Response body for the buffered path — JSON or SSE passed through verbatim.
   * Empty when {@link streamed} is true (the body was delivered chunk-by-chunk
   * via {@link InvokeAgentCoreOptions.onChunk} instead of buffered).
   */
  raw: string;
  /**
   * True when a `text/event-stream` body was streamed incrementally through
   * {@link InvokeAgentCoreOptions.onChunk} (already emitted; `raw` is empty);
   * false for the buffered path.
   */
  streamed: boolean;
}

/**
 * Wait until the agent's `GET /ping` returns a 2xx on `host:port`, or
 * throw after `timeoutMs`.
 *
 * Docker's port forwarder accepts TCP as soon as `-p` binds, before the
 * agent's HTTP server is up, so a TCP probe would declare ready too early.
 * We probe `/ping` and treat only a 2xx as ready; connect/reset/abort and
 * any non-2xx status (the server is up but still warming) are retried.
 * Agent frameworks can be slow to import, so the default window is wider
 * than the Lambda RIE probe's.
 */
export async function waitForAgentCorePing(
  host: string,
  port: number,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = '';

  while (Date.now() < deadline) {
    try {
      const status = await pingProbe(host, port, 1000);
      if (status !== undefined) {
        if (status >= 200 && status < 300) {
          // Short settle: even after a 200, the very next request can race
          // the server on a cold daemon. Cheap insurance.
          await delay(150);
          return;
        }
        lastDetail = `last /ping status ${status}`;
      }
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    }
    await delay(150);
  }

  const tail = lastDetail ? `: ${lastDetail}` : '';
  throw new Error(
    `AgentCore agent did not become ready on ${host}:${port} within ${timeoutMs}ms${tail}. ` +
      `The container may have exited early or may not serve GET ${PING_PATH} — check 'docker logs' output.`
  );
}

/**
 * Issue `GET /ping`. Returns the HTTP status on any response, undefined on
 * a transient connect/reset/abort (treated as "not ready yet"). Other
 * error classes (e.g. DNS) propagate.
 */
async function pingProbe(
  host: string,
  port: number,
  timeoutMs: number
): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}${PING_PATH}`, {
      method: 'GET',
      signal: controller.signal,
    });
    await response.text().catch(() => undefined);
    return response.status;
  } catch (err) {
    if (isTransientNetworkError(err)) return undefined;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetch()` failures during container boot manifest as a generic
 * `TypeError: fetch failed` whose `.cause` carries the underlying Node
 * `ECONNRESET` / `ECONNREFUSED` / `UND_ERR_SOCKET`. Treat all of those —
 * plus an `AbortError` from the per-probe timeout — as "not ready, retry".
 */
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

export interface InvokeAgentCoreOptions {
  /** Value for the {@link AGENTCORE_SESSION_ID_HEADER} request header. */
  sessionId: string;
  /** Abort the request after this many ms. */
  timeoutMs: number;
  /**
   * Optional `Authorization` header to forward (e.g. `Bearer <jwt>`). Real
   * AgentCore forwards the validated request to the container, so agents
   * that read the header behave the same locally. Omitted when unset.
   */
  authorization?: string;
  /**
   * Sink for incremental `text/event-stream` output. When provided AND the
   * response Content-Type is `text/event-stream`, the body is decoded and
   * streamed chunk-by-chunk through this callback as it arrives — matching the
   * incremental UX AgentCore gives in the cloud — instead of being buffered.
   * The result then has `streamed: true` and an empty `raw`. For a non-SSE
   * response (or when omitted), the body is buffered into `raw` as before.
   */
  onChunk?: (text: string) => void;
}

/**
 * POST the event body to the agent's `/invocations` endpoint with the
 * session-id header and a JSON content type, then return the response.
 *
 * A `text/event-stream` response is streamed incrementally through
 * `options.onChunk` (when given) so the user sees tokens as they arrive — the
 * result is then `streamed: true` with an empty `raw`. Any other response (or
 * a missing sink) is buffered into `raw` and returned verbatim.
 */
export async function invokeAgentCore(
  host: string,
  port: number,
  event: unknown,
  options: InvokeAgentCoreOptions
): Promise<AgentCoreInvokeResult> {
  const url = `http://${host}:${port}${INVOCATIONS_PATH}`;
  const body = JSON.stringify(event ?? {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        [AGENTCORE_SESSION_ID_HEADER]: options.sessionId,
        ...(options.authorization && { Authorization: options.authorization }),
      },
      body,
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type');
    const isSse = (contentType ?? '').includes('text/event-stream');

    if (isSse && options.onChunk && response.body) {
      // Stream chunk-by-chunk under the SAME abort signal — an agent that
      // emits SSE frames slowly (a chat agent streaming tokens) reaches stdout
      // as it arrives instead of all at once on completion. The abort fires if
      // the whole stream exceeds `timeoutMs`.
      await streamBody(response.body, options.onChunk);
      return { status: response.status, contentType, raw: '', streamed: true };
    }

    // Buffer the body under the SAME abort signal — an agent that returns
    // headers but stalls mid-body would otherwise hang past `timeoutMs` since
    // `fetch` resolves on headers.
    const raw = await response.text();
    return { status: response.status, contentType, raw, streamed: false };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(
        `AgentCore invoke at ${url} timed out after ${options.timeoutMs}ms. ` +
          `The agent may be hung; check container logs.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode a response body stream to UTF-8 text and push each chunk to `onChunk`
 * as it arrives. Uses the reader API (portable across Node versions) and a
 * streaming TextDecoder so a multi-byte char split across chunk boundaries is
 * not corrupted.
 */
async function streamBody(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        if (text) onChunk(text);
      }
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } finally {
    reader.releaseLock();
  }
}
