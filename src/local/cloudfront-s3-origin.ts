import { getEmbedConfig } from './embed-config.js';
import { getLogger } from '../utils/logger.js';
import {
  contentTypeForKey,
  resolveErrorResponseCandidates,
  uriToKey,
  type ResolvedCustomErrorResponse,
  type StaticOriginResult,
} from './cloudfront-static-origin.js';

/**
 * Serve a distribution's S3 origin by reading the DEPLOYED bucket from real S3
 * on demand (issue #405). This is the front/back-split path: the CDK repo
 * defines the CloudFront distribution + S3 bucket (and the CloudFront
 * Functions) but the static files were uploaded out of band (a separate
 * frontend repo / pipeline), so there is no BucketDeployment source asset in
 * the cloud assembly to serve locally. Under `--from-cfn-stack`, the command
 * resolves the bucket's physical name from deployed state and hands it here.
 *
 * Reading the origin content from real S3 is consistent with cdk-local's scope
 * split — application compute runs locally; managed services stay real AWS. The
 * request-time read fetches ONLY the object a request touches (no pre-sync), so
 * a CDN bucket with tens/hundreds of thousands of objects is fine: a test
 * touches a handful. The fetched bytes live only in memory for that one
 * request (no local disk; a read-through cache is a possible follow-up).
 *
 * The URI->key mapping, default-root-object, MIME, and the `CustomErrorResponses`
 * fallback are reused from {@link cloudfront-static-origin} — only the leaf
 * "read a local file" becomes "S3 GetObject". So a deployed-S3 origin resolves
 * exactly the keys / error pages the local-dir static origin would.
 */

