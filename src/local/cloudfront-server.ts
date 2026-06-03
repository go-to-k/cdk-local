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
import { serveFromStaticOrigin } from './cloudfront-static-origin.js';
import type { FrontDoorTlsMaterials } from './front-door-tls.js';

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
}

/** Start the local CloudFront server and resolve once it is listening. */
export async function startCloudFrontServer(
  options: StartCloudFrontServerOptions
): Promise<StartedCloudFrontServer> {
  const logger = getLogger().child('cloudfront');
  // Mutable cell so `--watch` can swap the routing model under the live socket.
  const state: { distribution: ResolvedDistribution } = { distribution: options.distribution };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res, state, logger).catch((err) => {
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
  const originResult = serveFromOrigin(origin, behavior, effectiveUri, distribution, logger);
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

  res.statusCode = finalStatus;
  setHeadersSafely(res, finalHeaders, logger);
  res.end(originResult.body);
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
}

function serveFromOrigin(
  origin: ResolvedOrigin | undefined,
  behavior: ResolvedBehavior,
  uri: string,
  distribution: ResolvedDistribution,
  logger: ReturnType<typeof getLogger>
): OriginResult | undefined {
  if (behavior.hasLambdaEdge) {
    logger.warn(
      `Behavior ${behavior.pathPattern ?? '(default)'} carries a Lambda@Edge association; cdk-local does not run Lambda@Edge — serving the S3 origin only.`
    );
  }
  if (!origin || origin.kind !== 's3') return undefined;
  const result = serveFromStaticOrigin({
    localDirs: origin.localDirs,
    uri,
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
  if (origin.kind === 'custom') {
    return (
      `Origin '${origin.originId}' is a custom (non-S3) origin (${origin.domainName}). ` +
      'cdkl start-cloudfront serves S3 origins only.\n'
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
