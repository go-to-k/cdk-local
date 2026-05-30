import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';
import {
  derivePseudoParametersFromRegion,
  formatStateRemedy,
  substituteImagePlaceholders,
  tryResolveImageFnJoin,
  type ImageResolutionContext,
} from './intrinsic-image.js';
import { parseTarget, type ParsedTarget } from './lambda-resolver.js';
import { getEmbedConfig } from './embed-config.js';
import { getLogger } from '../utils/logger.js';

/**
 * CloudFormation resource type for a Bedrock AgentCore Runtime.
 * `cdkl invoke-agentcore` resolves and runs these locally.
 */
export const AGENTCORE_RUNTIME_TYPE = 'AWS::BedrockAgentCore::Runtime';

/**
 * AgentCore Runtime protocols `cdkl invoke-agentcore` can serve.
 *
 * - `HTTP` — the agent contract (`POST /invocations` + `GET /ping` on 8080).
 * - `MCP` — Model Context Protocol over Streamable HTTP (`POST /mcp` on 8000).
 * - `A2A` — Agent2Agent JSON-RPC 2.0 over HTTP (`POST /` on 9000).
 * - `AGUI` — Agent-User Interaction event streams (SSE on `POST /invocations`,
 *   WebSocket on `/ws`); reuses the HTTP path's container port (8080) and its
 *   incremental SSE / WS streaming.
 */
export const AGENTCORE_HTTP_PROTOCOL = 'HTTP';
export const AGENTCORE_MCP_PROTOCOL = 'MCP';
export const AGENTCORE_A2A_PROTOCOL = 'A2A';
export const AGENTCORE_AGUI_PROTOCOL = 'AGUI';

/** Protocols this CLI can run a container for. */
const SUPPORTED_AGENTCORE_PROTOCOLS = [
  AGENTCORE_HTTP_PROTOCOL,
  AGENTCORE_MCP_PROTOCOL,
  AGENTCORE_A2A_PROTOCOL,
  AGENTCORE_AGUI_PROTOCOL,
] as const;

/**
 * Result of resolving a `cdkl invoke-agentcore <target>` argument back to a
 * concrete `AWS::BedrockAgentCore::Runtime` in the synthesized assembly.
 *
 * Covers the CONTAINER artifact and the `CodeConfiguration` managed-runtime
 * artifact (fromCodeAsset AND fromS3) on all four protocols — HTTP / MCP /
 * A2A / AGUI. The resolver hard-errors on a non-literal `Code.S3.Prefix`
 * so the command never starts something it can't run.
 */
export interface ResolvedAgentCoreRuntime {
  /** Stack the runtime belongs to. */
  stack: StackInfo;
  /** CloudFormation logical ID of the runtime. */
  logicalId: string;
  /** Raw template entry (for property reads beyond what's surfaced here). */
  resource: TemplateResource;
  /**
   * Resolved container image URI from
   * `AgentRuntimeArtifact.ContainerConfiguration.ContainerUri`. Set for a
   * CONTAINER artifact; undefined for a {@link codeArtifact} one (exactly one
   * of the two is set).
   *
   * May still carry `${AWS::*}` placeholders when the source was an
   * `Fn::Sub` (the canonical `fromAsset` shape): the asset-hash match in
   * the command's image plan extracts the tag regardless, and the ECR-pull
   * path substitutes them via `--from-cfn-stack` state. A literal URI
   * passes through verbatim.
   */
  containerUri?: string;
  /**
   * Resolved `AgentRuntimeArtifact.CodeConfiguration` (managed-runtime / from
   * source) when the runtime declares one instead of a container — the command
   * builds a local image from the bundle's source. Undefined for a container
   * artifact (exactly one of {@link containerUri} / `codeArtifact` is set).
   */
  codeArtifact?: AgentCoreCodeArtifact;
  /**
   * `Properties.EnvironmentVariables` as it appears in the template
   * (a `Record<string, unknown>` — intrinsic-valued entries are left
   * unresolved here and handled by the command's shared env path). `{}`
   * when the runtime declares none.
   */
  environmentVariables: Record<string, unknown>;
  /**
   * `Properties.RoleArn` when it is a literal ARN string, else undefined
   * (an intrinsic such as `Fn::GetAtt`). Bare `--assume-role` uses this;
   * an intrinsic role falls back to an explicit `--assume-role <arn>`.
   */
  roleArn?: string;
  /** `HTTP` / `MCP` / `A2A` / `AGUI` (validated at resolution time). */
  protocol: string;
  /**
   * `Properties.AuthorizerConfiguration.CustomJWTAuthorizer` when present
   * with a literal `DiscoveryUrl` — the inbound JWT (OAuth / OIDC) authorizer
   * AgentCore uses to gate `/invocations`. Undefined when the runtime is
   * unauthenticated, or when `DiscoveryUrl` is an unresolved intrinsic.
   */
  jwtAuthorizer?: AgentCoreJwtAuthorizer;
}

