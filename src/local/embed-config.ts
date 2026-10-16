/**
 * Embed-time branding configuration.
 *
 * cdk-local hardcodes its own branding (`cdkl` binary, `cdk-local`
 * product name, `cdkl-*` Docker / AWS resource names, `/cdk-local-aws`
 * credential bind-mount) into user-visible error messages and resource
 * identifiers. A host that embeds cdk-local's Commander factories (e.g.
 * cdkd, whose binary is `cdkd` and whose subcommand group is
 * `cdkd local`) passes a {@link CdkLocalEmbedConfig} so those strings
 * read in the host's own branding instead.
 *
 * The four command factories call {@link setEmbedConfig} before building
 * their Commander option tree, so both construction-time strings (option
 * descriptions / defaults) and action-time strings (errors, resource
 * names) read the resolved config via {@link getEmbedConfig}. When no
 * config is supplied every field falls back to cdk-local's own defaults,
 * leaving native `cdkl` behavior byte-identical.
 */
/**
 * The logger surface a host hands cdk-local through
 * {@link CdkLocalEmbedConfig.logger}. Structurally a subset of cdk-local's own
 * `Logger`, so a host's logger with the usual four level methods plus
 * `setLevel` / `getLevel` fits without an adapter.
 */
export interface EmbedHostLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void;
  getLevel(): 'debug' | 'info' | 'warn' | 'error';
}

export interface CdkLocalEmbedConfig {
  /**
   * Command prefix for subcommand references in user-facing strings, e.g.
   * `${cliName} invoke` / `${cliName} start-api`. Default `'cdkl'`; cdkd
   * passes `'cdkd local'`.
   */
  cliName?: string;
  /**
   * Bare executable / process name for standalone references, e.g.
   * `${binaryName} is exiting` / `${binaryName} could not determine ...`,
   * the local request id, and the hyphen-free Cognito user-pool
   * placeholder id. Default `'cdkl'`; cdkd passes `'cdkd'`.
   */
  binaryName?: string;
  /**
   * Product name for prose references, e.g. `${productName} supports ...`.
   * Also seeds the profile-credentials tmpdir prefix. Default
   * `'cdk-local'`; cdkd passes `'cdkd'`.
   */
  productName?: string;
  /**
   * Prefix for generated Docker / AWS resource identifiers — container,
   * volume, network, image-tag, tmpdir names, STS `RoleSessionName`s, and
   * the example Cloud Map namespace. Default `'cdkl'`; cdkd passes
   * `'cdkd-local'`.
   */
  resourceNamePrefix?: string;
  /**
   * Container directory the host AWS shared-credentials file is
   * bind-mounted under. Default `'/cdk-local-aws'`; cdkd passes
   * `'/cdkd-aws'`.
   */
  awsBindMountPath?: string;
  /**
   * Prefix for the environment variables this CLI reads — `${envPrefix}_APP`
   * (the `--app` fallback) and `${envPrefix}_ROLE_ARN` (the `--role-arn`
   * fallback). Default `'CDKL'`; cdkd passes `'CDKD'`.
   */
  envPrefix?: string;
  /**
   * Whether this host fails-closed by default on unverifiable AWS_IAM SigV4
   * requests. cdk-local's default is warn-and-pass (`false`); a host like
   * cdkd that ships fail-closed-by-default passes `true`. Drives the polarity
   * of the SigV4 warn-message advice (whether the strictness flag reads as an
   * opt-IN or opt-OUT). Default `false`.
   */
  sigV4StrictByDefault?: boolean;
  /**
   * The CLI flag a user toggles to change SigV4 strictness. With
   * `sigV4StrictByDefault: false` it is an opt-IN flag (`'--strict-sigv4'`,
   * the default); with `sigV4StrictByDefault: true` it is the host's opt-OUT
   * flag (cdkd passes `'--allow-unverified-sigv4'`). Default `'--strict-sigv4'`.
   */
  sigV4OptFlag?: string;
  /**
   * The host's own logger. When set, every line cdk-local logs (from the
   * global logger and every `child()` logger) is handed to it UNFORMATTED
   * instead of being written to the console, and cdk-local's level reads and
   * `--verbose` level raises go to it too. The host therefore owns the stream
   * each level lands on, the level filter, and the formatting — so a host that
   * reserves stdout for a payload (a single-shot invoke piped to `jq`) can keep
   * cdk-local's progress lines off it, and a host's `--verbose` reaches the
   * debug lines cdk-local's own messages point at. A `child()` logger's
   * `[prefix]` is still prepended under debug. Default: unset (cdk-local's
   * console logger).
   */
  logger?: EmbedHostLogger;
  /**
   * Which identity resolves the emulated WORKLOAD's inputs once `--role-arn`
   * has assumed a role. `'role'` (the default, and standalone `cdkl`'s
   * contract) runs everything as the assumed role. `'caller'` keeps the role
   * for what it is for — synth, the ECR pull, a fromS3 code bundle — and
   * resolves the workload's inputs as the identity the process had BEFORE
   * the assume: the credential triple handed to a container, task secrets,
   * `{{resolve:...}}`, `--from-cfn-stack`, the
   * `--assume-role` / `--assume-task-role` / `--ecr-role-arn` /
   * `--layer-role-arn` hops, literal layer ARNs, and the CloudFront engine's
   * deployed reads. For a host whose `--role-arn` is a DEPLOY identity.
   *
   * The exception is `${AWS::AccountId}` (and the placeholder task-role
   * account): it names the DEPLOY account, so it resolves as the `--role-arn`
   * role even in caller mode, and cross-account values point where the stack
   * lives. Without the second argument of `recordAssumedRole` the
   * lookup falls back to `buildStsClientConfig`: the selected PROFILE's account
   * when a profile is set (the caller's account, the wrong one for a
   * cross-account role), else the default chain (the env, i.e. the role). So a
   * host that records its own assume should always pass the role triple.
   *
   * In caller mode the `--ecr-role-arn` / `--layer-role-arn` / `--assume-role`
   * hops are SIGNED by the caller, so a target role's trust policy must trust
   * the caller, not only the deploy role; the credentials those hops return
   * still do the pull / fetch.
   *
   * Bound: the caller snapshot lives in the process that assumed. A child
   * process spawned after the assume (`cdkl studio`'s runners) inherits the
   * role's triple and no snapshot, so this mode does not reach it.
   *
   * The host must mirror its `--profile` flag into `AWS_PROFILE`: several
   * workload sites receive no `profile` argument and read the selection from
   * the environment, so an unmirrored flag resolves the caller's pre-assume
   * identity there instead of the profile. See `src/utils/workload-identity.ts`. Default `'role'`.
   */
  workloadIdentity?: 'role' | 'caller';
}

