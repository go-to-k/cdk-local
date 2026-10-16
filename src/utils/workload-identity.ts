/**
 * The identity the emulated WORKLOAD's inputs resolve as once `--role-arn`
 * has assumed a role (go-to-k/cdk-local#783).
 *
 * `applyRoleArnIfSet` overwrites the process's `AWS_*` triple with the role,
 * so every client built afterwards from the default chain runs as the role.
 * That is standalone `cdkl`'s contract, and it stays the default. A host whose
 * `--role-arn` is a DEPLOY identity sets the embed config's
 * `workloadIdentity: 'caller'`; then the sites that resolve the workload's
 * inputs build their clients through {@link workloadClientConfig} /
 * {@link workloadStsClientConfig}, and the sites that copy the process triple
 * into a container go through {@link applyWorkloadEnvCredentials}. Both answer
 * with the identity the process had BEFORE the assume.
 *
 * Which sites are workload inputs is decided at each site, not here. The role
 * keeps synth, the ECR image pull and a fromS3 code bundle (the emulated
 * unit's own artifact, produced by this deploy); everything the workload READS
 * or RECEIVES — secrets, parameters, `{{resolve:...}}`, `--from-cfn-stack`,
 * `${AWS::AccountId}`, a literal layer ARN (code the developer did not write),
 * the container's credential triple and every assume-role hop — is the
 * caller's.
 *
 * The snapshot is module state, written once per process by the code that
 * performs the assume. A child process spawned after the assume inherits the
 * role's triple and no snapshot, so this mode does not reach it.
 */

import type { AwsCredentialIdentityProvider } from '@smithy/types';
import { getEmbedConfig } from '../local/embed-config.js';
import { buildProxyClientConfig, buildProxyRequestHandler } from './aws-proxy.js';
import type { AwsProxyClientConfig } from './aws-proxy.js';
import { getLogger } from './logger.js';

/** A static credential triple, as read from `AWS_*`. */
export interface CallerCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface AssumedRoleRecord {
  /** The pre-assume static triple, or `undefined` when the env carried none. */
  caller: CallerCredentials | undefined;
}

let record: AssumedRoleRecord | undefined;
let stripWarned = false;

/**
 * The refusal for a second assume in one process. Shared by
 * {@link recordAssumedRole} and `applyRoleArnIfSet`, which checks BEFORE its
 * `AssumeRole` hop: a second assume would snapshot the FIRST role's triple as
 * "the caller" and hand it to the workload.
 */
export const SECOND_ASSUME_MESSAGE =
  'A role was already assumed in this process; refusing to assume a second one. ' +
  'Pass --role-arn once.';

/**
 * Record that a role has been assumed, with the caller's pre-assume triple
 * (or `undefined` when the environment held none). Called by the code that
 * overwrites `AWS_*` — cdk-local's `applyRoleArnIfSet`, or a host's own
 * equivalent — BEFORE it overwrites them. Write-once: a second call throws.
 *
 * The triple is COPIED, so a holder of the original object cannot rewrite the
 * identity every caller-mode client runs as.
 */
export function recordAssumedRole(caller: CallerCredentials | undefined): void {
  if (record !== undefined) throw new Error(SECOND_ASSUME_MESSAGE);
  record = {
    caller: caller
      ? {
          accessKeyId: caller.accessKeyId,
          secretAccessKey: caller.secretAccessKey,
          ...(caller.sessionToken ? { sessionToken: caller.sessionToken } : {}),
        }
      : undefined,
  };
}

/** Whether {@link recordAssumedRole} has run in this process. */
export function assumedRoleRecorded(): boolean {
  return record !== undefined;
}

/** Read the static `AWS_*` triple from the environment, if a complete one is set. */
export function readEnvCallerCredentials(
  env: NodeJS.ProcessEnv = process.env
): CallerCredentials | undefined {
  const accessKeyId = env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = env['AWS_SECRET_ACCESS_KEY'];
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = env['AWS_SESSION_TOKEN'];
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** Test-isolation helper: forget the recorded assume. */
export function resetWorkloadIdentity(): void {
  record = undefined;
  stripWarned = false;
}

function callerRecord(): AssumedRoleRecord | undefined {
  return getEmbedConfig().workloadIdentity === 'caller' ? record : undefined;
}

/**
 * The single warning the SDK chain emits that is FALSE for the env-less chain
 * below: it names `default` as the profile only to subtract the env link, so
 * "Both AWS_PROFILE and the pair ... are set" is not what happened. Every
 * other chain warning still reaches the logger.
 */
const MULTIPLE_CREDENTIAL_SOURCES_WARNING = 'Multiple credential sources detected';

const chainLogger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (...args: unknown[]): void => {
    const text = args.map(String).join(' ');
    if (text.includes(MULTIPLE_CREDENTIAL_SOURCES_WARNING)) return;
    getLogger().warn(text);
  },
  error: (...args: unknown[]): void => {
    getLogger().error(args.map(String).join(' '));
  },
};