/**
 * The inbound custom-JWT authorizer config a runtime declares
 * (`AuthorizerConfiguration.CustomJWTAuthorizer`). `discoveryUrl` is the
 * OIDC discovery document URL (`.well-known/openid-configuration`);
 * `allowedAudience` / `allowedClients` are the `aud` / `client_id`
 * allowlists the token must satisfy;
 * `allowedScopes` are OAuth scopes the token's `scope` claim must include;
 * `customClaims` are per-claim equality / membership rules the token must
 * satisfy in addition to the standard checks.
 */
export interface AgentCoreJwtAuthorizer {
  discoveryUrl: string;
  allowedAudience?: string[];
  allowedClients?: string[];
  allowedScopes?: string[];
  customClaims?: AgentCoreCustomClaim[];
}

/**
 * A single `CustomClaims` rule from
 * `AuthorizerConfiguration.CustomJWTAuthorizer.CustomClaims[]`. Drives
 * per-claim verification:
 *
 * - `valueType: STRING` + `operator: EQUALS` — the token claim must
 *   string-equal `value` (a single string).
 * - `valueType: STRING_ARRAY` + `operator: CONTAINS` — the token claim must
 *   be an array containing `value` (a single string).
 * - `valueType: STRING_ARRAY` + `operator: CONTAINS_ANY` — the token claim
 *   must be an array sharing at least one entry with `value` (an array of
 *   strings).
 */
export interface AgentCoreCustomClaim {
  name: string;
  valueType: 'STRING' | 'STRING_ARRAY';
  operator: 'EQUALS' | 'CONTAINS' | 'CONTAINS_ANY';
  value: string | string[];
}

/**
 * A resolved `AgentRuntimeArtifact.CodeConfiguration` (managed-runtime).
 * `codeAssetHash` is the cdk.out file-asset hash (from `Code.S3.Prefix`,
 * `<hash>.zip`) the command looks up to find the bundle's local source dir
 * (the `fromCodeAsset` shape); `entryPoint` is the `EntryPoint` argv and
 * `runtime` the `Runtime` enum.
 *
 * `s3Source` is set for the `fromS3` shape — a bundle whose `Code.S3.Bucket`
 * is either a literal string (a pre-existing S3 object — NOT the CDK staging
 * bucket of a fromCodeAsset, which renders as an `Fn::Sub` intrinsic) or an
 * unresolved intrinsic the command resolves against `--from-cfn-stack` state
 * (`Ref` / `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::Sub` — the same
 * intrinsics `--from-cfn-stack` env-var substitution already handles).
 *
 * - `bucket` is set when the template carries a literal bucket name, OR after
 *   the command has resolved an intrinsic against state.
 * - `bucketIntrinsic` is set when the template's `Code.S3.Bucket` is an
 *   unresolved intrinsic — the command resolves it via the same
 *   state-substitution machinery env vars use, then populates `bucket`.
 *
 * Exactly one of `bucket` / `bucketIntrinsic` is set as returned by the
 * resolver (the command turns the intrinsic into a `bucket` before download).
 */