export interface ResolvedEmbedConfig {
  cliName: string;
  binaryName: string;
  productName: string;
  resourceNamePrefix: string;
  awsBindMountPath: string;
  envPrefix: string;
  sigV4StrictByDefault: boolean;
  sigV4OptFlag: string;
  logger?: EmbedHostLogger;
  workloadIdentity: 'role' | 'caller';
}

const DEFAULTS: ResolvedEmbedConfig = {
  cliName: 'cdkl',
  binaryName: 'cdkl',
  productName: 'cdk-local',
  resourceNamePrefix: 'cdkl',
  awsBindMountPath: '/cdk-local-aws',
  envPrefix: 'CDKL',
  sigV4StrictByDefault: false,
  sigV4OptFlag: '--strict-sigv4',
  workloadIdentity: 'role',
};

let current: ResolvedEmbedConfig = DEFAULTS;

/**
 * Resolve and install the active embed config. Called once per command
 * factory with the host's overrides (or `undefined` for native cdkl
 * behavior). Idempotent: re-calling with the same overrides is a no-op,
 * which is why all four factories may safely set the same config.
 */
export function setEmbedConfig(config?: CdkLocalEmbedConfig): void {
  current = {
    cliName: config?.cliName ?? DEFAULTS.cliName,
    binaryName: config?.binaryName ?? DEFAULTS.binaryName,
    productName: config?.productName ?? DEFAULTS.productName,
    resourceNamePrefix: config?.resourceNamePrefix ?? DEFAULTS.resourceNamePrefix,
    awsBindMountPath: config?.awsBindMountPath ?? DEFAULTS.awsBindMountPath,
    envPrefix: config?.envPrefix ?? DEFAULTS.envPrefix,
    sigV4StrictByDefault: config?.sigV4StrictByDefault ?? DEFAULTS.sigV4StrictByDefault,
    sigV4OptFlag: config?.sigV4OptFlag ?? DEFAULTS.sigV4OptFlag,
    workloadIdentity: config?.workloadIdentity === 'caller' ? 'caller' : 'role',
    ...(config?.logger !== undefined && { logger: config.logger }),
  };
}

/** The active resolved embed config. */
export function getEmbedConfig(): ResolvedEmbedConfig {
  return current;
}

/** Restore cdk-local defaults. Primarily a test-isolation helper. */
export function resetEmbedConfig(): void {
  current = DEFAULTS;
}
