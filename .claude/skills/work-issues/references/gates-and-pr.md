<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 6. Gates + PR (per lane)

**Before the session's FIRST commit, prove the gates are ALIVE.** Registration is
not execution — on 2026-08-20 all seventeen PreToolUse gates here were
registered and INERT (go-to-k/cdk-real-drift#1801: an `if` holding `A or B`
matches nothing) — and the failure is silent in the worst direction, since an
ungated commit looks exactly like one that passed. `/hooks` lists what is
REGISTERED, so it cannot see this. One command can:

```bash
git commit --dry-run -m "gate liveness probe"   # from the repo root, on main
```

Run it as YOUR OWN Bash tool call: PreToolUse hooks gate the agent's tool calls
and nothing else, so the identical line typed by a human into a terminal
bypasses the hook system entirely and proves nothing. `--dry-run` commits
nothing whatever the tree looks like. Expected: `Blocked by branch-gate` (the
root is on `main`) or `Blocked by check-gate` (markers stale). Git's ordinary
output instead — `On branch main`, `nothing to commit` — means the gates are not
firing at all, and every gate step below is then self-enforced: run each check
by hand and say so in the report, because nothing else will.

From inside the worktree, run the full check that CI runs:

```bash
vp run verify        # = check (typecheck + lint + format) + test + test:hooks + build
```

`test:hooks` is in that alias because it is in what `/check` runs and therefore
in what the `check` marker attests to (go-to-k/cdk-local#630); it is a separate
task from `vp run test`, so an alias stopping short of it would report green on
a suite the gate does not mean.

All green, then run `/check` (and `/check-docs` if the diff touches docs) to refresh
the markers the check-gate demands, commit (conventional-commit prefix), push, and
open the PR with `Closes #<n>`. A `src/**` touch also needs a green `/run-integ`
before merge (the `integ` gate) — never defer the integ to a later PR.

## 7. If main advanced while you worked (parallel merges)

A peer agent merging its PRs moves `main` (+ a `chore(release)` bump). Your branch
is now behind and `git diff origin/main..<branch>` shows **phantom removals** of
the peer's added lines — that is the stale-base artifact, NOT real deletions.
Confirm the TRUE diff and rebase:

```bash
git diff --stat $(git merge-base origin/main <branch>)..<branch>   # the real change
git -C "<LANE_TREE>" rebase origin/main   # the path the launch-mode probe recorded
```

Re-run gates, `git push --force-with-lease`.

**A clean rebase — and a clean merge — is NOT evidence that §3's one-lane-per-file
rule held.** Git conflicts only where the two sides touched the same LINES, so two
lanes editing disjoint SECTIONS of one file both land intact and §3 fails
*silently* (measured 2026-08-19, go-to-k/cdk-real-drift#1775:
go-to-k/cdk-real-drift#1772 and go-to-k/cdk-real-drift#1773 both rewrote the
same SKILL.md and merged nine seconds apart, surviving by luck). When your PR
lands into a file another PR touched in the same window, the absent conflict
proves nothing — confirm it after the pull in §9.

The same silence covers a second shape: a peer PR that adds a **repo-wide check**
— a test globbing the tree (`git ls-files`, a `readdirSync` over a directory) or a
new lint rule — gains jurisdiction over CONTENT in files it never touched, so
file-disjointness says nothing and neither PR's CI exercised the pair (yours ran
before their check existed, theirs before your content did). `main` can go red on
a merge where both sides were green — measured twice: this repo's §9 CI corollary
(go-to-k/cdk-local#524 failing on a line go-to-k/cdk-local#520 merged in
parallel), and go-to-k/cdk-real-drift#1782's `git ls-files "*.md"` scanner
merging while go-to-k/cdk-real-drift#1783 added ~100 untouched markdown lines
(2026-08-19; running the scanner over the new prose cost one command). So when a
peer merges mid-lane, look at **what** it added, not only which files it
touched: rebase, then RUN any repo-wide check the peer introduced over your own
diff before merging. This repo is especially exposed — it already ships
repo-wide consistency tests (the four-copies harness
`.claude/hooks/pr-review-gate.test.sh`, the reference scanner
`tests/unit/skills/work-issues-skill-refs.test.ts`).
