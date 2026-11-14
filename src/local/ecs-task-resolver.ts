import { dirname, isAbsolute, resolve } from 'node:path';
import { takeAwsEmulatorStateSourceHint } from './workload-aws-wiring.js';
import { existsSync, statSync } from 'node:fs';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { describeStacks, selectTargetStack } from '../cli/stack-matcher.js';
import {
  formatStateRemedy,
  substituteImagePlaceholders,
  tryResolveImageFnJoin,
  contextForContainer,
  type ImageResolutionContext,
} from './intrinsic-image.js';
import {
  containsCrossStackIntrinsic,
  substituteAgainstState,
  substituteAgainstStateAsync,
  resolveWithSensitivity,
  resolveWithSensitivityAsync,
  type CrossStackResolver,
  type StateSubstitutionResult,
  type SubstitutionContext,
} from './state-resolver.js';
import {
  DynamicReferenceResolver,
  containsDynamicReference,
  crossStackDynamicReferenceHook,
} from './dynamic-reference-resolver.js';
import { getEmbedConfig } from './embed-config.js';
import { parseEcrRegistryHost } from './ecr-uri.js';
import { defineOwnKey } from '../utils/own-keys.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { displayIdent } from '../utils/ident-display.js';

/**
 * Result of resolving a `cdkl run-task <target>` argument back to a
 * concrete `AWS::ECS::TaskDefinition` in the synthesized assembly. The
 * shape mirrors what the ECS API + the CFn template expose so the runner
 * can directly translate each field into `docker run` flags / `docker
 * network` lifecycle calls without re-walking the template.
 *
 * Phase 1: no AWS-side ECS API calls are needed to build this — every
 * field is template-derived. `Secrets[].valueFrom` resolution happens
 * separately in `ecs-secrets-resolver.ts` so this module stays free of
 * AWS SDK imports.
 */
export interface ResolvedEcsTask {
  /** Stack the task definition belongs to. */
  stack: StackInfo;
  /** Logical id of the AWS::ECS::TaskDefinition resource. */
  taskDefinitionLogicalId: string;
  /** Raw template entry — kept for future feature additions. */
  resource: TemplateResource;
  /**
   * Task family. Falls back to the logical id when not declared (CDK auto-
   * generates a family in this case but only at deploy time; locally we
   * surface the logical id so logs are still identifiable).
   */
  family: string;
  /**
   * Default `bridge`. `awsvpc` is mapped to `bridge` locally with a warn
   * because docker cannot emulate ENI-per-task; `host` and `none` pass
   * through unchanged.
   */
  networkMode: 'bridge' | 'awsvpc' | 'host' | 'none';
  /**
   * Resolved task role ARN. Surfaced as either:
   *   - a flat string ARN passed through verbatim from the template, OR
   *   - the deployed role's ARN when the `TaskRoleArn` is a `Ref` /
   *     `Fn::GetAtt` against an `AWS::IAM::Role` in the same stack and the
   *     state source's record holds that role (go-to-k/cdkd#6223), OR
   *   - a synth-time placeholder of the shape
   *     `arn:${AWS::Partition}:iam::${AWS::AccountId}:role/<RoleLogicalId>`
   *     for the same reference with no such record ({@link taskRoleUnresolved}
   *     is then set). The CLI substitutes the placeholders lazily via STS
   *     `GetCallerIdentity` when (and only when) `--assume-task-role` is used
   *     in its bare form.
   *   - `undefined` when the template's `TaskRoleArn` is missing OR is an
   *     intrinsic that doesn't reference a same-stack IAM Role (e.g.
   *     points at a non-IAM-Role resource type or is an unsupported
   *     intrinsic shape — see `resolveRoleArn`).
   */
  taskRoleArn?: string;
  /**
   * Set when {@link taskRoleArn} is the placeholder built from the role's
   * LOGICAL id, with why no state record named the deployed role: the ARN is
   * right only if the role's name is its logical id (go-to-k/cdkd#6223).
   */
  taskRoleUnresolved?: { logicalId: string; reason: TaskRoleUnresolvedReason };
  /** Resolved execution role ARN. Follows the same shape as `taskRoleArn`. */
  executionRoleArn?: string;
  containers: ResolvedEcsContainer[];
  volumes: ResolvedEcsVolume[];
  /**
   * `RuntimePlatform.CpuArchitecture` + `OperatingSystemFamily`. Only
   * `X86_64` / `ARM64` + `LINUX` are routed in v1; other values pass
   * through unchanged but the docker-runner only honors the arch field.
   */
  runtimePlatform?: { cpuArchitecture: 'X86_64' | 'ARM64'; operatingSystemFamily: 'LINUX' };
  /**
   * Resolution warnings (e.g. `awsvpc` → `bridge` map) the caller may
   * want to surface at startup. Non-fatal — the runner still proceeds.
   */
  warnings: string[];
}

export interface ResolvedEcsContainer {
  name: string;
  image: ResolvedEcsImage;
  command?: string[];
  entryPoint?: string[];
  workingDirectory?: string;
  /** Literal-only env vars; intrinsic-valued entries are dropped (matches `cdkl invoke` v1). */
  environment: Record<string, string>;
  /**
   * Env keys whose value resolved to a decrypted `SecureString` SSM
   * parameter (issue #99). The runner unions these into the
   * value-from-process-env set so the secret never lands on the
   * `docker run` argv.
   */
  sensitiveEnvKeys: string[];
  /** SecretArn entries. Resolved to real values by `ecs-secrets-resolver.ts`. */
  secrets: { name: string; valueFrom: string }[];
  /**
   * Names of `Secrets` entries dropped because their intrinsic `ValueFrom`
   * could not be resolved (no state source). Not fetched, but a value
   * `--env-vars` supplies for one is still a secret: the runner keeps it off
   * the `docker run` argv (issue #848). Absent when nothing was dropped.
   */
  droppedSecretNames?: string[];
  /**
   * Container port mappings. `name` (mirrors the CFn `Name` field) is
   * surfaced for Service Connect resolution (Phase 3 of #262 / Issue
   * #460) — the resolver matches `ServiceConnectConfiguration.Services[].PortName`
   * against this field.
   */
  portMappings: {
    name?: string;
    containerPort: number;
    hostPort?: number;
    protocol: 'tcp' | 'udp';
  }[];
  mountPoints: { sourceVolume: string; containerPath: string; readOnly: boolean }[];
  dependsOn: { containerName: string; condition: 'START' | 'COMPLETE' | 'SUCCESS' | 'HEALTHY' }[];
  links: string[];
  /** Default true per AWS docs — when not set, the container is treated as essential. */
  essential: boolean;
  healthCheck?: {
    command: string[];
    interval?: number;
    timeout?: number;
    retries?: number;
    startPeriod?: number;
  };
  user?: string;
  privileged?: boolean;
  readonlyRootFilesystem?: boolean;
  ulimits: { name: string; softLimit: number; hardLimit: number }[];
  /**
   * Non-fatal warnings produced while parsing this container — typically
   * intrinsic-valued env vars or secret ValueFrom entries that could not
   * be substituted against state. The CLI prints these so the user
   * understands why an expected env / secret is missing.
   */
  warnings: string[];
  /** An intrinsic-valued env var was dropped because no state source was given. */
  droppedEnvWithoutState?: boolean;
  /**
   * `Command` / `EntryPoint` / `HealthCheck.Command` elements that did not
   * resolve to a string (issue #961). Each keeps its POSITION in the resolved
   * array as an empty placeholder; {@link assertEcsTaskCommandsResolved}
   * refuses the run before any container starts, because running without the
   * element runs a different command than the deployed task. Absent when
   * every element resolved.
   */
  unresolvedCommandElements?: UnresolvedCommandElement[];
}

/** One container argv element that did not resolve (issue #961). */
export interface UnresolvedCommandElement {
  field: 'Command' | 'EntryPoint' | 'HealthCheck.Command';
  index: number;
  reason: string;
}

export type ResolvedEcsImage =
  | { kind: 'cdk-asset'; assetHash?: string }
  | { kind: 'ecr'; uri: string; account: string; region: string }
  | { kind: 'public'; uri: string }
  /**
   * Issue #847 — the image names a same-stack `AWS::ECR::Repository` whose
   * URI cannot be resolved without deployed state (no state source, or the
   * repository is absent from it). It is a deployed-registry pin like `ecr`,
   * so `--image-override` can replace it with a local build; a container
   * left uncovered fails with `unresolvedReason` before anything starts
   * (`assertEcsTaskImagesResolvable`).
   */
  | { kind: 'same-stack-ecr'; repoLogicalId: string; unresolvedReason: string };

export interface ResolvedEcsVolume {
  name: string;
  kind: 'host' | 'docker';
  /** Absolute host path for a bind mount. Undefined → docker anonymous volume. */
  hostPath?: string;
  /**
   * `DockerVolumeConfiguration`. When set, the volume is realized via
   * `docker volume create` rather than a bind mount.
   */
  dockerVolumeConfig?: {
    scope: 'task' | 'shared';
    autoprovision?: boolean;
    driver?: string;
    driverOpts?: Record<string, string>;
    labels?: Record<string, string>;
  };
}

export class EcsTaskResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcsTaskResolutionError';
    Object.setPrototypeOf(this, EcsTaskResolutionError.prototype);
  }
}

/**
 * Issue #847 — refuse a task whose container image is still a
 * {@link ResolvedEcsImage} `same-stack-ecr` that no `--image-override` covers.
 * `coveredContainers` names the containers whose image an override replaces.
 * Throws {@link EcsTaskResolutionError} carrying each uncovered container's
 * reason (the "needs deployed state" message the resolver used to throw
 * directly), so the failure lands before any network or container exists.
 *
 * Host-side use case: a host that resolves a task / service itself and runs
 * it through `runEcsTask` calls this after its own `--image-override` pass.
 */
export function assertEcsTaskImagesResolvable(
  task: Pick<ResolvedEcsTask, 'containers'>,
  coveredContainers: ReadonlySet<string> | ReadonlyMap<string, unknown> = new Set()
): void {
  const reasons: string[] = [];
  for (const c of task.containers) {
    if (c.image.kind !== 'same-stack-ecr' || coveredContainers.has(c.name)) continue;
    reasons.push(c.image.unresolvedReason);
  }
  if (reasons.length > 0) throw new EcsTaskResolutionError(reasons.join('\n'));
}

/**
 * The partition table + its lookup now live in `./intrinsic-image.js`,
 * which is the ONE home for them in this package (issue #575,
 * go-to-k/cdkd#1821: a second copy behind
 * `derivePseudoParametersFromRegion` there had drifted three rows behind
 * this one, so a `us-isof-` / `eu-isoe-` / `eusc-` region resolved
 * commercial on that path). `intrinsic-image.ts` is a leaf module and
 * this file already imports from it, so the reverse direction would be
 * an import cycle.
 *
 * `derivePartitionAndUrlSuffix` is re-exported so the existing importers
 * (`local-invoke.ts`, `ecs-service-emulator.ts`, `local-run-task.ts`,
 * `local-start-api.ts`) keep working unchanged. `PARTITION_TABLE` is NOT
 * inherited traffic -- it did not exist before this change -- and is
 * carried along only so the pair stays reachable from one module; its
 * sole consumer today is the test asserting the two names resolve to the
 * SAME objects rather than to a second copy.
 */
export { PARTITION_TABLE, derivePartitionAndUrlSuffix } from './intrinsic-image.js';

/**
 * Optional substitution data fed into `parseContainerImage`. Closes issue
 * #264 — container `Image` fields shaped as `Fn::Sub` against AWS pseudo
 * parameters (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` /
 * `${AWS::URLSuffix}`) and / or same-stack `AWS::ECR::Repository` refs are
 * resolvable at runtime when the caller can supply the account ID + region
 * (Tier 1, no state needed) and optionally the host state-recorded
 * `physicalId` map (Tier 2, `--from-state`).
 *
 * The CLI command resolves both blocks lazily — STS is only invoked when
 * at least one container's `Image` references the pseudo parameters — and
 * passes the resolved shape here. The resolver itself stays pure and
 * synchronous.
 */
