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
   * and the hyphen-free Cognito user-pool placeholder id. Default
   * `'cdkl'`; cdkd passes `'cdkd'`.
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
   * volume, network, image-tag, tmpdir names, STS `RoleSessionName`s, the
   * local request id, and the example Cloud Map namespace. Default
   * `'cdkl'`; cdkd passes `'cdkd-local'`.
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
}

export interface ResolvedEmbedConfig {
  cliName: string;
  binaryName: string;
  productName: string;
  resourceNamePrefix: string;
  awsBindMountPath: string;
  envPrefix: string;
}

const DEFAULTS: ResolvedEmbedConfig = {
  cliName: 'cdkl',
  binaryName: 'cdkl',
  productName: 'cdk-local',
  resourceNamePrefix: 'cdkl',
  awsBindMountPath: '/cdk-local-aws',
  envPrefix: 'CDKL',
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
