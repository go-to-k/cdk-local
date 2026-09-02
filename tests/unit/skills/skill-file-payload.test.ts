import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Byte budget for `.claude/skills/<name>/SKILL.md` — a fence on the failure
 * mode where a file that is loaded WHOLE into an agent's context accretes
 * narrative PR-by-PR with no size feedback anywhere.
 *
 * A SKILL.md is injected in full the moment its skill is invoked, so its byte
 * size is a fixed token toll paid at every invocation, re-paid on every context
 * compaction. MEASURED on 2026-08-28, immediately before the split this fence
 * guards: `work-issues/SKILL.md` was 122,890 B (~44k tokens loaded before the
 * run's first action), grown by its own §10 fold-back loop: every run appended
 * lessons to the file every future run must load. The remedy was progressive
 * disclosure — a thin SKILL.md orchestrator plus per-stage `references/*.md`
 * files read only when the run enters that stage — and this fence is what
 * keeps the orchestrator from growing back. (cdkd hit the same wall harder:
 * its copy reached 231 KB before the same split, go-to-k/cdkd#2360.)
 *
 * Three mechanical properties are fenced; content-worth stays a human call:
 *
 *   1. no SKILL.md may exceed MAX_SKILL_MD_BYTES;
 *   2. a SPLIT skill (one with a `references/` dir) keeps its SKILL.md a thin
 *      orchestrator, under MAX_ORCHESTRATOR_BYTES — the fold-back loop's
 *      natural target is the file that is always loaded, so that file gets the
 *      tight cap while stage files get a looser one;
 *   3. no single reference file may exceed MAX_REFERENCE_FILE_BYTES — a stage
 *      file is still loaded whole at stage entry, so unbounded growth there
 *      re-creates the original problem one hop away.
 *
 * Plus a deletion floor scoped to the split skill: the split promised to MOVE
 * content, not drop it, and every other assertion here is a one-sided upper
 * bound — so without the floor, "reduce payload" by deleting the stage files
 * outright would read as an improvement.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skillsDir = join(repoRoot, '.claude', 'skills');

const MAX_SKILL_MD_BYTES = 36_000; // the largest non-split skill's size is ASSERTED below (MEASURED_LARGEST_NON_SPLIT), never quoted here
const MAX_ORCHESTRATOR_BYTES = 12_000; // work-issues' orchestrator was ~7 KB at the 2026-08-28 split; its CURRENT size and remaining margin are ASSERTED below (MEASURED), never quoted here
// Quoting a margin in prose is both the point and the trap: the orchestrator has
// repeatedly grown to within a few hundred bytes of this cap while the comment
// beside it still cited the at-split figure, so nobody adding a paragraph could
// see how little room was left. Inside go-to-k/cdk-local#651 alone every figure
// in this file went stale TWICE -- once when a later commit grew a stage file,
// once after a rebase -- and both times a reviewer, not the suite, caught it. So
// the numbers now live in MEASURED, which asserts them against the tree and
// PRINTS the current ones (plus both floor margins and the leader's remaining
// cap headroom) in its failure message. Re-read that message rather than
// re-deriving anything by hand.
//
// The design direction the caps exist to force, stated without numbers so it
// cannot rot: round 6 added the parent-runs-the-probe design and paid for most
// of it by moving the probe and its edge-case reading into
// references/launch-mode.md, read once before stage 0, leaving a pointer here.
// go-to-k/cdk-local#651 then added a FOURTH probe value (LAUNCH_BRANCH) and spent
// five clauses here saying so, sending its rules to
// references/{launch-mode,claim,ship,retro}.md -- which is why a change touching
// thirteen files cost the always-loaded file so little. The remaining margin is
// under one wrapped line: the next orchestrator addition has to buy its space by
// moving something out.
const MAX_REFERENCE_FILE_BYTES = 64_000; // the largest stage file's size is ASSERTED below (MEASURED), never quoted here

// The split skill's stage files must still exist and still carry the moved
// content. 8 files / ~124 KB at the split; the floor sits far enough below
// that narrative COMPRESSION stays legal while wholesale deletion fails.
const SPLIT_SKILLS = ['work-issues'];
const MIN_REFERENCE_FILES = 6;
// The floor has a SECOND job beyond "the files still exist": it must sit above
// `corpus - largest file`, so DELETING the biggest stage file cannot pass. That
// property decays as the OTHER files grow (it is invariant when the largest one
// is compressed, since both terms drop together), and it had already decayed
// twice inside one week (78,000 then 86,000 on 2026-08-31). It is ASSERTED at
// the bottom of this file rather than only described here, so the next lapse is
// a red test at the commit that causes it instead of a silent hole.
//
// What this floor does NOT catch, stated plainly: gutting a NON-largest stage
// file. A byte floor cannot see that, and raising it until it could would forbid
// legitimate compression. The per-file guards are elsewhere and are about
// CONTENT rather than size -- work-issues-skill-refs.test.ts pins the document
// count, and work-issues-launch-mode.test.ts pins one ANCHORED pattern per ARM
// of the launch-mode / LAUNCH_BRANCH contract (it used to pin a token COUNT per
// file, which a reviewer measured vacuous in 4 of 7 files).
//
// Re-derived 2026-09-02 (go-to-k/cdk-local#653) at the FINAL tree of the
// LAUNCH_BRANCH lane, AFTER rebasing onto go-to-k/cdk-local#670 (re-derive after
// the rebase, not before, or every number is the pre-merge one). The inputs are
// in MEASURED below and ASSERTED, so only the REASONING lives here.
//
// WHAT CONSUMES THE MARGIN, measured rather than assumed: growth in the
// NON-largest files ONLY. When the LARGEST file grows, corpus and largest rise
// together and `corpus - largest` does not move at all. So the figure to watch
// is the sum of every stage file EXCEPT the biggest -- which is also why this
// lane ate the margin so fast: it grew ship.md by ~7.4 KB and retro.md and
// gotchas.md besides, none of them the leader.
//
// The 112,000 this replaces was left over ~4.5 KB of margin when it was set and
// came out of the rebase with 91 B -- a margin nobody can plan against, the same
// failure the MAX_ORCHESTRATOR_BYTES comment above was re-measured for. This
// value restores ~4.6 KB and is strictly TIGHTER than what it replaces (no upper
// bound moves). MEASURED prints the current margin in its failure message, so
// the next erosion arrives as a number rather than as a surprise. Sized against
// `corpus - largest` rather than against the either-largest case because the top
// two stage files are ~14.5 KB apart, so a flip is not near; the sibling cdkd
// sizes against the flip because ITS top two are ~2 KB apart.
const MIN_REFERENCE_CORPUS_BYTES = 116_500;

/**
 * The measurements every comment in this file reasons from, ASSERTED against the
 * tree rather than quoted in prose.
 *
 * WHY: each byte figure used to live only in a comment, and comments drift in
 * the one direction that matters -- silently, while every assertion stays green.
 * Inside go-to-k/cdk-local#651 the stated figures went stale twice and a reviewer
 * caught both; the corpus floor already had a self-checking invariant, the
 * per-file caps and the corpus figures did not, and that asymmetry is what this
 * closes.
 *
 * It also surfaces the leader's remaining HEADROOM and both floor MARGINS in its
 * failure message, so erosion is visible BEFORE a bound is breached -- an upper
 * bound can only report a file that is already over.
 */
const MEASURED: Record<
  string,
  {
    orchestratorBytes: number;
    corpusBytes: number;
    largest: { file: string; bytes: number };
    runnerUp: { file: string; bytes: number };
  }
> = {
  // Keyed by SKILL, not module-global: the assertion below is generated per
  // entry of SPLIT_SKILLS, so a second split skill would otherwise be measured
  // against work-issues' numbers -- permanently red, with a message naming the
  // wrong file.
  'work-issues': {
    orchestratorBytes: 11_837,
    corpusBytes: 150_126,
    largest: { file: 'implement.md', bytes: 38_217 },
    runnerUp: { file: 'verify.md', bytes: 23_706 },
  },
};

/**
 * The same, for the non-split cap. `MAX_SKILL_MD_BYTES` is sized against the
 * largest UNSPLIT SKILL.md, and that figure was quoted in a comment and nowhere
 * else -- so it drifted with every hunt-bugs edit and said nothing about how
 * close the cap actually was.
 */
const MEASURED_LARGEST_NON_SPLIT: { file: string; bytes: number } = {
  file: 'hunt-bugs',
  bytes: 27_851,
};

function skillNames(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(skillsDir, name, 'SKILL.md')))
    .sort();
}

