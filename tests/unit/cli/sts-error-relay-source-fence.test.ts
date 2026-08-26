import { describe, expect, it } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
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
 * It is a SOURCE-TEXT check, and the first draft of it was weaker than it read.
 * Three evasions were found by review and are closed here, each with the
 * assertion that closes it:
 *
 *   - A tenth site in a SIXTH file was invisible, because the file list was
 *     hard-coded. The scan now walks every `src/cli/commands/*.ts` and the file
 *     list is asserted to be exactly what the scan finds.
 *   - The `describeAwsFailureForWarn` check matched the window text, and every
 *     site carries a COMMENT naming that helper — so a copy-pasted tenth site
 *     that kept the comment and wrote `${(err as Error).message}` passed. The
 *     check now matches a CALL, with comments stripped first.
 *   - The raw-relay check matched one exact ternary spelling. It now matches any
 *     `err.message` read.
 *
 * Its scope stays narrow on purpose: only `logger.warn` lines that name an STS
 * operation as having failed. A broader rule ("no `err.message` in any warn")
 * would be wrong — these files carry dozens of legitimate Docker / filesystem /
 * synth relays, and a fence that has to be suppressed is a fence nobody keeps.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..', 'src');
const COMMANDS = join(SRC, 'cli', 'commands');

/**
 * Announces an STS failure. Deliberately loose about what sits between the
 * operation and `failed` — a template literal wraps across source lines, so an
 * anchored or backtick-free pattern would silently match nothing (which is the
 * fail-open direction) rather than too much.
 */
const STS_FAILURE_LINE = /STS\s+[A-Za-z]+.{0,120}?failed/;

/** Any read of the error's message, not one blessed ternary spelling. */
const RAW_RELAY = /\berr(?:or)?\s*(?:as\s+Error\s*\)?)?\s*\)?\s*\.message\b|\berr(?:or)?\.message\b/;

/** A CALL to the shared helper, not a comment mentioning it. */
const HELPER_CALL = /describeAwsFailureForWarn\s*\(/;

/**
 * How many source lines around the announcing line count as part of the site.
 *
 * Measured, not guessed: seven sites render inline on the announcing line or
 * the one after it, and one (`local-invoke.ts`'s `--assume-role` site) hoists
 * the render into a `const reason = ...` two lines above. A one-sided window
 * reported that one as unguarded. The numbers are the measured need and no
 * more — a wider window lets one site's helper call vouch for an unguarded
 * neighbour.
 */
const LINES_BEFORE = 2;
const LINES_AFTER = 1;

interface Finding {
  file: string;
  line: number;
  /** The window with `//` comments stripped, so a comment cannot vouch for code. */
  code: string;
}

/** Strip `//` comments so a comment naming the helper cannot satisfy the check. */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const t = l.trimStart();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
      return l;
    })
    .join('\n');
}

function commandFiles(): string[] {
  return readdirSync(COMMANDS)
    .filter((f) => f.endsWith('.ts'))
    .sort();
}

function stsFailureRelays(file: string): Finding[] {
  const lines = readFileSync(join(COMMANDS, file), 'utf8').split('\n');
  const found: Finding[] = [];
  for (const [i, line] of lines.entries()) {
    const bare = line.trimStart();
    // Prose cannot relay anything.
    if (bare.startsWith('//') || bare.startsWith('*') || bare.startsWith('/*')) continue;
    if (!STS_FAILURE_LINE.test(line)) continue;
    const window = lines.slice(Math.max(0, i - LINES_BEFORE), i + LINES_AFTER + 1).join('\n');
    found.push({ file, line: i + 1, code: stripLineComments(window) });
  }
  return found;
}

describe('#570 — a tenth STS relay site cannot be added unguarded', () => {
  const all = commandFiles().flatMap(stsFailureRelays);

  it('finds the STS failure lines it is supposed to be guarding', () => {
    // Non-vacuity: if the regex ever stops matching (a reworded message, a
    // renamed file), every assertion below passes over an empty list. Both the
    // count AND the identity of the files carrying them are pinned, so a new
    // site in a file not previously carrying one fails here rather than
    // slipping past a hard-coded list.
    expect(all).toHaveLength(9);
    expect([...new Set(all.map((f) => f.file))].sort()).toEqual([
      'ecs-service-emulator.ts',
      'local-invoke-agentcore.ts',
      'local-invoke.ts',
      'local-run-task.ts',
      'local-start-api.ts',
    ]);
  });

  it('routes every one of them through a describeAwsFailureForWarn CALL', () => {
    const unguarded = all.filter((f) => !HELPER_CALL.test(f.code));
    expect(
      unguarded.map((f) => `${f.file}:${f.line}`),
      'an STS failure warn that does not render its error through the shared policy'
    ).toEqual([]);
  });

  it('leaves none of them reading the raw error message', () => {
    const raw = all.filter((f) => RAW_RELAY.test(f.code));
    expect(
      raw.map((f) => `${f.file}:${f.line}`),
      'an STS failure warn still reading err.message directly'
    ).toEqual([]);
  });

  it('proves the guard discriminates, on each of the three evasions it closes', () => {
    // Without this, the assertions above are "no bad rows in a list I built"
    // and would pass just as well against a matcher that matches nothing.

    // (a) the shape a tenth site would have, inline.
    const inline = [
      '      logger.warn(',
      "        `--assume-role: STS AssumeRole(${arn}) failed: ${err instanceof Error ? err.message : String(err)}. ` +",
      "          'Falling back.'",
    ].join('\n');
    expect(STS_FAILURE_LINE.test(inline.split('\n')[1]!)).toBe(true);
    expect(HELPER_CALL.test(stripLineComments(inline))).toBe(false);
    expect(RAW_RELAY.test(stripLineComments(inline))).toBe(true);

    // (b) a comment naming the helper must NOT vouch for the code.
    const commentOnly = [
      '      // rendered via describeAwsFailureForWarn(err, ...)',
      "        `STS AssumeRole failed: ${(err as Error).message}`",
    ].join('\n');
    expect(HELPER_CALL.test(stripLineComments(commentOnly))).toBe(false);
    expect(RAW_RELAY.test(stripLineComments(commentOnly))).toBe(true);

    // (c) a spelling the first draft's raw-relay regex missed.
    expect(RAW_RELAY.test('`${error.message}`')).toBe(true);

    // And the positive control: a genuine site is accepted.
    const guarded = "        `STS GetCallerIdentity failed: ${describeAwsFailureForWarn(err, 'x')}`";
    expect(STS_FAILURE_LINE.test(guarded)).toBe(true);
    expect(HELPER_CALL.test(stripLineComments(guarded))).toBe(true);
    expect(RAW_RELAY.test(stripLineComments(guarded))).toBe(false);
  });
});
