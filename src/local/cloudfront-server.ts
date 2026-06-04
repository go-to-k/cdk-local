import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { getLogger } from '../utils/logger.js';
import { albPathPatternMatches } from './alb-path-matcher.js';
import {
  buildViewerRequestEvent,
  buildViewerResponseEvent,
  runViewerRequest,
  runViewerResponse,
  type CfResponse,
  type CfValue,
} from './cloudfront-function-runtime.js';
import type {
  ResolvedBehavior,
  ResolvedDistribution,
  ResolvedOrigin,
} from './cloudfront-resolver.js';
import { serveLambdaUrlOrigin } from './cloudfront-lambda-origin.js';
import { serveFromStaticOrigin } from './cloudfront-static-origin.js';
import type { FrontDoorTlsMaterials } from './front-door-tls.js';
import { applyCorsResponseHeadersFromConfig, matchPreflight } from './cors-handler.js';

/**
 * Invoke a warm Lambda RIE container with a Function URL event, keyed by the
 * backing `AWS::Lambda::Function` logical id. The command boots one per unique
 * Function URL origin at startup (issue #376); the server looks them up by the
 * `lambda-url` origin's `functionLogicalId`.
 */
export type LambdaUrlInvokerMap = Map<string, (event: Record<string, unknown>) => Promise<unknown>>;

/**
 * Local HTTP / HTTPS server that serves an `AWS::CloudFront::Distribution`'s
 * viewer-request -> S3 origin -> viewer-response pipeline (issue #363). Per
 * request it picks the matching cache behavior, runs the behavior's
 * viewer-request CloudFront Function (short-circuiting on a generated
 * response), serves the (possibly rewritten) URI from the behavior's resolved
 * S3 origin directory, then runs the viewer-response function — exactly the
 * routing the deployed distribution would, reproduced locally so a rewrite /
 * routing change is verifiable in seconds.
 *
 * The resolved distribution is held behind a mutable cell so `--watch` can
 * atomically swap it via {@link StartedCloudFrontServer.update}; the listening
 * socket is never recreated.
 */

/** A running local CloudFront server. */
export interface StartedCloudFrontServer {
  /** The base URL the server is listening on (e.g. `http://127.0.0.1:8080`). */
  url: string;
  /** The bound port. */
  port: number;
  /** `http` or `https`. */
  scheme: 'http' | 'https';
  /** Swap the served distribution (a `--watch` reload). */
  update(distribution: ResolvedDistribution): void;
  /** Stop listening. */
  close(): Promise<void>;
}

export interface StartCloudFrontServerOptions {
  distribution: ResolvedDistribution;
  host: string;
  port: number;
  /** TLS materials for an HTTPS listener; plain HTTP when absent. */
  tls?: FrontDoorTlsMaterials;
  /**
   * Invokers for `lambda-url` origins, keyed by backing-function logical id.
   * Built once at boot (the warm RIE containers) and NOT recreated on a
   * `--watch` reload — a `lambda-url` origin appearing only after a reload has
   * no invoker and is served as 502 (restart to boot it).
   */
  lambdaInvokers?: LambdaUrlInvokerMap;
}

