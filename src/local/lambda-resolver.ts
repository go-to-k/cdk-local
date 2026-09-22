import {
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';
import {
  derivePartitionAndUrlSuffix,
  derivePseudoParametersFromRegion,
  tryResolveImageFnJoin,
} from './intrinsic-image.js';
import { stringifyValue } from '../utils/stringify.js';
import { sanitizeServiceExceptionMessage } from './credential-error.js';
import {
  absoluteAssemblyPathEscape,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../utils/assembly-path.js';
import { getLogger } from '../utils/logger.js';
import { getEmbedConfig } from './embed-config.js';

/**
 * Result of resolving a `cdkl invoke <target>` argument back to a
 * concrete Lambda function in the synthesized assembly.
 *
 * Discriminated union (PR 5, D5.3): `kind === 'zip'` for traditional
 * Node.js / Python ZIP-packaged Lambdas; `kind === 'image'` for container
 * Lambdas (`Code.ImageUri`). The two variants have meaningfully different
 * fields — `runtime` / `handler` / `codePath` are zip-only, while
 * `dockerSource` / `imageConfig` / `architecture` are image-only — so the
 * compiler can enforce exhaustive handling at the consumer (the
 * `local-invoke.ts` CLI command branch).
 *
 * Orthogonal future fields (e.g. PR 6 layers) live on the base interface
 * so they apply to both variants without each adding a copy.
 */
export type ResolvedLambda = ResolvedZipLambda | ResolvedImageLambda;

interface ResolvedLambdaBase {
  /** Stack the function belongs to. */
  stack: StackInfo;
  /** CloudFormation logical ID of the function. */
  logicalId: string;
  /** Raw template entry (for property reads beyond what's surfaced here). */
  resource: TemplateResource;
  /** `MemorySize` from the template, or 128 when omitted (Lambda default). */
  memoryMb: number;
  /** `Timeout` (seconds) from the template, or 3 when omitted (Lambda default). */
  timeoutSec: number;
  /**
   * Resolved Lambda layers (PR 6 of #224, issue #232). Each entry points
   * at an `AWS::Lambda::LayerVersion` resource in the same stack — the
   * `logicalId` lets the caller emit clearer error messages, `assetPath`
   * is the absolute directory under `cdk.out` (resolved via the same
   * `Metadata['aws:asset:path']` hint Lambda code uses) that bind-mounts
   * at `/opt`. `[]` when the function declares no Layers.
   *
   * **Order is load-bearing**: AWS layer semantics are "last layer wins
   * on file collision", so this array preserves the template's input
   * order. cdk-local implements the last-wins rule by merging every
   * layer's asset directory into a single host tmpdir IN TEMPLATE ORDER
   * (later layers overwrite earlier files, `copyLayerTreeLastWins`), then
   * bind-mounting the merged tmpdir at `/opt:ro`. Docker
   * rejects multiple `-v ...:/opt:ro` entries at the same target path
   * (`Error response from daemon: Duplicate mount point: /opt`) — bind
   * mounts are NOT layered the way the OCI image stack is — so the
   * merge happens on the host, not via overlay layering. The single-
   * layer case skips the copy and bind-mounts the asset dir directly.
   *
   * Out of scope for v1 (any of these hard-error at resolution time):
   *   - Cross-stack / cross-account / cross-region layer ARNs (anything
   *     that isn't a same-stack `Ref` / `Fn::GetAtt[..., Ref]` pointing
   *     at an `AWS::Lambda::LayerVersion`).
   *   - Layers without `Metadata['aws:asset:path']` (i.e. layers whose
   *     content is `S3Bucket`/`S3Key` from outside cdk.out — there's no
   *     local directory to bind-mount).
   */
  layers: ResolvedLambdaLayer[];
  /**
   * `Properties.EphemeralStorage.Size` (issue #440). CDK 2.x's
   * `lambda.Function({ ephemeralStorageSize: cdk.Size.gibibytes(N) })`
   * synthesizes `Properties.EphemeralStorage: { Size: <N * 1024> }`
   * — the value is the templated `/tmp` cap in **MiB** (CFn property
   * range 512..10240). Threaded through to docker's `--tmpfs
   * /tmp:rw,size=<N>m` so handlers that exceed the deployed cap fail
   * locally with `ENOSPC` the way they would on AWS, and handlers
   * that detect free space via `statvfs` / `df` see the templated
   * size rather than the host's overlay-fs.
   *
   * Undefined when `Properties.EphemeralStorage` is absent — the
   * container's `/tmp` is then whatever the base image provides (AWS
   * Lambda base images don't mount a sized tmpfs themselves, so this
   * preserves the pre-#440 behavior). Applies to both ZIP and IMAGE
   * Lambdas — `--tmpfs` overlays inside container Lambdas just like
   * it does on the public base images.
   */
  ephemeralStorageMb?: number;
}

/**
 * One entry of a Lambda's resolved `Properties.Layers`. Two shapes:
 *
 *   - `kind: 'asset'` — same-stack `AWS::Lambda::LayerVersion`
 *     reference (the original PR 6 path). `assetPath` is the absolute
 *     directory under `cdk.out` ready to bind-mount at `/opt`.
 *   - `kind: 'arn'` — pre-existing literal-ARN entry the CDK template
 *     points at directly (AWS Lambda Powertools, Datadog Extension,
 *     shared internal layers, cross-account / cross-region references).
 *     The layer ZIP is NOT yet on disk; the CLI materializes it via
 *     `materializeLayerFromArn(...)` (issue #448) right before the
 *     docker container starts. Carrying the parsed ARN fields here
 *     keeps the resolver pure-functional (no AWS SDK calls) and lets
 *     the materializer be tested independently.
 */
export type ResolvedLambdaLayer = ResolvedAssetLambdaLayer | ResolvedArnLambdaLayer;

export interface ResolvedAssetLambdaLayer {
  kind: 'asset';
  /**
   * CFn logical ID of the `AWS::Lambda::LayerVersion` resource.
   * Shared field name with the `kind: 'arn'` variant so callers can
   * read a uniform identifier without first narrowing the union.
   */
  logicalId: string;
  /**
   * Absolute path on disk to the layer's unzipped asset directory. Will
   * be bind-mounted at `/opt` inside the container (read-only). The
   * directory is laid out per AWS's runtime-specific load-path
   * conventions (`opt/python/...`, `opt/nodejs/...`, etc.) — cdk-local does
   * NOT inspect the contents, just hands the directory to docker.
   */
  assetPath: string;
}

export interface ResolvedArnLambdaLayer {
  kind: 'arn';
  /**
   * Pseudo-logical-id for log lines — set to the literal ARN so
   * iteration code like `layers.map((l) => l.logicalId)` works
   * uniformly across both variants without per-kind narrowing.
   */
  logicalId: string;
  /**
   * Full literal ARN as it appeared in the template
   * (`arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>`). Kept
   * verbatim alongside `logicalId` because callers (the materializer)
   * need the canonical ARN string for SDK calls and the per-kind
   * branch is the only place where the difference matters.
   */
  arn: string;
  /** Region segment extracted from the ARN (e.g. `us-east-1`). */
  region: string;
  /** Account ID segment extracted from the ARN (12 digits). */
  accountId: string;
  /** Layer name segment (the `:layer:<name>:` middle). */
  name: string;
  /** Numeric version segment, as a string for `LayerName:Version` joins. */
  version: string;
}

export interface ResolvedZipLambda extends ResolvedLambdaBase {
  kind: 'zip';
  /** Lambda runtime string (e.g. `nodejs20.x`). */
  runtime: string;
  /** Lambda handler string (e.g. `index.handler`). */
  handler: string;
  /**
   * Resolved local code path. For asset-backed functions, this is the
   * absolute directory under `cdk.out` named by the resource's
   * `Metadata['aws:asset:path']`. For inline `Code.ZipFile` functions,
   * this is `null` and the caller is expected to materialize a temp dir
   * before bind-mounting (handled in the command layer to keep this
   * module side-effect-free).
   */
  codePath: string | null;
  /**
   * For inline Lambdas only: the inline source body. The command layer
   * writes this into a temp dir at the path implied by `handler`.
   */
  inlineCode?: string;
  /**
   * `Architectures: [x86_64]` (default) or `[arm64]`. Threaded through to
   * `--platform linux/amd64` / `linux/arm64` on the warm container's
   * `docker run` (and base-image pull). Without it the base image runs at the
   * host's native arch, so a `provided.*` `bootstrap` compiled for the other
   * arch fails with `exec format error`.
   */
  architecture: 'x86_64' | 'arm64';
}

export interface ResolvedImageLambda extends ResolvedLambdaBase {
  kind: 'image';
  /**
   * Raw `Code.ImageUri` from the template. Used to extract the asset hash
   * for the local-build path AND for the ECR-pull fallback path (when the
   * URI doesn't match any cdk.out asset). Already resolved through
   * cdk-assets bootstrap-placeholder substitution upstream — `${AWS::*}`
   * pseudo-parameters are still present (cdk-local substitutes them at the
   * lookup site since it knows the calling account/region).
   */
  imageUri: string;
  /**
   * `ImageConfig` from the template. All fields are optional — the
   * common case is just `Command: [<handler>]`. Empty `[]` for
   * `entryPoint` means "use the image's default entrypoint" (typically
   * `/lambda-entrypoint.sh` on AWS base images, which routes to RIE).
   */
  imageConfig: {
    command?: string[];
    entryPoint?: string[];
    workingDirectory?: string;
  };
  /**
   * `Architectures: [x86_64]` (default) or `[arm64]`. Threaded through to
   * `--platform linux/amd64` / `linux/arm64` on BOTH `docker build` AND
   * `docker run`. Without this, an arm64 host running an x86_64 Lambda
   * hits emulation; an x86_64 host running arm64 fails with
   * `exec format error`.
   */
  architecture: 'x86_64' | 'arm64';
}

/**
 * Resolve a Lambda's `Architectures` array to a single architecture, defaulting
 * to `x86_64` (AWS's default when the property is omitted). Shared by the ZIP
 * and IMAGE resolution paths so both pin `--platform` to the declared arch —
 * without it a `provided.*` `bootstrap` compiled for one arch fails with
 * `exec format error` when run at the host's native arch.
 */
export function resolveLambdaArchitecture(
  props: Record<string, unknown>,
  logicalId: string
): 'x86_64' | 'arm64' {
  const arches = props['Architectures'];
  if (Array.isArray(arches) && arches.length > 0) {
    const first: unknown = arches[0];
    if (first === 'arm64') return 'arm64';
    if (first === 'x86_64') return 'x86_64';
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has unsupported Architectures value '${String(first)}'. ` +
        `${getEmbedConfig().cliName} supports x86_64 and arm64.`
    );
  }
  return 'x86_64';
}

export class LocalInvokeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalInvokeResolutionError';
    Object.setPrototypeOf(this, LocalInvokeResolutionError.prototype);
  }
}

/**
 * Parse a `target` argument into (optional stack pattern, path-or-id).
 *
 * Two accepted forms:
 *   - `Stack:LogicalId` — colon delimits stack from logical ID. Logical
 *     IDs cannot contain `/` or `:`, so the parse is unambiguous.
 *   - `Stack/Path/...` — display-path form. The stack prefix is the first
 *     `/`-delimited segment; everything after is the construct path
 *     (which itself starts with the same stack name in CDK output, e.g.
 *     `MyStack/MyApi/Handler`).
 *
 * For single-stack apps the stack prefix may be omitted entirely:
 *   - Bare `Handler` is treated as a logical ID in the only stack.
 *   - Bare `MyApi/Handler` is treated as a construct path; the only
 *     stack's name is prepended at lookup time.
 *
 * Returns the raw split. The actual stack-resolution + auto-detect logic
 * lives in `resolveLambdaTarget` so `parseTarget` stays a pure string
 * splitter.
 */
export interface ParsedTarget {
  /**
   * Stack pattern if explicit, else `null`. When `null` the resolver
   * auto-detects the single stack in the app.
   */
  stackPattern: string | null;
  /** Path-or-id portion of the target. */
  pathOrId: string;
  /** `true` iff `pathOrId` looks like a construct path (contains `/`). */
  isPath: boolean;
}

export function parseTarget(target: string): ParsedTarget {
  if (typeof target !== 'string' || target.length === 0) {
    throw new LocalInvokeResolutionError(
      "Empty target. Pass a CDK display path (e.g. 'MyStack/MyApi/Handler') or stack-qualified logical ID (e.g. 'MyStack:MyApiHandler1234ABCD')."
    );
  }

  // Stack:LogicalId form. The colon must precede every slash for this to
  // be the colon form (otherwise `Stack:Foo/bar` is ambiguous and we
  // prefer the path form).
  const colonIdx = target.indexOf(':');
  const slashIdx = target.indexOf('/');
  if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
    const stackPattern = target.substring(0, colonIdx);
    const pathOrId = target.substring(colonIdx + 1);
    if (pathOrId.length === 0) {
      throw new LocalInvokeResolutionError(`Target '${target}' has no logical ID after ':'.`);
    }
    return { stackPattern, pathOrId, isPath: pathOrId.includes('/') };
  }

  // Path form with explicit stack: stack is the first segment.
  if (slashIdx > 0) {
    return { stackPattern: target.substring(0, slashIdx), pathOrId: target, isPath: true };
  }

  // Bare logical ID — single-stack auto-detect path.
  return { stackPattern: null, pathOrId: target, isPath: false };
}

/**
 * Resolve a parsed target against the synthesized stacks. Throws
 * {@link LocalInvokeResolutionError} with an actionable message (listing
 * available Lambdas) on any miss.
 */
export function resolveLambdaTarget(target: string, stacks: StackInfo[]): ResolvedLambda {
  if (stacks.length === 0) {
    throw new LocalInvokeResolutionError('No stacks found in the synthesized assembly.');
  }

  const parsed = parseTarget(target);
  const stack = pickStack(parsed, stacks);

  const template = stack.template;
  const resources = template.Resources ?? {};

  let match: { logicalId: string; resource: TemplateResource } | undefined;

  if (parsed.isPath) {
    // Build the path index once so we can list every available Lambda
    // when the lookup misses.
    const index = buildCdkPathIndex(template);
    const resolvedPaths = resolveCdkPathToLogicalIds(parsed.pathOrId, index);

    // Filter to Lambda functions; keep the rest for an error path.
    const lambdaMatches = resolvedPaths.filter(
      ({ logicalId }) => resources[logicalId]?.Type === 'AWS::Lambda::Function'
    );

    if (lambdaMatches.length === 0) {
      throw notFoundError(target, stack, resources);
    }
    if (lambdaMatches.length > 1) {
      throw new LocalInvokeResolutionError(
        `Target '${target}' matches ${lambdaMatches.length} Lambda functions in ${stack.stackName}: ` +
          lambdaMatches.map((m) => m.logicalId).join(', ') +
          '. Refine the path or use the stack:LogicalId form.'
      );
    }
    const m = lambdaMatches[0]!;
    match = { logicalId: m.logicalId, resource: resources[m.logicalId]! };
  } else {
    const resource = resources[parsed.pathOrId];
    if (!resource) {
      throw notFoundError(target, stack, resources);
    }
    match = { logicalId: parsed.pathOrId, resource };
  }

  const { logicalId, resource } = match;

  if (resource.Type !== 'AWS::Lambda::Function') {
    if (resource.Type.startsWith('Custom::')) {
      throw new LocalInvokeResolutionError(
        `Resource '${logicalId}' in ${stack.stackName} is a Custom Resource (${resource.Type}), not a Lambda function. ` +
          `Custom Resources are invoked by the deploy framework, not by users. ` +
          `If you want to test the underlying handler, target the ServiceToken Lambda directly.`
      );
    }
    throw new LocalInvokeResolutionError(
      `Resource '${logicalId}' in ${stack.stackName} is ${resource.Type}, not a Lambda function. ` +
        `${getEmbedConfig().cliName} only invokes AWS::Lambda::Function resources.`
    );
  }

  return extractLambdaProperties(stack, logicalId, resource, resources);
}

/**
 * Single-stack auto-detect (D4): if the app has exactly one stack, the
 * user may omit the stack prefix. Otherwise an explicit stack pattern is
 * required.
 */
function pickStack(parsed: ParsedTarget, stacks: StackInfo[]): StackInfo {
  if (parsed.stackPattern === null) {
    if (stacks.length === 1) return stacks[0]!;
    throw new LocalInvokeResolutionError(
      `Multiple stacks in app, target '${parsed.pathOrId}' is missing a stack prefix. ` +
        `Use 'StackName:${parsed.pathOrId}' or 'StackName/...' (path form). ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }

  // Reuse the shared stack-matcher so display-path / wildcard semantics
  // line up with deploy / diff / destroy.
  const matched = matchStacks(stacks, [parsed.stackPattern]);
  if (matched.length === 0) {
    throw new LocalInvokeResolutionError(
      `Stack '${parsed.stackPattern}' not found. ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }
  if (matched.length > 1) {
    throw new LocalInvokeResolutionError(
      `Stack pattern '${parsed.stackPattern}' matched ${matched.length} stacks: ` +
        matched.map((s) => s.stackName).join(', ') +
        '. Use a more specific pattern.'
    );
  }
  return matched[0]!;
}

/**
 * Pull the Lambda properties this command cares about out of the
 * template. Validates required fields up front so the docker-runner can
 * assume a fully-typed `ResolvedLambda`.
 *
 * Branches on `Code.ImageUri`: when set the function is a container
 * Lambda (PR 5, D5.3) and the discriminator flips to `kind: 'image'`;
 * `Runtime` / `Handler` are NOT required on this path (D5.5 — AWS
 * contract: container Lambdas don't have `Handler`; invocation is
 * driven by `ImageConfig.Command` or the image's own CMD).
 */
function extractLambdaProperties(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource,
  resources: Record<string, TemplateResource>
): ResolvedLambda {
  const props = resource.Properties ?? {};
  const memoryMb = typeof props['MemorySize'] === 'number' ? props['MemorySize'] : 128;
  const timeoutSec = typeof props['Timeout'] === 'number' ? props['Timeout'] : 3;
  const ephemeralStorageMb = extractEphemeralStorageMb(props, logicalId);

  const code = (props['Code'] ?? {}) as Record<string, unknown>;
  const imageUri = extractImageUri(
    code['ImageUri'],
    logicalId,
    stack.stackName,
    resources,
    stack.region
  );

  if (imageUri !== undefined) {
    return extractImageLambdaProperties({
      stack,
      logicalId,
      resource,
      memoryMb,
      timeoutSec,
      props,
      imageUri,
      // Spread-and-omit so the optional field stays optional at the
      // callee under `exactOptionalPropertyTypes` — passing `undefined`
      // for `ephemeralStorageMb?: number` would be a type error.
      ...(ephemeralStorageMb !== undefined && { ephemeralStorageMb }),
    });
  }

  // ZIP path (D5.5): Runtime + Handler are mandatory.
  const runtime = typeof props['Runtime'] === 'string' ? props['Runtime'] : '';
  const handler = typeof props['Handler'] === 'string' ? props['Handler'] : '';

  if (!runtime) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has no Runtime property and no Code.ImageUri. ` +
        `${getEmbedConfig().productName} cannot tell if this is a ZIP or a container Lambda.`
    );
  }
  if (!handler) {
    throw new LocalInvokeResolutionError(`Lambda '${logicalId}' has no Handler property.`);
  }

  const inlineCode = typeof code['ZipFile'] === 'string' ? code['ZipFile'] : undefined;

  let codePath: string | null = null;
  if (!inlineCode) {
    // Function code may be a ZIP-packaged asset (`Code.fromAsset('bundle.zip')`
    // or a bundling that emits a zip) — `allowZip` accepts the `.zip` file
    // here; the consumer extracts it via `materializeAssetCodeDir` before the
    // bind-mount. Layers still require an unzipped directory.
    codePath = resolveAssetCodePath(stack, logicalId, resource, { allowZip: true });
  }

  // PR 6 (#232): resolve same-stack `Layers` references. Out-of-scope
  // shapes (literal ARNs, cross-stack refs, layers without an asset
  // path) hard-error here so the user sees a clear pointer at the
  // offending entry instead of a silently-missing `/opt/<lib>` at
  // invoke time.
  const layers = resolveLambdaLayers(stack, logicalId, props);
  const architecture = resolveLambdaArchitecture(props, logicalId);

  return {
    kind: 'zip',
    stack,
    logicalId,
    resource,
    runtime,
    handler,
    memoryMb,
    timeoutSec,
    codePath,
    layers,
    architecture,
    ...(ephemeralStorageMb !== undefined && { ephemeralStorageMb }),
    ...(inlineCode !== undefined && { inlineCode }),
  };
}

/**
 * Parse `Properties.EphemeralStorage.Size` (issue #440). CFn shape:
 * `{ EphemeralStorage: { Size: <MiB> } }`. CDK's
 * `cdk.Size.gibibytes(N)` serializes to `N * 1024`. AWS-side range is
 * 512..10240 MiB (the deployed function rejects anything outside that
 * range at create time); cdk-local rejects > 10240 here so a misconfigured
 * template fails fast at `cdkl invoke` boot rather than hanging
 * on a `docker run` that AWS would have refused anyway. The 512 floor
 * is AWS's minimum (the default when `EphemeralStorage` is omitted is
 * also 512), but we deliberately accept values DOWN to 1 so users can
 * exercise the cap with a deliberately-small `/tmp` in local tests —
 * `--tmpfs /tmp:size=Nm` itself enforces no lower bound; the only
 * cross-check is "would AWS accept this?", which the deploy side
 * already gates upstream.
 *
 * Returns `undefined` when the property is absent, NaN, < 1, or
 * non-numeric. Hard-rejects > 10240. Intrinsic-valued sizes (the
 * `{ Ref: 'SomeParam' }` shape that's uncommon for EphemeralStorage
 * but theoretically valid) drop to `undefined` with a one-line warn
 * via the calling logger — local invoke can't resolve those without
 * the template's Parameters context the deploy engine has, and the
 * fallback (no `--tmpfs`) is safer than guessing.
 */
export function extractEphemeralStorageMb(
  props: Record<string, unknown>,
  logicalId: string
): number | undefined {
  const raw = props['EphemeralStorage'];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const size = (raw as Record<string, unknown>)['Size'];
  if (typeof size !== 'number') {
    // Intrinsic-valued or otherwise unresolvable. Drop silently and
    // leave `--tmpfs` off — the deploy side enforces the real range
    // upstream. The `logicalId` argument is kept for parity with the
    // sibling extractors (so a future audit can grep call sites).
    void logicalId;
    return undefined;
  }
  if (!Number.isFinite(size) || size < 1) return undefined;
  if (size > 10240) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has Properties.EphemeralStorage.Size = ${size} MiB, ` +
        'which exceeds the AWS limit of 10240 MiB. AWS would reject the function at deploy time; ' +
        'cap the value to <= 10240 (10 GiB) and retry.'
    );
  }
  // CFn templates may carry fractional MiB values (unusual, but the
  // type is `number`). docker's `--tmpfs size=...m` parser accepts
  // integers only — round down to the nearest MiB to be safe; the
  // worst-case effect is a slightly smaller `/tmp` than templated,
  // which still surfaces the ENOSPC the user wants to catch.
  return Math.floor(size);
}

/**
 * Extract the `Code.ImageUri` value across the shapes CDK actually synthesizes.
 *
 * Supported shapes:
 *
 *   1. Flat string — pass through.
 *   2. `Fn::Sub` (string or `[template, vars]`) — the canonical asset
 *      shape for `lambda.DockerImageCode.fromImageAsset(...)`. The
 *      `${AWS::*}` placeholders survive and are substituted at the
 *      cdk-assets lookup site. Critical bug fix C1 from the PR 5 design
 *      doc: CDK synthesizes
 *      `{Fn::Sub: '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}:<hash>'}`,
 *      NOT a flat string. The hash-extraction regex in the asset
 *      manifest loader works against the substituted form.
 *   3. `Fn::Join` (canonical CDK 2.x shape for
 *      `lambda.DockerImageCode.fromEcr(repo, { tagOrDigest })`) — see
 *      [src/local/intrinsic-image.ts](./intrinsic-image.ts), `tryResolveImageFnJoin`.
 *      For IMPORTED repositories (literal acct-id / region + `Ref:
 *      AWS::URLSuffix` + literal repo path) the resolver returns a
 *      complete ECR URI here without state. For SAME-STACK references
 *      the resolver needs the host's state (`--from-state`) to recover the
 *      repository's account-id / region; without state we surface a
 *      clear error pointing the user at `cdkl invoke --from-state`
 *      / `ContainerImage.fromAsset` / a public-image alternative.
 *
 * Throws `LocalInvokeResolutionError` for `Fn::Join` shapes the resolver
 * recognizes as ECR-shape-needing-state OR malformed; returns `undefined`
 * for genuinely unrecognized shapes so the caller's downstream ZIP-vs-
 * IMAGE branching can route to its existing error path.
 */
function extractImageUri(
  value: unknown,
  logicalId: string,
  stackName: string,
  resources: Record<string, TemplateResource>,
  region: string | undefined
): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sub = obj['Fn::Sub'];
    if (typeof sub === 'string' && sub.length > 0) return sub;
    // Fn::Sub array form: [template, vars]. The first element is the template.
    if (Array.isArray(sub) && typeof sub[0] === 'string') return sub[0];

    // `Fn::Join` — try the shared ECR-URI resolver. Issue #637 plumbed
    // region-derived pseudo parameters (`urlSuffix` / `partition` /
    // `region`) through here so the canonical
    // `lambda.DockerImageCode.fromImageAsset` shape (only intrinsic in
    // the URI is `${AWS::URLSuffix}`) resolves without `--from-state`.
    // Same-stack ECR refs still return `needs-state`; a Join that
    // genuinely references `${AWS::AccountId}` without state returns
    // `not-applicable` with a more specific error.
    if ('Fn::Join' in obj) {
      const pseudoParameters = derivePseudoParametersFromRegion(region);
      const joinResolved = tryResolveImageFnJoin(
        value,
        resources,
        pseudoParameters ? { pseudoParameters } : undefined
      );
      if (joinResolved.kind === 'resolved') return joinResolved.uri;
      if (joinResolved.kind === 'needs-state') {
        throw new LocalInvokeResolutionError(
          `Lambda '${logicalId}' in ${stackName} references same-stack ECR repository '${joinResolved.repoLogicalId}' via Fn::Join. ` +
            `${getEmbedConfig().cliName} cannot resolve the repository URI without state — ` +
            `deploy the stack first (so ${getEmbedConfig().productName} records the repository physical id), ` +
            'rebuild via lambda.DockerImageCode.fromImageAsset, or pin a public image.'
        );
      }
      if (joinResolved.kind === 'unsupported-join') {
        throw new LocalInvokeResolutionError(
          `Lambda '${logicalId}' in ${stackName} has an unsupported Fn::Join Code.ImageUri shape: ${joinResolved.reason}. ` +
            `${getEmbedConfig().cliName} recognizes the canonical CDK 2.x lambda.DockerImageCode.fromEcr Fn::Join shape ` +
            '(delimiter "" with nested Fn::Select/Fn::Split over an ECR Repository Arn GetAtt + Ref to the repo).'
        );
      }
      // `not-applicable` — Join couldn't reduce every element AND no
      // same-stack ECR Repository ref. With #637's pseudo-parameter
      // plumbing the typical remaining cause is `${AWS::AccountId}`
      // (needs an STS call or `--from-state`) or an unknown region.
      const accountIdHint = pseudoParameters
        ? ` (likely \${AWS::AccountId}, which ${getEmbedConfig().productName} cannot derive without --from-state or STS)`
        : ` (${getEmbedConfig().productName} could not derive AWS pseudo parameters because stack.region was undefined)`;
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' in ${stackName} has an Fn::Join Code.ImageUri that ${getEmbedConfig().cliName} cannot resolve${accountIdHint}. ` +
          'Workarounds: deploy first and run with --from-state, or pin a fully-literal public image URI.'
      );
    }
  }
  return undefined;
}

