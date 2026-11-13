import { readFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import type { AssetManifest, DockerImageAsset, FileAsset } from '../types/assets.js';
import {
  displayUntrustedValue,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../utils/assembly-path.js';
import { getLogger } from '../utils/logger.js';
import { displayStackName } from '../utils/ident-display.js';
import { resolveAssetSourcePath } from './asset-source-path.js';

/**
 * Asset manifest loader
 *
 * Loads and parses CDK asset manifests from the CDK output directory
 */
export class AssetManifestLoader {
  private logger = getLogger().child('AssetManifestLoader');

  /**
   * Load a STACK's asset manifest: the file the assembly itself names
   * (`stack.assetManifestPath`) when the stack carries one, else
   * `<fallbackDir>/<stackName>.assets.json`.
   *
   * Never rebuild the file name from `stackName` when the path is known: CDK
   * names the manifest after the ARTIFACT id, which differs from the physical
   * name for every stack under a `cdk.Stage` (`MyStageApiA576A1D2.assets.json`
   * for `MyStage-Api`) and for any stack with an explicit `stackName`, so the
   * rebuilt name is a silent ENOENT and the stack's docker-image assets go
   * unresolved (#746). The directory is the manifest's own, which every caller
   * already treated as the asset base.
   */
  async loadStackManifest(
    stack: { stackName: string; assetManifestPath?: string | undefined },
    fallbackDir: string
  ): Promise<AssetManifest | null> {
    if (stack.assetManifestPath) {
      return this.loadManifest(
        dirname(stack.assetManifestPath),
        stack.stackName,
        basename(stack.assetManifestPath)
      );
    }
    return this.loadManifest(fallbackDir, stack.stackName);
  }

  /**
   * Load asset manifest from CDK output directory
   *
   * @param cdkOutputDir CDK output directory (e.g., "cdk.out")
   * @param stackName Stack name
   * @param fileName The manifest's file name; `<stackName>.assets.json` by
   *   default. Prefer {@link loadStackManifest}, which takes it from the
   *   assembly.
   * @returns Asset manifest or null if not found
   */
  async loadManifest(
    cdkOutputDir: string,
    stackName: string,
    fileName: string = `${stackName}.assets.json`
  ): Promise<AssetManifest | null> {
    // The name comes from the assembly's own `manifest.json`, so a
    // hand-modified one can carry `../../x` and point this read outside the
    // directory. CloudFormation stack names cannot contain `/`, so no real
    // synth reaches the refusal (go-to-k/cdk-local#745).
    const resolved = resolveAssemblyPath(cdkOutputDir, fileName);
    if (!resolved.contained) {
      throw new Error(
        `Refusing to read the asset manifest for stack ` +
          `${displayUntrustedValue(stackName)}: it ` +
          renderAssemblyPathEscape(resolved, cdkOutputDir, 'read it')
      );
    }
    // The caller's own spelling, as before: the verdict above is about the
    // same file, and a relative `--output` keeps reading relative.
    const manifestPath = join(cdkOutputDir, fileName);

    try {
      this.logger.debug(`Loading asset manifest from: ${displayUntrustedValue(manifestPath)}`);
      const content = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as AssetManifest;

      this.logger.debug(
        `Loaded asset manifest: ${Object.keys(manifest.files).length} file assets, ` +
          `${Object.keys(manifest.dockerImages).length} docker image assets`
      );

      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug(`Asset manifest not found: ${displayUntrustedValue(manifestPath)}`);
        return null;
      }

      throw new Error(
        `Failed to load asset manifest from ${displayUntrustedValue(manifestPath)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get file assets from manifest (excludes CloudFormation templates)
   *
   * @param manifest Asset manifest
   * @returns Map of asset hash to file asset
   */
  getFileAssets(manifest: AssetManifest): Map<string, FileAsset> {
    const fileAssets = new Map<string, FileAsset>();

    for (const [assetHash, asset] of Object.entries(manifest.files)) {
      // Skip CloudFormation templates (they have .json extension)
      if (asset.source.path.endsWith('.json') || asset.source.path.endsWith('.template.json')) {
        this.logger.debug(
          `Skipping CloudFormation template asset: ${displayStackName(asset.displayName)}`
        );
        continue;
      }

      fileAssets.set(assetHash, asset);
    }

    this.logger.debug(`Found ${fileAssets.size} file assets (excluding templates)`);
    return fileAssets;
  }

  /**
   * Get a file asset's source directory (absolute path), REFUSING a
   * `source.path` that leaves `opts.assetOutdir` (go-to-k/cdk-local#745).
   *
   * The value resolves against `cdkOutputDir` with `path.join` semantics, as
   * it always has, so an ABSOLUTE value is folded under it rather than
   * honoured (`'fold'` in `resolveAssetSourcePath`). `assetOutdir` is the
   * app's outdir — `assetPathDirs(stack).assetOutdir` — and is REQUIRED so a
   * caller cannot silently bound a Stage's `../asset.<hash>` at the manifest
   * directory.
   *
   * The one reader is the AgentCore CodeConfiguration bundle, which builds an
   * image FROM this directory; `subject` names it in the refusal.
   */
  getAssetSourcePath(
    cdkOutputDir: string,
    asset: FileAsset,
    opts: { assetOutdir: string; subject: string; wrapError: (message: string) => Error }
  ): string {
    return resolveAssetSourcePath({
      manifestDir: cdkOutputDir,
      value: asset.source.path,
      assetOutdir: opts.assetOutdir,
      absolute: 'fold',
      field: 'source.path',
      subject: opts.subject,
      action: 'build an image from it',
      sink: 'build an image from that directory and run it locally',
      wrapError: opts.wrapError,
    });
  }

  /**
   * Resolve asset destination values (replace ${AWS::AccountId}, ${AWS::Region}, etc.)
   *
   * @param value Value with placeholders
   * @param accountId AWS account ID
   * @param region AWS region
   * @param partition AWS partition (default: "aws")
   * @returns Resolved value
   */
  resolveAssetDestinationValue(
    value: string,
    accountId: string,
    region: string,
    partition = 'aws'
  ): string {
    return value
      .replace(/\$\{AWS::AccountId\}/g, accountId)
      .replace(/\$\{AWS::Region\}/g, region)
      .replace(/\$\{AWS::Partition\}/g, partition);
  }
}

/**
 * Look up the docker-image asset that backs a Lambda's `Code.ImageUri`.
 *
 * The CDK template synthesizes `Code.ImageUri` as a `Fn::Sub` whose body
 * references the bootstrap ECR repo and ends in `:<hash>` — that hash is
 * the same key used in `manifest.dockerImages[<hash>]`. cdk-local extracts the
 * hash by walking known image-URI shapes; on miss, when the manifest has
 * exactly one Docker image AND the URI points at that asset's own
 * destination repository (the `repositoryName` the synthesizer recorded for
 * it, e.g. `cdk-hnb659fds-container-assets-<account>-<region>`), we fall back
 * to it (single-asset heuristic) — this covers digest pins
 * (`@sha256:<digest>`) and custom tags on the asset repository.
 *
 * A URI in any other repository (a literal registry path, a
 * `DockerImageCode.fromEcr` repository) never takes the fallback, even when
 * the stack has exactly one Docker image asset: that asset belongs to a
 * different function, and running it would silently execute that
 * function's code (go-to-k/cdk-local#946). Such a URI returns `undefined`
 * so the caller takes its own ECR-pull / emulator-refusal path.
 *
 * Returns the `(hash, asset)` pair when matched, or `undefined` when both
 * the regex AND the single-asset fallback miss (typically: 0 docker assets,
 * 2+ docker assets with no hash match, or a URI outside the asset's
 * repository — the caller should treat this as "fall through to the
 * ECR-pull path").
 *
 * Exported as a free function (not a method) so the local-invoke modules
 * can reuse it without depending on the `AssetManifestLoader` instance —
 * the manifest itself is a plain JSON shape.
 */
export function getDockerImageBySourceHash(
  manifest: AssetManifest,
  imageUri: string
): { hash: string; asset: DockerImageAsset } | undefined {
  const dockerImages = manifest.dockerImages ?? {};
  const entries = Object.entries(dockerImages);
  if (entries.length === 0) return undefined;

  // Try to extract the hash from the ImageUri tail. Match `:<hash>` (NOT
  // `@sha256:<digest>` — those are immutable digest pins which never carry
  // the source hash; we fall through to the single-asset heuristic for
  // those). The hash itself is hex-only in CDK's bootstrap layout.
  const hash = extractHashFromImageUri(imageUri);
  if (hash !== undefined) {
    const asset = dockerImages[hash];
    if (asset) {
      return { hash, asset };
    }
  }

  // Single-asset fallback: when the user has exactly one Docker image in
  // the stack and the URI points at that asset's destination repository,
  // it is the one being invoked. Avoids hard-failing on hash-extraction
  // misses (digest pins, custom tags). A URI in any other repository is
  // NOT that asset (go-to-k/cdk-local#946).
  if (entries.length === 1) {
    const [singleHash, singleAsset] = entries[0]!;
    if (imageUriTargetsAssetRepository(imageUri, singleAsset)) {
      return { hash: singleHash, asset: singleAsset };
    }
  }

  return undefined;
}

/**
 * Whether `imageUri`'s repository path is one of the asset's destination
 * `repositoryName`s. Either side may still carry `${AWS::...}` placeholders
 * (`${AWS::AccountId}` / `${AWS::Region}`) — the template body and the
 * manifest are written by the same synthesizer, but a resolver may have
 * substituted some of them on the URI side, and the two sides can each keep
 * a different one — so a pseudo parameter on either side matches any
 * non-empty run of characters on the other.
 */
function imageUriTargetsAssetRepository(imageUri: string, asset: DockerImageAsset): boolean {
  const repo = extractRepositoryFromImageUri(imageUri);
  if (repo === undefined) return false;
  for (const dest of Object.values(asset.destinations ?? {})) {
    const name = dest?.repositoryName;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (pseudoParameterPatternsOverlap(name, repo)) return true;
  }
  return false;
}

/**
 * The repository path of an image URI: everything after the registry host
 * (the first `/`) with the `@<digest>` or `:<tag>` suffix removed.
 * `undefined` when the URI has no registry host (a bare Docker Hub name is
 * never a CDK asset destination).
 */
function extractRepositoryFromImageUri(imageUri: string): string | undefined {
  const slash = imageUri.indexOf('/');
  if (slash < 0) return undefined;
  let path = imageUri.slice(slash + 1);
  const at = path.indexOf('@');
  if (at >= 0) path = path.slice(0, at);
  const lastSlash = path.lastIndexOf('/');
  const colon = path.lastIndexOf(':');
  // A `:` after the last `/` is the tag separator; one inside a `${AWS::...}`
  // placeholder is not (it is always followed by `}` before the end).
  if (colon > lastSlash && !path.slice(colon).includes('}')) path = path.slice(0, colon);
  return path.length > 0 ? path : undefined;
}

/** Stands for one `${AWS::...}` pseudo parameter in a tokenized repository name. */
const PSEUDO_PARAMETER = Symbol('pseudo-parameter');

/**
 * Whether two repository names can denote the same repository, where each
 * `${AWS::...}` pseudo parameter on EITHER side stands for any non-empty run
 * of characters other than `/` on the other (so `a-123-${AWS::Region}` and
 * `a-${AWS::AccountId}-us-east-1` overlap). Any other `${...}` (e.g. a
 * `${MyRepo}` resource reference) is compared literally, so it can never
 * widen into a wildcard.
 */
function pseudoParameterPatternsOverlap(a: string, b: string): boolean {
  const ta = tokenizePseudoParameters(a);
  const tb = tokenizePseudoParameters(b);
  const memo = new Map<number, boolean>();
  const match = (i: number, j: number): boolean => {
    if (i === ta.length || j === tb.length) return i === ta.length && j === tb.length;
    const key = i * (tb.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result = false;
    if (ta[i] === PSEUDO_PARAMETER) {
      for (let k = j; k < tb.length && tb[k] !== '/' && !result; k++) result = match(i + 1, k + 1);
    } else if (tb[j] === PSEUDO_PARAMETER) {
      for (let k = i; k < ta.length && ta[k] !== '/' && !result; k++) result = match(k + 1, j + 1);
    } else {
      result = ta[i] === tb[j] && match(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function tokenizePseudoParameters(value: string): (string | typeof PSEUDO_PARAMETER)[] {
  const tokens: (string | typeof PSEUDO_PARAMETER)[] = [];
  const parts = value.split(/\$\{AWS::[^}]*\}/);
  parts.forEach((part, index) => {
    if (index > 0) tokens.push(PSEUDO_PARAMETER);
    tokens.push(...Array.from(part));
  });
  return tokens;
}

/**
 * Extract the source hash from a Lambda `Code.ImageUri` string. CDK's
 * bootstrap layout ends every image URI in `:<hex-hash>`, and that hash
 * is the same key used in the asset manifest's `dockerImages` map.
 *
 * Returns `undefined` for shapes we can't parse (digest pins, missing tag,
 * etc.) — the caller falls back to the single-asset heuristic.
 */
function extractHashFromImageUri(imageUri: string): string | undefined {
  // Reject digest-pinned URIs. `<repo>@sha256:<digest>` carries no hash.
  if (imageUri.includes('@sha256:')) return undefined;

  // Match `:<hex-hash>` at the very end of the URI. `cdk-hnb659fds-container-assets-...:<64-hex>`
  // is the typical shape; we accept any 8+-character hex tail to be lenient.
  const match = /:([a-f0-9]{8,})$/.exec(imageUri);
  return match?.[1];
}