/**
 * Substitution context for ECS resolution. Re-exported alias for the
 * shared `ImageResolutionContext` in `intrinsic-image.ts` (extracted
 * in issue #286 Gap 2 when `lambda-resolver.ts` needed the same
 * resolver). The shared type carries `pseudoParameters` (Tier 1) +
 * `stateResources` (Tier 2). `stateResources` is consumed by:
 *   - Image (PR #267): `${<LogicalId>}` against an `AWS::ECR::Repository`
 *     and the `Fn::GetAtt: [<Repo>, 'RepositoryUri']` shape.
 *   - Environment / Secrets (issue #291): intrinsic-valued
 *     `Environment[].Value` and `Secrets[].ValueFrom` entries
 *     (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`) are substituted
 *     via `state-resolver.ts`'s `substituteAgainstState`.
 * Existing consumers (`src/cli/commands/local-run-task.ts`) import the
 * alias; new code should reach for `ImageResolutionContext` directly.
 */
export type EcsImageResolutionContext = ImageResolutionContext;

/**
 * Parse a `target` argument into (optional stack pattern, path-or-id).
 * Mirrors `lambda-resolver.parseTarget` exactly — same accepted forms,
 * same single-stack auto-detect rule.
 */
export interface ParsedEcsTarget {
  stackPattern: string | null;
  pathOrId: string;
  isPath: boolean;
}

/**
 * Walk the matched stack's template and report whether any container's
 * `Image` field needs Tier 1 (pseudo-parameter) or Tier 2 (state-recorded
 * ECR Repository) substitution. The CLI uses this to make the STS /
 * state-load calls lazy — flat strings / cdk-asset shapes / Fn::Sub bodies
 * with no recognized placeholders skip both calls entirely.
 *
 * The probe is per-stack rather than per-target because we don't run the
 * full target resolver until the substitution context is built; cheap
 * O(resources) scan over the template's task definitions is sufficient.
 */
export interface EcsImageResolutionNeeds {
  /** Any `Fn::Sub` body references an `AWS::*` pseudo parameter. */
  needsPseudoParameters: boolean;
  /**
   * Any `Fn::Sub` body references an `AWS::ECR::Repository` logical ID,
   * OR any `Fn::GetAtt: [<Repo>, 'RepositoryUri' | 'Arn']` is present.
   */
  needsStateResources: boolean;
  /**
   * Any container's `Environment[].Value` OR `Secrets[].ValueFrom` is
   * an intrinsic (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`); OR
   * any task's `Volumes[].Host.SourcePath` is an intrinsic (Gap 6 of
   * #286); OR any task's `TaskRoleArn` / `ExecutionRoleArn` is a
   * `Fn::Sub` / `Fn::Join` intrinsic (Gap 5 of #286). The CLI uses
   * this flag to gate `--from-state` state loading + pseudo-parameter
   * resolution. Without `--from-state` these entries either drop with
   * warnings (env / secret / role ARN) or hard-error (volume source
   * path — silent drop would mount an empty anonymous volume).
   */
  needsEnvOrSecretSubstitution: boolean;
  /**
   * Any container's `Environment[].Value` OR `Secrets[].ValueFrom` is a
   * cross-stack intrinsic (top-level `Fn::ImportValue` /
   * `Fn::GetStackOutput`). Issue #454 — gates the cross-stack resolver
   * construction inside the `--from-state` flow so literal +
   * same-stack-intrinsic env maps don't pay the extra S3-client / index-
   * load cost.
   */
  needsCrossStackResolver: boolean;
  /**
   * Any task's `TaskRoleArn` is a `Ref` / `Fn::GetAtt` against a same-stack
   * `AWS::IAM::Role`, whose deployed name only the state record holds
   * (go-to-k/cdkd#6223). The CLI loads state for it on the bare
   * `--assume-task-role` path only.
   */
  needsTaskRoleState: boolean;
}

export function detectEcsImageResolutionNeeds(stack: StackInfo): EcsImageResolutionNeeds {
  const resources = stack.template.Resources ?? {};
  let needsPseudoParameters = false;
  let needsStateResources = false;
  let needsEnvOrSecretSubstitution = false;
  let needsCrossStackResolver = false;
  let needsTaskRoleState = false;

  for (const res of Object.values(resources)) {
    if (res.Type !== 'AWS::ECS::TaskDefinition') continue;
    const props = res.Properties ?? {};
    const containers = Array.isArray(props['ContainerDefinitions'])
      ? props['ContainerDefinitions']
      : [];
    for (const c of containers) {
      if (!c || typeof c !== 'object') continue;
      const co = c as Record<string, unknown>;
      const image = co['Image'];
      const need = inspectImageForSubstitutions(image, resources);
      if (need.pseudo) needsPseudoParameters = true;
      if (need.state) needsStateResources = true;
      if (containerHasIntrinsicEnvOrSecret(co)) needsEnvOrSecretSubstitution = true;
      // An intrinsic argv element resolves against state too (issue #961).
      const argv = containerArgvElements(co);
      if (argv.some((v) => v !== null && typeof v === 'object')) {
        needsEnvOrSecretSubstitution = true;
      }
      if (argv.some(isCrossStackIntrinsic)) {
        needsEnvOrSecretSubstitution = true;
        needsCrossStackResolver = true;
      }
      if (containerHasCrossStackEnvOrSecret(co)) {
        needsEnvOrSecretSubstitution = true;
        needsCrossStackResolver = true;
      }
    }
    // Volumes[].Host.SourcePath as a CFn intrinsic (Gap 6 of #286).
    const rawVolumes = props['Volumes'];
    if (Array.isArray(rawVolumes)) {
      for (const v of rawVolumes) {
        if (volumeHasIntrinsicSourcePath(v)) {
          needsEnvOrSecretSubstitution = true;
          break;
        }
      }
    }
    // A same-stack role's deployed name is only in the state record
    // (go-to-k/cdkd#6223). Its own flag: the CLI loads state for it only on
    // the bare `--assume-task-role` path, the one reader of the task role.
    if (sameStackRoleLogicalId(props['TaskRoleArn'], resources) !== undefined) {
      needsTaskRoleState = true;
    }
    // TaskRoleArn / ExecutionRoleArn as a Fn::Sub / Fn::Join intrinsic
    // (Gap 5 of #286). Ref / Fn::GetAtt shapes are `needsTaskRoleState`'s.
    if (
      isFnJoinOrSubIntrinsic(props['TaskRoleArn']) ||
      isFnJoinOrSubIntrinsic(props['ExecutionRoleArn'])
    ) {
      needsEnvOrSecretSubstitution = true;
    }
  }
  return {
    needsPseudoParameters,
    needsStateResources,
    needsEnvOrSecretSubstitution,
    needsCrossStackResolver,
    needsTaskRoleState,
  };
}

/**
 * Returns true when any `Environment[].Value` or `Secrets[].ValueFrom`
 * is, or nests, an `Fn::ImportValue` / `Fn::GetStackOutput` intrinsic.
 * Issue #454 — gates cross-stack resolver construction so literal +
 * same-stack-intrinsic env / secret maps don't pay the extra cost.
 */
function containerHasCrossStackEnvOrSecret(c: Record<string, unknown>): boolean {
  const env = c['Environment'];
  if (Array.isArray(env)) {
    for (const entry of env) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['Value'];
      if (isCrossStackIntrinsic(v)) return true;
    }
  }
  const secrets = c['Secrets'];
  if (Array.isArray(secrets)) {
    for (const entry of secrets) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['ValueFrom'];
      if (isCrossStackIntrinsic(v)) return true;
    }
  }
  return false;
}

/**
 * Every element of a container's `Command` / `EntryPoint` /
 * `HealthCheck.Command` (issue #961).
 */
function containerArgvElements(c: Record<string, unknown>): unknown[] {
  const health = c['HealthCheck'];
  const lists = [
    c['Command'],
    c['EntryPoint'],
    health && typeof health === 'object'
      ? (health as Record<string, unknown>)['Command']
      : undefined,
  ];
  return lists.flatMap((l) => (Array.isArray(l) ? (l as unknown[]) : []));
}

/**
 * A value only the async cross-stack path can resolve: an `Fn::ImportValue` /
 * `Fn::GetStackOutput` at the top level or nested at any depth inside
 * `Fn::Join` / `Fn::Sub` / ... (issue #962).
 */
function isCrossStackIntrinsic(value: unknown): boolean {
  return containsCrossStackIntrinsic(value);
}

/**
 * Detect whether a Volume entry has an intrinsic-valued `Host.SourcePath`.
 * Used by `detectEcsImageResolutionNeeds` (Gap 6 of #286) to trigger
 * state-load + pseudo-parameter resolution under `--from-state` when the
 * SourcePath is built via `cdk.Fn.sub(...)` / `cdk.Fn.join(...)`.
 */
function volumeHasIntrinsicSourcePath(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const host = (v as Record<string, unknown>)['Host'];
  if (!host || typeof host !== 'object') return false;
  const sp = (host as Record<string, unknown>)['SourcePath'];
  if (sp === undefined || sp === null) return false;
  if (typeof sp === 'string') return false;
  return typeof sp === 'object';
}

/**
 * Detect whether a value is an `Fn::Sub` / `Fn::Join` intrinsic. Used by
 * `detectEcsImageResolutionNeeds` to flag role-ARN intrinsic shapes
 * (Gap 5 of #286) that need `--from-state` + pseudo-parameter
 * substitution. `Ref` / `Fn::GetAtt` shapes resolve to a placeholder
 * ARN without state and are intentionally excluded here.
 */
function isFnJoinOrSubIntrinsic(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return 'Fn::Join' in obj || 'Fn::Sub' in obj;
}

/**
 * Returns true when any `Environment[].Value` or `Secrets[].ValueFrom`
 * is an intrinsic (non-literal). Used to gate `--from-state` state
 * loading at the CLI layer — issue #291.
 */
function containerHasIntrinsicEnvOrSecret(c: Record<string, unknown>): boolean {
  const env = c['Environment'];
  if (Array.isArray(env)) {
    for (const entry of env) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['Value'];
      if (
        v !== undefined &&
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
      ) {
        return true;
      }
    }
  }
  const secrets = c['Secrets'];
  if (Array.isArray(secrets)) {
    for (const entry of secrets) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['ValueFrom'];
      if (v !== undefined && typeof v !== 'string') return true;
    }
  }
  return false;
}

function inspectImageForSubstitutions(
  image: unknown,
  resources: Record<string, TemplateResource>
): { pseudo: boolean; state: boolean } {
  if (!image || typeof image !== 'object') return { pseudo: false, state: false };
  const obj = image as Record<string, unknown>;

  // Fn::GetAtt direct shape against an ECR::Repository — Tier 2 only.
  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    let lid: string | undefined;
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') lid = getAtt[0];
    else if (typeof getAtt === 'string') lid = getAtt.split('.')[0];
    if (lid && resources[lid]?.Type === 'AWS::ECR::Repository') {
      return { pseudo: false, state: true };
    }
  }

  // Fn::Join body: recursively walk every element for references that
  // would trigger Tier 1 (pseudo) / Tier 2 (state) needs. CDK 2.x
  // synthesizes `ContainerImage.fromEcrRepository(repo)` as a Fn::Join
  // containing nested Fn::Select / Fn::Split over the repo's Arn GetAtt
  // plus a Ref to the repo and `Ref: AWS::URLSuffix`.
  const join = obj['Fn::Join'];
  if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
    const scan: { pseudo: boolean; state: boolean } = { pseudo: false, state: false };
    inspectIntrinsicNeeds(join[1], resources, scan);
    if (scan.pseudo || scan.state) return scan;
  }

  // Fn::Sub body: scan every `${...}` placeholder.
  let sub: string | undefined;
  const subRaw = obj['Fn::Sub'];
  if (typeof subRaw === 'string') sub = subRaw;
  else if (Array.isArray(subRaw) && typeof subRaw[0] === 'string') sub = subRaw[0];
  if (!sub) return { pseudo: false, state: false };

  let pseudo = false;
  let state = false;
  const placeholderRegex = /\$\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = placeholderRegex.exec(sub)) !== null) {
    const key = m[1]!;
    if (key.startsWith('AWS::')) {
      pseudo = true;
      continue;
    }
    const dot = key.indexOf('.');
    const lid = dot === -1 ? key : key.slice(0, dot);
    if (resources[lid]?.Type === 'AWS::ECR::Repository') state = true;
  }
  return { pseudo, state };
}

/**
 * Recursive needs probe used by `inspectImageForSubstitutions` for the
 * `Fn::Join` shape: walk every nested intrinsic and flag whether a
 * `Ref: AWS::*` pseudo parameter is reachable (Tier 1 needed) or a
 * `Ref` / `Fn::GetAtt` against an `AWS::ECR::Repository` is reachable
 * (Tier 2 needed).
 */
