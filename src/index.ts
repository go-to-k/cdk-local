/**
 * cdk-local — public API surface.
 *
 * Hosts embedding `cdk-local` (e.g. cdkd, which injects its own
 * S3-backed `LocalStateProvider` via `extraStateProviders`) consume the
 * Commander factories below + the supporting types and helpers.
 */

export {
  createLocalInvokeCommand,
  type CreateLocalInvokeCommandOptions,
} from './cli/commands/local-invoke.js';
export {
  createLocalInvokeAgentCoreCommand,
  type CreateLocalInvokeAgentCoreCommandOptions,
} from './cli/commands/local-invoke-agentcore.js';
export {
  createLocalStartApiCommand,
  type CreateLocalStartApiCommandOptions,
} from './cli/commands/local-start-api.js';
export {
  createLocalRunTaskCommand,
  type CreateLocalRunTaskCommandOptions,
} from './cli/commands/local-run-task.js';
export {
  createLocalStartServiceCommand,
  type CreateLocalStartServiceCommandOptions,
} from './cli/commands/local-start-service.js';
export {
  createLocalStartAlbCommand,
  type CreateLocalStartAlbCommandOptions,
} from './cli/commands/local-start-alb.js';
export {
  createLocalListCommand,
  formatTargetListing,
  type CreateLocalListCommandOptions,
  type FormatTargetListingOptions,
} from './cli/commands/local-list.js';

/**
 * Target enumeration — turns a synthesized Cloud Assembly into the
 * runnable targets each `cdkl` command accepts, grouped by command.
 * Backs `cdkl list` and is reusable for interactive target pickers.
 */
export {
  listTargets,
  countTargets,
  type TargetEntry,
  type TargetListing,
} from './local/target-lister.js';

export {
  createLocalStateProvider,
  isCfnFlagPresent,
  rejectExplicitCfnStackWithMultipleStacks,
  resolveCfnRegion,
  resolveCfnFallbackRegion,
  resolveCfnStackName,
  LocalStateSourceError,
  type ExtraStateProviders,
  type LocalStateProviderFactory,
  type LocalStateSourceOptions,
} from './cli/commands/local-state-source.js';

export type { CdkLocalEmbedConfig } from './local/embed-config.js';
/**
 * Embed-config setter / getter / reset. A host that does NOT use cdk-local's
 * Commander factories (which install the config themselves) but DOES re-export
 * cdk-local's leaf modules as shims must call `setEmbedConfig(...)` once at
 * startup so those bundled modules render the host's branding (`cliName` /
 * `resourceNamePrefix` / etc.) instead of cdk-local's `cdkl` defaults.
 * `getEmbedConfig` reads the resolved config; `resetEmbedConfig` restores the
 * defaults (test isolation).
 */
export { getEmbedConfig, resetEmbedConfig, setEmbedConfig } from './local/embed-config.js';

export type { LocalStateProvider, LocalStateRecord } from './local/local-state-provider.js';
export {
  substituteAgainstState,
  substituteAgainstStateAsync,
  substituteEnvVarsFromState,
  substituteEnvVarsFromStateAsync,
  type CrossStackResolver,
  type SubstitutionContext,
  type StateEnvSubstitutionAudit,
  type PseudoParameters,
} from './local/state-resolver.js';

export {
  CfnLocalStateProvider,
  type CfnLocalStateProviderOptions,
} from './local/cfn-local-state-provider.js';

export {
  collectSsmParameterRefs,
  resolveSsmParameters,
  type SsmParameterRef,
  type ResolvedSsmParameters,
} from './local/ssm-parameter-resolver.js';

// Low-level local-execution building blocks are intentionally NOT
// re-exported here; they live behind the `cdk-local/internal` subpath
// (`src/internal.ts`) and carry no semver guarantee. Shim hosts (e.g.
// cdkd) import them from `cdk-local/internal` directly.
