/**
 * Resolve CloudFormation template `Parameters` of the SSM-backed types
 * `AWS::SSM::Parameter::Value<String>` / `AWS::SSM::Parameter::Value<List<String>>`
 * (what CDK synthesizes for `ssm.StringParameter.valueForStringParameter(...)`)
 * into their deployed values via SSM Parameter Store.
 *
 * Motivation (issue #94): a container / Lambda env var that `Ref`s such a
 * parameter cannot be resolved from the `--from-cfn-stack` state source.
 * That source is built from `ListStackResources` (deployed RESOURCES); a
 * CloudFormation PARAMETER is not a resource, so the `Ref` misses
 * `context.resources[<id>]` in `state-resolver.ts` and the env var is
 * warn-and-dropped. The synthesized template, however, carries the SSM
 * parameter NAME in each entry's `Default`:
 *
 *   "Parameters": {
 *     "SsmParameterValue...Parameter": {
 *       "Type": "AWS::SSM::Parameter::Value<String>",
 *       "Default": "/path/to/the/parameter"
 *     }
 *   }
 *
 * and the run already has working AWS credentials / region (the same ones
 * `--from-cfn-stack` uses for `ListStackResources`). This module reads each
 * parameter NAME from `Default`, batch-resolves the values via SSM
 * `GetParameters`, and returns a `logicalId -> value` map the CLI feeds
 * into the substitution context so a `Ref` to the parameter's logical id
 * resolves to the value instead of being dropped.
 *
 * Best-effort by design: on any SSM failure (no credentials, access
 * denied, throttling) the helper logs a warn and returns whatever it
 * could resolve (possibly nothing) — the caller then falls back to the
 * existing warn-and-drop behavior on the affected `Ref`s. It NEVER throws
 * out of the substitution pass.
 */

import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { getLogger } from '../utils/logger.js';
import type { CloudFormationTemplate } from '../types/resource.js';

/** SSM-backed CFn parameter types CDK synthesizes for SSM lookups. */
const SSM_STRING_TYPE = 'AWS::SSM::Parameter::Value<String>';
const SSM_LIST_TYPE = 'AWS::SSM::Parameter::Value<List<String>>';

/**
 * A template `Parameters` entry that points at an SSM parameter and so
 * can be resolved from Parameter Store.
 */
export interface SsmParameterRef {
  /** Logical ID of the CFn parameter (the `Ref` target). */
  logicalId: string;
  /** SSM parameter name, read from the entry's `Default`. */
  ssmName: string;
  /** `true` for the `List<String>` variant (the value is comma-joined). */
  isList: boolean;
}

/**
 * Scan a synthesized template's `Parameters` block for entries whose
 * `Type` is one of the SSM-backed parameter types AND whose `Default`
 * carries a usable SSM parameter name. Pure — no AWS calls.
 *
 * Entries without a non-empty string `Default` are skipped (CDK always
 * synthesizes the parameter name into `Default` for the
 * `valueForStringParameter` shape; a parameter declared without a default
 * has no name we can resolve, so it stays warn-and-drop).
 *
 * Exported for unit testing.
 */
export function collectSsmParameterRefs(
  template: Pick<CloudFormationTemplate, 'Parameters'> | undefined
): SsmParameterRef[] {
  const params = template?.Parameters;
  if (!params) return [];
  const out: SsmParameterRef[] = [];
  for (const [logicalId, entry] of Object.entries(params)) {
    if (!entry || typeof entry !== 'object') continue;
    const type = entry.Type;
    const isList = type === SSM_LIST_TYPE;
    if (type !== SSM_STRING_TYPE && !isList) continue;
    const ssmName = entry.Default;
    if (typeof ssmName !== 'string' || ssmName.length === 0) continue;
    out.push({ logicalId, ssmName, isList });
  }
  return out;
}

