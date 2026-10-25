import { existsSync, rmSync, statSync } from 'fs';
import { dirname } from 'path';
import { AssetManifestLoader } from '../assets/asset-manifest-loader.js';
import { resolveAssetSourcePath } from '../assets/asset-source-path.js';
import type { AssetManifest, FileAsset } from '../types/assets.js';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import { CdkLocalError } from '../utils/error-handler.js';
import { displayIdent } from '../utils/ident-display.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { getEmbedConfig } from './embed-config.js';
import { assetPathDirs, materializeAssetCodeDir } from './lambda-resolver.js';

/**
 * A web function revision's code, as `cdkl start-web-function` runs it — seam 1
 * of the two that keep a new code source out of the command (issue #831). Only
 * `planWebFunctionContainer` (web-function-runner) and
 * {@link disposeWebFunctionArtifact} switch on `kind`; the command never reads
 * an artifact's fields. A container-image source becomes a new member here plus
 * one arm in each, and the target resolver, the env and the serve loop stay.
 */
export type WebFunctionArtifact = WebFunctionZipArtifact | WebFunctionImageArtifact;

/** A zip bundle from `CodeConfig.S3Object`, matched to a file asset in cdk.out. */
export interface WebFunctionZipArtifact {
  kind: 'zip';
  /** `RuntimeConfig.Runtime`, looked up in the runtime table by the caller. */
  runtime: string;
  /** The bundle's package root on the host, bind-mounted read-only. */
  codeDir: string;
  /** Set when `codeDir` was extracted from a `.zip` asset; the caller removes it. */
  tmpDir?: string;
  /** The matched asset's manifest key (its source hash), for the boot log. */
  assetHash: string;
}

/**
 * RESERVED for a container-image `CodeConfig` source. No resolver produces it
 * yet; `planWebFunctionContainer` refuses it with a clear error, so adding the
 * source later is a change to the resolver and that one function's arm, not to
 * the command.
 */
export interface WebFunctionImageArtifact {
  kind: 'image';
  imageUri: string;
}

/** The `BuildConfig` of a revision, parsed before any file is touched. */
export interface WebFunctionCodeConfig {
  runtime: string;
  s3Object: { bucket: unknown; key: string; versionId?: string };
}

/** The `CodeConfig` keys this version resolves. Anything else fails naming the key. */
const SUPPORTED_CODE_CONFIG_KEYS: readonly string[] = ['S3Object'];

/**
 * Parse a revision's `BuildConfig` into its runtime and code source. Fails on a
 * `CodeConfig` key cdk-local does not know — naming it, never ignoring it — and
 * on an `S3Object.Key` that is not a literal string (a CDK asset's key always
 * is, so that is a bucket/key from outside this app).
 */
export function parseWebFunctionBuildConfig(
  revisionLogicalId: string,
  buildConfig: unknown
): WebFunctionCodeConfig {
  const subject = `Web function revision ${displayIdent(revisionLogicalId)}`;
  const build = asObject(buildConfig);
  const runtime = asObject(build?.['RuntimeConfig'])?.['Runtime'];
  if (typeof runtime !== 'string' || runtime.length === 0) {
    throw new CdkLocalError(
      `${subject} has no literal BuildConfig.RuntimeConfig.Runtime.`,
      'LOCAL_START_WEB_FUNCTION_NO_RUNTIME'
    );
  }
  const codeConfig = asObject(build?.['CodeConfig']);
  if (!codeConfig) {
    throw new CdkLocalError(
      `${subject} has no BuildConfig.CodeConfig object.`,
      'LOCAL_START_WEB_FUNCTION_NO_CODE_CONFIG'
    );
  }
  const unknownKeys = Object.keys(codeConfig).filter(
    (k) => !SUPPORTED_CODE_CONFIG_KEYS.includes(k)
  );
  if (unknownKeys.length > 0) {
    throw new CdkLocalError(
      `${subject} uses BuildConfig.CodeConfig.${unknownKeys.map((k) => displayIdent(k)).join(', ')}, ` +
        `which ${getEmbedConfig().cliName} start-web-function does not support yet. Supported: ` +
        `${SUPPORTED_CODE_CONFIG_KEYS.join(', ')}.`,
      'LOCAL_START_WEB_FUNCTION_UNSUPPORTED_CODE_CONFIG'
    );
  }
  const s3 = asObject(codeConfig['S3Object']);
  if (!s3) {
    throw new CdkLocalError(
      `${subject} has no BuildConfig.CodeConfig.S3Object.`,
      'LOCAL_START_WEB_FUNCTION_NO_CODE_CONFIG'
    );
  }
  const key = s3['Key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new CdkLocalError(
      `${subject} has a CodeConfig.S3Object.Key that is not a literal string ` +
        `(${describeValue(key)}). The code must come from a CDK asset in this app ` +
        `(for example an s3assets.Asset passing asset.s3BucketName / asset.s3ObjectKey), ` +
        `whose key synthesizes as a literal.`,
      'LOCAL_START_WEB_FUNCTION_CODE_KEY_NOT_LITERAL'
    );
  }
  const versionId = s3['VersionId'];
  return {
    runtime,
    s3Object: {
      bucket: s3['Bucket'],
      key,
      ...(typeof versionId === 'string' && { versionId }),
    },
  };
}