/**
 * Build the IMAGE-variant `ResolvedLambda` from a Lambda template entry
 * with `Code.ImageUri`. `ImageConfig` and `Architectures` are both
 * optional in CFn — the defaults match the AWS-side defaults.
 */
function extractImageLambdaProperties(args: {
  stack: StackInfo;
  logicalId: string;
  resource: TemplateResource;
  memoryMb: number;
  timeoutSec: number;
  ephemeralStorageMb?: number;
  props: Record<string, unknown>;
  imageUri: string;
}): ResolvedImageLambda {
  const { stack, logicalId, resource, memoryMb, timeoutSec, ephemeralStorageMb, props, imageUri } =
    args;

  const rawImageConfig = (props['ImageConfig'] ?? {}) as Record<string, unknown>;
  const imageConfig: ResolvedImageLambda['imageConfig'] = {};
  if (Array.isArray(rawImageConfig['Command'])) {
    imageConfig.command = rawImageConfig['Command'].filter(
      (s): s is string => typeof s === 'string'
    );
  }
  if (Array.isArray(rawImageConfig['EntryPoint'])) {
    imageConfig.entryPoint = rawImageConfig['EntryPoint'].filter(
      (s): s is string => typeof s === 'string'
    );
  }
  if (typeof rawImageConfig['WorkingDirectory'] === 'string') {
    imageConfig.workingDirectory = rawImageConfig['WorkingDirectory'];
  }

  const architecture = resolveLambdaArchitecture(props, logicalId);

  // PR 6 (#232): container Lambdas reject `Layers` at deploy time on
  // the AWS side — layers are baked into the image at build time, not
  // overlaid at runtime. We silently ignore any `Layers` property here
  // (matches AWS behavior at invoke time) by passing an empty list.
  return {
    kind: 'image',
    stack,
    logicalId,
    resource,
    memoryMb,
    timeoutSec,
    imageUri,
    imageConfig,
    architecture,
    layers: [],
    ...(ephemeralStorageMb !== undefined && { ephemeralStorageMb }),
  };
}

