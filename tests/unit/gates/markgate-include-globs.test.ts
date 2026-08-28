import { describe, it, expect } from 'vite-plus/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fence for issue #630.
 *
 * `.markgate.yml`'s `include:` lists decide which edits stale which gate
 * marker, and a glob there fails SILENTLY in the direction that matters: an
 * entry matching no file looks exactly like an entry doing its job. Nothing
 * re-reads a gate config, so the drift is unbounded in time.
 *
 * MEASURED on the tree this test was added to: the `check` gate's include
 * carried `vitest.config.ts`, `.eslintrc*` and `.prettierrc*`, none of which
 * this repo has ever had (`git ls-files | grep -E '^(vitest\.config\.ts|\.eslintrc|\.prettierrc)'`
 * returned zero rows, and no untracked copy existed either), while the real
 * `vite.config.ts` -- the file holding the vitest `include` globs and every
 * `vp run <task>` definition, i.e. the file that decides what "green" MEANS --
 * was absent. Narrowing the vitest include there left the suite green AND the
 * marker fresh with most of the suite no longer running.
 *
 * The population is derived from the config itself rather than hand-listed, so
 * a gate or an entry added later is scanned with no edit here. Matching is
 * delegated to `git ls-files -- ':(glob)<entry>'` instead of a hand-rolled
 * glob-to-regex step: the property under test is "matches nothing", and a
 * home-grown matcher getting `**` or a leading dot wrong would report exactly
 * that for a live entry.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONFIG = join(repoRoot, '.markgate.yml');

interface Entry {
  gate: string;
  glob: string;
  line: number;
}

/**
 * Minimal reader for the one shape `.markgate.yml` uses: two-space-indented
 * gate keys under a top-level `gates:`, each optionally carrying a
 * four-space-indented `include:` whose items are six-space-indented quoted
 * scalars. Deliberately strict -- a config that stops matching this shape
 * trips the floor below rather than silently parsing to nothing.
 */
export function parseIncludes(yaml: string): Entry[] {
  const out: Entry[] = [];
  let inGates = false;
  let gate: string | null = null;
  let inInclude = false;
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^gates:\s*$/.test(line)) {
      inGates = true;
      continue;
    }
    if (!inGates) continue;
    // A non-indented, non-blank, non-comment line ends the `gates:` block.
    if (/^\S/.test(line)) {
      inGates = false;
      gate = null;
      inInclude = false;
      continue;
    }
    const gateHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (gateHeader) {
      gate = gateHeader[1] ?? null;
      inInclude = false;
      continue;
    }
    if (/^ {4}include:\s*$/.test(line)) {
      inInclude = true;
      continue;
    }
    if (!inInclude || gate === null) continue;
    if (/^\s*(#.*)?$/.test(line)) continue; // blank line or comment inside the list
    const item = /^ {6}- "([^"]+)"\s*$/.exec(line);
    if (item) {
      out.push({ gate, glob: item[1] ?? '', line: i + 1 });
      continue;
    }
    inInclude = false; // anything else ends the list
  }
  return out;
}