/** Static / STS-issued credentials for the S3 read (a subset of the SDK's `AwsCredentialIdentity`). */
export interface S3OriginCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Outcome of fetching one object from the bucket. */
export type S3FetchResult =
  | { kind: 'found'; body: Buffer }
  | { kind: 'not-found' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

/**
 * Fetch a single object key from the bucket. The default implementation calls
 * the real S3 `GetObject`; a test seam can inject a fake. Returns a discriminated
 * outcome so the reader can map a missing key to the SPA fallback and an
 * access-denied to an actionable error (vs masking it as a 404).
 */
export type S3ObjectFetcher = (key: string) => Promise<S3FetchResult>;

export interface S3OriginReaderOptions {
  /** S3 client region (the bucket's region; resolved from `--stack-region` / `--region` / synth region). */
  region?: string;
  /** Explicit credentials (`--profile`-resolved); when absent the SDK's default credential chain is used. */
  credentials?: S3OriginCredentials;
  /**
   * Read-through cache: when `true`, a fetched object's bytes are kept in
   * memory for the session so a repeat request for the same key does NOT
   * re-`GetObject` (issue #405 follow-up). Default `false` — every request
   * re-reads, so an out-of-band S3 content change is always reflected. The
   * cache is cleared on a `--watch` reload via {@link S3OriginReader.clearCache}.
   */
  cache?: boolean;
  /** Test seam: override the object fetcher so unit tests need no real S3. */
  fetchObject?: S3ObjectFetcher;
}

/** Serve one URI from the deployed S3 origin, honoring default-root-object + custom error responses. */
export interface S3OriginReader {
  (input: {
    uri: string;
    defaultRootObject?: string;
    customErrorResponses?: readonly ResolvedCustomErrorResponse[];
  }): Promise<StaticOriginResult>;
  /**
   * Release the underlying S3 client (destroy its socket pool). Called on
   * server shutdown so an embedding host that restarts servers in-process
   * does not leak connections; a no-op when no client was created (an
   * all-cached session, or an injected test fetcher).
   */
  close(): Promise<void>;
  /** Drop the read-through cache (called on a `--watch` reload). No-op when caching is off. */
  clearCache(): void;
}

/**
 * Build a reader that serves a deployed S3 bucket on demand. The S3 client is
 * created lazily on first read (and reused) so an all-local distribution never
 * touches the SDK. Boot-time bound to one `bucketName`; one reader per origin.
 */
export function createS3OriginReader(
  bucketName: string,
  options: S3OriginReaderOptions = {}
): S3OriginReader {
  const source = options.fetchObject
    ? { fetch: options.fetchObject, close: async (): Promise<void> => undefined }
    : defaultFetchObject(bucketName, options);
  let deniedWarned = false;
  // Read-through cache of `found` objects (opt-in). Only successful reads are
  // cached; a miss / denial is re-tried each request (cheap + always current).
  const cache = options.cache ? new Map<string, Buffer>() : undefined;

  const fetchObject: S3ObjectFetcher = async (key) => {
    const hit = cache?.get(key);
    if (hit) return { kind: 'found', body: hit };
    const result = await source.fetch(key);
    if (result.kind === 'found') cache?.set(key, result.body);
    return result;
  };

  const reader = (async (input: {
    uri: string;
    defaultRootObject?: string;
    customErrorResponses?: readonly ResolvedCustomErrorResponse[];
  }): Promise<StaticOriginResult> => {
    const key = uriToKey(input.uri, input.defaultRootObject);
    if (key !== '') {
      const direct = await fetchObject(key);
      if (direct.kind === 'found') {
        return {
          statusCode: 200,
          headers: { 'content-type': contentTypeForKey(key) },
          body: direct.body,
        };
      }
      // A genuine credential / OAC-policy denial is a config problem, not a
      // missing page — surface it (once) with the --origin escape hatch rather
      // than masking it as a 404 SPA fallback.
      if (direct.kind === 'denied' && !deniedWarned) {
        deniedWarned = true;
        getLogger().warn(
          `S3 denied reading '${key}' from bucket '${bucketName}'. If this is an OAC-locked / private ` +
            `bucket your credentials cannot read, point the origin at a local directory with ` +
            `--origin <originId>=<dir> (or use credentials with s3:GetObject on the bucket). ` +
            `${getEmbedConfig().cliName} start-cloudfront reads the origin from real S3.`
        );
      }
      if (direct.kind === 'error') {
        getLogger().warn(
          `S3 read of '${key}' from bucket '${bucketName}' failed: ${direct.message}`
        );
      }
    }

    // Missing / forbidden key -> the distribution's CustomErrorResponses (SPA
    // fallback). The error page also lives in the bucket, so fetch it too.
    for (const candidate of resolveErrorResponseCandidates(input.customErrorResponses)) {
      const page = await fetchObject(candidate.errorKey);
      if (page.kind === 'found') {
        return {
          statusCode: candidate.responseCode,
          headers: { 'content-type': contentTypeForKey(candidate.errorKey) },
          body: page.body,
        };
      }
      // A denied / errored error-page read can't be served and isn't a plain
      // miss — log it (the primary-key denial already named --origin) so it is
      // not silently swallowed on the way to the terminal 404.
      if (page.kind === 'denied' || page.kind === 'error') {
        getLogger().warn(
          `S3 could not read custom-error page '${candidate.errorKey}' from bucket '${bucketName}' ` +
            `(${page.kind}); falling through.`
        );
      }
    }

    // No object and no usable custom-error page: a plain 404 (mirrors the
    // local-dir static origin's terminal case).
    return {
      statusCode: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from(`Not found: ${input.uri}\n`),
    };
  }) as unknown as S3OriginReader;

  reader.close = source.close;
  reader.clearCache = (): void => cache?.clear();
  return reader;
}

/** A minimal structural view of the S3 client + command this module uses. */
interface S3Access {
  client: { send(command: unknown): Promise<unknown>; destroy(): void };
  GetObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
}

/**
 * The default object source: a real S3 `GetObject` (classifying the SDK error
 * into the outcome union) plus a `close` that destroys the lazily-created
 * client's socket pool. The client is built once on first read and reused.
 */
function defaultFetchObject(
  bucketName: string,
  options: S3OriginReaderOptions
): { fetch: S3ObjectFetcher; close: () => Promise<void> } {
  let init: Promise<S3Access> | null = null;
  const getAccess = (): Promise<S3Access> => {
    if (!init) {
      init = (async () => {
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const client = new S3Client({
          ...(options.region && { region: options.region }),
          ...(options.credentials && {
            credentials: {
              accessKeyId: options.credentials.accessKeyId,
              secretAccessKey: options.credentials.secretAccessKey,
              ...(options.credentials.sessionToken && {
                sessionToken: options.credentials.sessionToken,
              }),
            },
          }),
        });
        return {
          client: client as unknown as S3Access['client'],
          GetObjectCommand: GetObjectCommand as unknown as S3Access['GetObjectCommand'],
        };
      })();
    }
    return init;
  };

  const fetch: S3ObjectFetcher = async (key) => {
    try {
      const { client, GetObjectCommand } = await getAccess();
      const res = (await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))) as {
        Body?: { transformToByteArray(): Promise<Uint8Array> };
      };
      if (!res.Body) return { kind: 'not-found' };
      const bytes = await res.Body.transformToByteArray();
      return { kind: 'found', body: Buffer.from(bytes) };
    } catch (err) {
      return classifyS3Error(err);
    }
  };

  const close = async (): Promise<void> => {
    if (!init) return; // client never created (e.g. an all-cached session)
    try {
      (await init).client.destroy();
    } catch {
      /* best-effort */
    }
  };

  return { fetch, close };
}

/**
 * Classify an S3 SDK error: a missing key (`NoSuchKey` / 404) is `not-found`
 * (try the SPA fallback), an `AccessDenied` / 403 is `denied` (a credential /
 * OAC config problem), anything else is `error`.
 */
export function classifyS3Error(err: unknown): S3FetchResult {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  const status = e?.$metadata?.httpStatusCode;
  const name = e?.name;
  if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return { kind: 'not-found' };
  if (status === 403 || name === 'AccessDenied' || name === 'Forbidden') return { kind: 'denied' };
  return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
}