/**
 * Where a Lambda's `Metadata['aws:asset:path']` really lives on this host
 * (go-to-k/cdkd#3534, applying the decision taken in go-to-k/cdkd#3494).
 *
 * THE one spelling shared by `cdkl invoke`'s resolver and `cdkl start-api`'s,
 * which each carried their own copy of `isAbsolute(p) ? p : resolve(dir, p)`.
 * A second hand-written copy is how a guard on one twin becomes a guard on
 * neither. It throws through the CALLER's `wrapError` so each site keeps its
 * own error class and names its own command.
 *
 * TWO VALUE SHAPES, ANSWERED DIFFERENTLY, and the asymmetry is the decision
 * rather than an accident:
 *
 * - RELATIVE, escaping. REFUSED. `path.resolve` folds `..` exactly as
 *   `path.join` does, so `../../../home/<user>/.aws` leaves the assembly, and
 *   nothing a real `cdk synth` emits has that shape.
 * - ABSOLUTE. ACCEPTED, with a WARNING naming the path when it leaves the
 *   asset outdir, and SILENCE when it does not.
 *
 * **Why absolute is accepted, when the security axis argued for refusing it.**
 * `cdk synth --no-staging` (context flag `aws:cdk:disable-asset-staging`) makes
 * upstream `AssetStaging.relativeStagedPath` return the staged path verbatim
 * instead of relativising it, so `aws:asset:path` is the asset's absolute
 * SOURCE directory, normally outside the outdir. Refusing it therefore rejects
 * the output of a documented CDK CLI flag, and the user's view is simply that
 * cdk-local will not read what `cdk` just wrote. Record both halves of the
 * trade, because a later reader must not "restore" the refusal as an
 * oversight:
 *
 * - The security cost is genuine. This value is BIND-MOUNTED read-only at
 *   `/var/task` (or `/opt` for a layer) into a container running handler code
 *   the SAME assembly supplied, and the run may carry the caller's
 *   credentials, so an absolute path a hostile assembly chose reaches the host
 *   filesystem. Nothing here can distinguish a `--no-staging` value from a
 *   planted one: both are an absolute directory the assembly named.
 * - What bounds it: this is a LOCAL developer command run against an assembly
 *   the user pointed at, and the warning names the directory so an unexpected
 *   one is visible rather than silent. **Do not count the read-only mount as
 *   the bound.** It stops writes to the tree, not the capability: a read-only
 *   bind of a directory holding a unix socket (`/var/run`, `/run`) still
 *   permits `connect(2)` on, say, `docker.sock`. The warning is the
 *   mitigation.
 *
 * The `..` containment is NOT relaxed with it, but be precise about what it
 * buys. Against an ADVERSARY it stops nothing: they write the ABSOLUTE
 * spelling and reach the same place with a warning instead of a refusal. What
 * it still catches is an ACCIDENTAL or legacy `..`, and it costs nothing,
 * which is why the arm stays. There is no containment boundary here any more;
 * the warning is the whole signal.
 *
 * CONTAIN WITHIN `assetOutdir`, NOT the manifest's directory. A Lambda inside
 * a `cdk.Stage` legitimately carries `../asset.<hash>`, because `cdk synth`
 * stages a Stage's assets into the APP's outdir while the Stage's manifest
 * sits in `cdk.out/assembly-<Stage>/`. Binding to the manifest directory
 * refuses every Stage asset as "hand-modified".
 *
 * Exported for unit testing and for `local-start-api.ts`'s copy of the caller.
 */
