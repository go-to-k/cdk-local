/**
 * Single-source-of-truth helper that picks a {@link LocalStateProvider}
 * for the `cdkl *` command family from CLI flags.
 *
 * Built-in flag (always wired):
 *
 *   - `--from-cfn-stack [<cfn-stack-name>]` — CFn-backed; reads a
 *     deployed CloudFormation stack via `ListStackResources`.
 *
 * Host-extensible state sources (via the `extraStateProviders` option):
 *
 *   - Hosts embedding cdk-local can register additional `LocalStateProvider`
 *     factories that respond to their own CLI flags (e.g. a host-registered
 *     `--from-state` backed by an S3 state store). Each entry is keyed by
 *     the camel-case Commander option name (e.g. `'fromState'`) so the
 *     dispatcher reads the corresponding boolean / string off the parsed
 *     options bag.
 *
 * This module centralizes:
 *
 *   - The mutual-exclusion check across `--from-cfn-stack` and every
 *     registered extra state-provider flag.
 *   - The bare-vs-explicit `--from-cfn-stack` resolution: bare flag uses
 *     the stack name from synthesis; an explicit value overrides.
 *   - Region resolution for the CFn client: precedence
 *     `--stack-region` > `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION`
 *     > the synth-derived stack region > the `--profile`'s configured
 *     region (see {@link resolveCfnFallbackRegion}).
 *
 * Returns `undefined` when no state-source flag is set — the caller
 * skips the substitution pass entirely.
 */

import { CfnLocalStateProvider } from '../../local/cfn-local-state-provider.js';
import { createMixedModeStateProvider } from '../../local/aws-emulator-mixed-mode.js';
import { getActiveWorkloadAwsWiring } from '../../local/workload-aws-wiring.js';
import { awsEmulatorRealServices, type AwsEmulatorWorkload } from '../../utils/aws-proxy.js';
import { getEmbedConfig } from '../../local/embed-config.js';
import { resolveProfileRegion } from '../../utils/profile-region.js';
import { namedEnvAwsRegion, regionOrAmbientDefault } from '../../utils/ambient-default-region.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';

/**
 * Options each `cdkl` command gathers from its flag set. The built-in
 * `--from-cfn-stack` flag is always present; the host may add fields
 * for its own `extraStateProviders` entries (e.g. `fromState: boolean`
 * for a host's `--from-state` shim).
 */
export interface LocalStateSourceOptions {
  /**
   * `--from-cfn-stack` flag value. Commander maps:
   *   - flag absent → `undefined`
   *   - `--from-cfn-stack` (bare) → `true`
   *   - `--from-cfn-stack <name>` → `'<name>'`
   */
  fromCfnStack?: string | boolean;
  /** Inherited `--region`. */
  region?: string;
  /** Inherited `--profile`. */
  profile?: string;
  /**
   * Inherited `--stack-region`. Used by `--from-cfn-stack` as the CFn
   * client's region. When unset, the helper falls back to `--region` >
   * `AWS_REGION` > `AWS_DEFAULT_REGION` > the synth-derived stack region.
   */
  stackRegion?: string;
  /** Arbitrary host-injected fields read by `extraStateProviders` factories. */
  [key: string]: unknown;
}

/**
 * What the caller of {@link createLocalStateProvider} asks of the provider.
 * Passed through to a host factory unchanged (go-to-k/cdk-local#892).
 */
export interface LocalStateProviderBehavior {
  /**
   * The one workload the names are resolved for. In mixed mode the services
   * excepted to real AWS are then that workload's own (`Parameters` plus its
   * own `--env-vars` sections), as its runtime calls go; without it, the
   * `Parameters` ones.
   */
  workload?: AwsEmulatorWorkload | undefined;
}

