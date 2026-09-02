#!/usr/bin/env bash
# branch-gate.sh
#
# PreToolUse hook. Blocks `git commit` and `git push` when the working
# tree the command will actually act on is on `main` / `master`. All
# changes to this repo must land via PR from a feature branch — direct
# commits/pushes to main are not allowed.
#
# WHY the cwd-aware resolution matters: this repo is regularly worked
# in via `git worktree`. A naive implementation that derived the repo
# root from `BASH_SOURCE` (the hook script's location) would check the
# worktree's branch (a feature branch) and allow the commit, even when
# the user's actual command did `cd /path/to/parent && git commit` and
# the commit landed on the parent worktree's `main`.
#
# Resolution order for "where will the git command actually run":
#   1. Explicit `git -C <path> commit/push` in the matched segment —
#      last `-C` wins.
#   2. The last `cd <path>` segment BEFORE the matched one.
#   3. The hook input's `cwd` field (the Bash tool's persisted cwd).
#   4. The hook process's own $PWD (fallback, almost never reached).

set -u

# Shared, segment-aware command matching (go-to-k/cdk-local#541). Sourcing it
# gives this gate `gate_matches`, `gate_target_dir`, and the GATE_RE_* verb
# regexes every gate now spells the same way.
# Fail CLOSED if the shared matcher is missing or does not load: a gate that
# cannot decide must not wave the command through. `[ -r … ] || exit 0` was the
# first shape here, and it silently disabled the gate whenever the library was
# unreadable or truncated — with the sibling gates' own comments claiming the
# opposite (go-to-k/cdkd#2130 review). The `declare -F` check catches a partial
# source, where `.` succeeds but the function is missing.
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
if ! declare -F gate_matches >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_matches is undefined (truncated file?)." >&2
  exit 2
fi


# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it. Reading via two separate jq invocations would
# consume stdin twice and the second read would see nothing.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `git commit` / `git push`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored. `gate_re` keeps whichever verb matched so the target-dir
# resolution below reads the right segment.
gate_re=""
for gate_candidate in "$GATE_RE_GIT_COMMIT" "$GATE_RE_GIT_PUSH"; do
  if gate_matches "$cmd" "$gate_candidate"; then
    gate_re="$gate_candidate"
    break
  fi
done
[ -n "$gate_re" ] || exit 0

# Where the gated command will actually run: a `-C <path>` inside the MATCHED
# segment wins, else the last `cd <path>` segment before it, else the hook
# payload's cwd (see gate_target_dir in _command-match.sh).
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$gate_re")

# Repo opt-in scope (cdkd#1259): this gate protects repos that follow
# the feature-branch + PR + markgate convention. A session rooted in
# such a repo can still run git against OTHER repos (a personal blog, a
# scratch clone) where committing straight to main is the normal
# workflow; the gate must not fire there. Opt-in signal: a
# `.markgate.yml` at the resolved target repo's top level. Repos
# without it pass through untouched.
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$target_top" || ! -f "$target_top/.markgate.yml" ]]; then
  exit 0
fi

# Read the branch from the resolved target dir. `-C` lets git operate on a
# directory that isn't our cwd. An EMPTY answer is not one condition -- see the
# `if [ -z "$branch" ]` arm below, which is where that used to be got wrong.
branch=$(git -C "$target_dir" symbolic-ref --short HEAD 2>/dev/null || echo "")

