import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fence for issue #630.
 *
 * `.markgate.yml`'s gate scopes decide which edits stale which marker, and an
 * entry there fails SILENTLY in the direction that matters: a glob matching
 * nothing looks exactly like one doing its job.
 *
 * MEASURED on the tree this test was added to. The `check` gate's include
 * carried `vitest.config.ts`, `.eslintrc*` and `.prettierrc*`, none of which
 * this repo has ever had, while the real `vite.config.ts` -- the file holding
 * the vitest `include` globs and every `vp run <task>` definition, i.e. the
 * file that decides what "green" MEANS -- was absent. Against markgate's OWN
 * resolution rather than an `ls`, `markgate verify check --explain` on the
 * pre-fix config resolved 949 files with zero of `vite.config.ts` /
 * `.mise.toml` / `.node-version` / `.claude/hooks/**` among them; on the fixed
 * config it resolves 981 with all of them present.
 *
 * ## Why this is re-implemented here rather than delegated to markgate
 *
 * markgate 0.4.1 ships `markgate config lint --json`, which reports exactly
 * this class -- run against the pre-fix config it named all three dead entries
 * by index (`gates.check.include[11]: 'vitest.config.ts' matches 0 files`).
 * It is the better instrument and the PR body cites it. It cannot be the fence
 * that RUNS, because `.github/workflows/ci.yml` installs `vp` only: there is
 * no mise and no markgate binary in CI, so a test shelling out to it would
 * fail there. So the check is duplicated in TypeScript, and the duplication is
 * declared rather than hidden.
 *
 * ## The parser refuses what it cannot model, and that is the whole design
 *
 * A hand-rolled YAML reader's failure mode is silent truncation: an entry
 * spelled in a shape the regex misses ends the list, taking every later entry
 * in that gate with it, and the sweep then reports "no dead globs" over a
 * population it never saw. Three defences, in order of importance:
 *
 *   1. every `      - ` line inside a scope list MUST parse, or the parser
 *      THROWS -- an unmodelled spelling is loud, never a quiet skip;
 *   2. the entry count is reconciled against an independent scan of those
 *      lines, and the gate-name set likewise, so a whole gate cannot vanish;
 *   3. `exclude:` is parsed and REFUSED. markgate honours it and subtracts it
 *      from the scope -- measured here with one variable changed: adding
 *      `exclude: ["vite.config.ts"]` while leaving the include untouched took
 *      `markgate verify check --explain` from 981 resolved files to 980 and
 *      removed `vite.config.ts` from the listing, while
 *      `markgate config lint --json` reported nothing about it. A fence
 *      modelling only `include` would keep reporting full coverage while an
 *      `exclude` silently subtracted. No gate uses one today; if one ever
 *      should, teach the sweep to subtract it BEFORE deleting that assertion.
 *
 * Matching is the union of `git ls-files -- ':(glob)<entry>'` and
 * `fs.globSync`, and an entry counts as dead only when BOTH are empty. Neither
 * alone is right: git sees only the index, so an entry like `dist/**` (16 real
 * files here, none tracked) is live for markgate's `hash: files` and would
 * read as dead; and git's wildmatch does not do brace alternation, which
 * markgate's doublestar does. The union errs toward NOT reporting a dead glob,
 * which is the right direction for a fence whose false positive would block a
 * legitimate config.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONFIG = join(repoRoot, '.markgate.yml');

interface Entry {
  gate: string;
  key: 'include' | 'exclude';
  glob: string;
  line: number;
}

interface ParsedConfig {
  entries: Entry[];
  /** Every gate key seen under `gates:`, whether or not it declares a scope. */
  gates: string[];
}

/**
 * Reader for the block shape `.markgate.yml` uses: two-space-indented gate
 * keys under a top-level `gates:`, each optionally carrying a
 * four-space-indented `include:` / `exclude:` whose items are
 * six-space-indented scalars. Double-quoted, single-quoted and bare scalars
 * are all accepted; anything else THROWS rather than ending the list.
 */