/**
 * The caller's own chain with the env link (now holding the role) subtracted.
 * Naming a profile makes `credential-provider-node` skip `fromEnv`, and the
 * SDK's `default` profile is exactly what the chain reads when none is named,
 * so this is "the default chain minus env" expressed through the SDK's own
 * precedence. Bound: a `[default]` profile that itself sources the
 * environment (`credential_source = Environment`, or a `credential_process`
 * that echoes `AWS_*`) still resolves the role.
 */
function callerChainWithoutEnv(proxied: boolean): AwsCredentialIdentityProvider {
  let chain: Promise<AwsCredentialIdentityProvider> | undefined;
  return async (identityProperties) => {
    chain ??= (async () => {
      const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
      return defaultProvider({
        profile: 'default',
        logger: chainLogger,
        ...(proxied ? { clientConfig: { requestHandler: buildProxyRequestHandler() } } : {}),
      });
    })().catch((err: unknown) => {
      chain = undefined;
      throw err;
    });
    return (await chain)(identityProperties);
  };
}

/**
 * The client-config fragment for a site that resolves a WORKLOAD input. Spread
 * it FIRST, like {@link buildProxyClientConfig}, which it equals unless the
 * host chose `workloadIdentity: 'caller'` AND a role was assumed AND no
 * profile is selected (by `profile` or `AWS_PROFILE` — either makes the SDK
 * chain skip the env link, so it already answers as the caller). Then it
 * injects the caller's pre-assume triple, or the caller's chain minus env.
 */
export function workloadClientConfig(
  opts: { profile?: string | undefined } = {}
): AwsProxyClientConfig {
  const base = buildProxyClientConfig({ profile: opts.profile });
  const rec = callerRecord();
  if (!rec) return base;
  const profile = opts.profile || process.env['AWS_PROFILE'];
  if (profile) return base;
  if (rec.caller) {
    const caller = rec.caller;
    const credentials: AwsCredentialIdentityProvider = async () => ({
      accessKeyId: caller.accessKeyId,
      secretAccessKey: caller.secretAccessKey,
      ...(caller.sessionToken ? { sessionToken: caller.sessionToken } : {}),
    });
    return { ...base, credentials };
  }
  return { ...base, credentials: callerChainWithoutEnv(base.requestHandler !== undefined) };
}

/** {@link workloadClientConfig} for an STS client, the `buildStsClientConfig` shape. */
export function workloadStsClientConfig(args: {
  region?: string | undefined;
  profile?: string | undefined;
}): { region?: string; profile?: string } & AwsProxyClientConfig {
  return {
    ...workloadClientConfig({ profile: args.profile }),
    ...(args.region && { region: args.region }),
    ...(args.profile && { profile: args.profile }),
  };
}

/**
 * Correct a container env that was built by copying the process's `AWS_*`
 * triple. Under caller mode after an assume, the copy holds the ROLE: restore
 * the caller's pre-assume triple, or STRIP the triple when the caller had no
 * static one (SSO / IMDS) — the container then receives exactly what it did
 * without `--role-arn`. No profile gate: a `--profile` overlay applied
 * afterwards still outranks this, as it does today. Returns what it did.
 *
 * The strip is warned once per process, naming the remedy, because a
 * long-running container's credential error otherwise lands far from its
 * cause.
 */
export function applyWorkloadEnvCredentials(
  env: Record<string, string | undefined>
): 'unchanged' | 'restored' | 'stripped' {
  const rec = callerRecord();
  if (!rec) return 'unchanged';
  if (rec.caller) {
    env['AWS_ACCESS_KEY_ID'] = rec.caller.accessKeyId;
    env['AWS_SECRET_ACCESS_KEY'] = rec.caller.secretAccessKey;
    if (rec.caller.sessionToken) env['AWS_SESSION_TOKEN'] = rec.caller.sessionToken;
    else delete env['AWS_SESSION_TOKEN'];
    return 'restored';
  }
  delete env['AWS_ACCESS_KEY_ID'];
  delete env['AWS_SECRET_ACCESS_KEY'];
  delete env['AWS_SESSION_TOKEN'];
  if (!stripWarned) {
    stripWarned = true;
    getLogger().warn(
      'The --role-arn role is not handed to the emulated workload, and your shell had no ' +
        'static AWS credentials to hand it instead, so the container receives none. ' +
        'Pass --profile <name>, or export static credentials, to give it an identity.'
    );
  }
  return 'stripped';
}