function inspectIntrinsicNeeds(
  node: unknown,
  resources: Record<string, TemplateResource>,
  scan: { pseudo: boolean; state: boolean }
): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const item of node) inspectIntrinsicNeeds(item, resources, scan);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (typeof obj['Ref'] === 'string') {
    const target = obj['Ref'];
    if (target.startsWith('AWS::')) scan.pseudo = true;
    else if (resources[target]?.Type === 'AWS::ECR::Repository') scan.state = true;
    return;
  }

  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    let lid: string | undefined;
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') lid = getAtt[0];
    else if (typeof getAtt === 'string') lid = getAtt.split('.')[0];
    if (lid && resources[lid]?.Type === 'AWS::ECR::Repository') scan.state = true;
    return;
  }

  // For every other intrinsic shape, descend into its arguments so a
  // `Fn::Select` / `Fn::Split` / `Fn::Join` / `Fn::Sub` wrapper does
  // not hide a reference deeper in the tree.
  for (const value of Object.values(obj)) {
    inspectIntrinsicNeeds(value, resources, scan);
  }
}

export function parseEcsTarget(target: string): ParsedEcsTarget {
  if (typeof target !== 'string' || target.length === 0) {
    throw new EcsTaskResolutionError(
      "Empty target. Pass a CDK display path (e.g. 'MyStack/MyService/TaskDef') or stack-qualified logical ID (e.g. 'MyStack:MyServiceTaskDefXYZ1234')."
    );
  }
  const colonIdx = target.indexOf(':');
  const slashIdx = target.indexOf('/');
  if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
    const stackPattern = target.substring(0, colonIdx);
    const pathOrId = target.substring(colonIdx + 1);
    if (pathOrId.length === 0) {
      throw new EcsTaskResolutionError(`Target '${target}' has no logical ID after ':'.`);
    }
    return { stackPattern, pathOrId, isPath: pathOrId.includes('/') };
  }
  if (slashIdx > 0) {
    return { stackPattern: target.substring(0, slashIdx), pathOrId: target, isPath: true };
  }
  return { stackPattern: null, pathOrId: target, isPath: false };
}

/**
 * Resolve a parsed target against the synthesized stacks. Throws
 * `EcsTaskResolutionError` with an actionable message (listing every
 * available task definition in the matched stack) on any miss.
 *
 * Optional `context` (issue #264): when the caller can supply AWS
 * pseudo-parameter values (Tier 1) and / or host state-recorded resources
 * (Tier 2), `Fn::Sub`-shaped ECR image URIs that reference
 * `${AWS::AccountId}` / `${AWS::Region}` / a same-stack
 * `AWS::ECR::Repository` are substituted before classification.
 */
export function resolveEcsTaskTarget(
  target: string,
  stacks: StackInfo[],
  context?: EcsImageResolutionContext
): ResolvedEcsTask {
  if (stacks.length === 0) {
    throw new EcsTaskResolutionError('No stacks found in the synthesized assembly.');
  }
  const parsed = parseEcsTarget(target);
  const stack = pickStack(parsed, stacks, target);
  const resources = stack.template.Resources ?? {};

  let logicalId: string | undefined;
  let resource: TemplateResource | undefined;

  if (parsed.isPath) {
    const index = buildCdkPathIndex(stack.template);
    const resolved = resolveCdkPathToLogicalIds(parsed.pathOrId, index);
    const taskDefs = resolved.filter(
      ({ logicalId: l }) => resources[l]?.Type === 'AWS::ECS::TaskDefinition'
    );
    if (taskDefs.length === 0) {
      throw notFoundError(target, stack, resources);
    }
    if (taskDefs.length > 1) {
      throw new EcsTaskResolutionError(
        `Target '${target}' matches ${taskDefs.length} task definitions in ${stack.stackName}: ` +
          taskDefs.map((t) => t.logicalId).join(', ') +
          '. Refine the path or use the stack:LogicalId form.'
      );
    }
    logicalId = taskDefs[0]!.logicalId;
    resource = resources[logicalId];
  } else {
    resource = resources[parsed.pathOrId];
    if (!resource) throw notFoundError(target, stack, resources);
    logicalId = parsed.pathOrId;
  }

  if (!logicalId || !resource) throw notFoundError(target, stack, resources);

  if (resource.Type === 'AWS::Lambda::Function') {
    throw new EcsTaskResolutionError(
      `Resource ${displayIdent(logicalId)} in ${stack.stackName} is a Lambda function, not an ECS task definition. ` +
        `Use \`${getEmbedConfig().cliName} invoke\` for Lambda; \`${getEmbedConfig().cliName} run-task\` is ECS only.`
    );
  }
  if (resource.Type !== 'AWS::ECS::TaskDefinition') {
    throw new EcsTaskResolutionError(
      `Resource ${displayIdent(logicalId)} in ${stack.stackName} is ${displayIdent(resource.Type)}, not an AWS::ECS::TaskDefinition.`
    );
  }

  return extractTaskDefinitionProperties(stack, logicalId, resource, context);
}

function pickStack(parsed: ParsedEcsTarget, stacks: StackInfo[], target: string): StackInfo {
  const selection = selectTargetStack(parsed, target, stacks);
  switch (selection.kind) {
    case 'found':
      return selection.stack;
    case 'no-prefix':
      throw new EcsTaskResolutionError(
        `Multiple stacks in app, target '${parsed.pathOrId}' is missing a stack prefix. ` +
          `Use 'StackName:${parsed.pathOrId}' or 'StackName/...' (path form). ` +
          `Available stacks: ${describeStacks(stacks)}.`
      );
    case 'not-found':
      throw new EcsTaskResolutionError(
        `Stack '${selection.pattern}' not found. Available stacks: ${describeStacks(stacks)}.`
      );
    case 'ambiguous':
      throw new EcsTaskResolutionError(
        `Stack pattern '${selection.pattern}' matched ${selection.matched.length} stacks: ` +
          describeStacks(selection.matched) +
          ". Use a more specific pattern, or the stack's display path (path form)."
      );
  }
}

function extractTaskDefinitionProperties(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource,
  context?: EcsImageResolutionContext
): ResolvedEcsTask {
  const props = resource.Properties ?? {};
  const warnings: string[] = [];

  const family = pickString(props['Family']) ?? logicalId;

  const rawNetworkMode = pickString(props['NetworkMode']) ?? 'bridge';
  let networkMode: ResolvedEcsTask['networkMode'];
  if (
    rawNetworkMode === 'bridge' ||
    rawNetworkMode === 'awsvpc' ||
    rawNetworkMode === 'host' ||
    rawNetworkMode === 'none'
  ) {
    networkMode = rawNetworkMode;
  } else {
    throw new EcsTaskResolutionError(
      `Task definition ${displayIdent(logicalId)} has unsupported NetworkMode ${displayIdent(rawNetworkMode)}. ` +
        'Supported values: bridge / awsvpc / host / none.'
    );
  }
  if (networkMode === 'awsvpc') {
    warnings.push(
      `NetworkMode 'awsvpc' on ${displayIdent(logicalId)} is mapped to docker bridge locally — ` +
        'docker cannot emulate ENI-per-task. AWS SDK calls still reach public endpoints via the developer network.'
    );
  }

  // Issue #544 — `ProxyConfiguration` (custom App Mesh / Envoy bootstrap)
  // is NOT honored by `cdkl start-service` / `cdkl run-task`
  // in v1. Design § 2 hard-rejects custom Envoy bootstrap; locally we
  // run the user's containers without the configured proxy and surface
  // a warn so users aren't surprised by the missing sidecar.
  if (props['ProxyConfiguration']) {
    warnings.push(
      `Task definition ${displayIdent(logicalId)} declares 'ProxyConfiguration' (custom Envoy / App Mesh bootstrap), ` +
        `which is NOT honored by '${getEmbedConfig().cliName} start-service' / '${getEmbedConfig().cliName} run-task' in v1. ` +
        'Local execution will run without the configured proxy. See design doc § 2 for the rationale.'
    );
  }

  const resources = stack.template.Resources ?? {};

  const subContext = buildSubstitutionContextFromImageContext(context);
  // Mixed mode can make the record's roles the wrong side's (go-to-k/cdkd#6223):
  // drop its IAM roles only, so a `Fn::Join` / `Fn::Sub` role ARN over pseudo
  // parameters or other records still resolves.
  const roleSubContext =
    context?.ignoreStateForRoles && subContext
      ? {
          ...subContext,
          resources: Object.fromEntries(
            Object.entries(subContext.resources).filter(
              ([, r]) => r.resourceType !== 'AWS::IAM::Role'
            )
          ),
        }
      : subContext;
  const taskRole = resolveRoleArn(props['TaskRoleArn'], resources, roleSubContext);
  const taskRoleArn = taskRole.arn;
  const executionRoleArn = resolveRoleArn(props['ExecutionRoleArn'], resources, roleSubContext).arn;

  const runtimePlatform = parseRuntimePlatform(props['RuntimePlatform']);

  const rawContainers = props['ContainerDefinitions'];
  if (!Array.isArray(rawContainers) || rawContainers.length === 0) {
    throw new EcsTaskResolutionError(
      `Task definition ${displayIdent(logicalId)} has no ContainerDefinitions.`
    );
  }
  const containers = rawContainers.map((c, idx) =>
    parseContainerDefinition(c, idx, logicalId, resources, stack, context)
  );

  // Surface per-container warnings (e.g. dropped intrinsic env vars /
  // secrets) on the task-level `warnings` array so the CLI prints them.
  for (const ctr of containers) {
    for (const w of ctr.warnings) {
      warnings.push(`Container ${displayIdent(ctr.name)}: ${w}`);
    }
  }
  // No state source and a resource-referencing env var dropped: one hint.
  if (containers.some((c) => c.droppedEnvWithoutState)) {
    const hint = takeAwsEmulatorStateSourceHint();
    if (hint) warnings.push(hint);
  }

  const rawVolumes = props['Volumes'];
  const volumes = Array.isArray(rawVolumes)
    ? rawVolumes.map((v, idx) => parseVolume(v, idx, logicalId, subContext))
    : [];

  // dependsOn must reference an existing container name.
  const containerNames = new Set(containers.map((c) => c.name));
  for (const c of containers) {
    for (const d of c.dependsOn) {
      if (!containerNames.has(d.containerName)) {
        throw new EcsTaskResolutionError(
          `Container ${displayIdent(c.name)} depends on ${displayIdent(d.containerName)}, which is not defined in task ${displayIdent(logicalId)}.`
        );
      }
    }
  }

  const out: ResolvedEcsTask = {
    stack,
    taskDefinitionLogicalId: logicalId,
    resource,
    family,
    networkMode,
    containers,
    volumes,
    warnings,
  };
  if (taskRoleArn !== undefined) out.taskRoleArn = taskRoleArn;
  if (taskRole.unresolved !== undefined) out.taskRoleUnresolved = taskRole.unresolved;
  if (executionRoleArn !== undefined) out.executionRoleArn = executionRoleArn;
  if (runtimePlatform !== undefined) out.runtimePlatform = runtimePlatform;
  return out;
}

function parseRuntimePlatform(value: unknown): ResolvedEcsTask['runtimePlatform'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const cpu = obj['CpuArchitecture'];
  const os = obj['OperatingSystemFamily'];
  if (typeof cpu !== 'string' || typeof os !== 'string') return undefined;
  if (cpu !== 'X86_64' && cpu !== 'ARM64') return undefined;
  if (os !== 'LINUX') return undefined;
  return { cpuArchitecture: cpu, operatingSystemFamily: os };
}