function parseConfig(yaml: string): ParsedConfig {
  const entries: Entry[] = [];
  const gates: string[] = [];
  let inGates = false;
  let gate: string | null = null;
  let key: 'include' | 'exclude' | null = null;
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const at = `.markgate.yml:${i + 1}`;
    if (/^gates:\s*$/.test(line)) {
      inGates = true;
      continue;
    }
    if (!inGates) continue;
    if (/^\S/.test(line)) {
      // A non-indented, non-blank, non-comment line ends the `gates:` block.
      if (!/^\s*(#.*)?$/.test(line)) {
        inGates = false;
        gate = null;
        key = null;
      }
      continue;
    }
    const gateHeader = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (gateHeader) {
      gate = gateHeader[1] ?? null;
      if (gate !== null) gates.push(gate);
      key = null;
      continue;
    }
    const scopeKey = /^ {4}(include|exclude):\s*(.*)$/.exec(line);
    if (scopeKey) {
      const rest = (scopeKey[2] ?? '').trim();
      if (rest !== '' && !rest.startsWith('#')) {
        // A flow sequence (`include: ["a","b"]`) or an anchor / alias.
        // Refusing is the point: silently skipping would drop the whole gate.
        throw new Error(
          `${at}: unsupported inline value for \`${scopeKey[1]}\` in gate '${gate}': ${rest}\n` +
            `This parser models the block-sequence form only. Rewrite it as a block list, ` +
            `or teach parseConfig the new shape -- do NOT let it be skipped.`
        );
      }
      key = scopeKey[1] === 'exclude' ? 'exclude' : 'include';
      continue;
    }
    if (key === null || gate === null) continue;
    if (/^\s*(#.*)?$/.test(line)) continue; // blank line or comment inside the list
    if (/^ {4}\S/.test(line)) {
      key = null; // a sibling key at the gate's own indent ends the list
      continue;
    }
    // The bare-scalar arm excludes YAML indicator characters in FIRST
    // position -- `[`/`{` open a flow collection, `&`/`*`/`!` an anchor,
    // alias or tag -- so `- [a, b]` throws instead of being read as the
    // literal glob "[a, b]". Later positions are unrestricted, because a
    // real glob may legitimately contain braces (`tsconfig{,.test}.json`).
    // A glob that genuinely starts with `*` must be quoted, which YAML
    // requires anyway.
    const item =
      /^ {6}- (?:"([^"]*)"|'([^']*)'|([^\s#[\]{}&*!|>%@`'"][^#]*?))\s*(?:#.*)?$/.exec(line);
    if (!item) {
      throw new Error(
        `${at}: could not parse this line inside gate '${gate}'.${key}:\n  ${line}\n` +
          `An unparsed line used to END the list silently, dropping this entry AND every ` +
          `later entry in the gate -- the sweep then reports "no dead globs" over a ` +
          `population it never saw. Extend parseConfig instead of loosening this.`
      );
    }
    entries.push({ gate, key, glob: item[1] ?? item[2] ?? (item[3] ?? '').trim(), line: i + 1 });
  }
  return { entries, gates };
}

/**
 * Independent counts, used to reconcile the parse. Deliberately NOT derived
 * from `parseConfig` -- a floor computed by the thing it is checking cannot
 * notice that thing losing entries.
 */
function rawCounts(yaml: string): { items: number; gates: string[] } {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^gates:\s*$/.test(l));
  const body = start === -1 ? [] : lines.slice(start + 1);
  const end = body.findIndex((l) => /^\S/.test(l) && !/^\s*#/.test(l));
  const scoped = end === -1 ? body : body.slice(0, end);
  return {
    items: scoped.filter((l) => /^ {6}- /.test(l)).length,
    gates: scoped.flatMap((l) => {
      const m = /^ {2}([A-Za-z0-9_-]+):/.exec(l);
      return m?.[1] !== undefined ? [m[1]] : [];
    }),
  };
}

function trackedFiles(glob: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', `:(glob)${glob}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\0')
      .filter((f) => f.length > 0);
  } catch {
    // A pathspec git refuses (e.g. a leading `/`) falls through to the on-disk
    // arm rather than escaping as a bare "Command failed: git ls-files".
    return [];
  }
}

/** Tracked matches (git's wildmatch) union on-disk matches (doublestar-ish). */
function matchCount(glob: string): number {
  const tracked = trackedFiles(glob).length;
  if (tracked > 0) return tracked;
  try {
    return globSync(glob, { cwd: repoRoot }).length;
  } catch {
    return 0;
  }
}