/** Start the local CloudFront server and resolve once it is listening. */
export async function startCloudFrontServer(
  options: StartCloudFrontServerOptions
): Promise<StartedCloudFrontServer> {
  const logger = getLogger().child('cloudfront');
  // Mutable cell so `--watch` can swap the routing model under the live socket.
  // The Lambda invokers are boot-time only (warm containers), so they live
  // outside the swappable distribution cell.
  const lambdaInvokers: LambdaUrlInvokerMap = options.lambdaInvokers ?? new Map();
  const state: { distribution: ResolvedDistribution } = { distribution: options.distribution };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res, state, lambdaInvokers, logger).catch((err) => {
      logger.warn(`Request handling failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
      }
      if (!res.writableEnded) res.end('Internal error in cdkl start-cloudfront.\n');
    });
  };

  const scheme: 'http' | 'https' = options.tls ? 'https' : 'http';
  const server: Server = options.tls
    ? createHttpsServer({ cert: options.tls.certPem, key: options.tls.keyPem }, handler)
    : createHttpServer(handler);

  const port = await listen(server, options.host, options.port);
  const url = `${scheme}://${options.host}:${port}`;
  return {
    url,
    port,
    scheme,
    update(distribution: ResolvedDistribution): void {
      state.distribution = distribution;
    },
    close(): Promise<void> {
      return new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    },
  };
}

/** The per-request pipeline: behavior match -> viewer-request -> origin -> viewer-response. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: { distribution: ResolvedDistribution },
  lambdaInvokers: LambdaUrlInvokerMap,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const distribution = state.distribution;
  const rawUrl = req.url ?? '/';
  const queryIdx = rawUrl.indexOf('?');
  const uri = queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
  const querystring = queryIdx === -1 ? '' : rawUrl.slice(queryIdx + 1);

  const behavior = matchBehavior(distribution.behaviors, uri);
  if (!behavior) {
    writePlain(res, 404, 'No cache behavior matched.\n');
    return;
  }

  // CloudFront answers a CORS preflight at the edge from the behavior's
  // ResponseHeadersPolicy — before the origin. Reproduce that: a matching
  // OPTIONS preflight short-circuits with the canonical 204 + CORS headers.
  // A non-matching / non-preflight OPTIONS falls through to the origin.
  if (behavior.cors) {
    const preflight = matchPreflight(
      { method: req.method ?? 'GET', headers: nodeHeadersToRecord(req.headers) },
      behavior.cors
    );
    if (preflight) {
      res.statusCode = preflight.statusCode;
      setHeadersSafely(res, preflight.headers, logger);
      res.end();
      return;
    }
  }

  // Build the viewer-request event and run the viewer-request function.
  let requestEvent = buildViewerRequestEvent({
    method: req.method ?? 'GET',
    uri,
    querystring,
    headers: req.headers,
    ip: req.socket.remoteAddress ?? '127.0.0.1',
    distributionId: distribution.logicalId,
    domainName: req.headers.host ?? 'localhost',
    requestId: `cdkl-${Date.now().toString(36)}-${Math.floor(performance.now()).toString(36)}`,
  });

  let effectiveUri = uri;
  if (behavior.viewerRequest) {
    const outcome = await runViewerRequest(behavior.viewerRequest, requestEvent);
    if (outcome.kind === 'response') {
      writeCfResponse(res, outcome.response, logger);
      return;
    }
    effectiveUri = outcome.request.uri;
    requestEvent = {
      ...requestEvent,
      request: outcome.request,
    };
  }

  // Resolve + serve from the behavior's origin.
  const origin = distribution.origins.get(behavior.targetOriginId);
  const originResult = await serveFromOrigin(origin, behavior, {
    uri: effectiveUri,
    querystring,
    method: req.method ?? 'GET',
    headers: req.headers,
    // The body is buffered lazily — only a Lambda Function URL origin reads it;
    // a static S3 origin never does, so an S3 GET pays no buffering cost.
    readBody: () => readRequestBody(req),
    sourceIp: req.socket.remoteAddress ?? '127.0.0.1',
    distribution,
    lambdaInvokers,
    logger,
  });
  if (!originResult) return writePlain(res, 502, originUnavailableMessage(origin, behavior));

  // Run the viewer-response function over the origin response.
  let finalStatus = originResult.statusCode;
  let finalHeaders = originResult.headers;
  if (behavior.viewerResponse) {
    const responseEvent = buildViewerResponseEvent(requestEvent, {
      statusCode: originResult.statusCode,
      headers: originResult.headers,
    });
    const mutated = await runViewerResponse(behavior.viewerResponse, responseEvent);
    finalStatus = mutated.statusCode;
    finalHeaders = cfHeadersToPlain(mutated.headers, originResult.headers);
  }

  // Collect Set-Cookie from BOTH the origin's v2 cookies[] and any set-cookie a
  // viewer-response function added (the flat header map can't carry multiple),
  // pulling the latter out of finalHeaders so it isn't dropped or double-set.
  const setCookies = [...(originResult.setCookies ?? [])];
  for (const name of Object.keys(finalHeaders)) {
    if (name.toLowerCase() === 'set-cookie') {
      setCookies.push(finalHeaders[name]!);
      delete finalHeaders[name];
    }
  }

  res.statusCode = finalStatus;
  setHeadersSafely(res, finalHeaders, logger);
  if (setCookies.length > 0) {
    try {
      res.setHeader('set-cookie', setCookies);
    } catch (err) {
      logger.warn(
        `Skipping invalid Set-Cookie header(s): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  // Add the behavior's ResponseHeadersPolicy CORS headers to the actual
  // response (Access-Control-Allow-Origin + Vary / credentials / expose),
  // last so they win — CloudFront's CorsConfig.OriginOverride applies the
  // policy over any header the origin set. No-op without a request Origin or
  // an allowed one.
  if (behavior.cors) {
    const origin = req.headers.origin;
    applyCorsResponseHeadersFromConfig(
      res,
      behavior.cors,
      typeof origin === 'string' ? origin : undefined
    );
  }
  res.end(originResult.body);
}

/**
 * Convert Node's `IncomingMessage.headers` (`Record<string, string | string[]>`)
 * to the lowercased `Record<string, string[]>` shape `matchPreflight` expects.
 */
function nodeHeadersToRecord(headers: IncomingMessage['headers']): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value : [value];
  }
  return out;
}

/** Read the full request body into a Buffer. */
function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

/**
 * Set response headers, skipping any whose name / value Node rejects (invalid
 * HTTP token, CR/LF injection) rather than throwing an opaque 500. A CloudFront
 * Function can return an arbitrary header map; a malformed entry should fail
 * loudly on that one header, not the whole response. CR/LF is stripped from
 * values defensively before the set.
 */
