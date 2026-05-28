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
 * `--region` is intentionally NOT in `commonOptions` — local commands
 * pick the region from `AWS_REGION` / profile / synthesized stack env.
 * The deprecated flag below remains for muscle-memory compatibility.
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
 * Deprecated `--region` option attached to every command.
 *
 * Kept (rather than fully removed) so that scripts or muscle memory
 * passing `--region` do not break. The value is parsed but ignored;
 * the SDK picks the region from `AWS_REGION` / profile / synthesized
 * stack env.
 */
export const deprecatedRegionOption = new Option(
  '--region <region>',
  '[deprecated] No effect on this command; use AWS_REGION or your AWS profile'
).hideHelp();

/**
 * Emit a one-shot stderr warning when a command receives `--region`.
 */
export function warnIfDeprecatedRegion(options: { region?: string }): void {
  if (options.region !== undefined) {
    process.stderr.write(
      'Warning: --region is deprecated for this command and has no effect. ' +
        'Use the AWS_REGION environment variable or your AWS profile to override the SDK default region.\n'
    );
  }
}

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
 * `-i, --interactive` — present an arrow-key picker to choose the
 * target(s) for this command instead of typing a CDK path / logical ID.
 * Added to the four run commands (NOT `list`, which lists everything).
 * Requires a TTY; in a non-interactive shell the command errors with a
 * clear message. The required-target commands (`invoke` / `run-task` /
 * `start-service`) also auto-launch the picker when the target is
 * omitted in a TTY; `start-api` shows it only with the explicit flag
 * (a bare `start-api` keeps serving every discovered API).
 */
export const interactiveOption = new Option(
  '-i, --interactive',
  'Pick the target(s) from an interactive list instead of passing them as arguments (requires a TTY)'
).default(false);

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