export interface AgentCoreCodeArtifact {
  runtime: string;
  entryPoint: string[];
  codeAssetHash: string;
  s3Source?: {
    bucket?: string;
    bucketIntrinsic?: unknown;
    key: string;
    versionId?: string;
  };
}

export class AgentCoreResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCoreResolutionError';
    Object.setPrototypeOf(this, AgentCoreResolutionError.prototype);
  }
}

/**
 * Resolve a `cdkl invoke-agentcore <target>` argument against the synthesized
 * stacks. Accepts the same target forms as every other command
 * (`Stack:LogicalId` / `Stack/Path/...` / bare in single-stack apps),
 * reusing {@link parseTarget} + the shared stack-matcher / cdk-path index.
 *
 * `imageContext` is optional: when the `ContainerUri` is an `Fn::Join`
 * (imported ECR repo / same-stack repo under `--from-cfn-stack`), the
 * caller threads resolved pseudo parameters + state so the URI reduces to
 * a concrete string. Literal / `Fn::Sub` URIs need no context.
 */
export function resolveAgentCoreTarget(
  target: string,
  stacks: StackInfo[],
  imageContext?: ImageResolutionContext
): ResolvedAgentCoreRuntime {
  if (stacks.length === 0) {
    throw new AgentCoreResolutionError('No stacks found in the synthesized assembly.');
  }

  const parsed = parseTarget(target);
  const stack = pickStack(parsed, stacks);
  const resources = stack.template.Resources ?? {};

  const { logicalId, resource } = matchRuntime(parsed, target, stack, resources);

  if (resource.Type !== AGENTCORE_RUNTIME_TYPE) {
    throw new AgentCoreResolutionError(
      `Resource '${logicalId}' in ${stack.stackName} is ${resource.Type}, not ${AGENTCORE_RUNTIME_TYPE}. ` +
        `${getEmbedConfig().cliName} invoke-agentcore only runs Bedrock AgentCore Runtime resources.`
    );
  }

  return extractRuntimeProperties(stack, logicalId, resource, resources, imageContext);
}

/**
 * Best-effort pick of the candidate stack a target lives in, BEFORE full
 * resolution — so the command can build a `--from-cfn-stack` image-resolution
 * context (state load + pseudo parameters) and thread it into
 * {@link resolveAgentCoreTarget} so a same-stack `AWS::ECR::Repository`
 * `Fn::Join` ContainerUri resolves to the deployed URI. Returns undefined when
 * the stack is ambiguous (multi-stack app, no prefix) — the caller proceeds
 * without a context and the resolver surfaces its own error if one is needed.
 * Mirrors `run-task`'s `pickCandidateStack`.
 */
export function pickAgentCoreCandidateStack(
  target: string,
  stacks: StackInfo[]
): StackInfo | undefined {
  const parsed = parseTarget(target);
  if (parsed.stackPattern === null) {
    return stacks.length === 1 ? stacks[0] : undefined;
  }
  const matched = matchStacks(stacks, [parsed.stackPattern]);
  return matched.length === 1 ? matched[0] : undefined;
}

/**
 * Single-stack auto-detect: if the app has exactly one stack the user may
 * omit the stack prefix; otherwise an explicit stack pattern is required.
 * Mirrors the Lambda / ECS resolvers' behavior via the shared
 * stack-matcher.
 */