/**
 * Factory function signature for a host-supplied state provider. The
 * dispatcher invokes the matching factory with the full parsed options
 * bag so the factory can read its own option fields directly, and with the
 * caller's {@link LocalStateProviderBehavior} (an empty object when the
 * caller asked for nothing): a host provider that resolves per service in
 * mixed mode honors `workload` the way `--from-cfn-stack` does.
 */
export type LocalStateProviderFactory = (
  options: LocalStateSourceOptions,
  behavior: LocalStateProviderBehavior
) => LocalStateProvider;

/**
 * Registry of host-supplied state-provider factories.
 *
 * Each key is the camel-case Commander option name (e.g. `'fromState'`)
 * that the dispatcher should treat as "this state source is active when
 * the corresponding option field is truthy". When activated, the
 * dispatcher invokes the factory and returns its result.
 */
export type ExtraStateProviders = Record<string, LocalStateProviderFactory>;

/**
 * Default stack name → CFn stack name resolution. Bare `--from-cfn-stack`
 * uses the cdkl stack name verbatim as the CFn stack name (typical for
 * CDK apps where the names match). Override by passing
 * `--from-cfn-stack <explicit-name>`.
 *
 * Exported for unit testing.
 */
export function resolveCfnStackName(fromCfnStack: string | boolean, stackName: string): string {
  if (typeof fromCfnStack === 'string') return fromCfnStack;
  return stackName;
}

/**
 * Single source of truth for "is the user asking for `--from-cfn-stack`?".
 * Commander maps the flag to one of `undefined` (absent) / `true` (bare) /
 * `'<name>'` (explicit). Everything except `undefined` / `false` means
 * the flag is present.
 *
 * Exported for use by `cdkl start-api` and unit testing.
 */
export function isCfnFlagPresent(opts: Pick<LocalStateSourceOptions, 'fromCfnStack'>): boolean {
  const v = opts.fromCfnStack;
  return v !== undefined && v !== false;
}

/**
 * True when at least one host-registered extra state-provider flag (e.g. a
 * host's `--from-state`) is set in the options bag — the same activation test
 * {@link createLocalStateProvider} applies (`options[key]` truthy).
 */
export function hasExtraStateProviderActive(
  options: object,
  extraStateProviders: ExtraStateProviders | undefined
): boolean {
  if (!extraStateProviders) return false;
  const bag = options as Record<string, unknown>;
  return Object.keys(extraStateProviders).some((key) => Boolean(bag[key]));
}

/**
 * True when ANY state source is active: `--from-cfn-stack` or a
 * host-registered extra provider. A command that gates a state-backed path
 * on {@link isCfnFlagPresent} alone leaves a host's provider registered but
 * unreachable (go-to-k/cdk-local#699).
 */
export function isStateSourceActive(
  options: Pick<LocalStateSourceOptions, 'fromCfnStack'>,
  extraStateProviders: ExtraStateProviders | undefined
): boolean {
  return isCfnFlagPresent(options) || hasExtraStateProviderActive(options, extraStateProviders);
}

/**
 * The `--flag` naming the active state source, for a log line that says where
 * a value came from. `undefined` when no state source is active.
 */
export function activeStateSourceFlag(
  options: Pick<LocalStateSourceOptions, 'fromCfnStack'>,
  extraStateProviders: ExtraStateProviders | undefined
): string | undefined {
  if (isCfnFlagPresent(options)) return '--from-cfn-stack';
  if (!extraStateProviders) return undefined;
  const bag = options as Record<string, unknown>;
  const key = Object.keys(extraStateProviders).find((k) => Boolean(bag[k]));
  return key === undefined ? undefined : toFlagName(key);
}

/**
 * Every state-source flag a command accepts, for a message telling the user
 * which flag enables a state-backed path: `--from-cfn-stack`, then each host
 * flag in registration order.
 */
export function stateSourceFlagNames(
  extraStateProviders: ExtraStateProviders | undefined
): string[] {
  return ['--from-cfn-stack', ...Object.keys(extraStateProviders ?? {}).map(toFlagName)];
}

