import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The `/work-issues` LAUNCH-MODE machinery, which decides whether a run creates
 * a worktree per lane or works in the tree it was launched in, plus the
 * LAUNCH_BRANCH contract that makes the second mode leave no trace.
 *
 * WHY THIS FILE EXISTS. `skill-file-payload.test.ts` and
 * `work-issues-skill-refs.test.ts` measure BYTES and CITATIONS. Neither looks at
 * what the prose says, so every mode-specific arm in this skill was untested --
 * and the orchestrator cap made that worse than merely untested: `SKILL.md` sits
 * a few hundred bytes under a 12,000 B cap, so DELETING the launch-mode section
 * was the cheapest way to buy headroom and the suite would have called it an
 * improvement. Measured 2026-09-01: deleting the probe block, deleting the whole
 * `## Launch mode` section, and deleting every line containing `IN-PLACE` or
 * `MAIN-CHECKOUT` were all GREEN before this file existed.
 *
 * WHY IT WAS REWRITTEN (go-to-k/cdk-local#653, round 3). A reviewer rebuilt the
 * previous revision's 29 assertions on a scratch tree and mutated the real
 * content against them. A COMPOSITE mutant that gutted four of the six contract
 * behaviours AND re-added the WITHDRAWN fast-forward -- as
 * `git branch --force <LAUNCH_BRANCH> origin/main`, three lines under the
 * comment saying that is banned -- passed 29/29 GREEN. The measured causes were
 * all shape, not coverage:
 *
 *   - the per-file guard was a COUNT FLOOR on the token `LAUNCH_BRANCH`, and a
 *     count cannot see WHICH mention survived. `launch-mode.md` names it 11
 *     times and `ship.md` 6, so deleting the "PUT BACK" paragraph, consequence
 *     rows 4/6/8 or the whole fallback gate all stayed above the floor. Rows of
 *     {doc, contract, arm, pattern} replace it: one ANCHORED pattern per arm;
 *   - the restore recipe was fenced by a BLACKLIST of moving verbs, so
 *     `git branch --force`, `git switch --force-create`,
 *     `git -C "<LANE_TREE>" pull --ff-only` and `git -C . merge --ff-only` all
 *     passed INSIDE the recipe. It is now ORDERED EQUALITY over the block's
 *     extracted command lines: anything added, removed or reordered fails;
 *   - the chain scan keyed on `git switch <LAUNCH_BRANCH>`, a string the detach
 *     FALLBACK does not contain, so unchaining the fallback was invisible. It
 *     now keys on the `git branch -D` line and runs over BOTH blocks;
 *   - the probe's parsed output was asserted VALUE by VALUE, so a fifth
 *     `KEY=VAL` line or a line with no `=` parsed in unnoticed. The KEY SET is
 *     now asserted, in order.
 *
 * Two FALSE POSITIVES were measured at the same time and are fixed here, because
 * a fence that blocks a correct edit gets deleted by the next author:
 * `...ALWAYS -- even if the tree arrived detached` tripped the conditional-rule
 * scan (a CONCESSIVE clause states the rule is unconditional), and
 * `git merge-base --is-ancestor` tripped the branch-moving scan (`merge-base` is
 * a read). Both directions of both scans now carry fixtures, so neither the
 * widening nor the carve-out can go inert unnoticed.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skillsDir = join(repoRoot, '.claude', 'skills');
const skillDir = join(skillsDir, 'work-issues');
const LAUNCH_MODE_DOC = join('references', 'launch-mode.md');

/** Repo-root-relative paths, so one table can hold both skills. */
const WI = join('.claude', 'skills', 'work-issues');
const HUNT_BUGS = join('.claude', 'skills', 'hunt-bugs', 'SKILL.md');
const WI_SKILL = join(WI, 'SKILL.md');
const WI_LAUNCH_MODE = join(WI, LAUNCH_MODE_DOC);
const WI_TRIAGE = join(WI, 'references', 'triage.md');
const WI_CLAIM = join(WI, 'references', 'claim.md');
const WI_IMPLEMENT = join(WI, 'references', 'implement.md');
const WI_SHIP = join(WI, 'references', 'ship.md');
const WI_RETRO = join(WI, 'references', 'retro.md');
const WI_GOTCHAS = join(WI, 'references', 'gotchas.md');

/** Every markdown file of the skill, orchestrator first. */
function skillDocs(): string[] {
  return [
    'SKILL.md',
    ...readdirSync(join(skillDir, 'references'))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => join('references', f)),
  ];
}

/** Skill-relative read (work-issues). */
function read(rel: string): string {
  return readFileSync(join(skillDir, rel), 'utf8');
}

/** Repo-root-relative read. */
function rootRead(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

/**
 * A hard-wrap-insensitive literal matcher: every run of whitespace becomes
 * `\s+`, so a pin survives the prose being RE-WRAPPED and still fails when the
 * words change.
 *
 * Written as a helper rather than by hand because hand-written `\s+` is exactly
 * what goes missing: `ship.md` states the restore on one line and `retro.md`
 * wraps the same command across a newline, so a single-line regex copied from
 * one silently matches nothing in the other -- a pin that cannot fail, which is
 * the failure this whole file exists to remove.
 */
function phrase(text: string): RegExp {
  return new RegExp(
    text
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+')
  );
}

/**
 * The probe's distinguishing token. `--git-common-dir` is what makes the mode
 * decidable at all (a linked worktree's `--git-dir` differs from it, the main
 * checkout's does not), so counting it counts copies of the probe.
 */
const PROBE_TOKEN = '--git-common-dir';

/**
 * Files that carry a mode-specific ARM and the marker(s) each must still name.
 * Not every file needs both: `claim.md` and `gotchas.md` only qualify the
 * IN-PLACE side, and `gates-and-pr.md` deliberately carries NO arm (its
 * `git -C "<LANE_TREE>"` spelling is correct in both modes, which is why the
 * mode words were removed from it rather than duplicated).
 */
const ARM_BEARING: Record<string, string[]> = {
  'SKILL.md': ['MAIN-CHECKOUT', 'IN-PLACE'],
  [LAUNCH_MODE_DOC]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'triage.md')]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'implement.md')]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'ship.md')]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'retro.md')]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'claim.md')]: ['IN-PLACE'],
  [join('references', 'gotchas.md')]: ['IN-PLACE'],
};

/**
 * The six behaviours the LAUNCH_BRANCH contract is made of
 * (go-to-k/cdk-local#651, ported from go-to-k/cdkd#2417). Naming them lets the
 * table below be checked for COVERAGE rather than merely for length: a
 * behaviour whose rows all lived in one file would be one deletion away from
 * unfenced, and a behaviour with no rows at all is the state the reviewer
 * measured for `fallback-gate` and `runs-last`.
 */
type Contract =
  /** (a) the probe RECORDS the value and hands it to every stage. */
  | 'probe'
  /** (b) an EMPTY value at probe time selects the detach FALLBACK. */
  | 'fallback-gate'
  /** (c) the run branches in place and NEVER commits onto LAUNCH_BRANCH. */
  | 'never-commit'
  /** (d) the restore is AS-IS and deletes only the branches THIS run made. */
  | 'as-is-restore'
  /** (e) the restore is the run's LAST step, after the retro PR. */
  | 'runs-last'
  /** (f) switch and delete are &&-CHAINED, in the restore AND the fallback. */
  | 'chained';

