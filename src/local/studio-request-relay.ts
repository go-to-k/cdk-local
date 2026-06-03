/**
 * Server-side HTTP relay for the `cdkl studio` in-workspace request composer
 * (issue #322).
 *
 * The composer lives in the browser, but the served target runs on a DIFFERENT
 * host port than the studio page — a direct browser fetch to it would be a
 * cross-origin request the served app does not allow (CORS). So studio relays
 * the composed request through its OWN server (same-origin from the browser):
 * `POST /api/request` -> this module -> the serve's endpoint -> the response is
 * returned to the browser.
 *
 * For an `api` / `alb` serve the endpoint is the studio capture-proxy URL, so a
 * relayed request lands on the timeline exactly like an external curl. For an
 * `ecs` serve published via `--host-port` the endpoint is the replica's host
 * URL (no proxy in front, so it is NOT captured).
 *
 * The relay is host-agnostic — it just performs one bounded HTTP request — so
 * it is exported from `cdk-local/internal` for a host CLI embedding studio.
 */

/** A composed request as the studio UI posts it (validated by the caller). */
export interface ServeRequestInput {
  /** Absolute base URL of the running serve (proxy URL or ecs host URL). */
  baseUrl: string;
  /** HTTP method (GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS). */
  method: string;
  /** Request path (joined onto `baseUrl`); defaults to `/`. */
  path?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body (string); omitted for body-less methods. */
  body?: string;
  /** Abort the request after this many ms (default 30s). */
  timeoutMs?: number;
  /** Cap the captured response body at this many chars (UTF-16 code units) (default 512 KiB). */
  maxBodyChars?: number;
}

/** The relayed response handed back to the studio UI. */
export interface ServeRequestResult {
  status: number;
  headers: Record<string, string>;
  /** Response body, truncated to `maxBodyChars` code units (a marker is appended if cut). */
  body: string;
  /** True when the body was truncated at the cap. */
  truncated: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY = 512 * 1024;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Join a base URL and a path without doubling or dropping the `/`. */
function joinUrl(baseUrl: string, path: string | undefined): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (!path || path === '') return base + '/';
  return base + (path.startsWith('/') ? path : '/' + path);
}

/**
 * Perform one HTTP request against a running serve and return a bounded
 * response. `fetchFn` is injectable for tests (defaults to the global `fetch`).
 * Throws on a network / timeout error (the caller maps it to a 502/500); an
 * HTTP error status is a NORMAL result (returned, not thrown).
 */
export async function relayServeRequest(
  input: ServeRequestInput,
  fetchFn: typeof fetch = fetch,
  clock: () => number = Date.now
): Promise<ServeRequestResult> {
  const method = input.method.toUpperCase();
  const url = joinUrl(input.baseUrl, input.path);
  const maxBody = input.maxBodyChars ?? DEFAULT_MAX_BODY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = clock();
  try {
    const res = await fetchFn(url, {
      method,
      headers: input.headers ?? {},
      // Only attach a body for methods that take one — fetch rejects a body on
      // GET / HEAD.
      ...(BODY_METHODS.has(method) && input.body !== undefined ? { body: input.body } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const full = await res.text();
    const truncated = full.length > maxBody;
    const body = truncated ? full.slice(0, maxBody) + '\n…[truncated]' : full;
    return { status: res.status, headers, body, truncated, durationMs: clock() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
