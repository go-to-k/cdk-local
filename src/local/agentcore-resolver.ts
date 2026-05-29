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

/**
 * CloudFormation resource type for a Bedrock AgentCore Runtime.
 * `cdkl invoke-agent` resolves and runs these locally.
 */
export const AGENTCORE_RUNTIME_TYPE = 'AWS::BedrockAgentCore::Runtime';

/**
 * The only protocol `cdkl invoke-agent` serves in v1. AgentCore Runtimes
 * may also declare `MCP` / `A2A` / `AGUI`, which speak different wire
 * contracts and are out of scope here.
 */
export const AGENTCORE_HTTP_PROTOCOL = 'HTTP';

/**
 * Result of resolving a `cdkl invoke-agent <target>` argument back to a
 * concrete `AWS::BedrockAgentCore::Runtime` in the synthesized assembly.
 *
 * v1 covers the CONTAINER artifact + HTTP protocol only — the resolver
 * hard-errors on `CodeConfiguration` artifacts (S3 zip + managed runtime)
 * and non-HTTP protocols so the command never starts a container it can't
 * speak to.
 */
export interface ResolvedAgentRuntime {
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
  /** Always `HTTP` in v1 (validated at resolution time). */
  protocol: string;
}

export class AgentCoreResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCoreResolutionError';
    Object.setPrototypeOf(this, AgentCoreResolutionError.prototype);
  }
}

/**
 * Resolve a `cdkl invoke-agent <target>` argument against the synthesized
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
): ResolvedAgentRuntime {
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
        `${getEmbedConfig().cliName} invoke-agent only runs Bedrock AgentCore Runtime resources.`
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

/** Pull the runtime properties `cdkl invoke-agent` cares about. */
function extractRuntimeProperties(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource,
  resources: Record<string, TemplateResource>,
  imageContext: ImageResolutionContext | undefined
): ResolvedAgentRuntime {
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

  return {
    stack,
    logicalId,
    resource,
    containerUri,
    environmentVariables,
    protocol,
    ...(roleArn !== undefined && { roleArn }),
  };
}

/**
 * Validate `ProtocolConfiguration`. v1 serves only `HTTP`; absent is
 * treated as `HTTP` (the runtime contract's default request/response
 * shape). Any explicit non-HTTP value hard-errors.
 */
function extractProtocol(value: unknown, logicalId: string, stackName: string): string {
  if (value === undefined || value === null) return AGENTCORE_HTTP_PROTOCOL;
  if (typeof value !== 'string') {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} has a non-string ProtocolConfiguration. ` +
        `${getEmbedConfig().cliName} invoke-agent supports the ${AGENTCORE_HTTP_PROTOCOL} protocol only in v1.`
    );
  }
  if (value !== AGENTCORE_HTTP_PROTOCOL) {
    throw new AgentCoreResolutionError(
      `AgentCore Runtime '${logicalId}' in ${stackName} uses the ${value} protocol. ` +
        `${getEmbedConfig().cliName} invoke-agent supports the ${AGENTCORE_HTTP_PROTOCOL} protocol only in v1 ` +
        `(MCP / A2A / AGUI speak different wire contracts).`
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
        `${getEmbedConfig().cliName} invoke-agent v1 runs container artifacts only — ` +
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
      `AgentCore Runtime '${logicalId}' in ${stackName} has a ContainerConfiguration.ContainerUri that ${getEmbedConfig().cliName} invoke-agent cannot resolve. ` +
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
