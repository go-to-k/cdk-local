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
 * It is a SOURCE-TEXT check, and every draft of it has been weaker than it
 * read. Five evasions found by review are closed, each with the assertion that
 * closes it:
 *
 *   - A tenth site in a SIXTH file was invisible, because the file list was
 *     hard-coded. The scan walks every `src/cli/commands/*.ts` now and the file
 *     set is asserted rather than assumed.
 *   - The helper check matched the window TEXT, and every site carries a
 *     comment naming the helper — so a tenth site keeping the comment and
 *     writing `${(err as Error).message}` passed. A CALL is matched now.
 *   - Comment stripping only handled a LEADING `//`; a TRAILING one on a line
 *     of real code still vouched for it.
 *   - The raw-relay check matched one exact ternary spelling.
 *   - Detection was per-line, so a template wrapping across a `+` — the house
 *     style at four of the nine sites — was invisible.
 *
 * WHAT IT STILL DOES NOT CATCH, stated so nobody reads more into a green run:
 *
 *   - It does not match the error VALUE. A `describeAwsFailureForWarn(other, …)`
 *     one line away vouches for an unguarded neighbour. Only per-error matching
 *     fixes that, which needs an AST.
 *   - It is wording-bound. A tenth site spelled `STS ${op} failure` or with no
 *     `STS` token at all produces no finding — though a copy-paste-shaped one
 *     trips the exact-9 count loudly.
 *   - `readdirSync` is not recursive, so a future `src/cli/commands/<subdir>/`
 *     is unscanned.
 *
 * Its scope stays narrow on purpose: only lines that name an STS operation as
 * having failed. A broader rule ("no `err.message` in any warn") would be
 * wrong — these files carry dozens of legitimate Docker / filesystem / synth
 * relays, and a fence that has to be suppressed is a fence nobody keeps.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..', 'src');
const COMMANDS = join(SRC, 'cli', 'commands');

/**
 * Announces an STS failure. Matched against a JOINED window rather than one
 * line: four of the nine existing sites wrap their template across a `+`,
 * which is the house style, and a per-line pattern misses every one of those
 * in the FAIL-OPEN direction (no finding, so no count trip either).
 *
 * `STS` is matched CASE-SENSITIVELY and on a word boundary, and both halves
 * were paid for. A case-insensitive `/sts\s+/` matched the word `lists ` in
 * `local-start-alb.ts`'s `--tls-cert` help text ("the cert lists DNS:localhost
 * ... will fail the SAN check"), reporting an option definition as an
 * unguarded relay. cdk-local writes the service as `STS` everywhere, so
 * insisting on that spelling costs nothing and removes a whole class of prose
 * false positives.
 */
const STS_FAILURE_LINE = /\bSTS\s+[A-Za-z$][\s\S]{0,200}?fail/;

/**
 * A read of anything wire-derived off the error. Deliberately broader than
 * `.message`: `err.name` is the `x-amzn-errortype` forging vector this whole
 * change exists to close, and `String(err)` / `err.stack` carry the message
 * anyway. Each spelling here was added because a review probe got past the
 * previous one.
 */
const RAW_RELAY =
  /\b(?:err|error|e)\s*(?:as\s+[A-Za-z.<>\[\]]+\s*)?\)?\s*[?!]?\.\s*(?:message|name|stack)\b|\bString\s*\(\s*err/;

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

/**
 * Remove comment text so a comment cannot vouch for code.
 *
 * Both forms matter and the first draft only handled the first: a LEADING
 * `//` line, and a TRAILING `// ... describeAwsFailureForWarn(err, op)` on a
 * line of real code, which satisfied the helper check while the code beside it
 * relayed the message raw. Measured.
 *
 * The `//` strip is naive about a `//` inside a string literal. That direction
 * is fail-CLOSED here (it can only remove text, never add a helper call), so
 * the trade is accepted.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const t = l.trimStart();
      if (t.startsWith('*') || t.startsWith('/*')) return '';
      return l.replace(/\/\/.*$/, '');
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
    // A site is announced by a line that opens a template naming STS; the
    // `failed` half may wrap onto the next one, so the DETECTION window looks
    // forward from here while the GUARD window also looks back (the two
    // ARN-quoting sites hoist their render into a `const reason` above).
    const ahead = lines.slice(i, i + LINES_AFTER + 1).join('\n');
    if (!/\bSTS\s+[A-Za-z$]/.test(line) || !STS_FAILURE_LINE.test(ahead)) continue;
    const window = lines.slice(Math.max(0, i - LINES_BEFORE), i + LINES_AFTER + 1).join('\n');
    found.push({ file, line: i + 1, code: stripComments(window) });
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

  it('proves the guard discriminates, on each evasion it closes', () => {
    // Without this, the assertions above are "no bad rows in a list I built"
    // and would pass just as well against a matcher that matches nothing.

    // (a) the shape a tenth site would have, inline.
    const inline = [
      '      logger.warn(',
      "        `--assume-role: STS AssumeRole(${arn}) failed: ${err instanceof Error ? err.message : String(err)}. ` +",
      "          'Falling back.'",
    ].join('\n');
    expect(STS_FAILURE_LINE.test(inline.split('\n')[1]!)).toBe(true);
    expect(HELPER_CALL.test(stripComments(inline))).toBe(false);
    expect(RAW_RELAY.test(stripComments(inline))).toBe(true);

    // (b) a comment naming the helper must NOT vouch for the code.
    const commentOnly = [
      '      // rendered via describeAwsFailureForWarn(err, ...)',
      "        `STS AssumeRole failed: ${(err as Error).message}`",
    ].join('\n');
    expect(HELPER_CALL.test(stripComments(commentOnly))).toBe(false);
    expect(RAW_RELAY.test(stripComments(commentOnly))).toBe(true);

    // (c) spellings earlier drafts' raw-relay regex missed, each from a probe.
    for (const spelling of [
      '`${error.message}`',
      '`${(err as any).message}`',
      '`${err?.message}`',
      '`${err!.message}`',
      '`${e.message}`',
      '`${(err as Error).name}`',
      '`${err.stack}`',
      '`${String(err)}`',
    ]) {
      expect(RAW_RELAY.test(spelling), `RAW_RELAY missed ${spelling}`).toBe(true);
    }

    // (d) a TRAILING comment naming the helper must not vouch for the code.
    const trailing =
      "        `STS AssumeRole failed: ${String(err)}`, // describeAwsFailureForWarn(err, 'x')";
    expect(HELPER_CALL.test(stripComments(trailing))).toBe(false);
    expect(RAW_RELAY.test(stripComments(trailing))).toBe(true);

    // (e) a template wrapping across a `+` is still DETECTED.
    const wrapped = ['      `... STS AssumeRole(${arn}) ` +', '        `failed: ${err.message}`'].join(
      '\n'
    );
    expect(STS_FAILURE_LINE.test(wrapped)).toBe(true);

    // (f) and prose must NOT be: the `/i` draft matched `lists DNS...fail` in a
    // `--tls-cert` help string and reported an option definition as a relay.
    expect(
      STS_FAILURE_LINE.test('the cert lists DNS:localhost as SubjectAltName, will fail the check')
    ).toBe(false);

    // And the positive control: a genuine site is accepted.
    const guarded = "        `STS GetCallerIdentity failed: ${describeAwsFailureForWarn(err, 'x')}`";
    expect(STS_FAILURE_LINE.test(guarded)).toBe(true);
    expect(HELPER_CALL.test(stripComments(guarded))).toBe(true);
    expect(RAW_RELAY.test(stripComments(guarded))).toBe(false);
  });
});