/**
 * Find the file asset in a stack's cdk.out manifest whose S3 destination is
 * `key` (exactly, or as the last segment of a prefixed key), falling back to
 * the manifest entry keyed by the key's hash (`<hash>.zip`). Exported for
 * unit testing.
 */
export function findFileAssetForObjectKey(
  manifest: AssetManifest,
  key: string
): { hash: string; asset: FileAsset } | undefined {
  for (const [hash, asset] of Object.entries(manifest.files ?? {})) {
    for (const dest of Object.values(asset.destinations ?? {})) {
      if (dest.objectKey === key || dest.objectKey.endsWith(`/${key}`)) return { hash, asset };
    }
  }
  const hash = key.replace(/^.*\//, '').replace(/\.zip$/, '');
  const byHash = Object.hasOwn(manifest.files ?? {}, hash) ? manifest.files[hash] : undefined;
  return byHash ? { hash, asset: byHash } : undefined;
}

/**
 * Resolve a revision's code to a local artifact. Today: the `S3Object` matched
 * against the stack's cdk.out file assets, its source directory (or an
 * extracted copy of a `.zip` source) ready to bind-mount.
 *
 * An `S3Object` that matches no local asset FAILS naming the bucket and key —
 * cdk-local does not download deployed code for a web function.
 */
export async function resolveWebFunctionArtifact(
  stack: StackInfo,
  revisionLogicalId: string,
  code: WebFunctionCodeConfig,
  loader: AssetManifestLoader = new AssetManifestLoader()
): Promise<WebFunctionArtifact> {
  const subject = `Web function revision ${displayUntrustedValue(revisionLogicalId)} code bundle`;
  const notFound = (): CdkLocalError =>
    new CdkLocalError(
      `${subject} (S3Object bucket ${describeValue(code.s3Object.bucket)}, key ` +
        `${displayUntrustedValue(code.s3Object.key)}) matches no file asset in this app's cdk.out. ` +
        `${getEmbedConfig().cliName} start-web-function runs code that comes from a CDK asset in ` +
        `this app (for example an s3assets.Asset of a directory); it does not download deployed ` +
        `code. Re-synthesize the app, or point the revision at an asset.`,
      'LOCAL_START_WEB_FUNCTION_CODE_ASSET_NOT_FOUND'
    );
  const manifestPath = stack.assetManifestPath;
  if (!manifestPath) throw notFound();
  const manifestDir = dirname(manifestPath);
  const manifest = await loader.loadStackManifest(stack, manifestDir);
  const match = manifest ? findFileAssetForObjectKey(manifest, code.s3Object.key) : undefined;
  if (!match) throw notFound();

  if (typeof match.asset.source.path !== 'string' || match.asset.source.path.length === 0) {
    throw new CdkLocalError(
      `${subject} matches file asset ${displayIdent(match.hash)}, which has no source.path ` +
        `(it is produced by source.executable at publish time), so there is no staged bundle ` +
        `in cdk.out to mount. Give the revision an asset of a directory or a .zip file ` +
        `(for example s3assets.Asset with path: '<dir>').`,
      'LOCAL_START_WEB_FUNCTION_CODE_ASSET_NO_PATH'
    );
  }
  const sourcePath = resolveAssetSourcePath({
    manifestDir,
    value: match.asset.source.path,
    assetOutdir: assetPathDirs(stack).assetOutdir,
    absolute: 'honour-warn',
    field: 'source.path',
    subject,
    action: 'mount it',
    sink: 'bind-mount that directory into the web function container',
    wrapError: (message) =>
      new CdkLocalError(message, 'LOCAL_START_WEB_FUNCTION_CODE_SOURCE_ESCAPES_ASSEMBLY'),
  });
  if (!existsSync(sourcePath)) {
    throw new CdkLocalError(
      `${subject} source ${displayUntrustedValue(sourcePath)} does not exist. Re-synthesize the app and retry.`,
      'LOCAL_START_WEB_FUNCTION_CODE_SOURCE_MISSING'
    );
  }
  if (!statSync(sourcePath).isDirectory() && !sourcePath.endsWith('.zip')) {
    throw new CdkLocalError(
      `${subject} source ${displayUntrustedValue(sourcePath)} is neither a directory nor a .zip ` +
        `archive, so it is not a code bundle.`,
      'LOCAL_START_WEB_FUNCTION_CODE_SOURCE_NOT_BUNDLE'
    );
  }
  const materialized = materializeAssetCodeDir(sourcePath);
  return {
    kind: 'zip',
    runtime: code.runtime,
    codeDir: materialized.dir,
    ...(materialized.tmpDir !== undefined && { tmpDir: materialized.tmpDir }),
    assetHash: match.hash,
  };
}

/**
 * Release what {@link resolveWebFunctionArtifact} created on the host (a zip's
 * extracted temp dir). Idempotent and best-effort; the per-kind knowledge lives
 * here so the command never inspects an artifact's fields.
 */
export function disposeWebFunctionArtifact(artifact: WebFunctionArtifact | undefined): void {
  if (artifact?.kind !== 'zip' || artifact.tmpDir === undefined) return;
  try {
    if (existsSync(artifact.tmpDir)) rmSync(artifact.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A template value for an error line: a literal as itself, an intrinsic as JSON. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return displayUntrustedValue(value);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return displayUntrustedValue(json ?? String(value));
}
