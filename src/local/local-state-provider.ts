/**
 * `LocalStateProvider` — abstraction over the substitution input the
 * `cdkl *` commands feed to `state-resolver.ts`.
 *
 * Two implementations:
 *
 *   - {@link S3LocalStateProvider} (default for `--from-state`) — reads
 *     the host's S3 state for stacks deployed via `cdkl deploy`. Same
 *     behavior as the pre-issue-#606 code path; the S3 implementation is
 *     a thin wrapper around the existing `loadStateForStack` +
 *     `buildCrossStackResolver` helpers in
 *     `src/cli/commands/local-state-loader.ts`.
 *
 *   - {@link CfnLocalStateProvider} (new for `--from-cfn-stack`) — reads
 *     a deployed CloudFormation stack via `ListStackResources` +
 *     `DescribeStacks --Outputs` + `ListExports`. Lets the `local *`
 *     commands substitute deployed physical IDs from a CDK app deployed
 *     via the upstream CDK CLI (`cdk deploy` → CloudFormation), so users
 *     migrating between cdk-local and CFn (or running cdk-local against an
 *     existing CFn-managed CDK app) get the same UX they get with
 *     `--from-state` against cdk-local-deployed stacks.
 *
 * The interface intentionally mirrors what `state-resolver.ts` consumes:
 * a `Record<string, ResourceState>` (covers `Ref`), an outputs map
 * (cross-stack `Fn::GetStackOutput` source), and an optional cross-stack
 * resolver (`Fn::ImportValue` / `Fn::GetStackOutput`). The four `cdkl *`
 * command files build a single context off of whatever provider
 * fired and pass it through the substitution engine unchanged.
 *
 * `--from-cfn-stack` is mutually exclusive with `--from-state` at the
 * CLI layer (each command file enforces this); the interface itself
 * carries no notion of which flag was the source so the same provider
 * could in principle drive both flags in the future.
 */

import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState } from '../types/state.js';
import type { CrossStackResolver } from './state-resolver.js';
import type { ResolvedSsmParameters } from './ssm-parameter-resolver.js';

/**
 * Result of loading state for a specific (stack, region) pair. The
 * shape is intentionally a strict subset of cdk-local's `StackState` so the
 * substituter doesn't depend on schema fields irrelevant to local
 * execution (lock state, version, lastModified, etc.).
 */
export interface LocalStateRecord {
  /**
   * Per-logical-id resource records. Covers `Ref: <logicalId>` lookups
   * via `physicalId`. The CFn provider leaves `attributes` empty —
   * `ListStackResources` does not return per-attribute values, so
   * `Fn::GetAtt` does not resolve statically against this map. For a
   * consumer Lambda's own env vars that gap is closed at runtime by
   * {@link LocalStateProvider.resolveDeployedFunctionEnv} (reads the
   * deployed function's already-resolved env); other `Fn::GetAtt` sites
   * still warn-and-drop.
   */
  resources: Record<string, ResourceState>;
  /**
   * Stack outputs map. Sourced from the host's state for the S3 provider and
   * from `DescribeStacks.Outputs[]` for the CFn provider. Consumed by
   * `Fn::GetStackOutput` and by the cross-stack resolver when no
   * persistent exports index is available.
   */
  outputs: Record<string, string>;
  /**
   * Region the state record was actually loaded from. For the S3
   * provider this resolves multi-region ambiguity (the same stack name
   * can have state in multiple regions); for the CFn provider it's the
   * region the `cloudformation:DescribeStacks` call hit.
   */
  region: string;
}

/**
 * Source for substitution inputs. Implementations encapsulate both the
 * single-stack load AND the optional cross-stack resolver — the two
 * code paths share the same client / region / credential context, so
 * an implementation can decide internally whether to share a single
 * AWS client across both lookups (the CFn provider does — only one
 * `CloudFormationClient` instance).
 *
 * Failures from `load` are best-effort warn-and-drop: an implementation
 * is expected to log a warning and return `undefined` so the caller
 * falls back to PR 1's "intrinsic-valued env var dropped" behavior.
 * Genuine programmer errors (e.g. mutual-exclusion violation at the
 * CLI layer) are caught earlier.
 *
 * `dispose` is called by the CLI layer when the substitution pass is
 * over so providers can close any AWS clients they own. Implementations
 * MUST tolerate being disposed even when `load` was never called (the
 * caller may construct the provider before deciding whether to use it).
 */
