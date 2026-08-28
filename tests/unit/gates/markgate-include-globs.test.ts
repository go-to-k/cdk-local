import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fence for issue #630.
 *
 * `.markgate.yml`'s gate scopes decide which edits stale which marker, and an
 * entry there fails SILENTLY in the direction that matters: a glob matching
 * nothing looks exactly like one doing its job.
 *
 * MEASURED on the tree this was written for. The `check` gate's include
 * carried `vitest.config.ts`, `.eslintrc*` and `.prettierrc*`, none of which
 * this repo has ever had, while the real `vite.config.ts` -- the file holding
 * the vitest `include` globs and every `vp run <task>` definition, i.e. the
 * file that decides what "green" MEANS -- was absent. markgate's own linter
 * named all three on the pre-fix config:
 *
 *   gates.check.include[11]: 'vitest.config.ts' matches 0 files
 *   gates.check.include[12]: '.eslintrc*' matches 0 files
 *   gates.check.include[13]: '.prettierrc*' matches 0 files
 *
 * and `markgate verify check --explain` resolved zero of `vite.config.ts` /
 * `.mise.toml` / `.node-version` and zero `.claude/hooks/*` files into the
 * scope, against 30 hook files after the fix. (The scope's absolute SIZE is
 * deliberately not quoted anywhere here: `hash: files` digests untracked files
 * too, so the total moves with `dist/`, `node_modules/` and any scratch file
 * in the tree -- two reviewers measuring the same commit got different totals.
 * The counts above are the stable, reproducible half.)
 *
 * ## What this fence claims, and what it does NOT
 *
 * markgate 0.4.1 ships `markgate config lint --json`, which decides this
 * question EXACTLY -- it parses with yaml.v3 and matches with the same
 * doublestar walk `hash: files` uses. It is the right instrument and the PR
 * body cites its output. It cannot be the fence that RUNS, because
 * `.github/workflows/ci.yml` installs `vp` only: no mise, no markgate binary,
 * so a test shelling out to it would fail in CI. What runs here is therefore a
 * DELIBERATELY WEAKER approximation, and the weakness has a direction:
 *
 *   it may call a dead entry LIVE (over-approximation), and must never call a
 *   live entry DEAD.
 *
 * That is the safe direction for a fence whose false positive would block a
 * legitimate config. Two known over-approximations, both from git's pathspec
 * and Node's glob being more permissive than doublestar-over-files: a bare
 * directory name (`.claude/agents` rather than `.claude/agents/**`) and a glob
 * matching only directories. Both are checked EXPLICITLY below rather than
 * left to the general sweep, because writing `src` for `src/**` is this PR's
 * own defect class. Anything subtler belongs to `markgate config lint`, and
 * this file says so instead of pretending otherwise.
 *
 * ## Why a hand-rolled parser at all
 *
 * Because this repo has no YAML parser to reach for: `package.json` declares
 * none, and neither does the dev-dependency set (the sibling repos cdkd and
 * cdk-real-drift both DO have one, which is why their equivalents parse rather
 * than refuse). Adding a dependency to a lockfile so a single fence can read a
 * single config is a worse trade than refusing the shapes it cannot model —
 * and refusal turns out to be the STRICTER option, not the weaker one: a
 * parser accepts a novel spelling and quietly gets it wrong, while this one
 * stops. Read the refusals below as the point of the design, not as its
 * limitation.
 *
 * ## The parser refuses what it cannot model
 *
 * A hand-rolled YAML reader's failure mode is silent truncation: an entry in a
 * shape the regex misses ends the list, taking every later entry in that gate
 * with it, and the sweep then reports "no dead globs" over a population it
 * never saw. An earlier draft of this file had exactly that bug twice -- first
 * for single-quoted and bare scalars, then for a block sequence indented at
 * the parent key's own column, which is valid YAML that markgate accepts and
 * which a reviewer used to hide three dead globs from a 9/9 green run.
 *
 * The remedy is not a better regex. It is a COMPLETENESS check: the parser
 * records which lines it consumed, and a separate pass fails if any `- ` line
 * anywhere under `gates:` was not consumed. Item indentation is learned rather
 * than assumed, non-scope keys (`requires:`) have their items consumed and
 * discarded, and anything still unrecognised THROWS. A shape this file cannot
 * model becomes a loud failure, never a quiet omission.
 *
 * `exclude:` is parsed and REFUSED. markgate honours it and subtracts it from
 * the scope -- measured with one variable changed, adding
 * `exclude: ["vite.config.ts"]` while leaving the include untouched removed
 * `vite.config.ts` from `markgate verify check --explain` and dropped the
 * resolved total by exactly one, while `markgate config lint --json` reported
 * nothing about it. A fence modelling only `include` would keep reporting full
 * coverage while an `exclude` silently subtracted. No gate uses one today; if
 * one ever should, teach the sweep to subtract it BEFORE deleting that
 * assertion. (Cross-lane finding, go-to-k/cdk-real-drift#1838.)
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
  /** `hash:` value per gate, when one is declared. */
  hashOf: Map<string, string>;
  /** `base:` value per gate, when one is declared. */
  baseOf: Map<string, string>;
  /** 1-based line numbers of every `- ` item line the parser consumed. */
  consumed: Set<number>;
  /** Gates that DECLARED an `include:` key, whether or not items followed. */
  declaredInclude: string[];
}

