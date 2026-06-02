/**
 * Shared CLI args `cdkl studio` threads into every child command it
 * spawns (the single-shot `cdkl invoke` in studio-dispatch and the
 * long-running `cdkl start-api` / `start-alb` / `start-service` in
 * studio-serve-manager). studio is a control plane over the CLI, so
 * session-global flags set on `cdkl studio` are forwarded verbatim to
 * each child rather than re-implemented.
 *
 * Centralizing the arg construction keeps the two spawn sites from
 * drifting (they previously each hand-rolled the same app / profile /
 * region / context pushes) and is the single place where a new
 * session-global flag is wired through.
 */

/** Session-global config forwarded to every studio child command. */
export interface SharedChildConfig {
  /** `--app` value, if studio was given one. */
  app?: string;
  /** `--profile` to thread through. */
  profile?: string;
  /** `--region` to thread through. */
  region?: string;
  /** `-c key=value` context overrides. */
  context?: Record<string, string>;
  /**
   * `--from-cfn-stack` session binding. Commander's optional-value form
   * maps a bare flag to `true` and `--from-cfn-stack <name>` to the
   * string; both are forwarded as-is (every child command accepts the
   * bare and named forms).
   */
  fromCfnStack?: string | boolean;
  /**
   * `--assume-role <arn>` — explicit ARN only. studio does NOT expose the
   * bare auto-resolve form because the child commands disagree on it
   * (`start-api` takes `<arn-or-pair>` with a separate `--assume-role-auto`
   * flag), so a value-only flag threads cleanly to all of them.
   */
  assumeRole?: string;
}

/**
 * Build the shared `--app` / `--profile` / `--region` / `-c` /
 * `--from-cfn-stack` / `--assume-role` args for a studio child command.
 * Returns a flat argv fragment to spread after the subcommand + target.
 */
export function buildSharedChildArgs(config: SharedChildConfig): string[] {
  const args: string[] = [];
  if (config.app) args.push('--app', config.app);
  if (config.profile) args.push('--profile', config.profile);
  if (config.region) args.push('--region', config.region);
  for (const [k, v] of Object.entries(config.context ?? {})) {
    args.push('-c', `${k}=${v}`);
  }
  // `--from-cfn-stack`: bare flag (true) vs named stack (string).
  if (config.fromCfnStack === true) {
    args.push('--from-cfn-stack');
  } else if (typeof config.fromCfnStack === 'string' && config.fromCfnStack !== '') {
    args.push('--from-cfn-stack', config.fromCfnStack);
  }
  // `--assume-role <arn>`: explicit ARN only.
  if (typeof config.assumeRole === 'string' && config.assumeRole !== '') {
    args.push('--assume-role', config.assumeRole);
  }
  return args;
}