export function resolveAssetCodeDirectory(
  manifestDir: string,
  assetPath: string,
  wrapError: (message: string) => Error,
  /**
   * The app's outdir, the CONTAINMENT bound; see the note above for why it is
   * not the manifest's directory.
   *
   * **REQUIRED, and positioned here so OMITTING it is a type error.** The
   * dangerous mistake is not a SWAP, it is a DROP: an optional bound
   * defaulting to `manifestDir` silently refuses every legitimate Stage asset
   * while every top-level test stays green, because there `manifestDir` and
   * `assetOutdir` coincide. `logicalId` comes LAST because it is only ever
   * interpolated into a message — the least dangerous parameter belongs in the
   * position a mistake is least costly. A `logicalId` / `assetOutdir` swap is
   * still expressible and is caught by the tests rather than the compiler: the
   * bound becomes `resolve('<logicalId>')` under the cwd, disjoint from the
   * base, so every path is refused and every Stage acceptance case reds.
   */
  assetOutdir: string,
  logicalId: string
): string {
  if (isAbsolute(assetPath)) {
    // ACCEPTED — see the header. `resolve` only normalises here, the value
    // already being absolute; it is what makes the warning name the directory
    // that is really mounted rather than an unfolded spelling of it.
    const absolute = resolve(assetPath);
    const escape = absoluteAssemblyPathEscape(assetOutdir, absolute);
    if (escape !== undefined) {
      // WARN, never throw: the one producer of this shape is a real
      // `cdk synth --no-staging`, and refusing it rejects the output of a
      // documented CDK CLI flag. The warning exists so an absolute path the
      // user did NOT expect is visible rather than silent, so it names the
      // directory and says what is done with it.
      getLogger().warn(
        `Lambda '${sanitizeServiceExceptionMessage(logicalId)}' has an absolute ` +
          `Metadata['aws:asset:path'] pointing outside the assembly: ` +
          `'${sanitizeServiceExceptionMessage(absolute)}'` +
          (escape.escape === 'symlink'
            ? ` (through a symbolic link to '${sanitizeServiceExceptionMessage(escape.realPath)}')`
            : '') +
          `. ${getEmbedConfig().productName} will read that directory and expose its ` +
          `contents to the container — bind-mounted read-only, or copied when the asset is ` +
          `a .zip or one of several merged layers — where the code in this assembly can ` +
          `read it. This is what cdk synth --no-staging emits, and is expected for it; if ` +
          `you did not synthesize with that flag, treat this assembly as untrusted.`
      );
    }
    return absolute;
  }
  // RESOLVE against the manifest's directory, CONTAIN within the app's outdir.
  const resolved = resolveAssemblyPath(manifestDir, assetPath, {
    containWithin: assetOutdir,
  });
  // NAMING THE BOUND ITSELF is not an escape here, and the two arms must agree
  // about that. `resolveAssemblyPath`'s `isInside` is false for an empty
  // `path.relative` — right for a caller that reads a FILE, wrong here, where
  // the value is a DIRECTORY to bind-mount by design. Left alone it also
  // contradicts the absolute arm, which accepts the same directory.
  if (
    !resolved.contained &&
    resolved.escape === 'lexical' &&
    resolved.path === resolve(assetOutdir)
  ) {
    return resolved.path;
  }
  if (!resolved.contained) {
    // The default provenance sentence blames a hand-modified assembly, and
    // there is ONE legitimate layout it would accuse falsely: `--app` naming a
    // Stage SUB-assembly makes that directory the assembly root, so the
    // Stage's assets — staged into the APP's outdir by `cdk synth` — sit one
    // level above it and CDK's own `../asset.<hash>` escapes. Say so, so the
    // user repoints `--app` instead of hunting a tamper that did not happen.
    // A HEURISTIC, deliberately: it keys on the `assembly-<Stage>` directory
    // name `cdk synth` uses, so it stays silent for a differently-named
    // sub-assembly and would fire for a user outdir that happens to be called
    // `assembly-*`. Both are cheap — the clause is additive and the verdict is
    // unchanged either way. The `..` test is separator-aware for the reason
    // `isInside` gives: a sibling named `..foo` is not an escape upward, and
    // the hint would be noise on it.
    // `/` as well as the platform `sep`: an assembly's own values are always
    // `/`-separated, so on Windows a `sep`-only test never fires and the Stage
    // hint silently disappears from the message that needs it most.
    const climbsOut =
      assetPath === '..' || assetPath.startsWith(`..${sep}`) || assetPath.startsWith('../');
    // Reaching this clause now means the climb in `assetPathDirs` DECLINED:
    // the directory is named like a Stage sub-assembly but its parent carries
    // no `manifest.json`, so it is not one. A real sub-assembly never gets
    // here — the bound is its parent and `../asset.<hash>` resolves inside.
    // So the sentence points at the layout rather than asserting it.
    const stageHint =
      basename(assetOutdir).startsWith('assembly-') && climbsOut
        ? ` This directory is named like a cdk.Stage sub-assembly, but its parent ` +
          `is not an assembly (no manifest.json), so it was treated as the assembly ` +
          `root. If you meant to point --app at a Stage inside an app's output ` +
          `directory, point it at that output directory.`
        : '';
    throw wrapError(
      `Lambda '${sanitizeServiceExceptionMessage(logicalId)}' has ` +
        `Metadata['aws:asset:path']='${sanitizeServiceExceptionMessage(assetPath)}' which ` +
        `${renderAssemblyPathEscape(resolved, assetOutdir, 'mount it')}${stageHint}`
    );
  }
  return resolved.path;
}

