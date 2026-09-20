<!-- Part of the /work-issues skill (§10). A bare §N points into the stage file holding that section; the map is SKILL.md's "Stages" table. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

Trigger: after §9's last lane is merged and every worktree THIS run added is
removed (an IN-PLACE run added none, so its trigger is the last merge), BEFORE
the wrap report, while the evidence is still in context. `/verify-pr` step 11's
retrospective was per LANE; this one covers **the flow itself** across the
WHOLE run, and **applies** the fix as a routine call. Escalate via
`AskUserQuestion` only when the edit changes what the flow PROMISES: dropping a
check, lowering a review tier, loosening §0.

### 10-0. Measure the run's net effect on the backlog

Count closed vs filed, splitting filed into new issues and findings FOLDED
into an existing one (§5's window) — the folds being issues updated since the
run started whose BODY gained a `- [ ]` row. `updatedAt` alone can never read 0
here: §4 makes every lane comment on the issue it takes.

**Then run the PROMOTION check on every `next` this run filed and left open** —
a deferral is judged against the run that HAPPENED, and it must be a QUERY,
since nobody re-opens a decision they remember making deliberately. Grep each
body for `Session-fit: *next` (no GitHub label carries it), pull the filenames
out, and match them by SUFFIX (bodies name a file by BASENAME far more often
than by full path) against

```bash
git diff --name-only "<sha main was at when this run started>..origin/main" | sort -u
```

That diff is a LOWER bound on what the run loaded, since it also READ its
reviewers' diffs and the modules its lanes traced: if any file the fix touches
was read this run, the item is `now`. A hit is a prompt for judgement, not a
verdict — a SHARED BASENAME matches every sibling directory at once — and when
one CONTRADICTS the stated reason, the BODY is the stale side.

Report one line — `closed N / filed M (new K / folded J)` — plus the reason
when M > N; only one such reason is healthy, the code really having that many
independent defects (say which area). `J = 0` over several findings in one area
signals §5's window was searched by this instance's spelling, not the concept.
**M <= N is NOT a target**: an unfiled finding leaves the defect in the
product.

### 10-a. Evidence: only what this run actually produced

Walk the session and collect, each with its concrete instance: **corrections
the user made** (two on one theme across lanes is a defect in this text);
**text that was WRONG as written** (a failed command, a probe reporting clear
while a lane was live, a dead flag / path / hook name); **steps you had to
invent**; **right instruction, wrong place**; **followed it and still paid**.

**No evidence, no edit.** A clean run's output is one wrap line
("retrospective: no skill change — §2 / §4 / §8 held"); a skill grown from
"this would be nice" stops being read to the bottom, where §9 and §10 live.
**And evidence you were HANDED is not evidence you VERIFIED**: the observation
survives the hand-off, the CAUSAL STORY often does not — resolve it against the
file, reading the CONDITION rather than a line number.

### 10-b. Where the fix belongs — pick ONE

**Default to no mechanism**: a tooling finding is a ROW in
`docs/tooling-backlog.md` on its FIRST occurrence, and a mechanism is built
only on the SECOND occurrence of the same failure. Otherwise:

- **This skill's stage files** — the `references/<stage>.md` where the lesson
  fires, never the SKILL.md orchestrator unless the stage list changed.
- **Another skill**, only one this run exercised, or **`.claude/CLAUDE.md` /
  `.claude/rules/**`** when it applies to any work here.
- **Memory** for judgmental, cross-repo lessons — weakest enforcement, and the
  landing spot when nothing above can hold the rule.

### 10-c. How to edit: amend, do not append

Every run appending one more bullet is how a long skill becomes an unread one.

- Put the fix **in the step where it fires** (gotchas is for traps that span
  steps), **amend the sentence that was wrong** rather than adding a sibling,
  and point at a rule already in `.claude/CLAUDE.md` rather than restating it.
- **Carry the evidence inline as ONE line**: the rule plus a citation, never
  the narrative. A rule with no incident behind it cannot be retired; one
  buried in its incident report is not read.
- **Pay for what you add** by cutting a line this run proved stale, subsumed or
  wrong. The budgets in `.claude/CLAUDE.md`'s Tooling Policy are the stop on
  this skill's growth loop; nothing enforces them, so raising one instead of
  paying is a choice you make in the open. A lesson compression cannot pay for
  splits the stage instead.
- **Fully qualify every issue / PR reference as `go-to-k/<repo>#N`** — a bare
  `#N` auto-links to THIS repo's item N, which is a different issue. In a PR or
  issue BODY use the full `https://github.com/go-to-k/<repo>/issues/N` URL.
  Nothing checks this any more.

### 10-d. Ship it like any other change

After `/merge-pr` you are back on `main`, where `branch-gate` blocks commits,
so the retro gets its own branch. MAIN-CHECKOUT (§3's launch-mode probe) runs
THIS block, not the next one:

```bash
# Suffix the branch with the LESSON, not the date: a merged branch is deleted
# (post-merge-orphan-push-gate refuses re-pushing that name) and a bare date
# collides with a peer's retro the same day.
B=chore/work-issues-retro-<lesson-slug>
git worktree add ".claude/worktrees/${B##*/}" -b "$B" origin/main
cd ".claude/worktrees/${B##*/}"
mise trust && mise install    # untrusted .mise.toml: vp will not resolve
pnpm install                  # worktrees have no node_modules
```

IN-PLACE — run THIS block INSTEAD, never both: `git worktree add` from inside
this tree NESTS the worktree the mode exists to prevent. `B` is re-assigned
because a separate fenced block is a separate shell.

```bash
B=chore/work-issues-retro-<lesson-slug>
git fetch origin && git switch -c "$B" origin/main
```

- `chore:` prefix — agent tooling, not `src/**`; `fix:` / `feat:` would make
  release-please describe a user-facing change that never happened. English
  only in every committed line, and in the PR title and body
  (`pr-content-checks.yml` / `issue-conventions.yml` check both in CI).
- A `work-issues`-only edit is still unit-suite INPUT, so run `/check` and
  `/check-docs`; with no `src/**` change there is no integ and no live test.
  `/review-pr` gives a skill-only PR the tier its size earns, no docs
  down-bias: a wrong rule here propagates into every future session.
- Merge with `/merge-pr <n>` **before the wrap report**: §9's closing check is
  "every worktree THIS run added is gone".

An IN-PLACE run added no worktree: it stops `/merge-pr` once the remote merge
is confirmed `state=MERGED`, BEFORE that skill's local-cleanup step (§9), and
this is where the PARENT runs §9's IN-PLACE cleanup arm — **the LAST step of
the whole run**, and the parent's even when §10 was dispatched to a subagent,
since two agents must not both be switching one tree:

```bash
git show-ref --verify --quiet refs/heads/<LAUNCH_BRANCH> || echo 'gone -> use the fallback'
[ -z "$(git status --porcelain)" ] && git switch --no-guess <LAUNCH_BRANCH> && git branch -D <every branch THIS run created> || echo 'STOPPED: dirty tree (commit first), or the switch failed'
```

Copy those two lines verbatim — the dirty-tree test first, then the CHAINED
switch — or a dirty tree carries work onto the outer tool's branch and `-D`
deletes the branch that was holding it. The retro branch is one of those
deleted, which is why §9 does not do this per-lane.

This is `Session-fit: now`: deferring leaves main self-inconsistent, the
evidence dies with the session, and the open PR is NOT CLOSEABLE. Report the
outcome in one wrap line — what changed, in which step, with the evidence.
