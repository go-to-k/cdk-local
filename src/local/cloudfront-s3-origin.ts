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
  /** Test seam: override the object fetcher so unit tests need no real S3. */
  fetchObject?: S3ObjectFetcher;
}

/** Serve one URI from the deployed S3 origin, honoring default-root-object + custom error responses. */
export type S3OriginReader = (input: {
  uri: string;
  defaultRootObject?: string;
  customErrorResponses?: readonly ResolvedCustomErrorResponse[];
}) => Promise<StaticOriginResult>;

/**
 * Build a reader that serves a deployed S3 bucket on demand. The S3 client is
 * created lazily on first read (and reused) so an all-local distribution never
 * touches the SDK. Boot-time bound to one `bucketName`; one reader per origin.
 */
export function createS3OriginReader(
  bucketName: string,
  options: S3OriginReaderOptions = {}
): S3OriginReader {
  const fetchObject = options.fetchObject ?? defaultFetchObject(bucketName, options);
  let deniedWarned = false;

  return async (input) => {
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
    }

    // No object and no usable custom-error page: a plain 404 (mirrors the
    // local-dir static origin's terminal case).
    return {
      statusCode: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from(`Not found: ${input.uri}\n`),
    };
  };
}

/** A minimal structural view of the S3 client + command this module uses. */
interface S3Access {
  client: { send(command: unknown): Promise<unknown> };
  GetObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
}

/** The default fetcher: a real S3 `GetObject`, classifying the SDK error into the outcome union. */
function defaultFetchObject(bucketName: string, options: S3OriginReaderOptions): S3ObjectFetcher {
  // The S3 client is built once on first use and reused across reads.
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

  return async (key) => {
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