export interface LocalStateProvider {
  /**
   * Short label surfaced in warn messages so users can tell which
   * source produced the substitution they're looking at. Always one of
   * `'--from-state'` / `'--from-cfn-stack'`.
   */
  readonly label: string;
  /**
   * Load the state record for `stackName`. `synthRegion` is the
   * synth-derived stack region (`env.region` on the CDK stack); the
   * implementation may use it as a fallback when no explicit region
   * override is set. Returns `undefined` on any expected miss (no
   * record, ambiguous region, bucket / stack resolution failure).
   */
  load(stackName: string, synthRegion: string | undefined): Promise<LocalStateRecord | undefined>;
  /**
   * Build a cross-stack resolver for `Fn::ImportValue` /
   * `Fn::GetStackOutput`. The S3 provider reads the host's exports index +
   * per-stack state; the CFn provider uses `ListExports` (paginated)
   * for `Fn::ImportValue` and rejects `Fn::GetStackOutput` (cdk-local-specific
   * intrinsic — CFn has no equivalent). `consumerRegion` is the
   * region the consumer Lambda / ECS task lives in.
   *
   * Returns `undefined` when the resolver could not be built; the
   * caller treats every cross-stack intrinsic as unresolved in that
   * case.
   */
  buildCrossStackResolver(consumerRegion: string): Promise<CrossStackResolver | undefined>;
  /**
   * Optional: read a deployed Lambda function's already-resolved
   * environment variables, keyed by env-var name. Used as a last-resort
   * fill for env keys whose template value is a CloudFormation intrinsic
   * the static substituter could not resolve (e.g. `Fn::GetAtt
   * <SiblingFn>.Arn`, which `ListStackResources` does not return an
   * attribute for). CloudFormation resolved every intrinsic at deploy
   * time, so the deployed function's `Environment.Variables` already
   * carries the concrete value — reading it covers `Fn::GetAtt` /
   * `Fn::Sub` / `Fn::ImportValue` / cross-stack `Ref` uniformly without
   * per-resource-type reconstruction.
   *
   * `functionPhysicalId` is the deployed function name / ARN (the `Ref`
   * value `ListStackResources` returns for `AWS::Lambda::Function`).
   * Returns `undefined` on any expected miss (no such function, access
   * denied, throttling) so the caller falls back to warn-and-drop.
   *
   * Implemented only by the CFn provider (`--from-cfn-stack`) — the S3
   * provider's state already carries deploy-time attributes, so its
   * `Fn::GetAtt` resolves statically and no fallback is needed. Optional
   * so existing / host-extension providers need not implement it.
   *
   * Note: `Environment.Variables` is a plaintext, non-secret-intended
   * property (AWS surfaces it to any caller with
   * `lambda:GetFunctionConfiguration`); recovered values land in the
   * local container env. Callers must never log the values.
   */
  resolveDeployedFunctionEnv?(
    functionPhysicalId: string
  ): Promise<Record<string, string> | undefined>;
  /**
   * Optional: resolve a deployed Lambda function's execution-role ARN
   * via `lambda:GetFunctionConfiguration`'s `Configuration.Role`.
   *
   * Closes the bare `--assume-role` auto-resolve gap (issue #181) for
   * the common case where the Lambda's execution role is a sibling
   * resource in the same stack. `ListStackResources` returns the role's
   * NAME (PhysicalResourceId), not the ARN, so the static state lookup
   * in {@link resolveExecutionRoleArnFromState} (which reads
   * `attributes.Arn`) returns `undefined`. The function's own
   * deploy-time-resolved configuration is the lowest-cost way to
   * recover the ARN — same shape as
   * {@link LocalStateProvider.resolveDeployedFunctionEnv}, one extra
   * `lambda:GetFunctionConfiguration` call.
   *
   * `functionPhysicalId` is the deployed function name / ARN (the
   * `Ref` value `ListStackResources` returns for `AWS::Lambda::Function`).
   * Returns `undefined` on any expected miss (no such function, access
   * denied, throttling) so the caller falls back to the existing
   * "Pass the ARN explicitly: --assume-role <arn>" warning.
   *
   * Implemented only by the CFn provider (`--from-cfn-stack`) — the S3
   * provider's state already carries deploy-time attributes, so its
   * `attributes.Arn` resolves statically and no fallback is needed.
   */
  resolveLambdaExecutionRoleArn?(functionPhysicalId: string): Promise<string | undefined>;
  /**
   * Optional: resolve a deployed AgentCore Runtime's execution-role ARN
   * via `bedrock-agentcore-control:GetAgentRuntime`'s `roleArn` field.
   *
   * Closes the bare `--assume-role` auto-resolve gap (issue #187) for
   * the common case where the Runtime's execution role is a sibling
   * resource in the same stack (`new bedrock.AgentCoreRuntime(...)` with
   * the L2's auto-created default execution role). `ListStackResources`
   * returns the role's NAME (PhysicalResourceId), not the ARN, so the
   * static state lookup in {@link resolveExecutionRoleArnFromState} (which
   * reads `attributes.Arn`) returns `undefined`. The runtime's own
   * deploy-time-resolved configuration is the lowest-cost way to recover
   * the ARN — same shape as
   * {@link LocalStateProvider.resolveLambdaExecutionRoleArn}, one extra
   * `bedrock-agentcore-control:GetAgentRuntime` call.
   *
   * `runtimePhysicalId` is the deployed runtime's `agentRuntimeId` (the
   * `Ref` value `ListStackResources` returns for
   * `AWS::BedrockAgentCore::Runtime`).
   * Returns `undefined` on any expected miss (no such runtime, access
   * denied, throttling) so the caller falls back to the existing
   * "Pass the ARN explicitly: --assume-role <arn>" warning.
   *
   * Implemented only by the CFn provider (`--from-cfn-stack`) — the S3
   * provider's state already carries deploy-time attributes, so its
   * `attributes.Arn` resolves statically and no fallback is needed.
   */
  resolveAgentCoreRuntimeRoleArn?(runtimePhysicalId: string): Promise<string | undefined>;
  /**
   * Optional: resolve a synthesized stack template's SSM-backed
   * `Parameters` (`AWS::SSM::Parameter::Value<String>` /
   * `AWS::SSM::Parameter::Value<List<String>>`, what CDK synthesizes for
   * `ssm.StringParameter.valueForStringParameter(...)`) into a
   * `parameterLogicalId -> value` map by reading each parameter's SSM
   * name (from the template entry's `Default`) out of SSM Parameter
   * Store. `List<String>` values are surfaced comma-joined.
   *
   * The returned `values` map is fed into the substitution context's
   * `parameters` field so a `Ref` to such a parameter resolves to the value
   * instead of being dropped — these parameters are CloudFormation
   * PARAMETERS, not resources, so they never appear in the `load()`
   * resource map (built from `ListStackResources`). The returned
   * `secureStringLogicalIds` flags the decrypted `SecureString` parameters
   * so the consuming env keys are kept off the `docker run` argv (#99).
   *
   * Implemented only by the CFn provider (`--from-cfn-stack`) — it owns
   * the region / credential context the SSM read needs, the same one its
   * `CloudFormationClient` uses. Returns an empty map when the template
   * declares no SSM-backed parameters, and is best-effort: an SSM failure
   * logs a warn and returns whatever it could resolve (possibly nothing)
   * so the caller falls back to warn-and-drop. Never throws.
   *
   * Note: SSM parameter VALUES land in the local container env (env-var
   * substitution). Callers must never log the values.
   */
  resolveTemplateSsmParameters?(template: CloudFormationTemplate): Promise<ResolvedSsmParameters>;
  /**
   * Optional: return a single-line description of the most recent
   * `load()` failure (if any), suitable for embedding verbatim in a
   * downstream resolver error. Used by image / env / secret resolvers
   * to flip the "pass --from-cfn-stack" hint into a more accurate
   * "the state-source attempt failed: ..." remedy — the user who
   * already passed `--from-cfn-stack` should see what AWS actually
   * returned, not a suggestion to pass the flag again.
   *
   * Implementations that do not track failure detail may omit this
   * method; callers gracefully fall back to the original generic
   * remedy when the return is `undefined` or the method is missing.
   * Implementations that DO track failure detail should reset their
   * recorded message when a subsequent `load()` succeeds, so the
   * getter only returns the message tied to the latest call.
   */
  getLastLoadError?(): string | undefined;
  /**
   * Release any AWS clients the provider owns. Always called by the
   * CLI layer in the outer `finally`. Idempotent.
   */
  dispose(): void;
}
