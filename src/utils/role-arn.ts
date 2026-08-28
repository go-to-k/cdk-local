import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { AssumeRoleCommandOutput } from '@aws-sdk/client-sts';
import { getLogger } from './logger.js';
import { getEmbedConfig } from '../local/embed-config.js';
import { buildStsClientConfig } from './profile-resolver.js';
import { describeAwsFailureForWarn, flattenToOneLine } from '../local/credential-error.js';

/**
 * Upper bound on a value this module is willing to treat as a role ARN.
 *
 * NOT invented here: it is the length constraint the receiving API itself
 * documents for the field this value ends up in — STS `AssumeRole`'s
 * `RoleArn` (AWS STS API Reference: "Length Constraints: Minimum length of
 * 20. Maximum length of 2048."). Bounding at the receiver's own limit is the
 * defensible number because anything above it is a value STS would reject
 * anyway, so the cap can never turn a working configuration into a broken one.
 *
 * It is deliberately far above what a real role ARN needs — IAM's own entity
 * limits put the ceiling near 600 characters (`arn:<partition>:iam::<12
 * digits>:role/` plus a path of at most 512 and a name of at most 64) — because
 * the job here is stopping an UNBOUNDED wire value from being sent and printed,
 * not re-deriving IAM's schema. A tighter guess would be this module's own
 * opinion; 2048 is the receiver's.
 *
 * The MINIMUM (20) is deliberately NOT enforced. The grammar below already
 * implies a floor one character under it (`arn:a:iam::1:role/X` is 19), so
 * enforcing it would reject a synthetic-but-well-shaped value for no security
 * gain — length amplification is the half that matters here.
 *
 * The comparison is on UTF-16 units, which is exact for every value the
 * grammar can ACCEPT (it admits printable ASCII only, where units, code points
 * and bytes coincide) and a safe over-approximation for the rest.
 */
export const IAM_ROLE_ARN_MAX_LENGTH = 2048;

/**
 * The shape an IAM role ARN must have.
 *
 * Extracted from `src/cli/options.ts`, which validated `--assume-role` with
 * `/^arn:[^:]+:iam::\d+:role\//` while three WIRE resolution points asked the
 * same question with `startsWith('arn:')` (issue #607). Two spellings of one
 * question regenerate: this is the single site that owns it, and every other
 * site calls {@link isIamRoleArn} rather than paraphrasing it.
 *
 * Deliberate strictness decisions, in both directions:
 *
 *   - The PARTITION is `[A-Za-z0-9-]+`, so `aws`, `aws-cn`, `aws-us-gov` and
 *     the iso partitions all pass. Tighter than the extracted `[^:]+` (which
 *     admitted spaces and slashes), and still open-ended enough that a
 *     partition AWS has not launched yet is not rejected by name.
 *   - The ACCOUNT stays `[0-9]+` rather than `[0-9]{12}`. Real account ids are
 *     12 digits, but this is a SHAPE bound, not a schema validator — AWS
 *     rejects a wrong account id far better than cdk-local can — and this
 *     repo's own fixtures use short ids (`arn:aws:iam::111:role/...`).
 *   - The role tail is `[!-~]+`: at least one character, printable ASCII, no
 *     spaces. That accepts every path-shaped role name
 *     (`role/service-role/Foo`, `role/aws-service-role/x.amazonaws.com/Bar`)
 *     because IAM's own path grammar is exactly printable-ASCII segments.
 *   - The pattern is ANCHORED AT BOTH ENDS, which the extracted one was not.
 *     That is the half that matters for a hostile endpoint: an unanchored
 *     `role\/` accepts a value carrying a newline and a forged second line
 *     after it, and it is the value's PRINTED half that the flatten at the log
 *     sites was left holding on its own.
 *
 * LINEARITY: every quantified class is disjoint from the literal that follows
 * it (`[A-Za-z0-9-]+` then `:`, `[0-9]+` then `:`), and the one class that is
 * not (`[!-~]+`) is the last element before `$`. There is no alternation and
 * no nested quantifier, so there is no input on which this backtracks
 * super-linearly — which matters because it runs on values off the wire.
 * {@link isIamRoleArn} also applies the length bound BEFORE the match, so the
 * pattern never sees an unbounded string at all.
 */
