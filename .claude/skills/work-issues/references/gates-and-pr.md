<!-- Part of the /work-issues skill (§6–§7). A bare §N points into the stage file holding that section; the map is SKILL.md's "Stages" table. READ THIS FILE IN FULL when your run enters this stage. -->

## 6. Checks + PR (per lane)

From inside the lane tree, run what CI runs:

```bash
vp run verify        # = check (typecheck + lint + format) + test + test:hooks + build
```

`test:hooks` is a separate task from `vp run test`; stopping short of it
reports green on a suite it does not cover.

All green, then run `/check` (and `/check-docs` if the diff touches docs) —
**recommended, nothing enforces them**. Commit (conventional-commit prefix),
push, open the PR with `Closes #<n>`.

The MECHANICAL merge conditions are two: CI green (the `ci-ok` required status
check) and a fresh `integ` marker, set by `/run-integ` and enforced by
`integ-gate.sh` at `gh pr merge` / `git merge`. So a `src/**` touch needs a
green `/run-integ` in the SAME PR — never defer the integ to a later one.

## 7. If main advanced while you worked (parallel merges)

A peer merging its PRs moves `main`. Your branch is then behind and
`git diff origin/main..<branch>` shows **phantom removals** of the peer's added
lines — a stale-base artifact, NOT real deletions. Confirm the TRUE diff and
rebase:

```bash
git diff --stat $(git merge-base origin/main <branch>)..<branch>   # the real change
git -C "<LANE_TREE>" rebase origin/main   # the path the launch-mode probe recorded
```

Re-check, `git push --force-with-lease`.

**A clean rebase — and a clean merge — is NOT evidence that §3's
one-lane-per-file rule held.** Git conflicts only where both sides touched the
same LINES, so two lanes editing disjoint SECTIONS of one file both land intact
and §3 fails *silently* (go-to-k/cdk-real-drift#1775). Confirm after §9's pull.

Second shape: a peer PR adding a **repo-wide check** — a test globbing the tree
(`git ls-files`, a `readdirSync`) or a new lint rule — gains jurisdiction over
CONTENT in files it never touched, so file-disjointness says nothing and
neither PR's CI exercised the pair; `main` can go red where both sides were
green. So look at **what** a mid-lane merge added, not only which files it
touched: rebase, then RUN any repo-wide check it introduced over your own diff
(`tests/unit/no-control-bytes.test.ts` is one this repo ships).
