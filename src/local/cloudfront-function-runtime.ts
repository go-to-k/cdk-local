import * as nodeBuffer from 'node:buffer';
import * as nodeCrypto from 'node:crypto';
import * as nodeQuerystring from 'node:querystring';
import * as vm from 'node:vm';
import { createUnboundCloudFrontModule, type CloudFrontModule } from './cloudfront-kvs.js';

/**
 * The CloudFront Functions JS 2.0 runtime exposes a set of globals + `require`
 * modules that a bare `node:vm` context does NOT provide — code that uses any
 * of them works in production but fails locally with a `ReferenceError`
 * (issue #410). Reproduce them with their Node equivalents:
 *
 *   - globals: `Buffer`, `atob` / `btoa`, `TextEncoder` / `TextDecoder`
 *     (the 2.0 runtime's documented globals / built-in objects);
 *   - `require('crypto')` (`createHash` / `createHmac`, md5 / sha1 / sha256),
 *     `require('querystring')`, and `require('buffer')` — backed by the Node
 *     modules (a superset of the 2.0 runtime's documented subset, which is the
 *     right trade-off for a dev tool: a function using only the documented API
 *     behaves identically; an undocumented Node-only API would work locally but
 *     not deployed).
 *
 * `console` is added by the caller. A `require` of anything other than the
 * three modules above throws, and `fs` / `process` / timers / network / `eval`
 * are not provided as globals — matching the deployed runtime's restricted
 * features (a fidelity convenience, not a hard isolation guarantee; see the
 * module docstring).
 */
function cloudFrontRuntimeRequire(name: string): unknown {
  if (name === 'crypto') return nodeCrypto;
  if (name === 'querystring') return nodeQuerystring;
  if (name === 'buffer') return nodeBuffer;
  throw new Error(
    `Cannot find module '${name}'. CloudFront Functions only provides the 'crypto', ` +
      "'querystring', and 'buffer' built-in modules."
  );
}

/** The CloudFront-Functions-2.0 globals + `require` to merge into a sandbox. */
function cloudFrontRuntimeGlobals(): Record<string, unknown> {
  return {
    Buffer,
    atob,
    btoa,
    TextEncoder,
    TextDecoder,
    require: cloudFrontRuntimeRequire,
  };
}

/**
 * Hard cap on a single CloudFront Function's synchronous run. The deployed
 * runtime caps CPU at ~1ms; locally we are generous but still bound it so a
 * runaway `while (true) {}` in a function fails that one request with a clear
 * error instead of wedging the single-threaded local server for every
 * subsequent request. `vm`'s timeout only interrupts synchronous code — an
 * `await`-based hang in a 2.0 async handler is not caught (it has no local
 * analogue), which is acceptable for a dev tool.
 */
const FUNCTION_TIMEOUT_MS = 5000;

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
 * a returned promise is awaited. The sandbox exposes the standard JavaScript
 * built-ins a vm context provides plus `console` and the CloudFront-Functions-2.0
 * runtime built-ins a bare vm context lacks — `Buffer`, `atob` / `btoa`,
 * `TextEncoder` / `TextDecoder`, and a `require` for the `crypto` /
 * `querystring` / `buffer` modules (see {@link cloudFrontRuntimeGlobals}, issue
 * #410). `process` / timers / `fetch` / `fs` are not provided as globals (a
 * function referencing them gets a `ReferenceError`, matching CloudFront's
 * restricted features). Note the vm is a FIDELITY sandbox, not a security
 * boundary — injecting host objects (`console`, `Buffer`, the `cf` module)
 * means hostile code could reach the host realm; that is moot here because the
 * function code is the user's own CDK-app code run locally for dev.
 *
 * The 2.0 KeyValueStore API IS reproduced: a `import cf from 'cloudfront'`
 * statement is stripped from the code ({@link stripCloudFrontImport}) and the
 * binding (`cf`) is injected as a {@link CloudFrontModule} whose `cf.kvs()`
 * reads are backed by the deployed store (`--from-cfn-stack`) or a local JSON
 * map (`--kvs-file`) — see `cloudfront-kvs.ts`. A function reaching for KVS
 * with no binding resolved gets a clear actionable error at read time
 * ({@link createUnboundCloudFrontModule}).
 *
 * Out of scope: the 2.0 `cf.fetch` origin-request API and crypto helpers —
 * these have no local analogue and are documented as unsupported.
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

