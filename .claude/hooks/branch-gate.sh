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

# Read the branch from the resolved target dir. `-C` lets git operate
# on a directory that isn't our cwd; if the dir doesn't exist or isn't
# inside a git repo, symbolic-ref returns empty and we fall through to
# the safe `exit 0` below (we can't gate what we can't see).
branch=$(git -C "$target_dir" symbolic-ref --short HEAD 2>/dev/null || echo "")

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
