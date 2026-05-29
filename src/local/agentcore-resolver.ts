import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';
import {
  derivePseudoParametersFromRegion,
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
 *
 * `A2A` / `AGUI` declare yet other wire contracts and are not served yet.
 */
export const AGENTCORE_HTTP_PROTOCOL = 'HTTP';
export const AGENTCORE_MCP_PROTOCOL = 'MCP';

/** Protocols this CLI can run a container for. */
const SUPPORTED_AGENTCORE_PROTOCOLS = [AGENTCORE_HTTP_PROTOCOL, AGENTCORE_MCP_PROTOCOL] as const;

/**
 * Result of resolving a `cdkl invoke-agentcore <target>` argument back to a
 * concrete `AWS::BedrockAgentCore::Runtime` in the synthesized assembly.
 *
 * Covers the CONTAINER artifact on the HTTP + MCP protocols — the resolver
 * hard-errors on `CodeConfiguration` artifacts (S3 zip + managed runtime)
 * and the A2A / AGUI protocols so the command never starts a container it
 * can't speak to.
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
   * `AgentRuntimeArtifact.ContainerConfiguration.ContainerUri`.
   *
   * May still carry `${AWS::*}` placeholders when the source was an
   * `Fn::Sub` (the canonical `fromAsset` shape): the asset-hash match in
   * the command's image plan extracts the tag regardless, and the ECR-pull
   * path substitutes them via `--from-cfn-stack` state. A literal URI
   * passes through verbatim.
   */
  containerUri: string;
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
  /** `HTTP` or `MCP` (validated at resolution time). */
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
 * allowlists the token must satisfy.
 */
export interface AgentCoreJwtAuthorizer {
  discoveryUrl: string;
  allowedAudience?: string[];
  allowedClients?: string[];
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
  const containerUri = extractContainerUri(
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
    containerUri,
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

  return {
    discoveryUrl,
    ...(allowedAudience && allowedAudience.length > 0 && { allowedAudience }),
    ...(allowedClients && allowedClients.length > 0 && { allowedClients }),
  };
}

/**
 * Validate `ProtocolConfiguration`. Serves `HTTP` (the default when absent)
 * and `MCP`; `A2A` / `AGUI` speak other wire contracts and hard-error with a
 * pointer to the follow-up.
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
        `${getEmbedConfig().cliName} invoke-agentcore supports the ${SUPPORTED_AGENTCORE_PROTOCOLS.join(' / ')} protocols ` +
        `(A2A / AGUI speak different wire contracts and are not served yet).`
    );
  }
  return value;
}

/**
 * Extract + resolve the container image URI from `AgentRuntimeArtifact`.
 * Rejects the `CodeConfiguration` artifact (S3 zip + managed runtime),
 * which has no Dockerfile and is deferred from v1.
 */
function extractContainerUri(
  artifact: unknown,
  logicalId: string,
  stackName: string,
  resources: Record<string, TemplateResource>,
  region: string | undefined,
  imageContext: ImageResolutionContext | undefined
): string {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has no AgentRuntimeArtifact.`
    );
  }
  const art = artifact as Record<string, unknown>;

  if (art['CodeConfiguration'] && !art['ContainerConfiguration']) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} uses a code artifact (CodeConfiguration). ` +
        `${getEmbedConfig().cliName} invoke-agentcore v1 runs container artifacts only — ` +
        `running a managed-runtime code artifact locally needs a from-source build that is not yet supported. ` +
        `Build the agent as a container (e.g. AgentCoreRuntime fromAsset / a Dockerfile) to run it locally.`
    );
  }

  const container = art['ContainerConfiguration'];
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has no ContainerConfiguration in its AgentRuntimeArtifact.`
    );
  }

  const uri = resolveImageUri(
    (container as Record<string, unknown>)['ContainerUri'],
    resources,
    region,
    imageContext
  );
  if (uri === undefined) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has a ContainerConfiguration.ContainerUri that ${getEmbedConfig().cliName} invoke-agentcore cannot resolve. ` +
        `v1 resolves a literal image URI, an Fn::Sub asset URI (the fromAsset / Dockerfile path), and an imported-ECR Fn::Join. ` +
        `A same-stack AWS::ECR::Repository reference is not supported — build the agent as a fromAsset image, or pin a literal / imported ECR image URI.`
    );
  }
  return uri;
}

/**
 * Resolve a `ContainerUri` value to a string. Handles a literal string,
 * an `Fn::Sub` (the template returned verbatim — `${AWS::*}` placeholders
 * are kept for asset-hash matching / later ECR substitution), and the
 * canonical CDK `Fn::Join` ECR shape via the shared {@link intrinsic-image}
 * resolver. Returns undefined when none apply.
 */
function resolveImageUri(
  value: unknown,
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
  }

  return undefined;
}
