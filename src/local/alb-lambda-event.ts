import type { IncomingMessage } from 'node:http';

/**
 * Issue #123 (Lambda-target slice) — translate an inbound HTTP request into the
 * Application Load Balancer Lambda-target invocation event, and translate the
 * handler's response back into HTTP components.
 *
 * This is the **ALB** Lambda event shape, NOT the API Gateway one (`start-api`
 * owns that via `api-gateway-event.ts`). The shapes are deliberately distinct:
 *
 * Request event (confirmed against the AWS docs
 * https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html):
 *
 * ```
 * {
 *   "requestContext": { "elb": { "targetGroupArn": "<tg-arn>" } },
 *   "httpMethod": "GET",
 *   "path": "/",
 *   // single-value form (default):
 *   "queryStringParameters": { "k": "v2" },   // last value wins on dup keys
 *   "headers":               { "k": "v2" },   // last value wins on dup keys
 *   // multi-value form (target-group attribute lambda.multi_value_headers.enabled=true):
 *   "multiValueQueryStringParameters": { "k": ["v1", "v2"] },
 *   "multiValueHeaders":              { "k": ["v1", "v2"] },
 *   "body": "<string>",
 *   "isBase64Encoded": false
 * }
 * ```
 *
 * Exactly ONE of the single-value / multi-value variants is present, chosen by
 * the target group's `lambda.multi_value_headers.enabled` attribute. ALB also
 * stamps `x-amzn-trace-id`, `x-forwarded-for`, `x-forwarded-port`, and
 * `x-forwarded-proto` on every request — the front-door server already appends
 * the `x-forwarded-*` set, so the request snapshot reaching this builder carries
 * them.
 *
 * Body base64: when the `content-encoding` header is present, OR the
 * content-type is not one of `text/*`, `application/json`,
 * `application/javascript`, `application/xml`, the body is base64-encoded and
 * `isBase64Encoded` is `true` (mirrors ALB).
 *
 * Response (the handler must return): `{ statusCode, statusDescription?,
 * headers | multiValueHeaders, body?, isBase64Encoded? }`. A malformed response
 * (no numeric `statusCode`, or a Lambda runtime error envelope) maps to HTTP
 * 502 — mirroring how a real ALB answers when a Lambda target returns an
 * invalid response.
 */

/**
 * The HTTP request shape the ALB event-builder consumes. Decoupled from
 * `node:http` so the builder stays pure / unit-testable. Header names are
 * passed in their on-wire case (lowercased by the builder).
 */
export interface AlbHttpRequestSnapshot {
  /** HTTP method, uppercased (`GET` / `POST` / ...). */
  method: string;
  /** Full URL path including query string, NOT decoded. e.g. `/items?a=1&a=2`. */
  rawUrl: string;
  /** Headers as a key -> array map (multiple values per name preserved). */
  headers: Record<string, string[]>;
  /** Request body as a Buffer. Empty body -> zero-length Buffer. */
  body: Buffer;
}

/** Content types ALB treats as text (body sent verbatim, `isBase64Encoded: false`). */
function isTextualContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    ct.startsWith('application/json') ||
    ct.startsWith('application/javascript') ||
    ct.startsWith('application/xml')
  );
}

/**
 * Build a `AlbHttpRequestSnapshot` from a live `node:http` request plus the
 * already-buffered body. Header values arrive as `string | string[]`; this
 * normalizes them to `string[]` (preserving multi-value) the builder expects.
 */
export function snapshotFromIncoming(req: IncomingMessage, body: Buffer): AlbHttpRequestSnapshot {
  const headers: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value : [value];
  }
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    rawUrl: req.url ?? '/',
    headers,
    body,
  };
}