/**
 * The two directories an asset path is judged against — THE one spelling both
 * resolvers derive them with, for the same reason
 * {@link resolveAssetCodeDirectory} is one function: two sites disagreeing
 * about the BOUND is a defect no refusal test can see.
 *
 * Asset paths are relative to the manifest's own directory: the stack's
 * `assetManifestPath` is `<cdk.out>/<stack>.assets.json`, so stripping the
 * filename gives the base.
 *
 * `assetOutdir` is the app's outdir and is the CONTAINMENT bound. An ABSENT
 * one falls back to the base, which is correct for a top-level stack and
 * NARROWS for a Stage — it never opens past the base, so a hand-built
 * `StackInfo` carrying neither field is refused rather than admitted.
 * `AssemblyReader` always sets it.
 *
 * The two fallbacks are asymmetric, and the base's prefers `assetOutdir` over
 * `process.cwd()` deliberately: `AssemblyReader` always sets `assetOutdir` but
 * may leave `assetManifestPath` undefined, and taking `process.cwd()` there
 * produces a base DISJOINT from the bound — nothing under the cwd is inside
 * `cdk.out` — so every asset path is refused with a message blaming the
 * assembly. Fail-closed, so never a hole, but a wrong diagnosis.
 * `process.cwd()` survives only for a `StackInfo` carrying NEITHER field,
 * where base and bound coincide again.
 *
 * A PRESENT `assetOutdir` is used AS GIVEN, and the base is never allowed to
 * replace it. The asymmetry is a trust boundary rather than a style choice:
 * `assetOutdir` comes from the user's own `--app` / `--output`, while
 * `manifestDir` is derived from `AssetManifestArtifact.file`, which cx-api
 * resolves out of the assembly's OWN `manifest.json` — so the base is
 * assembly-CONTROLLED and the bound is not. An earlier revision dropped a
 * present bound whenever it was not an ancestor of the base, meaning to
 * improve the diagnosis for a host that supplied a nonsense bound; measured,
 * it let a planted `"file": "../../../../x.assets.json"` push `manifestDir` to
 * `/` and carry the bound with it, so a plain relative `etc/passwd` resolved
 * CONTAINED. A disjoint host-supplied bound refusing everything is a wrong
 * DIAGNOSIS; a widened bound is the vulnerability this module exists to stop.
 *
 * State the property precisely, because the obvious stronger version is FALSE:
 * it is NOT that "the base left the bound, so everything resolved against it is
 * outside" — a candidate can climb back in (`app/cdk.out/asset.9f1` from a base
 * of `/Users/dev`). What holds is that THE BOUND IS ENFORCED INDEPENDENTLY OF
 * THE BASE, so a planted `file` can steer where a relative value resolves FROM
 * and can still only reach inside the user's own outdir — which the assembly
 * already owns. A later reader leaning on the stronger sentence would think a
 * separate base check is redundant.
 *
 * An EMPTY string is treated as ABSENT rather than as a bound, because
 * `path.resolve('')` is the cwd — a directory the host never named. It takes
 * the same fallback as `undefined`.
 *
 * KNOW WHAT THE ABSENT CASE BUYS, which is NOT "a narrower bound": the
 * fallback is `manifestDir`, and that is assembly-derived, so a `StackInfo`
 * carrying no `assetOutdir` gets NO containment rather than a tighter one — a
 * planted `file` moves base and bound together. It is unreachable through
 * `AssemblyReader`, which always sets `assetOutdir` from `cloudAssembly.directory`,
 * and it is what cdkd does; a library host that builds `StackInfo` by hand and
 * wants the guard must supply the field.
 *
 * Exported for `local-start-api.ts`'s copy of the caller, and for unit testing.
 */
