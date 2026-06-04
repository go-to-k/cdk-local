/**
 * Lambda@Edge event translation for `cdkl start-cloudfront` (issue #400).
 *
 * A behavior's `LambdaFunctionAssociations` are real Lambda functions (Node /
 * Python) that CloudFront invokes at four points in the request pipeline —
 * `viewer-request`, `origin-request` (before the origin fetch), `origin-response`
 * (after), and `viewer-response`. cdk-local already runs Lambda code in a real
 * RIE container; this module is the wire format between the local HTTP pipeline
 * and the Lambda@Edge event/response contract.
 *
 * The event is `{ Records: [{ cf: { config, request, response? } }] }`. Headers
 * are the Lambda@Edge `{ "<lowercased>": [{ key, value }] }` multi-map. A
 * request-stage function returns either a (possibly modified) `request` to
 * continue to the origin, or a `response` to short-circuit; a response-stage
 * function returns a (possibly modified) `response`. Response `status` is a
 * STRING in this contract.
 *
 * Out of scope (matching the issue): the edge runtime size/timeout tiers, and
 * the `request.origin` mutation block (origin-request can rewrite the origin —
 * locally the origin is fixed by the resolved behavior, so an `origin` the
 * function sets is ignored). Body is surfaced for the request stages when the
 * association sets `IncludeBody` (base64), and a generated/!modified response
 * body is honored.
 */

/** The Lambda@Edge header multi-map: lowercased name -> [{ key (original case), value }]. */
export type EdgeHeaders = Record<string, Array<{ key: string; value: string }>>;

/** The four Lambda@Edge association event types. */
export type EdgeEventType =
  | 'viewer-request'
  | 'origin-request'
  | 'origin-response'
  | 'viewer-response';

/** A Lambda@Edge `cf.request` object. */
export interface EdgeRequest {
  clientIp: string;
  method: string;
  uri: string;
  querystring: string;
  headers: EdgeHeaders;
  body?: {
    action: 'read-only' | 'replace';
    data: string;
    encoding: 'base64' | 'text';
    inputTruncated: boolean;
  };
}

/** A Lambda@Edge `cf.response` object (`status` is a string in this contract). */
export interface EdgeResponse {
  status: string;
  statusDescription?: string;
  headers: EdgeHeaders;
  body?: string;
  bodyEncoding?: 'text' | 'base64';
}

/** `cf.config`. */
export interface EdgeConfig {
  distributionDomainName: string;
  distributionId: string;
  eventType: EdgeEventType;
  requestId: string;
}

/** The full event handed to a Lambda@Edge function. */
export interface EdgeEvent {
  Records: Array<{
    cf: { config: EdgeConfig; request: EdgeRequest; response?: EdgeResponse };
  }>;
}

/** The HTTP-side request snapshot the server threads through the edge pipeline. */
export interface EdgeRequestInput {
  clientIp: string;
  method: string;
  uri: string;
  querystring: string;
  /** Lowercased header name -> raw values (Node's `IncomingHttpHeaders` form, normalized). */
  headers: Record<string, string[]>;
  /** Request body — included in the event only when the association sets IncludeBody. */
  body?: Buffer;
}

/** Convert a normalized HTTP header map into the Lambda@Edge multi-map. */
export function httpHeadersToEdge(headers: Record<string, string[]>): EdgeHeaders {
  const out: EdgeHeaders = {};
  for (const [name, values] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    out[lower] = values.map((value) => ({ key: name, value }));
  }
  return out;
}

/**
 * Flatten a Lambda@Edge header multi-map into a single-valued `{ name: value }`
 * map (comma-joining duplicates), EXCEPT `set-cookie`, whose values are returned
 * separately so multiple cookies survive. Pseudo / read-only headers CloudFront
 * forbids a function from setting are dropped.
 */
export function edgeHeadersToHttp(headers: EdgeHeaders): {
  headers: Record<string, string>;
  setCookies: string[];
} {
  const out: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const [name, entries] of Object.entries(headers)) {
    if (!Array.isArray(entries)) continue;
    const lower = name.toLowerCase();
    if (READ_ONLY_RESPONSE_HEADERS.has(lower)) continue;
    if (lower === 'set-cookie') {
      for (const e of entries) if (e && typeof e.value === 'string') setCookies.push(e.value);
      continue;
    }
    const values = entries.filter((e) => e && typeof e.value === 'string').map((e) => e.value);
    if (values.length > 0) out[lower] = values.join(', ');
  }
  return { headers: out, setCookies };
}

/**
 * Headers a Lambda@Edge function is not allowed to add/modify on a response (a
 * subset CloudFront blackholes). We drop them rather than fail the response.
 */
