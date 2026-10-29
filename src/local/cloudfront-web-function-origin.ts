import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { stripHopByHopHeaders } from './front-door-server.js';
import { formatAuthority } from '../utils/url-authority.js';

/**
 * Serve a CloudFront behavior whose origin is a Lambda Web Function endpoint
 * (go-to-k/cdkd#5516) by forwarding the origin request over HTTP to the locally
 * running revision server (booted by the command, the way `start-web-function`
 * runs it). A web function is a plain HTTP server, so the origin request is the
 * viewer request after the edge stages: same method, path, query string, body
 * and headers, minus the hop-by-hop ones, with `Host` naming the origin and the
 * client address appended to `X-Forwarded-For`, as CloudFront does.
 *
 * The response is buffered — the viewer-response stages run over it — and an
 * origin that cannot be reached answers 502, one that does not answer within
 * the origin's read timeout 504, CloudFront's own statuses for those cases.
 * The OAC SigV4 signing CloudFront adds has no local counterpart and is not
 * reproduced; the endpoint's `AuthType` is not enforced locally either.
 */

/** CloudFront's default `OriginReadTimeout`, in seconds. */
export const DEFAULT_ORIGIN_READ_TIMEOUT_SECONDS = 30;

/** Where a booted web function server answers. */
export interface WebFunctionOriginTarget {
  host: string;
  port: number;
}

/** The request the CloudFront server hands to a Web Function endpoint origin. */
export interface WebFunctionOriginRequest {
  method: string;
  /** Request path (no query string). */
  uri: string;
  /** Raw query string (no leading `?`); empty when none. */
  querystring: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  sourceIp?: string;
}

/** The origin response, flattened the way the other origin kinds return one. */
export interface WebFunctionOriginResult {
  statusCode: number;
  /** Lowercased single-valued headers (no `set-cookie` — see {@link cookies}). */
  headers: Record<string, string>;
  /** One full `Set-Cookie:` value per entry. */
  cookies: string[];
  body: Buffer;
}

/** Forward one origin request to the web function server and buffer its response. */
export function serveWebFunctionOrigin(args: {
  target: WebFunctionOriginTarget;
  request: WebFunctionOriginRequest;
  /** `CustomOriginConfig.OriginReadTimeout` in seconds; default 30. */
  readTimeoutSeconds?: number;
}): Promise<WebFunctionOriginResult> {
  const { target, request } = args;
  const timeoutMs = (args.readTimeoutSeconds ?? DEFAULT_ORIGIN_READ_TIMEOUT_SECONDS) * 1000;
  const headers = buildOriginRequestHeaders(request, target);
  if (request.body.length > 0) headers['content-length'] = String(request.body.length);
  const path = request.querystring ? `${request.uri}?${request.querystring}` : request.uri;

  return new Promise<WebFunctionOriginResult>((resolveResult) => {
    let settled = false;
    const settle = (result: WebFunctionOriginResult): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const req = httpRequest(
      // agent: false — one connection per origin request, so no pooled socket
      // outlives a server that restarted or a CloudFront server that closed.
      { host: target.host, port: target.port, method: request.method, path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          settle({
            statusCode: res.statusCode ?? 502,
            ...splitResponseHeaders(res.headers),
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', (err) => settle(originError(502, err.message)));
      }
    );
    req.setTimeout(timeoutMs, () => {
      settle(
        originError(
          504,
          `the web function server did not answer within the origin read timeout (${timeoutMs / 1000}s)`
        )
      );
      req.destroy();
    });
    req.on('error', (err) => settle(originError(502, err.message)));
    req.end(request.body.length > 0 ? request.body : undefined);
  });
}

/**
 * The headers the origin request carries: the viewer's, without the hop-by-hop
 * set (and `content-length`, re-derived from the buffered body), `Host`
 * naming the origin, and the client address appended to `X-Forwarded-For`.
 * Exported for unit testing.
 */
export function buildOriginRequestHeaders(
  request: Pick<WebFunctionOriginRequest, 'headers' | 'sourceIp'>,
  target: WebFunctionOriginTarget
): Record<string, string | string[]> {
  const headers: NodeJS.Dict<string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name.toLowerCase()] = value;
  }
  stripHopByHopHeaders(headers);
  delete headers['content-length'];
  headers['host'] = formatAuthority(target.host, target.port);
  if (request.sourceIp !== undefined) {
    const prior = headers['x-forwarded-for'];
    const priorValue = Array.isArray(prior) ? prior.join(', ') : prior;
    headers['x-forwarded-for'] = priorValue
      ? `${priorValue}, ${request.sourceIp}`
      : request.sourceIp;
  }
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Split a Node response header map into the flat map and the `Set-Cookie`
 * list, without the hop-by-hop headers and `content-length` (the CloudFront
 * server re-frames the body, which a response stage may replace).
 */
function splitResponseHeaders(raw: IncomingHttpHeaders): {
  headers: Record<string, string>;
  cookies: string[];
} {
  const copy: NodeJS.Dict<string | string[]> = { ...raw };
  stripHopByHopHeaders(copy);
  delete copy['content-length'];
  const cookies = copy['set-cookie'];
  delete copy['set-cookie'];
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(copy)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return {
    headers,
    cookies: cookies === undefined ? [] : Array.isArray(cookies) ? cookies : [cookies],
  };
}

function originError(statusCode: 502 | 504, detail: string): WebFunctionOriginResult {
  return {
    statusCode,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    cookies: [],
    body: Buffer.from(
      `${statusCode === 502 ? 'Bad Gateway' : 'Gateway Timeout'}: ${detail.replace(/[\r\n]+/g, ' ')}\n`
    ),
  };
}
