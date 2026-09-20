---
name: merge-pr
description: Squash-merge a PR and fully clean up the feature worktree + local branch, without tripping the side-worktree `'main' is already used by worktree` fatal.
argument-hint: "<pr-number>"
---

# Merge PR + worktree cleanup

Squash-merge a PR and clean up the feature worktree, local branch, and remote
branch in one pass, from INSIDE the feature worktree.

`gh pr merge <N> --squash --delete-branch` from a side worktree fails its LOCAL
cleanup step with `fatal: 'main' is already used by worktree at '<main>'` — the
remote merge already landed, but gh's post-step tries to switch the side
worktree onto `main`, which the main worktree has checked out. So: merge WITHOUT
`--delete-branch`, then clean up local artifacts by hand. The remote branch is
auto-deleted by the repo's `delete_branch_on_merge: true`.

Merge from inside the repo, never from `/tmp` with `--repo` — a cwd outside the
repo makes the cwd-aware merge-time checks fail open.

## Preconditions

- The PR is ready to merge (CI green, `integ` marker fresh). This skill is the
  merge + cleanup mechanic and re-runs no verification.
- You are in the PR's feature worktree (typically `.claude/worktrees/<branch>/`).

## Steps

1. **Resolve paths and branch** (from inside the feature worktree):

   ```bash
   PR=<pr-number>
   WT=$(git rev-parse --show-toplevel)                                  # this feature worktree
   BR=$(git branch --show-current)
   MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")  # main worktree
   echo "PR=$PR  branch=$BR  worktree=$WT  main=$MAIN"
   ```

   `WT` should be under `.claude/worktrees/` and `MAIN` should be the repo root.
   If `WT` == `MAIN`, skip the worktree-remove in step 4 but still delete the
   local branch. A linked `WT` NOT under `.claude/worktrees/` is ALWAYS an
   IN-PLACE caller (this skill never creates a worktree there) — read step 4's
   stop rule first. The converse does NOT hold: a `WT` UNDER `.claude/worktrees/`
   may be IN-PLACE too, and `$WT` cannot tell that apart from one this flow
   created. Only the CALLER knows.

2. **Merge, WITHOUT `--delete-branch`** (run in the worktree):

   ```bash
   gh pr merge "$PR" --squash
   ```

3. **Confirm the remote merge landed** before touching anything local:

   ```bash
   gh pr view "$PR" --json state,mergedAt -q '"state=\(.state) mergedAt=\(.mergedAt)"'
   ```

   Expect `state=MERGED`. If it is not MERGED, STOP — do not delete the worktree
   (the branch is your only copy of un-merged work).

4. **Clean up local artifacts** from the main worktree (a worktree cannot remove
   itself while you are cd'd into it).

   **STOP HERE when the caller was launched IN-PLACE** — inside a worktree an
   outer tool (an Orca/ADE workspace) created, rather than one it added itself.
   The `WT == MAIN` guard does NOT cover that case: IN-PLACE, `WT` is a linked
   worktree and differs from `MAIN`, so both lines run and REMOVE THE OUTER
   TOOL'S TREE together with any uncommitted work in it. The caller knows which
   case applies (`/work-issues` `references/launch-mode.md` holds the probe) and
   tells you. Such a caller does its own branch cleanup — switch back to the
   branch the tree arrived on, delete only the branches it made — and leaves the
   tree standing. Do step 5, then report.

   ```bash
   git -C "$MAIN" worktree remove "$WT" --force   # skip if WT == MAIN
   git -C "$MAIN" branch -D "$BR"
   git -C "$MAIN" worktree prune
   ```

5. **Confirm the remote branch is gone**. Only if it somehow survived, delete it
   via the API — NOT `git push origin --delete`, which
   `post-merge-orphan-push-gate.sh` may flag:

   ```bash
   git -C "$MAIN" ls-remote --exit-code --heads origin "$BR" >/dev/null 2>&1 \
     && gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/$BR" \
     || echo "remote branch already deleted"
   ```

6. **Report**: PR `#<N>` merged (squash), worktree removed, local + remote branch
   deleted.