function pickStack(parsed: ParsedTarget, stacks: StackInfo[]): StackInfo {
  if (parsed.stackPattern === null) {
    if (stacks.length === 1) return stacks[0]!;
    throw new AgentCoreResolutionError(
      `Multiple stacks in app, target '${parsed.pathOrId}' is missing a stack prefix. ` +
        `Use 'StackName:${parsed.pathOrId}' or 'StackName/...' (path form). ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }
  const matched = matchStacks(stacks, [parsed.stackPattern]);
  if (matched.length === 0) {
    throw new AgentCoreResolutionError(
      `Stack '${parsed.stackPattern}' not found. ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }
  if (matched.length > 1) {
    throw new AgentCoreResolutionError(
      `Stack pattern '${parsed.stackPattern}' matched ${matched.length} stacks: ` +
        matched.map((s) => s.stackName).join(', ') +
        '. Use a more specific pattern.'
    );
  }
  return matched[0]!;
}

/** Resolve a parsed target to a single (logicalId, resource) pair. */
function matchRuntime(
  parsed: ParsedTarget,
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): { logicalId: string; resource: TemplateResource } {
  if (parsed.isPath) {
    const index = buildCdkPathIndex(stack.template);
    const resolvedPaths = resolveCdkPathToLogicalIds(parsed.pathOrId, index);
    const runtimeMatches = resolvedPaths.filter(
      ({ logicalId }) => resources[logicalId]?.Type === AGENTCORE_RUNTIME_TYPE
    );
    if (runtimeMatches.length === 0) {
      throw notFoundError(target, stack, resources);
    }
    if (runtimeMatches.length > 1) {
      throw new AgentCoreResolutionError(
        `Target '${target}' matches ${runtimeMatches.length} AgentCore Runtimes in ${stack.stackName}: ` +
          runtimeMatches.map((m) => m.logicalId).join(', ') +
          '. Refine the path or use the stack:LogicalId form.'
      );
    }
    const m = runtimeMatches[0]!;
    return { logicalId: m.logicalId, resource: resources[m.logicalId]! };
  }

  const resource = resources[parsed.pathOrId];
  if (!resource) {
    throw notFoundError(target, stack, resources);
  }
  return { logicalId: parsed.pathOrId, resource };
}

function notFoundError(
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): AgentCoreResolutionError {
  const available = Object.entries(resources)
    .filter(([, r]) => r.Type === AGENTCORE_RUNTIME_TYPE)
    .map(([id]) => id);
  const hint =
    available.length > 0
      ? `Available AgentCore Runtimes in ${stack.stackName}: ${available.join(', ')}.`
      : `No ${AGENTCORE_RUNTIME_TYPE} resources found in ${stack.stackName}.`;
  return new AgentCoreResolutionError(`Target '${target}' not found. ${hint}`);
}

/** Pull the runtime properties `cdkl invoke-agentcore` cares about. */
function extractRuntimeProperties(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource,
  resources: Record<string, TemplateResource>,
  imageContext: ImageResolutionContext | undefined
): ResolvedAgentCoreRuntime {
  const props = resource.Properties ?? {};

  const protocol = extractProtocol(props['ProtocolConfiguration'], logicalId, stack.stackName);
  const artifact = extractArtifact(
    props['AgentRuntimeArtifact'],
    logicalId,
    stack.stackName,
    resources,
    stack.region,
    imageContext
  );

  const environmentVariables =
    props['EnvironmentVariables'] &&
    typeof props['EnvironmentVariables'] === 'object' &&
    !Array.isArray(props['EnvironmentVariables'])
      ? (props['EnvironmentVariables'] as Record<string, unknown>)
      : {};

  const roleArn = typeof props['RoleArn'] === 'string' ? props['RoleArn'] : undefined;
  const jwtAuthorizer = extractJwtAuthorizer(props['AuthorizerConfiguration'], logicalId);

  return {
    stack,
    logicalId,
    resource,
    ...(artifact.kind === 'container'
      ? { containerUri: artifact.containerUri }
      : { codeArtifact: artifact.codeArtifact }),
    environmentVariables,
    protocol,
    ...(roleArn !== undefined && { roleArn }),
    ...(jwtAuthorizer !== undefined && { jwtAuthorizer }),
  };
}

/**
 * Extract a literal `CustomJWTAuthorizer` from `AuthorizerConfiguration`.
 * Returns undefined when there is no authorizer, or when `DiscoveryUrl` is
 * not a literal string (an unresolved intrinsic) — verification needs a
 * concrete URL to fetch, so an intrinsic is warn-and-skipped by the caller.
 */
function extractJwtAuthorizer(
  authorizerConfig: unknown,
  logicalId: string
): AgentCoreJwtAuthorizer | undefined {
  if (
    !authorizerConfig ||
    typeof authorizerConfig !== 'object' ||
    Array.isArray(authorizerConfig)
  ) {
    return undefined;
  }
  const jwt = (authorizerConfig as Record<string, unknown>)['CustomJWTAuthorizer'];
  if (!jwt || typeof jwt !== 'object' || Array.isArray(jwt)) return undefined;
  const cfg = jwt as Record<string, unknown>;

  const discoveryUrl = cfg['DiscoveryUrl'];
  if (typeof discoveryUrl !== 'string' || discoveryUrl.length === 0) {
    getLogger().warn(
      `AgentCore Runtime '${logicalId}' declares a CustomJWTAuthorizer whose DiscoveryUrl is not a literal string; ` +
        `${getEmbedConfig().cliName} invoke-agentcore cannot verify inbound JWTs against it and will skip auth.`
    );
    return undefined;
  }

  const toStringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const allowedAudience = toStringArray(cfg['AllowedAudience']);
  const allowedClients = toStringArray(cfg['AllowedClients']);
  const allowedScopes = toStringArray(cfg['AllowedScopes']);
  const customClaims = extractCustomClaims(cfg['CustomClaims'], logicalId);

  return {
    discoveryUrl,
    ...(allowedAudience && allowedAudience.length > 0 && { allowedAudience }),
    ...(allowedClients && allowedClients.length > 0 && { allowedClients }),
    ...(allowedScopes && allowedScopes.length > 0 && { allowedScopes }),
    ...(customClaims && customClaims.length > 0 && { customClaims }),
  };
}

/**
 * Parse a `CustomJWTAuthorizer.CustomClaims[]` array into
 * {@link AgentCoreCustomClaim}s. The template shape (synthesized by the L2):
 *
 * ```
 * {
 *   InboundTokenClaimName: <claim name>,
 *   InboundTokenClaimValueType: 'STRING' | 'STRING_ARRAY',
 *   AuthorizingClaimMatchValue: {
 *     ClaimMatchOperator: 'EQUALS' | 'CONTAINS' | 'CONTAINS_ANY',
 *     ClaimMatchValue: { MatchValueString?: ..., MatchValueStringList?: [...] }
 *   }
 * }
 * ```
 *
 * Each entry that fails to parse (missing name / unknown type / unknown
 * operator / wrong value shape) is warn-and-skipped — the deployed runtime
 * would reject a token that violates ANY claim rule, so dropping a rule we
 * can't evaluate is the safer side (under-restrictive in `--no-verify-auth`
 * paths, fine elsewhere because the surviving rules still gate the token).
 */
function extractCustomClaims(raw: unknown, logicalId: string): AgentCoreCustomClaim[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentCoreCustomClaim[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const name = e['InboundTokenClaimName'];
    const valueType = e['InboundTokenClaimValueType'];
    const matchObj = e['AuthorizingClaimMatchValue'];
    if (typeof name !== 'string' || name.length === 0) continue;
    if (valueType !== 'STRING' && valueType !== 'STRING_ARRAY') {
      getLogger().warn(
        `AgentCore Runtime '${logicalId}' CustomClaims entry '${name}' has unsupported ` +
          `InboundTokenClaimValueType '${String(valueType)}' (expected STRING / STRING_ARRAY); skipping.`
      );
      continue;
    }
    if (!matchObj || typeof matchObj !== 'object' || Array.isArray(matchObj)) continue;
    const m = matchObj as Record<string, unknown>;
    const operator = m['ClaimMatchOperator'];
    const matchValue = m['ClaimMatchValue'];
    if (operator !== 'EQUALS' && operator !== 'CONTAINS' && operator !== 'CONTAINS_ANY') {
      getLogger().warn(
        `AgentCore Runtime '${logicalId}' CustomClaims entry '${name}' has unsupported ` +
          `ClaimMatchOperator '${String(operator)}' (expected EQUALS / CONTAINS / CONTAINS_ANY); skipping.`
      );
      continue;
    }
    if (!matchValue || typeof matchValue !== 'object' || Array.isArray(matchValue)) continue;
    const mv = matchValue as Record<string, unknown>;
    // STRING + EQUALS and STRING_ARRAY + CONTAINS use MatchValueString (single
    // string); STRING_ARRAY + CONTAINS_ANY uses MatchValueStringList (array).
    let value: string | string[] | undefined;
    if (operator === 'CONTAINS_ANY') {
      const list = mv['MatchValueStringList'];
      if (Array.isArray(list)) {
        value = list.filter((x): x is string => typeof x === 'string');
        if ((value as string[]).length === 0) value = undefined;
      }
    } else {
      const s = mv['MatchValueString'];
      if (typeof s === 'string' && s.length > 0) value = s;
    }
    if (value === undefined) {
      getLogger().warn(
        `AgentCore Runtime '${logicalId}' CustomClaims entry '${name}' has no usable ` +
          `MatchValueString / MatchValueStringList for operator ${operator}; skipping.`
      );
      continue;
    }
    out.push({ name, valueType, operator, value });
  }
  return out;
}

/**
 * Validate `ProtocolConfiguration`. Serves the four AgentCore protocols
 * (HTTP / MCP / A2A / AGUI); an unrecognized value hard-errors with the
 * supported list so the command never starts something it can't run.
 */
function extractProtocol(value: unknown, logicalId: string, stackName: string): string {
  if (value === undefined || value === null) return AGENTCORE_HTTP_PROTOCOL;
  if (typeof value !== 'string') {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has a non-string ProtocolConfiguration. ` +
        `${getEmbedConfig().cliName} invoke-agentcore supports the ${SUPPORTED_AGENTCORE_PROTOCOLS.join(' / ')} protocols.`
    );
  }
  if (!(SUPPORTED_AGENTCORE_PROTOCOLS as readonly string[]).includes(value)) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} uses the ${value} protocol. ` +
        `${getEmbedConfig().cliName} invoke-agentcore supports the ${SUPPORTED_AGENTCORE_PROTOCOLS.join(' / ')} protocols.`
    );
  }
  return value;
}

