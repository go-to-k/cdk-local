import { InvalidArgumentError, Option } from 'commander';
import type { Command } from 'commander';
import { getEmbedConfig } from '../local/embed-config.js';
import { describeRejectedRoleArn, isIamRoleArn } from '../utils/role-arn.js';
import { getLogger } from '../utils/logger.js';
import { awsEmulatorEnvName } from '../local/workload-aws-wiring.js';

/**
 * Parse context key=value pairs from CLI arguments into a Record.
 */
export function parseContextOptions(contextArgs?: string[]): Record<string, string> {
  const context: Record<string, string> = {};
  if (contextArgs) {
    for (const arg of contextArgs) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex > 0) {
        context[arg.substring(0, eqIndex)] = arg.substring(eqIndex + 1);
      }
    }
  }
  return context;
}

/**
 * Options shared across every cdk-local command. Built per-call (not a
 * module-level const) so the `--role-arn` env-var hint reflects the active
 * embed config, which the command factory installs before calling this.
 *
 * `--region` is intentionally NOT in `commonOptions` — it is registered
 * separately via {@link regionOption} so a host CLI (cdkd) can swap the
 * shared option block once without losing the `--region` flag.
 */
export function commonOptions(): Option[] {
  const { envPrefix } = getEmbedConfig();
  return [
    new Option('--verbose', 'Enable verbose logging').default(false),
    new Option('--profile <profile>', 'AWS profile'),
    new Option(
      '--role-arn <arn>',
      `IAM role ARN to assume for AWS API calls (env: ${envPrefix}_ROLE_ARN)`
    ),
    new Option(
      '-y, --yes',
      'Automatically answer interactive prompts with the recommended response'
    ).default(false),
  ];
}

/**
 * `--aws-emulator` / `--ca-bundle`, registered by every command that
 * starts workload containers (inside its `add<Cmd>SpecificOptions` helper).
 * Built per-call so the env-var hint reflects the active embed config.
 */
export function awsEndpointOptions(): Option[] {
  const envName = awsEmulatorEnvName();
  return [
    new Option(
      '--aws-emulator [url]',
      'Run against a local AWS Emulator (default https://127.0.0.1:9297; the port selects ~/.aws/emulator/<port>/): ' +
        "this command's own AWS calls (--from-cfn-stack included) and every workload container use it, and " +
        `containers get only its credentials and trust its CA (env: ${envName})`
    ),
    new Option(
      '--ca-bundle <file>',
      'PEM CA bundle mounted read-only into every workload container, with AWS_CA_BUNDLE / NODE_EXTRA_CA_CERTS / ' +
        'REQUESTS_CA_BUNDLE / SSL_CERT_FILE pointed at it (default: the host AWS_CA_BUNDLE)'
    ),
  ];
}

/** Add {@link awsEndpointOptions} to `cmd`. */
export function addAwsEndpointOptions(cmd: Command): Command {
  for (const opt of awsEndpointOptions()) cmd.addOption(opt);
  return cmd;
}

/**
 * `--region` option attached to every command. The value drives both
 * host-side AWS SDK calls (STS `GetCallerIdentity` for
 * `${AWS::AccountId}` resolution, `AssumeRole` for `--assume-role`, etc.)
 * and the container's `AWS_REGION` env var. When omitted, region
 * precedence falls back to `AWS_REGION` / `AWS_DEFAULT_REGION` env,
 * then the synthesized stack region, then the `--profile`'s configured
 * region — same shape as the AWS CLI's `--region` flag (issue #245).
 *
 * Kept as a standalone export rather than baked into `commonOptions`
 * so a host CLI (cdkd) can swap the shared option block once without
 * losing this flag.
 */
export const regionOption = new Option(
  '--region <region>',
  'AWS region for SDK calls; defaults to AWS_REGION env, the synthesized stack region, or the resolved profile region'
);

/**
 * Backward-compat alias for the previous `deprecatedRegionOption` export.
 * `--region` is no longer deprecated (issue #245) but external callers
 * (including cdkd) may still import the old name. Slated for removal
 * once those callers migrate to {@link regionOption}.
 *
 * @deprecated Use {@link regionOption}.
 */
export const deprecatedRegionOption = regionOption;

/**
 * App options. Built per-call (not a module-level const) so the `--app`
 * env-var hint reflects the active embed config.
 *
 * `--app` is optional: falls back to `${envPrefix}_APP` env var, then
 * `cdk.json` `app` field. Accepts either a shell command (e.g.
 * `"node app.ts"`) or a path to a pre-synthesized cloud assembly directory
 * (e.g. `"cdk.out"`).
 */
