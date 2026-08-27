import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { AssumeRoleCommandOutput } from '@aws-sdk/client-sts';
import { getLogger } from './logger.js';
import { getEmbedConfig } from '../local/embed-config.js';
import { buildStsClientConfig } from './profile-resolver.js';
import { describeAwsFailureForWarn, flattenToOneLine } from '../local/credential-error.js';

/**
 * {@link assumeRoleCredentials} failed, and the failure is cdk-local's OWN
 * rendering of it rather than a raw SDK error.
 *
 * Exists because this helper has TWO kinds of caller and they need opposite
 * things (issue #579 review round 4, found by #570's own harness going red):
 *
 *   - THREE paths are unguarded all the way to `formatError`
 *     (`local-start-api`'s `assumeLambdaExecutionRole`, and `assumeTaskRole` in
 *     both `local-run-task` and `ecs-service-emulator`). They need this helper
 *     to render the failure, which is why it no longer propagates unwrapped.
 *   - ONE path -- `local-invoke.ts`'s `resolveLambdaContainerEnv` -- ALREADY
 *     renders it, guarded by the #570 lane. Wrapping for the first group broke
 *     that one: the outer `describeAwsFailureForWarn` saw a plain `Error`
 *     (no `$fault`, because it is cdk-local's own), withheld the
 *     already-sanitized text, and turned `ExpiredTokenException: The security
 *     token ... is expired` into `Error; 138-character message withheld`. The
 *     policy withholding its OWN output is the worst of both branches.
 *
 * So `message` carries the framed sentence for the first group, and `detail`
 * carries the bare half for a caller that supplies its own framing. A relay
 * that re-renders `detail` would double-withhold it again; print it verbatim.
 *
 * BOTH of this helper's throws use it (issue #579 review round 5). The
 * no-usable-credentials sibling was left a bare `Error` in round 4 and carried
 * the identical defect one throw over: at `local-invoke.ts` it missed the
 * `instanceof` test and rendered as `Error; 47-character message withheld`.
 * That is the exact loss `credential-error.ts` documents as accepted and
 * points here to fix, so it is fixed here rather than described again.
 *
 * NOT thrown when `makeError` is supplied -- that caller asked for its own
 * class, and every `makeError` path today is in the unguarded group.
 */
export class AssumeRoleFailure extends Error {
  /**
   * The bare half, with no `AssumeRole(<arn>) ...` framing, safe to print
   * VERBATIM on a line that adds its own. Already policy-rendered when the
   * cause was an SDK error; cdk-local's own literal otherwise. Never re-render
   * it -- that is what double-withholds.
   */
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'AssumeRoleFailure';
    this.detail = detail;
    Object.setPrototypeOf(this, AssumeRoleFailure.prototype);
  }
}

/** Temporary credentials minted by {@link assumeRoleCredentials}. */
export interface AssumedRoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/**
 * Issue an STS AssumeRole for `roleArn` and return the temporary
 * credentials (issue #509).
 *
 * This is the single shared implementation behind every command's
 * `--assume-role` / `--assume-task-role` path (`cdkl invoke`,
 * `start-api`, `run-task`, and the `start-service` / `start-alb`
 * emulator) — each previously carried its own near-identical copy,
 * which kept credential-minting logic OFF this module (the one
 * `/review-pr`'s up-bias security surface lists) and duplicated the
 * issue #245 `--profile` threading fix four times.
 *
 * `sessionNameSuffix` distinguishes the callers in CloudTrail
 * (`<resourceNamePrefix>-<suffix>-<epochMs>`). `makeError` lets a
 * caller surface the failure as its own error class (the ECS emulator
 * throws `LocalStartServiceError`).
 *
 * CHANGED by issue #579 review round 4: "STS transport errors always
 * propagate unwrapped" is no longer true, and it was the last instance of the
 * `try { send } finally { destroy }` with no `catch` that the derived
 * population found. Propagating unwrapped meant the raw SDK error reached
 * `withErrorHandling` -> `formatError`, which prints
 * `${error.name}: ${error.message}` UNFLATTENED and UNCLAMPED at DEFAULT
 * level — so a `CredentialsProviderError` carrying a `credential_process`
 * command line landed there verbatim, from every `--assume-role` /
 * `--assume-task-role` path in the CLI. This is the file `/review-pr`'s
 * `UP_PATHS` names as credential-material surface, which is exactly why it is
 * the wrong place to leave the relay open.
 *
 * The no-usable-credentials check sits OUTSIDE the `try` rather than being
 * re-raised through an `instanceof` guard, because `makeError` mints the
 * CALLER's class and there is no sentinel this function could test for.
 * `sts.destroy()` still runs first — the `finally` fires on the way out of the
 * `try`, and the response has already been read by then.
 *
 * What that buys is narrower than an earlier revision of this note claimed,
 * and the overclaim is worth correcting rather than deleting: being outside the
 * `try` means this function never routes its own text through the withholding
 * policy, which is what the THREE `formatError` paths need — they print
 * `message` directly. It does NOT help a caller that RE-RENDERS the error,
 * because such a caller tests a class rather than a line number. That is what
 * {@link AssumeRoleFailure} is for, and why BOTH throws below use it.
 */