export function assetPathDirs(stack: StackInfo): {
  manifestDir: string;
  assetOutdir: string;
} {
  const bound = stack.assetOutdir === '' ? undefined : stack.assetOutdir;
  const manifestDir = stack.assetManifestPath
    ? dirname(stack.assetManifestPath)
    : (bound ?? process.cwd());
  return {
    manifestDir,
    assetOutdir: bound === undefined ? manifestDir : assemblyRootOf(bound),
  };
}

/**
 * The real assembly ROOT for a `--app` that names a `cdk.Stage`
 * SUB-assembly.
 *
 * When a user points `--app` at `cdk.out/assembly-MyStage`, the assembly they
 * are working with is rooted at `cdk.out` — `cdk synth` writes the Stage's
 * manifest into the sub-directory and stages its ASSETS one level above, so
 * CDK's own `../asset.<hash>` is a within-assembly reference. Bounding at the
 * named directory made every one of those look like an escape, and the
 * refusal had to append a paragraph explaining that the layout "is not a
 * tamper" — a guard that has to talk you out of its own verdict is computing
 * the wrong thing.
 *
 * **It is a CONVENIENCE, not a safety property, and an earlier revision of
 * this comment claimed the opposite.** That revision argued the climb is safe
 * because it runs on a USER-supplied value. That is true of the STRING and
 * false of the DECISION: the predicate is a directory NAME and the presence of
 * a FILE, both inside the tree being examined — which under this module's own
 * threat model is the attacker's. An archive unpacking as `manifest.json` +
 * `assembly-X/` into a user's home, run as `--app ~/assembly-X`, moved the
 * bound to `~`, after which `../.aws` resolved CONTAINED and was mounted with
 * no refusal and no warning. It had been refused before the climb existed.
 *
 * So the climb is bounded by two things that are not arguments:
 *
 * 1. **It WARNS every time it fires** (see {@link warnDerivedAssemblyRoot}),
 *    naming the directory the user passed and the one derived from it. The
 *    module's doctrine for an absolute path applies here unchanged — a
 *    directory the user did not name must be visible rather than silent — and
 *    it costs one line on the legitimate Stage path.
 * 2. **The parent must DECLARE this child**, not merely sit above it: its
 *    `manifest.json` must parse and carry a `cdk:cloud-assembly` artifact
 *    whose `properties.directoryName` is this directory's basename, which is
 *    cx-api's own invariant. This removes the accidental collision entirely
 *    (`manifest.json` is not a CDK-exclusive filename) and makes the hostile
 *    case require a purpose-built manifest. It does NOT make the climb safe
 *    against someone who ships the whole tree — they can write that manifest
 *    too. Point 1 is what covers that, which is why it is first.
 *
 * `manifestDir` never climbs: it stays `dirname(assetManifestPath)`, the
 * assembly-derived value, and is still judged against whatever this returns.
 *
 * Returns the caller's own spelling UNCHANGED when no climb happens, because
 * the bound is used as given elsewhere and normalising it would make a
 * relative `--output cdk.out` come back absolute for every ordinary app.
 */
function assemblyRootOf(outdir: string): string {
  let dir = resolve(outdir);
  let climbed = false;
  for (;;) {
    if (!basename(dir).startsWith('assembly-')) break;
    const parent = dirname(dir);
    if (parent === dir || !parentDeclaresNestedAssembly(parent, basename(dir))) break;
    dir = parent;
    climbed = true;
  }
  if (!climbed) return outdir;
  warnDerivedAssemblyRoot(outdir, dir);
  return dir;
}

/**
 * Whether `parent`'s own `manifest.json` declares `child` as a nested
 * assembly, which is what cx-api writes for a `cdk.Stage`.
 *
 * Tolerant by construction: an unreadable or unparseable manifest, or one with
 * no matching artifact, answers `false` and the climb stops — the conservative
 * direction, since not climbing only restores the previous refusal.
 */
function parentDeclaresNestedAssembly(parent: string, child: string): boolean {
  try {
    const raw = readFileSync(join(parent, 'manifest.json'), 'utf-8');
    const artifacts = (JSON.parse(raw) as { artifacts?: Record<string, unknown> }).artifacts;
    if (artifacts === null || typeof artifacts !== 'object') return false;
    return Object.values(artifacts).some((a) => {
      const art = a as { type?: unknown; properties?: { directoryName?: unknown } };
      return art?.type === 'cdk:cloud-assembly' && art.properties?.directoryName === child;
    });
  } catch {
    return false;
  }
}

/** Warned ONCE per derived root per process; the climb runs per resolve. */
const warnedDerivedRoots = new Set<string>();

/** Test seam; one process serves one app. */
export function resetDerivedRootWarnings(): void {
  warnedDerivedRoots.clear();
}

/**
 * Say that the assembly root was DERIVED rather than given.
 *
 * The user named one directory and the containment bound is another, wider
 * one. On the legitimate Stage path that is exactly what they wanted and the
 * line is informative; on a hostile tree it is the only signal that a sibling
 * of the directory they named is now inside the bound.
 */
function warnDerivedAssemblyRoot(named: string, derived: string): void {
  if (warnedDerivedRoots.has(derived)) return;
  warnedDerivedRoots.add(derived);
  getLogger().warn(
    `'${sanitizeServiceExceptionMessage(named)}' is a cdk.Stage sub-assembly, so ` +
      `${getEmbedConfig().productName} is treating its parent ` +
      `'${sanitizeServiceExceptionMessage(derived)}' as the assembly root — that is ` +
      `where cdk synth stages a Stage's assets. Everything under that parent is now ` +
      `inside the containment bound, including siblings of the directory you named. ` +
      `If you did not expect the wider directory, point --app at the app's own output ` +
      `directory instead.`
  );
}

/**
 * Resolve the local directory that corresponds to a function's deployed
 * asset, using the CDK-blessed `Metadata['aws:asset:path']` hint (D2). The
 * value is a directory path relative to `cdk.out` (e.g. `asset.abc123def`)
 * and CDK has already unzipped it for us — we bind-mount the directory
 * directly, no re-zipping.
 *
 * Falls back to a clear error when the metadata is missing OR the resolved
 * directory does not exist (CDK should always emit it for asset-backed
 * Lambdas; absence usually means the user pre-synthesized with a different
 * cdk.out and pointed `--output` at a stale one). Through
 * {@link resolveAssetCodeDirectory} it REFUSES an escaping RELATIVE value and
 * WARNS on an ABSOLUTE one that leaves the asset outdir — see that function
 * for why the two differ.
 */
function resolveAssetCodePath(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource,
  options: { allowZip?: boolean } = {}
): string {
  const meta = resource.Metadata;
  const assetPath = meta?.['aws:asset:path'];
  if (typeof assetPath !== 'string' || assetPath.length === 0) {
    throw new LocalInvokeResolutionError(
      `Lambda '${sanitizeServiceExceptionMessage(logicalId)}' has no ` +
        `Metadata['aws:asset:path']. ` +
        `${getEmbedConfig().cliName} invoke needs this hint to find the local asset directory. ` +
        'Re-synthesize the app (without `--output <stale-dir>`) and retry.'
    );
  }

  const { manifestDir, assetOutdir } = assetPathDirs(stack);
  const abs = resolveAssetCodeDirectory(
    manifestDir,
    assetPath,
    (message) => new LocalInvokeResolutionError(message),
    assetOutdir,
    logicalId
  );
  if (!existsSync(abs)) {
    throw new LocalInvokeResolutionError(
      `Lambda '${sanitizeServiceExceptionMessage(logicalId)}' asset path ` +
        `'${sanitizeServiceExceptionMessage(abs)}' does not exist. ` +
        'Re-synthesize the app and retry.'
    );
  }
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    return abs;
  }
  // A ZIP-packaged asset (`Code.fromAsset('bundle.zip')` or a bundling step
  // that emits a zip): CDK stages it as `asset.<hash>.zip` and points
  // `aws:asset:path` at the zip FILE, not an unzipped directory. The function-
  // code path opts in via `allowZip` and extracts it on demand
  // (`materializeAssetCodeDir`). Layers still require an unzipped directory.
  if (options.allowZip && stat.isFile() && abs.toLowerCase().endsWith('.zip')) {
    return abs;
  }
  throw new LocalInvokeResolutionError(
    `Lambda '${sanitizeServiceExceptionMessage(logicalId)}' asset path ` +
      `'${sanitizeServiceExceptionMessage(abs)}' is not a directory` +
      (options.allowZip ? ' or a .zip archive' : '') +
      '. Re-synthesize the app and retry.'
  );
}