const IAM_ROLE_ARN_PATTERN = /^arn:[A-Za-z0-9-]+:iam::[0-9]+:role\/[!-~]+$/;

/**
 * Is `value` a string shaped like an IAM role ARN, and short enough to send?
 *
 * The single authority for that question (issue #607). `src/cli/options.ts`
 * asks it of a user-supplied `--assume-role`; `cfn-local-state-provider.ts`
 * and `local-invoke.ts` ask it of a value that arrived off a live
 * `GetFunctionConfiguration` / `GetAgentRuntime` response or out of deployed
 * stack state, which is the population that motivated extracting it — such a
 * value is not only PRINTED, it is SENT as `AssumeRoleCommand.RoleArn`, so a
 * cap at the log line would bound only half of it.
 *
 * OVERLOADED on purpose. The wire callers pass `unknown` (a state
 * `attributes.Arn`, an SDK response field) and want the `value is string`
 * narrowing so they can drop a separate `typeof` test. `src/cli/options.ts`
 * passes a value that is ALREADY `string`, and a predicate narrowing to
 * `string` makes the NEGATIVE branch `never` — which turns that branch's own
 * `Invalid --assume-role value "${raw}"` message into a
 * `restrict-template-expressions` warning. The string overload returns a plain
 * boolean so the error message the user actually reads still type-checks.
 */
export function isIamRoleArn(value: string): boolean;
export function isIamRoleArn(value: unknown): value is string;
export function isIamRoleArn(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // Length FIRST: the pattern is linear, but there is no reason to hand it a
  // megabyte from a hostile endpoint to find that out.
  if (value.length > IAM_ROLE_ARN_MAX_LENGTH) return false;
  return IAM_ROLE_ARN_PATTERN.test(value);
}

/**
 * Longest prefix of a rejected value {@link describeRejectedRoleArn} will show.
 *
 * 128 rather than 64: `arn:aws:iam::123456789012:role/` is 31 characters on
 * its own, so 64 left only 33 for the part that actually distinguishes one
 * role from another — a CDK-generated name
 * (`Stack-HandlerServiceRole1234ABCD-XXXXXXXXXXXX`) does not fit in that, and
 * a preview that elides exactly the informative half is not a diagnosis. 128
 * still leaves the rendered line well inside the 400-character bound its
 * callers' tests assert.
 */
const REJECTED_ARN_PREVIEW_MAX = 128;

/**
 * Render a value {@link isIamRoleArn} REJECTED so it can go on a warn line.
 *
 * A rejection has two very different causes and the log line has to serve
 * both: an ordinary misconfiguration (a role NAME where an ARN was expected,
 * an ARN of the wrong resource type), where seeing the value is the whole
 * diagnosis; and a hostile or broken endpoint returning something unbounded,
 * where printing the value is the thing being prevented. So the value is
 * shown, flattened and clamped, with its true length named — the same shape
 * `sanitizeServiceExceptionMessage` uses, and for the same reason: a clamped
 * preview must never be mistakable for the whole value.
 *
 * The cut is on CODE POINTS so it cannot emit half of a surrogate pair, and
 * the reported count is the code-point count of the FLATTENED string, which is
 * the string the preview is a prefix of.
 */