function parseContainerDefinition(
  raw: unknown,
  idx: number,
  taskLogicalId: string,
  resources: Record<string, TemplateResource>,
  stack: StackInfo,
  context?: EcsImageResolutionContext
): ResolvedEcsContainer {
  if (!raw || typeof raw !== 'object') {
    throw new EcsTaskResolutionError(
      `Task ${displayIdent(taskLogicalId)} ContainerDefinitions[${idx}] is not an object.`
    );
  }
  const c = raw as Record<string, unknown>;
  const name = pickString(c['Name']);
  if (!name) {
    throw new EcsTaskResolutionError(
      `Task ${displayIdent(taskLogicalId)} ContainerDefinitions[${idx}] has no Name.`
    );
  }

  const image = parseContainerImage(c['Image'], name, taskLogicalId, resources, stack, context);

  // Mixed mode: this container's own exceptions pick its names (#905).
  const containerContext = contextForContainer(context, name);
  const subContext = buildSubstitutionContextFromImageContext(containerContext);

  // An argv element that does not resolve is RECORDED, not dropped: dropping
  // it ran a different command (`--bucket` with no value, issue #961). The
  // CLI refuses the run via `assertEcsTaskCommandsResolved` once the
  // cross-stack post-pass has had its chance at the element.
  const unresolvedCommandElements: UnresolvedCommandElement[] = [];
  const argv = (raw: unknown, field: UnresolvedCommandElement['field']): string[] | undefined =>
    resolveArgvArray(raw, field, subContext, containerContext, unresolvedCommandElements);
  const command = argv(c['Command'], 'Command');
  const entryPoint = argv(c['EntryPoint'], 'EntryPoint');
  const workingDirectory = pickString(c['WorkingDirectory']);

  const environment: Record<string, string> = {};
  const sensitiveEnvKeys: string[] = [];
  const droppedEnvKeys: { key: string; reason: string }[] = [];
  let droppedEnvWithoutState = false;
  if (Array.isArray(c['Environment'])) {
    for (const entry of c['Environment'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const key = pickString(e['Name']);
      const value = e['Value'];
      if (!key) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        // Own-key writes: an env var named `__proto__` must not be
        // dropped by Object.prototype's setter (issue #769).
        defineOwnKey(environment, key, String(value));
        continue;
      }
      // Intrinsic-valued entry. With `--from-state` we try to substitute
      // against state + pseudo parameters (closes #291); without it the
      // value is dropped and a warn is surfaced via the task's
      // `warnings` array (matches PR 1 `cdkl invoke` semantics).
      if (subContext) {
        const { result: sub, consumedSensitive } = resolveWithSensitivity(value, subContext);
        if (sub.kind === 'literal') {
          defineOwnKey(environment, key, String(sub.value));
          // SecureString-backed value — keep it off the `docker run` argv (#99).
          if (consumedSensitive) sensitiveEnvKeys.push(key);
          continue;
        }
        droppedEnvKeys.push({ key, reason: sub.reason });
      } else {
        droppedEnvWithoutState = true;
        droppedEnvKeys.push({
          key,
          reason: 'intrinsic-valued; pass --from-state to substitute against deployed state',
        });
      }
    }
  }

  const secrets: ResolvedEcsContainer['secrets'] = [];
  const droppedSecretKeys: { key: string; reason: string }[] = [];
  if (Array.isArray(c['Secrets'])) {
    for (const entry of c['Secrets'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const sName = pickString(e['Name']);
      const valueFromRaw = e['ValueFrom'];
      if (!sName) continue;
      // Literal string ValueFrom (pre-resolved, or fromSecretCompleteArn).
      if (typeof valueFromRaw === 'string' && valueFromRaw.length > 0) {
        secrets.push({ name: sName, valueFrom: valueFromRaw });
        continue;
      }
      // Intrinsic-valued (`Ref` / `Fn::GetAtt` / `Fn::Join` / `Fn::Sub`).
      // With `--from-state` substitute against deployed state + pseudo
      // parameters; without it, drop the secret and warn — the user's
      // workaround is `fromSecretCompleteArn` (literal ARN at synth time).
      if (subContext) {
        const sub = substituteAgainstState(valueFromRaw, subContext);
        if (sub.kind === 'literal' && typeof sub.value === 'string' && sub.value.length > 0) {
          secrets.push({ name: sName, valueFrom: sub.value });
          continue;
        }
        droppedSecretKeys.push({
          key: sName,
          reason: sub.kind === 'literal' ? 'resolved to non-string / empty value' : sub.reason,
        });
      } else {
        droppedSecretKeys.push({
          key: sName,
          reason: 'intrinsic-valued ValueFrom; pass --from-state to resolve the deployed ARN',
        });
      }
    }
  }

  const portMappings: ResolvedEcsContainer['portMappings'] = [];
  if (Array.isArray(c['PortMappings'])) {
    for (const entry of c['PortMappings'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const p = entry as Record<string, unknown>;
      const containerPort = typeof p['ContainerPort'] === 'number' ? p['ContainerPort'] : undefined;
      if (containerPort === undefined) continue;
      const hostPort = typeof p['HostPort'] === 'number' ? p['HostPort'] : undefined;
      const protocol = pickString(p['Protocol']) === 'udp' ? 'udp' : 'tcp';
      const pm: ResolvedEcsContainer['portMappings'][number] = { containerPort, protocol };
      if (hostPort !== undefined) pm.hostPort = hostPort;
      const portName = typeof p['Name'] === 'string' ? p['Name'] : undefined;
      if (portName !== undefined) pm.name = portName;
      portMappings.push(pm);
    }
  }

  const mountPoints: ResolvedEcsContainer['mountPoints'] = [];
  if (Array.isArray(c['MountPoints'])) {
    for (const entry of c['MountPoints'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const m = entry as Record<string, unknown>;
      const sourceVolume = pickString(m['SourceVolume']);
      const containerPath = pickString(m['ContainerPath']);
      if (!sourceVolume || !containerPath) continue;
      mountPoints.push({
        sourceVolume,
        containerPath,
        readOnly: m['ReadOnly'] === true,
      });
    }
  }

  const dependsOn: ResolvedEcsContainer['dependsOn'] = [];
  if (Array.isArray(c['DependsOn'])) {
    for (const entry of c['DependsOn'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const d = entry as Record<string, unknown>;
      const containerName = pickString(d['ContainerName']);
      const condition = pickString(d['Condition']);
      if (!containerName || !condition) continue;
      if (
        condition !== 'START' &&
        condition !== 'COMPLETE' &&
        condition !== 'SUCCESS' &&
        condition !== 'HEALTHY'
      ) {
        throw new EcsTaskResolutionError(
          `Container ${displayIdent(name)} has invalid DependsOn condition ${displayIdent(condition)}. ` +
            'Accepted values: START / COMPLETE / SUCCESS / HEALTHY.'
        );
      }
      dependsOn.push({ containerName, condition });
    }
  }

  const links = pickStringArray(c['Links']) ?? [];
  const essential = c['Essential'] === false ? false : true;

  let healthCheck: ResolvedEcsContainer['healthCheck'] | undefined;
  if (c['HealthCheck'] && typeof c['HealthCheck'] === 'object') {
    const h = c['HealthCheck'] as Record<string, unknown>;
    const command2 = argv(h['Command'], 'HealthCheck.Command');
    if (command2 && command2.length > 0) {
      healthCheck = { command: command2 };
      if (typeof h['Interval'] === 'number') healthCheck.interval = h['Interval'];
      if (typeof h['Timeout'] === 'number') healthCheck.timeout = h['Timeout'];
      if (typeof h['Retries'] === 'number') healthCheck.retries = h['Retries'];
      if (typeof h['StartPeriod'] === 'number') healthCheck.startPeriod = h['StartPeriod'];
    }
  }

  const user = pickString(c['User']);
  const privileged = c['Privileged'] === true ? true : undefined;
  const readonlyRootFilesystem = c['ReadonlyRootFilesystem'] === true ? true : undefined;

  const ulimits: ResolvedEcsContainer['ulimits'] = [];
  if (Array.isArray(c['Ulimits'])) {
    for (const entry of c['Ulimits'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const u = entry as Record<string, unknown>;
      const uName = pickString(u['Name']);
      const soft = typeof u['SoftLimit'] === 'number' ? u['SoftLimit'] : undefined;
      const hard = typeof u['HardLimit'] === 'number' ? u['HardLimit'] : undefined;
      if (!uName || soft === undefined || hard === undefined) continue;
      ulimits.push({ name: uName, softLimit: soft, hardLimit: hard });
    }
  }

  const warnings: string[] = [];
  for (const d of droppedEnvKeys) {
    warnings.push(`Environment ${displayIdent(d.key)} dropped: ${d.reason}`);
  }
  for (const d of droppedSecretKeys) {
    warnings.push(`Secret ${displayIdent(d.key)} dropped: ${d.reason}`);
  }

  const out: ResolvedEcsContainer = {
    name,
    image,
    environment,
    sensitiveEnvKeys,
    secrets,
    portMappings,
    mountPoints,
    dependsOn,
    links,
    essential,
    ulimits,
    warnings,
  };
  if (droppedEnvWithoutState) out.droppedEnvWithoutState = true;
  if (droppedSecretKeys.length > 0) out.droppedSecretNames = droppedSecretKeys.map((d) => d.key);
  if (command !== undefined) out.command = command;
  if (entryPoint !== undefined) out.entryPoint = entryPoint;
  if (workingDirectory !== undefined) out.workingDirectory = workingDirectory;
  if (healthCheck !== undefined) out.healthCheck = healthCheck;
  if (user !== undefined) out.user = user;
  if (privileged !== undefined) out.privileged = privileged;
  if (readonlyRootFilesystem !== undefined) out.readonlyRootFilesystem = readonlyRootFilesystem;
  if (unresolvedCommandElements.length > 0) {
    out.unresolvedCommandElements = unresolvedCommandElements;
  }
  return out;
}

/**
 * Resolve a container argv array (`Command` / `EntryPoint` /
 * `HealthCheck.Command`). ECS resolves every element at deploy time, so an
 * intrinsic element is substituted against state as `Environment` is
 * (issue #961). One that cannot be resolved keeps its POSITION as an empty
 * placeholder and is recorded in `unresolved`; the run is refused before any
 * container starts, so the placeholder never reaches docker.
 */
function resolveArgvArray(
  raw: unknown,
  field: UnresolvedCommandElement['field'],
  subContext: SubstitutionContext | undefined,
  context: EcsImageResolutionContext | undefined,
  unresolved: UnresolvedCommandElement[]
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((element: unknown, index) => {
    if (typeof element === 'string') return element;
    if (typeof element === 'number' || typeof element === 'boolean') return String(element);
    if (!element || typeof element !== 'object' || Array.isArray(element)) {
      unresolved.push({ field, index, reason: 'not a string or an intrinsic' });
      return '';
    }
    if (isCrossStackIntrinsic(element)) {
      // The sync substitution cannot answer a cross-stack reference; the
      // async post-pass (`applyCrossStackResolverToTask`) resolves it, or
      // replaces this reason with its own.
      unresolved.push({ field, index, reason: CROSS_STACK_ARGV_REASON });
      return '';
    }
    if (!subContext) {
      unresolved.push({
        field,
        index,
        reason: `intrinsic-valued and no deployed state was loaded: ${formatStateRemedy(context)}`,
      });
      return '';
    }
    const secret = secretAttributeRead(element, subContext.resources);
    if (secret !== undefined) {
      unresolved.push({ field, index, reason: secret });
      return '';
    }
    const { result: sub, consumedSensitive } = resolveWithSensitivity(element, subContext);
    const arg = argvValue(sub, consumedSensitive);
    if ('value' in arg) return arg.value;
    unresolved.push({ field, index, reason: arg.reason });
    return '';
  });
}

/**
 * The value cdkd-shaped state records in place of a `NoEcho` custom
 * resource's attribute. Serving it would run the command with `***` as an
 * argument.
 */
const STATE_SECRET_MASK = '***';

/**
 * Attribute names that look credential-bearing, minus the ones that name an
 * identifier of the secret rather than the secret (`SecretArn`, `SecretId`,
 * `SecretName`, ...).
 */
const SECRET_ATTRIBUTE_NAME = /secret|password|credential/i;
const NON_SECRET_ATTRIBUTE_SUFFIX = /(arn|id|name|url|alias|status)$/i;

/**
 * Attributes whose VALUE is a secret although their name does not look like
 * one, keyed by resource type and read by own key.
 */
const SECRET_VALUED_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ['AWS::AppSync::ApiKey', ['ApiKey']],
  ['AWS::EC2::IpamExternalResourceVerificationToken', ['TokenValue']],
  ['AWS::IVS::StreamKey', ['Value']],
]);

/**
 * Why an argv element must not be resolved because it reads a SECRET from
 * state, or `undefined` when it reads none. State records some secrets in
 * plaintext (`AWS::IAM::AccessKey`'s `SecretAccessKey`, an AppSync API key,
 * whatever a custom resource returned) and a `NoEcho` custom resource's
 * attribute as the mask; an argv element
 * lands on the `docker run` command line, positional and unredacted, so
 * either one is refused rather than served (issue #961).
 */
function secretAttributeRead(
  element: unknown,
  stateResources: SubstitutionContext['resources']
): string | undefined {
  for (const [logicalId, attribute] of getAttReads(element)) {
    const record = Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
    const recorded = record?.attributes;
    const stored = recorded && Object.hasOwn(recorded, attribute) ? recorded[attribute] : undefined;
    const type = typeof record?.resourceType === 'string' ? record.resourceType : '';
    const typed = SECRET_VALUED_ATTRIBUTES.get(type);
    if (
      (SECRET_ATTRIBUTE_NAME.test(attribute) && !NON_SECRET_ATTRIBUTE_SUFFIX.test(attribute)) ||
      typed?.includes(attribute) === true ||
      // A custom resource can return anything (an `AwsCustomResource` reading a
      // SecureString records the plaintext), and a nested stack's output can
      // pass a secret through: the same classes `deployedFillMayBeSecret`
      // keeps off the argv for Lambda env.
      type.startsWith('Custom::') ||
      type === 'AWS::CloudFormation::CustomResource' ||
      (type === 'AWS::CloudFormation::Stack' && attribute.startsWith('Outputs.')) ||
      stored === STATE_SECRET_MASK
    ) {
      return (
        `reads ${displayIdent(logicalId)}.${displayIdent(attribute)}, an attribute that is or may be a secret, which ` +
        `${getEmbedConfig().binaryName} will not put on the docker run command line; ` +
        'pass the value through Environment or Secrets instead'
      );
    }
  }
  return undefined;
}

/**
 * Every `[logicalId, attribute]` an intrinsic reads through `Fn::GetAtt`
 * (array or dotted-string form) or a `${LogicalId.Attribute}` placeholder of
 * `Fn::Sub`, at any depth.
 */
function getAttReads(node: unknown, out: [string, string][] = []): [string, string][] {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) getAttReads(item, out);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'Fn::GetAtt') {
      if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string') {
        out.push([value[0], value[1]]);
      } else if (typeof value === 'string' && value.includes('.')) {
        const dot = value.indexOf('.');
        out.push([value.slice(0, dot), value.slice(dot + 1)]);
      }
    } else if (key === 'Fn::Sub') {
      const template = Array.isArray(value) ? value[0] : value;
      if (typeof template === 'string') {
        for (const m of template.matchAll(/\$\{([^}!][^}]*)\}/g)) {
          const ref = m[1]!.trim();
          const dot = ref.indexOf('.');
          if (dot > 0 && !ref.startsWith('AWS::')) {
            out.push([ref.slice(0, dot), ref.slice(dot + 1)]);
          }
        }
      }
    }
    getAttReads(value, out);
  }
  return out;
}