/** Scalar forms a list item may take. Anything else throws. */
function scalar(raw: string, at: string, gate: string | null, key: string): string {
  const m = /^(?:"([^"]*)"|'([^']*)'|([^\s#[\]{}&*!|>%@`'"][^#]*?))\s*(?:#.*)?$/.exec(raw);
  if (!m) {
    throw new Error(
      `${at}: could not parse this list item inside gate '${gate}'.${key}:\n  ${raw}\n` +
        `Unparsed items used to END the list silently, dropping this entry AND every ` +
        `later one in the gate. Extend this parser instead of loosening the check that ` +
        `caught you.`
    );
  }
  return (m[1] ?? m[2] ?? (m[3] ?? '').trim()).trim();
}

/**
 * Reader for `.markgate.yml`'s block shape. Gate keys sit at two spaces under
 * a top-level `gates:`; a gate's keys at four. List items may be indented at
 * any column at or beyond their key's -- learned, not assumed, because the
 * assumption is what failed before.
 */
function parseConfig(yaml: string): ParsedConfig {
  const entries: Entry[] = [];
  const gates: string[] = [];
  const consumed = new Set<number>();
  const declaredInclude: string[] = [];
  const hashOf = new Map<string, string>();
  const baseOf = new Map<string, string>();
  let inGates = false;
  let gate: string | null = null;
  let key: string | null = null;
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').replace(/﻿/g, '').replace(/\t/g, '  ');
    const at = `.markgate.yml:${i + 1}`;
    if (/^gates:\s*$/.test(line)) {
      inGates = true;
      continue;
    }
    if (!inGates) continue;
    if (/^\s*(#.*)?$/.test(line)) continue; // blank or comment, at any indent
    if (/^\S/.test(line)) {
      inGates = false; // a new top-level key ends the gates block
      gate = null;
      key = null;
      continue;
    }
    const gateHeader = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (gateHeader) {
      gate = gateHeader[1] ?? null;
      if (gate !== null) gates.push(gate);
      key = null;
      continue;
    }
    const keyLine = /^ {4}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (keyLine) {
      const name = keyLine[1] ?? '';
      // The keys this fence has VERIFIED do not change the resolved scope --
      // deliberately NOT "markgate's key set", which an earlier version of
      // this comment claimed and which was false. markgate 0.4.1 also accepts
      // `composes` and `state_dir` (both silent under `config lint`, both
      // measured here as leaving `verify check --explain` at 983 files), and
      // they are refused anyway: this fence models scope, and a key whose
      // scope effect has only been spot-checked is not a key it can model.
      // Unknown keys used to be consumed and DISCARDED, so a typo'd
      // `includes:` took five globs out of the sweep with every assertion
      // green -- and a future key that SUBTRACTS from the scope, as `exclude`
      // does, would arrive the same silent way.
      if (!/^(hash|base|ttl|include|exclude|requires)$/.test(name)) {
        const known = /^(composes|state_dir)$/.test(name)
          ? `\`${name}\` IS a real markgate 0.4.1 key, and is refused here rather than ` +
            `ignored: this fence reports scope coverage, so it must not run over a key ` +
            `whose effect on scope it has not established. Establish it (one variable, ` +
            `against the pinned binary), then add it beside \`requires\`.`
          : `An unmodelled key may add to or SUBTRACT from the resolved scope, which ` +
            `would make every check below report coverage it does not have.`;
        throw new Error(
          `${at}: gate key \`${name}\` in gate '${gate}' is not modelled.\n${known}`
        );
      }
      const rest = (keyLine[2] ?? '').trim();
      const hasInlineValue = rest !== '' && !rest.startsWith('#');
      if ((name === 'include' || name === 'exclude') && hasInlineValue) {
        // A flow sequence (`include: ["a","b"]`) or an anchor / alias.
        // Refusing is the point: skipping it would drop the whole gate.
        throw new Error(
          `${at}: unsupported inline value for \`${name}\` in gate '${gate}': ${rest}\n` +
            `This parser models the block-sequence form only. Rewrite it as a block list, ` +
            `or teach the parser the new shape -- do NOT let it be skipped.`
        );
      }
      if (name === 'include' && gate !== null) declaredInclude.push(gate);
      // The VALUES of `hash` and `base`, not just their presence. `hash` is
      // the one knob that silently makes an include list inert; see the case
      // below for the measurement.
      if (gate !== null && hasInlineValue && (name === 'hash' || name === 'base')) {
        const value = rest.replace(/\s*#.*$/, '').trim();
        (name === 'hash' ? hashOf : baseOf).set(gate, value);
      }
      // A key with an inline value takes no items; one without may.
      key = hasInlineValue ? null : name;
      continue;
    }
    const itemLine = /^(\s+)- (.*)$/.exec(line);
    if (itemLine) {
      if (gate === null || key === null) {
        throw new Error(
          `${at}: a list item with no scope key above it:\n  ${line}\n` +
            `The parser cannot tell which key owns it, so it refuses rather than guessing.`
        );
      }
      consumed.add(i + 1);
      if (key !== 'include' && key !== 'exclude') continue; // e.g. `requires:`
      entries.push({
        gate,
        key,
        // `.replace(/^\s+/, '')` because `-  "x"` (two spaces) is legal
        // YAML that markgate accepts; the item regex captures the extra space.
        glob: scalar((itemLine[2] ?? '').replace(/^\s+/, ''), at, gate, key),
        line: i + 1,
      });
      continue;
    }
    throw new Error(
      `${at}: unrecognised line inside gate '${gate}':\n  ${line}\n` +
        `Nested mappings and other shapes are not modelled. Extend the parser.`
    );
  }
  return { entries, gates, consumed, declaredInclude, hashOf, baseOf };
}

/**
 * Independent scan, sharing NO assumption with `parseConfig`. The previous
 * version counted `^ {6}- ` lines -- the very indentation assumption that
 * failed -- so it agreed with the parser precisely when both were wrong.
 */
function rawScan(yaml: string): { itemLines: number[]; gates: string[] } {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^gates:\s*$/.test(l));
  const itemLines: number[] = [];
  const gates: string[] = [];
  if (start === -1) return { itemLines, gates };
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) break;
    if (/^\s+-\s/.test(line)) itemLines.push(i + 1);
    const m = /^ {2}([A-Za-z0-9_-]+):/.exec(line);
    if (m?.[1] !== undefined) gates.push(m[1]);
  }
  return { itemLines, gates };
}

