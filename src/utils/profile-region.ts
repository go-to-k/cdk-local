import { STSClient } from '@aws-sdk/client-sts';
import { firstUsableRegion } from '../local/dynamic-reference-resolver.js';
import { ambientDefaultRegion, namedEnvAwsRegion } from './ambient-default-region.js';
import { buildStsClientConfig } from './profile-resolver.js';

/**
 * The region an ECS task container gets as `AWS_REGION`, in the order a
 * deployed task would see it (go-to-k/cdk-local#925): `--region`, the host's
 * `AWS_REGION`, `AWS_DEFAULT_REGION`, `--stack-region` or the stack's own
 * `env.region`, the loaded state record's region, a host's ambient default
 * (`ambient-default-region.ts`, go-to-k/cdk-local#963), then the region the SDK
 * resolves for the profile (`--profile`, else `AWS_PROFILE` / `default` in
 * `~/.aws/config`). An env-agnostic stack's `unknown-region` placeholder is
 * skipped, and the result is folded to lower case, AWS's only spelling of a
 * region. `undefined` when nothing names one: the container then stays
 * region-less, and its SDK's own "Region is missing" is the right signal.
 */
export async function resolveContainerRegion(sources: {
  region?: string | undefined;
  stackRegion?: string | undefined;
  stateRegion?: string | undefined;
  profile?: string | undefined;
}): Promise<string | undefined> {
  const named = firstUsableRegion(
    sources.region,
    namedEnvAwsRegion(),
    process.env['AWS_DEFAULT_REGION'],
    sources.stackRegion,
    sources.stateRegion,
    ambientDefaultRegion()
  );
  if (named) return named.toLowerCase();
  const fromProfile = firstUsableRegion(await resolveSdkDefaultRegion(sources.profile));
  return fromProfile?.toLowerCase();
}

/**
 * Give a Lambda-shaped container its region: BOTH `AWS_REGION` and
 * `AWS_DEFAULT_REGION`, as the Lambda service sets both. Writing only the
 * first would leave a forwarded host `AWS_DEFAULT_REGION` naming another
 * region beside it, and boto3 reads the second (go-to-k/cdk-local#926). A
 * no-op for an absent region.
 */
export function setContainerRegion(env: Record<string, string>, region: string | undefined): void {
  if (!region) return;
  env['AWS_REGION'] = region;
  env['AWS_DEFAULT_REGION'] = region;
}

/**
 * The region the SDK's default provider chain resolves for `profile`, or for
 * the default profile (`AWS_PROFILE`, else `default`) when none is given.
 * Unlike {@link resolveProfileRegion} it does not need a named profile.
 * Best-effort: `undefined` when no region is configured.
 */
async function resolveSdkDefaultRegion(profile: string | undefined): Promise<string | undefined> {
  const sts = new STSClient(buildStsClientConfig({ profile }));
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
  return resolveSdkDefaultRegion(profile);
}
