import { STSClient } from '@aws-sdk/client-sts';

/**
 * Resolve `--profile <p>` to a concrete credential set AND the profile's
 * configured region. Shared across every `cdkl` subcommand
 * (`invoke` / `start-api` / `run-task` / `start-service` / `start-alb` /
 * `invoke-agentcore`) so the credential-resolution behavior is byte-for-byte
 * uniform — previously the per-command resolvers drifted (issue #245: the
 * `invoke` copy returned the credential triple only, leaking the profile's
 * `region` and forcing handlers' ambient-region SDK calls to fail with
 * "Region is missing" locally).
 *
 * Drives the SDK's default credential provider chain (SSO / IAM Identity
 * Center / `fromIni` / role-assumption profiles all handled uniformly —
 * the same chain that resolves `--profile` for the host's own AWS SDK
 * clients).
 *
 * Region resolution is best-effort: a profile with no `region =` (and no
 * `AWS_REGION` / `AWS_DEFAULT_REGION` env) yields `region: undefined`
 * rather than throwing — a missing region is not a missing-credentials
 * error. The caller layers this region behind other sources via
 * `resolveContainerFallbackRegion`.
 */
export async function resolveProfileCredentials(profile: string): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}> {
  const sts = new STSClient({ profile });
  try {
    const credsProvider = sts.config.credentials;
    const creds = typeof credsProvider === 'function' ? await credsProvider() : credsProvider;
    if (!creds || !creds.accessKeyId || !creds.secretAccessKey) {
      throw new Error(
        `--profile '${profile}': credential provider chain resolved without usable credentials. ` +
          'Check `aws sso login --profile ' +
          profile +
          '` for SSO profiles, or `~/.aws/credentials` / `~/.aws/config` for regular profiles.'
      );
    }
    let region: string | undefined;
    try {
      const regionProvider = sts.config.region;
      const resolved =
        typeof regionProvider === 'function' ? await regionProvider() : regionProvider;
      if (typeof resolved === 'string' && resolved.length > 0) region = resolved;
    } catch (err) {
      // Profile has no region configured (and no AWS_REGION env) — leave
      // undefined; the container falls through to the next region source.
      //
      // BUT: don't swallow real auth / IMDS errors (SSO token expiry,
      // ConfigurationError, NetworkingError) under this no-region
      // umbrella. Those should propagate so the caller sees the actual
      // problem instead of a misleading fall-through to "no region".
      const msg = err instanceof Error ? err.message : String(err);
      const isMissingRegionError =
        /region is missing/i.test(msg) ||
        /could not resolve region/i.test(msg) ||
        /no region in config/i.test(msg) ||
        /region.*not.*set/i.test(msg);
      if (!isMissingRegionError) throw err;
      region = undefined;
    }
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken && { sessionToken: creds.sessionToken }),
      ...(region && { region }),
    };
  } finally {
    sts.destroy();
  }
}

/**
 * Build the constructor config for an `STSClient` that honors both
 * `--region` and `--profile`. Every STS-touching site in the codebase
 * (`GetCallerIdentity` for `${AWS::AccountId}` resolution, `AssumeRole`
 * for `--assume-role`, etc.) must use this helper so a future site can
 * never silently drop the `--profile` plumbing — the historical pattern
 * `new STSClient({ ...(region && { region }) })` ignored `--profile`,
 * which is exactly the issue #245 relapse-prone shape.
 *
 * Returns a fresh object each call so callers can spread additional
 * fields (custom `requestHandler`, `maxAttempts`, etc.) without
 * mutating a shared default.
 */
export function buildStsClientConfig(args: {
  region?: string | undefined;
  profile?: string | undefined;
}): { region?: string; profile?: string } {
  return {
    ...(args.region && { region: args.region }),
    ...(args.profile && { profile: args.profile }),
  };
}