const trackedCache = new Map<string, string[]>();

/** Tracked FILES matching a git `:(glob)` pathspec. */
function trackedFiles(glob: string): string[] {
  const hit = trackedCache.get(glob);
  if (hit !== undefined) return hit;
  let out: string[] = [];
  try {
    out = execFileSync('git', ['ls-files', '-z', '--', `:(glob)${glob}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\0')
      .filter((f) => f.length > 0);
  } catch {
    // A pathspec git refuses (a leading `/`, say) falls through to the on-disk
    // arm rather than escaping as a bare "Command failed: git ls-files".
    out = [];
  }
  trackedCache.set(glob, out);
  return out;
}

/**
 * On-disk FILES matching the glob, confined to the repo. `hash: files` digests
 * untracked and gitignored files too, so the tracked set alone would call
 * `dist/**` dead; and without the file/containment filters an entry like
 * `../**` or a directory-only glob reads as live when markgate says otherwise.
 */
function onDiskFiles(glob: string): string[] {
  try {
    return globSync(glob, { cwd: repoRoot, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => resolve(d.parentPath, d.name))
      .filter((p) => p.startsWith(repoRoot + sep))
      .map((p) => relative(repoRoot, p));
  } catch {
    return [];
  }
}

function matchCount(glob: string): number {
  const tracked = trackedFiles(glob).length;
  return tracked > 0 ? tracked : onDiskFiles(glob).length;
}

/** A wildcard-free entry naming a DIRECTORY matches no FILE for markgate. */
function isBareDirectory(glob: string): boolean {
  if (/[*?[\]{}]/.test(glob)) return false;
  try {
    return statSync(join(repoRoot, glob)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The single documented zero-match entry: a gitignored sentinel `/review-pr`
 * rewrites, absent entirely in a fresh worktree. An explicit one-element
 * allow-list rather than a `git check-ignore` rule -- that rule exempted every
 * ignored path, so a typo'd `dist/index.js` would have been waved through too.
 */
const ZERO_MATCH_ALLOWED = ['.markgate-pr-review-sha'];

/**
 * Files this fence reads through a spelling the `readFileSync` scan below
 * cannot see. `git check-ignore` consults `.gitignore`, so `.gitignore` is a
 * checker INPUT of this suite exactly as `ci.yml` is -- deleting its
 * `.markgate-pr-review-sha` line reds this file, and without the include entry
 * the `check` marker would stay FRESH over it. That is the go-to-k/cdk-local#620
 * class for the THIRD time in this PR, and the first two were also introduced
 * by the fence written to close it.
 *
 * Hand-listed because a regex cannot follow an argument into a subprocess. The
 * `execFileSync` budget in the same case is what stops the list going stale:
 * adding a new subprocess read fails until it is declared here.
 */
const EXTRA_READS = ['.gitignore'];

describe('.markgate.yml gate scopes', () => {
  const yaml = readFileSync(join(repoRoot, '.markgate.yml'), 'utf8');
  const parsed = parseConfig(yaml);
  const raw = rawScan(yaml);
  const includes = parsed.entries.filter((e) => e.key === 'include');
  const checkGlobs = includes.filter((e) => e.gate === 'check').map((e) => e.glob);

  it('the parse consumed every list item in the file', () => {
    // COMPLETENESS, not a count. A `>=` floor let an earlier draft drop 11 of
    // 26 entries; a count against a scan sharing the parser's indentation
    // assumption then let a whole gate vanish at a different indent. This
    // compares line NUMBERS: every `- ` line under `gates:` must have been
    // consumed by name, so an entry cannot be missed without failing here.
    const missed = raw.itemLines.filter((n) => !parsed.consumed.has(n));
    expect(
      missed.map((n) => `.markgate.yml:${n}`),
      `these list items were never consumed by the parser, so nothing below checks ` +
        `them:\n${missed.join(', ')}`
    ).toEqual([]);
    expect(parsed.gates, 'a gate key was missed by the parse').toEqual(raw.gates);
    expect(parsed.gates, 'the check gate vanished from the parse').toContain('check');
    expect(
      raw.itemLines.length,
      'the config has almost no scope entries -- did the scan find it at all?'
    ).toBeGreaterThanOrEqual(15);
    // Per-gate floor. The global one above is satisfied by 28 entries however
    // they are distributed, so emptying one gate's `include:` entirely -- five
    // globs out of `docs`, say -- sails through it.
    const emptied = parsed.declaredInclude.filter(
      (g) => !parsed.entries.some((e) => e.gate === g && e.key === 'include')
    );
    expect(
      emptied,
      `these gates declare an \`include:\` with no entries, so they scope NOTHING: ` +
        `${emptied.join(', ')}`
    ).toEqual([]);
    expect(
      parsed.declaredInclude.length,
      'no gate declares an include at all -- the parse found nothing to check'
    ).toBeGreaterThan(0);
  });

  it('no gate\'s `hash` value makes its include list inert', () => {
    // `exclude` one key over, and measured against the pinned markgate 0.4.1
    // on this tree. The include list only means something under a hasher that
    // READS it:
    //
    //   hash: files      -> `verify check --explain` resolves 983 files
    //   hash: git-tree   ->                          resolves 1, and
    //                       `markgate config lint` is SILENT (rc=0)
    //   hash: diff       -> lint WARNS and verify fails to parse (no `base`)
    //   worktree/content -> lint WARNS, verify fails to parse
    //
    // So exactly one value collapses the scope quietly, and every assertion in
    // this file passes underneath it: the entries still parse, still match
    // files, and still name the right paths -- they are simply no longer what
    // the marker digests. Only the VALUE check below can see it.
    const usesInclude = /^(files|diff)$/;
    const inert = parsed.declaredInclude
      .filter((g) => !usesInclude.test(parsed.hashOf.get(g) ?? 'files'))
      .map((g) => `gate '${g}' has hash: ${parsed.hashOf.get(g)}`);
    expect(
      inert,
      `these gates declare an \`include:\` under a hasher that ignores it, so the list ` +
        `scopes NOTHING while everything else here still passes:\n${inert.join('\n')}`
    ).toEqual([]);

    // `check` and `docs` are pinned to `files` specifically. `.markgate.yml`
    // records the reason -- they are cheap to re-run, so they stay strict --
    // and `diff` would quietly weaken them to a merge-base delta.
    for (const gate of ['check', 'docs']) {
      expect(
        parsed.hashOf.get(gate),
        `gate '${gate}' is meant to be strict \`hash: files\`; \`diff\` would weaken it ` +
          `to a merge-base delta and \`git-tree\` would ignore its include entirely`
      ).toBe('files');
    }

    // `base` is meaningful only under `hash: diff`. markgate's own linter
    // already refuses the combination loudly (measured: `base is only valid
    // with hash=diff`, and `verify` then fails to parse), so this is a
    // fail-fast echo rather than the only guard -- but a config that cannot
    // parse takes EVERY gate down, so it is worth catching in the suite.
    for (const gate of parsed.gates) {
      const hasBase = parsed.baseOf.has(gate);
      const isDiff = parsed.hashOf.get(gate) === 'diff';
      expect(
        hasBase,
        `gate '${gate}': \`base\` is valid only with \`hash: diff\` (has hash: ` +
          `${parsed.hashOf.get(gate) ?? '<none>'}, base: ${parsed.baseOf.get(gate) ?? '<none>'})`
      ).toBe(isDiff);
    }
  });

  it('no gate declares an `exclude:` this sweep would not subtract', () => {
    const excludes = parsed.entries.filter((e) => e.key === 'exclude');
    expect(
      excludes.map((e) => `.markgate.yml:${e.line} gate '${e.gate}' excludes "${e.glob}"`),
      'a gate grew an `exclude:`. markgate SUBTRACTS it from the resolved scope, so the ' +
        'sweep below would keep reporting full coverage over a smaller reality. Teach the ' +
        'sweep to subtract it FIRST, then remove this assertion -- do not just delete it.'
    ).toEqual([]);
  });

  it('every include entry matches at least one file', () => {
    const dead = includes
      .filter((e) => !ZERO_MATCH_ALLOWED.includes(e.glob))
      .filter((e) => matchCount(e.glob) === 0)
      .map((e) => `.markgate.yml:${e.line} gate '${e.gate}' includes "${e.glob}"`);
    expect(
      dead,
      `these include entries match no file, so they scope nothing:\n${dead.join('\n')}\n` +
        `A glob matching nothing is indistinguishable from one doing its job. Remove it, ` +
        `or correct it to the file it was meant to name.`
    ).toEqual([]);
  });

  it('no include entry is a bare directory name', () => {
    // The over-approximation this fence covers explicitly, because it IS this
    // PR's defect class one step over: `.claude/agents` instead of
    // `.claude/agents/**` scopes NOTHING for markgate (`hash: files` keeps
    // files, and doublestar matches only the directory entry), while git's
    // pathspec happily reports every file beneath it and `globSync` returns
    // the directory. Both of this file's arms would call it live.
    const bare = includes
      .filter((e) => isBareDirectory(e.glob))
      .map((e) => `.markgate.yml:${e.line} gate '${e.gate}' includes "${e.glob}"`);
    expect(
      bare,
      `these entries name a DIRECTORY, which matches no file for markgate:\n${bare.join('\n')}\n` +
        `Write "<dir>/**".`
    ).toEqual([]);
  });

  it('the allow-listed zero-match entry really is a gitignored sentinel', () => {
    for (const glob of ZERO_MATCH_ALLOWED) {
      expect(
        parsed.entries.some((e) => e.glob === glob),
        `${glob} is allow-listed here but no gate references it any more -- drop the entry`
      ).toBe(true);
      let ignored = '';
      try {
        // Exits 1 when the path is NOT ignored, which `execFileSync` throws on
        // -- the crafted message below never printed until this catch existed.
        ignored = execFileSync('git', ['check-ignore', '-v', '--', glob], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        ignored = '';
      }
      expect(ignored, `${glob} is no longer gitignored, so it should not be exempt`).toContain(
        glob
      );
    }
  });

  it('every file this fence READS is inside the check gate it guards', () => {
    // The go-to-k/cdk-local#620 rule applied to this file: a checker INPUT
    // outside the include can red the suite while the marker stays fresh.
    // This fence became such a reader in its own second commit (it asserts
    // `ci.yml` still runs `test:hooks`), which re-introduced the very class it
    // exists to close.
    //
    // The population is derived from this file's own source. A regex can only
    // see the spelling it models, so the count of read calls must equal the
    // derived reads plus the one self-read below: adding a read via
    // `resolve()`, a template literal or a joined path fails here instead of
    // slipping past. It is a budget, not a proof -- aliasing `readFileSync` to
    // another name, or reading through `execFileSync('cat', ...)`, still
    // evades it. The claim is "the obvious respellings are caught", not "no
    // read can hide".
    //
    // Careful when editing the text in this case: the scan reads its own
    // source, so writing the scanned spelling into a comment or a message
    // counts as a read and makes the equality fail on prose. It did, twice.
    const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    // The equality below permits exactly ONE unmodelled read -- this one. That
    // budget is TRANSFERABLE unless it is nailed down: respelling the self-read
    // through the modelled form frees the slot for a smuggled read of a file in
    // no gate, and two coordinated edits then pass. Pin the self-read's own
    // spelling so the slot cannot be vacated.
    expect(
      (selfSource.match(/readFileSync\(fileURLToPath\(/g) ?? []).length,
      'the self-read must keep this exact spelling: it is the one read the equality ' +
        'below allows to be unmodelled, and respelling it frees that allowance for a ' +
        'read of a file nothing checks'
    ).toBe(1);
    const reads = [
      ...new Set(
        [...selfSource.matchAll(/readFileSync\(\s*join\(\s*repoRoot,([^)]*)\)/g)]
          .map((m) => [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((q) => q[1] ?? '').join('/'))
          .filter((path) => path.length > 0)
      ),
    ].sort();
    const readCalls = (selfSource.match(/readFileSync\(/g) ?? []).length;
    expect(
      readCalls,
      `this file makes ${readCalls} readFileSync calls but only ${reads.length} resolve ` +
        `through the modelled spelling (plus one self-read). A read the extractor cannot ` +
        `see is a checker input nothing below checks. Spell new reads the same way the ` +
        `others are spelled, or extend the extractor -- and do not write that spelling ` +
        `into a comment or a message here, because this scan reads its own source.`
    ).toBe(reads.length + 1);

    // The `execFileSync` spelling has its own budget: the scan cannot follow a
    // path into a subprocess, so the only defence is to notice a new one. Three
    // occurrences today -- `git ls-files`, `git check-ignore`, and one mention
    // inside a comment.
    expect(
      (selfSource.match(/execFileSync\(/g) ?? []).length,
      'this file gained or lost an `execFileSync` site. A subprocess read is invisible ' +
        'to the scan above, so any file it consults must be listed in EXTRA_READS and ' +
        'scoped into the check gate -- then update this count.'
    ).toBe(3);

    const covered = (path: string): boolean =>
      checkGlobs.some((g) => trackedFiles(g).includes(path));
    const uncovered = [...reads, ...EXTRA_READS].filter((path) => !covered(path));
    expect(
      uncovered,
      `this test reads ${uncovered.join(', ')}, which no \`check\` include entry covers. ` +
        `Editing one of those reds this suite while a previously-set marker stays FRESH ` +
        `-- the go-to-k/cdk-local#620 class. Scope it in, or stop reading it.`
    ).toEqual([]);
    // Negative control: `covered` must be able to say NO, or the assertion
    // above passes for any input. CONTRIBUTING.md is tracked and in no gate.
    expect(
      covered('CONTRIBUTING.md'),
      'the coverage predicate reports everything as in-scope, so it proves nothing'
    ).toBe(false);
  });

  it("the check gate scopes the files that decide what 'green' means", () => {
    // Named rather than derived: these four are in the include for a reason
    // the other entries do not share -- they are not READ by any assertion.
    // They decide what the suite selects (`vite.config.ts`), which binaries
    // run it (`.mise.toml` pins vp + markgate, `.node-version` pins the Node
    // they run on), and what the marker MEANS (`.markgate.yml`).
    for (const g of ['vite.config.ts', '.mise.toml', '.node-version', '.markgate.yml']) {
      expect(checkGlobs, `the check gate no longer scopes ${g}`).toContain(g);
    }
  });

  it('the check gate scopes the shell hook suites that /check runs', () => {
    // The two halves of issue #630's decision, each inert without the other:
    // the include entry makes a hook edit stale the marker, and `/check`
    // running `test:hooks` makes the run that clears it execute the suites.
    expect(checkGlobs, 'the check gate no longer scopes .claude/hooks/**').toContain(
      '.claude/hooks/**'
    );

    const skill = readFileSync(join(repoRoot, '.claude', 'skills', 'check', 'SKILL.md'), 'utf8');
    // Anchored to a NUMBERED STEP, not to any mention: a bare `toContain`
    // passed with the step deleted, because the rationale paragraph below the
    // list also spells the command.
    expect(
      skill,
      '/check no longer lists `vp run test:hooks` as a numbered step, so the check marker ' +
        'would attest to a suite that excludes the .claude/hooks/*.test.sh assertions'
    ).toMatch(/^\d+\. `vp run test:hooks`/m);

    const verifyPr = readFileSync(
      join(repoRoot, '.claude', 'skills', 'verify-pr', 'SKILL.md'),
      'utf8'
    );
    // Same trap, one file over: this skill names the command in its output
    // table as well, so the step and the row are asserted separately.
    expect(
      verifyPr,
      '/verify-pr sets the `check` marker but no longer lists `vp run test:hooks` as a step'
    ).toMatch(/^ {3}- `vp run test:hooks` — the shell suites/m);
    expect(
      verifyPr,
      "/verify-pr's output table lost its `vp run test:hooks` row"
    ).toMatch(/^\| hook shell suites \(`vp run test:hooks`\) \|/m);

    const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    // The claimed backstop. `.markgate.yml` and both skills say CI runs this.
    expect(ci, 'ci.yml no longer runs `vp run test:hooks`').toMatch(
      /^\s*- run: vp run test:hooks\s*$/m
    );

    const config = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf8');
    // `[^}]*` keeps the match inside the `verify:` block.
    expect(
      config,
      '`vp run verify` no longer chains test:hooks, so the alias reports a green the ' +
        'check gate does not mean'
      // Anchored to the `command:` STRING, not to anywhere in the block. The
      // block carries a comment inside the same `[^}]*` window, so a reword
      // that happens to quote the command would keep this green with the
      // command DELETED -- the confluence-point trap this file has now hit
      // three times.
    ).toMatch(/verify:\s*\{[^}]*command:\s*'[^']*vp run test:hooks/);
    expect(
      config,
      'the `verify` task is cacheable again, so `vp run verify` can replay a green ' +
        'recorded before a .claude/hooks/** edit'
    ).toMatch(/verify:\s*\{[^}]*cache:\s*false/);
  });

  it('the rules doc names exactly the scope the config does', () => {
    // `.claude/rules/hooks.md` restates the check gate's scope in prose, and
    // this PR's own subject is a scope enumeration going stale unnoticed. Set
    // EQUALITY, both directions: a dropped entry and an invented one both
    // fail. Whitespace-normalised first, because the paragraph is hard-wrapped
    // and a line-sensitive regex broke the first time it was re-wrapped.
    const rules = readFileSync(join(repoRoot, '.claude', 'rules', 'hooks.md'), 'utf8').replace(
      /\s+/g,
      ' '
    );
    const block = /Scope: (.*?) Only invalidated by changes in that scope\./.exec(rules);
    expect(
      block,
      "the check-gate `Scope:` sentence in .claude/rules/hooks.md moved or was renamed"
    ).not.toBeNull();
    const named = [
      ...new Set([...(block?.[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '')),
    ].sort();
    expect(
      named,
      `.claude/rules/hooks.md's check-gate scope sentence and .markgate.yml's include list ` +
        `disagree. A prose enumeration of a config is exactly what issue #630 found stale; ` +
        `keep it in step, or stop enumerating.`
    ).toEqual([...new Set(checkGlobs)].sort());
  });

  it('the parser refuses shapes it cannot model (guard the guard)', () => {
    // Without this, a parser that quietly returned [] would make every sweep
    // above pass on any config at all. The fixtures are the measured defects:
    // the three entries this issue removed, plus every spelling a reviewer
    // used to hide a dead glob from a green run.
    const canonical = parseConfig(
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
    expect(canonical.entries.map((e) => e.glob)).toEqual([
      'vitest.config.ts',
      '.eslintrc*',
      '.prettierrc*',
      'vite.config.ts',
    ]);
    expect(canonical.gates).toEqual(['demo', 'other']);

    // Items at the PARENT key's own indent: valid YAML, accepted by markgate,
    // and invisible to the previous 6-space assumption. A reviewer hid three
    // dead globs behind it while the suite stayed 9/9 green.
    const parentIndent = parseConfig(
      ['gates:', '  demo:', '    include:', '    - "a.txt"', '    - "b.txt"', ''].join('\n')
    );
    expect(parentIndent.entries.map((e) => e.glob)).toEqual(['a.txt', 'b.txt']);
    expect(parentIndent.consumed.size).toBe(2);

    // Deeper indent, and a second space after the dash: both legal, both
    // previously a hard failure on a config markgate accepts.
    expect(
      parseConfig(
        ['gates:', '  demo:', '    include:', '        - "a.txt"', '      -  "b.txt"', ''].join('\n')
      ).entries.map((e) => e.glob)
    ).toEqual(['a.txt', 'b.txt']);

    // A non-scope key's block list is consumed and discarded, not counted.
    const withRequires = parseConfig(
      [
        'gates:',
        '  demo:',
        '    requires:',
        '      - check',
        '      - docs',
        '    include:',
        '      - "a.txt"',
        '',
      ].join('\n')
    );
    expect(withRequires.entries.map((e) => e.glob)).toEqual(['a.txt']);
    expect(withRequires.consumed.size, 'the `requires:` items must still be CONSUMED').toBe(3);

    // `exclude:` must be PARSED, so the refusal above can see it.
    expect(
      parseConfig(
        ['gates:', '  demo:', '    exclude:', '      - "docs/**"', '    include:', '      - "src/**"', '']
          .join('\n')
      ).entries.map((e) => `${e.key}:${e.glob}`)
    ).toEqual(['exclude:docs/**', 'include:src/**']);

    // Unmodelled shapes THROW rather than ending the list.
    expect(() =>
      parseConfig(['gates:', '  demo:', '    include:', '      - [a, b]', ''].join('\n'))
    ).toThrow(/could not parse this list item/);
    expect(() =>
      parseConfig(['gates:', '  demo:', '    include: ["a", "b"]', ''].join('\n'))
    ).toThrow(/unsupported inline value/);
    expect(() =>
      parseConfig(['gates:', '  demo:', '    include:', '      nested:', '        - "a"', ''].join('\n'))
    ).toThrow(/unrecognised line/);
  });

  it('the matcher calls the removed globs dead and sees untracked files (guard the guard)', () => {
    // If `matchCount` returned a positive number for anything, the sweep could
    // never fail.
    expect(
      ['vitest.config.ts', '.eslintrc*', '.prettierrc*'].map(matchCount),
      'a file now matches one of the globs #630 removed as dead -- re-check the include'
    ).toEqual([0, 0, 0]);
    expect(matchCount('vite.config.ts')).toBe(1);

    // The bare-directory rule, on a directory this repo certainly has.
    expect(isBareDirectory('src'), 'a bare directory name must be recognised as such').toBe(true);
    expect(isBareDirectory('src/**')).toBe(false);
    expect(isBareDirectory('vite.config.ts')).toBe(false);

    // The on-disk arm: `hash: files` digests untracked files, so an entry
    // matching only untracked content is LIVE and git alone would call it
    // dead. Probed with a file created here rather than against `dist/` --
    // CI runs `vp run test` BEFORE `vp run build`, so a `dist/**` probe passed
    // locally and failed in CI on a tree that simply had not been built.
    const dir = mkdtempSync(join(repoRoot, 'node_modules', '.cdkl-glob-probe-'));
    const probe = join(dir, 'probe.txt');
    try {
      writeFileSync(probe, 'x');
      const rel = relative(repoRoot, probe).split(sep).join('/');
      expect(trackedFiles(rel), 'the probe file must be untracked for this to mean anything')
        .toEqual([]);
      expect(
        onDiskFiles(rel),
        'the on-disk arm stopped seeing untracked files, so an entry matching only ' +
          'untracked-but-real content would be reported dead while markgate digests it'
      ).toEqual([rel]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Containment, probed where it can actually fail. `../**` does NOT escape:
    // measured, Node's glob does not walk upward, so it returns 1225 entries
    // all inside the repo and an assertion on it is unfalsifiable (deleting
    // the containment filter leaves it green). An ABSOLUTE pattern does
    // escape, so that is what this probes -- raw `globSync` must yield paths
    // outside the repo, and `onDiskFiles` must return none of them.
    const escapes = globSync('/etc/*', { cwd: repoRoot, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => resolve(d.parentPath, d.name))
      .filter((f) => !f.startsWith(repoRoot + sep));
    expect(
      escapes.length,
      'the probe found no file outside the repo, so it cannot show containment working'
    ).toBeGreaterThan(0);
    expect(
      onDiskFiles('/etc/*'),
      'the on-disk arm returned a path outside the repository'
    ).toEqual([]);
    // File-only: a directory is not a file match, which is what makes the
    // bare-directory rule above able to fire.
    expect(onDiskFiles('src'), 'a directory is not a file match').toEqual([]);
  });
});