const READ_ONLY_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Build the request-stage event (`viewer-request` / `origin-request`). */
export function buildEdgeRequestEvent(args: {
  eventType: 'viewer-request' | 'origin-request';
  config: Omit<EdgeConfig, 'eventType'>;
  request: EdgeRequestInput;
  includeBody: boolean;
}): EdgeEvent {
  return {
    Records: [
      {
        cf: {
          config: { ...args.config, eventType: args.eventType },
          request: toEdgeRequest(args.request, args.includeBody),
        },
      },
    ],
  };
}

/** Build the response-stage event (`origin-response` / `viewer-response`). */
export function buildEdgeResponseEvent(args: {
  eventType: 'origin-response' | 'viewer-response';
  config: Omit<EdgeConfig, 'eventType'>;
  request: EdgeRequestInput;
  response: { statusCode: number; headers: Record<string, string> };
}): EdgeEvent {
  return {
    Records: [
      {
        cf: {
          config: { ...args.config, eventType: args.eventType },
          request: toEdgeRequest(args.request, false),
          response: {
            status: String(args.response.statusCode),
            statusDescription: statusText(args.response.statusCode),
            headers: httpHeadersToEdge(toMultiMap(args.response.headers)),
          },
        },
      },
    ],
  };
}

function toEdgeRequest(input: EdgeRequestInput, includeBody: boolean): EdgeRequest {
  const request: EdgeRequest = {
    clientIp: input.clientIp,
    method: input.method,
    uri: input.uri,
    querystring: input.querystring,
    headers: httpHeadersToEdge(input.headers),
  };
  if (includeBody) {
    const buf = input.body ?? Buffer.alloc(0);
    request.body = {
      action: 'read-only',
      data: buf.toString('base64'),
      encoding: 'base64',
      inputTruncated: false,
    };
  }
  return request;
}

/**
 * Classify a request-stage handler's return value: a `status` field means the
 * function generated a response (short-circuit); otherwise it is the
 * (possibly-modified) request to continue with. A non-object / undefined return
 * continues with the unmodified request — defensive, matching how a function
 * that just inspects the request behaves.
 */
export type EdgeRequestOutcome =
  | { kind: 'continue'; request: EdgeRequest }
  | { kind: 'response'; response: EdgeResponse };

export function interpretEdgeRequestResult(
  result: unknown,
  fallback: EdgeRequest
): EdgeRequestOutcome {
  if (!result || typeof result !== 'object') return { kind: 'continue', request: fallback };
  const obj = result as Record<string, unknown>;
  if ('status' in obj) {
    return { kind: 'response', response: coerceEdgeResponse(obj) };
  }
  return { kind: 'continue', request: coerceEdgeRequest(obj, fallback) };
}

/** Interpret a response-stage handler's return value as the (modified) response. */
export function interpretEdgeResponseResult(result: unknown, fallback: EdgeResponse): EdgeResponse {
  if (!result || typeof result !== 'object') return fallback;
  return coerceEdgeResponse(result as Record<string, unknown>, fallback);
}

/** The server-facing shape a generated / modified edge response collapses to. */
export interface EdgeResponseResult {
  statusCode: number;
  headers: Record<string, string>;
  setCookies: string[];
  body: Buffer;
}

/** Collapse an {@link EdgeResponse} into the server's status / headers / body. */
export function edgeResponseToResult(
  response: EdgeResponse,
  fallbackBody?: Buffer
): EdgeResponseResult {
  const statusCode = Number.parseInt(response.status, 10);
  const { headers, setCookies } = edgeHeadersToHttp(response.headers ?? {});
  let body: Buffer;
  if (response.body !== undefined) {
    body =
      response.bodyEncoding === 'base64'
        ? Buffer.from(response.body, 'base64')
        : Buffer.from(response.body);
  } else {
    body = fallbackBody ?? Buffer.alloc(0);
  }
  return {
    statusCode: Number.isFinite(statusCode) ? statusCode : 500,
    headers,
    setCookies,
    body,
  };
}

/**
 * Server-facing request-stage orchestration: given a handler's raw return value
 * and the current request input, produce either the (modified) request to
 * continue with, or the generated response to short-circuit.
 */
export function applyEdgeRequestResult(
  result: unknown,
  base: EdgeRequestInput
):
  | { kind: 'continue'; request: EdgeRequestInput }
  | { kind: 'response'; response: EdgeResponseResult } {
  const outcome = interpretEdgeRequestResult(result, toEdgeRequest(base, false));
  if (outcome.kind === 'response') {
    return { kind: 'response', response: edgeResponseToResult(outcome.response) };
  }
  return { kind: 'continue', request: applyEdgeRequest(base, outcome.request) };
}