export async function assumeRoleCredentials(opts: {
  roleArn: string;
  region: string | undefined;
  profile: string | undefined;
  sessionNameSuffix: string;
  makeError?: (message: string) => Error;
}): Promise<AssumedRoleCredentials> {
  // Thread `--profile` so the AssumeRole call is signed with the
  // profile's credentials (matching `aws sts assume-role --profile
  // <p>`), not the default env-shadowed chain (issue #245).
  const sts = new STSClient(buildStsClientConfig({ region: opts.region, profile: opts.profile }));
  const shownArn = flattenToOneLine(opts.roleArn);
  let response: AssumeRoleCommandOutput;
  try {
    response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: opts.roleArn,
        RoleSessionName: `${getEmbedConfig().resourceNamePrefix}-${opts.sessionNameSuffix}-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
  } catch (err) {
    const detail = describeAwsFailureForWarn(err, 'STS AssumeRole');
    const message = `AssumeRole(${shownArn}) failed: ${detail}`;
    throw opts.makeError ? opts.makeError(message) : new AssumeRoleFailure(message, detail);
  } finally {
    sts.destroy();
  }

  // Outside the `try` on purpose; see the note above. cdk-local's own text is
  // never routed through the withholding policy.
  const creds = response.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    // `message` is BYTE-IDENTICAL to what this threw before issue #579 -- the
    // three direct-print paths and `credential-error.ts`'s own worked example
    // both quote it. What changed is the CLASS, so a re-rendering caller can
    // recognise it, and `detail`, which drops the `AssumeRole(<arn>)` framing
    // such a caller has already written.
    const message = `AssumeRole(${shownArn}) returned no usable credentials.`;
    const detail = 'the response carried no usable credentials';
    throw opts.makeError ? opts.makeError(message) : new AssumeRoleFailure(message, detail);
  }
  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
}

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
 * `profile` is threaded into the STSClient construction (via
 * {@link buildStsClientConfig}) so `--profile <p> --role-arn <arn>` runs
 * AssumeRole through the named profile's credential chain rather than
 * the default chain — this was the second-relapse vector closed by
 * issue #245 (every STSClient site under `src/cli/**` + `src/local/**`
 * is audited, but `src/utils/role-arn.ts` was outside the audit scope's
 * first cut; this caller-side threading + the widened audit scope in
 * `tests/unit/cli/sts-client-profile-audit.test.ts` keep them in sync).
 *
 * Default session duration is 1 hour.
 */
export async function applyRoleArnIfSet(opts: {
  roleArn: string | undefined;
  region: string | undefined;
  profile: string | undefined;
}): Promise<void> {
  const roleArn = opts.roleArn || process.env[`${getEmbedConfig().envPrefix}_ROLE_ARN`];
  if (!roleArn) return;

  const logger = getLogger().child('role-arn');
  // FLATTENED at every interpolation (issue #579 review round 4). `roleArn` is
  // usually the user's own flag value, but it also arrives from
  // `<envPrefix>_ROLE_ARN` and, at the bare `--assume-role` call sites, from a
  // live `GetFunctionConfiguration` / `GetAgentRuntime` response behind only a
  // `startsWith('arn:')` check. The `info` line below is the more reachable of
  // the two, because it fires on SUCCESS.
  const shownArn = flattenToOneLine(roleArn);
  logger.debug(`Assuming role ${shownArn}...`);

  const sts = new STSClient(buildStsClientConfig({ region: opts.region, profile: opts.profile }));
  let response: AssumeRoleCommandOutput;
  try {
    response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `${getEmbedConfig().binaryName}-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
  } catch (err) {
    // The nine-caller site, and the most reachable relay the derived population
    // turned up: NOTHING between here and `formatError` caught, so a
    // `CredentialsProviderError` printed its `credential_process` command line
    // at DEFAULT level from `cdkl studio`, the ECS emulator,
    // `invoke-agentcore` and six other entry points.
    throw new Error(
      `AssumeRole(${shownArn}) failed: ${describeAwsFailureForWarn(err, 'STS AssumeRole')}`
    );
  } finally {
    sts.destroy();
  }

  // cdk-local's own throws live OUTSIDE the guarded region, so the policy can
  // never withhold text this file wrote itself.
  if (!response.Credentials) {
    throw new Error(`AssumeRole returned no credentials for role ${shownArn}`);
  }
  const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = response.Credentials;
  if (!AccessKeyId || !SecretAccessKey || !SessionToken) {
    throw new Error(`AssumeRole response missing credentials fields for role ${shownArn}`);
  }
  process.env['AWS_ACCESS_KEY_ID'] = AccessKeyId;
  process.env['AWS_SECRET_ACCESS_KEY'] = SecretAccessKey;
  process.env['AWS_SESSION_TOKEN'] = SessionToken;
  logger.info(
    `Assumed role ${shownArn} (session expires ${Expiration?.toISOString() ?? 'unknown'})`
  );
}
