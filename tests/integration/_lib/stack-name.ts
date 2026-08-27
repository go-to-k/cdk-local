/**
 * Lane-unique naming for integration fixtures (issue #582), app side.
 *
 * `tests/integration/_lib/stack-name.sh` derives a per-worktree suffix and
 * exports it as `INTEG_STACK_SUFFIX` before a fixture's `verify.sh`
 * builds any name. The CDK app inherits that variable (the toolkit spawns
 * the app with the full parent environment), so appending it here makes the
 * synthesized stack name match the one `verify.sh` deploys, scans for and
 * destroys — and makes `cdkl <Stack>/<Construct>` targets line up too.
 *
 * With the variable unset — a bare `cdk synth` run by hand — the historical
 * un-suffixed name is returned, so nothing outside `verify.sh` changes.
 *
 * The shell library is the single place the suffix is DERIVED; this is only
 * the place it is READ.
 */
export function integStackName(base: string): string {
  const lane = process.env.INTEG_STACK_SUFFIX;
  return lane ? `${base}-${lane}` : base;
}

/**
 * The same suffixing for a non-stack name that is also account-global and so
 * also collides between lanes: a CloudFormation export name, an SSM
 * parameter path. Separate from {@link integStackName} so a call site says
 * which kind of name it is building.
 */
export function integScopedName(base: string): string {
  const lane = process.env.INTEG_STACK_SUFFIX;
  return lane ? `${base}-${lane}` : base;
}