/**
 * Result of {@link materializeAssetCodeDir}: a directory ready to bind-mount
 * as the Lambda code root, plus an optional `tmpDir` the caller MUST clean up
 * when the directory was freshly extracted from a `.zip` asset.
 */
export interface MaterializedAssetCode {
  /** Directory to bind-mount as the Lambda code root. */
  dir: string;
  /**
   * Set only when `dir` is a freshly-created temp directory holding the
   * extracted contents of a `.zip` asset — the caller is responsible for
   * removing it (via its existing tmpdir cleanup) once the container is gone.
   * Undefined when `dir` is the original (already-unzipped) asset directory,
   * which must NOT be removed.
   */
  tmpDir?: string;
}

/**
 * Turn a resolved function-code asset path into a directory ready to
 * bind-mount into the Lambda container.
 *
 * Most CDK Lambda assets are already-unzipped directories (`asset.<hash>/`)
 * that bind-mount directly — those pass through untouched. But a
 * ZIP-packaged asset (`Code.fromAsset('bundle.zip')`, or a bundling that
 * emits a zip) is staged as `asset.<hash>.zip` and `aws:asset:path` points at
 * the zip FILE. Docker cannot bind-mount a zip file as a directory, so we
 * extract it to a fresh temp dir on demand and return that for the mount.
 *
 * Used by `cdkl invoke`, `cdkl start-api`, and the front-door Lambda runner —
 * the three places that bind-mount a ZIP Lambda's code — so all agree on the
 * zip handling. The returned `tmpDir` (when set) is threaded into the caller's
 * existing tmpdir cleanup.
 */
export function materializeAssetCodeDir(codePath: string): MaterializedAssetCode {
  // `codePath` usually comes from `resolveAssetCodePath(..., { allowZip: true })`,
  // which already verified the path exists and is either a directory or a
  // `.zip` file. Re-check existence here so callers whose own asset-path
  // resolver does NOT validate (e.g. start-api's local `resolveAssetCodePath`)
  // still get an actionable error instead of a raw `ENOENT` from `statSync`.
  if (!existsSync(codePath)) {
    throw new LocalInvokeResolutionError(
      `Lambda asset path '${sanitizeServiceExceptionMessage(codePath)}' does not exist. ` +
        'Re-synthesize the app and retry.'
    );
  }
  if (statSync(codePath).isDirectory()) {
    return { dir: codePath };
  }
  const zipBytes = readFileSync(codePath);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipBytes);
  } catch (err) {
    throw new LocalInvokeResolutionError(
      `Lambda asset '${sanitizeServiceExceptionMessage(codePath)}' is a file but could not ` +
        `be read as a ZIP archive: ` +
        `${err instanceof Error ? err.message : String(err)}. Re-synthesize the app and retry.`
    );
  }
  // fflate's `unzipSync` returns only file CONTENTS — no per-entry unix mode,
  // and a SYMLINK entry comes back as a regular entry whose content is the link
  // TARGET path. A `provided.*` runtime commonly ships `bootstrap` as a symlink
  // to the real binary (e.g. Swift's `bootstrap -> MyHandler`), so writing that
  // content as a regular file yields an 18-byte text file that RIE fork/exec's
  // -> `exec format error` / `Runtime.InvalidEntrypoint`. So we parse the zip's
  // central directory ourselves for each entry's stored unix mode and recreate
  // symlinks as symlinks + restore the executable bit. (A directory asset
  // bypasses this path entirely — CDK staged it with correct modes and we
  // bind-mount it directly.)
  const modes = parseZipUnixModes(zipBytes);
  const S_IFMT = 0o170000;
  const S_IFLNK = 0o120000;
  const dir = mkdtempSync(join(tmpdir(), `${getEmbedConfig().resourceNamePrefix}-lambda-zip-`));
  // Two passes: write every REGULAR file first, then create symlinks. Creating
  // symlinks last means no regular-file `writeFileSync` can follow an
  // already-created symlink out of the extraction dir (a symlink-then-write
  // escape), on top of the lexical zip-slip guard on every `dest`.
  const symlinks: Array<{ dest: string; target: string }> = [];
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('/')) continue; // directory entry — no file content
    const dest = resolveSafeZipEntryPath(dir, name);
    mkdirSync(dirname(dest), { recursive: true });
    const mode = modes.get(name) ?? 0;
    if ((mode & S_IFMT) === S_IFLNK) {
      // Symlink entry: the content IS the link target path. Defer creation to
      // the second pass.
      symlinks.push({ dest, target: new TextDecoder().decode(content) });
      continue;
    }
    writeFileSync(dest, content);
    // Preserve the stored unix permission bits when present; otherwise grant
    // 0o755 so a `provided.*` `bootstrap` stays executable (some zips store a
    // bare 0 mode). Keeping files readable is safe: the user's own code in an
    // ephemeral local container.
    const perm = mode & 0o777;
    chmodSync(dest, perm || 0o755);
  }
  // A `provided.*` runtime commonly ships `bootstrap` as a symlink to the real
  // binary (Swift: `bootstrap -> MyHandler`); recreate it as a real symlink so
  // the bind-mounted asset resolves the same as the deployed package — the
  // target is the user's own (relative) path, resolved inside the container.
  for (const { dest, target } of symlinks) {
    symlinkSync(target, dest);
  }
  return { dir, tmpDir: dir };
}

/**
 * Parse a ZIP archive's central directory into a map of entry name -> stored
 * unix mode (the high 16 bits of the central-directory external file
 * attributes). fflate's `unzipSync` discards this, but we need it to tell a
 * symlink entry from a regular file and to restore the executable bit. Returns
 * an empty map (callers fall back to a default mode) for a non-standard /
 * unparseable archive — best-effort, never throws.
 */
function parseZipUnixModes(bytes: Uint8Array): Map<string, number> {
  const modes = new Map<string, number>();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD_SIG = 0x06054b50; // End Of Central Directory record
  const CDH_SIG = 0x02014b50; // Central Directory file Header
  // The EOCD is at the end, after an optional <=65535-byte comment; scan back.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return modes;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // offset of central directory start
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== CDH_SIG) break;
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const externalAttrs = dv.getUint32(p + 38, true);
    const unixMode = externalAttrs >>> 16; // high 16 bits = unix st_mode
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (unixMode !== 0) modes.set(name, unixMode);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return modes;
}

/**
 * Guard against zip-slip: reject an entry whose normalized path escapes the
 * extraction root (e.g. `../../etc/passwd`).
 */
function resolveSafeZipEntryPath(root: string, entry: string): string {
  const dest = normalize(join(root, entry));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (dest !== root && !dest.startsWith(rootWithSep)) {
    throw new LocalInvokeResolutionError(
      `Refusing to extract a Lambda ZIP asset entry that escapes the target dir: '${entry}'.`
    );
  }
  return dest;
}

/**
 * Resolve a Lambda's `Properties.Layers` references to local asset
 * directories (PR 6 of #224, issue #232).
 *
 * Each entry in the synthesized template is an intrinsic pointing at an
 * `AWS::Lambda::LayerVersion` resource in the same stack — most commonly
 * `{Ref: '<LayerLogicalId>'}` (which CDK uses for `LayerVersion.layerArn`)
 * or `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}`. Once we have the
 * layer's logical ID we look up its `aws:asset:path` Metadata the same
 * way function code is located (the layer asset is unzipped under
 * `cdk.out/asset.<hash>/` ready to bind-mount).
 *
 * **Order is preserved**: `Properties.Layers` is iterated left-to-right
 * and the resulting `ResolvedLambdaLayer[]` carries the same order. The
 * caller (`local-invoke.ts`'s `materializeLambdaLayers` and
 * `local-start-api.ts`'s server-boot pre-merge) merges every
 * entry into one host tmpdir in template order to honor AWS's
 * "last-layer-wins" file-collision semantics — Docker rejects multiple
 * bind mounts at the same target so cdk-local cannot rely on overlay
 * layering.
 *
 * **Same-stack handling** (`{Ref: <Id>}` / `{Fn::GetAtt: [<Id>, 'Ref']}`):
 *
 *   - Refs that don't point at an `AWS::Lambda::LayerVersion` resource
 *     hard-error — almost always a typo'd logical ID.
 *   - Refs to a `LayerVersion` whose `Metadata['aws:asset:path']` is
 *     missing hard-error — the layer's content is `S3Bucket` / `S3Key`
 *     from outside cdk.out and there's no local directory to bind-mount.
 *
 * **Literal-ARN handling** (issue #448): entries shaped like the string
 * `arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>` are parsed
 * into a `{kind: 'arn', ...}` resolved layer. The actual
 * `lambda:GetLayerVersion` + presigned-URL download + unzip happens
 * later in the CLI (`materializeLayerFromArn(...)`), which can optionally
 * `sts:AssumeRole` into the layer's account when the dev's default
 * credentials cannot read it. Covers AWS-published public layers (Lambda
 * Powertools, Datadog Extension, etc.) and cross-account / cross-region
 * shared layers.
 */
