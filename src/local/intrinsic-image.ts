import type { ResourceState } from '../types/state.js';
import type { TemplateResource } from '../types/resource.js';

/**
 * Shared resolver for CFn intrinsic-function shapes that show up in
 * container-image URI fields — both ECS `ContainerDefinition.Image`
 * (`cdkl run-task`) and Lambda `Code.ImageUri` (`cdk-local
 * invoke` container Lambdas). CDK 2.x synthesizes the same canonical
 * `Fn::Join` shape for `ContainerImage.fromEcrRepository(repo, tag)` and
 * `lambda.DockerImageCode.fromEcr(repo, { tagOrDigest })` — so both call
 * sites share the resolver.
 *
 * Originally introduced as a private helper inside `ecs-task-resolver.ts`
 * (PR #280 / issue #271) and extracted here when `lambda-resolver.ts`
 * needed the same shape (issue #286 Gap 2). The extraction keeps the two
 * call sites bit-identical so a future change in the canonical CDK shape
 * gets fixed once.
 *
 * Scope is intentionally narrow: the resolver only handles the subset of
 * intrinsics needed to reconstruct an ECR image URI. `Fn::If` /
 * `Fn::FindInMap` / etc. are out of scope — this is a minimal resolver
 * for image URIs, not a general-purpose deploy-time resolver.
 */

/**
 * Substitution context for `tryResolveImageFnJoin` and `substituteImagePlaceholders`.
 *
 * Both blocks are optional: `pseudoParameters` covers Tier 1 (no state
 * needed — works against the developer's shell creds / region for
 * `${AWS::Region}` / `${AWS::AccountId}` / `${AWS::URLSuffix}` /
 * `${AWS::Partition}`); `stateResources` covers Tier 2 (`--from-state`
 * — substitutes same-stack ECR `Ref` / `Fn::GetAtt: [<Repo>, 'Arn']`
 * against the host state-recorded `physicalId` / `attributes`).
 *
 * The CLI command resolves both blocks lazily — STS is only invoked when
 * at least one image references the pseudo parameters — and passes the
 * resolved shape here. The resolver itself stays pure and synchronous.
 */
export interface ImageResolutionContext {
  /**
   * Resolved AWS pseudo parameters. When undefined for a given key, the
   * substitution is treated as missing and the value passes through
   * verbatim. Caller is expected to populate every key when it populates
   * any (we derive partition / URL suffix from region in the CLI layer).
   */
  pseudoParameters?: {
    accountId?: string;
    region?: string;
    partition?: string;
    urlSuffix?: string;
  };
  /**
   * `state.resources` from the host's S3 state record for the target stack,
   * loaded by the CLI command before resolution when `--from-state` is
   * passed. Used to substitute `${<LogicalId>}` against an
   * `AWS::ECR::Repository` and the `Fn::GetAtt` `Arn` / `RepositoryUri`
   * shapes. Undefined when `--from-state` is not in effect.
   */
  stateResources?: Record<string, ResourceState>;
  /**
   * Resolved SSM-backed template `Parameters`
   * (`AWS::SSM::Parameter::Value<String>`), keyed by parameter logical ID.
   * Fed into `state-resolver.ts`'s `SubstitutionContext.parameters` so a
   * `Ref` to such a parameter in a container `Environment` / `Secrets`
   * entry resolves to its SSM value instead of being warn-and-dropped
   * (issue #94). The CLI resolves these out-of-band via SSM Parameter
   * Store under `--from-cfn-stack`. Undefined when the stack declares no
   * SSM-backed parameters / no state source is in effect.
   */
  stateParameters?: Record<string, string>;
  /**
   * Logical IDs of {@link stateParameters} entries whose SSM `Type` is
   * `SecureString` (decrypted). Threaded into
   * `SubstitutionContext.sensitiveParameters` so the consuming container
   * env keys are routed off the `docker run` argv (issue #99). Undefined
   * when no SecureString parameter was resolved.
   */
  stateSensitiveParameters?: readonly string[];
  /**
   * Single-line detail captured by a state-source provider whose `load()`
   * was attempted but failed (e.g. `ListStackResources(<wrong-name>)`
   * returned a ValidationError for a stack name that does not exist).
   * Used by the resolver layer to flip the "pass --from-cfn-stack"
   * remedy hint into "the state load was attempted but failed: ...;
   * verify the stack name + --region / --profile" so the user is not
   * told to re-supply a flag they already passed. Undefined when no
   * load was attempted, or when the load succeeded.
   */
  stateLoadFailureMessage?: string;
}