function referenceFiles(name: string): string[] {
  const dir = join(skillsDir, name, 'references');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => join(dir, f));
}

describe('skill file payload budget', () => {
  const names = skillNames();

  it('actually sees the skills (the scan is not vacuous)', () => {
    // 11 skills at the time of writing; a scan that stopped matching would
    // otherwise report "0 files over budget" as green.
    expect(names.length).toBeGreaterThanOrEqual(9);
  });

  for (const name of names) {
    const skillMd = join(skillsDir, name, 'SKILL.md');
    const isSplit = referenceFiles(name).length > 0;
    const cap = isSplit ? MAX_ORCHESTRATOR_BYTES : MAX_SKILL_MD_BYTES;

    it(`${name}/SKILL.md stays under ${cap} B`, () => {
      const size = statSync(skillMd).size;
      expect(
        size,
        `.claude/skills/${name}/SKILL.md is ${size} B, over the ${cap} B cap. ` +
          (isSplit
            ? `This skill is SPLIT: its SKILL.md is a thin orchestrator and lessons ` +
              `belong in the references/<stage>.md file where they fire ` +
              `(references/retro.md section 10-b) — not here.`
            : `Split it: move per-stage detail into references/*.md files read at ` +
              `stage entry (see work-issues for the shape), or trim narrative into ` +
              `the stage file it belongs to. Every byte here is loaded on every ` +
              `invocation of the skill.`)
      ).toBeLessThanOrEqual(cap);
    });
  }

  for (const name of names) {
    for (const ref of referenceFiles(name)) {
      it(`${name}/references/${ref.split('/').pop()} stays under ${MAX_REFERENCE_FILE_BYTES} B`, () => {
        const size = statSync(ref).size;
        expect(
          size,
          `${ref} is ${size} B, over the ${MAX_REFERENCE_FILE_BYTES} B cap. A stage file ` +
            `is loaded whole at stage entry, so it carries a cap too — compress the ` +
            `narrative (rule + one-line incident citation) or split the stage.`
        ).toBeLessThanOrEqual(MAX_REFERENCE_FILE_BYTES);
      });
    }
  }

  for (const name of SPLIT_SKILLS) {
    it(`${name}'s orchestrator points only at stage files that exist (no stranded stages)`, () => {
      // The count/byte floors below tolerate deleting the one or two SMALLEST
      // stage files, which would leave orchestrator table rows pointing at
      // nothing. Every `references/<x>.md` the orchestrator names must exist.
      const skillMd = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf-8');
      const named = [...new Set([...skillMd.matchAll(/references\/([A-Za-z0-9._-]+\.md)/g)].map((m) => m[1]!))];
      expect(named.length, `SKILL.md of ${name} names no references/*.md at all`).toBeGreaterThanOrEqual(
        MIN_REFERENCE_FILES
      );
      const missing = named.filter((f) => !existsSync(join(skillsDir, name, 'references', f)));
      expect(
        missing,
        `.claude/skills/${name}/SKILL.md points at stage file(s) that do not exist — ` +
          `restore the file(s) or fix the table`
      ).toEqual([]);
    });

    it(`${name} keeps its stage files (the split moved content, it did not drop it)`, () => {
      const refs = referenceFiles(name);
      expect(
        refs.length,
        `.claude/skills/${name}/references/ holds ${refs.length} stage files, below the ` +
          `floor of ${MIN_REFERENCE_FILES}. The orchestrator SKILL.md points into these; ` +
          `deleting one strands its stage.`
      ).toBeGreaterThanOrEqual(MIN_REFERENCE_FILES);
      const total = refs.reduce((n, f) => n + statSync(f).size, 0);
      expect(
        total,
        `.claude/skills/${name}/references/ totals ${total} B, below the ` +
          `${MIN_REFERENCE_CORPUS_BYTES} B floor. Every upper bound in this file reads a ` +
          `wholesale deletion as an improvement; this floor is what notices content ` +
          `being DROPPED rather than moved or compressed.`
      ).toBeGreaterThanOrEqual(MIN_REFERENCE_CORPUS_BYTES);

      // The floor's OWN invariant, asserted rather than described. Everything
      // above only says "the corpus is big enough"; what the floor is FOR is
      // that deleting the single largest stage file cannot pass, which holds
      // only while the floor sits above `corpus - largest`. That property
      // decays silently as the other files grow -- the comment beside the
      // constant records it lapsing twice (78,000 then 86,000) inside one week,
      // each time found by a human re-deriving it by hand. Asserting it makes
      // the next lapse a red test at the commit that causes it, and the failure
      // message carries the number to raise the floor to.
      const largest = Math.max(...refs.map((f) => statSync(f).size));
      expect(
        MIN_REFERENCE_CORPUS_BYTES,
        `MIN_REFERENCE_CORPUS_BYTES (${MIN_REFERENCE_CORPUS_BYTES}) has lapsed: the ` +
          `${name} corpus is ${total} B and its largest stage file is ${largest} B, so ` +
          `deleting that one file would leave ${total - largest} B and still pass. Raise ` +
          `the floor above ${total - largest} (and re-derive the comment beside it), or ` +
          `re-derive it DOWNWARD in the same commit as a genuine compression pass.`
      ).toBeGreaterThan(total - largest);
    });

    it(`${name}: the byte figures this file reasons from still match the tree`, () => {
      const expected = MEASURED[name];
      expect(
        expected,
        `SPLIT_SKILLS lists "${name}" but MEASURED has no entry for it. Add one (the ` +
          `numbers are printed by the assertion below once the key exists), or this ` +
          `skill's byte figures are unasserted.`
      ).toBeDefined();
      const sized = referenceFiles(name)
        .map((f) => ({ file: f.split('/').pop()!, bytes: statSync(f).size }))
        .sort((a, b) => b.bytes - a.bytes);
      // A split skill has at least MIN_REFERENCE_FILES stage files (asserted
      // above), but read defensively so a one-file skill fails with THIS
      // message rather than a TypeError from `sized[1]`.
      expect(sized.length, `${name} has too few stage files to have a runner-up`).toBeGreaterThan(1);
      const actual = {
        orchestratorBytes: statSync(join(skillsDir, name, 'SKILL.md')).size,
        corpusBytes: sized.reduce((n, e) => n + e.bytes, 0),
        largest: sized[0]!,
        runnerUp: sized[1]!,
      };
      const capHeadroom = MAX_REFERENCE_FILE_BYTES - actual.largest.bytes;
      const orchestratorHeadroom = MAX_ORCHESTRATOR_BYTES - actual.orchestratorBytes;
      expect(
        actual,
        `The MEASURED record at the top of this file no longer matches the tree.\n` +
          `  orchestrator  ${expected!.orchestratorBytes} -> ${actual.orchestratorBytes} ` +
          `(${orchestratorHeadroom} B left under the ${MAX_ORCHESTRATOR_BYTES} B cap)\n` +
          `  corpus        ${expected!.corpusBytes} -> ${actual.corpusBytes}\n` +
          `  largest       ${expected!.largest.file} ${expected!.largest.bytes} -> ` +
          `${actual.largest.file} ${actual.largest.bytes}\n` +
          `  runner-up     ${expected!.runnerUp.file} ${expected!.runnerUp.bytes} -> ` +
          `${actual.runnerUp.file} ${actual.runnerUp.bytes}\n` +
          `  floor margins: ${MIN_REFERENCE_CORPUS_BYTES - (actual.corpusBytes - actual.largest.bytes)} ` +
          `(binding) / ${MIN_REFERENCE_CORPUS_BYTES - (actual.corpusBytes - actual.runnerUp.bytes)} ` +
          `(either-largest)\n` +
          `  ${actual.largest.file} has ${capHeadroom} B left under the ` +
          `${MAX_REFERENCE_FILE_BYTES} B per-file cap.\n` +
          `Update MEASURED and re-read the comments that cite it -- every byte claim in this ` +
          `file is derived from these numbers, and a stale one silently misleads the next ` +
          `author into planning against room that is not there. If the BINDING margin has ` +
          `gone small or negative, raise MIN_REFERENCE_CORPUS_BYTES in the same commit; if ` +
          `the top two have come within a PR's growth of each other, re-derive the floor ` +
          `against the either-largest margin instead and say so beside it.`
      ).toEqual({
        orchestratorBytes: expected!.orchestratorBytes,
        corpusBytes: expected!.corpusBytes,
        largest: { file: expected!.largest.file, bytes: expected!.largest.bytes },
        runnerUp: { file: expected!.runnerUp.file, bytes: expected!.runnerUp.bytes },
      });
    });
  }

  it('the largest NON-split SKILL.md still matches what MAX_SKILL_MD_BYTES was sized against', () => {
    // The un-split cap's calibration lived in a trailing comment and nowhere
    // else, so it drifted with every hunt-bugs edit while saying nothing about
    // how close the cap actually was. Same treatment as MEASURED: assert it, and
    // print the headroom.
    const sized = names
      .filter((n) => referenceFiles(n).length === 0)
      .map((n) => ({ file: n, bytes: statSync(join(skillsDir, n, 'SKILL.md')).size }))
      .sort((a, b) => b.bytes - a.bytes);
    expect(sized.length, 'no non-split skill found; the scan is vacuous').toBeGreaterThan(0);
    const headroom = MAX_SKILL_MD_BYTES - sized[0]!.bytes;
    expect(
      sized[0],
      `MEASURED_LARGEST_NON_SPLIT is stale: ${MEASURED_LARGEST_NON_SPLIT.file}/SKILL.md ` +
        `${MEASURED_LARGEST_NON_SPLIT.bytes} -> ${sized[0]!.file}/SKILL.md ${sized[0]!.bytes} ` +
        `(${headroom} B left under the ${MAX_SKILL_MD_BYTES} B cap). Update it; if the ` +
        `headroom has gone small, the skill needs splitting rather than the cap raising.`
    ).toEqual(MEASURED_LARGEST_NON_SPLIT);
  });
});