export function describeRejectedRoleArn(value: unknown): string {
  if (typeof value !== 'string') return `a non-string ${typeof value} value`;
  // Code points, not grapheme clusters: the property wanted is that the cut
  // cannot split a surrogate PAIR. Same trade-off, and same reason, as
  // `sanitizeServiceExceptionMessage`.
  // oxlint-disable-next-line typescript/no-misused-spread
  const points = [...flattenToOneLine(value)];
  const preview =
    points.length <= REJECTED_ARN_PREVIEW_MAX
      ? points.join('')
      : `${points.slice(0, REJECTED_ARN_PREVIEW_MAX).join('')}...`;
  return `"${preview}" (${points.length} characters)`;
}

/**
 * The sentence a guarded send throws when a value is refused before it leaves
 * the process. One spelling, exported, so every guarded send words the refusal
 * identically — including `local-invoke-agentcore.ts`'s own inline
 * `AssumeRoleCommand`, which is not routed through this module.
 */
export function refusedRoleArnMessage(value: unknown): string {
  return (
    `AssumeRole refused: the role ARN is not a well-formed IAM role ARN ` +
    `(expected arn:<partition>:iam::<account>:role/<name>, at most ` +
    `${IAM_ROLE_ARN_MAX_LENGTH} characters): ${describeRejectedRoleArn(value)}. ` +
    `Nothing was sent to STS.`
  );
}

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
  // GUARDED SEND (issue #607). This is the site that owns "may this value be
  // sent?" — as opposed to the resolution points, which own "where did this
  // bad value come from?" and produce the sited warn a user can act on.
  // Checking here bounds every caller of THIS helper, including the ones no
  // resolution point covers: a `LocalStateProvider` supplied by a host CLI,
  // whose return value cdk-local never sees resolved, and `<envPrefix>_ROLE_ARN`
  // at the sibling below.
  //
  // It is NOT a process-wide choke point, and an earlier revision of this
  // comment wrongly said it was ("one of the two places in the process where a
  // role ARN is handed to STS ... bounds EVERY caller"). `grep -rn 'new
  // AssumeRoleCommand(' src/` finds FIVE sends, not two. The other three are
  // `local-invoke-agentcore.ts`'s `assumeAgentCoreExecutionRole` (guarded
  // separately, against {@link refusedRoleArnMessage}, because it is on the
  // wire path — its arg is `resolveAssumeRoleArn`'s output), and
  // `layer-arn-materializer.ts` / `ecr-puller.ts`, whose ARNs come only from
  // `--layer-role-arn` / `--ecr-role-arn` on the user's own command line. Any
  // NEW send has to guard itself; nothing here does it for them.
  //
  // BEFORE the client is constructed and before anything is logged, so a
  // refused value costs no network setup and never reaches a log line.
  if (!isIamRoleArn(opts.roleArn)) {
    const detail = `the role ARN is not well-formed: ${describeRejectedRoleArn(opts.roleArn)}`;
    const message = refusedRoleArnMessage(opts.roleArn);
    throw opts.makeError ? opts.makeError(message) : new AssumeRoleFailure(message, detail);
  }

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

  // GUARDED SEND (issue #607) — the eighteen-caller one. See the note in
  // {@link assumeRoleCredentials}, including its correction about how many
  // sends exist: the bound belongs where the value is handed to STS, not only
  // where it was resolved. This send is the ONLY cover for
  // `<envPrefix>_ROLE_ARN`, which reaches the process straight from the
  // environment with no resolution point in front of it at all.
  //
  // Checked BEFORE the flatten and the `debug` line below, so a refused value
  // is never printed anywhere, at any level.
  if (!isIamRoleArn(roleArn)) {
    throw new Error(refusedRoleArnMessage(roleArn));
  }

  const logger = getLogger().child('role-arn');
  // FLATTENED at every interpolation (issue #579 review round 4). Since #607
  // this value has already passed {@link isIamRoleArn} directly above, which
  // admits printable ASCII only — so the flatten is now provably a no-op here
  // and is kept as belt-and-braces rather than as the thing standing between a
  // hostile endpoint and this line. That inversion is the whole point of #607:
  // a cap at the log line bounded only what gets PRINTED, while the same value
  // was also SENT.
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