/**
 * Render the resolver-error remedy string for a "needs deployed state"
 * failure. When the context records that a state-source provider's
 * `load()` was attempted but failed ({@link ImageResolutionContext.stateLoadFailureMessage}),
 * the hint surfaces the underlying failure and points at the
 * stack-name / region / profile knobs instead of repeating "pass
 * --from-cfn-stack" — the user already passed it and seeing the same
 * flag suggested back is misleading. Otherwise the original hint is
 * emitted verbatim.
 *
 * Returned as a clause without a trailing punctuation so callers can
 * concatenate it with their alternatives (e.g. "..., build via
 * ContainerImage.fromAsset, or pin a public image.").
 */
export function formatStateRemedy(context: ImageResolutionContext | undefined): string {
  if (context?.stateLoadFailureMessage) {
    return (
      `the state-source attempt failed: ${context.stateLoadFailureMessage}; ` +
      'verify the stack name (try --from-cfn-stack <deployed-name> if it differs ' +
      'from the synthesized name) and that --region / --profile target the right account'
    );
  }
  return 'pass --from-cfn-stack to load the deployed stack state';
}

/**
 * Region-prefix -> partition / URL-suffix table, most-specific prefix
 * first. Covers all seven non-commercial partitions; the COMMERCIAL
 * partition is deliberately NOT a row but the fallback in
 * `derivePartitionAndUrlSuffix` below, so a brand-new commercial region
 * resolves correctly before this table hears about it.
 *
 * Exported so a test can iterate the REAL rows: a test that re-types
 * the prefixes locally cannot see a future row, which is the only thing
 * the ordering claim above needs fencing against.
 *
 * Issue #575: the table used to carry four of the eight partitions, so
 * an `eusc-` / `eu-isoe-` / `us-isof-` region fell through to the
 * commercial row and produced `amazonaws.com` — a host that does not
 * exist in those partitions.
 *
 * This module is the ONE home for the table. It lived in
 * `ecs-task-resolver.ts` until a SECOND, independently-drifting copy
 * was found here behind `derivePseudoParametersFromRegion`
 * (go-to-k/cdkd#1821 measured the divergence). `intrinsic-image.ts` is a
 * leaf — every import it has is an `import type`, erased at compile
 * time — and `ecs-task-resolver.ts` already imports from it, so this is
 * the only direction that does not create an import cycle. That module
 * re-exports both symbols so its own importers stay unchanged.
 */
export const PARTITION_TABLE: ReadonlyArray<{
  regionPrefix: string;
  partition: string;
  urlSuffix: string;
}> = [
  { regionPrefix: 'cn-', partition: 'aws-cn', urlSuffix: 'amazonaws.com.cn' },
  { regionPrefix: 'us-gov-', partition: 'aws-us-gov', urlSuffix: 'amazonaws.com' },
  { regionPrefix: 'us-isob-', partition: 'aws-iso-b', urlSuffix: 'sc2s.sgov.gov' },
  { regionPrefix: 'us-isof-', partition: 'aws-iso-f', urlSuffix: 'csp.hci.ic.gov' },
  { regionPrefix: 'us-iso-', partition: 'aws-iso', urlSuffix: 'c2s.ic.gov' },
  { regionPrefix: 'eu-isoe-', partition: 'aws-iso-e', urlSuffix: 'cloud.adc-e.uk' },
  { regionPrefix: 'eusc-', partition: 'aws-eusc', urlSuffix: 'amazonaws.eu' },
];

/**
 * Derive the AWS partition / URL suffix for an AWS region. Same mapping
 * CloudFormation applies to `${AWS::Partition}` / `${AWS::URLSuffix}`.
 * Exported so the CLI can keep the STS hop minimal — caller passes the
 * region in once, this returns the matching partition + suffix.
 *
 * The region is lower-cased before matching: `--region CN-NORTH-1` is a
 * region the AWS CLI accepts, and an unnormalized compare used to send
 * it to the commercial fallback (issue #575).
 */
export function derivePartitionAndUrlSuffix(region: string): {
  partition: string;
  urlSuffix: string;
} {
  const normalized = region.toLowerCase();
  for (const row of PARTITION_TABLE) {
    if (normalized.startsWith(row.regionPrefix)) {
      return { partition: row.partition, urlSuffix: row.urlSuffix };
    }
  }
  return { partition: 'aws', urlSuffix: 'amazonaws.com' };
}