type ExtractedArtifact =
  | { kind: 'container'; containerUri: string }
  | { kind: 'code'; codeArtifact: AgentCoreCodeArtifact };

/**
 * Resolve `AgentRuntimeArtifact` to either a container image URI or a code
 * artifact (managed runtime). A `ContainerConfiguration` yields the resolved
 * `ContainerUri`; a `CodeConfiguration` yields its `Runtime` / `EntryPoint` +
 * the cdk.out asset hash the command uses to locate the bundle source.
 */
function extractArtifact(
  artifact: unknown,
  logicalId: string,
  stackName: string,
  resources: Record<string, TemplateResource>,
  region: string | undefined,
  imageContext: ImageResolutionContext | undefined
): ExtractedArtifact {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has no AgentRuntimeArtifact.`
    );
  }
  const art = artifact as Record<string, unknown>;

  if (art['CodeConfiguration'] && !art['ContainerConfiguration']) {
    return {
      kind: 'code',
      codeArtifact: extractCodeArtifact(art['CodeConfiguration'], logicalId, stackName),
    };
  }

  const container = art['ContainerConfiguration'];
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has no ContainerConfiguration in its AgentRuntimeArtifact.`
    );
  }

  const uri = resolveImageUri(
    (container as Record<string, unknown>)['ContainerUri'],
    logicalId,
    stackName,
    resources,
    region,
    imageContext
  );
  if (uri === undefined) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has a ContainerConfiguration.ContainerUri that ${getEmbedConfig().cliName} invoke-agentcore cannot resolve. ` +
        `v1 resolves a literal image URI, an Fn::Sub asset URI (the fromAsset / Dockerfile path), an imported-ECR Fn::Join, ` +
        `and a same-stack AWS::ECR::Repository Fn::Join under --from-cfn-stack — build the agent as a fromAsset image, or pin a literal / imported ECR image URI.`
    );
  }
  return { kind: 'container', containerUri: uri };
}

/**
 * Extract a `CodeConfiguration` (managed-runtime) artifact. Reads `Runtime`,
 * `EntryPoint`, and the `Code.S3` location. `Code.S3.Prefix` must be a literal
 * string (the object key) — it doubles as the cdk.out file-asset hash for the
 * `fromCodeAsset` shape (`<hash>.zip`).
 *
 * - `Code.S3.Bucket` literal string → fromS3 bundle, `s3Source.bucket` set.
 * - `Code.S3.Bucket` intrinsic (`Ref` / `Fn::ImportValue` / `Fn::GetStackOutput`
 *   / `Fn::Sub`) → fromS3 bundle, `s3Source.bucketIntrinsic` set (the command
 *   resolves it against `--from-cfn-stack` state via the same machinery env
 *   vars use).
 * - `Code.S3.Bucket` missing → fromCodeAsset shape (the staging bucket renders
 *   as an `Fn::Sub` intrinsic for fromCodeAsset, but the cdk.out lookup
 *   short-circuits that — no `s3Source` needed).
 *
 * A non-literal `Code.S3.Prefix` (an unresolved intrinsic) hard-errors.
 */
function extractCodeArtifact(
  codeConfig: unknown,
  logicalId: string,
  stackName: string
): AgentCoreCodeArtifact {
  const cfg =
    codeConfig && typeof codeConfig === 'object' && !Array.isArray(codeConfig)
      ? (codeConfig as Record<string, unknown>)
      : {};

  const runtime = cfg['Runtime'];
  if (typeof runtime !== 'string' || runtime.length === 0) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has a CodeConfiguration with no string Runtime.`
    );
  }

  const entryPointRaw = cfg['EntryPoint'];
  const entryPoint = Array.isArray(entryPointRaw)
    ? entryPointRaw.filter((x): x is string => typeof x === 'string')
    : [];
  if (entryPoint.length === 0) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has a CodeConfiguration with no EntryPoint.`
    );
  }

  const s3 =
    cfg['Code'] && typeof cfg['Code'] === 'object'
      ? (cfg['Code'] as Record<string, unknown>)['S3']
      : undefined;
  const s3Obj =
    s3 && typeof s3 === 'object' && !Array.isArray(s3) ? (s3 as Record<string, unknown>) : {};
  const prefix = s3Obj['Prefix'];
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has a CodeConfiguration whose Code.S3.Prefix is not a literal string. ` +
        `${getEmbedConfig().cliName} invoke-agentcore needs a literal object key — re-synthesize a fromCodeAsset bundle, ` +
        `or pass a literal bucket + key for a fromS3 bundle.`
    );
  }

  // Prefix is `<assetHash>.zip` (possibly with a key prefix) → the cdk.out
  // file-asset hash the command looks up to find a fromCodeAsset bundle source.
  const codeAssetHash = prefix.replace(/^.*\//, '').replace(/\.zip$/, '');

  // A literal Bucket means a fromS3 bundle. An intrinsic Bucket — one of
  // {Ref, Fn::ImportValue, Fn::GetStackOutput} — is also a fromS3 bundle whose
  // bucket name we resolve against `--from-cfn-stack` state at command time.
  // The CDK staging bucket of a fromCodeAsset renders as `{Fn::Sub: "..."}`
  // and is INTENTIONALLY skipped here so fromCodeAsset still routes through
  // the cdk.out asset path.
  const bucket = s3Obj['Bucket'];
  const versionId = s3Obj['VersionId'];
  const versionIdField = typeof versionId === 'string' && versionId.length > 0 ? { versionId } : {};
  let s3Source: AgentCoreCodeArtifact['s3Source'] | undefined;
  if (typeof bucket === 'string' && bucket.length > 0) {
    s3Source = { bucket, key: prefix, ...versionIdField };
  } else if (isFromS3BucketIntrinsic(bucket)) {
    s3Source = { bucketIntrinsic: bucket, key: prefix, ...versionIdField };
  }

  return { runtime, entryPoint, codeAssetHash, ...(s3Source && { s3Source }) };
}