/**
 * One ANCHORED pattern per ARM of the contract, replacing the token-count floor
 * this table used to be. The floor was measured VACUOUS in four of seven files:
 * a count only notices a file's LAST mention going, which is the one deletion
 * nobody makes.
 *
 * If an arm legitimately MOVES, move its row -- do not delete it. A row deleted
 * without a replacement silently retires a behaviour, and the coverage test
 * below is what makes that visible.
 */
const LAUNCH_BRANCH_BEARING: Array<{ doc: string; contract: Contract; arm: string; pattern: RegExp }> = [
  {
    doc: WI_SKILL,
    contract: 'probe',
    arm: 'the opening report states LAUNCH_BRANCH beside the other three probe values',
    pattern: phrase('`MAIN_CHECKOUT` and `LAUNCH_BRANCH` (the branch §9 puts back; empty if launched detached)'),
  },
  {
    doc: WI_SKILL,
    contract: 'probe',
    arm: 'the triage dispatch carries LAUNCH_BRANCH',
    pattern: phrase('Hand it `MODE` / `LANE_TREE` / `MAIN_CHECKOUT` / `LAUNCH_BRANCH` from the probe'),
  },
  {
    doc: WI_SKILL,
    contract: 'probe',
    arm: 'every lane dispatch carries LAUNCH_BRANCH (without it a lane cannot restore)',
    pattern: phrase("and the probe's `MODE` / `LANE_TREE` / `MAIN_CHECKOUT` / `LAUNCH_BRANCH`."),
  },
  {
    doc: WI_SKILL,
    contract: 'never-commit',
    arm: 'the claim names the branch §5 will create, never LAUNCH_BRANCH',
    pattern: phrase('Never `LAUNCH_BRANCH`.'),
  },
  {
    doc: WI_TRIAGE,
    contract: 'probe',
    arm: 'stage 3 is HANDED the four values and refuses to re-derive them',
    pattern: phrase('carries its `MODE` / `LANE_TREE` / `MAIN_CHECKOUT` / `LAUNCH_BRANCH`. If the dispatch did not, STOP'),
  },
  {
    doc: WI_LAUNCH_MODE,
    contract: 'probe',
    arm: 'the value is UNRECOVERABLE once §5 switches the tree, so it is recorded now',
    pattern: phrase('It is the one value that becomes UNRECOVERABLE if not recorded now'),
  },
  {
    doc: WI_LAUNCH_MODE,
    contract: 'fallback-gate',
    arm: 'an EMPTY value is an ANSWER, and it is what selects §9\'s detach fallback',
    pattern: phrase(
      'An EMPTY value is a legitimate answer, not a probe failure: it says the run was launched detached, and §9\'s restore keeps a detach fallback for exactly that case.'
    ),
  },
  {
    doc: WI_LAUNCH_MODE,
    contract: 'never-commit',
    arm: 'the "a branch to PUT BACK, never one to commit to" rule',
    pattern: phrase('`LAUNCH_BRANCH` is a branch to PUT BACK, never one to commit to.'),
  },
  {
    doc: WI_LAUNCH_MODE,
    contract: 'never-commit',
    arm: 'consequence row 4: branch in place, never commit onto LAUNCH_BRANCH',
    pattern: /^\|.*never commit onto `LAUNCH_BRANCH`.*\|$/m,
  },
  {
    doc: WI_LAUNCH_MODE,
    contract: 'as-is-restore',
    arm: 'consequence row 6: switch back as-is, deleting only this run\'s branches',
    pattern: /^\|.*`LAUNCH_BRANCH` \*\*as-is\*\* — no pull, no rebase, no fast-forward.*\|$/m,
  },
  {
    doc: WI_LAUNCH_MODE,
    contract: 'fallback-gate',
    arm: 'consequence row 6 also gates the detach on empty-at-probe-time or gone',
    pattern: /^\|.*detach only when `LAUNCH_BRANCH` was empty at probe time or is now gone.*\|$/m,
  },
  {
    doc: WI_LAUNCH_MODE,
    contract: 'runs-last',
    arm: 'consequence row 8: the restore is the run\'s LAST step, after the retro PR',
    pattern: /^\|.*`LAUNCH_BRANCH` restore is the run's LAST step.*\|$/m,
  },
  {
    doc: WI_CLAIM,
    contract: 'never-commit',
    arm: 'do NOT claim LAUNCH_BRANCH',
    pattern: phrase("Do NOT claim `LAUNCH_BRANCH` — the branch checked out here right now is the OUTER TOOL's, not this run's"),
  },
  {
    doc: WI_IMPLEMENT,
    contract: 'never-commit',
    arm: 'section 5 forbids committing onto it and points at the §9 restore',
    pattern: phrase("Never commit onto it; §9 switches back to it untouched as the run's last step."),
  },
  {
    doc: WI_IMPLEMENT,
    contract: 'never-commit',
    arm: 'the delete_branch_on_merge rationale, which is WHY the rule exists',
    pattern: phrase("so a lane that opened its PR from it would delete the outer tool's remote branch on the way out"),
  },
  {
    doc: WI_SHIP,
    contract: 'as-is-restore',
    arm: 'the AS-IS rationale (the withdrawn fast-forward clause)',
    pattern: phrase('AS-IS is the whole rule: RESTORE, never ADJUST.'),
  },
  {
    doc: WI_SHIP,
    contract: 'as-is-restore',
    arm: 'the IN-PLACE arm puts back what it found and deletes every branch it made',
    pattern: phrase('What it DOES owe is the BRANCH: put back the one it found, delete every one it made.'),
  },
  {
    doc: WI_SHIP,
    contract: 'runs-last',
    arm: 'the restore runs LAST, not per-lane, and in the PARENT',
    pattern: phrase('run it LAST, not per-lane, in the PARENT'),
  },
  {
    doc: WI_SHIP,
    contract: 'fallback-gate',
    arm: 'the fallback fires ONLY on an empty or missing LAUNCH_BRANCH, never by default',
    pattern: phrase(
      'Fallback, and ONLY when `LAUNCH_BRANCH` was empty at probe time (the run was launched detached) or the `show-ref --verify` above FAILED (rc=128) — never as the default.'
    ),
  },
  {
    doc: WI_SHIP,
    contract: 'chained',
    arm: 'the restore block states WHY the delete is chained to the switch',
    // Stays within ONE physical line: this pin lives inside a fenced block
    // whose wrapped continuation re-opens with `# `, which `phrase()` cannot
    // bridge because a comment marker is not whitespace.
    pattern: phrase('CHAINED: an unchained `-D` after a FAILED switch still deletes'),
  },
  {
    doc: WI_SHIP,
    contract: 'chained',
    arm: 'the fallback block states that it is chained for the same reason',
    pattern: phrase('CHAINED for the same reason as the primary block'),
  },
  {
    doc: WI_RETRO,
    contract: 'runs-last',
    arm: 'section 10-d is the LAST step of the whole run',
    pattern: phrase('**the LAST step of the whole run**'),
  },
  {
    doc: WI_RETRO,
    // retro.md HARD-WRAPS this command, so a copy of ship.md's single-line
    // regex silently misses it -- the reason `phrase()` exists.
    contract: 'as-is-restore',
    arm: 'section 10-d states section 9\'s restore command',
    pattern: phrase('`git switch <LAUNCH_BRANCH> && git branch -D <every branch THIS run created>`'),
  },
  {
    doc: WI_RETRO,
    contract: 'as-is-restore',
    arm: 'and states it is as-is: no pull, no rebase, no fast-forward',
    pattern: phrase('— as-is (no pull, no rebase, no fast-forward)'),
  },
  {
    doc: WI_RETRO,
    contract: 'chained',
    arm: 'and states the chaining reason',
    pattern: phrase('CHAINED so a failed switch cannot leave the `-D` to run anyway'),
  },
  {
    doc: WI_GOTCHAS,
    contract: 'runs-last',
    arm: 'the Stop-hook bullet points at the LAST-step restore, not at the detach',
    pattern: phrase("§9's IN-PLACE cleanup arm is where that happens — as the run's LAST step: switch back to `LAUNCH_BRANCH`"),
  },
  {
    doc: WI_GOTCHAS,
    contract: 'fallback-gate',
    arm: 'the detach is kept as the FALLBACK, gated on empty-or-gone',
    pattern: phrase('so §9 keeps it as the FALLBACK, taken only when `LAUNCH_BRANCH` was empty at probe time or is now gone.'),
  },
  {
    doc: HUNT_BUGS,
    contract: 'probe',
    arm: 'the hunt records LAUNCH_BRANCH from the shared probe',
    pattern: phrase('RECORD its `LAUNCH_BRANCH`: that is the branch the outer tool handed the tree over on, and step 8 puts it back.'),
  },
  {
    doc: HUNT_BUGS,
    contract: 'never-commit',
    arm: 'the hunt never commits onto it',
    pattern: phrase('**Never commit onto it.**'),
  },
  {
    doc: HUNT_BUGS,
    contract: 'never-commit',
    arm: 'the delete_branch_on_merge rationale is stated there too',
    pattern: phrase("would delete the outer tool's remote branch on the way out"),
  },
  {
    doc: HUNT_BUGS,
    contract: 'as-is-restore',
    arm: 'step 8-2 restores the branch and deletes only the one the hunt made',
    pattern: phrase('`git switch <LAUNCH_BRANCH> && git branch -D <the branch this hunt created>`'),
  },
  {
    doc: HUNT_BUGS,
    contract: 'chained',
    arm: 'and chains the delete to the switch',
    pattern: phrase('CHAINED so a failed switch cannot leave the `-D` to run anyway'),
  },
  {
    doc: HUNT_BUGS,
    contract: 'fallback-gate',
    arm: 'the detach arm is gated on empty-at-probe-time or a failing show-ref',
    pattern: phrase(
      'only when `LAUNCH_BRANCH` was empty at probe time, or `git show-ref --verify refs/heads/<LAUNCH_BRANCH>` finds nothing.'
    ),
  },
  {
    doc: HUNT_BUGS,
    contract: 'as-is-restore',
    arm: 'the closing check names the restored end state',
    pattern: phrase("on `LAUNCH_BRANCH`, or detached if that arm fired — with every branch this hunt created deleted"),
  },
];