/**
 * Derive the AWS pseudo parameters that are trivially knowable from the
 * deploy region alone, without any STS call or state load.
 *
 * `partition` / `urlSuffix` come from `derivePartitionAndUrlSuffix`
 * above — the single partition authority in this package. This function
 * used to carry its OWN if/else chain, which knew four of the eight
 * partitions and compared case-sensitively, so a `us-isof-` / `eu-isoe-`
 * / `eusc-` region (and any upper-cased region) resolved to the
 * commercial partition: `${AWS::Partition}` substituted `aws` into every
 * ARN built here, and the `Fn::Join` ECR `Code.ImageUri` reconstruction
 * produced `<acct>.dkr.ecr.<region>.amazonaws.com`, a host that does not
 * exist in those partitions. Quiet, because the value is structurally
 * valid and nothing downstream rejects it (issue #575,
 * go-to-k/cdkd#1821).
 *
 * `region` is returned VERBATIM, deliberately: the delegation lower-cases
 * only for MATCHING. Lower-casing the RETURNED value would change what
 * `${AWS::Region}` substitutes into templates, which is a separate
 * behaviour change tracked in go-to-k/cdkd#1831.
 *
 * `accountId` is optional pass-through (caller decides whether to populate
 * it). The bootstrap-ECR URI shape that `lambda.DockerImageCode.fromImageAsset`
 * synthesizes carries account-id + region as literal strings in the template,
 * so only `urlSuffix` / `partition` / `region` are required to resolve it
 * (issue #637).
 *
 * Returns `undefined` when `region` is undefined / empty so the caller can
 * fall through cleanly. The shape mirrors `ImageResolutionContext.pseudoParameters`
 * so the result drops straight into a context literal.
 */
export function derivePseudoParametersFromRegion(
  region: string | undefined,
  accountId?: string
): { accountId?: string; region: string; partition: string; urlSuffix: string } | undefined {
  if (!region || typeof region !== 'string' || region.length === 0) return undefined;
  const { partition, urlSuffix } = derivePartitionAndUrlSuffix(region);
  return {
    ...(accountId !== undefined && { accountId }),
    // Verbatim, NOT the lower-cased form the match used — see above.
    region,
    partition,
    urlSuffix,
  };
}

/**
 * Outcome of attempting to resolve a `Fn::Join`-shaped image URI against
 * the substitution context. Discriminated so the caller can route each
 * case to the right error / classification path.
 */
export type FnJoinResolveOutcome =
  | { kind: 'not-applicable' }
  | { kind: 'resolved'; uri: string }
  | { kind: 'needs-state'; repoLogicalId: string }
  | { kind: 'unsupported-join'; reason: string };

/**
 * Resolve the canonical CDK 2.x `Fn::Join` shape emitted by
 * `ContainerImage.fromEcrRepository(repo, tag)` (ECS) and
 * `lambda.DockerImageCode.fromEcr(repo, { tagOrDigest })` (Lambda
 * container).
 *
 * The shape is a `Fn::Join` with delimiter `""` whose elements include
 * nested `Fn::Select` / `Fn::Split` over an `Fn::GetAtt: [<Repo>, 'Arn']`
 * plus a `Ref` to the same `AWS::ECR::Repository` and a
 * `Ref: AWS::URLSuffix`. For SAME-STACK references the account-id +
 * region only exist in the host's S3 state (recorded at deploy time on the
 * Repository's `Arn` attribute), so the resolver inherently requires
 * `--from-state` (Tier 2) for that variant. For IMPORTED repositories
 * the URI components are flat strings + `Ref: AWS::URLSuffix` and
 * resolve cleanly without state (Tier 1).
 *
 * Returns `not-applicable` when `raw` isn't an `Fn::Join` (the caller
 * falls through to its existing `Fn::Sub` / flat-string handling).
 * Returns `needs-state` when the `Fn::Join` references a same-stack ECR
 * Repository but no state was supplied (the caller surfaces a
 * `--from-state` hint). Returns `unsupported-join` when the join shape
 * doesn't fit the canonical CDK 2.x pattern (e.g. delimiter != "",
 * non-recognized nested intrinsic) so the caller can route to a precise
 * error.
 */
