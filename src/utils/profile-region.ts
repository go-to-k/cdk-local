import { STSClient } from '@aws-sdk/client-sts';

/**
 * Resolve the AWS region the SDK would pick for a named profile (the
 * profile's `region` in `~/.aws/config`, honoring the standard
 * env / config chain) WITHOUT resolving credentials.
 *
 * cdk-local already passes `--profile` straight to the AWS SDK clients
 * for CREDENTIALS, but the `--from-cfn-stack` region resolution
 * (`resolveCfnRegion`) only consults `--stack-region` / `--region` /
 * `AWS_REGION` / `AWS_DEFAULT_REGION` / the synth-derived stack region.
 * A profile that carries a `region` (e.g. `region = ap-northeast-1`)
 * was therefore ignored, so `cdkl ... --from-cfn-stack --profile <p>`
 * against an env-agnostic stack failed with "requires a region to query
 * CloudFormation" even though `aws cloudformation ... --profile <p>`
 * would have used the profile's region.
 *
 * Uses the same SDK region provider as
 * `resolveProfileCredentials` (an STS client's resolved `config.region`)
 * so the fallback region matches what the CFn client itself would pick
 * for the profile. Best-effort: returns `undefined` when no profile is
 * given, or the region cannot be resolved (no profile region and no
 * `AWS_REGION` / `AWS_DEFAULT_REGION` env) — the caller then falls
 * through to its existing "no region" handling.
 */
export async function resolveProfileRegion(
  profile: string | undefined
): Promise<string | undefined> {
  if (profile === undefined || profile === '') return undefined;
  const sts = new STSClient({ profile });
  try {
    const regionProvider = sts.config.region;
    const resolved = typeof regionProvider === 'function' ? await regionProvider() : regionProvider;
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  } finally {
    sts.destroy();
  }
}