/** Split a raw URL into its path (query-stripped, not decoded) and raw query string. */
function splitRawUrl(rawUrl: string): { path: string; rawQuery: string } {
  const hashIdx = rawUrl.indexOf('#');
  const noHash = hashIdx === -1 ? rawUrl : rawUrl.slice(0, hashIdx);
  const qIdx = noHash.indexOf('?');
  if (qIdx === -1) return { path: noHash, rawQuery: '' };
  return { path: noHash.slice(0, qIdx), rawQuery: noHash.slice(qIdx + 1) };
}

/**
 * Parse a raw query string into single + multi-value maps. ALB does NOT decode
 * query parameters (the docs explicitly say "If the query parameters are
 * URL-encoded, the load balancer does not decode them"), so values are kept
 * verbatim. A bare `?flag` key yields the empty string value.
 */
function parseQuery(rawQuery: string): {
  single: Record<string, string>;
  multi: Record<string, string[]>;
} {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  if (rawQuery.length === 0) return { single, multi };
  for (const pair of rawQuery.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    // single: last value wins (ALB default-format semantics).
    single[key] = value;
    (multi[key] ??= []).push(value);
  }
  return { single, multi };
}

/**
 * Build the single + multi-value header maps. Names are lowercased; the single
 * map keeps the LAST value (ALB default-format), the multi map keeps every
 * value in arrival order.
 */
function buildHeaderMaps(headers: Record<string, string[]>): {
  single: Record<string, string>;
  multi: Record<string, string[]>;
} {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const list = values.slice();
    multi[lower] = list;
    if (list.length > 0) single[lower] = list[list.length - 1]!;
  }
  return { single, multi };
}

/** Header lookup that tolerates the case-folded multi-value request map. */
function firstHeader(headers: Record<string, string[]>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v[0];
  }
  return undefined;
}

export interface BuildAlbLambdaEventOptions {
  /** The resolved target-group ARN-or-logical-id surfaced under `requestContext.elb`. */
  targetGroupArn: string;
  /**
   * Whether the target group has `lambda.multi_value_headers.enabled=true`.
   * `true` -> emit `multiValueHeaders` / `multiValueQueryStringParameters`;
   * `false` (default) -> emit `headers` / `queryStringParameters` (last-wins).
   */
  multiValueHeaders: boolean;
}

/**
 * Build the ALB Lambda-target invocation event from an HTTP request snapshot.
 * Emits exactly the single-value OR multi-value variant per
 * `opts.multiValueHeaders`.
 */
export function buildAlbLambdaEvent(
  req: AlbHttpRequestSnapshot,
  opts: BuildAlbLambdaEventOptions
): Record<string, unknown> {
  const { path, rawQuery } = splitRawUrl(req.rawUrl);
  const query = parseQuery(rawQuery);
  const headerMaps = buildHeaderMaps(req.headers);

  const contentEncoding = firstHeader(req.headers, 'content-encoding');
  const contentType = firstHeader(req.headers, 'content-type') ?? '';
  const isBase64Encoded =
    req.body.length > 0 &&
    (contentEncoding !== undefined ? true : !isTextualContentType(contentType));
  const body = isBase64Encoded ? req.body.toString('base64') : req.body.toString('utf-8');

  const event: Record<string, unknown> = {
    requestContext: { elb: { targetGroupArn: opts.targetGroupArn } },
    httpMethod: req.method,
    path,
    isBase64Encoded,
    body,
  };

  if (opts.multiValueHeaders) {
    event['multiValueHeaders'] = headerMaps.multi;
    event['multiValueQueryStringParameters'] = query.multi;
  } else {
    event['headers'] = headerMaps.single;
    event['queryStringParameters'] = query.single;
  }

  return event;
}

/** HTTP response components translated from a Lambda ALB-target response. */
export interface TranslatedAlbResponse {
  statusCode: number;
  /** Optional human status line (ALB `statusDescription`); undefined -> Node default. */
  statusDescription?: string;
  /**
   * Headers as a key -> array map so the server can emit one wire header per
   * value (e.g. multiple `set-cookie` lines). Names are lowercased.
   */
  headers: Record<string, string[]>;
  /** Body bytes ready to write to the socket. */
  body: Buffer;
}