/**
 * How many rows each behaviour must keep, and across how many DOCUMENTS. The
 * document floor is the load-bearing half: rows concentrated in one file are one
 * deletion away from unfenced, which is how `fallback-gate` and `runs-last` came
 * to have no fence at all. Floors sit BELOW the counts at the time of writing so
 * a legitimate compression can retire one site; re-derive rather than raise to
 * the current count.
 */
const CONTRACT_FLOOR: Record<Contract, { rows: number; docs: number }> = {
  probe: { rows: 5, docs: 3 },
  'fallback-gate': { rows: 4, docs: 3 },
  'never-commit': { rows: 6, docs: 4 },
  'as-is-restore': { rows: 6, docs: 3 },
  'runs-last': { rows: 4, docs: 3 },
  chained: { rows: 4, docs: 3 },
};

/**
 * The population the two content scans below run over, DERIVED from the repo
 * rather than listed. The list version of this was itself the recurring defect:
 * three review rounds each found a site stating the old rule, and the third
 * found two more that this very PR had edited (`references/triage.md` and
 * `.claude/rules/hooks.md`) and that the list did not name. A hand-list of
 * "everywhere the rule is stated" goes stale exactly when a change adds a site,
 * which is the moment the scan is needed.
 *
 * `git ls-files` reads the INDEX, so an untracked draft is invisible until
 * `git add` -- the same property `work-issues-skill-refs.test.ts` relies on.
 */
