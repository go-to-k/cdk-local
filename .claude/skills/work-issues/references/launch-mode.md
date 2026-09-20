<!-- Part of the /work-issues skill (before stage 0). A bare §N points into the stage file holding that section; the map is SKILL.md's "Stages" table. READ THIS FILE IN FULL before stage 0. -->

## Launch mode — the PARENT runs this BEFORE stage 0

This is the ONLY copy of the probe.

```bash
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] \
  || { echo 'PROBE FAILED: not inside a git work tree -- do not guess the mode'; exit 1; }
COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
GITDIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)
LANE_TREE=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
MAIN_CHECKOUT=$(dirname "$COMMON")
LAUNCH_BRANCH=$(git branch --show-current)   # empty when launched detached
[ "$GITDIR" = "$COMMON" ] && MODE=MAIN-CHECKOUT || MODE=IN-PLACE
printf 'MODE=%s\nLANE_TREE=%s\nMAIN_CHECKOUT=%s\nLAUNCH_BRANCH=%s\n' \
  "$MODE" "$LANE_TREE" "$MAIN_CHECKOUT" "$LAUNCH_BRANCH"
```

Run it in the PARENT, before stage 0; state all four values in the opening
report and pass them into the triage dispatch and every lane dispatch. Later,
or inside the triage subagent, is too late: §2's collision map needs
`<MAIN_CHECKOUT>/.claude/worktrees/<w>` and, given a relative path from a lane
tree, returns NOTHING — read as "no competing agents", failing QUIETLY — and
the parent is the party that later runs `git worktree add` or does not.

### Reading the four values

- **`MAIN_CHECKOUT`** — the parent of the ONE shared git dir. Never `pwd` or
  `--show-toplevel`: both answer "the tree I am standing in", exactly wrong in
  the mode that needs the value.
- **`LANE_TREE`** — "the tree this run stands in", NOT "the lane worktree".
  MAIN-CHECKOUT records the main checkout under it; IN-PLACE they differ, and
  that difference is the point.
- **`LAUNCH_BRANCH`** — the branch the tree was handed to this run ON, read **at
  probe time**; IN-PLACE that is the branch the OUTER TOOL created. EMPTY is
  legitimate, not a failure — the run was launched detached, and §9 keeps a
  detach fallback for it. UNRECOVERABLE if not recorded now: §5 switches the
  tree onto the lane's own branch, after which `git branch --show-current`
  answers with the LANE's branch.

**IN-PLACE, `LAUNCH_BRANCH` is a branch to PUT BACK, never one to commit to.**
§5 branches in place off `origin/main` instead, because the merge deletes the
REMOTE branch the PR was opened from (§9) — a lane working directly on the
outer tool's branch would delete it on the way out. The lane owns its own
branch and deletes only that one.

A blank value is worse than a failure — `git -C ""` silently re-targets the
cwd's repo — so the probe stops on its first line. Do not weaken that guard or
the `pwd -P` calls.

### The values are RECORDED, never re-derived

The opening report is their ONLY recorded copy. Every later stage runs in a
fresh shell whose cwd may have silently reset to the main checkout (appendix,
the `cd <lane tree> &&` rule), so re-deriving `LANE_TREE` from
`git rev-parse --show-toplevel` or `pwd` — and equally a `grep` / `cat` on a
RELATIVE path, or a bare `git branch --show-current` / `git diff` — answers
about the main checkout in exactly the case the value exists to guard. Read
every file this run owns under the recorded absolute `<LANE_TREE>`, and treat
an answer CONTRADICTING the recorded values as a cwd fault, not a finding
(go-to-k/cdkd#2514). This repo keeps no worktree-owner sentinel, so those
values, §5's ownership probes and the §4 claims are the WHOLE ownership record.

**`<LANE_TREE>` and `<MAIN_CHECKOUT>` in a later stage are SUBSTITUTION
PLACEHOLDERS, not shell variables.** Paste the absolute path from the report
into the command text; never `git -C "$LANE_TREE"`, since every later block is
its own shell where the variable is already empty — and an empty `-C`
re-targets rather than failing. An unsubstituted placeholder is visible in the
command; an empty variable is not visible anywhere.

### What IN-PLACE changes, and where each consequence fires

IN-PLACE = launched inside a worktree someone else created (an Orca/ADE
workspace, a stray `cd`): exactly ONE working tree.

| # | Consequence | Where |
|---|---|---|
| 1 | Lanes run SERIALLY — a concurrent second lane needs a worktree NESTED inside this one, which dies with the outer workspace and takes its uncommitted work (go-to-k/cdk-local#635). Several issues per run is still fine in sequence: claim all up front, later ones QUEUED, stand down any the run will not reach | §3 |
| 2 | §2's worktree probes take `<MAIN_CHECKOUT>/.claude/worktrees/<w>`, not a relative path | §2 |
| 3 | The claim names the tree already checked out here plus the branch §5 WILL create in it — never `LAUNCH_BRANCH`, the outer tool's | §4 |
| 4 | Create no worktree; after confirming the tree is YOURS, branch IN PLACE off `origin/main` — ALWAYS — and never commit onto `LAUNCH_BRANCH`. §5 holds the recipe | §5 |
| 5 | `/merge-pr` stops once the merge is CONFIRMED: its local-cleanup step (`git worktree remove` + `git branch -D`) must not run — a lane removing the tree it runs in deletes its own cwd. The TREE belongs to whoever created it | §9, §10-d |
| 6 | Switch back to `LAUNCH_BRANCH` **as-is** — no pull, no rebase, no fast-forward — deleting only the branches THIS run created; detach only when `LAUNCH_BRANCH` was empty at probe time or is now gone | §9 |
| 7 | `main` is checked out in the main checkout, so `git checkout main` cannot run here — pull through `git -C "<MAIN_CHECKOUT>"` | §9 |
| 8 | The retro branch is created in THIS tree too, so the `LAUNCH_BRANCH` restore is the run's LAST step — after the retro PR merges, not in §9's per-lane cleanup | §10-d |
| 9 | The markgate store is per-WORKTREE and this mode has ONE, so a lane INHERITS the previous lane's `integ` marker. An rc=0 at a lane's FIRST command is inherited, not earned — run `/run-integ` for THIS lane whatever it reports | §8 |