/**
 * The host's own option fields to carry onto an options bag a command rebuilds
 * from an allow-list before handing it to {@link createLocalStateProvider}
 * (directly or through `resolveLambdaContainerEnv`). The dispatcher activates
 * an extra provider only when `options[key]` is truthy, and the provider's
 * factory reads its companion fields (a host's `--state-bucket`, say) from the
 * same bag, so an allow-list that names only cdk-local's own keys registers the
 * provider and never selects it. With no extra providers registered this is
 * empty, so the standalone CLI's bag is unchanged. Spread it FIRST so the
 * caller's explicit keys still win.
 */
export function hostStateSourceFields(
  options: object,
  extraStateProviders: ExtraStateProviders | undefined
): Record<string, unknown> {
  if (!extraStateProviders || Object.keys(extraStateProviders).length === 0) return {};
  return { ...(options as Record<string, unknown>) };
}

/**
 * Resolve the region used for the CFn client. The CFn provider is
 * region-bound at construction time; we apply the precedence chain
 * `--stack-region` > `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION`
 * > the synth-derived stack region. Throws `LocalStateSourceError`
 * when none of these signals is set — the CFn API call needs a
 * concrete region and silently picking `us-east-1` would query the
 * wrong stack environment.
 *
 * Exported for unit testing.
 */
export function resolveCfnRegion(
  options: Pick<LocalStateSourceOptions, 'stackRegion' | 'region'>,
  synthRegion: string | undefined
): string {
  const region =
    options.stackRegion ??
    options.region ??
    namedEnvAwsRegion() ??
    process.env['AWS_DEFAULT_REGION'] ??
    regionOrAmbientDefault(synthRegion);
  if (region === undefined) {
    throw new LocalStateSourceError(
      '--from-cfn-stack requires a region to query CloudFormation. ' +
        'Set one of: --stack-region <region>, --region <region>, AWS_REGION env var, AWS_DEFAULT_REGION env var, or an env.region on the target CDK stack.'
    );
  }
  return region;
}

/**
 * Compute the lowest-precedence region fallback for the CFn state
 * provider and pass the result as the `synthRegion` argument to
 * {@link createLocalStateProvider}. The synth-derived stack region wins
 * when present; otherwise — and only when `--from-cfn-stack` is active —
 * the `--profile`'s configured region is used so an env-agnostic stack
 * (no `env.region`) is still queryable via `--profile <p>` alone, the
 * same way `aws cloudformation ... --profile <p>` resolves region from
 * the profile.
 *
 * {@link resolveCfnRegion}'s precedence (`--stack-region` > `--region` >
 * `AWS_REGION` > `AWS_DEFAULT_REGION` > this fallback) is preserved: the
 * profile region only matters when every higher-priority signal is
 * absent.
 *
 * Async because reading the profile region touches the shared config
 * files; the public sync `resolveCfnRegion` / `createLocalStateProvider`
 * signatures are intentionally left unchanged so embedding hosts are not
 * forced to adopt an async region resolver.
 */
export async function resolveCfnFallbackRegion(
  options: Pick<LocalStateSourceOptions, 'fromCfnStack' | 'profile'>,
  synthRegion: string | undefined
): Promise<string | undefined> {
  if (synthRegion !== undefined) return synthRegion;
  if (!isCfnFlagPresent(options)) return undefined;
  return resolveProfileRegion(options.profile);
}

/**
 * Common error class for the mutual-exclusion check so the CLI layer
 * can surface a consistent error message from every command.
 */
export class LocalStateSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStateSourceError';
  }
}

/**
 * Pre-flight check for `--from-cfn-stack <explicit-name>` when the
 * caller will construct one provider per routed stack (e.g.
 * `cdkl start-api` / `cdkl start-service`). An explicit value applies
 * to the SINGLE CFn stack named — when multiple stacks are routed,
 * every one of them would query the same CFn stack, yielding silent
 * wrong-physical-id substitutions for any logical id that happens to
 * collide between the user's stacks. Reject at the CLI layer instead.
 *
 * Bare `--from-cfn-stack` (the stack-name-default) is fine for
 * multi-stack: each routed stack reads its own CFn counterpart.
 */