/**
 * A KeyValueStore association declared on a function's
 * `FunctionConfig.KeyValueStoreAssociations[]`, carried on the compiled
 * function so the command layer can resolve its ARN (under `--from-cfn-stack`)
 * or back it with a `--kvs-file` and build the `cf` module.
 */
export interface CloudFrontKvsAssociation {
  /**
   * The raw `KeyValueStoreARN` value from the template — a literal ARN string,
   * or an intrinsic (`Fn::GetAtt[<Kvs>, 'Arn']` / `Ref` / `Fn::Sub`).
   */
  arnValue: unknown;
  /**
   * The `AWS::CloudFront::KeyValueStore` resource logical id, pre-extracted when
   * the ARN is an intrinsic reference to a same-template store. Absent for a
   * literal-ARN association (e.g. an imported store).
   */
  kvsLogicalId?: string;
}

/** A compiled CloudFront Function — reused across requests. */
export interface CompiledCloudFrontFunction {
  /** The `AWS::CloudFront::Function` logical id (for diagnostics). */
  logicalId: string;
  /** Declared runtime (`cloudfront-js-1.0` / `cloudfront-js-2.0`). */
  runtime: string;
  /**
   * Compiled script that runs the user's code (defining `handler`) and then
   * invokes `handler(__cfEvent)`, returning its result. Running the INVOCATION
   * inside the vm — not just the handler extraction — is what lets the
   * {@link FUNCTION_TIMEOUT_MS} bound a runaway synchronous handler.
   */
  script: vm.Script;
  /**
   * The local name the `cloudfront` module is imported under (`cf` in
   * `import cf from 'cloudfront'`), when the function imports it. Set by
   * {@link stripCloudFrontImport} at compile time; the binding is injected into
   * the sandbox at invoke time.
   */
  cloudfrontBindingName?: string;
  /**
   * KeyValueStore associations declared on the function (from
   * `FunctionConfig.KeyValueStoreAssociations`). Populated by the resolver;
   * consumed by the command layer to build {@link cloudfrontModule}.
   */
  kvsAssociations?: CloudFrontKvsAssociation[];
  /**
   * The resolved `cf` module injected at invoke time. Set by the command layer
   * after it resolves the KVS bindings (deployed store / local file). When a
   * function imports `cloudfront` but this is unset, an
   * {@link createUnboundCloudFrontModule} is injected so a `cf.kvs()` read
   * surfaces a clear actionable error. Mutable so a `--watch` reload can rebind.
   */
  cloudfrontModule?: CloudFrontModule;
}

const EVENT_GLOBAL = '__cfEvent';

/**
 * Regex matching the canonical CloudFront-Functions 2.0 KeyValueStore import
 * line (`import cf from 'cloudfront';`). The module is default-imported under a
 * single binding name; this is the only `cloudfront` import form the runtime
 * supports. Anchored per-line (`m` flag) so only the import statement is
 * matched, not a substring elsewhere.
 */