/**
 * The single documented zero-match entry: a gitignored sentinel `/review-pr`
 * rewrites, which does not exist at all in a fresh worktree. Spelled as an
 * explicit one-element allow-list rather than a `git check-ignore` rule --
 * that rule exempted every ignored path, so a typo'd `dist/index.js` would
 * have been waved through as well.
 */
const ZERO_MATCH_ALLOWED = ['.markgate-pr-review-sha'];

describe('.markgate.yml gate scopes', () => {
  const yaml = readFileSync(CONFIG, 'utf8');
  const parsed = parseConfig(yaml);
  const raw = rawCounts(yaml);

  it('the parse loses nothing (reconciled against an independent count)', () => {
    // Asserted as an EQUALITY against a separate scan rather than as a `>=`
    // floor: a floor with slack is exactly what let an earlier draft of this
    // file drop 11 of 26 entries and still pass.
    expect(
      parsed.entries.length,
      `parseConfig produced ${parsed.entries.length} entries but .markgate.yml has ` +
        `${raw.items} \`      - \` lines under \`gates:\`. The parse is losing entries, ` +
        `and every lost entry is one this sweep never checks.`
    ).toBe(raw.items);
    expect(parsed.gates, 'a gate key was missed by the parse').toEqual(raw.gates);
    expect(parsed.gates, 'the check gate vanished from the parse').toContain('check');
    expect(raw.items, 'the config has almost no scope entries -- did the scan find it?')
      .toBeGreaterThanOrEqual(15);
  });

  it('no gate declares an `exclude:` this sweep would not subtract', () => {
    // markgate honours `exclude` and subtracts it from the resolved scope.
    // MEASURED with one variable changed (include untouched): adding
    // `exclude: ["vite.config.ts"]` to the check gate took
    // `markgate verify check --explain` from 981 resolved files to 980 and
    // removed `vite.config.ts` from the listing, while
    // `markgate config lint --json` reported nothing about it. The sweep below
    // models `include` only, so it would keep reporting full coverage while an
    // `exclude` silently subtracted. Refuse the shape rather than mis-model it.
    const excludes = parsed.entries.filter((e) => e.key === 'exclude');
    expect(
      excludes.map((e) => `.markgate.yml:${e.line} gate '${e.gate}' excludes "${e.glob}"`),
      'a gate grew an `exclude:`. Teach the dead-glob sweep below to subtract it from ' +
        'the include set FIRST, then remove this assertion -- do not just delete it.'
    ).toEqual([]);
  });

  it('every include entry matches at least one file', () => {
    const dead = parsed.entries
      .filter((e) => e.key === 'include')
      .filter((e) => !ZERO_MATCH_ALLOWED.includes(e.glob))
      .filter((e) => matchCount(e.glob) === 0)
      .map((e) => `.markgate.yml:${e.line} gate '${e.gate}' includes "${e.glob}"`);
    expect(
      dead,
      `these include entries match no file, so they scope nothing:\n${dead.join('\n')}\n` +
        `A glob matching nothing is indistinguishable from one doing its job. Remove it, ` +
        `or correct it to the file it was meant to name. (markgate's own ` +
        `\`markgate config lint --json\` reports the same class, but CI has no markgate.)`
    ).toEqual([]);
  });

  it('the allow-listed zero-match entry really is a gitignored sentinel', () => {
    // Guard the exemption: it must stay a deliberate sentinel, not a place to
    // park a broken glob. Both properties are required -- still referenced by
    // a gate, and still ignored by git.
    for (const glob of ZERO_MATCH_ALLOWED) {
      expect(
        parsed.entries.some((e) => e.glob === glob),
        `${glob} is allow-listed here but no gate references it any more -- drop the entry`
      ).toBe(true);
      const ignored = execFileSync('git', ['check-ignore', '-v', '--', glob], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(ignored, `${glob} is no longer gitignored, so it should not be exempt`).toContain(
        glob
      );
    }
  });

  it('every file this fence READS is inside the check gate it guards', () => {
    // The go-to-k/cdk-local#620 rule, applied to this file: a checker INPUT
    // outside the include can red the suite while the marker stays fresh.
    // This fence became such a reader in its own second commit (it asserts
    // `ci.yml` still runs `test:hooks`), which would have re-introduced the
    // very class it exists to close -- measured as probe Q17, GREEN before
    // this case existed.
    //
    // The population is DERIVED from this file's own source rather than
    // hand-listed, so a `readFileSync(join(repoRoot, ...))` added later is
    // covered with no edit here.
    const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const reads = [
      ...new Set(
        [...selfSource.matchAll(/join\(\s*repoRoot,([^)]*)\)/g)]
          .map((m) =>
            [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((q) => q[1] ?? '').join('/')
          )
          .filter((path) => path.length > 0)
      ),
    ].sort();
    expect(
      reads.length,
      'the self-scan found almost no `join(repoRoot, ...)` reads -- it has stopped ' +
        'matching this file, so it would report full coverage over nothing'
    ).toBeGreaterThanOrEqual(5);

    const checkGlobs = parsed.entries
      .filter((e) => e.gate === 'check' && e.key === 'include')
      .map((e) => e.glob);
    const uncovered = reads.filter(
      (path) => !checkGlobs.some((g) => trackedFiles(g).includes(path))
    );
    expect(
      uncovered,
      `this test reads ${uncovered.join(', ')}, which no \`check\` include entry covers. ` +
        `Editing one of those reds this suite while a previously-set marker stays FRESH ` +
        `-- the go-to-k/cdk-local#620 class. Scope it in, or stop reading it.`
    ).toEqual([]);
  });

  it("the check gate scopes the files that decide what 'green' means", () => {
    // Named rather than derived: these four are in the include for a reason
    // the other entries do not share -- they are not READ by any assertion.
    // They decide what the suite selects (`vite.config.ts`), which binaries
    // run it (`.mise.toml` pins vp + markgate, `.node-version` pins the Node
    // they run on), and what the marker MEANS (`.markgate.yml`). Nothing else
    // would notice one being dropped.
    const checkGlobs = parsed.entries
      .filter((e) => e.gate === 'check' && e.key === 'include')
      .map((e) => e.glob);
    for (const g of ['vite.config.ts', '.mise.toml', '.node-version', '.markgate.yml']) {
      expect(checkGlobs, `the check gate no longer scopes ${g}`).toContain(g);
    }
  });

  it('the check gate scopes the shell hook suites that /check runs', () => {
    // The two halves of issue #630's decision, each inert without the other:
    // the include entry makes a hook edit stale the marker, and `/check`
    // running `test:hooks` makes the run that clears it execute the suites.
    const checkGlobs = parsed.entries
      .filter((e) => e.gate === 'check' && e.key === 'include')
      .map((e) => e.glob);
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

    const verifyPr = readFileSync(
      join(repoRoot, '.claude', 'skills', 'verify-pr', 'SKILL.md'),
      'utf8'
    );
    // /verify-pr sets the same marker, so it owes the same step -- anchored to
    // the STEP BULLET, not to any mention. A bare `toContain` stayed GREEN with
    // the bullet deleted (measured as probe Q13), because the skill's own
    // output table also names the command: the identical confluence-point
    // mistake this file already fixed once for check/SKILL.md, one file over.
    expect(
      verifyPr,
      '/verify-pr sets the `check` marker but no longer lists `vp run test:hooks` as a ' +
        'step under "Tests"'
    ).toMatch(/^ {3}- `vp run test:hooks` — the shell suites/m);
    // ...and the report table must still carry it, or the step can be run and
    // silently omitted from the verdict the marker is set on.
    expect(
      verifyPr,
      "/verify-pr's output table lost its `vp run test:hooks` row"
    ).toMatch(/^\| hook shell suites \(`vp run test:hooks`\) \|/m);

    const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    // The claimed backstop. `.markgate.yml` and both skills say CI runs this;
    // nothing else re-reads the workflow.
    expect(ci, 'ci.yml no longer runs `vp run test:hooks`').toMatch(
      /^\s*- run: vp run test:hooks\s*$/m
    );

    const config = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf8');
    // `[^}]*` keeps the match inside the `verify:` block -- with `[\s\S]*?`
    // the scan would run past it and could be satisfied by an occurrence in
    // any later task.
    expect(
      config,
      '`vp run verify` no longer chains test:hooks, so the alias reports a green the ' +
        'check gate does not mean'
    ).toMatch(/verify:\s*\{[^}]*vp run test:hooks/);
    expect(
      config,
      'the `verify` task is cacheable again, so `vp run verify` can replay a green ' +
        'recorded before a .claude/hooks/** edit'
    ).toMatch(/verify:\s*\{[^}]*cache:\s*false/);
  });

  it('the rules doc names the same scope the config does', () => {
    // `.claude/rules/hooks.md` restates the check gate's scope in prose, and
    // this PR's own subject is a scope enumeration going stale unnoticed.
    // Every include entry must appear in that paragraph.
    // Whitespace-NORMALISED before matching. The paragraph is hard-wrapped
    // prose, so a line-sensitive regex breaks whenever an edit moves the wrap
    // column -- which it did, the first time this paragraph was edited after
    // the assertion was written.
    const rules = readFileSync(join(repoRoot, '.claude', 'rules', 'hooks.md'), 'utf8').replace(
      /\s+/g,
      ' '
    );
    const block = /- `check` — recorded by `\/check`.*?Only invalidated by changes in that scope\./.exec(
      rules
    );
    expect(
      block,
      'the check-gate scope paragraph in .claude/rules/hooks.md moved or was renamed'
    ).not.toBeNull();
    const prose = block?.[0] ?? '';
    const missing = parsed.entries
      .filter((e) => e.gate === 'check' && e.key === 'include')
      .map((e) => e.glob)
      .filter((g) => !prose.includes(g));
    expect(
      missing,
      `.claude/rules/hooks.md's check-gate scope paragraph does not name ${missing.join(', ')}. ` +
        `A prose enumeration of a config is exactly the thing issue #630 found stale; keep ` +
        `it in step with .markgate.yml or stop enumerating.`
    ).toEqual([]);
  });

  it('the parser reports a dead entry rather than dropping it (guard the guard)', () => {
    // Guard-the-guard: without this, a parser that silently returned [] would
    // make the sweep above pass on any config at all. Uses the three entries
    // this issue actually removed, so the fixture is the measured defect, plus
    // the spellings a future contributor might reach for instead.
    const parsedFixture = parseConfig(
      [
        'gates:',
        '  demo:',
        '    hash: files',
        '    include:',
        '      # a comment inside the list',
        '      - "vitest.config.ts"',
        "      - '.eslintrc*'",
        '      - .prettierrc*',
        '      - "vite.config.ts"',
        '  other:',
        '    ttl: 30m',
        '',
      ].join('\n')
    );
    expect(parsedFixture.entries.map((e) => e.glob)).toEqual([
      'vitest.config.ts',
      '.eslintrc*',
      '.prettierrc*',
      'vite.config.ts',
    ]);
    expect(parsedFixture.gates).toEqual(['demo', 'other']);
    expect(parsedFixture.entries.every((e) => e.gate === 'demo')).toBe(true);

    // An `exclude:` must be PARSED (so the refusal above can see it), not
    // skipped as an unknown key.
    const withExclude = parseConfig(
      ['gates:', '  demo:', '    exclude:', '      - "docs/**"', '    include:', '      - "src/**"', ''].join(
        '\n'
      )
    );
    expect(withExclude.entries.map((e) => `${e.key}:${e.glob}`)).toEqual([
      'exclude:docs/**',
      'include:src/**',
    ]);

    // An unmodelled spelling must THROW, not silently end the list.
    expect(() =>
      parseConfig(['gates:', '  demo:', '    include:', '      - [a, b]', ''].join('\n'))
    ).toThrow(/could not parse this line/);
    expect(() =>
      parseConfig(['gates:', '  demo:', '    include: ["a", "b"]', ''].join('\n'))
    ).toThrow(/unsupported inline value/);

    // And the matcher must actually call the three removed globs dead: if it
    // returned a positive number for anything, the sweep could never fail.
    expect(
      ['vitest.config.ts', '.eslintrc*', '.prettierrc*'].map(matchCount),
      'a file now matches one of the globs #630 removed as dead -- re-check the include'
    ).toEqual([0, 0, 0]);
    expect(matchCount('vite.config.ts')).toBe(1);
    // The union arm: an untracked-but-real path is LIVE for markgate's
    // `hash: files`, and git alone would call it dead.
    expect(
      matchCount('dist/**'),
      'the on-disk arm of matchCount stopped seeing untracked files, so an entry like ' +
        '`dist/**` would be reported dead while markgate digests it'
    ).toBeGreaterThan(0);
  });
});