export function resolveLambdaLayers(
  stack: StackInfo,
  logicalId: string,
  props: Record<string, unknown>
): ResolvedLambdaLayer[] {
  const layers = props['Layers'];
  if (layers === undefined) return [];
  if (!Array.isArray(layers)) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has a non-array Layers property. Expected an array of LayerVersion references.`
    );
  }
  if (layers.length === 0) return [];

  const resources = stack.template.Resources ?? {};
  const out: ResolvedLambdaLayer[] = [];
  for (let i = 0; i < layers.length; i++) {
    const entry: unknown = layers[i];

    // Literal-ARN entry (issue #448) — recognized before the
    // logical-ID lookup so users who reference AWS-published layers
    // (Lambda Powertools etc.) or cross-account / cross-region shared
    // layers bypass the same-stack resource scan.
    if (typeof entry === 'string') {
      const parsed = parseLayerVersionArn(entry);
      if (!parsed) {
        throw new LocalInvokeResolutionError(
          `Lambda '${logicalId}' has a Layers entry [${i}] ${getEmbedConfig().productName} cannot resolve locally: literal string '${entry}'. ` +
            'Expected a same-stack Ref / Fn::GetAtt to an AWS::Lambda::LayerVersion ' +
            'OR a literal layer-version ARN of the form ' +
            'arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>, ' +
            'whose partition agrees with its region.'
        );
      }
      out.push({ kind: 'arn', logicalId: parsed.arn, ...parsed });
      continue;
    }

    const layerLogicalId = pickLayerLogicalId(entry);
    if (!layerLogicalId) {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' has a Layers entry [${i}] ${getEmbedConfig().productName} cannot resolve locally: ${describeLayerEntry(entry)}. ` +
          'Expected a same-stack Ref / Fn::GetAtt to an AWS::Lambda::LayerVersion ' +
          'OR a literal layer-version ARN of the form ' +
          'arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>, ' +
          'whose partition agrees with its region.'
      );
    }

    const layerResource = resources[layerLogicalId];
    if (!layerResource) {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' Layers entry [${i}] references '${layerLogicalId}', ` +
          `but no resource with that logical ID exists in stack '${stack.stackName}'.`
      );
    }
    if (layerResource.Type !== 'AWS::Lambda::LayerVersion') {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' Layers entry [${i}] references '${layerLogicalId}' (${layerResource.Type}), ` +
          'which is not an AWS::Lambda::LayerVersion.'
      );
    }

    const assetPath = resolveAssetCodePath(stack, layerLogicalId, layerResource);
    out.push({ kind: 'asset', logicalId: layerLogicalId, assetPath });
  }
  return out;
}

/**
 * Parse a Lambda layer-version ARN string into its segments.
 *
 * Returns `undefined` for anything that does not match the strict
 * `arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>` shape so
 * the caller can produce a clearer error than a silent
 * misinterpretation of hand-edited templates.
 *
 * The partition segment is **derived from the region** rather than
 * enumerated (issue #575). An alternation has to be re-edited every time
 * AWS adds a partition — it listed three of the eight, so a layer ARN in
 * `aws-iso` / `aws-iso-b` / `aws-iso-e` / `aws-iso-f` / `aws-eusc` did
 * not parse and `resolveLambdaLayers` hard-threw — and it can never
 * reject a self-inconsistent pair such as
 * `arn:aws-cn:lambda:us-east-1:...`, which the derived compare does.
 *
 * Exported for unit testing.
 */
export function parseLayerVersionArn(
  input: string
): { arn: string; region: string; accountId: string; name: string; version: string } | undefined {
  // The region segment stays SHAPE-based (`<word>(-<word>)+-<digits>`,
  // wide enough for the European Sovereign Cloud's four-letter
  // `eusc-de-east-1` and for regions with more interior chunks than
  // today's) rather than a loose charset, because
  // `derivePartitionAndUrlSuffix` answers `aws` for any region it does
  // not recognize — the commercial fallback that lets a brand-new region
  // resolve before its table hears about it. With a charset,
  // `arn:aws:lambda:garbage:...` would parse.
  const m =
    /^arn:(aws(?:-[a-z]+)*):lambda:([a-z]{2,}(?:-[a-z]+)+-\d+):(\d{12}):layer:([A-Za-z0-9_-]+):(\d+)$/.exec(
      input
    );
  if (!m) return undefined;
  const partition = m[1]!;
  const region = m[2]!;
  if (derivePartitionAndUrlSuffix(region).partition !== partition) return undefined;
  return {
    arn: input,
    region,
    accountId: m[3]!,
    name: m[4]!,
    version: m[5]!,
  };
}

/**
 * Walk a single Layers-array entry and return the referenced layer's
 * logical ID — or `undefined` for shapes we don't try to resolve in v1.
 *
 * Accepted shapes (what CDK actually synthesizes — JSON-only):
 *   - `{Ref: '<LayerLogicalId>'}`
 *   - `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}` (rare; LayerVersion's
 *     Ref form is usually emitted as a flat `Ref`)
 *
 * Intentionally **rejected**: the YAML-only string form
 * `{Fn::GetAtt: '<LogicalId>.<attr>'}`. CloudFormation YAML accepts the
 * dot-shorthand and converts it to the array form on the wire, but
 * CloudFormation JSON (the output of `cdk synth`, which is the only
 * thing cdk-local ingests) never emits the string form. Treating it as
 * resolvable here would silently accept hand-edited / malformed templates
 * that no real CDK flow can produce; instead we fall through to the
 * standard "cdk-local cannot resolve this Layers entry locally" error so the
 * user sees the offending shape called out.
 */
function pickLayerLogicalId(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const obj = entry as Record<string, unknown>;
  if (typeof obj['Ref'] === 'string') return obj['Ref'];
  if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') return arg[0];
    // Deliberately not: `if (typeof arg === 'string') return arg.split('.')[0]`.
    // See docstring above — the string form is YAML-only and CFn JSON
    // never emits it.
  }
  return undefined;
}

/**
 * Stringify a Layers-array entry for use in error messages. Truncates
 * literal ARNs to a short form so the message stays one-line.
 */
function describeLayerEntry(entry: unknown): string {
  if (typeof entry === 'string') return `literal ARN '${entry}'`;
  if (entry === null) return 'null';
  if (typeof entry !== 'object') return stringifyValue(entry);
  try {
    const json = JSON.stringify(entry);
    return json.length > 120 ? json.substring(0, 117) + '...' : json;
  } catch {
    return Object.prototype.toString.call(entry);
  }
}

/**
 * Build a "target not found" error that lists every Lambda function in
 * the resolved stack so the user can copy/paste a valid target. Mirrors
 * the format the issue spec calls out.
 */
function notFoundError(
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): LocalInvokeResolutionError {
  const lambdas: { displayPath: string; logicalId: string }[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const meta = resource.Metadata;
    const cdkPath = typeof meta?.['aws:cdk:path'] === 'string' ? meta['aws:cdk:path'] : '';
    lambdas.push({ displayPath: cdkPath || logicalId, logicalId });
  }

  let msg = `target '${target}' did not match any Lambda function in ${stack.stackName}.\n\n`;
  if (lambdas.length === 0) {
    msg += `Stack ${stack.stackName} has no Lambda functions.`;
  } else {
    const width = Math.max(...lambdas.map((l) => l.displayPath.length));
    msg += `Available Lambda functions in ${stack.stackName}:\n`;
    for (const l of lambdas) {
      msg += `  ${l.displayPath.padEnd(width)}  (${l.logicalId})\n`;
    }
  }
  return new LocalInvokeResolutionError(msg.trimEnd());
}