/**
 * Whitelist the intrinsic shapes the command can resolve for a fromS3
 * `Code.S3.Bucket` against `--from-cfn-stack` state — `Ref` (same-stack
 * resource), `Fn::ImportValue` (CloudFormation export), `Fn::GetStackOutput`
 * (cdk-local cross-stack output). Crucially excludes `Fn::Sub`, which is the
 * fromCodeAsset staging-bucket shape: that one stays unmarked so fromCodeAsset
 * routes through the cdk.out asset path unchanged.
 */
function isFromS3BucketIntrinsic(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return 'Ref' in obj || 'Fn::ImportValue' in obj || 'Fn::GetStackOutput' in obj;
}

/**
 * Resolve a `ContainerUri` value to a string. Handles a literal string,
 * an `Fn::Sub` (the template returned verbatim — `${AWS::*}` placeholders
 * are kept for asset-hash matching / later ECR substitution), and the
 * canonical CDK `Fn::Join` ECR shape via the shared {@link intrinsic-image}
 * resolver. A same-stack `AWS::ECR::Repository` Fn::Join without
 * `--from-cfn-stack` throws an `AgentCoreResolutionError` pointing the user
 * at the right flag (mirroring `cdkl run-task`'s shape). Returns undefined
 * when none of the supported shapes apply.
 */
