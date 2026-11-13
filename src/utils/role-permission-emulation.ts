import { getLogger } from './logger.js';
import { getEmbedConfig } from '../local/embed-config.js';
import { describeAwsFailureForWarn, flattenToOneLine } from '../local/credential-error.js';
import { workloadClientConfig, workloadStsClientConfig } from './workload-identity.js';
import { describeRejectedRoleArn, isIamRoleArn } from './role-arn.js';

/**
 * Emulating an execution role's permissions when the real `AssumeRole` of it
 * is refused (go-to-k/cdk-local#929).
 *
 * A role CDK creates trusts only its service principal, so `--assume-role`
 * (and `--assume-task-role`) is refused with AccessDenied unless the developer
 * edits the trust policy. Instead of the command's old outcome (an error, or
 * the developer's own, usually broader, credentials), this reads the role's
 * inline and attached managed policies and obtains credentials for the CALLER
 * with those policies as SESSION POLICIES. The effective permissions are then
 * the intersection of the caller's and the role's, so a permission the role
 * lacks fails locally.
 *
 * Credential source:
 *   - `--emulate-role-via <arn>` given: `sts:AssumeRole` of that role (one the
 *     caller CAN assume), with the session policies.
 *   - otherwise, an IAM user caller: `sts:GetFederationToken` with the session
 *     policies.
 *   - otherwise (IAM Identity Center, a role session, root): no emulation.
 *
 * Every "cannot emulate" outcome warns and returns `undefined`; the call site
 * then does what a refused assume did before this existed.
 */

/** The STS-issued credentials an emulation returns. */
export interface EmulatedRoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** STS caps the plaintext of the inline and managed session policies together. */
export const SESSION_POLICY_MAX_CHARS = 2048;
/** STS accepts at most this many managed session policy ARNs. */
export const SESSION_POLICY_MAX_ARNS = 10;

/**
 * Applied when the role has no policies at all. Without a session policy,
 * `AssumeRole` would grant the via role's FULL permissions (and
 * `GetFederationToken` would grant nothing usable), while the role being
 * emulated grants nothing.
 */
const DENY_ALL_POLICY =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}';

/** The role's policies, as IAM returned them. */
export interface RolePolicies {
  /** Each inline policy's document, parsed. */
  inline: unknown[];
  /** The attached managed policies' ARNs. */
  managedArns: string[];
}

export type SessionPolicyPlan =
  | { ok: true; policy: string; policyArns: string[] }
  | { ok: false; reason: string };

/**
 * Turn the role's policies into STS session-policy parameters: the inline
 * policies combined into ONE minified document (STS takes a single `Policy`),
 * the managed policies passed by ARN. `Sid`s are dropped: they do not affect
 * evaluation, two inline policies may reuse one, and they cost characters
 * against the limit.
 *
 * Refused (with the reason the warning prints) when the inline documents do
 * not share one `Version` (combining them would change how policy variables
 * evaluate), when there are more than {@link SESSION_POLICY_MAX_ARNS} managed
 * policies, or when the plaintext exceeds {@link SESSION_POLICY_MAX_CHARS}.
 */
export function buildSessionPolicy(policies: RolePolicies): SessionPolicyPlan {
  const { inline, managedArns } = policies;
  if (managedArns.length > SESSION_POLICY_MAX_ARNS) {
    return {
      ok: false,
      reason: `the role has ${managedArns.length} managed policies, more than the ${SESSION_POLICY_MAX_ARNS} STS accepts as session policies`,
    };
  }
  const versions = new Set<string>();
  const statements: unknown[] = [];
  for (const doc of inline) {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, reason: 'an inline policy of the role is not a JSON object' };
    }
    const record = doc as Record<string, unknown>;
    versions.add(typeof record['Version'] === 'string' ? record['Version'] : '');
    const raw = record['Statement'];
    for (const statement of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
      if (statement !== null && typeof statement === 'object' && !Array.isArray(statement)) {
        const { Sid: _sid, ...rest } = statement as Record<string, unknown>;
        statements.push(rest);
      } else {
        statements.push(statement);
      }
    }
  }
  if (versions.size > 1) {
    return {
      ok: false,
      reason:
        'the inline policies of the role use different policy Version values and cannot be combined into one session policy',
    };
  }
  const [version] = [...versions];
  let policy: string;
  if (statements.length === 0) {
    // No inline statement grants nothing. An empty `Statement` would be
    // refused, and NO session policy with no managed ARN either means "no
    // session policy" — the via role's full permissions — so deny all.
    policy = managedArns.length === 0 ? DENY_ALL_POLICY : '';
  } else {
    policy = JSON.stringify({
      ...(version !== undefined && version !== '' && { Version: version }),
      Statement: statements,
    });
  }
  const chars = policy.length + managedArns.reduce((sum, arn) => sum + arn.length, 0);
  if (chars > SESSION_POLICY_MAX_CHARS) {
    return {
      ok: false,
      reason: `the role's policies take ${chars} characters as session policies, more than the ${SESSION_POLICY_MAX_CHARS} STS accepts`,
    };
  }
  return { ok: true, policy, policyArns: managedArns };
}

