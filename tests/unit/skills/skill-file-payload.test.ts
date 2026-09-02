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

const MAX_SKILL_MD_BYTES = 36_000; // largest non-split skill re-measured 27,266 B (hunt-bugs, 2026-09-02, go-to-k/cdk-local#651)
const MAX_ORCHESTRATOR_BYTES = 12_000; // work-issues orchestrator was ~7 KB at the 2026-08-28 split; re-measured 11,837 B on 2026-09-02, go-to-k/cdk-local#651 (163 B of margin)
// The re-measurement is the point, not trivia: the orchestrator has repeatedly
// grown to within a few hundred bytes of its cap while this comment still quoted
// the at-split figure, so nobody adding a paragraph could see how little room was
// left. Round 6 added the parent-runs-the-probe design and paid for most of it by
// moving the probe and its edge-case reading into references/launch-mode.md
// (10,224 B as of go-to-k/cdk-local#651, read once before stage 0) and leaving a
// pointer here -- the direction this cap exists to force. Re-measure it whenever
// the orchestrator is edited -- a cap with an unmeasured margin is one nobody can
// plan against.
// go-to-k/cdk-local#651 added a FOURTH probe value (LAUNCH_BRANCH) and spent
// 262 B here saying so, taking the margin from 425 B to 163 B. Its rules -- what
// the value is, why it is never re-derived, and the section 9 restore it drives
// -- went to references/{launch-mode,claim,ship,retro}.md, which is why a change
// touching thirteen files cost the always-loaded one five clauses. 163 B is under one
// wrapped line: the next orchestrator addition has to buy its space by moving
// something out, which is what this cap is for.
const MAX_REFERENCE_FILE_BYTES = 64_000; // largest stage file re-measured 37,050 B (implement.md, 2026-09-02, go-to-k/cdk-local#651, after rebasing over go-to-k/cdk-local#643)

// The split skill's stage files must still exist and still carry the moved
// content. 8 files / ~124 KB at the split; the floor sits far enough below
// that narrative COMPRESSION stays legal while wholesale deletion fails.
const SPLIT_SKILLS = ['work-issues'];
const MIN_REFERENCE_FILES = 6;
// The floor has a SECOND job beyond "the files still exist": it must sit above
// `corpus - largest file`, so DELETING the biggest stage file cannot pass. That
// property decays as the OTHER files grow (it is invariant when the largest one
// is compressed, since both terms drop together), and it had already decayed
// twice inside one week (78,000 then 86,000 on 2026-08-31). It is now ASSERTED
// at the bottom of this file rather than only described here, so the next lapse
// is a red test at the commit that causes it instead of a silent hole.
//
// What this floor does NOT catch, stated plainly: gutting a NON-largest stage
// file. A byte floor cannot see that, and raising it until it could would forbid
// legitimate compression. The per-file guards are elsewhere and are about
// CONTENT rather than size -- work-issues-skill-refs.test.ts pins the document
// count, and work-issues-launch-mode.test.ts pins that each arm-bearing stage
// file still names the mode it branches on and that the probe exists exactly
// once.
const MIN_REFERENCE_CORPUS_BYTES = 112_000; // re-derived 2026-09-02 (go-to-k/cdk-local#651) at the final tree, AFTER rebasing over go-to-k/cdk-local#643: 9 stage files, corpus 143,564 B, largest implement.md 37,050 B, so the property needs a floor above 143,564 - 37,050 = 106,514, which the 100,000 held here no longer provided. 112,000 restores it with 5,486 B of margin and is strictly TIGHTER (no upper bound touched). The margin is deliberately wider than an exactly-sufficient floor would give: ship.md alone grew 4,623 B in this one PR, so a margin of one PR's growth means the next PR re-derives this again. Still sized against `corpus - largest` rather than the either-largest case, because the top two are 15,209 B apart (implement.md 37,050, verify.md 21,841 -- verify.md had already overtaken triage.md as runner-up, in go-to-k/cdk-local#652) -- a flip is not near; cdkd sizes against the flip because its top two are ~2 KB apart. ~31 KB (143,564 - 112,000 = 31,564 B) of narrative compression headroom remains below the floor

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
  }
});
