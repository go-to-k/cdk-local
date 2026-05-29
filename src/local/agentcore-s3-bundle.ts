import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { CdkLocalError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import { getEmbedConfig } from './embed-config.js';

/**
 * Download + extract a `fromS3` AgentCore CodeConfiguration bundle.
 *
 * A `fromS3` runtime points `AgentRuntimeArtifact.CodeConfiguration.Code.S3` at
 * a pre-existing S3 object (a ZIP of the agent source). `cdkl invoke-agentcore`
 * fetches it with the resolved credentials, extracts it to a temp dir, and runs
 * the SAME from-source build the `fromCodeAsset` path uses
 * ({@link buildAgentCoreCodeImage}) — so the only new surface here is the
 * download + unzip; the build + run + protocol-client path is unchanged.
 */

/** Literal S3 object location of a fromS3 code bundle. */
export interface S3BundleLocation {
  bucket: string;
  key: string;
  versionId?: string;
}

/** Static / STS-issued credentials for the S3 download. */
export interface S3BundleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface DownloadS3BundleOptions {
  /** Region for the S3 client (resolved from `--stack-region` / `--region` / env). */
  region?: string;
  /** `--profile` to authenticate the download (ignored when `credentials` is set). */
  profile?: string;
  /** Explicit credentials (e.g. STS temp creds from `--assume-role`); win over `profile`. */
  credentials?: S3BundleCredentials;
  /** Injected object fetcher for tests — bypasses the AWS SDK entirely. */
  fetchObject?: (location: S3BundleLocation) => Promise<Uint8Array>;
}

export interface ExtractedS3Bundle {
  /** Temp dir the bundle was extracted into (feed to the from-source build). */
  dir: string;
  /** Remove the temp dir (best-effort). */
  cleanup: () => Promise<void>;
}

/**
 * Download the bundle object, unzip it to a fresh temp dir, and return the dir
 * (plus a `cleanup`). The caller feeds `dir` to {@link buildAgentCoreCodeImage}
 * and calls `cleanup()` once the build is done.
 */
export async function downloadAndExtractS3Bundle(
  location: S3BundleLocation,
  options: DownloadS3BundleOptions = {}
): Promise<ExtractedS3Bundle> {
  const ref = formatRef(location);
  getLogger().info(`Downloading fromS3 code bundle ${ref}...`);

  const bytes = await (options.fetchObject ?? defaultFetchObject(options))(location);

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    throw new CdkLocalError(
      `Failed to unzip the fromS3 code bundle ${ref}: ${err instanceof Error ? err.message : String(err)}. ` +
        `The object must be a ZIP archive of the agent source.`,
      'LOCAL_INVOKE_AGENTCORE_S3_BUNDLE_UNZIP_FAILED'
    );
  }

  const dir = await mkdtemp(join(tmpdir(), `${getEmbedConfig().resourceNamePrefix}-agentcore-s3-`));
  try {
    let wrote = 0;
    for (const [name, content] of Object.entries(files)) {
      if (name.endsWith('/')) continue; // directory entry — no file content
      const dest = resolveSafeEntryPath(dir, name);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content);
      wrote += 1;
    }
    if (wrote === 0) {
      throw new CdkLocalError(
        `The fromS3 code bundle ${ref} contained no files.`,
        'LOCAL_INVOKE_AGENTCORE_S3_BUNDLE_EMPTY'
      );
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }).then(() => undefined),
  };
}

function formatRef(location: S3BundleLocation): string {
  const version = location.versionId ? `?versionId=${location.versionId}` : '';
  return `s3://${location.bucket}/${location.key}${version}`;
}

/**
 * Guard against zip-slip: reject an entry whose normalized path escapes the
 * extraction root (e.g. `../../etc/passwd`).
 */
function resolveSafeEntryPath(root: string, entry: string): string {
  const dest = normalize(join(root, entry));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (dest !== root && !dest.startsWith(rootWithSep)) {
    throw new CdkLocalError(
      `Refusing to extract a fromS3 bundle entry that escapes the target dir: '${entry}'.`,
      'LOCAL_INVOKE_AGENTCORE_S3_BUNDLE_ZIP_SLIP'
    );
  }
  return dest;
}

function defaultFetchObject(
  options: DownloadS3BundleOptions
): (location: S3BundleLocation) => Promise<Uint8Array> {
  return async (location) => {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      ...(options.region && { region: options.region }),
      ...(options.profile && !options.credentials && { profile: options.profile }),
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
    try {
      const res = await client.send(
        new GetObjectCommand({
          Bucket: location.bucket,
          Key: location.key,
          ...(location.versionId && { VersionId: location.versionId }),
        })
      );
      if (!res.Body) {
        throw new CdkLocalError(
          `S3 GetObject for ${formatRef(location)} returned an empty body.`,
          'LOCAL_INVOKE_AGENTCORE_S3_BUNDLE_EMPTY_BODY'
        );
      }
      return await res.Body.transformToByteArray();
    } finally {
      client.destroy();
    }
  };
}