/** An IAM user's ARN (`arn:<partition>:iam::<account>:user/<path/name>`). */
export function isIamUserArn(arn: string | undefined): boolean {
  return arn !== undefined && /^arn:[^:]+:iam::\d{12}:user\//.test(arn);
}

/**
 * The refusal `AssumeRole` answers when the trust policy does not allow the
 * caller. By NAME only: a bare 403 is also `InvalidClientTokenId`,
 * `SignatureDoesNotMatch` or `ExpiredToken` — broken caller credentials, which
 * emulation cannot help and must not hide.
 */
export function isAssumeRoleAccessDenied(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AccessDenied';
}

/** The last path segment of a role ARN: IAM's `RoleName`. */
function roleNameOf(roleArn: string): string {
  const resource = roleArn.split(':').slice(5).join(':');
  return resource.slice(resource.lastIndexOf('/') + 1);
}

/**
 * The approximation notice prints once per role per process: `invoke-agentcore`
 * assumes one role up to three times in a run, `start-api` once per Lambda that
 * shares it, and `--watch` again on every reload.
 */
const noticedRoles = new Set<string>();
/** The "cannot emulate" warning, likewise once per role per process. */
const failedRoles = new Set<string>();

/** @internal — test-only: forget which roles were already warned about. */
export function __resetRoleEmulationWarnings(): void {
  noticedRoles.clear();
  failedRoles.clear();
}

export interface EmulateRoleArgs {
  /** The execution role whose `AssumeRole` was refused. */
  roleArn: string;
  /** The region the refused hop used. */
  region: string | undefined;
  /** The `--profile` the refused hop was signed with. */
  profile: string | undefined;
  /** `--emulate-role-via <arn>`: a role the caller can assume. */
  emulateRoleVia?: string | undefined;
  /** The flag the warnings name, e.g. `--assume-role`. */
  flag: string;
  /** The `RoleSessionName` middle part, as the refused hop's (`start-service`, ...). */
  sessionNameSuffix: string;
}

/**
 * When `err` is the AccessDenied a refused `AssumeRole(args.roleArn)` threw,
 * emulate the role's permissions (see the module doc). Returns the
 * credentials, or `undefined` when `err` is anything else or emulation is not
 * possible (after a once-per-role warning naming why).
 *
 * Never throws: the caller keeps the ORIGINAL refusal when this returns
 * `undefined`, so an unexpected failure here must not replace it. Nothing
 * secret is printed: the credentials never reach a message, and AWS failures
 * are rendered through `describeAwsFailureForWarn`.
 */
export async function emulateRoleAfterDeniedAssume(
  err: unknown,
  args: EmulateRoleArgs
): Promise<EmulatedRoleCredentials | undefined> {
  if (!isAssumeRoleAccessDenied(err)) return undefined;
  try {
    return await emulate(args);
  } catch (unexpected) {
    if (failedRoles.has(args.roleArn)) return undefined;
    failedRoles.add(args.roleArn);
    getLogger().warn(
      `${args.flag}: emulating the role's permissions failed: ${describeAwsFailureForWarn(unexpected, 'role permission emulation')}.`
    );
    return undefined;
  }
}