function claudeFiles(): string[] {
  return execFileSync('git', ['ls-files', '.claude'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.endsWith('.md') || p.endsWith('.sh'));
}

/** Every tracked `.claude/**` file naming the value, with its text. */
function launchBranchBearingFiles(): Array<[string, string]> {
  return claudeFiles()
    .map((rel) => [rel, readFileSync(join(repoRoot, rel), 'utf8')] as [string, string])
    .filter(([, text]) => text.includes('LAUNCH_BRANCH'));
}

/**
 * The UNCONDITIONAL rule, pinned as a SENTENCE rather than as a token on a line.
 * A count floor cannot see it (measured: implement.md kept its LAUNCH_BRANCH
 * paragraph verbatim while the instruction beside it went back to "only if the
 * tree is detached", and the floor stayed green), and neither can a positive
 * `/IN-PLACE:[^\n]*ALWAYS/` -- an earlier draft passed on
 * "IN-PLACE: ALWAYS confirm the tree is yours first; then, if it arrived
 * detached ... take a fresh branch here", which is the reverted rule wearing the
 * word. Pinning the whole instruction leaves nowhere for the condition to hide.
 *
 * Section 5 (implement.md) is the file a lane actually opens at that stage, so
 * its entry is the one whose absence is dangerous rather than merely
 * inconsistent: a lane following a conditional rule commits onto LAUNCH_BRANCH,
 * and the merge then deletes the outer tool's remote branch.
 */
const UNCONDITIONAL_RULE: Array<[string, string]> = [
  [join('references', 'implement.md'), 'take a fresh branch here, ALWAYS'],
  [LAUNCH_MODE_DOC, 'branch IN PLACE off `origin/main` — ALWAYS'],
];

/**
 * The same rule in files outside `skillDir`, read from the repo root. The sibling
 * SKILL runs IN-PLACE and merges through /merge-pr, so the hazard is identical;
 * `.claude/CLAUDE.md` is the repo-global instruction file, always loaded, and it
 * stated the pre-change rule until go-to-k/cdk-local#651 -- with nothing fencing
 * it, since it is in no skill directory.
 */
const OUTSIDE_UNCONDITIONAL_RULE: Array<[string, string]> = [
  [HUNT_BUGS, "take the fix's branch IN PLACE off `origin/main` — ALWAYS"],
  [join('.claude', 'CLAUDE.md'), 'branch IN PLACE off `origin/main` -- ALWAYS'],
];

/**
 * Lines whose subject IS the in-place branch instruction. Every one of them has
 * to carry the unconditionality, so a SECOND site cannot re-introduce the
 * condition beside a correct first one -- which is how the bash comment in
 * implement.md could revert while its heading stayed right.
 */
// Deliberately loose on what follows "branch IN PLACE": a probe that
// re-conditioned only the bash comment slipped a phrase-list version of this,
// because it wrote "takes a branch IN PLACE only when..." and the list held
// "take a branch IN PLACE". The predicate is the SUBJECT of the line, not its
// grammar.
const IN_PLACE_RULE_LINE = /IN-PLACE:|branch IN PLACE\b/i;

/**
 * A line plus its continuation, for a scan over hard-wrapped prose: a rule whose
 * subject and object land on different lines is the natural way to write it, and
 * a line-scoped test misses it. The join STOPS at a blank line (paragraph
 * boundary) and at a markdown table row (`|` starts its own record) -- without
 * that, `launch-mode.md`'s consequence table joined row 6 to row 7 and read the
 * MAIN-CHECKOUT pull recipe as if it acted on LAUNCH_BRANCH.
 */
function wrappedWindow(lines: string[], i: number): string {
  const line = lines[i]!;
  const next = lines[i + 1] ?? '';
  if (next.trim() === '' || line.trimStart().startsWith('|') || next.trimStart().startsWith('|')) {
    return line;
  }
  return `${line} ${next}`;
}

/**
 * A CONCESSIVE clause -- "ALWAYS, even if the tree arrived detached" -- states
 * that the rule holds DESPITE the condition, i.e. it is the unconditional rule
 * written out. `STILL_CONDITIONAL` matched it anyway, because "even if ...
 * detached" contains "if ... detached", so the fence refused a correct edit that
 * makes the rule harder to misread. Measured on go-to-k/cdk-local#653.
 *
 * The marker is replaced rather than the whole clause deleted, so the REST of
 * the sentence is still scanned: "even if the tree arrived detached, branch only
 * when its PR has merged" must still fail on its second limb.
 */
const CONCESSIVE = /\b(even (if|when|though)|regardless of (whether|if)|no matter (if|whether|what)|whether or not)\b/gi;

/**
 * BOTH limbs of the withdrawn condition: it read "only when the tree is
 * DETACHED **or its PR has MERGED**", and a version naming only `detached` let a
 * probe re-condition on the second limb straight through. Matched across a
 * two-line window, because this prose is hard-wrapped and a condition whose
 * subject and object land on different lines is the natural way to write it.
 */
const STILL_CONDITIONAL = /\b(if|when|unless|only)\b[^.]*\b(detached|already merged|PR has merged)\b/i;

/** True when the window GATES the in-place rule, concessive clauses aside. */
function statesACondition(window: string): boolean {
  return STILL_CONDITIONAL.test(window.replace(CONCESSIVE, 'CONCESSIVE-CLAUSE'));
}

/**
 * Both directions of the concessive carve-out, as fixtures. A carve-out that
 * over-reaches is silent -- it just stops catching the reverts -- so the MATCHES
 * list is what keeps the scan alive and the ALLOWS list is what keeps the
 * carve-out honest.
 */
const STILL_CONDITIONAL_MATCHES = [
  'IN-PLACE: if the branch here is detached, take a fresh branch',
  'branch IN PLACE off `origin/main` only when the tree arrived detached',
  'branch IN PLACE unless its PR has merged',
  'IN-PLACE: take a fresh branch when the PR has already merged',
  'IN-PLACE: even if the tree arrived detached, branch here only when its PR has merged',
];
const STILL_CONDITIONAL_ALLOWS = [
  'IN-PLACE: take a fresh branch here, ALWAYS, and WITHOUT leaving the tree',
  'IN-PLACE: take a fresh branch here, ALWAYS — even if the tree arrived detached',
  'branch IN PLACE off `origin/main` — ALWAYS, regardless of whether its PR has merged',
  'branch IN PLACE off `origin/main` — ALWAYS, no matter whether the tree arrived detached',
];

/**
 * Verbs that MOVE a branch. Section 9's restore is AS-IS, so none of these may
 * appear in the restore recipe or on a line that names LAUNCH_BRANCH. The first
 * draft of that step fast-forwarded the branch to origin/main, and the shape it
 * would come back in is `git switch <LAUNCH_BRANCH>` on one line and the
 * fast-forward on the NEXT -- which an argument-position regex cannot see.
 *
 * Two corrections measured on go-to-k/cdk-local#653, one in each direction:
 * the LONG spellings (`--force`, `--force-create`) and the rename forms were
 * absent, so the composite mutant's `git branch --force <LAUNCH_BRANCH>
 * origin/main` passed; and `git merge-base --is-ancestor` -- a pure READ that a
 * correct edit may well want -- matched `\bgit\s+merge\b`, because a hyphen is a
 * word boundary. The verb alternation is now followed by `(?![-\w])`.
 */
const GIT_VERB = String.raw`\bgit(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+`;
const BRANCH_MOVING = new RegExp(
  [
    `${GIT_VERB}(?:pull|rebase|merge|reset|push|update-ref)(?![-\\w])`,
    `${GIT_VERB}branch\\s+(?:-f|--force|-M|-m|--move)\\b`,
    `${GIT_VERB}(?:switch|checkout)\\s+(?:-[CB]|--force-create)\\b`,
  ].join('|')
);

/**
 * The moving-verb set is only as good as its arms, and several match NOTHING in
 * the corpus today -- so deleting them again would be inert and green. These
 * fixtures make the widening itself a fenced property, and the ALLOWS list makes
 * the `(?![-\w])` carve-out one too.
 */
const BRANCH_MOVING_MATCHES = [
  'git pull --ff-only origin main',
  'git rebase origin/main',
  'git merge --ff-only origin/main',
  'git reset --hard origin/main',
  'git push --force origin HEAD',
  'git update-ref refs/heads/x origin/main',
  'git branch -f x origin/main',
  'git branch --force <LAUNCH_BRANCH> origin/main',
  'git branch -M <LAUNCH_BRANCH> renamed',
  'git switch -C x origin/main',
  'git switch --force-create x origin/main',
  'git checkout -B x origin/main',
  'git -C "<LANE_TREE>" pull --ff-only origin main',
  'git -C . merge --ff-only origin/main',
];
const BRANCH_MOVING_ALLOWS = [
  'git switch <LAUNCH_BRANCH>',
  'git switch --detach origin/main',
  'git branch -D <every branch THIS run created>',
  'git branch --show-current',
  'git show-ref --verify refs/heads/<LAUNCH_BRANCH>',
  'git rev-list --count origin/main..<LAUNCH_BRANCH>',
  'git merge-base --is-ancestor origin/main <LAUNCH_BRANCH>',
  'git fetch origin',
  'git status --porcelain',
];

/** A `git branch -d/-D` whose ARGUMENT is the outer tool's own branch. */
const DELETES_LAUNCH_BRANCH = /\bgit\s+branch\s+(-[dD]|--delete)\b[^\n]*LAUNCH_BRANCH/;

/** Every fenced ```bash block of a markdown file, in order. */
export function bashBlocks(markdown: string): string[] {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (/^```bash\s*$/.test(lines[i]!)) start = i + 1;
    } else if (/^```\s*$/.test(lines[i]!)) {
      out.push(lines.slice(start, i).join('\n'));
      start = -1;
    }
  }
  return out;
}

/**
 * Command lines of a block: blanks and whole-line comments dropped, a trailing
 * `# ...` comment stripped.
 *
 * The strip is QUOTE-AWARE. An unconditional `/\s+#.*$/` truncates a legitimate
 * `git commit -m "closes #651"` mid-string, and the caller then reports the
 * MUTILATED text as an unrecognised command -- a confusing failure for an edit
 * that was fine.
 */