/**
 * Batch-resolve a set of {@link SsmParameterRef}s via SSM `GetParameters`
 * and return a `logicalId -> resolved value` map. `List<String>`
 * parameters are comma-joined (CloudFormation surfaces the list type as a
 * comma-delimited string when the value is consumed as a `Ref`).
 *
 * `GetParameters` accepts up to 10 names per call, so the refs are
 * chunked. Names that SSM reports as invalid (`InvalidParameters`) are
 * left out of the result map so the caller falls back to warn-and-drop
 * on the corresponding `Ref`. `WithDecryption: true` is set so Secure
 * String parameters resolve too (matching how CloudFormation resolves
 * the `AWS::SSM::Parameter::Value<String>` type at deploy time).
 *
 * Security note: a decrypted SecureString value resolved here is then
 * baked into the container's `Environment` like any other resolved env
 * value, so it follows the standard plaintext-env exposure path — it can
 * appear on the `docker run -e KEY=VALUE` argv (visible in host `ps`) and
 * is not redacted by `redactAwsCredentialsInArgs` (which only covers
 * `SENSITIVE_ENV_KEYS`). This mirrors the deployed Lambda/ECS env and is
 * the same inherent exposure documented in `docker-runner`; routing
 * SecureString-resolved values through the value-from-process-env form is
 * tracked as a follow-up.
 *
 * Best-effort: a failed `GetParameters` chunk logs a warn and is skipped
 * (the other chunks still contribute their values); the function never
 * throws.
 *
 * `label` is the state-source label (e.g. `--from-cfn-stack`) used to
 * prefix warns so the user can tell which source produced them.
 *
 * Exported for unit testing.
 */
export async function resolveSsmParameters(
  client: SSMClient,
  refs: readonly SsmParameterRef[],
  label: string
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (refs.length === 0) return out;

  const logger = getLogger();

  // GetParameters accepts at most 10 names per call.
  const CHUNK = 10;
  // Map SSM name -> the refs that requested it (multiple logical IDs may
  // point at the same SSM name).
  const byName = new Map<string, SsmParameterRef[]>();
  for (const ref of refs) {
    const list = byName.get(ref.ssmName);
    if (list) list.push(ref);
    else byName.set(ref.ssmName, [ref]);
  }
  const uniqueNames = [...byName.keys()];

  for (let i = 0; i < uniqueNames.length; i += CHUNK) {
    const names = uniqueNames.slice(i, i + CHUNK);
    let resolved: Array<{ Name?: string | undefined; Value?: string | undefined }>;
    try {
      const resp = await client.send(
        new GetParametersCommand({ Names: names, WithDecryption: true })
      );
      resolved = resp.Parameters ?? [];
      const invalid = resp.InvalidParameters ?? [];
      if (invalid.length > 0) {
        logger.warn(
          `${label}: SSM GetParameters reported invalid parameter name(s): ${invalid.join(', ')}. ` +
            `Ref to the matching CloudFormation parameter(s) will warn-and-drop (was the SSM parameter created?).`
        );
      }
    } catch (err) {
      logger.warn(
        `${label}: SSM GetParameters(${names.join(', ')}) failed: ${formatSsmError(err)}. ` +
          `Ref to the matching CloudFormation parameter(s) will warn-and-drop (grant ssm:GetParameters or override via --env-vars).`
      );
      continue;
    }

    for (const p of resolved) {
      if (typeof p.Name !== 'string' || typeof p.Value !== 'string') continue;
      const requesters = byName.get(p.Name);
      if (!requesters) continue;
      for (const ref of requesters) {
        // CloudFormation surfaces a `List<String>` SSM value as a
        // comma-delimited string when referenced; SSM returns the value
        // already comma-joined for StringList parameters, so we pass it
        // through verbatim — the `isList` flag is retained for clarity
        // and future divergence but needs no transform here.
        out[ref.logicalId] = p.Value;
      }
    }
  }

  return out;
}

/**
 * Format an SSM SDK error as `<name>: <message>` so the warn names the
 * error class (e.g. `AccessDeniedException`, `ThrottlingException`).
 * Mirrors `formatAwsErrorForWarn` in `cfn-local-state-provider.ts`.
 * Exported for unit testing.
 */
export function formatSsmError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const name = err.name && err.name !== 'Error' ? err.name : undefined;
  return name !== undefined ? `${name}: ${err.message}` : err.message;
}