async function emulate(args: EmulateRoleArgs): Promise<EmulatedRoleCredentials | undefined> {
  const logger = getLogger();
  // Both ARNs passed `isIamRoleArn` (printable ASCII, bounded) before they got
  // here; flattened anyway, as every role-ARN log site in this repo is.
  const shownRole = flattenToOneLine(args.roleArn);
  const cannot = (reason: string): undefined => {
    if (failedRoles.has(args.roleArn)) return undefined;
    failedRoles.add(args.roleArn);
    logger.warn(
      `${args.flag}: AssumeRole(${shownRole}) was refused, and the role's permissions cannot be emulated instead: ${reason}.`
    );
    return undefined;
  };

  const { STSClient, GetCallerIdentityCommand, GetFederationTokenCommand, AssumeRoleCommand } =
    await import('@aws-sdk/client-sts');
  // The same config as the refused hop (`assumeRoleCredentials`): the same
  // identity (`--profile`, caller mode) and the same route (`--aws-emulator`,
  // mixed mode), so IAM / STS reach real AWS only when the refused hop did.
  const sts = new STSClient(
    workloadStsClientConfig({ region: args.region, profile: args.profile })
  );
  try {
    let callerArn: string | undefined;
    try {
      callerArn = (await sts.send(new GetCallerIdentityCommand({}))).Arn;
    } catch (idErr) {
      return cannot(describeAwsFailureForWarn(idErr, 'STS GetCallerIdentity'));
    }
    // IAM is read by role NAME in the caller's account, so a role in another
    // account would read a same-named role of the caller's instead.
    const roleAccount = args.roleArn.split(':')[4];
    if (roleAccount === undefined || roleAccount !== callerArn?.split(':')[4]) {
      return cannot("the role is not in your credentials' account, so its policies cannot be read");
    }
    // GUARDED SEND (issue #607): the via ARN is shape-checked at the command's
    // entry, but this send guards itself like every other `AssumeRole` send.
    if (args.emulateRoleVia !== undefined && !isIamRoleArn(args.emulateRoleVia)) {
      return cannot(
        `--emulate-role-via is not a well-formed IAM role ARN: ${describeRejectedRoleArn(args.emulateRoleVia)}`
      );
    }
    if (args.emulateRoleVia === undefined && !isIamUserArn(callerArn)) {
      return cannot(
        'your credentials are not an IAM user, and only an IAM user can call sts:GetFederationToken. ' +
          "Pass --emulate-role-via <arn> naming a role you can assume, and that role is assumed with the role's policies as session policies"
      );
    }

    let policies: RolePolicies;
    try {
      policies = await readRolePolicies(args);
    } catch (readErr) {
      return cannot(
        `reading the role's policies failed (it needs iam:ListRolePolicies, iam:GetRolePolicy and iam:ListAttachedRolePolicies): ${describeAwsFailureForWarn(readErr, 'IAM role policy read')}`
      );
    }
    const plan = buildSessionPolicy(policies);
    if (!plan.ok) return cannot(plan.reason);

    const sessionPolicies = {
      ...(plan.policy !== '' && { Policy: plan.policy }),
      ...(plan.policyArns.length > 0 && { PolicyArns: plan.policyArns.map((arn) => ({ arn })) }),
    };
    const prefix = getEmbedConfig().resourceNamePrefix;
    let via: string;
    let response;
    try {
      if (args.emulateRoleVia !== undefined) {
        via = `AssumeRole of --emulate-role-via ${flattenToOneLine(args.emulateRoleVia)}`;
        response = await sts.send(
          new AssumeRoleCommand({
            RoleArn: args.emulateRoleVia,
            RoleSessionName: `${prefix}-${args.sessionNameSuffix}-emulate-${Date.now()}`.slice(
              0,
              64
            ),
            DurationSeconds: 3600,
            ...sessionPolicies,
          })
        );
      } else {
        via = 'sts:GetFederationToken';
        response = await sts.send(
          new GetFederationTokenCommand({
            // 2-32 characters of [\w+=,.@-].
            Name: `${prefix.replace(/[^\w+=,.@-]/g, '-')}-${Date.now()}`.slice(-32),
            DurationSeconds: 3600,
            ...sessionPolicies,
          })
        );
      }
    } catch (stsErr) {
      const stsName = (stsErr as { name?: unknown } | null)?.name;
      // The SDK names the modeled error `PackedPolicyTooLargeException`; the
      // wire code `PackedPolicyTooLarge` is accepted too.
      if (stsName === 'PackedPolicyTooLargeException' || stsName === 'PackedPolicyTooLarge') {
        return cannot(
          "the role's policies are larger than STS accepts as session policies (PackedPolicyTooLarge)"
        );
      }
      const rendered = describeAwsFailureForWarn(stsErr, 'STS session-policy credentials');
      // Temporary IAM-user credentials (GetSessionToken / MFA) still have a
      // `user/` ARN, but STS refuses GetFederationToken for them.
      return cannot(
        args.emulateRoleVia === undefined
          ? `${rendered}. Temporary IAM user credentials (GetSessionToken / MFA) cannot call sts:GetFederationToken; pass --emulate-role-via <arn> naming a role you can assume instead`
          : rendered
      );
    }
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      return cannot('STS returned no usable credentials');
    }
    if (!noticedRoles.has(args.roleArn)) {
      noticedRoles.add(args.roleArn);
      const count = policies.inline.length + policies.managedArns.length;
      const who = args.emulateRoleVia !== undefined ? 'that role' : 'you';
      const federationNote =
        args.emulateRoleVia === undefined
          ? ' A GetFederationToken session cannot call IAM, nor STS except GetCallerIdentity.'
          : '';
      logger.warn(
        `${args.flag}: AssumeRole(${shownRole}) was refused (the role's trust policy does not allow you), so its permissions are EMULATED: credentials from ${via} with the role's ${policies.inline.length} inline and ${policies.managedArns.length} managed ${count === 1 ? 'policy' : 'policies'} as session policies, which allow only what both ${who} and the role allow. This is an APPROXIMATION: resource-based policies, KMS key policies and aws:PrincipalArn conditions that name the role see a different principal, and the role's permissions boundary and session tags are not reproduced. Policy variables such as aws:username and aws:userid take this session's values, not the role's (a role session has no aws:username).${federationNote}`
      );
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } finally {
    sts.destroy();
  }
}