export function commandLines(block: string): string[] {
  const stripComment = (line: string): string => {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '#' && i > 0 && /\s/.test(line[i - 1]!)) {
        return line.slice(0, i);
      }
    }
    return line;
  };
  return block
    .split('\n')
    .map((l) => stripComment(l).trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** The first fenced ```bash block of a markdown file. */
export function firstBashBlock(markdown: string): string | null {
  return bashBlocks(markdown)[0] ?? null;
}

describe('work-issues launch-mode probe', () => {
  it('the probe exists exactly once across the skill directory, in launch-mode.md', () => {
    const hits = skillDocs().filter((doc) => read(doc).includes(PROBE_TOKEN));
    expect(
      hits,
      `Expected exactly one file to carry the launch-mode probe (\`${PROBE_TOKEN}\`), found ` +
        `${hits.length}: ${hits.join(', ') || '(none)'}. The skill's own text calls ` +
        `${LAUNCH_MODE_DOC} the ONLY copy: zero hits means the probe was deleted and every ` +
        `IN-PLACE arm downstream is unreachable; two means a second verbatim copy that will ` +
        `drift out of step with the first.`
    ).toEqual([LAUNCH_MODE_DOC]);
    const occurrences = read(LAUNCH_MODE_DOC).split(PROBE_TOKEN).length - 1;
    expect(occurrences, `${LAUNCH_MODE_DOC} repeats the probe token ${occurrences} times`).toBe(1);
  });

  it('the orchestrator points at the launch-mode stage file', () => {
    // The parent reads SKILL.md and nothing else before stage 0; if the pointer
    // goes, the probe is unreachable however intact the file it lives in is.
    expect(read('SKILL.md')).toContain(`references/launch-mode.md`);
  });

  for (const [doc, markers] of Object.entries(ARM_BEARING)) {
    it(`${doc} still names the mode(s) it branches on: ${markers.join(', ')}`, () => {
      const text = read(doc);
      const missing = markers.filter((m) => !text.includes(m));
      expect(
        missing,
        `${doc} no longer mentions ${missing.join(' / ')}. Either its mode-specific arm was ` +
          `deleted (the byte floors do not notice: they only catch the LARGEST stage file ` +
          `disappearing), or the arm moved -- in which case update ARM_BEARING in this file ` +
          `so the assertion keeps tracking where the behaviour actually lives.`
      ).toEqual([]);
    });
  }

  for (const { doc, contract, arm, pattern } of LAUNCH_BRANCH_BEARING) {
    it(`${doc} still carries its ${contract} arm: ${arm}`, () => {
      expect(
        rootRead(doc),
        `${doc} no longer carries the "${contract}" arm "${arm}" (${pattern}). Deleting it ` +
          `breaks the LAUNCH_BRANCH contract even though the file may still MENTION ` +
          `LAUNCH_BRANCH elsewhere -- which is exactly why this asserts the ARM and not the ` +
          `token: a count floor was measured vacuous in 4 of 7 files. If the arm MOVED, move ` +
          `its row in LAUNCH_BRANCH_BEARING; deleting a row silently retires a behaviour.`
      ).toMatch(pattern);
    });
  }

  for (const contract of Object.keys(CONTRACT_FLOOR) as Contract[]) {
    it(`the "${contract}" behaviour is fenced in depth and in breadth`, () => {
      // The reviewer's composite mutant passed because two behaviours had no
      // rows at all and two more had rows in a single file. Depth alone is not
      // enough: rows concentrated in one document are one deletion away from
      // unfenced, and this repo states each rule in several places on purpose.
      const rows = LAUNCH_BRANCH_BEARING.filter((r) => r.contract === contract);
      const docs = new Set(rows.map((r) => r.doc));
      const floor = CONTRACT_FLOOR[contract];
      expect(
        rows.length,
        `only ${rows.length} row(s) fence the "${contract}" behaviour, below the floor of ` +
          `${floor.rows}. Rows were deleted rather than moved, which retires a contract ` +
          `behaviour silently -- the exact state a reviewer measured for "fallback-gate" and ` +
          `"runs-last" before go-to-k/cdk-local#653.`
      ).toBeGreaterThanOrEqual(floor.rows);
      expect(
        docs.size,
        `the "${contract}" behaviour is fenced in only ${docs.size} document(s) ` +
          `(${[...docs].join(', ')}), below the floor of ${floor.docs}. One deletion would ` +
          `leave it unfenced.`
      ).toBeGreaterThanOrEqual(floor.docs);
    });
  }

  describe('section 9 restores LAUNCH_BRANCH as-is rather than moving it', () => {
    const ship = rootRead(WI_SHIP);
    const shipBlocks = bashBlocks(ship);
    const restore = shipBlocks.filter((b) => b.includes('git switch <LAUNCH_BRANCH>'));
    const fallback = shipBlocks.filter((b) => b.includes('git switch --detach origin/main'));

    /**
     * The EXACT command sequence of each block, in order.
     *
     * An `ALLOWED`-SET check is an UPPER bound: it forbids additions but permits
     * deletions and reordering, so deleting the `show-ref --verify` gate,
     * `git branch --show-current`, `git status --porcelain` or the
     * `rev-list --count` closing check was each silently re-revertible -- all
     * four measured GREEN on the previous revision. A BLACKLIST of moving verbs
     * is worse still: it is an enumeration of bad shapes, and the reviewer
     * walked straight past it with `git branch --force`,
     * `git switch --force-create` and a `-C`-prefixed `pull --ff-only`.
     * Ordered equality subsumes both, and its polarity is the right one for a
     * recipe this small and this dangerous: anything not written here fails.
     */
    const PRESCRIBED_RESTORE = [
      'git show-ref --verify refs/heads/<LAUNCH_BRANCH>',
      'git switch <LAUNCH_BRANCH> \\',
      '&& git branch -D <every branch THIS run created>',
      'git branch --show-current',
      'git status --porcelain',
      'git rev-list --count origin/main..<LAUNCH_BRANCH>',
    ];
    const PRESCRIBED_FALLBACK = [
      'git fetch origin \\',
      '&& git switch --detach origin/main \\',
      '&& git branch -D <every branch THIS run created>',
    ];

    it('both blocks exist exactly once and are extractable', () => {
      expect(
        restore.length,
        `references/ship.md has ${restore.length} fenced blocks containing ` +
          `\`git switch <LAUNCH_BRANCH>\`; expected exactly the one section 9 restore recipe.`
      ).toBe(1);
      expect(
        fallback.length,
        `references/ship.md has ${fallback.length} fenced detach FALLBACK blocks; expected ` +
          `exactly one.`
      ).toBe(1);
    });

    it('the restore block is exactly the prescribed sequence, in order', () => {
      expect(
        commandLines(restore[0]!),
        `references/ship.md's IN-PLACE restore block no longer matches the prescribed ` +
          `sequence. Each line is load-bearing and so is the ORDER: the ` +
          `\`show-ref --verify\` gate is what CHOOSES between this block and the detach ` +
          `fallback, the delete is PLURAL because §10-d takes a retro branch in this same ` +
          `tree, and the closing \`--show-current\` / \`--porcelain\` / \`rev-list --count\` ` +
          `checks are what prove the tree was left as it was found. The switch and the ` +
          `delete must stay \`&&\`-CHAINED: unchained, a FAILED switch still runs the -D, ` +
          `and git refuses that only for the CHECKED-OUT branch -- so every other branch ` +
          `this run created, the retro branch included, is deleted while the tree stays on ` +
          `the lane branch it was supposed to leave. Anything that MOVES LAUNCH_BRANCH ` +
          `(pull / merge / rebase / reset / branch --force) re-introduces the withdrawn ` +
          `fast-forward clause, and anything that DELETES it destroys the outer tool's ` +
          `branch. If the recipe legitimately changed, update PRESCRIBED_RESTORE in the ` +
          `same commit.`
      ).toEqual(PRESCRIBED_RESTORE);
    });

    it('the fallback block is exactly the prescribed sequence, in order', () => {
      expect(
        commandLines(fallback[0]!),
        `references/ship.md's detach FALLBACK block no longer matches its prescribed ` +
          `sequence. It was fenced by NOTHING before go-to-k/cdk-local#653 -- the chain ` +
          `scan keyed on \`git switch <LAUNCH_BRANCH>\`, a string this block does not ` +
          `contain -- so unchaining it, or adding a branch-moving command to it, was green.`
      ).toEqual(PRESCRIBED_FALLBACK);
    });

    it('neither block moves or deletes LAUNCH_BRANCH itself', () => {
      for (const [name, block] of [
        ['restore', restore[0]!],
        ['fallback', fallback[0]!],
      ] as const) {
        for (const line of commandLines(block)) {
          expect(
            line,
            `references/ship.md's ${name} block line \`${line}\` MOVES a branch. The restore ` +
              `is AS-IS: no pull, no rebase, no merge, no reset, no \`branch --force\`.`
          ).not.toMatch(BRANCH_MOVING);
          expect(
            line,
            `references/ship.md's ${name} block line \`${line}\` DELETES LAUNCH_BRANCH -- the ` +
              `outer tool's own branch, and the single most damaging thing this contract ` +
              `exists to prevent. The \`-D\` takes <every branch THIS run created>.`
          ).not.toMatch(DELETES_LAUNCH_BRANCH);
        }
      }
    });

    it('both blocks CHAIN the delete to the switch above it', () => {
      // Keyed on the `git branch -D` LINE, not on `git switch <LAUNCH_BRANCH>`:
      // the fallback does not contain that string, so the previous revision's
      // loop skipped it entirely and unchaining the fallback stayed green.
      // Unchained, a FAILED switch still runs the -D. git refuses to delete only
      // the CHECKED-OUT branch (verified: rc=1 with the others already gone), so
      // every other branch this run created -- the §10-d retro branch among them
      // -- is destroyed while the tree stays on the lane branch it was supposed
      // to leave: strictly worse than not cleaning up, since the tree looks
      // half-restored and the branch that would let you retry is gone. The
      // fallback carries a second instance: an unchained `switch --detach` after
      // a failed `fetch` detaches at a STALE origin/main.
      for (const [name, block] of [
        ['restore', restore[0]!],
        ['fallback', fallback[0]!],
      ] as const) {
        const cmds = commandLines(block);
        const del = cmds.findIndex((l) => l.includes('git branch -D'));
        expect(del, `references/ship.md's ${name} block has no branch delete`).toBeGreaterThan(0);
        expect(
          cmds[del]!.startsWith('&&') || cmds[del - 1]!.endsWith('\\'),
          `references/ship.md's ${name} block runs \`${cmds[del]}\` UNCHAINED. Chain it to the ` +
            `command above with \`&&\`: on a failed switch the delete otherwise still destroys ` +
            `every branch that is not checked out.`
        ).toBe(true);
      }
    });

    it('the fallback never names LAUNCH_BRANCH, and still deletes this run\'s branches', () => {
      // The fallback fires precisely when LAUNCH_BRANCH is empty or dangling, so
      // it must not hand the name to ANY command -- the empty-argument class of
      // bug this skill documents elsewhere. The existence probe that chooses
      // between the two arms lives in the RESTORE block, above the decision, so
      // nothing legitimate is left to name it here.
      expect(
        fallback[0]!,
        `references/ship.md's fallback block names LAUNCH_BRANCH. That value is empty or ` +
          `dangling on every path that reaches this block; the probe that reads it belongs ` +
          `in the restore block, before the arm is chosen.`
      ).not.toContain('LAUNCH_BRANCH');
    });

    it('the restore is presented BEFORE the detach fallback', () => {
      // An agent reading top-down takes the first arm it meets, and detaching is
      // the end state this change moved away from. The hook's own message is
      // pinned the same way in `.claude/hooks/stop-unmerged-lane-warn.test.sh`.
      const restoreAt = ship.indexOf('git switch <LAUNCH_BRANCH>');
      const detachAt = ship.indexOf('git switch --detach origin/main');
      expect(restoreAt, 'references/ship.md no longer shows the restore recipe').toBeGreaterThan(-1);
      expect(detachAt, 'references/ship.md no longer shows the detach fallback').toBeGreaterThan(-1);
      expect(
        restoreAt,
        `references/ship.md presents the detach FALLBACK before the LAUNCH_BRANCH restore. ` +
          `A run reading top-down takes the first arm it meets.`
      ).toBeLessThan(detachAt);
    });

    it('the fallback is labelled mutually exclusive with the restore', () => {
      // Every other paired arm in ship.md carries this label; running both
      // leaves the tree detached, which is the end state this section removes.
      expect(
        ship,
        `references/ship.md's IN-PLACE arms lost the "never both" exclusivity label that its ` +
          `paired MAIN-CHECKOUT / IN-PLACE blocks carry.`
      ).toMatch(/run THIS block INSTEAD, never both/);
    });
  });

  it('no site anywhere in .claude/** names LAUNCH_BRANCH beside a branch-moving verb', () => {
    // The block scan above reaches the two fenced recipes. retro.md,
    // gotchas.md and hunt-bugs/SKILL.md each carry a PROSE copy it cannot see,
    // and launch-mode.md's table states the rule one line per row.
    const scanned = launchBranchBearingFiles();
    expect(
      scanned.length,
      `only ${scanned.length} .claude/** file(s) mention LAUNCH_BRANCH; the derived scan ` +
        `population has collapsed and would report clean over anything.`
    ).toBeGreaterThanOrEqual(9);
    for (const [name, text] of scanned) {
      const lines = text.split('\n');
      for (const [i, line] of lines.entries()) {
        if (!line.includes('LAUNCH_BRANCH')) continue;
        // The wrapped window, not the bare line: a fast-forward written on the
        // line AFTER the mention is the withdrawn draft's own shape.
        expect(
          wrappedWindow(lines, i),
          `${name}:${i + 1} names LAUNCH_BRANCH beside a branch-moving verb.`
        ).not.toMatch(BRANCH_MOVING);
      }
      for (const [i, line] of lines.entries()) {
        expect(
          line,
          `${name}:${i + 1} passes LAUNCH_BRANCH to \`git branch -d/-D\`. That deletes the ` +
            `OUTER TOOL's branch; the delete takes the branches THIS run created.`
        ).not.toMatch(DELETES_LAUNCH_BRANCH);
      }
    }
  });

  for (const [doc, sentence] of UNCONDITIONAL_RULE) {
    it(`${doc} states the in-place branch rule unconditionally`, () => {
      expect(
        read(doc),
        `${doc} no longer carries the instruction verbatim: "${sentence}". A conditional ` +
          `rule there sends a lane onto LAUNCH_BRANCH, which the merge then deletes on the ` +
          `outer tool's behalf (this repo has delete_branch_on_merge). If the wording ` +
          `legitimately changed, update UNCONDITIONAL_RULE in the same commit.`
      ).toContain(sentence);
    });
  }

  for (const [rel, sentence] of OUTSIDE_UNCONDITIONAL_RULE) {
    it(`${rel} states the in-place branch rule unconditionally`, () => {
      expect(
        rootRead(rel),
        `${rel} no longer carries: "${sentence}". A conditional rule there sends a run ` +
          `onto LAUNCH_BRANCH, which the merge then deletes on the outer tool's behalf ` +
          `(this repo has delete_branch_on_merge). If the wording legitimately changed -- ` +
          `note the dash styles differ between these files, so a normalising pass will trip ` +
          `this -- update OUTSIDE_UNCONDITIONAL_RULE in the same commit.`
      ).toContain(sentence);
    });
  }

  it('no site re-conditions the in-place branch rule on the tree being detached', () => {
    // The sentence pins above prove the right rule is PRESENT; this proves a
    // second site has not put the old one back beside it. Scoped to lines whose
    // subject IS the instruction, so the paragraphs that discuss the withdrawn
    // condition as history are untouched.
    const scanned = claudeFiles().map(
      (rel) => [rel, readFileSync(join(repoRoot, rel), 'utf8')] as [string, string]
    );
    let sites = 0;
    for (const [name, text] of scanned) {
      const lines = text.split('\n');
      for (const [i, line] of lines.entries()) {
        if (!IN_PLACE_RULE_LINE.test(line)) continue;
        sites++;
        expect(
          statesACondition(wrappedWindow(lines, i)),
          `${name}:${i + 1} states the in-place branch rule and gates it on the tree's ` +
            `state (detached, or its PR already merged). go-to-k/cdkd#2417 made that rule ` +
            `unconditional. A CONCESSIVE clause ("ALWAYS -- even if the tree arrived ` +
            `detached") is fine and is carved out; a real condition is not.`
        ).toBe(false);
      }
    }
    expect(
      sites,
      `the in-place rule was found at ${sites} sites across .claude/**; the scan has stopped ` +
        `matching and would report clean over anything.`
    ).toBeGreaterThanOrEqual(4);
  });

  it('the conditional-rule scan still fires, and its concessive carve-out does not over-reach', () => {
    for (const text of STILL_CONDITIONAL_MATCHES) {
      expect(statesACondition(text), `the conditional scan no longer flags \`${text}\`.`).toBe(true);
    }
    for (const text of STILL_CONDITIONAL_ALLOWS) {
      expect(
        statesACondition(text),
        `the conditional scan flags \`${text}\`, which STATES the rule unconditionally. A ` +
          `fence that refuses a correct edit is a fence the next author deletes.`
      ).toBe(false);
    }
  });

  it('the branch-moving verb set still recognises what it was widened for', () => {
    for (const cmd of BRANCH_MOVING_MATCHES) {
      expect(cmd, `BRANCH_MOVING no longer matches \`${cmd}\`.`).toMatch(BRANCH_MOVING);
    }
    for (const cmd of BRANCH_MOVING_ALLOWS) {
      expect(
        cmd,
        `BRANCH_MOVING now matches \`${cmd}\`, which the recipes legitimately run. ` +
          `\`git merge-base\` is a READ: a hyphen is a word boundary, so a bare ` +
          `\`\\bgit\\s+merge\\b\` claims it.`
      ).not.toMatch(BRANCH_MOVING);
    }
  });

  /**
   * Every place the restore is stated OUTSIDE ship.md's fenced block, with the
   * number of times each states it. The COUNT is what closes the gap a reviewer
   * measured: hunt-bugs' recipe line could be deleted outright, after which the
   * chain loop iterated over nothing and passed vacuously.
   */
  const RESTORE_PROSE_SITES: Array<{ doc: string; restores: number; detaches: number }> = [
    { doc: WI_SHIP, restores: 1, detaches: 1 },
    { doc: WI_RETRO, restores: 1, detaches: 0 },
    { doc: HUNT_BUGS, restores: 1, detaches: 1 },
  ];

  for (const { doc, restores, detaches } of RESTORE_PROSE_SITES) {
    it(`${doc} states the restore ${restores}x / the detach ${detaches}x, each CHAINED`, () => {
      const lines = rootRead(doc).split('\n');
      let sawRestore = 0;
      let sawDetach = 0;
      for (const [i, line] of lines.entries()) {
        const window = wrappedWindow(lines, i);
        if (/git switch <LAUNCH_BRANCH>/.test(line)) {
          sawRestore++;
          expect(
            window,
            `${doc}:${i + 1} states the restore without chaining the branch delete to it. ` +
              `A failed switch must not leave \`git branch -D\` to run anyway.`
          ).toMatch(/git switch <LAUNCH_BRANCH>[^\n]*(\\\s*)?&&[^\n]*git branch -D/);
        }
        if (/git switch --detach origin\/main/.test(line)) {
          sawDetach++;
          expect(
            window,
            `${doc}:${i + 1} states the detach FALLBACK without chaining the branch delete ` +
              `to it. This is the block the previous chain scan could not see at all.`
          ).toMatch(/git switch --detach origin\/main[^\n]*(\\\s*)?&&[^\n]*git branch -D/);
        }
      }
      expect(
        sawRestore,
        `${doc} states the restore ${sawRestore} time(s), expected ${restores}. Zero means ` +
          `the recipe was DELETED and the chain loop above now iterates over nothing -- a ` +
          `vacuous pass, which is what a reviewer measured for hunt-bugs.`
      ).toBe(restores);
      expect(
        sawDetach,
        `${doc} states the detach fallback ${sawDetach} time(s), expected ${detaches}.`
      ).toBe(detaches);
    });
  }

  it("the restore's owner and the lane's reviewer shape are still stated", () => {
    // Two rules this change added that nothing else would notice losing: the
    // PARENT owns the end-of-run restore even though section 10-d is where it
    // fires, and a lane's reviewers run synchronously (a lane's subagents report
    // to the MAIN session, so a lane awaiting them waits for nothing).
    expect(
      read(join('references', 'ship.md')),
      `references/ship.md no longer says the PARENT owns the end-of-run restore. Section ` +
        `10 may be dispatched to a subagent, and two agents must not both switch one tree.`
    ).toContain('in the PARENT');
    expect(
      read(join('references', 'retro.md')),
      `references/retro.md no longer says the PARENT runs the restore in section 10-d.`
    ).toContain('the PARENT runs');
    expect(
      read('SKILL.md'),
      `SKILL.md no longer tells a lane to run its reviewers SYNCHRONOUSLY. Its subagents ` +
        `report to the main session, so a lane awaiting them waits for something that ` +
        `cannot arrive (references/verify.md section 8).`
    ).toContain('SYNCHRONOUSLY');
  });

  it('both mirrored flow lessons are still in the stage file that fires them', () => {
    // Neither lesson has an executable arm -- they are rules about how the
    // orchestrator dispatches -- so the only available fence is that the
    // distinguishing token survives. Weak, and better than nothing: both were
    // added by go-to-k/cdk-local#651 and every other assertion here would stay
    // green if a compression pass deleted them.
    // Pinned on the DIRECTIONAL half of each rule rather than on the API
    // literal it quotes: `Resuming agent` and `report to the MAIN session`
    // both survive a paragraph that says the opposite ("...report to the MAIN
    // session only once the lane has exited"), which is the revert worth
    // catching.
    expect(
      read(join('references', 'ship.md')),
      `references/ship.md lost section 9's queued-versus-Resuming rule: a SendMessage ` +
        `answering "queued" is not a granted turn.`
    ).toContain('A queued message is\nnever a granted turn');
    expect(
      read(join('references', 'verify.md')),
      `references/verify.md lost section 8's rule that reviewer subagents spawned BY A LANE ` +
        `report to the MAIN session, not to the lane.`
    ).toContain('not to the\n  lane that spawned them');
  });

  describe('the probe, executed', () => {
    /**
     * Runs the doc's OWN fenced probe -- extracted, not re-typed -- against a
     * throwaway repo and a linked worktree of it. A copy re-typed here would
     * pass while the shipped one was broken, which is the whole failure this
     * test is for.
     */
    const block = firstBashBlock(read(LAUNCH_MODE_DOC));

    /**
     * The keys the probe prints, IN ORDER. Without this a stray line -- a debug
     * echo, a fifth value someone added -- parses into the map unnoticed, and a
     * line with no `=` becomes a garbage key (`indexOf` returns -1, so the key
     * is the line minus its last character) while every value assertion below
     * still passes. Order-pinning also fences the printf's field list against
     * being reordered out of step with its arguments.
     */
    const PROBE_KEYS = ['MODE', 'LANE_TREE', 'MAIN_CHECKOUT', 'LAUNCH_BRANCH'];

    it('extracts a non-vacuous probe block from the doc', () => {
      expect(block, `no fenced bash block found in ${LAUNCH_MODE_DOC}`).not.toBeNull();
      expect(block!).toContain(PROBE_TOKEN);
      expect(block!).toContain('MAIN-CHECKOUT');
      expect(block!).toContain('IN-PLACE');
      expect(block!).toContain('LAUNCH_BRANCH');
    });

    /**
     * A throwaway repo plus a linked worktree of it, and a runner for the doc's
     * own probe. Each case builds its own so an early failure in one cannot mask
     * a later one -- the detached arm used to be appended to the case below.
     */
    function fixture() {
      const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wi-launch-mode-')));
      const main = join(tmp, 'main');
      const lane = join(tmp, 'lane');
      const script = join(tmp, 'probe.sh');
      writeFileSync(script, `${block}\n`);
      // Hermetic: a user's global config (hooksPath, templates, signing) must
      // not decide whether this test passes.
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
      const git = (args: string[], cwd = tmp) =>
        execFileSync('git', args, { cwd, env, encoding: 'utf8' });
      // Explicit initial branch: the LAUNCH_BRANCH assertions must not depend on
      // whichever default this git build compiles in.
      git(['init', '-q', '-b', 'probe-main', main]);
      git(['-C', main, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
      git(['-C', main, 'worktree', 'add', '-q', lane, '-b', 'lane-branch']);
      const run = (cwd: string) =>
        Object.fromEntries(
          execFileSync('bash', [script], { cwd, env, encoding: 'utf8' })
            .trim()
            .split('\n')
            .map((l) => {
              const at = l.indexOf('=');
              return [l.slice(0, at), l.slice(at + 1)] as const;
            })
        );
      return { tmp, main, lane, git, run };
    }

    it('answers MAIN-CHECKOUT in a main checkout and IN-PLACE in a linked worktree', () => {
      const { tmp, main, lane, run } = fixture();
      try {
        const fromMain = run(main);
        expect(
          Object.keys(fromMain),
          `the probe printed ${JSON.stringify(Object.keys(fromMain))} from the main ` +
            `checkout, not the four keys every stage substitutes. An extra line parses in ` +
            `as a key of its own and a line with no "=" becomes a garbage key, both of ` +
            `which leave the value assertions below passing.`
        ).toEqual(PROBE_KEYS);
        expect(fromMain.MODE).toBe('MAIN-CHECKOUT');
        expect(fromMain.LANE_TREE).toBe(main);
        expect(fromMain.MAIN_CHECKOUT).toBe(main);
        expect(fromMain.LAUNCH_BRANCH).toBe('probe-main');

        const fromLane = run(lane);
        expect(Object.keys(fromLane), 'the probe printed the wrong key set from the lane tree').toEqual(
          PROBE_KEYS
        );
        expect(fromLane.MODE).toBe('IN-PLACE');
        // The value section 9 puts back, read at probe time.
        expect(fromLane.LAUNCH_BRANCH).toBe('lane-branch');
        // The two values differing IS the mode, and MAIN_CHECKOUT must point at
        // the OTHER tree -- that is the value section 2's collision scan needs
        // and the one a `pwd`- or `--show-toplevel`-derived probe gets wrong.
        expect(fromLane.LANE_TREE).toBe(lane);
        expect(fromLane.MAIN_CHECKOUT).toBe(main);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('answers with the LANE branch once section 5 has switched the tree', () => {
      // The executable form of launch-mode.md's "UNRECOVERABLE if not recorded
      // now": after section 5 takes the lane's own branch in this same tree, the
      // probe can no longer name what section 9 has to put back. A run that
      // re-derives the value here restores the LANE branch onto itself.
      const { tmp, lane, git, run } = fixture();
      try {
        expect(run(lane).LAUNCH_BRANCH).toBe('lane-branch');
        git(['-C', lane, 'switch', '-q', '-c', 'chore/section-5-branch']);
        expect(
          run(lane).LAUNCH_BRANCH,
          `the probe re-run after section 5 still answers with the LAUNCH value, so the ` +
            `doc's "record it now, never re-derive it" rule would be unnecessary.`
        ).toBe('chore/section-5-branch');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('answers with an EMPTY LAUNCH_BRANCH in a worktree handed over detached', () => {
      // Empty is an ANSWER, not a failure -- it is what selects section 9's
      // detach fallback over the restore. The mode verdict must be unaffected,
      // since a detached worktree is still a worktree.
      const { tmp, main, lane, git, run } = fixture();
      try {
        git(['-C', lane, 'switch', '-q', '--detach', 'HEAD']);
        const fromDetachedLane = run(lane);
        expect(
          Object.keys(fromDetachedLane),
          'the probe printed the wrong key set from a detached lane tree'
        ).toEqual(PROBE_KEYS);
        expect(fromDetachedLane.MODE).toBe('IN-PLACE');
        expect(fromDetachedLane.LANE_TREE).toBe(lane);
        expect(fromDetachedLane.MAIN_CHECKOUT).toBe(main);
        expect(fromDetachedLane.LAUNCH_BRANCH).toBe('');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('refuses to answer outside a work tree instead of printing a wrong verdict', () => {
      // The dangerous failure is not an error, it is a CONFIDENT MAIN-CHECKOUT:
      // with every `git rev-parse` failing, an unguarded compare tests "" against
      // "" and says "main checkout" while standing nowhere. Inside `.git` the
      // trap is subtler still -- `--is-inside-work-tree` prints `false` and exits
      // ZERO there, so an exit-status guard passes and yields an empty LANE_TREE.
      const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wi-launch-mode-neg-')));
      try {
        const main = join(tmp, 'main');
        const script = join(tmp, 'probe.sh');
        writeFileSync(script, `${block}\n`);
        const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
        execFileSync('git', ['init', '-q', '-b', 'probe-main', main], { cwd: tmp, env, encoding: 'utf8' });

        for (const cwd of [tmp, join(main, '.git')]) {
          let failed = false;
          let output = '';
          try {
            output = execFileSync('bash', [script], { cwd, env, encoding: 'utf8', stdio: 'pipe' });
          } catch (e) {
            failed = true;
            output = String((e as { stdout?: string }).stdout ?? '');
          }
          expect(failed, `the probe answered "${output.trim()}" from ${cwd} instead of failing`).toBe(true);
          expect(output).not.toContain('MODE=');
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
