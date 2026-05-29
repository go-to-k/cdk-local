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
 * plain HTTP. `cdkl invoke-agent` runs the container, waits for `/ping`,
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

export interface AgentInvokeResult {
  /** HTTP status code of the `/invocations` response. */
  status: number;
  /** Response `Content-Type` (e.g. `application/json` or `text/event-stream`), or null. */
  contentType: string | null;
  /** Raw response body — JSON or SSE (`data: ...`) passed through verbatim. */
  raw: string;
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
export async function waitForAgentPing(
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

export interface InvokeAgentOptions {
  /** Value for the {@link AGENTCORE_SESSION_ID_HEADER} request header. */
  sessionId: string;
  /** Abort the request after this many ms. */
  timeoutMs: number;
}

/**
 * POST the event body to the agent's `/invocations` endpoint with the
 * session-id header and a JSON content type. Returns the raw response body
 * (JSON or SSE) together with its status + content type — the command
 * prints it verbatim, so both the non-streaming JSON and streaming SSE
 * shapes pass through unchanged.
 */
export async function invokeAgent(
  host: string,
  port: number,
  event: unknown,
  options: InvokeAgentOptions
): Promise<AgentInvokeResult> {
  const url = `http://${host}:${port}${INVOCATIONS_PATH}`;
  const body = JSON.stringify(event ?? {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        [AGENTCORE_SESSION_ID_HEADER]: options.sessionId,
      },
      body,
      signal: controller.signal,
    });
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

  const raw = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    raw,
  };
}