export function tryResolveImageFnJoin(
  raw: unknown,
  resources: Record<string, TemplateResource>,
  context: ImageResolutionContext | undefined
): FnJoinResolveOutcome {
  if (!raw || typeof raw !== 'object') return { kind: 'not-applicable' };
  const obj = raw as Record<string, unknown>;
  const arg = obj['Fn::Join'];
  if (arg === undefined) return { kind: 'not-applicable' };

  if (!Array.isArray(arg) || arg.length !== 2 || !Array.isArray(arg[1])) {
    return { kind: 'unsupported-join', reason: 'Fn::Join must be [delimiter, [elements]]' };
  }
  const [delimiter, elements] = arg as [unknown, unknown[]];
  if (typeof delimiter !== 'string') {
    return {
      kind: 'unsupported-join',
      reason: `Fn::Join delimiter must be a string, got ${typeof delimiter}`,
    };
  }

  // Find a same-stack ECR::Repository referenced by either a `Ref` or
  // `Fn::GetAtt` somewhere in the element tree. The presence of such a
  // reference is the load-bearing signal that this Fn::Join is an ECR
  // image URI (rather than an unrelated Join that happens to be the
  // Image field).
  const repoLogicalId = findEcrRepositoryRefInTree(elements, resources);

  const stateResources = context?.stateResources;
  if (repoLogicalId && !stateResources) {
    return { kind: 'needs-state', repoLogicalId };
  }

  // Walk every element through the generic intrinsic resolver. Any
  // unresolvable element aborts with `unsupported-join`.
  const parts: string[] = [];
  for (const element of elements) {
    const r = resolveImageIntrinsic(element, resources, context);
    if (r === undefined) {
      // No ECR Repository reference AND we could not produce a string —
      // this isn't a canonical CDK 2.x ECR Fn::Join. Surface
      // `not-applicable` so the caller falls back to its existing
      // flat-string / Fn::Sub path.
      if (!repoLogicalId) return { kind: 'not-applicable' };
      return {
        kind: 'unsupported-join',
        reason: 'one or more Fn::Join elements could not be resolved',
      };
    }
    parts.push(r);
  }

  return { kind: 'resolved', uri: parts.join(delimiter) };
}

/**
 * Walk a tree of intrinsic nodes and return the logical ID of the first
 * `AWS::ECR::Repository` referenced via `Ref` or `Fn::GetAtt`. Used to
 * detect whether a `Fn::Join` image shape is an ECR image URI (and so
 * needs Tier 2 / `--from-state` resolution).
 */