function resolveImageUri(
  value: unknown,
  logicalId: string,
  stackName: string,
  resources: Record<string, TemplateResource>,
  region: string | undefined,
  imageContext: ImageResolutionContext | undefined
): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const obj = value as Record<string, unknown>;

  const sub = obj['Fn::Sub'];
  if (typeof sub === 'string' && sub.length > 0) {
    return imageContext ? substituteImagePlaceholders(sub, resources, imageContext) : sub;
  }
  if (Array.isArray(sub) && typeof sub[0] === 'string') {
    return imageContext ? substituteImagePlaceholders(sub[0], resources, imageContext) : sub[0];
  }

  if ('Fn::Join' in obj) {
    const context: ImageResolutionContext | undefined =
      imageContext ??
      (() => {
        const pseudoParameters = derivePseudoParametersFromRegion(region);
        return pseudoParameters ? { pseudoParameters } : undefined;
      })();
    const joinResolved = tryResolveImageFnJoin(value, resources, context);
    if (joinResolved.kind === 'resolved') return joinResolved.uri;
    // Mirror ECS's shape: when the Fn::Join references a same-stack
    // AWS::ECR::Repository but no state has been loaded, point the user
    // at the state-source remedy rather than the coarse "cannot resolve"
    // we fall through to for genuinely unsupported intrinsics. The
    // remedy hint flips between "pass --from-cfn-stack" and
    // "the state-source attempt failed: ..." depending on whether the
    // context carries a captured load-failure message.
    if (joinResolved.kind === 'needs-state') {
      throw new AgentCoreResolutionError(
        `AgentCore Runtime '${logicalId}' in ${stackName} references same-stack ECR repository '${joinResolved.repoLogicalId}' via Fn::Join. ` +
          `${getEmbedConfig().cliName} cannot resolve the repository URI without state — ` +
          formatStateRemedy(context) +
          ', build via Runtime.fromAsset, or pin a literal / imported ECR image URI.'
      );
    }
  }

  return undefined;
}
