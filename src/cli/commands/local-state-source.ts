/**
 * Single-source-of-truth helper that picks a {@link LocalStateProvider}
 * for the `cdkl *` command family from CLI flags.
 *
 * Built-in flag (always wired):
 *
 *   - `--from-cfn-stack [<cfn-stack-name>]` — CFn-backed; reads a
 *     deployed CloudFormation stack via `DescribeStackResources`.
 *
 * Host-extensible state sources (via the `extraStateProviders` option):
 *
 *   - Hosts embedding cdk-local can register additional `LocalStateProvider`
 *     factories that respond to their own CLI flags (e.g. cdkd's
 *     `--from-state` for S3-backed cdkd state). Each entry is keyed by
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
 *     > the synth-derived stack region.
 *
 * Returns `undefined` when no state-source flag is set — the caller
 * skips the substitution pass entirely.
 */

import { CfnLocalStateProvider } from '../../local/cfn-local-state-provider.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';

/**
 * Options each `cdkl` command gathers from its flag set. The built-in
 * `--from-cfn-stack` flag is always present; the host may add fields
 * for its own `extraStateProviders` entries (e.g. `fromState: boolean`
 * for the cdkd shim's `--from-state`).
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
 * Factory function signature for a host-supplied state provider. The
 * dispatcher invokes the matching factory with the full parsed options
 * bag so the factory can read its own option fields directly.
 */
export type LocalStateProviderFactory = (options: LocalStateSourceOptions) => LocalStateProvider;

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
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    synthRegion;
  if (region === undefined) {
    throw new LocalStateSourceError(
      '--from-cfn-stack requires a region to query CloudFormation. ' +
        'Set one of: --stack-region <region>, --region <region>, AWS_REGION env var, AWS_DEFAULT_REGION env var, or an env.region on the target CDK stack.'
    );
  }
  return region;
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
      'Use bare --from-cfn-stack (each stack uses its own name as the CFn stack name) or run one cdkl invocation per stack.'
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
 * state sources (e.g. cdkd's `--from-state` / `S3LocalStateProvider`).
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
  extraStateProviders?: ExtraStateProviders
): LocalStateProvider | undefined {
  const cfnStackOpt = options.fromCfnStack;
  const cfnFlagPresent = isCfnFlagPresent(options);

  // Mutual-exclusion: count active state sources. Both --from-cfn-stack
  // and every host-registered extra flag (e.g. cdkd's --from-state) are
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
  // SDK's `DescribeStackResources({ StackName: '' })` rejects with a
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
    return new CfnLocalStateProvider({
      cfnStackName,
      region,
      ...(options.profile !== undefined && { profile: options.profile }),
    });
  }

  if (activeExtras.length === 1) {
    const key = activeExtras[0]!;
    const factory = extraStateProviders![key]!;
    return factory(options);
  }

  return undefined;
}

/** Convert a camel-case option field name to its `--kebab-case` flag form. */
function toFlagName(field: string): string {
  return '--' + field.replace(/([A-Z])/g, '-$1').toLowerCase();
}
