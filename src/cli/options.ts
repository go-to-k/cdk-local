import { Option } from 'commander';
import { getEmbedConfig } from '../local/embed-config.js';

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
 * Each invocation is either a bare ARN (sets / overwrites the global
 * default) or `<LogicalId>=<arn>` (per-Lambda override). Per-Lambda
 * always wins over global; global is the fallback when no per-Lambda
 * entry exists.
 */
export interface AssumeRoleOption {
  /** Global ARN — last bare-arn token wins. */
  globalArn?: string;
  /** Per-Lambda override map (`LogicalId` -> ARN). */
  perLambda: Record<string, string>;
}

const IAM_ROLE_ARN_REGEX = /^arn:[^:]+:iam::\d+:role\//;

export function parseAssumeRoleToken(
  raw: string,
  previous: AssumeRoleOption | undefined
): AssumeRoleOption {
  const acc: AssumeRoleOption = previous ?? { perLambda: {} };
  if (!acc.perLambda) acc.perLambda = {};

  const eqIndex = raw.indexOf('=');
  if (eqIndex === -1) {
    if (!IAM_ROLE_ARN_REGEX.test(raw)) {
      throw new Error(
        `Invalid --assume-role value "${raw}": expected an IAM role ARN like arn:aws:iam::123456789012:role/MyRole, or LogicalId=<arn>.`
      );
    }
    acc.globalArn = raw;
    return acc;
  }

  const logicalId = raw.substring(0, eqIndex).trim();
  const arn = raw.substring(eqIndex + 1).trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(logicalId)) {
    throw new Error(
      `Invalid --assume-role value "${raw}": left-hand side "${logicalId}" must be a CloudFormation logical ID (alphanumeric, leading letter).`
    );
  }
  if (!IAM_ROLE_ARN_REGEX.test(arn)) {
    throw new Error(
      `Invalid --assume-role value "${raw}": right-hand side "${arn}" must be an IAM role ARN like arn:aws:iam::123456789012:role/MyRole.`
    );
  }
  acc.perLambda[logicalId] = arn;
  return acc;
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