/**
 * Why an argv element must not go through the cross-stack post-pass because a
 * `Fn::GetAtt` logical ID / attribute name or a `Fn::Sub` template is itself
 * built from an `Fn::ImportValue` / `Fn::GetStackOutput`, or `undefined`.
 * {@link substituteAgainstStateAsync} substitutes a nested cross-stack value
 * BEFORE the sync pass, so such an element would read whichever same-stack
 * attribute the export names, past {@link secretAttributeRead}, which sees
 * only literal reads. CloudFormation refuses both shapes (issue #967).
 */
function computedAttributeRead(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = computedAttributeRead(item);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'Fn::GetAtt' && isCrossStackIntrinsic(value)) {
      return (
        'a Fn::GetAtt whose logical ID or attribute name is a cross-stack reference, ' +
        'which CloudFormation does not accept'
      );
    }
    if (key === 'Fn::Sub') {
      const template = Array.isArray(value) ? value[0] : value;
      if (isCrossStackIntrinsic(template)) {
        return 'a Fn::Sub whose template is a cross-stack reference, which CloudFormation does not accept';
      }
    }
    const r = computedAttributeRead(value);
    if (r !== undefined) return r;
  }
  return undefined;
}

/**
 * `context` with its cross-stack resolver noting, on `masked`, any value it
 * answers that is the secret mask. A producer value recorded as the mask can
 * be joined into a longer string (`--token=***`), which {@link argvValue}'s
 * whole-value check cannot see (issue #967).
 */
function withMaskWatch(
  context: SubstitutionContext,
  masked: { hit: boolean }
): SubstitutionContext {
  const inner = context.crossStackResolver;
  if (!inner) return context;
  const watch = (v: string | undefined): string | undefined => {
    if (v === STATE_SECRET_MASK) masked.hit = true;
    return v;
  };
  return {
    ...context,
    crossStackResolver: {
      resolveImport: async (exportName) => watch(await inner.resolveImport(exportName)),
      resolveGetStackOutput: async (stack, region, output) =>
        watch(await inner.resolveGetStackOutput(stack, region, output)),
    },
  };
}

const CROSS_STACK_ARGV_REASON =
  'a cross-stack reference (Fn::ImportValue / Fn::GetStackOutput): it resolves only from a state source ' +
  'with the producer stack deployed';

/**
 * The argv string for a substitution result, or why it cannot be one. A
 * value built from a SecureString parameter, or one carrying a
 * `{{resolve:...}}` dynamic reference, is refused: an argv element lands on
 * the `docker run` command line, where any local process can read it, and
 * passing the token instead would run a different command (issue #961).
 */
function argvValue(
  sub: StateSubstitutionResult,
  consumedSensitive: boolean
): { value: string } | { reason: string } {
  // Sensitivity first: an unresolved reason can quote a value built from a
  // SecureString (an export name `x-${SecureParam}` that no stack exports),
  // and the reason is printed when the run is refused.
  if (consumedSensitive) {
    return {
      reason:
        'resolved from a SecureString parameter, which would put the secret on the docker run argv; ' +
        'move the value into an Environment variable or a Secrets entry',
    };
  }
  if (sub.kind !== 'literal') return { reason: sub.reason };
  const value = sub.value;
  if (typeof value === 'number' || typeof value === 'boolean') return { value: String(value) };
  if (value === STATE_SECRET_MASK) {
    // A masked value handed across (an exports index persisting a NoEcho
    // output) would run the command with `***` as an argument.
    return { reason: 'resolved to the secret mask (***), not the deployed value' };
  }
  if (containsDynamicReference(value)) {
    return {
      reason:
        'resolved to a CloudFormation dynamic reference ({{resolve:...}}), which is resolved only in Environment, ' +
        'because resolving one here would put the secret on the docker run argv; ' +
        'move the value into an Environment variable or a Secrets entry',
    };
  }
  return { value };
}

/**
 * Refuse the run when any container argv element (`Command` / `EntryPoint` /
 * `HealthCheck.Command`) is still unresolved after the sync pass and the
 * cross-stack post-pass: running without it runs a different command than
 * the deployed task (issue #961). Every element of every container is named,
 * so one run reports them all.
 *
 * Host-side use case: a host that resolves a task / service itself and runs
 * it through `runEcsTask` calls this before any credential or container work;
 * the runner also refuses such a task before it touches docker.
 */
export function assertEcsTaskCommandsResolved(
  task: Pick<ResolvedEcsTask, 'containers' | 'taskDefinitionLogicalId'>
): void {
  const lines: string[] = [];
  for (const container of task.containers) {
    for (const u of container.unresolvedCommandElements ?? []) {
      lines.push(
        `  - Container ${displayIdent(container.name)} ${u.field}[${u.index}]: ${u.reason}`
      );
    }
  }
  if (lines.length === 0) return;
  throw new EcsTaskResolutionError(
    `Task ${displayIdent(task.taskDefinitionLogicalId)} has container command elements ` +
      `${getEmbedConfig().binaryName} could not resolve:\n${lines.join('\n')}\n` +
      'Refusing to run the task with these arguments missing, since that runs a different command ' +
      'than the deployed task.'
  );
}

/**
 * Map the ECS image-resolution context's `stateResources` +
 * `pseudoParameters` into the shape `substituteAgainstState` expects
 * (closes #291). Returns `undefined` when state has not been loaded —
 * the caller falls back to the pre-PR literal-only path.
 */
function buildSubstitutionContextFromImageContext(
  context: EcsImageResolutionContext | undefined
): SubstitutionContext | undefined {
  if (!context?.stateResources) return undefined;
  const subContext: SubstitutionContext = { resources: context.stateResources };
  if (context.pseudoParameters) {
    subContext.pseudoParameters = { ...context.pseudoParameters };
  }
  if (context.stateParameters) {
    subContext.parameters = { ...context.stateParameters };
  }
  if (context.stateSensitiveParameters?.length) {
    subContext.sensitiveParameters = new Set(context.stateSensitiveParameters);
  }
  return subContext;
}

/**
 * Parse the `Image` field of an ECS container definition.
 *
 * Three shapes:
 *   - `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` — ECR, in any
 *     host form `ECR_REGISTRY_HOST_FORMS` lists (FIPS / dual-stack too) and any
 *     partition. Pulled through `pullEcrImage` (cross-account / cross-region
 *     below).
 *   - `Fn::Sub` / `Fn::Join` / `Ref` referencing a `Code.fromAsset`-style
 *     CDK asset image. Surfaces `kind: 'cdk-asset'` with the optional
 *     asset hash so the runner can route through `docker-build.ts`.
 *   - Any other public URI (`public.ecr.aws/...`, `docker.io/...`,
 *     `nginx:latest`, etc.) — `kind: 'public'`, runner does a `docker pull`.
 *
 * Two-tier substitution (issue #264):
 *   - **Tier 1** — when `context.pseudoParameters` is populated, AWS pseudo
 *     parameters in `Fn::Sub` bodies (`${AWS::AccountId}` / `${AWS::Region}` /
 *     `${AWS::Partition}` / `${AWS::URLSuffix}`) are substituted before
 *     regex matching. The CLI resolves these via STS + region env once
 *     per invocation.
 *   - **Tier 2** — when `context.stateResources` is populated
 *     (`--from-state`), `${<LogicalId>}` placeholders that resolve to an
 *     `AWS::ECR::Repository` are substituted with the state-recorded
 *     `physicalId`, and `Fn::GetAtt: [<Repo>, 'RepositoryUri']` shapes
 *     are resolved via the same state record.
 *
 * Cross-account / cross-region pull (#455): `pullEcrImage` auto-detects
 * cross-account from `sts:GetCallerIdentity` and authenticates against
 * the URI's region directly. Pass `--ecr-role-arn <arn>` when the caller
 * does not already have cross-account `ecr:GetAuthorizationToken` /
 * `ecr:BatchGetImage` access on the target repository.
 */
