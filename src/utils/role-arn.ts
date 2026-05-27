import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getLogger } from './logger.js';

/**
 * Resolve the role-arn argument (CLI flag or `CDKL_ROLE_ARN` env var) and,
 * when set, assume the role and write the resulting temporary credentials
 * into `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
 * for the rest of the process.
 *
 * Why env vars, not threaded credentials: cdk-local constructs several
 * independent AWS clients (Lambda invoke, ECR pull, etc.). Threading a
 * `credentials` object through every site is high churn for an opt-in
 * flag. AWS SDK v3 reads the standard `AWS_*` env vars at the top of its
 * default credentials chain, so writing into them once at the command's
 * entry makes every later `new XxxClient()` pick up the assumed-role
 * credentials automatically without touching the client construction sites.
 *
 * Default session duration is 1 hour.
 */
export async function applyRoleArnIfSet(opts: {
  roleArn: string | undefined;
  region: string | undefined;
}): Promise<void> {
  const roleArn = opts.roleArn || process.env['CDKL_ROLE_ARN'];
  if (!roleArn) return;

  const logger = getLogger().child('role-arn');
  logger.debug(`Assuming role ${roleArn}...`);

  const sts = new STSClient({ ...(opts.region && { region: opts.region }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkl-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    if (!response.Credentials) {
      throw new Error(`AssumeRole returned no credentials for role ${roleArn}`);
    }
    const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = response.Credentials;
    if (!AccessKeyId || !SecretAccessKey || !SessionToken) {
      throw new Error(`AssumeRole response missing credentials fields for role ${roleArn}`);
    }
    process.env['AWS_ACCESS_KEY_ID'] = AccessKeyId;
    process.env['AWS_SECRET_ACCESS_KEY'] = SecretAccessKey;
    process.env['AWS_SESSION_TOKEN'] = SessionToken;
    logger.info(
      `Assumed role ${roleArn} (session expires ${Expiration?.toISOString() ?? 'unknown'})`
    );
  } finally {
    sts.destroy();
  }
}