function setHeadersSafely(
  res: ServerResponse,
  headers: Record<string, string>,
  logger: ReturnType<typeof getLogger>
): void {
  for (const [name, value] of Object.entries(headers)) {
    try {
      res.setHeader(name, value.replace(/[\r\n]/g, ''));
    } catch (err) {
      logger.warn(
        `Skipping invalid response header '${name}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/** The origin-serve result before viewer-response runs. */
interface OriginResult {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  /** Set-Cookie values emitted alongside the flat header map (Lambda origins). */
  setCookies?: string[];
}

interface ServeFromOriginArgs {
  uri: string;
  querystring: string;
  method: string;
  headers: IncomingMessage['headers'];
  /** Lazily buffer the request body — called only by a Lambda Function URL origin. */
  readBody: () => Promise<Buffer>;
  sourceIp: string;
  distribution: ResolvedDistribution;
  lambdaInvokers: LambdaUrlInvokerMap;
  logger: ReturnType<typeof getLogger>;
}

async function serveFromOrigin(
  origin: ResolvedOrigin | undefined,
  behavior: ResolvedBehavior,
  args: ServeFromOriginArgs
): Promise<OriginResult | undefined> {
  const { distribution, logger } = args;
  if (behavior.hasLambdaEdge) {
    logger.warn(
      `Behavior ${behavior.pathPattern ?? '(default)'} carries a Lambda@Edge association; cdk-local does not run Lambda@Edge — serving the origin only.`
    );
  }
  if (!origin) return undefined;

  if (origin.kind === 'lambda-url') {
    const invoke = args.lambdaInvokers.get(origin.functionLogicalId);
    if (!invoke) return undefined;
    const result = await serveLambdaUrlOrigin({
      invoke,
      functionUrlLogicalId: origin.functionUrlLogicalId,
      functionLogicalId: origin.functionLogicalId,
      request: {
        method: args.method,
        uri: args.uri,
        querystring: args.querystring,
        headers: args.headers,
        body: await args.readBody(),
        sourceIp: args.sourceIp,
      },
    });
    return {
      statusCode: result.statusCode,
      headers: result.headers,
      body: result.body,
      ...(result.cookies.length > 0 && { setCookies: result.cookies }),
    };
  }

  if (origin.kind !== 's3') return undefined;
  const result = serveFromStaticOrigin({
    localDirs: origin.localDirs,
    uri: args.uri,
    ...(distribution.defaultRootObject !== undefined && {
      defaultRootObject: distribution.defaultRootObject,
    }),
    customErrorResponses: distribution.customErrorResponses,
  });
  return { statusCode: result.statusCode, headers: result.headers, body: result.body };
}

function originUnavailableMessage(
  origin: ResolvedOrigin | undefined,
  behavior: ResolvedBehavior
): string {
  if (!origin)
    return `Behavior ${behavior.pathPattern ?? '(default)'} targets unknown origin '${behavior.targetOriginId}'.\n`;
  if (origin.kind === 'lambda-url') {
    return (
      `Origin '${origin.originId}' is a Lambda Function URL origin whose backing function ` +
      `'${origin.functionLogicalId}' was not booted (it was added after start-up). Restart start-cloudfront.\n`
    );
  }
  if (origin.kind === 'custom') {
    return (
      `Origin '${origin.originId}' is a custom (non-S3) origin (${origin.domainName}). ` +
      'cdkl start-cloudfront serves S3 origins and Lambda Function URL origins only.\n'
    );
  }
  return (
    `Origin '${origin.originId}' is an S3 origin with no resolvable local source. ` +
    `Point it at a directory with --origin ${origin.originId}=<dir>.\n`
  );
}

/**
 * Pick the cache behavior for a URI: the first `CacheBehaviors[]` entry (in
 * declared order) whose path pattern matches, else the default behavior. The
 * default behavior is the entry with no `pathPattern`.
 */
export function matchBehavior(
  behaviors: readonly ResolvedBehavior[],
  uri: string
): ResolvedBehavior | undefined {
  let fallback: ResolvedBehavior | undefined;
  for (const behavior of behaviors) {
    if (behavior.pathPattern === undefined) {
      fallback = behavior;
      continue;
    }
    if (albPathPatternMatches(behavior.pathPattern, uri)) return behavior;
  }
  return fallback;
}

function writeCfResponse(
  res: ServerResponse,
  response: CfResponse,
  logger: ReturnType<typeof getLogger>
): void {
  res.statusCode = response.statusCode;
  setHeadersSafely(res, cfHeadersToPlain(response.headers, {}), logger);
  const body = cfResponseBody(response);
  res.end(body);
}

function cfResponseBody(response: CfResponse): Buffer {
  if (response.body === undefined) return Buffer.alloc(0);
  if (typeof response.body === 'string') return Buffer.from(response.body);
  const data = response.body.data ?? '';
  return response.body.encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data);
}

/** Flatten a CloudFront header map (`{ name: { value } }`) to `{ name: value }`. */
function cfHeadersToPlain(
  cf: Record<string, CfValue>,
  base: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const [name, val] of Object.entries(cf)) {
    if (val.multiValue && val.multiValue.length > 0) {
      out[name] = val.multiValue.map((m) => m.value).join(', ');
    } else {
      out[name] = val.value;
    }
  }
  return out;
}

function writePlain(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(body);
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      server.removeListener('error', rejectPort);
      resolvePort(bound);
    });
  });
}
