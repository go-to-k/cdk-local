---
name: merge-pr
description: Squash-merge a PR and fully clean up the feature worktree + local branch, without tripping the side-worktree `'main' is already used by worktree` fatal and without bypassing the merge-time gates.
argument-hint: "<pr-number>"
---

# Merge PR + worktree cleanup

Squash-merge a PR and clean up the feature worktree, local branch, and remote
branch in one pass — from INSIDE the feature worktree, which is where work
naturally lives in this repo.

## Why this exists

`gh pr merge <N> --squash --delete-branch` run from a side worktree fails its
LOCAL cleanup step with:

```
failed to run git: fatal: 'main' is already used by worktree at '<main>'
```

The REMOTE merge already succeeded by then — only gh's `--delete-branch` local
post-step fails, because it tries to switch the side worktree onto `main`, which
the main worktree already has checked out (git forbids the same branch in two
worktrees).

The two tempting "fixes" are both wrong:

- Running `gh pr merge` from `/tmp` with `--repo` avoids the fatal, but the cwd
  is outside the repo so the cwd-aware merge-time gates (`verify-pr-gate.sh`,
  `pr-review-gate.sh`, `integ-gate.sh`, `closes-paren-form-gate.sh`) fail open
  and are SILENTLY BYPASSED. Never do this.
- Removing the worktree first, then merging from the main worktree, works but
  discards the worktree before the merge is confirmed.

This skill does it correctly: merge from inside the worktree (gates fire),
WITHOUT `--delete-branch` (so gh runs no local cleanup → no fatal), then clean
up local artifacts by hand. The remote branch is auto-deleted by the repo's
`delete_branch_on_merge: true` setting.

## Preconditions

- `/verify-pr` has already passed for this PR (its marker gates `gh pr merge`).
  This skill does NOT re-run verification — it is the merge + cleanup mechanic.
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

   Sanity-check: `WT` should be under `.claude/worktrees/`, and `MAIN` should be
   the repo root. If `WT` == `MAIN` you are already in the main worktree — skip
   the worktree-remove in step 4 (there is nothing to detach) but still delete
   the local branch.

2. **Authorize this merge through the worktree-merge gate** — in its OWN Bash
   call, BEFORE the merge call:

   ```bash
   mise exec -- markgate set merge-pr
   ```

   `gh-pr-merge-worktree-gate.sh` blocks a hand-run `gh pr merge` from a side
   worktree unless this marker is fresh — that is what forces every worktree
   merge through THIS skill. It MUST be a separate Bash invocation from the
   merge in step 3: a PreToolUse hook evaluates the whole command string before
   any line runs, so chaining `markgate set merge-pr && gh pr merge` would still
   see a stale marker and block. (The `merge-pr` gate has a 30m TTL so this
   authorization does not linger.) This is the ONLY place `markgate set
   merge-pr` is ever called — never run it by hand to merge outside this skill.

3. **Merge, WITHOUT `--delete-branch`** (run in the worktree so the merge-time
   gates fire):

   ```bash
   gh pr merge "$PR" --squash
   ```

   Omitting `--delete-branch` is the whole trick: gh does no local
   switch/delete, so the `'main' is already used` fatal cannot happen. (If the
   gates block this — stale `verify-pr` / `pr-review` / `integ` marker — stop and
   run the named skill; do NOT work around the block.)

4. **Confirm the remote merge landed** before touching anything local:

   ```bash
   gh pr view "$PR" --json state,mergedAt -q '"state=\(.state) mergedAt=\(.mergedAt)"'
   ```

   Expect `state=MERGED`. If it is not MERGED, STOP — do not delete the worktree
   (the branch is your only copy of un-merged work).

5. **Clean up local artifacts** from the main worktree (a worktree cannot remove
   itself while you are cd'd into it):

   ```bash
   git -C "$MAIN" worktree remove "$WT" --force   # skip if WT == MAIN
   git -C "$MAIN" branch -D "$BR"
   git -C "$MAIN" worktree prune
   ```

   `branch -D` succeeds because the branch is no longer checked out in any
   worktree once the worktree is removed.

6. **Confirm the remote branch is gone** (the repo's `delete_branch_on_merge`
   auto-deletes it on merge). Only if it somehow survived, delete it via the API
   — NOT `git push origin --delete`, which `post-merge-orphan-push-gate.sh` may
   flag:

   ```bash
   git -C "$MAIN" ls-remote --exit-code --heads origin "$BR" >/dev/null 2>&1 \
     && gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/$BR" \
     || echo "remote branch already deleted"
   ```

7. **Report**: PR `#<N>` merged (squash), worktree removed, local + remote branch
   deleted, `git worktree list` no longer shows the feature worktree.

## Notes

- The `cd` into the main worktree happens only via `git -C "$MAIN"` in step 5 —
  the working directory of the merge command in step 3 stays inside the feature
  worktree so the gates resolve the correct per-worktree markgate state dir.
- This skill sets exactly ONE markgate marker: `merge-pr` (step 2), which
  authorizes its own `gh pr merge` past `gh-pr-merge-worktree-gate.sh`. It does
  NOT set / re-run the `verify-pr` / `pr-review` / `integ` gates — those must
  already be satisfied; this skill is the merge + cleanup mechanic.
