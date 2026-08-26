import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Issue #570 — the TENTH-site fence.
 *
 * `sts-error-relay-sites.test.ts` drives nine known sites and fails when any of
 * them stops routing through `describeAwsFailureForWarn`. What it cannot see is
 * a site that did not exist when the table was written: a new
 * `logger.warn('... STS <Op> failed: ${err.message}')` generates no case, so it
 * generates no failure either. That is the shape this file closes.
 *
 * It is a SOURCE-TEXT check, deliberately, and its scope is deliberately narrow:
 * every `logger.warn` line in the five converted command files that names an STS
 * operation as having failed must render the error through the shared helper.
 * A broader rule ("no `err.message` in any warn") would be wrong — those files
 * carry dozens of legitimate Docker / filesystem / synth relays, and a fence
 * that has to be suppressed is a fence nobody keeps.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..', 'src');

/**
 * The five files whose STS relays issue #570 converted. Listed as literals
 * rather than globbed: a glob would silently stop covering a file that was
 * renamed, which is the direction that fails open.
 */
const CONVERTED_FILES = [
  'cli/commands/local-invoke.ts',
  'cli/commands/local-run-task.ts',
  'cli/commands/ecs-service-emulator.ts',
  'cli/commands/local-start-api.ts',
  'cli/commands/local-invoke-agentcore.ts',
];

/** `STS GetCallerIdentity failed` / `STS AssumeRole(...) failed` and friends. */
const STS_FAILURE_LINE = /STS\s+(GetCallerIdentity|AssumeRole)[^`]*?failed/;

/** The raw shape the fix replaced. */
const RAW_RELAY = /err\s+instanceof\s+Error\s*\?\s*err\.message\s*:\s*String\(err\)/;

interface Finding {
  file: string;
  line: number;
  text: string;
}

/**
 * How many source lines around the announcing line count as part of the site.
 *
 * A warn's template is split across source lines, and the error rendering sits
 * on EITHER side of the announcing one: inline on the same or the next line at
 * seven sites, and hoisted into a `const reason = ...` a couple of lines ABOVE
 * at the two that interpolate a role ARN. A one-sided window reported one of
 * those two as unguarded, which is how these numbers were arrived at rather
 * than guessed.
 */
const LINES_BEFORE = 4;
const LINES_AFTER = 2;

/** Collect every physical line that announces an STS failure, with its window. */
function stsFailureRelays(file: string): Finding[] {
  const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
  const found: Finding[] = [];
  for (const [i, line] of lines.entries()) {
    if (!STS_FAILURE_LINE.test(line)) continue;
    // Skip prose: only a template-literal line can be relaying anything.
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
    const window = lines.slice(Math.max(0, i - LINES_BEFORE), i + LINES_AFTER + 1).join('\n');
    found.push({ file, line: i + 1, text: window });
  }
  return found;
}

describe('#570 — a tenth STS relay site cannot be added unguarded', () => {
  const all = CONVERTED_FILES.flatMap(stsFailureRelays);

  it('finds the STS failure lines it is supposed to be guarding', () => {
    // Non-vacuity: if the regex ever stops matching (a reworded message, a
    // renamed file), every assertion below passes over an empty list. The
    // count is the nine converted sites; it is asserted as a floor AND a
    // ceiling so both a silently-lost match and an unnoticed new site show up.
    expect(all.map((f) => `${f.file}:${f.line}`)).toHaveLength(9);
  });

  it('routes every one of them through describeAwsFailureForWarn', () => {
    const unguarded = all.filter((f) => !f.text.includes('describeAwsFailureForWarn'));
    expect(
      unguarded.map((f) => `${f.file}:${f.line}`),
      'an STS failure warn that does not render its error through the shared policy'
    ).toEqual([]);
  });

  it('leaves none of them interpolating the raw error message', () => {
    const raw = all.filter((f) => RAW_RELAY.test(f.text));
    expect(
      raw.map((f) => `${f.file}:${f.line}`),
      'an STS failure warn still interpolating err.message verbatim'
    ).toEqual([]);
  });

  it('proves the guard discriminates: a synthesized unguarded site is caught', () => {
    // Without this, the three assertions above are "no bad rows in a list I
    // built" and would pass just as well against a broken matcher. Feed the
    // matcher a line of exactly the shape a tenth site would have and confirm
    // it is both FOUND and REJECTED.
    const tenth = [
      '    } catch (err) {',
      '      logger.warn(',
      "        `--assume-role: STS AssumeRole(${arn}) failed: ${err instanceof Error ? err.message : String(err)}. ` +",
      "          'Falling back.'",
      '      );',
    ].join('\n');
    const announcing = tenth.split('\n')[2]!;
    expect(STS_FAILURE_LINE.test(announcing)).toBe(true);
    expect(tenth.includes('describeAwsFailureForWarn')).toBe(false);
    expect(RAW_RELAY.test(tenth)).toBe(true);
  });
});