/**
 * Server-facing response-stage orchestration: apply a handler's modified
 * response over the current status / headers, keeping the origin body unless the
 * function replaced it.
 */
export function applyEdgeResponseResult(
  result: unknown,
  base: { statusCode: number; headers: Record<string, string> },
  originBody: Buffer
): EdgeResponseResult {
  const fallback: EdgeResponse = {
    status: String(base.statusCode),
    headers: httpHeadersToEdge(toMultiMap(base.headers)),
  };
  return edgeResponseToResult(interpretEdgeResponseResult(result, fallback), originBody);
}

/** Apply a request-stage function's modified request back onto the server's request input. */
export function applyEdgeRequest(base: EdgeRequestInput, request: EdgeRequest): EdgeRequestInput {
  const out: EdgeRequestInput = {
    clientIp: base.clientIp,
    method: typeof request.method === 'string' ? request.method : base.method,
    uri: typeof request.uri === 'string' ? request.uri : base.uri,
    querystring: typeof request.querystring === 'string' ? request.querystring : base.querystring,
    headers: edgeHeadersToRawMap(request.headers) ?? base.headers,
  };
  // A function that set request.body.action === 'replace' rewrites the body.
  if (request.body && request.body.action === 'replace' && typeof request.body.data === 'string') {
    out.body =
      request.body.encoding === 'base64'
        ? Buffer.from(request.body.data, 'base64')
        : Buffer.from(request.body.data);
  } else if (base.body !== undefined) {
    out.body = base.body;
  }
  return out;
}

function edgeHeadersToRawMap(headers: EdgeHeaders): Record<string, string[]> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const out: Record<string, string[]> = {};
  for (const [name, entries] of Object.entries(headers)) {
    if (!Array.isArray(entries)) continue;
    out[name.toLowerCase()] = entries
      .filter((e) => e && typeof e.value === 'string')
      .map((e) => e.value);
  }
  return out;
}

function coerceEdgeRequest(obj: Record<string, unknown>, fallback: EdgeRequest): EdgeRequest {
  const out: EdgeRequest = {
    clientIp: typeof obj['clientIp'] === 'string' ? (obj['clientIp'] as string) : fallback.clientIp,
    method: typeof obj['method'] === 'string' ? (obj['method'] as string) : fallback.method,
    uri: typeof obj['uri'] === 'string' ? (obj['uri'] as string) : fallback.uri,
    querystring:
      typeof obj['querystring'] === 'string'
        ? (obj['querystring'] as string)
        : fallback.querystring,
    headers: coerceEdgeHeaders(obj['headers']) ?? fallback.headers,
  };
  const body = obj['body'];
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    out.body = {
      action: b['action'] === 'replace' ? 'replace' : 'read-only',
      data: typeof b['data'] === 'string' ? (b['data'] as string) : '',
      encoding: b['encoding'] === 'text' ? 'text' : 'base64',
      inputTruncated: b['inputTruncated'] === true,
    };
  }
  return out;
}

function coerceEdgeResponse(obj: Record<string, unknown>, fallback?: EdgeResponse): EdgeResponse {
  const status =
    typeof obj['status'] === 'string'
      ? (obj['status'] as string)
      : typeof obj['status'] === 'number'
        ? String(obj['status'])
        : (fallback?.status ?? '200');
  const out: EdgeResponse = {
    status,
    headers: coerceEdgeHeaders(obj['headers']) ?? fallback?.headers ?? {},
  };
  if (typeof obj['statusDescription'] === 'string') {
    out.statusDescription = obj['statusDescription'] as string;
  } else if (fallback?.statusDescription !== undefined) {
    out.statusDescription = fallback.statusDescription;
  }
  if (typeof obj['body'] === 'string') {
    out.body = obj['body'] as string;
    if (obj['bodyEncoding'] === 'base64' || obj['bodyEncoding'] === 'text') {
      out.bodyEncoding = obj['bodyEncoding'];
    }
  }
  return out;
}

/** Coerce an arbitrary value into the EdgeHeaders shape, tolerating a bare `{name: 'value'}` map. */
function coerceEdgeHeaders(value: unknown): EdgeHeaders | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: EdgeHeaders = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (Array.isArray(raw)) {
      const entries = raw
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e) => ({
          key: typeof e['key'] === 'string' ? (e['key'] as string) : name,
          value: typeof e['value'] === 'string' ? (e['value'] as string) : String(e['value'] ?? ''),
        }));
      out[lower] = entries;
    } else if (typeof raw === 'string') {
      out[lower] = [{ key: name, value: raw }];
    }
  }
  return out;
}

function toMultiMap(headers: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = [value];
  return out;
}

function statusText(code: number): string {
  return STATUS_TEXT[code] ?? '';
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};
