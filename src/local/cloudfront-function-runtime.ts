import * as vm from 'node:vm';

/**
 * Run a synthesized `AWS::CloudFront::Function`'s inline JavaScript locally
 * (issue #363). A CloudFront Function is the user's own application compute —
 * a small `viewer-request` / `viewer-response` handler doing URL rewrites,
 * header tweaks, redirects, or SPA fallback — and `cdkl start-cloudfront`
 * runs it in-process over the distribution's routing the same way `start-api`
 * runs a Lambda handler. This is NOT an emulation of the managed CloudFront
 * service: only the function-code contract is reproduced.
 *
 * The function body is the literal `Properties.FunctionCode` string from the
 * template (CDK always synthesizes it inline). It is compiled once and run in
 * a fresh `node:vm` context per request to obtain the `handler` function, then
 * `handler(event)` is invoked. `cloudfront-js-2.0` handlers may be `async`, so
 * a returned promise is awaited. The sandbox exposes only the standard
 * JavaScript built-ins a vm context already provides plus `console` (the 2.0
 * runtime has `console.log`); it does NOT expose `require`, `process`, timers,
 * or `fetch`, so a function reaching for the real CloudFront KeyValueStore /
 * `cf.fetch` runtime APIs fails locally with a clear error rather than
 * silently diverging.
 *
 * Out of scope: the CloudFront KeyValueStore (`cloudfront.kvs()`), the 2.0
 * `cf.fetch` origin-request API, and crypto helpers — these have no local
 * analogue and are documented as unsupported.
 */

/** The CloudFront-Functions header / cookie / query-value object shape. */
export interface CfValue {
  value: string;
  /** Present for multi-valued headers / query params. */
  multiValue?: Array<{ value: string }>;
}

/** A CloudFront Functions `event.request` object. */
export interface CfRequest {
  method: string;
  uri: string;
  querystring: Record<string, CfValue>;
  headers: Record<string, CfValue>;
  cookies: Record<string, CfValue>;
}

/** A CloudFront Functions `event.response` object. */
export interface CfResponse {
  statusCode: number;
  statusDescription?: string;
  headers: Record<string, CfValue>;
  cookies?: Record<string, CfValue>;
  body?: string | { encoding?: 'text' | 'base64'; data?: string };
}

/** The event passed to a `viewer-request` handler. */
export interface CfViewerRequestEvent {
  version: '1.0';
  context: {
    distributionDomainName: string;
    distributionId: string;
    eventType: string;
    requestId: string;
  };
  viewer: { ip: string };
  request: CfRequest;
}

/** The event passed to a `viewer-response` handler. */
export interface CfViewerResponseEvent extends CfViewerRequestEvent {
  response: CfResponse;
}

/** A compiled CloudFront Function — reused across requests. */
export interface CompiledCloudFrontFunction {
  /** The `AWS::CloudFront::Function` logical id (for diagnostics). */
  logicalId: string;
  /** Declared runtime (`cloudfront-js-1.0` / `cloudfront-js-2.0`). */
  runtime: string;
  /** Compiled script that, when run, evaluates to the `handler` function. */
  script: vm.Script;
}

/**
 * Compile a CloudFront Function's inline code once. Throws a clear error when
 * the code has a syntax error or declares no `handler` (surfaced at boot so a
 * malformed function never silently no-ops at request time).
 */