/** A Lambda RIE error envelope (`{errorMessage, errorType, ...}`) with no statusCode. */
function isErrorEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const obj = payload as Record<string, unknown>;
  if ('statusCode' in obj) return false;
  return typeof obj['errorMessage'] === 'string';
}

/**
 * The canonical 502 a real ALB returns when a Lambda target's response is
 * malformed (missing/invalid `statusCode`, non-object payload, or a runtime
 * error envelope). Plain-text body, mirroring ALB's own 502 page shape closely
 * enough for local dev.
 */
function badGatewayResponse(): TranslatedAlbResponse {
  const body = Buffer.from('<html><body><h1>502 Bad Gateway</h1></body></html>', 'utf-8');
  return {
    statusCode: 502,
    statusDescription: '502 Bad Gateway',
    headers: {
      'content-type': ['text/html'],
      'content-length': [String(body.length)],
    },
    body,
  };
}

function stringifyHeaderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/**
 * Translate a Lambda ALB-target response payload into HTTP components.
 *
 * A well-formed response is an object with a numeric `statusCode`. Headers come
 * from `headers` (single-value) and/or `multiValueHeaders` (array-valued); ALB
 * accepts either regardless of the request-side multi-value setting, so both
 * are honored here (multiValueHeaders extend / append to the single map).
 * `body` is optional; `isBase64Encoded: true` means the body is base64 and is
 * decoded to raw bytes.
 *
 * Anything else -> 502 (matching a real ALB), incl. a runtime error envelope.
 */
export function translateAlbLambdaResponse(payload: unknown): TranslatedAlbResponse {
  if (isErrorEnvelope(payload)) return badGatewayResponse();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return badGatewayResponse();
  }
  const obj = payload as Record<string, unknown>;
  const statusRaw = obj['statusCode'];
  if (typeof statusRaw !== 'number' || !Number.isFinite(statusRaw)) {
    return badGatewayResponse();
  }
  const statusCode = Math.trunc(statusRaw);

  const isBase64 = obj['isBase64Encoded'] === true;
  const rawBody = obj['body'];
  let body: Buffer;
  if (rawBody === undefined || rawBody === null) {
    body = Buffer.alloc(0);
  } else if (typeof rawBody === 'string') {
    body = isBase64 ? Buffer.from(rawBody, 'base64') : Buffer.from(rawBody, 'utf-8');
  } else {
    body = Buffer.from(JSON.stringify(rawBody), 'utf-8');
  }

  const headers: Record<string, string[]> = {};
  const addHeader = (name: string, value: string): void => {
    const lower = name.toLowerCase();
    (headers[lower] ??= []).push(value);
  };

  const singleHeaders = obj['headers'];
  if (singleHeaders && typeof singleHeaders === 'object' && !Array.isArray(singleHeaders)) {
    for (const [name, value] of Object.entries(singleHeaders as Record<string, unknown>)) {
      addHeader(name, stringifyHeaderValue(value));
    }
  }

  const multiHeaders = obj['multiValueHeaders'];
  if (multiHeaders && typeof multiHeaders === 'object' && !Array.isArray(multiHeaders)) {
    for (const [name, values] of Object.entries(multiHeaders as Record<string, unknown>)) {
      if (!Array.isArray(values)) continue;
      for (const v of values) addHeader(name, stringifyHeaderValue(v));
    }
  }

  // content-length is informational; emit a correct one from the actual body
  // bytes so a partial / mismatched length from the handler doesn't lie on the
  // wire (ALB recomputes it too).
  headers['content-length'] = [String(body.length)];

  const result: TranslatedAlbResponse = { statusCode, headers, body };
  const statusDescription = obj['statusDescription'];
  if (typeof statusDescription === 'string' && statusDescription.length > 0) {
    result.statusDescription = statusDescription;
  }
  return result;
}
