import type { IncomingHttpHeaders } from 'node:http';
import {
  buildHttpApiV2Event,
  type HttpRequestSnapshot,
  type MatchedRouteContext,
} from './api-gateway-event.js';
import { translateLambdaResponse } from './api-gateway-response.js';
import type { DiscoveredRoute } from './route-discovery.js';

/**
 * Serve a CloudFront behavior whose origin is a Lambda Function URL by invoking
 * the backing Lambda locally (issue #376). A Function URL origin receives the
 * Lambda Function URL (payload format 2.0) event — identical to the HTTP API v2
 * shape — so we reuse {@link buildHttpApiV2Event} (with a synthetic `$default`
 * function-url route) and {@link translateLambdaResponse} (v2). The resulting
 * status / headers / body become the CloudFront origin response, around which
 * the behavior's viewer-response function still runs.
 *
 * Out of scope (v1): Function URL response streaming (`InvokeMode:
 * RESPONSE_STREAM`) — the Lambda is invoked buffered; IAM (`AWS_IAM`) auth on
 * the Function URL is not enforced locally.
 */

/** The request shape the CloudFront server hands to a Lambda Function URL origin. */
export interface LambdaUrlOriginRequest {
  method: string;
  /** Request path (no query string), e.g. `/api/items`. */
  uri: string;
  /** Raw query string (no leading `?`), e.g. `a=1&b=2`. Empty when none. */
  querystring: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  sourceIp?: string;
}

/** The origin response from a Lambda Function URL invoke. */
export interface LambdaUrlOriginResult {
  statusCode: number;
  /** Lowercased single-valued headers (no `set-cookie` — see {@link cookies}). */
  headers: Record<string, string>;
  /** One full `Set-Cookie:` value per entry (the v2 `cookies` field). */
  cookies: string[];
  body: Buffer;
}

/**
 * Build the Function URL v2 event from the request, invoke the Lambda, and
 * translate its response. `invoke` is the warm RIE container's invoke function
 * (from `createFrontDoorLambdaRunner`).
 */
export async function serveLambdaUrlOrigin(args: {
  invoke: (event: Record<string, unknown>) => Promise<unknown>;
  functionUrlLogicalId: string;
  functionLogicalId: string;
  request: LambdaUrlOriginRequest;
}): Promise<LambdaUrlOriginResult> {
  const { request } = args;
  const snapshot: HttpRequestSnapshot = {
    method: request.method,
    rawUrl: request.querystring ? `${request.uri}?${request.querystring}` : request.uri,
    headers: normalizeHeaders(request.headers),
    body: request.body,
    ...(request.sourceIp !== undefined && { sourceIp: request.sourceIp }),
  };
  const route: DiscoveredRoute = {
    method: 'ANY',
    pathPattern: '$default',
    lambdaLogicalId: args.functionLogicalId,
    source: 'function-url',
    apiVersion: 'v2',
    stage: '$default',
    apiLogicalId: args.functionUrlLogicalId,
    invokeMode: 'BUFFERED',
    declaredAt: args.functionUrlLogicalId,
  };
  const ctx: MatchedRouteContext = { route, pathParameters: {}, matchedPath: request.uri };
  const event = buildHttpApiV2Event(snapshot, ctx);
  const payload = await args.invoke(event);
  const translated = translateLambdaResponse(payload, 'v2');
  return {
    statusCode: translated.statusCode,
    headers: translated.headers,
    cookies: translated.cookies,
    body: translated.body,
  };
}

/**
 * Convert Node's incoming-header map (`string | string[] | undefined`) into the
 * `Record<string, string[]>` shape {@link HttpRequestSnapshot} expects. A
 * comma-joined string header (Node's default for most duplicates) is passed
 * through as a single element; an array header is preserved.
 */
function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value : [value];
  }
  return out;
}