export function compileCloudFrontFunction(
  logicalId: string,
  code: string,
  runtime: string
): CompiledCloudFrontFunction {
  let script: vm.Script;
  try {
    // The trailing `handler` expression makes the script evaluate to the
    // declared handler function (a `function handler(){}` declaration is
    // hoisted; a `var handler = ...` assignment is also in scope).
    script = new vm.Script(`${code}\n;typeof handler === 'function' ? handler : undefined`, {
      filename: `cloudfront-function-${logicalId}.js`,
    });
  } catch (err) {
    throw new Error(
      `CloudFront Function '${logicalId}' failed to compile: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  // Probe once that a `handler` is actually defined.
  const probe = script.runInContext(vm.createContext({ console }));
  if (typeof probe !== 'function') {
    throw new Error(
      `CloudFront Function '${logicalId}' does not declare a 'handler' function. ` +
        'A CloudFront Function must export `function handler(event) { ... }`.'
    );
  }
  return { logicalId, runtime, script };
}

/**
 * Invoke a compiled function's `handler(event)` in a fresh sandbox and return
 * its result. A `cloudfront-js-2.0` async handler's promise is awaited. Any
 * error thrown by the handler is wrapped with the function's logical id.
 */
export async function invokeCloudFrontFunction(
  fn: CompiledCloudFrontFunction,
  event: CfViewerRequestEvent | CfViewerResponseEvent
): Promise<unknown> {
  const context = vm.createContext({ console });
  let handler: unknown;
  try {
    handler = fn.script.runInContext(context);
  } catch (err) {
    throw new Error(
      `CloudFront Function '${fn.logicalId}' failed while loading: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof handler !== 'function') {
    throw new Error(`CloudFront Function '${fn.logicalId}' has no callable 'handler'.`);
  }
  try {
    const result = (handler as (e: unknown) => unknown)(event);
    return result instanceof Promise ? await result : result;
  } catch (err) {
    throw new Error(
      `CloudFront Function '${fn.logicalId}' threw at request time: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * The outcome of running a `viewer-request` function: either CONTINUE to the
 * origin with the (possibly rewritten) request, or short-circuit with a
 * RESPONSE the function generated (a redirect / fixed body). CloudFront treats
 * a returned object carrying a `statusCode` as a response; otherwise it is the
 * forwarded request.
 */
export type ViewerRequestOutcome =
  | { kind: 'continue'; request: CfRequest }
  | { kind: 'response'; response: CfResponse };

/**
 * Run a `viewer-request` function and classify its return value. A non-object
 * return (or `undefined`) is treated as "continue unchanged" — a defensive
 * default matching CloudFront's tolerance of a function that just inspects the
 * request.
 */
export async function runViewerRequest(
  fn: CompiledCloudFrontFunction,
  event: CfViewerRequestEvent
): Promise<ViewerRequestOutcome> {
  const result = await invokeCloudFrontFunction(fn, event);
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if ('statusCode' in obj) {
      return { kind: 'response', response: coerceResponse(obj) };
    }
    return { kind: 'continue', request: coerceRequest(obj, event.request) };
  }
  return { kind: 'continue', request: event.request };
}

/**
 * Run a `viewer-response` function and return the (possibly mutated) response.
 * A non-object return falls back to the unmodified origin response.
 */
export async function runViewerResponse(
  fn: CompiledCloudFrontFunction,
  event: CfViewerResponseEvent
): Promise<CfResponse> {
  const result = await invokeCloudFrontFunction(fn, event);
  if (result && typeof result === 'object') {
    return coerceResponse(result as Record<string, unknown>, event.response);
  }
  return event.response;
}

/** Normalize a function's returned request object back into a {@link CfRequest}. */
function coerceRequest(obj: Record<string, unknown>, fallback: CfRequest): CfRequest {
  return {
    method: typeof obj['method'] === 'string' ? (obj['method'] as string) : fallback.method,
    uri: typeof obj['uri'] === 'string' ? (obj['uri'] as string) : fallback.uri,
    querystring: coerceValueMap(obj['querystring']) ?? fallback.querystring,
    headers: coerceValueMap(obj['headers']) ?? fallback.headers,
    cookies: coerceValueMap(obj['cookies']) ?? fallback.cookies,
  };
}

/** Normalize a function's returned response object into a {@link CfResponse}. */
function coerceResponse(obj: Record<string, unknown>, fallback?: CfResponse): CfResponse {
  const statusCode =
    typeof obj['statusCode'] === 'number'
      ? (obj['statusCode'] as number)
      : (fallback?.statusCode ?? 200);
  const res: CfResponse = {
    statusCode,
    headers: coerceValueMap(obj['headers']) ?? fallback?.headers ?? {},
  };
  const desc = obj['statusDescription'] ?? fallback?.statusDescription;
  if (typeof desc === 'string') res.statusDescription = desc;
  const cookies = coerceValueMap(obj['cookies']);
  if (cookies) res.cookies = cookies;
  const body = obj['body'];
  if (typeof body === 'string' || (body && typeof body === 'object')) {
    res.body = body as NonNullable<CfResponse['body']>;
  } else if (fallback?.body !== undefined) {
    res.body = fallback.body;
  }
  return res;
}

/**
 * Coerce a header / cookie / querystring map back into the `{ value }` shape,
 * tolerating a function that wrote a bare string value (`headers.location =
 * 'https://...'` instead of `{ value: '...' }`). Returns `undefined` when the
 * field is absent so the caller keeps the prior value.
 */
function coerceValueMap(value: unknown): Record<string, CfValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, CfValue> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
      const cv = v as { value: unknown; multiValue?: unknown };
      const entry: CfValue = { value: scalarToString(cv.value) };
      if (Array.isArray(cv.multiValue)) {
        entry.multiValue = cv.multiValue
          .filter((m): m is { value: unknown } => Boolean(m) && typeof m === 'object')
          .map((m) => ({ value: scalarToString((m as { value: unknown }).value) }));
      }
      out[k] = entry;
    } else if (typeof v === 'string') {
      out[k] = { value: v };
    }
  }
  return out;
}

/**
 * Coerce a CloudFront function's header / cookie / query value to a string. CF
 * values are strings, but a function may hand back a number / boolean; anything
 * non-scalar (or absent) collapses to the empty string.
 */
function scalarToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Build a `viewer-request` event from an incoming HTTP request. Header keys
 * are lower-cased (CloudFront's contract); a multi-valued header is carried in
 * `multiValue` with `value` set to the first entry.
 */
export function buildViewerRequestEvent(input: {
  method: string;
  uri: string;
  querystring: string;
  headers: NodeJS.Dict<string | string[]>;
  ip: string;
  distributionId: string;
  domainName: string;
  requestId: string;
}): CfViewerRequestEvent {
  return {
    version: '1.0',
    context: {
      distributionDomainName: input.domainName,
      distributionId: input.distributionId,
      eventType: 'viewer-request',
      requestId: input.requestId,
    },
    viewer: { ip: input.ip },
    request: {
      method: input.method.toUpperCase(),
      uri: input.uri,
      querystring: parseQueryStringToCf(input.querystring),
      headers: headersToCf(input.headers),
      cookies: cookiesFromHeaders(input.headers),
    },
  };
}

/** Extend a request event into a `viewer-response` event with the origin response. */
export function buildViewerResponseEvent(
  requestEvent: CfViewerRequestEvent,
  response: {
    statusCode: number;
    statusDescription?: string;
    headers: NodeJS.Dict<string | string[]>;
  }
): CfViewerResponseEvent {
  return {
    ...requestEvent,
    context: { ...requestEvent.context, eventType: 'viewer-response' },
    response: {
      statusCode: response.statusCode,
      ...(response.statusDescription !== undefined && {
        statusDescription: response.statusDescription,
      }),
      headers: headersToCf(response.headers),
    },
  };
}

/** Serialize a CloudFront request's `querystring` object back to a raw string. */
export function serializeCfQueryString(qs: Record<string, CfValue>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(qs)) {
    const values =
      val.multiValue && val.multiValue.length > 0 ? val.multiValue : [{ value: val.value }];
    for (const v of values) {
      parts.push(
        v.value === ''
          ? encodeURIComponent(key)
          : `${encodeURIComponent(key)}=${encodeURIComponent(v.value)}`
      );
    }
  }
  return parts.join('&');
}

function parseQueryStringToCf(raw: string): Record<string, CfValue> {
  const out: Record<string, CfValue> = {};
  if (!raw) return out;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodePart(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : decodePart(pair.slice(eq + 1));
    addCfValue(out, key, value);
  }
  return out;
}

function headersToCf(headers: NodeJS.Dict<string | string[]>): Record<string, CfValue> {
  const out: Record<string, CfValue> = {};
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined) continue;
    // `cookie` is surfaced via `request.cookies`, not `request.headers`, to
    // match CloudFront — but it is harmless to also keep it as a header.
    const lower = name.toLowerCase();
    if (Array.isArray(raw)) {
      for (const v of raw) addCfValue(out, lower, v);
    } else {
      addCfValue(out, lower, raw);
    }
  }
  return out;
}

function cookiesFromHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, CfValue> {
  const out: Record<string, CfValue> = {};
  const raw = headers['cookie'] ?? headers['Cookie'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  for (const header of list) {
    for (const pair of header.split(';')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      addCfValue(out, name, value);
    }
  }
  return out;
}

/** Append a value under `key`, promoting to `multiValue` on the second hit. */
function addCfValue(map: Record<string, CfValue>, key: string, value: string): void {
  const existing = map[key];
  if (existing === undefined) {
    map[key] = { value };
    return;
  }
  if (!existing.multiValue) existing.multiValue = [{ value: existing.value }];
  existing.multiValue.push({ value });
}

function decodePart(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}