export function rejectExplicitCfnStackWithMultipleStacks(
  options: Pick<LocalStateSourceOptions, 'fromCfnStack'>,
  routedStackCount: number
): void {
  if (routedStackCount <= 1) return;
  if (typeof options.fromCfnStack !== 'string') return;
  throw new LocalStateSourceError(
    `--from-cfn-stack <name> cannot be used with multiple routed stacks (got ${routedStackCount}). ` +
      'An explicit CFn stack name applies to one stack only and would silently mismap logical IDs across siblings. ' +
      `Use bare --from-cfn-stack (each stack uses its own name as the CFn stack name) or run one ${getEmbedConfig().binaryName} invocation per stack.`
  );
}

/**
 * Pick and construct the right `LocalStateProvider` for the supplied
 * flag set. Returns `undefined` when no state-source flag is set
 * (caller skips the substitution pass). Throws `LocalStateSourceError`
 * when more than one state-source is active (mutually exclusive —
 * different sources, asking for several is ambiguous about precedence).
 *
 * `stackName` is the cdkl-side stack name the command resolved to its
 * target — needed for the bare-`--from-cfn-stack` default. `synthRegion`
 * is the synth-derived stack region (`env.region` on the CDK stack) —
 * fallback for the CFn client when no explicit region override is set.
 *
 * `extraStateProviders` is the host-supplied registry of additional
 * state sources (e.g. a host's `--from-state` / S3-backed provider).
 * Each entry's key is the camel-case Commander option name; the
 * dispatcher activates the matching factory when the corresponding
 * options field is truthy.
 *
 * For multi-stack callers (`cdkl start-api` / `cdkl start-service`)
 * also invoke `rejectExplicitCfnStackWithMultipleStacks` BEFORE the
 * per-stack loop.
 */
export function createLocalStateProvider(
  options: LocalStateSourceOptions,
  stackName: string,
  synthRegion: string | undefined,
  extraStateProviders?: ExtraStateProviders,
  /** {@link LocalStateProviderBehavior}; also handed to a host factory. */
  behavior: LocalStateProviderBehavior = {}
): LocalStateProvider | undefined {
  const cfnStackOpt = options.fromCfnStack;
  const cfnFlagPresent = isCfnFlagPresent(options);

  // Mutual-exclusion: count active state sources. Both --from-cfn-stack
  // and every host-registered extra flag (e.g. a host's --from-state) are
  // counted; the user must pick exactly one.
  const activeExtras: string[] = [];
  if (extraStateProviders) {
    for (const key of Object.keys(extraStateProviders)) {
      if (options[key]) {
        activeExtras.push(key);
      }
    }
  }
  if (cfnFlagPresent && activeExtras.length > 0) {
    throw new LocalStateSourceError(
      `--from-cfn-stack is mutually exclusive with ${activeExtras.map(toFlagName).join(', ')}. ` +
        'Pick one state source.'
    );
  }
  if (activeExtras.length > 1) {
    throw new LocalStateSourceError(
      `state-source flags are mutually exclusive: ${activeExtras.map(toFlagName).join(', ')}. ` +
        'Pick one.'
    );
  }

  // Reject empty `--from-cfn-stack ""`. Letting it through would
  // construct a `CfnLocalStateProvider` with `cfnStackName: ''` and the
  // SDK's `ListStackResources({ StackName: '' })` rejects with a
  // generic ValidationError far from the call site. Reject at the
  // dispatcher with a clear remediation message instead.
  if (cfnStackOpt === '') {
    throw new LocalStateSourceError(
      '--from-cfn-stack requires a non-empty stack name when an explicit value is provided. ' +
        'Drop the value to use the resolved stack name, or pass --from-cfn-stack <name>.'
    );
  }

  if (cfnFlagPresent) {
    const cfnStackName = resolveCfnStackName(cfnStackOpt as string | boolean, stackName);
    const region = resolveCfnRegion(options, synthRegion);
    const real = new CfnLocalStateProvider({
      cfnStackName,
      region,
      ...(options.profile !== undefined && { profile: options.profile }),
      // An SSM-backed template parameter follows this workload's SSM route.
      ...(behavior.workload !== undefined && { workload: behavior.workload }),
    });
    // Mixed mode (a "real-aws" exception in --env-vars): resources of the
    // excepted services resolve from the stack deployed to real AWS, the rest
    // from the stack deployed into AWS Emulator. Outside it, `real` is the
    // only side: under --aws-emulator alone its clients read the emulator.
    const mixed = getActiveWorkloadAwsWiring()?.mixed;
    if (!mixed) return real;
    const emulator = new CfnLocalStateProvider({
      cfnStackName,
      region,
      endpointOverride: mixed.emulatorClientOverride,
      label: '--from-cfn-stack (AWS Emulator)',
    });
    // No routing installed (a host that skipped it): except nothing, so names
    // fail closed to the emulator rather than to the run-wide union.
    const realServices = awsEmulatorRealServices(behavior.workload) ?? [];
    // A workload with no exception of its own reads every name from the emulator.
    if (realServices.length === 0) {
      real.dispose();
      return emulator;
    }
    return createMixedModeStateProvider({ emulator, real, realServices });
  }

  if (activeExtras.length === 1) {
    const key = activeExtras[0]!;
    const factory = extraStateProviders![key]!;
    return factory(options, behavior);
  }

  return undefined;
}