function parseContainerImage(
  raw: unknown,
  containerName: string,
  taskLogicalId: string,
  resources: Record<string, TemplateResource>,
  _stack: StackInfo,
  context?: EcsImageResolutionContext
): ResolvedEcsImage {
  // Tier 2: handle `Fn::GetAtt: [<Repo>, 'RepositoryUri']` directly — it
  // produces a complete `<acct>.dkr.ecr.<region>.amazonaws.com/<name>` URI
  // we can match against the ECR regex below. The tag is whatever the
  // template provides; for the bare GetAtt shape there is none, which is
  // unusual but we surface the resulting tagless URI rather than guess.
  const getAttImage = tryResolveImageGetAtt(raw, resources, context);
  if (getAttImage?.kind === 'resolved') {
    return classifyResolvedImage(getAttImage.uri);
  }
  if (getAttImage?.kind === 'needs-state') {
    return sameStackEcrImage(containerName, taskLogicalId, getAttImage.repoLogicalId, context);
  }

  // Issue #271: CDK 2.x synthesizes `ContainerImage.fromEcrRepository(repo)`
  // as a `Fn::Join` that builds the ECR URI from nested `Fn::Select` /
  // `Fn::Split` over the repository's `Arn` GetAtt plus a `Ref` to the
  // repo and `Ref: AWS::URLSuffix`. The repository's account-id and
  // region are only available from deployed-stack state (recorded at
  // deploy time), so this shape inherently requires loading state via
  // `--from-cfn-stack` (Tier 2).
  const joinResolved = tryResolveImageFnJoin(raw, resources, context);
  if (joinResolved.kind === 'resolved') {
    return classifyResolvedImage(joinResolved.uri);
  }
  if (joinResolved.kind === 'needs-state') {
    return sameStackEcrImage(
      containerName,
      taskLogicalId,
      joinResolved.repoLogicalId,
      context,
      ' via Fn::Join'
    );
  }
  if (joinResolved.kind === 'unsupported-join') {
    throw new EcsTaskResolutionError(
      `Container ${displayIdent(containerName)} in task ${displayIdent(taskLogicalId)} has an unsupported Fn::Join Image shape: ${joinResolved.reason}. ` +
        `${getEmbedConfig().cliName} recognizes the canonical CDK 2.x ContainerImage.fromEcrRepository Fn::Join shape ` +
        '(delimiter "" with nested Fn::Select/Fn::Split over an ECR Repository Arn GetAtt + Ref to the repo).'
    );
  }

  const flat = extractImageString(raw);
  if (!flat) {
    throw new EcsTaskResolutionError(
      `Container ${displayIdent(containerName)} in task ${displayIdent(taskLogicalId)} has an unparseable Image property. ` +
        `${getEmbedConfig().cliName} supports flat string images, single-key Fn::Sub bodies, and CDK-asset Image references.`
    );
  }

  // CDK asset shape: contains the bootstrap-assets repo placeholder. The
  // tail `:<hash>` is the asset hash (same shape used by Lambda container
  // images — see `getDockerImageBySourceHash`).
  if (flat.includes('cdk-hnb659fds-container-assets-')) {
    const hashMatch = /:([a-f0-9]{8,})$/.exec(flat);
    const out: ResolvedEcsImage = { kind: 'cdk-asset' };
    if (hashMatch) out.assetHash = hashMatch[1]!;
    return out;
  }

  // Substitute pseudo parameters + same-stack ECR Ref placeholders into
  // the flat string when context is supplied. Pure string-rewrite —
  // unresolved placeholders pass through verbatim so the post-walk
  // diagnostics below can route to the precise error message.
  const substituted = substituteImagePlaceholders(flat, resources, context);

  // Unresolved `${...}` placeholders survived substitution. Surface a
  // precise hint BEFORE the ECR regex match — otherwise a leftover
  // `${MyRepo}` in the path portion would still match the host-portion
  // regex and silently produce a broken URI for `docker pull` to fail on.
  if (substituted.includes('${')) {
    const unresolvedRepoRef = findUnresolvedEcrRepositoryRef(substituted, resources);
    if (unresolvedRepoRef) {
      return sameStackEcrImage(containerName, taskLogicalId, unresolvedRepoRef, context);
    }
    if (substituted.includes('AWS::')) {
      throw new EcsTaskResolutionError(
        `Container ${displayIdent(containerName)} in task ${displayIdent(taskLogicalId)} has an Image that references AWS pseudo parameters (${displayUntrustedValue(substituted)}). ` +
          `${getEmbedConfig().productName} could not resolve them: confirm AWS credentials are configured so STS GetCallerIdentity succeeds, ` +
          'and that --region / AWS_REGION names the target region. ' +
          'Workaround: build the image locally (ContainerImage.fromAsset) or pin a public image.'
      );
    }
    // Some other placeholder survived (e.g. a Parameter ref). Surface as
    // a generic resolver failure rather than letting it slip through as
    // a "public" image.
    throw new EcsTaskResolutionError(
      `Container ${displayIdent(containerName)} in task ${displayIdent(taskLogicalId)} has an Image with unresolved \${...} placeholders (${displayUntrustedValue(substituted)}). ` +
        `${getEmbedConfig().cliName} only resolves AWS pseudo parameters and same-stack AWS::ECR::Repository refs.`
    );
  }

  // Account-scoped ECR repo, in any of the host forms AWS serves (plain /
  // FIPS / dual-stack / dual-stack FIPS) and any partition (issue #760).
  const ecrHost = parseEcrRegistryHost(substituted);
  if (ecrHost) {
    return { kind: 'ecr', uri: substituted, account: ecrHost.accountId, region: ecrHost.region };
  }

  return { kind: 'public', uri: substituted };
}

/**
 * Issue #847 — the image for a same-stack ECR repository the resolver cannot
 * turn into a URI. Returned rather than thrown so `--image-override` can
 * replace it; {@link assertEcsTaskImagesResolvable} raises `unresolvedReason`
 * for a container no override covers.
 */
function sameStackEcrImage(
  containerName: string,
  taskLogicalId: string,
  repoLogicalId: string,
  context: EcsImageResolutionContext | undefined,
  via = ''
): ResolvedEcsImage {
  return {
    kind: 'same-stack-ecr',
    repoLogicalId,
    unresolvedReason:
      `Container ${displayIdent(containerName)} in task ${displayIdent(taskLogicalId)} references same-stack ECR repository ${displayIdent(repoLogicalId)}${via}. ` +
      `${getEmbedConfig().cliName} cannot resolve the repository URI without state — ` +
      formatStateRemedy(context) +
      ', build via ContainerImage.fromAsset, pin a public image, or pass --image-override to build it from a local Dockerfile.',
  };
}

/**
 * When the flat string still contains `${X}` after substitution, check
 * whether `X` (or `X.<attr>`) names a same-stack `AWS::ECR::Repository`.
 * Returns the logical ID of the offending repo for a precise error
 * message; `undefined` otherwise.
 */
function findUnresolvedEcrRepositoryRef(
  substituted: string,
  resources: Record<string, TemplateResource>
): string | undefined {
  const placeholderRegex = /\$\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = placeholderRegex.exec(substituted)) !== null) {
    const key = m[1]!;
    if (key.startsWith('AWS::')) continue;
    const dot = key.indexOf('.');
    const lid = dot === -1 ? key : key.slice(0, dot);
    if (resources[lid]?.Type === 'AWS::ECR::Repository') return lid;
  }
  return undefined;
}

/**
 * Classify a fully-substituted image URI (Tier 1 / Tier 2 produced a
 * concrete string) into the `ResolvedEcsImage` shape. Splits out so the
 * `Fn::GetAtt` path can share the regex-match branches.
 */
function classifyResolvedImage(uri: string): ResolvedEcsImage {
  if (uri.includes('cdk-hnb659fds-container-assets-')) {
    const hashMatch = /:([a-f0-9]{8,})$/.exec(uri);
    const out: ResolvedEcsImage = { kind: 'cdk-asset' };
    if (hashMatch) out.assetHash = hashMatch[1]!;
    return out;
  }
  const ecrHost = parseEcrRegistryHost(uri);
  if (ecrHost) {
    return { kind: 'ecr', uri, account: ecrHost.accountId, region: ecrHost.region };
  }
  return { kind: 'public', uri };
}

/**
 * Handle the discrete `Fn::GetAtt: [<Repo>, 'RepositoryUri']` /
 * `'<Repo>.RepositoryUri'` shape against state-recorded resources. CDK
 * occasionally emits this instead of `Fn::Sub` when the user writes
 * `ContainerImage.fromEcrRepository(repo, tag)` and the tag is a literal.
 * Returns the resolved URI string on hit, `undefined` on miss (the caller
 * falls through to `extractImageString` for `Fn::Sub` / `Fn::Join` / `Ref`).
 */
function tryResolveImageGetAtt(
  raw: unknown,
  resources: Record<string, TemplateResource>,
  context: EcsImageResolutionContext | undefined
): { kind: 'resolved'; uri: string } | { kind: 'needs-state'; repoLogicalId: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const arg = obj['Fn::GetAtt'];
  if (arg === undefined) return undefined;

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

  const refResource = resources[logicalId];
  if (refResource?.Type !== 'AWS::ECR::Repository') return undefined;
  if (attr !== 'RepositoryUri' && attr !== 'Arn') return undefined;

  const cached = context?.stateResources?.[logicalId]?.attributes?.[attr];
  if (typeof cached === 'string' && cached.length > 0) return { kind: 'resolved', uri: cached };
  // Issue #847 — a `RepositoryUri` GetAtt with no state-recorded value is the
  // same unresolvable same-stack pin as the `Fn::Join` shape. (`Arn` is not an
  // image URI, so it keeps falling through to the unparseable-Image error.)
  if (attr === 'RepositoryUri') return { kind: 'needs-state', repoLogicalId: logicalId };
  return undefined;
}

function extractImageString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sub = obj['Fn::Sub'];
    if (typeof sub === 'string' && sub.length > 0) return sub;
    if (Array.isArray(sub) && typeof sub[0] === 'string') return sub[0];
    const join = obj['Fn::Join'];
    if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
      const sep = typeof join[0] === 'string' ? join[0] : '';
      const parts = (join[1] as unknown[])
        .map((p) => (typeof p === 'string' ? p : extractImageString(p)))
        .filter((p): p is string => p !== undefined);
      if (parts.length === (join[1] as unknown[]).length) return parts.join(sep);
    }
  }
  return undefined;
}

// `tryResolveImageFnJoin` (plus supporting helpers `findEcrRepositoryRefInTree` /
// `resolveImageIntrinsic` / `resolveImageIntrinsicAny`) and the
// `FnJoinResolveOutcome` type were extracted to `intrinsic-image.ts` so
// `lambda-resolver.ts` can reuse them for container Lambdas (`Code.ImageUri`).
// Both call sites import the shared helper at the top of their respective
// resolver. See issue #286 Gap 2 and PR #280 for the original ECS shape.

function parseVolume(
  raw: unknown,
  idx: number,
  taskLogicalId: string,
  subContext?: SubstitutionContext
): ResolvedEcsVolume {
  if (!raw || typeof raw !== 'object') {
    throw new EcsTaskResolutionError(
      `Task ${displayIdent(taskLogicalId)} Volumes[${idx}] is not an object.`
    );
  }
  const v = raw as Record<string, unknown>;
  const name = pickString(v['Name']);
  if (!name) {
    throw new EcsTaskResolutionError(
      `Task ${displayIdent(taskLogicalId)} Volumes[${idx}] has no Name.`
    );
  }

  if (v['EFSVolumeConfiguration']) {
    throw new EcsTaskResolutionError(
      `Task ${displayIdent(taskLogicalId)} Volumes[${idx}] ${displayIdent(name)} uses EFSVolumeConfiguration, which ${getEmbedConfig().cliName} cannot proxy locally. ` +
        `Workaround: bind-mount a local directory at the same containerPath via Host: { SourcePath: '<local-path>' }, or override at runtime via --env-vars semantics for a Phase 2 follow-up.`
    );
  }
  if (v['FSxWindowsFileServerVolumeConfiguration']) {
    throw new EcsTaskResolutionError(
      `Task ${displayIdent(taskLogicalId)} Volumes[${idx}] ${displayIdent(name)} uses FSxWindowsFileServerVolumeConfiguration, which ${getEmbedConfig().cliName} cannot proxy locally.`
    );
  }

  const dockerCfg = v['DockerVolumeConfiguration'];
  if (dockerCfg && typeof dockerCfg === 'object') {
    const d = dockerCfg as Record<string, unknown>;
    const scope = pickString(d['Scope']) === 'shared' ? 'shared' : 'task';
    const cfg: ResolvedEcsVolume['dockerVolumeConfig'] = { scope };
    if (typeof d['Autoprovision'] === 'boolean') cfg.autoprovision = d['Autoprovision'];
    const driver = pickString(d['Driver']);
    if (driver) cfg.driver = driver;
    if (d['DriverOpts'] && typeof d['DriverOpts'] === 'object') {
      const opts: Record<string, string> = {};
      for (const [k, val] of Object.entries(d['DriverOpts'] as Record<string, unknown>)) {
        if (typeof val === 'string') opts[k] = val;
      }
      cfg.driverOpts = opts;
    }
    if (d['Labels'] && typeof d['Labels'] === 'object') {
      const labels: Record<string, string> = {};
      for (const [k, val] of Object.entries(d['Labels'] as Record<string, unknown>)) {
        if (typeof val === 'string') labels[k] = val;
      }
      cfg.labels = labels;
    }
    return { name, kind: 'docker', dockerVolumeConfig: cfg };
  }

  // Host bind mount (or anonymous when SourcePath unset).
  // SourcePath may be a flat string OR a CFn intrinsic (`Fn::Sub` /
  // `Fn::Join` / `Ref`) — CDK emits the intrinsic shape when the user
  // builds the path via `cdk.Fn.sub(...)` / `cdk.Fn.join(...)` (verified
  // via real `cdk synth` against `new ecs.Ec2TaskDefinition({ volumes:
  // [{ name, host: { sourcePath: cdk.Fn.sub('...') } }] })`). When state
  // + pseudo parameters are available (`--from-state` flow on
  // `cdkl run-task` already populates the context for env / secret
  // / image resolution), we substitute the intrinsic in place via the
  // same `substituteAgainstState` helper. Unresolvable intrinsics
  // hard-error — a Host bind mount with a missing path is not safe to
  // proxy as an anonymous volume (the container would silently see an
  // empty mount instead of the data it expects). Closes Gap 6 of #286.
  const host = v['Host'];
  if (host && typeof host === 'object') {
    const rawSourcePath = (host as Record<string, unknown>)['SourcePath'];
    const sourcePath = resolveVolumeSourcePath(rawSourcePath, name, idx, taskLogicalId, subContext);
    if (sourcePath !== undefined) {
      const abs = isAbsolute(sourcePath) ? sourcePath : resolve(process.cwd(), sourcePath);
      return { name, kind: 'host', hostPath: abs };
    }
  }
  return { name, kind: 'host' };
}

