/**
 * A region a host CLI copied into `process.env.AWS_REGION` as a DEFAULT, not
 * as a region the user named (go-to-k/cdk-local#963).
 *
 * cdkd's `--aws-emulator` copies the emulator run's configured region into
 * its own `AWS_REGION` when the shell names none, so readers that only check
 * the environment agree on a region for an environment-agnostic stack
 * (go-to-k/cdkd#6270). That copy is the emulator's counterpart of the
 * `region =` line in `~/.aws/config`, so it must rank BELOW a stack's
 * `env.region` and the state record's region, as a profile region does on
 * real AWS. A host that makes such a copy calls
 * {@link setAmbientDefaultRegion}; every chain that ranks the host
 * `AWS_REGION` above a stack or state region reads it through
 * {@link namedEnvAwsRegion} and consults {@link ambientDefaultRegion} after
 * the stack / state region.
 *
 * Nothing in `cdkl` itself calls the setter, so standalone `cdkl` sees
 * `namedEnvAwsRegion() === process.env.AWS_REGION` and no default.
 *
 * Same semantics as cdkd's `src/utils/emulator-default-region.ts`: the
 * default counts only while `process.env.AWS_REGION` still holds it, so a
 * later write of another region (a `--region` the host applied) wins.
 */

let recorded: string | undefined;

/**
 * Record `region` as the default the host wrote into `process.env.AWS_REGION`,
 * or forget it with `undefined`.
 */
export function setAmbientDefaultRegion(region: string | undefined): void {
  recorded = region === '' ? undefined : region;
}

/**
 * The recorded default while `process.env.AWS_REGION` still holds it, else
 * `undefined` (no host default, the user named a region, or a later write
 * replaced it).
 */
export function ambientDefaultRegion(): string | undefined {
  return recorded !== undefined && process.env['AWS_REGION'] === recorded ? recorded : undefined;
}

/**
 * `process.env.AWS_REGION` unless it holds the recorded default: the variable
 * as the user set it.
 */
export function namedEnvAwsRegion(): string | undefined {
  return ambientDefaultRegion() === undefined ? process.env['AWS_REGION'] : undefined;
}

/**
 * `stackRegion` (a stack's `env.region`, a state record's region), or the
 * recorded default when it names no region: absent, empty, or the
 * `unknown-region` placeholder an environment-agnostic stack synthesizes.
 * Returns `stackRegion` unchanged when no default is recorded, so a chain
 * reads exactly as before without a host default.
 */
export function regionOrAmbientDefault(stackRegion: string | undefined): string | undefined {
  const ambient = ambientDefaultRegion();
  if (ambient === undefined) return stackRegion;
  return stackRegion === undefined || stackRegion === '' || stackRegion === 'unknown-region'
    ? ambient
    : stackRegion;
}