/**
 * The {@link AwsEmulatorWorkload} no `--env-vars` section names: in AWS
 * Emulator mixed mode its excepted services are the `Parameters` exceptions
 * alone. A multi-workload command resolves its shared names (and every
 * workload {@link groupWorkloadsRoutedApart} does not return) for it.
 */
export const UNNAMED_WORKLOAD: AwsEmulatorWorkload = Object.freeze({});

/** One group of {@link groupWorkloadsRoutedApart}. */
export interface WorkloadRouteGroup<T> {
  /** The services the group excepts to real AWS, sorted (every other one goes to AWS Emulator). */
  realServices: string[];
  /** A workload of the group: pass it as `behavior.workload`. */
  workload: AwsEmulatorWorkload;
  items: T[];
}

/**
 * AWS Emulator mixed mode in a command serving several workloads
 * (go-to-k/cdk-local#905): the `items` whose workload excepts a different set
 * of services to real AWS (`Parameters` plus its own `--env-vars` sections) than
 * {@link UNNAMED_WORKLOAD}, grouped by that set. Each group resolves its names
 * with its own provider (`createLocalStateProvider(..., { workload })`), so a
 * workload never reads an emulator name for a service its runtime sends to
 * real AWS, or the reverse. Empty outside mixed mode, and when no section
 * changes the set.
 */
export function groupWorkloadsRoutedApart<T>(
  items: readonly T[],
  workloadOf: (item: T) => AwsEmulatorWorkload
): WorkloadRouteGroup<T>[] {
  const base = awsEmulatorRealServices(UNNAMED_WORKLOAD);
  if (base === undefined) return [];
  const baseKey = base.join(',');
  const groups = new Map<string, WorkloadRouteGroup<T>>();
  for (const item of items) {
    const workload = workloadOf(item);
    const realServices = awsEmulatorRealServices(workload) ?? base;
    const key = realServices.join(',');
    if (key === baseKey) continue;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { realServices, workload, items: [item] });
  }
  return [...groups.values()];
}

/** Convert a camel-case option field name to its `--kebab-case` flag form. */
function toFlagName(field: string): string {
  return '--' + field.replace(/([A-Z])/g, '-$1').toLowerCase();
}