/**
 * Resolve a volume `Host.SourcePath` value to a flat host-path string.
 * Handles flat strings (pre-PR behavior) and the CFn intrinsic shapes
 * (`Fn::Sub` / `Fn::Join` / `Ref` / `Fn::GetAtt`) that CDK emits when
 * the user builds the path via `cdk.Fn.sub(...)` / `cdk.Fn.join(...)`.
 * Returns `undefined` when the field is absent or empty (anonymous
 * volume — the legacy path); throws `EcsTaskResolutionError` when the
 * intrinsic cannot be resolved against the supplied context.
 *
 * The hard-error on unresolvable intrinsics matches the upstream
 * pre-Gap-6 behavior (which silently dropped the SourcePath and produced
 * an anonymous volume) only on the failure mode — but now with a precise
 * actionable message instead of mysteriously empty mounts at runtime.
 */
function resolveVolumeSourcePath(
  raw: unknown,
  volumeName: string,
  idx: number,
  taskLogicalId: string,
  subContext: SubstitutionContext | undefined
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
  if (typeof raw !== 'object') {
    throw new EcsTaskResolutionError(
      `Task ${displayIdent(taskLogicalId)} Volumes[${idx}] ${displayIdent(volumeName)} Host.SourcePath must be a string or a CFn intrinsic, got ${typeof raw}.`
    );
  }
  if (!subContext) {
    throw new EcsTaskResolutionError(
      `Task ${displayIdent(taskLogicalId)} Volumes[${idx}] ${displayIdent(volumeName)} Host.SourcePath is a CFn intrinsic (Ref/Fn::Sub/Fn::Join/Fn::GetAtt). ` +
        `Pass --from-state to substitute it against the deployed state + AWS pseudo parameters.`
    );
  }
  const sub = substituteAgainstState(raw, subContext);
  if (sub.kind === 'literal' && typeof sub.value === 'string' && sub.value.length > 0) {
    return sub.value;
  }
  throw new EcsTaskResolutionError(
    `Task ${displayIdent(taskLogicalId)} Volumes[${idx}] ${displayIdent(volumeName)} Host.SourcePath could not be resolved: ` +
      (sub.kind === 'literal' ? 'resolved to non-string / empty value' : sub.reason)
  );
}

/**
 * Synth-time placeholder marker used in the account-id segment of an ARN
 * when the role's account cannot be known statically (the role is defined
 * inline as an `AWS::IAM::Role` in the same stack). The CLI replaces this
 * with the live account via STS `GetCallerIdentity` lazily — only when
 * `--assume-task-role` is used in its bare form and the resolved ARN
 * still contains this marker.
 */
export const TASK_ROLE_ACCOUNT_PLACEHOLDER = '${AWS::AccountId}';

/**
 * The partition segment's placeholder in the same ARN (go-to-k/cdkd#6223): the
 * CLI fills it in from the same `GetCallerIdentity` answer, whose ARN carries
 * the partition, so an `aws-cn` / `aws-us-gov` role is not named `arn:aws:`.
 */
export const TASK_ROLE_PARTITION_PLACEHOLDER = '${AWS::Partition}';

/** `arn:${partition}:iam::${account}:role<path><name>`, both placeholders unfilled. */
function placeholderRoleArn(pathAndName: string): string {
  return `arn:${TASK_ROLE_PARTITION_PLACEHOLDER}:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role${pathAndName}`;
}

/**
 * Fill a task-role ARN's placeholders from the caller's `GetCallerIdentity`
 * answer: the account, and the partition read off the caller's own ARN (`aws`
 * when it has none).
 */
export function fillTaskRolePlaceholders(
  arn: string,
  account: string,
  callerArn: string | undefined
): string {
  const segment = callerArn?.split(':')[1];
  const partition = callerArn?.startsWith('arn:') && segment ? segment : 'aws';
  return arn
    .split(TASK_ROLE_ACCOUNT_PLACEHOLDER)
    .join(account)
    .split(TASK_ROLE_PARTITION_PLACEHOLDER)
    .join(partition);
}

/** Whether `arn` still carries a placeholder only `GetCallerIdentity` can fill. */
export function hasTaskRolePlaceholder(arn: string): boolean {
  return (
    arn.includes(TASK_ROLE_ACCOUNT_PLACEHOLDER) || arn.includes(TASK_ROLE_PARTITION_PLACEHOLDER)
  );
}

/**
 * The logical id of the same-stack `AWS::IAM::Role` a role-ARN value points
 * at (`Ref` or `Fn::GetAtt [<LogicalId>, 'Arn']`), or `undefined` when the
 * value is any other shape or names no `AWS::IAM::Role` in `resources`.
 */
export function sameStackRoleLogicalId(
  value: unknown,
  resources: Record<string, TemplateResource>
): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  let refLogicalId: string | undefined;
  if ('Ref' in obj && typeof obj['Ref'] === 'string') {
    refLogicalId = obj['Ref'];
  } else if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') {
      // Accept `[<LogicalId>, 'Arn']`; other attribute names (rare on IAM
      // Role refs) fall through to undefined since the ARN we emit is always
      // the role ARN shape.
      const attr = typeof arg[1] === 'string' ? arg[1] : '';
      if (attr === '' || attr === 'Arn') refLogicalId = arg[0];
    }
  }
  if (refLogicalId === undefined) return undefined;
  return resources[refLogicalId]?.Type === 'AWS::IAM::Role' ? refLogicalId : undefined;
}

/**
 * Why a same-stack role's ARN is the placeholder built from its LOGICAL id
 * rather than its deployed name (go-to-k/cdkd#6223):
 *
 * - `no-state` — no state record was read for the lookup.
 * - `no-record` — the record has no entry for the role (or one carrying
 *   neither an `Arn` nor a physical id).
 * - `path-not-literal` — the record holds only the role's name
 *   (`--from-cfn-stack`) and the template's `Path` is not a literal IAM path,
 *   so the ARN cannot be built from it.
 */
export type TaskRoleUnresolvedReason = 'no-state' | 'no-record' | 'path-not-literal';

/** A resolved role ARN plus, for the logical-id placeholder, why it was used. */
interface RoleArnResolution {
  arn?: string;
  unresolved?: { logicalId: string; reason: TaskRoleUnresolvedReason };
}

/**
 * The deployed ARN of a same-stack role, read from the state source's record
 * of it (go-to-k/cdkd#6223). A role CDK creates without `roleName` is
 * deployed as `<Stack>-<LogicalId>-<suffix>`, so only the record knows it.
 *
 *   - A record carrying the role's `Arn` attribute (cdkd's `--from-state`):
 *     returned verbatim.
 *   - A record with only the physical id (`--from-cfn-stack`), which for an
 *     `AWS::IAM::Role` is the role NAME: the ARN is built from it plus the
 *     template's `Path` (absent means `/`; anything but a literal IAM path is
 *     refused, as the ARN would name another role), with the partition and
 *     account left as the placeholders the CLI fills in.
 */
function roleArnFromStateRecord(
  logicalId: string,
  role: TemplateResource,
  subContext: SubstitutionContext | undefined
): { arn: string } | { reason: TaskRoleUnresolvedReason } {
  if (!subContext) return { reason: 'no-state' };
  const record = subContext.resources[logicalId];
  if (!record) return { reason: 'no-record' };
  const arn = record.attributes?.['Arn'];
  if (typeof arn === 'string' && arn.length > 0) return { arn };
  const name = record.physicalId;
  if (typeof name !== 'string' || name.length === 0) return { reason: 'no-record' };
  if (name.startsWith('arn:')) return { arn: name };
  const rawPath = role.Properties?.['Path'];
  if (rawPath === undefined) return { arn: placeholderRoleArn(`/${name}`) };
  // IAM paths start and end with `/`.
  if (typeof rawPath !== 'string' || !/^\/(?:.*\/)?$/.test(rawPath)) {
    return { reason: 'path-not-literal' };
  }
  return { arn: placeholderRoleArn(`${rawPath}${name}`) };
}

/**
 * Resolve a Task / Execution role ARN reference. Accepts:
 *
 *   - A flat string ARN — returned verbatim.
 *   - `Ref` / `Fn::GetAtt[..., 'Arn']` against an `AWS::IAM::Role` in
 *     the same stack — with a state source whose record holds the role, its
 *     DEPLOYED ARN (go-to-k/cdkd#6223, see `roleArnFromStateRecord`);
 *     otherwise a synth-time placeholder ARN of the shape
 *     `arn:${AWS::Partition}:iam::${AWS::AccountId}:role/<RoleLogicalId>`,
 *     which names the deployed role only when its name IS the logical id
 *     (`unresolved` says why it was used). The CLI fills the placeholders in
 *     lazily via STS when the bare `--assume-task-role` form is used.
 *   - `Fn::Join` / `Fn::Sub` — when the supplied substitution context
 *     can resolve every nested intrinsic to a literal (state + pseudo
 *     parameters via `--from-state` flow), the resulting flat ARN is
 *     returned. This covers the rare `iam.Role.fromRoleArn(scope, id,
 *     cdk.Fn.join(...))` pattern verified via real `cdk synth` on
 *     2026-05-12 against `iam.Role.fromRoleArn(stack, 'X', Fn.join(':',
 *     ['arn','aws','iam','',cdk.Aws.ACCOUNT_ID,'role/Name']))`.
 *     Closes Gap 5 of #286.
 *
 * The `arn` is `undefined` when the reference cannot be resolved (logical id
 * missing, non-IAM-Role target, unsupported intrinsic shape, or
 * intrinsic shape whose nested refs cannot be resolved without
 * `--from-state`).
 */
