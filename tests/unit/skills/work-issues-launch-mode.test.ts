import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The `/work-issues` LAUNCH-MODE machinery, which decides whether a run creates
 * a worktree per lane or works in the tree it was launched in.
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
 * Three properties, in increasing order of what they actually prove:
 *
 *   1. the probe exists EXACTLY ONCE in the skill directory -- pinning both its
 *      presence and the single-copy claim the text makes about it (a second
 *      verbatim copy is the drift shape section 10-b fences elsewhere);
 *   2. every file carrying a mode-specific ARM still names the mode(s) it
 *      branches on, so gutting one file's arms fails even though the corpus
 *      byte floor (which only notices the LARGEST file disappearing) would not;
 *   3. the probe is EXECUTED, in a real git repo and in a real linked worktree
 *      of it, and must answer with the two literal verdicts. This is the one
 *      arm of the whole change that is executable rather than prose, and the
 *      shell-edge-case reading beside it in the doc is otherwise re-checked by
 *      nothing.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skillsDir = join(repoRoot, '.claude', 'skills');
const skillDir = join(skillsDir, 'work-issues');
const LAUNCH_MODE_DOC = join('references', 'launch-mode.md');

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

function read(rel: string): string {
  return readFileSync(join(skillDir, rel), 'utf8');
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
 * Files carrying an arm of the LAUNCH_BRANCH contract (go-to-k/cdk-local#651,
 * ported from go-to-k/cdkd#2417): the probe records the branch the outer tool
 * handed the tree over on, section 5 refuses to commit onto it, and section 9
 * puts it back AS-IS at the very end. Separate from ARM_BEARING because the mode
 * words survive deleting the restore -- a file can still say IN-PLACE everywhere
 * while the one step that makes the mode leave no trace is gone, which is what
 * the byte floors also cannot see. gotchas.md is here because its Stop-hook entry
 * names the restore as the remedy; before this change it named detaching and
 * called the choice the outer tool's, which is the contradiction that would
 * return if the arm were dropped there alone. hunt-bugs is here because it is a
 * SECOND skill that runs IN-PLACE and merges through /merge-pr, so the
 * commit-onto-LAUNCH_BRANCH hazard is identical there.
 *
 * The value is an occurrence FLOOR, not a boolean. A presence check passes on a
 * file that kept one mention and lost every paragraph around it -- measured
 * during review: ship.md's fallback block, its "runs LAST" note and both new
 * table rows in launch-mode.md could all go while `toContain` stayed green. Each
 * floor sits at roughly half the count at the time of writing, so narrative
 * COMPRESSION is still legal and gutting is not. Re-derive rather than raise to
 * the current count: a floor equal to the count fails on the next reword.
 */
const LAUNCH_BRANCH_BEARING: Record<string, number> = {
  // Counts at the time of writing: SKILL.md 4, launch-mode.md 11, claim.md 1,
  // implement.md 1, ship.md 10, retro.md 1, gotchas.md 2; hunt-bugs 7.
  // The three files whose count is 1 get a floor of 1, which IS the presence
  // check this comment disparages -- there is nothing else available at that
  // count. What covers them instead is UNCONDITIONAL_RULE below, which pins the
  // whole instruction rather than the token.
  'SKILL.md': 2,
  [LAUNCH_MODE_DOC]: 8,
  [join('references', 'claim.md')]: 1,
  // implement.md is section 5's own file and the ONE a lane actually opens at
  // that stage, so its arm is the one whose absence is dangerous rather than
  // merely inconsistent: a lane reading only the older conditional wording
  // commits onto LAUNCH_BRANCH, and the merge then deletes the outer tool's
  // remote branch. It was out of scope while go-to-k/cdk-local#643 held the
  // file and joined the list the moment that PR merged.
  [join('references', 'implement.md')]: 1,
  [join('references', 'ship.md')]: 6,
  [join('references', 'retro.md')]: 1,
  [join('references', 'gotchas.md')]: 1,
};

/** The same set as a list, for the scans that read every bearing doc. */
const LAUNCH_BRANCH_BEARING_DOCS = Object.keys(LAUNCH_BRANCH_BEARING);

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
  [join('.claude', 'skills', 'hunt-bugs', 'SKILL.md'), "take the fix's branch IN PLACE off `origin/main` — ALWAYS"],
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
const STILL_CONDITIONAL = /\b(if|when|unless|only)\b[^.]*\bdetached\b/i;

/** Skills OTHER than work-issues that must carry the same contract. */
const LAUNCH_BRANCH_SIBLING_SKILLS: Record<string, number> = {
  'hunt-bugs': 4,
};

/**
 * Verbs that MOVE a branch. Section 9's restore is AS-IS, so none of these may
 * appear in the restore recipe or on a line that names LAUNCH_BRANCH. The first
 * draft of that step fast-forwarded the branch to origin/main, and the shape it
 * would come back in is `git switch <LAUNCH_BRANCH>` on one line and the
 * fast-forward on the NEXT -- which an argument-position regex cannot see.
 */
const BRANCH_MOVING =
  /\bgit\s+(pull|rebase|merge|reset|push|update-ref)\b|\bgit\s+branch\s+-f\b|\bgit\s+(switch|checkout)\s+-[CB]\b/;

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

  for (const [doc, floor] of Object.entries(LAUNCH_BRANCH_BEARING)) {
    it(`${doc} still carries its LAUNCH_BRANCH arm (>= ${floor} mentions)`, () => {
      const found = read(doc).split('LAUNCH_BRANCH').length - 1;
      expect(
        found,
        `${doc} mentions LAUNCH_BRANCH ${found} times, below its floor of ${floor}. Its arm ` +
          `of the restore contract was gutted or moved: without it an IN-PLACE run ends on a ` +
          `squash-merged lane branch (the Stop hook warns every turn) or detached ` +
          `(visible-surprising in the outer tool's UI) instead of on the branch the tool ` +
          `created. If the arm MOVED, update LAUNCH_BRANCH_BEARING so the assertion keeps ` +
          `tracking it; if it was legitimately COMPRESSED below the floor, re-derive the floor ` +
          `in the same commit.`
      ).toBeGreaterThanOrEqual(floor);
    });
  }

  for (const [skill, floor] of Object.entries(LAUNCH_BRANCH_SIBLING_SKILLS)) {
    it(`${skill}/SKILL.md carries the same LAUNCH_BRANCH contract (>= ${floor} mentions)`, () => {
      // A second skill that runs IN-PLACE and merges through /merge-pr inherits
      // the hazard verbatim: this repo has `delete_branch_on_merge`, so a run
      // that opened its PR from LAUNCH_BRANCH deletes the outer tool's remote
      // branch. work-issues' own fences cannot see that file at all.
      const text = readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8');
      const found = text.split('LAUNCH_BRANCH').length - 1;
      expect(
        found,
        `.claude/skills/${skill}/SKILL.md mentions LAUNCH_BRANCH ${found} times, below its ` +
          `floor of ${floor}. That skill also runs IN-PLACE and merges through /merge-pr, so ` +
          `dropping the contract there re-opens the exact hazard work-issues closed.`
      ).toBeGreaterThanOrEqual(floor);
    });
  }

  it('section 9 restores LAUNCH_BRANCH as-is rather than fast-forwarding it', () => {
    // The spec was CORRECTED mid-filing: an early draft fast-forwarded the branch
    // to origin/main first. Restoring is the point -- the branch is the outer
    // tool's artifact -- so a re-introduced move of that branch is the regression
    // this pins. The withdrawal is discussed in prose, so the assertion reads the
    // COMMANDS, not the surrounding narrative.
    //
    // Scoped to the RECIPE BLOCK rather than matched as the verb's argument: the
    // draft's actual shape was `git switch <LAUNCH_BRANCH>` on one line and the
    // fast-forward on the NEXT, which never names the placeholder at all. An
    // argument-position regex missed five of six candidate rewrites when it was
    // measured during review; a whole-block ban misses none of them.
    const ship = read(join('references', 'ship.md'));
    const restore = bashBlocks(ship).filter((b) => b.includes('git switch <LAUNCH_BRANCH>'));
    expect(
      restore.length,
      `references/ship.md has ${restore.length} fenced blocks containing ` +
        `\`git switch <LAUNCH_BRANCH>\`; expected exactly the one section 9 restore recipe.`
    ).toBe(1);
    for (const line of restore[0]!.split('\n')) {
      expect(
        line,
        `section 9's restore recipe runs a command that MOVES a branch. The restore is ` +
          `AS-IS: no pull, no rebase, no merge, no reset, no \`branch -f\`.`
      ).not.toMatch(BRANCH_MOVING);
    }
    // ...and nowhere in either doc may a moving verb share a line with the value.
    // retro.md carries a SECOND copy of the recipe in prose, which the block scan
    // above cannot reach.
    // ...and nowhere in ANY bearing doc may a moving verb share a line with the
    // value. retro.md and hunt-bugs/SKILL.md each carry a second, prose copy of
    // the recipe that the block scan above cannot reach, and launch-mode.md's
    // table rows state the rule in one line apiece.
    const scanned: Array<[string, string]> = [
      ...LAUNCH_BRANCH_BEARING_DOCS.map((d) => [d, read(d)] as [string, string]),
      ...OUTSIDE_UNCONDITIONAL_RULE.map(([rel]) => [rel, readFileSync(join(repoRoot, rel), 'utf8')] as [string, string]),
    ];
    for (const [name, text] of scanned) {
      for (const [i, line] of text.split('\n').entries()) {
        if (!line.includes('LAUNCH_BRANCH')) continue;
        expect(
          line,
          `${name}:${i + 1} names LAUNCH_BRANCH on the same line as a branch-moving verb.`
        ).not.toMatch(BRANCH_MOVING);
      }
    }

    // The restore must be presented BEFORE the detach fallback: an agent reading
    // top-down takes the first arm it meets, and detaching is the end state this
    // change moved away from. The hook's own message is pinned the same way in
    // `.claude/hooks/stop-unmerged-lane-warn.test.sh`.
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
        readFileSync(join(repoRoot, rel), 'utf8'),
        `${rel} no longer carries: "${sentence}". A conditional rule there sends a run ` +
          `onto LAUNCH_BRANCH, which the merge then deletes on the outer tool's behalf ` +
          `(this repo has delete_branch_on_merge).`
      ).toContain(sentence);
    });
  }

  it('no site re-conditions the in-place branch rule on the tree being detached', () => {
    // The sentence pins above prove the right rule is PRESENT; this proves a
    // second site has not put the old one back beside it. Scoped to lines whose
    // subject IS the instruction, so the paragraphs that discuss the withdrawn
    // condition as history are untouched.
    const files: Array<[string, string]> = [
      ...LAUNCH_BRANCH_BEARING_DOCS.map((d) => [d, read(d)] as [string, string]),
      ...OUTSIDE_UNCONDITIONAL_RULE.map(([rel]) => [rel, readFileSync(join(repoRoot, rel), 'utf8')] as [string, string]),
    ];
    for (const [name, text] of files) {
      for (const [i, line] of text.split('\n').entries()) {
        if (!IN_PLACE_RULE_LINE.test(line)) continue;
        expect(
          line,
          `${name}:${i + 1} states the in-place branch rule and gates it on the tree being ` +
            `detached. go-to-k/cdkd#2417 made that rule unconditional.`
        ).not.toMatch(STILL_CONDITIONAL);
      }
    }
  });

  it('both mirrored flow lessons are still in the stage file that fires them', () => {
    // Neither lesson has an executable arm -- they are rules about how the
    // orchestrator dispatches -- so the only available fence is that the
    // distinguishing token survives. Weak, and better than nothing: both were
    // added by go-to-k/cdk-local#651 and every other assertion here would stay
    // green if a compression pass deleted them.
    expect(
      read(join('references', 'ship.md')),
      `references/ship.md lost section 9's queued-versus-Resuming rule: a SendMessage ` +
        `answering "queued" is not a granted turn.`
    ).toContain('Resuming agent');
    expect(
      read(join('references', 'verify.md')),
      `references/verify.md lost section 8's rule that reviewer subagents spawned BY A LANE ` +
        `report to the MAIN session.`
    ).toContain('report to the MAIN session');
  });

  describe('the probe, executed', () => {
    /**
     * Runs the doc's OWN fenced probe -- extracted, not re-typed -- against a
     * throwaway repo and a linked worktree of it. A copy re-typed here would
     * pass while the shipped one was broken, which is the whole failure this
     * test is for.
     */
    const block = firstBashBlock(read(LAUNCH_MODE_DOC));

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
        expect(fromMain.MODE).toBe('MAIN-CHECKOUT');
        expect(fromMain.LANE_TREE).toBe(main);
        expect(fromMain.MAIN_CHECKOUT).toBe(main);
        expect(fromMain.LAUNCH_BRANCH).toBe('probe-main');

        const fromLane = run(lane);
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
