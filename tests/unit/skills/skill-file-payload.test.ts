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

const MAX_SKILL_MD_BYTES = 30_000; // RE-DERIVED DOWNWARD 36_000 -> 30_000 by the 2026-09-04 token-diet compression pass (mirroring go-to-k/cdkd#2493); the largest non-split skill's size is ASSERTED below (MEASURED_LARGEST_NON_SPLIT), never quoted here
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
// ~115 B -- about one wrapped line at 80 columns. go-to-k/cdk-local#675 read it
// as ~163 B at 11,837 B, and the 2026-09-05 batching pass's stage-3 clause
// (11,837 -> 11,885) ate the difference. The next orchestrator
// addition still has to buy its space by moving something out, and MEASURED
// asserts the live figure, so read its failure message rather than this
// sentence.
const MAX_REFERENCE_FILE_BYTES = 32_000; // RE-DERIVED DOWNWARD 64_000 -> 32_000 by the 2026-09-04 token-diet compression pass; the largest stage file's size is ASSERTED below (MEASURED), never quoted here

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
// Re-derived DOWNWARD 132_000 -> 119_500 by the 2026-09-04 token-diet
// compression pass (mirroring go-to-k/cdkd#2493), at that pass's FINAL tree.
// Re-derive at the FINAL tree, and after any rebase rather than before it, or
// every number is the pre-merge one. The inputs are in MEASURED below and
// ASSERTED, so only the REASONING lives here.
//
// WHAT CONSUMES THE MARGIN, measured rather than assumed: growth in the
// NON-largest files ONLY. When the LARGEST file grows, corpus and largest rise
// together and `corpus - largest` does not move at all. So the figure to watch
// is the sum of every stage file EXCEPT the biggest -- which is why a retro lane
// eats the margin fast: its lessons land in whichever stage file each one fires
// in, and `implement.md` (the leader) is rarely one of them (the
// go-to-k/cdk-local#650 lane grew six non-leader files by ~15.4 KB total and
// lapsed the then-floor of 116,500; the assertion at the bottom of this file is
// what said so, at the commit that caused it).
//
// This value was set ~3.5 KB above the compressed tree's `corpus - largest`
// at derivation, the same order of margin its predecessors were given (live
// margin: MEASURED's failure message). A COMPRESSION pass moves
// the floor DOWN in the same commit (the retro anti-regrowth rule in
// references/retro.md section 10-c forbids buying room by raising it). MEASURED
// prints the current margin in its failure message, so the next erosion arrives
// as a number rather than as a surprise. Still sized against `corpus - largest`
// rather than against the either-largest case because the top two stage files
// are ~8 KB apart, so a flip is not near -- that gap has moved from ~10.0 KB
// to ~7.0 KB and back, so re-check it rather than assuming; the sibling cdkd sizes against
// the flip because ITS top two are ~2 KB apart.
// The 2026-09-05 batching pass added one paragraph to triage.md (batching as
// the DEFAULT rather than a permission, with the amortization reason stated)
// and one clause to the orchestrator's stage-3 row: corpus 144,680 -> 145,551,
// so the margin over `corpus - largest` went 3,117 -> 2,246 B. The floor is
// unchanged; the next addition of that size should be paid for by compression.
// The paragraph's FIRST draft claimed a run amortizes its build, `/check`,
// review dispatch and integ. A review of the sibling cdkd's identical text
// found all four are PER-LANE here (references/gates-and-pr.md is titled
// "per lane"; section 9 serializes the integs), so the corrected text claims
// only the context -- the probe, the collision map, the backlog read and the
// retro. Worth recording because the wrong version READ fine: an amortization
// argument is checkable against the flow it describes, and nothing in this
// file would have caught it.
//
// The 2026-09-05 port of four sibling retro runs' lessons is the worked example
// of what this bound does and does not charge, and it is stated as an INVARIANT
// rather than as figures because every figure here has now gone stale twice in
// one day. Additions to the LARGEST stage file move `corpus - largest` by
// exactly zero; additions to any other file, INCLUDING ones arriving from main,
// are charged in full. So a margin that moved less than the corpus is evidence
// about WHICH file grew, never about room the additions created -- and a file
// that escapes this bound by being the largest pays instead out of its own
// MAX_REFERENCE_FILE_BYTES headroom. Read the live numbers off MEASURED's
// failure message, which is the only place they are asserted; do not re-quote
// them here, per the convention the three constants above already state.
//
// That port paid section 10-c's "pay for what you add" by a CUT, not a move:
// references/retro.md's stale-reason bullet carried one incident that the new
// rule in .claude/rules/session-report.md subsumes, so it was deleted and
// replaced by a pointer. Nothing left this corpus for another file.
// The 2026-09-06 ranking-criteria port (maintainer-directed, mirroring
// go-to-k/cdkd) added two preferences to triage.md section 3 -- rank the
// AGENT-TOOLING class (`.claude/**`, `.claude/CLAUDE.md`) LAST, and never rank
// by AGE, taking the OLDER issue where all else ties, because the outcome a
// recency tiebreaker produces is an old defect in the emulation path that no
// run ever reaches. It came out NET NEGATIVE -- read the live figures off
// MEASURED's failure message per the convention above; the checkable component
// is the two bullets at 855 B, paid by DISPLACEMENT, the move cdkd made in the
// same section a day earlier: section 0 had restated `.claude/CLAUDE.md`'s
// untrusted-content rule at length -- vectors, red flags, the Web-UI block, the
// no-`gh auth refresh` clause, all of it always loaded -- and now points at it
// (-873 B), keeping only what the stage adds: who to check, and who decides.
// The `now`-by-default pass first lapsed this floor by 113 B (retro.md's
// promotion bullet is a non-leader addition, charged in full) and PAID rather
// than raised, per section 10-c: three retro.md narratives compressed to their
// citations in the same commit. The go-to-k/cdk-local#735 retro mirror took
// the same route from a 10 B margin -- its two additions land in verify.md and
// gotchas.md, both NON-leaders and so charged in full -- and over-paid, so the
// floor is unchanged. The LIVE margin is deliberately not quoted here, the
// same rule the three cap comments above state about themselves: this clause
// used to end "and the binding margin is now 70 B", which was true at the
// commit that wrote it and false at the next three, in present tense, in the
// text a lane reads before adding to a non-leader file. MEASURED asserts the
// inputs and its failure message prints the live figure; read that.
const MIN_REFERENCE_CORPUS_BYTES = 119_500;

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
    orchestratorBytes: 11_885,
    // The `now`-by-default pass (the maintainer's recurring wrap-time "cheaper
    // to do it here?" challenge, answered in advance): implement.md 5-c gained
    // the context-test-first paragraph and its session-state / sweep bullets
    // now name the rule's reasons (part-funded by compressing the
    // go-to-k/cdk-local#560 narrative beside them); retro.md 10-0 gained the
    // read-set-is-wider-than-the-diff promotion bullet, paid inside retro.md
    // by three narrative compressions so the floor below did not move. Two
    // review rounds folded in; measured at the sha pushed: corpus 150,144,
    // largest 30,752, so `corpus - largest` = 119,392 -- 108 B under the
    // floor. The next non-leader addition must be paid for in its own file.
    // The follow-up that dropped "a NEW fixture" as a `next` reason (two
    // reasons now: external input / cold AND heavy; `Severity: high` and
    // loose ends are `now`) grew the leader, implement.md 30,752 -> 30,936,
    // and retro.md by a (b)-counting bullet paid inside retro.md by three
    // trims: corpus 150,426, `corpus - largest` 119,490 -- 10 B under the
    // floor. The next non-leader addition must be paid for in its own file.
    // go-to-k/cdk-local#722 then re-dated one sentence in implement.md
    // (+13 B, inside the largest file, so `corpus - largest` is unchanged).
    // The go-to-k/cdk-local#735 mirror of the cdkd go-to-k/cdkd#3077 run's
    // retro (2026-09-16): verify.md 8-b gained the "a lane that may not RUN
    // the fixture yet still WRITES the arm" sentence (+~430 B) and gotchas.md
    // gained the 429-resume bullet (+~490 B), both PAID for by compression in
    // their own files rather than by moving the floor (section 10-c). What
    // paid: verify.md's scratch-COPY paragraph, its restatement of the `check`
    // gate's include list and its restatement of the orphan-sweep rule now
    // point at `.claude/agents/pr-*-reviewer.md`, `.markgate.yml` and
    // `.claude/CLAUDE.md` respectively, a third reviewer-round citation went,
    // and two incident narratives were compressed to one line each;
    // gotchas.md's reset-cron bullet was compressed and its duplicate "never
    // defer integration tests" appendix entry folded into the gotcha that
    // already said it. verify.md 22,452 -> 21,979 and gotchas.md
    // 13,023 -> 13,436, net -60 B on the corpus, so `corpus - largest` fell
    // 119,490 -> 119,430 and the floor's binding margin went 10 -> 70 B with
    // the floor UNCHANGED.
    // The go-to-k/cdk-local#737 mirror of cdkd's go-to-k/cdkd#3296 retro
    // (2026-09-17): implement.md 5-e gained the bullet saying a narrow probe
    // VALUE input and an assertion's EXEMPTION are one defect, carrying the
    // three requirements that follow -- whole class per message, assert the
    // VALUE, and a TRANSCRIBED class needs a whole-domain behaviour fence
    // against the copy IN USE. The independence sentence was RELOCATED into
    // it out of verify.md's probe-diagnosis ladder, which now points here
    // rather than restating it, so the concept has one home (section 10-c's
    // near-duplicate rule). No cap and no floor moved, but state the
    // accounting in terms of the figures this record ASSERTS, and in no
    // others. Two rounds of review each caught a false byte claim in this
    // paragraph -- first a claim that the change was paid for in BOTH files,
    // when verify.md had GREW and paid nothing; then a hand-written
    // decomposition of the bullet's size against what one compression
    // recovered, out by the same amount in each term, so the NET still
    // reconciled and the suite stayed green. A recount is not the fix for a
    // figure that keeps drifting: an UNFENCED number in the record the next
    // lane reads to decide where to pay misdirects exactly that reader, and
    // nothing re-checks it. Neither wrong figure is restated here, not even
    // to correct it -- a labelled-false number is still a number this record
    // carries and nothing re-derives. Only the four asserted below are
    // stated; the review thread on go-to-k/cdk-local#738 holds the arithmetic.
    //
    // implement.md 30,949 -> 31,921 (79 B under the cap, down from 1,051),
    // verify.md 21,979 -> 22,000, corpus 150,379 -> 151,372, `corpus -
    // largest` 119,430 -> 119,451, so the floor's binding margin is 49 B with
    // MIN_REFERENCE_CORPUS_BYTES UNCHANGED. verify.md ABSORBED its growth --
    // the pointer replacing the relocated sentence is longer than the
    // sentence was -- so implement.md's cap headroom is what funded this.
    // The next NON-LEADER addition has under 49 B before the floor lapses,
    // and must be paid for in whichever file receives it: paying inside
    // implement.md buys nothing here, because growth in the LARGEST file
    // raises corpus and largest together and leaves the difference unmoved.
    //
    // One compression was tried and is REVERTED: shortening
    // `.claude/skills/review-pr/SKILL.md` to `review-pr/SKILL.md` "under
    // `.claude/`" composed to a path that does not exist -- a fact lost in a
    // compression, inside the one bullet whose subject is auditing every copy
    // of an enumerated path list. Bytes are not worth a wrong path; spell
    // them in full.
    corpusBytes: 151_372,
    largest: { file: 'implement.md', bytes: 31_921 },
    runnerUp: { file: 'verify.md', bytes: 22_000 },
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
  bytes: 25_771,
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
          `deleting that one file would leave ${total - largest} B and still pass. If YOUR ` +
          `commit grew a non-leader stage file, PAY for it by compression in that file ` +
          `rather than raising this floor -- references/retro.md section 10-c forbids a ` +
          `retro buying room that way, and the comment beside the constant records the ` +
          `passes that paid. Raise the floor above ${total - largest} (and re-derive the ` +
          `comment beside it) only when the lapse is not yours to compress, or re-derive ` +
          `it DOWNWARD in the same commit as a genuine compression pass.`
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