export function appOptions(): Option[] {
  const { envPrefix } = getEmbedConfig();
  return [
    new Option(
      '-a, --app <command>',
      `CDK app command (e.g., "node app.ts") or path to a pre-synthesized cloud assembly directory. Falls back to cdk.json or ${envPrefix}_APP env`
    ),
    new Option('--output <path>', 'Output directory for synthesis').default('cdk.out'),
  ];
}

/**
 * Context options.
 */
export const contextOptions = [
  new Option(
    '-c, --context <key=value...>',
    'Set context values (can be specified multiple times)'
  ),
];

/**
 * Per-Lambda + global `--assume-role` parser used by `cdkl start-api`.
 *
 * Each invocation is one of:
 *   - bare ARN — sets / overwrites the global default
 *   - `<LogicalId>=<arn>` — per-Lambda override (repeatable)
 *
 * Issue #256 Option 1's per-routed-Lambda auto-resolve mode is
 * surfaced as a SEPARATE boolean flag (`--assume-role-auto`) rather
 * than the `[arn]` optional-value shape — Commander's optional-value
 * handling silently overwrites a value-form accumulator with `true`
 * when the bare form is parsed AFTER value forms, dropping the
 * per-Lambda map. The separate flag eliminates the ordering quirk;
 * the two surfaces are then composed at boot via
 * {@link normalizeStartApiAssumeRole}, which still enforces the
 * mutually-exclusive global slot (auto-resolve + global ARN is
 * rejected).
 *
 * Resolution precedence (`effectiveAssumeRoleArn`): per-Lambda map
 * entry > global ARN > unset. Bare-auto-resolve is orthogonal — it
 * fires for any routed Lambda the map does NOT name, and is mutually
 * exclusive with the global ARN on the global slot (the boot-time
 * guard rejects bare + global together).
 */
export interface AssumeRoleOption {
  /** Global ARN — last bare-arn token wins. */
  globalArn?: string;
  /** Per-Lambda override map (`LogicalId` -> ARN). */
  perLambda: Record<string, string>;
  /**
   * Issue #256 Option 1 — non-breaking: `--assume-role-auto` means
   * "auto-resolve EACH routed Lambda's own execution role per-Lambda".
   * Mutually exclusive with `globalArn`; the per-Lambda map still
   * wins for the named Lambda. Set by
   * {@link normalizeStartApiAssumeRole} from the separate
   * `--assume-role-auto` boolean flag — never set directly by
   * {@link parseAssumeRoleToken}.
   */
  bareAutoResolve?: boolean;
}

/**
 * The `--emulate-role-via <arn>` parser: a malformed ARN is refused at parse,
 * before any AWS call, like the `--assume-role` value forms.
 */
export function parseEmulateRoleVia(raw: string): string {
  const arn = raw.trim();
  if (!isIamRoleArn(arn)) {
    throw new InvalidArgumentError(
      `Invalid --emulate-role-via value ${describeRejectedRoleArn(raw)}: expected an IAM role ARN like arn:aws:iam::123456789012:role/MyRole.`
    );
  }
  return arn;
}

/**
 * `--emulate-role-via <arn>` (go-to-k/cdk-local#929), added beside the role
 * flag (`roleFlag`) of every command that assumes a workload's execution role.
 * When that AssumeRole is refused with AccessDenied (the role trusts only its
 * service principal), the role's permissions are emulated with session
 * policies (`src/utils/role-permission-emulation.ts`): an IAM user needs no
 * flag (GetFederationToken), any other caller names a role it can assume here.
 */
export function emulateRoleViaOption(roleFlag: string): Option {
  return new Option(
    '--emulate-role-via <arn>',
    `When the ${roleFlag} AssumeRole is refused (the role does not trust you), emulate the ` +
      "role's permissions: assume THIS role with the execution role's policies as session " +
      'policies, so only what both allow is allowed. For callers that are not an IAM user ' +
      '(IAM Identity Center, a role session); an IAM user gets the same through ' +
      'sts:GetFederationToken without this flag. An approximation: resource-based policies, ' +
      'key policies and conditions naming the role are not reproduced, and a role with a permissions boundary is not emulated.'
  ).argParser(parseEmulateRoleVia);
}

/** Whether a `[arn]`-form role flag asks for a role (an ARN, or the bare flag). */
export function isRoleFlagRequested(value: string | boolean | undefined): boolean {
  return value === true || typeof value === 'string';
}

/**
 * The entry check for `--emulate-role-via`: given without the role flag
 * (absent, or `--no-assume-role`), nothing would ever read it, so say so.
 * The ARN shape is checked by {@link parseEmulateRoleVia} at parse.
 */
export function warnIfEmulateRoleViaUnused(
  value: string | undefined,
  args: { roleFlag: string; roleRequested: boolean }
): void {
  if (value === undefined || args.roleRequested) return;
  getLogger().warn(
    `--emulate-role-via has no effect without ${args.roleFlag}: it is used only when that flag's AssumeRole is refused.`
  );
}