function matchCount(glob: string): number {
  const out = execFileSync('git', ['ls-files', '-z', '--', `:(glob)${glob}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f.length > 0).length;
}

/**
 * A literal path that git deliberately ignores is a legitimate zero-match
 * entry: `.markgate-pr-review-sha` is a gitignored sentinel whose whole job is
 * to be rewritten by `/review-pr`, and it does not exist at all in a fresh
 * worktree. Anything else matching nothing is the defect.
 */
function isIgnoredSentinel(glob: string): boolean {
  if (/[*?[\]]/.test(glob)) return false;
  return spawnSync('git', ['check-ignore', '-q', '--', glob], { cwd: repoRoot }).status === 0;
}

describe('.markgate.yml include globs', () => {
  const yaml = readFileSync(CONFIG, 'utf8');
  const entries = parseIncludes(yaml);

  it('the parser actually sees the config (the scan is not vacuous)', () => {
    // 5 gates carried an `include:` when this was written, holding 22 entries
    // between them. A parse that stopped matching would otherwise report
    // "no dead globs" as green.
    const gates = [...new Set(entries.map((e) => e.gate))].sort();
    expect(gates, 'no gate include lists parsed out of .markgate.yml').toContain('check');
    expect(gates.length).toBeGreaterThanOrEqual(4);
    expect(entries.length).toBeGreaterThanOrEqual(15);
  });

  it('every include entry matches at least one tracked file', () => {
    const dead = entries
      .filter((e) => !isIgnoredSentinel(e.glob))
      .filter((e) => matchCount(e.glob) === 0)
      .map((e) => `.markgate.yml:${e.line} gate '${e.gate}' includes "${e.glob}"`);
    expect(
      dead,
      `these include entries match no tracked file, so they scope nothing:\n${dead.join('\n')}\n` +
        `A glob matching nothing is indistinguishable from one doing its job. Remove it, ` +
        `or correct it to the file it was meant to name.`
    ).toEqual([]);
  });

  it("the check gate scopes the files that decide what 'green' means", () => {
    // Named rather than derived: these three are in the include for a reason
    // the other entries do not share -- they are not READ by any assertion,
    // they decide what the suite selects (`vite.config.ts`), which binaries
    // run it (`.mise.toml`), and what the marker MEANS (`.markgate.yml`).
    // Nothing else would notice one being dropped.
    const checkGlobs = entries.filter((e) => e.gate === 'check').map((e) => e.glob);
    for (const g of ['vite.config.ts', '.mise.toml', '.markgate.yml']) {
      expect(checkGlobs, `the check gate no longer scopes ${g}`).toContain(g);
    }
  });

  it('the check gate scopes the shell hook suites that /check runs', () => {
    // The two halves of issue #630's decision, each inert without the other:
    // the include entry makes a hook edit stale the marker, and `/check`
    // running `test:hooks` makes the run that clears it execute the suites.
    const checkGlobs = entries.filter((e) => e.gate === 'check').map((e) => e.glob);
    expect(checkGlobs, 'the check gate no longer scopes .claude/hooks/**').toContain(
      '.claude/hooks/**'
    );
    const skill = readFileSync(join(repoRoot, '.claude', 'skills', 'check', 'SKILL.md'), 'utf8');
    // Anchored to a NUMBERED STEP, not to any mention. A bare `toContain`
    // passed with the step deleted (measured as probe P4): the rationale
    // paragraph below the list also spells `vp run test:hooks`, so the
    // assertion was reading a confluence point rather than the instruction.
    expect(
      skill,
      '/check no longer lists `vp run test:hooks` as a numbered step, so the check marker ' +
        'would attest to a suite that excludes the .claude/hooks/*.test.sh assertions ' +
        '(issue #630)'
    ).toMatch(/^\d+\. `vp run test:hooks`/m);
    const config = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf8');
    expect(
      config,
      '`vp run verify` no longer chains test:hooks, so the alias reports a green the ' +
        'check gate does not mean'
      // `[^}]*` keeps the match inside the `verify:` block -- with `[\s\S]*?`
      // the scan would run past it and could be satisfied by an occurrence in
      // any later task.
    ).toMatch(/verify:\s*\{[^}]*vp run test:hooks/);
  });

  it('the parser reports a dead entry rather than dropping it (guard the guard)', () => {
    // Guard-the-guard: without this, a parser that silently returned [] would
    // make the sweep above pass on any config at all. Uses the three entries
    // this issue actually removed, so the fixture is the measured defect.
    const parsed = parseIncludes(
      [
        'gates:',
        '  demo:',
        '    hash: files',
        '    include:',
        '      # a comment inside the list',
        '      - "vitest.config.ts"',
        '      - ".eslintrc*"',
        '      - ".prettierrc*"',
        '      - "vite.config.ts"',
        '  other:',
        '    ttl: 30m',
        '',
      ].join('\n')
    );
    expect(parsed.map((e) => e.glob)).toEqual([
      'vitest.config.ts',
      '.eslintrc*',
      '.prettierrc*',
      'vite.config.ts',
    ]);
    expect(parsed.every((e) => e.gate === 'demo')).toBe(true);
    // And the matcher must actually call those three dead: if `matchCount`
    // returned a positive number for anything, the sweep above could never
    // fail.
    expect(
      ['vitest.config.ts', '.eslintrc*', '.prettierrc*'].map(matchCount),
      'a file now matches one of the globs #630 removed as dead -- re-check the include'
    ).toEqual([0, 0, 0]);
    expect(matchCount('vite.config.ts')).toBe(1);
  });
});