function findEcrRepositoryRefInTree(
  node: unknown,
  resources: Record<string, TemplateResource>
): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findEcrRepositoryRefInTree(item, resources);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;

  if (typeof obj['Ref'] === 'string') {
    const target = obj['Ref'];
    if (resources[target]?.Type === 'AWS::ECR::Repository') return target;
    return undefined;
  }

  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    let lid: string | undefined;
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') lid = getAtt[0];
    else if (typeof getAtt === 'string') lid = getAtt.split('.')[0];
    if (lid && resources[lid]?.Type === 'AWS::ECR::Repository') return lid;
    return undefined;
  }

  for (const value of Object.values(obj)) {
    const hit = findEcrRepositoryRefInTree(value, resources);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Generic recursive resolver for the intrinsic-function subset needed to
 * construct an ECR image URI from a `Fn::Join` tree. Handles:
 *
 *   - literal strings / numbers / booleans (returned as their string form)
 *   - `Ref: AWS::URLSuffix` / `AWS::Partition` / `AWS::Region` /
 *     `AWS::AccountId` against `context.pseudoParameters`
 *   - `Ref: <ECRRepoLogicalId>` against `context.stateResources` →
 *     `physicalId`
 *   - `Fn::GetAtt: [<ECRRepoLogicalId>, 'Arn'|'RepositoryUri']` against
 *     `context.stateResources.attributes`
 *   - `Fn::Split: [delimiter, str]` (where `str` resolves to a string)
 *   - `Fn::Select: [index, list]` (where `list` resolves to an array)
 *   - `Fn::Join: [delimiter, [elements]]` (recursive — each element
 *     resolved via this function)
 *   - `Fn::Sub: <template>` (string-replace via `substituteImagePlaceholders`)
 *
 * Returns `undefined` when any sub-resolution fails so the caller can
 * route the outer Fn::Join to `unsupported-join`. Deliberately tight
 * scope — `Fn::If` / `Fn::FindInMap` / etc. are out of scope here.
 */
function resolveImageIntrinsic(
  node: unknown,
  resources: Record<string, TemplateResource>,
  context: ImageResolutionContext | undefined
): string | undefined {
  const v = resolveImageIntrinsicAny(node, resources, context);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * Same resolver as `resolveImageIntrinsic` but returns the raw resolved
 * value (string / number / boolean / array of strings). Used by
 * `Fn::Select` over a `Fn::Split` (which produces a string[]).
 */
function resolveImageIntrinsicAny(
  node: unknown,
  resources: Record<string, TemplateResource>,
  context: ImageResolutionContext | undefined
): string | number | boolean | string[] | undefined {
  if (node === null || node === undefined) return undefined;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return node;
  }
  if (Array.isArray(node)) {
    // A bare array isn't a valid intrinsic at this layer.
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return undefined;
  const intrinsic = keys[0]!;
  const arg = obj[intrinsic];

  if (intrinsic === 'Ref') {
    if (typeof arg !== 'string') return undefined;
    if (arg.startsWith('AWS::')) {
      const p = context?.pseudoParameters;
      if (!p) return undefined;
      if (arg === 'AWS::URLSuffix') return p.urlSuffix;
      if (arg === 'AWS::Partition') return p.partition;
      if (arg === 'AWS::Region') return p.region;
      if (arg === 'AWS::AccountId') return p.accountId;
      return undefined;
    }
    const refResource = resources[arg];
    if (refResource?.Type !== 'AWS::ECR::Repository') return undefined;
    const stateEntry = context?.stateResources?.[arg];
    if (!stateEntry) return undefined;
    return stateEntry.physicalId;
  }

  if (intrinsic === 'Fn::GetAtt') {
    let logicalId: string | undefined;
    let attr: string | undefined;
    if (
      Array.isArray(arg) &&
      arg.length === 2 &&
      typeof arg[0] === 'string' &&
      typeof arg[1] === 'string'
    ) {
      logicalId = arg[0];
      attr = arg[1];
    } else if (typeof arg === 'string') {
      const dot = arg.indexOf('.');
      if (dot > 0 && dot < arg.length - 1) {
        logicalId = arg.slice(0, dot);
        attr = arg.slice(dot + 1);
      }
    }
    if (!logicalId || !attr) return undefined;
    if (resources[logicalId]?.Type !== 'AWS::ECR::Repository') return undefined;
    const cached = context?.stateResources?.[logicalId]?.attributes?.[attr];
    if (typeof cached === 'string' && cached.length > 0) return cached;
    // No recorded attribute. `--from-cfn-stack` resolves state from
    // `ListStackResources`, which returns physical IDs only (never the
    // `Arn` / `RepositoryUri` attributes), so the canonical
    // `ContainerImage.fromEcrRepository` join — which extracts the
    // account + region by `Fn::Select`-ing over `Fn::Split(":", <Arn>)` —
    // would otherwise fail here. A same-stack ECR repository's Arn /
    // RepositoryUri are deterministic, so synthesize them from the repo's
    // physical name (the `ListStackResources` physical ID) plus the
    // already-resolved account / region / partition / URL suffix (the
    // stack's own, which is where a same-stack repo lives).
    const physicalId = context?.stateResources?.[logicalId]?.physicalId;
    const p = context?.pseudoParameters;
    if (physicalId && p?.region && p.accountId) {
      if (attr === 'Arn' && p.partition) {
        return `arn:${p.partition}:ecr:${p.region}:${p.accountId}:repository/${physicalId}`;
      }
      if (attr === 'RepositoryUri' && p.urlSuffix) {
        return `${p.accountId}.dkr.ecr.${p.region}.${p.urlSuffix}/${physicalId}`;
      }
    }
    return undefined;
  }

  if (intrinsic === 'Fn::Split') {
    if (!Array.isArray(arg) || arg.length !== 2) return undefined;
    const argArr = arg as unknown[];
    const delim = argArr[0];
    if (typeof delim !== 'string') return undefined;
    const src = resolveImageIntrinsicAny(argArr[1], resources, context);
    if (typeof src !== 'string') return undefined;
    return src.split(delim);
  }

  if (intrinsic === 'Fn::Select') {
    if (!Array.isArray(arg) || arg.length !== 2) return undefined;
    const argArr = arg as unknown[];
    const rawIndex = argArr[0];
    let index: number | undefined;
    if (typeof rawIndex === 'number') {
      index = rawIndex;
    } else if (typeof rawIndex === 'string' && /^-?\d+$/.test(rawIndex)) {
      index = Number.parseInt(rawIndex, 10);
    }
    if (index === undefined || !Number.isFinite(index)) return undefined;
    const list = resolveImageIntrinsicAny(argArr[1], resources, context);
    if (Array.isArray(list)) {
      if (index < 0 || index >= list.length) return undefined;
      const picked = list[index];
      if (typeof picked === 'string') return picked;
      return undefined;
    }
    // Some templates pass a literal array of intrinsics directly under
    // Fn::Select. Resolve each element on the fly.
    if (Array.isArray(argArr[1])) {
      const listLiteral = argArr[1] as unknown[];
      if (index < 0 || index >= listLiteral.length) return undefined;
      return resolveImageIntrinsic(listLiteral[index], resources, context);
    }
    return undefined;
  }

  if (intrinsic === 'Fn::Join') {
    if (!Array.isArray(arg) || arg.length !== 2) return undefined;
    const [delim, parts] = arg as [unknown, unknown];
    if (typeof delim !== 'string' || !Array.isArray(parts)) return undefined;
    const resolved: string[] = [];
    for (const part of parts) {
      const r = resolveImageIntrinsic(part, resources, context);
      if (r === undefined) return undefined;
      resolved.push(r);
    }
    return resolved.join(delim);
  }

  if (intrinsic === 'Fn::Sub') {
    // Reuse the single-string Fn::Sub substituter, which handles Tier 1
    // (pseudo parameters) + Tier 2 (state-recorded ECR Repository refs).
    let template: string | undefined;
    if (typeof arg === 'string') template = arg;
    else if (Array.isArray(arg) && typeof arg[0] === 'string') template = arg[0];
    if (template === undefined) return undefined;
    const out = substituteImagePlaceholders(template, resources, context);
    if (out.includes('${')) return undefined;
    return out;
  }

  return undefined;
}

/**
 * Replace `${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` /
 * `${AWS::URLSuffix}` against `context.pseudoParameters` and same-stack
 * `${<EcrRepoLogicalId>}` / `${<EcrRepoLogicalId>.<attr>}` placeholders
 * against `context.stateResources` in a flat string. Unresolvable
 * placeholders pass through verbatim — callers detect that with a
 * post-substitution `.includes('${')` check and surface a precise error.
 *
 * Pure string-rewrite; no AWS calls. Used by both the flat-`Fn::Sub`
 * Image path (ECS `cdkl run-task`) and the `Fn::Sub` branch of
 * `resolveImageIntrinsicAny` (the nested-intrinsic resolver in this
 * file).
 */
export function substituteImagePlaceholders(
  flat: string,
  resources: Record<string, TemplateResource>,
  context: ImageResolutionContext | undefined
): string {
  if (!flat.includes('${')) return flat;
  return flat.replace(/\$\{([^}]+)\}/g, (full, key: string) => {
    if (context?.pseudoParameters) {
      if (key === 'AWS::AccountId' && context.pseudoParameters.accountId) {
        return context.pseudoParameters.accountId;
      }
      if (key === 'AWS::Region' && context.pseudoParameters.region) {
        return context.pseudoParameters.region;
      }
      if (key === 'AWS::Partition' && context.pseudoParameters.partition) {
        return context.pseudoParameters.partition;
      }
      if (key === 'AWS::URLSuffix' && context.pseudoParameters.urlSuffix) {
        return context.pseudoParameters.urlSuffix;
      }
    }
    if (context?.stateResources) {
      const dot = key.indexOf('.');
      const logicalId = dot === -1 ? key : key.slice(0, dot);
      const refResource = resources[logicalId];
      const stateEntry = context.stateResources[logicalId];
      if (refResource?.Type === 'AWS::ECR::Repository' && stateEntry) {
        if (dot === -1) {
          // `${<Repo>}` → the repository's physical id (its Name).
          return stateEntry.physicalId;
        }
        const attr = key.slice(dot + 1);
        const cached = stateEntry.attributes?.[attr];
        if (typeof cached === 'string') return cached;
      }
    }
    return full;
  });
}