/**
 * Shape-checks both forms against {@link isIamRoleArn}.
 *
 * This file used to own a private `IAM_ROLE_ARN_REGEX`, while three WIRE
 * resolution points asked the same question with `startsWith('arn:')` (issue
 * #607) — so "is this a role ARN?" had two answers depending on whether the
 * value came from the flag or off a `GetFunctionConfiguration` response. The
 * predicate now lives in `src/utils/role-arn.ts`, beside the AssumeRole call
 * that consumes it, and this site calls it rather than keeping a copy.
 */
export function parseAssumeRoleToken(
  raw: string,
  previous: AssumeRoleOption | undefined
): AssumeRoleOption {
  const acc: AssumeRoleOption = previous ?? { perLambda: {} };
  if (!acc.perLambda) acc.perLambda = {};

  const eqIndex = raw.indexOf('=');
  if (eqIndex === -1) {
    // TRIMMED, like the pair form two lines below (issue #607). The pair form
    // has always trimmed both sides and the bare form never did, which was an
    // inconsistency between two spellings of one flag before this change and
    // became user-visible with it: the old regex was unanchored, so a
    // copy-pasted `--assume-role "arn:...:role/R "` with trailing whitespace
    // was silently accepted, and an anchored pattern rejects it. Trimming is
    // the fix that keeps the two forms agreeing, rather than making the bare
    // form newly stricter than the pair form for the same text.
    const bare = raw.trim();
    if (!isIamRoleArn(bare)) {
      throw new InvalidArgumentError(
        `Invalid --assume-role value "${raw}": expected an IAM role ARN like arn:aws:iam::123456789012:role/MyRole, or LogicalId=<arn>.`
      );
    }
    acc.globalArn = bare;
    return acc;
  }

  const logicalId = raw.substring(0, eqIndex).trim();
  const arn = raw.substring(eqIndex + 1).trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(logicalId)) {
    throw new InvalidArgumentError(
      `Invalid --assume-role value "${raw}": left-hand side "${logicalId}" must be a CloudFormation logical ID (alphanumeric, leading letter).`
    );
  }
  if (!isIamRoleArn(arn)) {
    throw new InvalidArgumentError(
      `Invalid --assume-role value "${raw}": right-hand side "${arn}" must be an IAM role ARN like arn:aws:iam::123456789012:role/MyRole.`
    );
  }
  acc.perLambda[logicalId] = arn;
  return acc;
}

/**
 * Compose `--assume-role` (value-form accumulator) and the separate
 * `--assume-role-auto` boolean flag into the in-process
 * representation `localStartApiCommand` consumes downstream.
 *
 *   - both unset -> `undefined` (pass dev creds through)
 *   - only `--assume-role-auto` -> `{ perLambda: {}, bareAutoResolve: true }`
 *     (per-Lambda auto-resolve for every routed Lambda)
 *   - only `--assume-role` -> the value-form accumulator (global ARN
 *     and/or per-Lambda map) as-is
 *   - both -> accumulator with `bareAutoResolve = true` overlaid;
 *     the per-Lambda map still wins for named Lambdas, auto-resolve
 *     fills in for every Lambda the map does NOT name
 *
 * Enforces the mutual-exclusion guard: `--assume-role-auto` and a
 * global ARN (`--assume-role <arn>`) both occupy the "default for
 * every other Lambda" slot, so the combination is ambiguous and
 * rejected at boot with a clear error. The per-Lambda map IS
 * compatible with either side.
 */
export function normalizeStartApiAssumeRole(
  raw: AssumeRoleOption | undefined,
  autoResolve: boolean
): AssumeRoleOption | undefined {
  if (raw === undefined) {
    return autoResolve ? { perLambda: {}, bareAutoResolve: true } : undefined;
  }
  if (autoResolve && raw.globalArn) {
    throw new Error(
      `--assume-role-auto auto-resolves EACH routed Lambda's own execution role, ` +
        `but --assume-role ${raw.globalArn} also names a single global default. ` +
        `These are mutually exclusive on the global slot. Either drop the global ARN ` +
        `to keep --assume-role-auto for every Lambda, or drop --assume-role-auto to keep the global default. ` +
        `Per-Lambda overrides (--assume-role <LogicalId>=<arn>) are compatible with either side.`
    );
  }
  if (autoResolve) raw.bareAutoResolve = true;
  return raw;
}

/**
 * Resolve the effective IAM role ARN for a given Lambda. Per-Lambda
 * override wins; otherwise the global default; otherwise `undefined`
 * (no role to assume — pass developer creds through).
 */
export function effectiveAssumeRoleArn(
  logicalId: string,
  opt: AssumeRoleOption | undefined
): string | undefined {
  if (!opt) return undefined;
  return opt.perLambda?.[logicalId] ?? opt.globalArn;
}