function resolveRoleArn(
  value: unknown,
  resources: Record<string, TemplateResource>,
  subContext?: SubstitutionContext
): RoleArnResolution {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') return { arn: value };
  if (typeof value !== 'object') return {};
  const obj = value as Record<string, unknown>;

  const refLogicalId = sameStackRoleLogicalId(value, resources);
  if (refLogicalId !== undefined) {
    const fromState = roleArnFromStateRecord(refLogicalId, resources[refLogicalId]!, subContext);
    if ('arn' in fromState) return { arn: fromState.arn };
    return {
      arn: placeholderRoleArn(`/${refLogicalId}`),
      unresolved: { logicalId: refLogicalId, reason: fromState.reason },
    };
  }
  if ('Ref' in obj || 'Fn::GetAtt' in obj) return {};

  // `Fn::Join` / `Fn::Sub` — `iam.Role.fromRoleArn(stack, id,
  // cdk.Fn.join(...))` shape. Resolve via state + pseudo parameters if
  // available; fall back to undefined (silent-drop, pre-PR behavior)
  // when the context can't fully resolve the intrinsic — same posture
  // as the existing Ref-to-missing-resource path.
  if ('Fn::Join' in obj || 'Fn::Sub' in obj) {
    if (!subContext) return {};
    const sub = substituteAgainstState(value, subContext);
    if (sub.kind === 'literal' && typeof sub.value === 'string' && sub.value.length > 0) {
      return { arn: sub.value };
    }
    return {};
  }

  return {};
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

function notFoundError(
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): EcsTaskResolutionError {
  const tasks: { displayPath: string; logicalId: string }[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::ECS::TaskDefinition') continue;
    const meta = resource.Metadata;
    const cdkPath = typeof meta?.['aws:cdk:path'] === 'string' ? meta['aws:cdk:path'] : '';
    tasks.push({ displayPath: cdkPath || logicalId, logicalId });
  }
  let msg = `target '${target}' did not match any ECS task definition in ${stack.stackName}.\n\n`;
  if (tasks.length === 0) {
    msg += `Stack ${stack.stackName} has no AWS::ECS::TaskDefinition resources.`;
  } else {
    const width = Math.max(...tasks.map((t) => t.displayPath.length));
    msg += `Available task definitions in ${stack.stackName}:\n`;
    for (const t of tasks) {
      msg += `  ${t.displayPath.padEnd(width)}  (${displayIdent(t.logicalId)})\n`;
    }
  }
  return new EcsTaskResolutionError(msg.trimEnd());
}

/**
 * Resolve a `kind: 'cdk-asset'` Image entry back to the on-disk build
 * context recorded in the stack's asset manifest. Surfaces an absolute
 * path to the cdk.out asset directory + the dockerfile name so the
 * runner can hand the pair to `buildDockerImage` directly. Returns
 * `undefined` when the asset isn't in the manifest — the caller hard-
 * errors with a clear "re-synthesize" pointer.
 */
export function buildCdkOutDir(stack: StackInfo): string | undefined {
  if (!stack.assetManifestPath) return undefined;
  return dirname(stack.assetManifestPath);
}

/**
 * Verify that a directory referenced by a docker-volume `Host.SourcePath`
 * actually exists. Surfaced as a warning rather than a hard error so
 * users can bind-mount future-created paths.
 */
export function checkVolumeHostPath(hostPath: string): boolean {
  try {
    return existsSync(hostPath) && statSync(hostPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The cross-stack post-pass of `run-task` and `start-service` / `start-alb`:
 * build the substitution context from the image-resolution context, resolve a
 * cross-stack value's `{{resolve:...}}` in its producer's region for the
 * container that consumes it (in AWS Emulator mixed mode, where THAT
 * container's runtime calls go: go-to-k/cdk-local#902), and apply it with
 * {@link applyCrossStackResolverToTask}.
 */
export async function applyCrossStackValuesToTask(
  task: ResolvedEcsTask,
  crossStackResolver: CrossStackResolver,
  opts: {
    imageContext: EcsImageResolutionContext | undefined;
    consumerRegion: string;
    profile?: string | undefined;
  }
): Promise<void> {
  const { imageContext } = opts;
  const dynamicRefs = new DynamicReferenceResolver({
    ...(opts.profile !== undefined && { profile: opts.profile }),
  });
  const subContext: SubstitutionContext = {
    resources: imageContext?.stateResources ?? {},
    ...(imageContext?.pseudoParameters && { pseudoParameters: imageContext.pseudoParameters }),
    ...(imageContext?.stateParameters && { parameters: imageContext.stateParameters }),
    ...(imageContext?.stateSensitiveParameters?.length && {
      sensitiveParameters: new Set(imageContext.stateSensitiveParameters),
    }),
    consumerRegion: opts.consumerRegion,
    crossStackResolver,
    // A cross-stack value carrying a `{{resolve:...}}` token resolves against
    // its producer's region at this boundary (issue #784).
    resolveDynamicReferences: crossStackDynamicReferenceHook(
      dynamicRefs,
      `Task ${task.taskDefinitionLogicalId} cross-stack env value`
    ),
  };
  // Mixed mode: a container with its own routed state resolves its same-stack
  // names against it, every field replaced (#905).
  const containerState = (name: string): ContainerSubstitutionState | undefined => {
    const own = imageContext?.containerStates;
    if (!own || !Object.hasOwn(own, name)) return undefined;
    const state = own[name]!;
    return {
      resources: state.stateResources ?? {},
      parameters: state.stateParameters,
      sensitiveParameters: state.stateSensitiveParameters?.length
        ? new Set(state.stateSensitiveParameters)
        : undefined,
    };
  };
  try {
    await applyCrossStackResolverToTask(task, subContext, containerState);
  } finally {
    dynamicRefs.dispose();
  }
}

/** The resolved argv array an unresolved element's placeholder lives in. */
function argvTarget(
  container: ResolvedEcsContainer,
  field: UnresolvedCommandElement['field']
): string[] | undefined {
  if (field === 'Command') return container.command;
  if (field === 'EntryPoint') return container.entryPoint;
  return container.healthCheck?.command;
}

/** The template's raw argv array for `field`. */
function rawArgv(
  c: Record<string, unknown>,
  field: UnresolvedCommandElement['field']
): unknown[] | undefined {
  let raw: unknown;
  if (field === 'Command') raw = c['Command'];
  else if (field === 'EntryPoint') raw = c['EntryPoint'];
  else {
    const h = c['HealthCheck'];
    raw = h && typeof h === 'object' ? (h as Record<string, unknown>)['Command'] : undefined;
  }
  return Array.isArray(raw) ? (raw as unknown[]) : undefined;
}

/** The state fields one container resolves against in mixed mode (#905). */
export interface ContainerSubstitutionState {
  resources: SubstitutionContext['resources'];
  parameters: SubstitutionContext['parameters'] | undefined;
  sensitiveParameters: SubstitutionContext['sensitiveParameters'] | undefined;
}

/** `context` with its state fields REPLACED by `state` (an absent one cleared). */
function withContainerState<T extends Omit<SubstitutionContext, 'resolveDynamicReferences'>>(
  context: T,
  state: ContainerSubstitutionState
): T {
  const out: T = { ...context, resources: state.resources };
  if (state.parameters) out.parameters = state.parameters;
  else delete out.parameters;
  if (state.sensitiveParameters) out.sensitiveParameters = state.sensitiveParameters;
  else delete out.sensitiveParameters;
  return out;
}

/**
 * Async post-pass that walks the resolved task's container Environment +
 * Secrets entries from the raw template (preserved in `task.resource`)
 * and re-attempts substitution via {@link substituteAgainstStateAsync}
 * against the supplied context. The sync `parseContainerDefinition`
 * pass already substituted everything the legacy resolver handles; this
 * pass picks up the additional shapes the async resolver supports —
 * specifically `Fn::ImportValue` / `Fn::GetStackOutput` (issue #454).
 *
 * Resolved entries are patched onto the container's `environment` /
 * `secrets` map AND the corresponding `warnings` entries are filtered
 * out so the CLI doesn't print a stale per-container warn for an entry
 * the post-pass successfully resolved. Entries that STILL can't resolve
 * (e.g. producer stack not deployed) keep their original warning so the
 * CLI's UX matches the sync path.
 *
 * Pure-functional on the task structure outside of in-place mutation of
 * the container's `environment` / `secrets` / `warnings` arrays. The
 * task is expected to be the same `ResolvedEcsTask` instance returned
 * by `resolveEcsTaskTarget` — the runner downstream reads from these
 * fields directly.
 */
export async function applyCrossStackResolverToTask(
  task: ResolvedEcsTask,
  context: SubstitutionContext,
  /**
   * The state fields one container resolves against in place of
   * `context`'s (AWS Emulator mixed mode, #905); `undefined` keeps them.
   */
  containerState?: (containerName: string) => ContainerSubstitutionState | undefined
): Promise<void> {
  if (!context.crossStackResolver) return;
  const { resolveDynamicReferences: _envOnly, ...secretContext } = context;
  const props = task.resource.Properties ?? {};
  const rawContainers = props['ContainerDefinitions'];
  if (!Array.isArray(rawContainers)) return;

  for (let idx = 0; idx < task.containers.length; idx += 1) {
    const container = task.containers[idx]!;
    const raw = rawContainers[idx];
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const containerName = pickString(c['Name']) ?? container.name;
    // Mixed mode: a `{{resolve:...}}` in this container's cross-stack value is
    // fetched where THIS container's runtime calls go, and its same-stack
    // names are the ones its own exceptions read (#905).
    const resolveRefs = context.resolveDynamicReferences;
    const ownState = containerState?.(container.name);
    const baseContext = ownState ? withContainerState(context, ownState) : context;
    const containerContext: SubstitutionContext = resolveRefs
      ? {
          ...baseContext,
          resolveDynamicReferences: (v, region) =>
            resolveRefs(v, region, { containerName: container.name }),
        }
      : baseContext;

    // Track keys the post-pass resolved so we can filter the matching
    // entries out of `container.warnings` (which the sync pass populated
    // with "dropped: <reason>" lines).
    const resolvedEnvKeys = new Set<string>();
    const resolvedSecretNames = new Set<string>();

    // Environment[].Value
    if (Array.isArray(c['Environment'])) {
      for (const entry of c['Environment'] as unknown[]) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const key = pickString(e['Name']);
        const value = e['Value'];
        if (!key) continue;
        // Skip literal values + entries already resolved by the sync
        // pass (present in `container.environment`).
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          continue;
        }
        // `Object.hasOwn`, not `in`: `'__proto__' in {}` is true (#769).
        if (Object.hasOwn(container.environment, key)) continue;
        if (!isCrossStackIntrinsic(value)) {
          // The sync pass already tried this — re-trying here can't
          // produce a different outcome.
          continue;
        }
        const { result: sub, consumedSensitive } = await resolveWithSensitivityAsync(
          value,
          containerContext
        );
        if (sub.kind === 'literal') {
          defineOwnKey(container.environment, key, String(sub.value));
          resolvedEnvKeys.add(key);
          // SecureString-backed value — keep it off the `docker run` argv (#99).
          if (consumedSensitive && !container.sensitiveEnvKeys.includes(key)) {
            container.sensitiveEnvKeys.push(key);
          }
        }
      }
    }

    // Secrets[].ValueFrom
    if (Array.isArray(c['Secrets'])) {
      for (const entry of c['Secrets'] as unknown[]) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const sName = pickString(e['Name']);
        const valueFromRaw = e['ValueFrom'];
        if (!sName) continue;
        if (typeof valueFromRaw === 'string' && valueFromRaw.length > 0) continue;
        if (container.secrets.some((s) => s.name === sName)) continue;
        if (!isCrossStackIntrinsic(valueFromRaw)) continue;
        // A ValueFrom is an ARN, never a value: no dynamic-reference hook, so
        // nothing resolved to plaintext can land where an ARN is echoed (#784).
        const sub = await substituteAgainstStateAsync(
          valueFromRaw,
          ownState ? withContainerState(secretContext, ownState) : secretContext
        );
        if (sub.kind === 'literal' && typeof sub.value === 'string' && sub.value.length > 0) {
          container.secrets.push({ name: sName, valueFrom: sub.value });
          resolvedSecretNames.add(sName);
        }
      }
    }

    // Command / EntryPoint / HealthCheck.Command elements the sync pass left
    // unresolved (issue #961). No dynamic-reference hook, as for Secrets: a
    // plaintext must not land on the `docker run` argv, so an element
    // resolving to a `{{resolve:...}}` token stays unresolved.
    if (container.unresolvedCommandElements?.length) {
      const argvContext = ownState ? withContainerState(secretContext, ownState) : secretContext;
      const remaining: UnresolvedCommandElement[] = [];
      for (const u of container.unresolvedCommandElements) {
        const target = argvTarget(container, u.field);
        const rawElement = rawArgv(c, u.field)?.[u.index];
        if (!target || !isCrossStackIntrinsic(rawElement)) {
          remaining.push(u);
          continue;
        }
        const refusal =
          secretAttributeRead(rawElement, argvContext.resources) ??
          computedAttributeRead(rawElement);
        if (refusal !== undefined) {
          remaining.push({ ...u, reason: refusal });
          continue;
        }
        const masked = { hit: false };
        const { result: sub, consumedSensitive } = await resolveWithSensitivityAsync(
          rawElement,
          withMaskWatch(argvContext, masked)
        );
        const arg = masked.hit
          ? {
              reason: `resolved a cross-stack value recorded as the secret mask (${STATE_SECRET_MASK}), not the deployed value`,
            }
          : argvValue(sub, consumedSensitive);
        if ('value' in arg) {
          target[u.index] = arg.value;
          continue;
        }
        remaining.push({ ...u, reason: arg.reason });
      }
      if (remaining.length > 0) container.unresolvedCommandElements = remaining;
      else delete container.unresolvedCommandElements;
    }

    if (resolvedEnvKeys.size > 0 || resolvedSecretNames.size > 0) {
      container.warnings = container.warnings.filter((w) => {
        for (const k of resolvedEnvKeys) {
          if (w.startsWith(`Environment ${displayIdent(k)} dropped:`)) return false;
        }
        for (const k of resolvedSecretNames) {
          if (w.startsWith(`Secret ${displayIdent(k)} dropped:`)) return false;
        }
        return true;
      });
      // Same filter at the task-level (the per-container warnings are
      // re-emitted onto `task.warnings` by `parseEcsTaskFromCdkResource`,
      // prefixed with `Container <displayIdent(name)>: `).
      task.warnings = task.warnings.filter((w) => {
        for (const k of resolvedEnvKeys) {
          if (
            w.startsWith(
              `Container ${displayIdent(containerName)}: Environment ${displayIdent(k)} dropped:`
            )
          ) {
            return false;
          }
        }
        for (const k of resolvedSecretNames) {
          if (
            w.startsWith(
              `Container ${displayIdent(containerName)}: Secret ${displayIdent(k)} dropped:`
            )
          ) {
            return false;
          }
        }
        return true;
      });
    }
  }
}