/**
 * The role's inline policy documents and attached managed policy ARNs
 * (`iam:ListRolePolicies` / `iam:GetRolePolicy` / `iam:ListAttachedRolePolicies`,
 * every page), read by the caller on the refused hop's route.
 */
export async function readRolePolicies(args: {
  roleArn: string;
  region: string | undefined;
  profile: string | undefined;
}): Promise<RolePolicies> {
  const {
    IAMClient,
    ListRolePoliciesCommand,
    GetRolePolicyCommand,
    ListAttachedRolePoliciesCommand,
  } = await import('@aws-sdk/client-iam');
  const iam = new IAMClient({
    ...workloadClientConfig({ profile: args.profile }),
    ...(args.region && { region: args.region }),
    ...(args.profile && { profile: args.profile }),
  });
  const RoleName = roleNameOf(args.roleArn);
  try {
    const names: string[] = [];
    let marker: string | undefined;
    do {
      const page = await iam.send(
        new ListRolePoliciesCommand({ RoleName, ...(marker && { Marker: marker }) })
      );
      names.push(...(page.PolicyNames ?? []));
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    const inline: unknown[] = [];
    for (const PolicyName of names) {
      const got = await iam.send(new GetRolePolicyCommand({ RoleName, PolicyName }));
      // IAM returns the document URL-encoded.
      inline.push(JSON.parse(decodeURIComponent(got.PolicyDocument ?? '{}')));
    }
    const managedArns: string[] = [];
    let attachedMarker: string | undefined;
    do {
      const page = await iam.send(
        new ListAttachedRolePoliciesCommand({
          RoleName,
          ...(attachedMarker && { Marker: attachedMarker }),
        })
      );
      for (const attached of page.AttachedPolicies ?? []) {
        if (attached.PolicyArn) managedArns.push(attached.PolicyArn);
      }
      attachedMarker = page.IsTruncated ? page.Marker : undefined;
    } while (attachedMarker);
    return { inline, managedArns };
  } finally {
    iam.destroy();
  }
}