const CLOUDFRONT_IMPORT_RE = /^[ \t]*import\s+(\w+)\s+from\s+['"]cloudfront['"]\s*;?[ \t]*$/m;

/**
 * Strip the `import cf from 'cloudfront'` statement from a 2.0 function's code
 * and return the binding name, so the code compiles as a plain `vm.Script`
 * (an `import` statement is invalid outside an ES module) and the `cloudfront`
 * module can be injected as the binding-named sandbox global instead. Returns
 * the code unchanged with no binding name when the function does not import
 * `cloudfront`. The matched line is blanked (not deleted) so error line numbers
 * still line up with the source.
 */
export function stripCloudFrontImport(code: string): { code: string; bindingName?: string } {
  const match = CLOUDFRONT_IMPORT_RE.exec(code);
  if (!match) return { code };
  return { code: code.replace(CLOUDFRONT_IMPORT_RE, ''), bindingName: match[1]! };
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
  // A 2.0 function backed by a KeyValueStore opens with `import cf from
  // 'cloudfront'`; strip it so the body compiles as a plain Script and inject
  // the `cloudfront` module under the captured binding name at invoke time.
  const { code: source, bindingName } = stripCloudFrontImport(code);
  let script: vm.Script;
  try {
    // The user code defines `handler`; the trailing call invokes it with the
    // per-request event injected as a context global. Compiling the call into
    // the same script means `runInContext`'s `timeout` covers the handler's
    // synchronous execution, not just its definition.
    script = new vm.Script(`${source}\n;handler(${EVENT_GLOBAL})`, {
      filename: `cloudfront-function-${logicalId}.js`,
    });
  } catch (err) {
    throw new Error(
      `CloudFront Function '${logicalId}' failed to compile: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  // Probe once that a `handler` is actually defined, surfacing a
  // missing-handler error at boot rather than a silent no-op per request. When
  // the function imports `cloudfront`, top-level code may call `cf.kvs(...)`, so
  // bind a benign placeholder module in the probe context (the real module is
  // injected per request at invoke time).
  let hasHandler: unknown;
  try {
    const probeGlobals: Record<string, unknown> = { console, ...cloudFrontRuntimeGlobals() };
    if (bindingName) probeGlobals[bindingName] = createUnboundCloudFrontModule(logicalId);
    const probeContext = vm.createContext(probeGlobals);
    hasHandler = new vm.Script(`${source}\n;typeof handler === 'function'`).runInContext(
      probeContext,
      { timeout: FUNCTION_TIMEOUT_MS }
    );
  } catch (err) {
    throw new Error(
      `CloudFront Function '${logicalId}' failed to compile: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (hasHandler !== true) {
    throw new Error(
      `CloudFront Function '${logicalId}' does not declare a 'handler' function. ` +
        'A CloudFront Function must export `function handler(event) { ... }`.'
    );
  }
  return {
    logicalId,
    runtime,
    script,
    ...(bindingName !== undefined && { cloudfrontBindingName: bindingName }),
  };
}

/**
 * Invoke a compiled function's `handler(event)` in a fresh sandbox and return
 * its result. The synchronous portion is bounded by {@link FUNCTION_TIMEOUT_MS}
 * (a runaway `while (true) {}` fails this one request instead of wedging the
 * server); a `cloudfront-js-2.0` async handler's promise is awaited. Any error
 * thrown by the handler is wrapped with the function's logical id.
 */
export async function invokeCloudFrontFunction(
  fn: CompiledCloudFrontFunction,
  event: CfViewerRequestEvent | CfViewerResponseEvent
): Promise<unknown> {
  const sandbox: Record<string, unknown> = {
    console,
    ...cloudFrontRuntimeGlobals(),
    [EVENT_GLOBAL]: event,
  };
  // Inject the `cloudfront` module under its import binding name. The command
  // layer sets `cloudfrontModule` once the KVS bindings resolve; when the
  // function imports `cloudfront` but no binding was resolved, an unbound module
  // is injected so a `cf.kvs()` read fails with a clear actionable error.
  if (fn.cloudfrontBindingName) {
    sandbox[fn.cloudfrontBindingName] =
      fn.cloudfrontModule ?? createUnboundCloudFrontModule(fn.logicalId);
  }
  const context = vm.createContext(sandbox);
  let result: unknown;
  try {
    result = fn.script.runInContext(context, { timeout: FUNCTION_TIMEOUT_MS });
  } catch (err) {
    throw new Error(
      `CloudFront Function '${fn.logicalId}' threw at request time: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
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