# The MAIN-vs-LINKED distinction, in the shape `main-tree-branch-gate.sh`
# already uses: the main checkout is whatever `git worktree list --porcelain`
# lists FIRST. Reused rather than re-invented, per go-to-k/cdkd#2402 -- but two
# parts of that shape are deliberately NOT copied here, because each was
# measured to buy nothing at this call site:
#
#   NO MEMO. That gate asks the question once per matched SEGMENT and caches the
#   last answer in a pair of globals. This gate asks at most once per command,
#   so a memo would cache nothing.
#
#   NO `canonicalize`. That gate compares its RAW `<dir>` argument -- a payload
#   cwd, which may still carry a symlink -- against the porcelain path, so it
#   must resolve both. This gate compares `$target_top`, which git has ALREADY
#   resolved. Probed against git 2.x on macOS, where `/var` is a symlink to
#   `/private/var`, with `<dir>` also reached through a symlinked parent and
#   through a subdir under one -- `rev-parse --show-toplevel` returned the fully
#   resolved real path in all four shapes, byte-identical to `worktree list
#   --porcelain`'s first entry. A local `canonicalize` copy was written here
#   first and NO mutation could kill it, which is what sent the question to a
#   probe. If a future git ever stopped resolving `--show-toplevel`, this
#   compare would fail OPEN and the five BLOCK cases in `branch-gate.test.sh`
#   are what go red.
if [ -z "$branch" ]; then
  # `symbolic-ref --short HEAD` prints NOTHING in two situations that are not
  # the same thing, and the comment that used to stand here asserted only the
  # harmless one ("if the dir doesn't exist or isn't inside a git repo ... we
  # can't gate what we can't see"):
  #
  #   (a) there is no repo to read       -> genuinely invisible; pass through.
  #   (b) a real repo with a DETACHED HEAD -> the tree has LEFT `main`, which is
  #       exactly the state this gate exists to catch, wearing a spelling it
  #       could not see because it recognised the state only by branch NAME.
  #
  # (b) is reachable from the documented flow. `main-tree-branch-gate.sh`
  # deliberately passes `git checkout <sha>` in the main checkout (its own
  # `--detach` note carries the measurement, and keeps the verdict); the tree
  # detaches, and this gate then waved a commit straight into the SHARED main
  # checkout. Measured on a scratch opted-in repo before this arm existed,
  # driving this hook with a `git commit -m x` payload: rc=2 on `main`, rc=0
  # once detached. Two gates, a hole neither has alone (go-to-k/cdkd#2402).
  #
  # THE DISCRIMINATOR IS ALREADY IN HAND. `$target_top` is `rev-parse
  # --show-toplevel` from this same dir, and it is non-empty here because the
  # opt-in check above returned early otherwise. A non-empty toplevel IS a real
  # repo with a work tree, so an empty branch beside it can only mean a detached
  # HEAD; a second `rev-parse --git-dir` probe would fork again to re-learn what
  # `$target_top` already said.
  #
  # IT COMPARES TOPLEVELS, NOT THE RAW DIR, and that single choice removes TWO
  # independent failures. `main_tree_of` in the sibling gate compares its
  # `<dir>` argument, which is the payload cwd, so (i) a cwd one level down
  # (`cd <repo>/src && ...`) is not equal to the checkout root, and (ii) the cwd
  # still carries whatever symlink the caller typed, while the porcelain path
  # does not. `$target_top` has neither problem: git resolves both out of
  # `--show-toplevel`. Measured -- swapping this compare to `$target_dir` turns
  # ALL FIVE block rows in `branch-gate.test.sh` red, the subdir row for reason
  # (i) and the other four for reason (ii), since a macOS `mktemp -d` hands out
  # a `/var` path that git reports as `/private/var`.
  #
  # BLOCKED ONLY IN THE MAIN CHECKOUT. A detached HEAD in a LINKED worktree is
  # the remedy this repo's own Stop hook prints -- `stop-unmerged-lane-warn.sh`
  # tells a session that must not remove its worktree to run
  # `git switch --detach origin/main`, "because a worktree with no current
  # branch is not a lane". Blocking that would refuse a documented instruction.
  #
  # `substr($0, 10)` rather than `$2`, for the reason the sibling gate records:
  # awk splits on whitespace, so a checkout path containing a SPACE is truncated
  # at it and the compare below then never matches -- the gate standing down
  # over a main checkout it had mis-read. Fenced by the spaced-path case in
  # `branch-gate.test.sh`.
  main_checkout=$(git -C "$target_dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')
  if [ "$target_top" = "$main_checkout" ]; then
    echo "Blocked by branch-gate: target git working tree has a DETACHED HEAD in the MAIN checkout." >&2
    echo "  resolved target dir: $target_dir" >&2
    echo "  main checkout      : $main_checkout" >&2
    echo "  HEAD               : $(git -C "$target_dir" rev-parse --short HEAD 2>/dev/null || echo '?')" >&2
    echo "  command: $cmd" >&2
    echo "A detached HEAD is not a feature branch, and this is the SHARED main checkout," >&2
    echo "so a commit here puts off-branch work in the tree every other lane reads." >&2
    echo "Re-attach first: git -C \"$main_checkout\" switch main" >&2
    echo "Then do the work in its own worktree: git worktree add <path> -b fix/xxx origin/main" >&2
    echo "A detached HEAD in a LINKED worktree is NOT blocked -- that is the documented" >&2
    echo "way to clear a lane." >&2
    exit 2
  fi
  # FAIL-OPEN, deliberate and stated. Three readings reach this line, and the
  # compare above sends all three here without needing a guard of their own,
  # since `$target_top` is non-empty and so can equal none of the empty answers:
  #   - `git worktree list` gave nothing (not a repo we can read) -- we do not
  #     gate what we cannot see;
  #   - the awk found no `worktree ` line at all -- same reading;
  #   - the detached tree is a LINKED worktree, the sanctioned lane-clearing
  #     state named above.
  exit 0
fi

case "$branch" in
  main|master)
    echo "Blocked by branch-gate: target git working tree is on branch '$branch'." >&2
    echo "  resolved target dir: $target_dir" >&2
    echo "  command: $cmd" >&2
    echo "Create a feature branch and open a PR instead (e.g. 'git -C \"$target_dir\" switch -c fix/xxx')." >&2
    echo "Direct commits/pushes to main are not allowed in this repo." >&2
    exit 2
    ;;
esac

exit 0
