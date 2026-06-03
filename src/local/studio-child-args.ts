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
  /**
   * Absolute path to the cloud-assembly directory studio synthesized ONCE
   * at boot (the `--output` dir, default `cdk.out`), if it persisted to
   * disk. When set and the child does NOT need to re-synth (every
   * single-shot invoke, and a serve that is NOT spawned with `--watch`),
   * `buildSharedChildArgs({ preferAssembly: true })` forwards
   * `--app <assemblyDir>` instead of `--app <app>` so the child reads the
   * pre-synthesized assembly and skips its own synth (issue #324). A
   * `--watch` serve must re-synth on change, so it keeps `--app <app>`.
   */
  assemblyDir?: string;
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

/** Per-call knobs for {@link buildSharedChildArgs}. */
export interface BuildSharedChildArgsOptions {
  /**
   * When true and `config.assemblyDir` is set, forward
   * `--app <assemblyDir>` (the once-synthesized cloud assembly) instead of
   * `--app <app>` so the child skips its own synth (issue #324). The two
   * spawn sites decide this per child: studio-dispatch always passes `true`
   * (single-shot invokes never re-synth), studio-serve-manager passes
   * `!config.watch` (a `--watch` serve must re-synth on change). Defaults
   * to false (forward `--app <app>` — the pre-#324 behavior).
   */
  preferAssembly?: boolean;
}

/**
 * Build the shared `--app` / `--profile` / `--region` / `-c` /
 * `--from-cfn-stack` / `--assume-role` args for a studio child command.
 * Returns a flat argv fragment to spread after the subcommand + target.
 *
 * When `opts.preferAssembly` is true and `config.assemblyDir` is set, the
 * `--app` value is the once-synthesized cloud-assembly directory so the
 * child reads it and skips a redundant synth (issue #324); otherwise it is
 * the app command (`config.app`).
 */
export function buildSharedChildArgs(
  config: SharedChildConfig,
  opts: BuildSharedChildArgsOptions = {}
): string[] {
  const args: string[] = [];
  // `--app`: reuse the boot-synthesized assembly dir when the child does
  // not need to re-synth (issue #324); else the app command.
  const appValue = opts.preferAssembly && config.assemblyDir ? config.assemblyDir : config.app;
  if (appValue) args.push('--app', appValue);
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
