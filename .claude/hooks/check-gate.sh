#!/usr/bin/env bash
# check-gate.sh
#
# PreToolUse hook. Blocks `git commit` unless both the `check` and
# `docs` markgate markers are fresh for the current content state.
# Each gate is scoped (see .markgate.yml) so edits to tests-only
# invalidate only `check`, and edits to docs-only invalidate only
# `docs`. Error messages identify which gate needs re-running.
#
# WHY cwd-aware resolution: this repo is regularly worked in via
# `git worktree`, and markgate stores marker state per-worktree at
# `<git rev-parse --absolute-git-dir>/markgate/`. We resolve the
# target working tree from the PreToolUse payload's `cwd` field +
# `cd <path>` segments + the matched segment's `git -C <path>` flag
# (all via the shared `gate_target_dir`), so the markgate verify runs
# against the worktree the commit will actually land in.

set -u

# Shared, segment-aware command matching (go-to-k/cdk-local#541). Sourcing it
# gives this gate `gate_matches`, `gate_target_dir`, and the GATE_RE_* verb
# regexes every gate now spells the same way.
# Fail OPEN if the shared matcher is missing: a hook that cannot decide must not
# break every Bash call with a `command not found` (go-to-k/cdk-local#542 review).
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
[ -r "$_gate_lib" ] || exit 0
. "$_gate_lib"

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it. Reading via two separate jq invocations would
# consume stdin twice and the second read would see nothing.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `git commit`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored.
gate_matches "$cmd" "$GATE_RE_GIT_COMMIT" || exit 0

# Where the gated command will actually run: a `-C <path>` inside the MATCHED
# segment wins, else the last `cd <path>` segment before it, else the hook
# payload's cwd (see gate_target_dir in _command-match.sh).
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GIT_COMMIT")

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see.
# Repo opt-in scope, mirroring branch-gate (go-to-k/cdkd#1259): this gate belongs
# to repos that follow the markgate convention. A session rooted in one of them
# still runs git against OTHER repos — a dotfiles checkout, a scratch clone —
# where committing to main is normal and no marker exists to be fresh. Without
# this the gate blocked those commits with a message naming skills that repo does
# not have (hit on 2026-08-20 from a sibling-repo session).
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$target_top" ] || [ ! -f "$target_top/.markgate.yml" ]; then
  exit 0
fi

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# Prefer the `mise`-managed version via `mise exec --` so the repo's
# canonical markgate wins over an older PATH binary (e.g. Homebrew).
# Falls back to PATH `markgate` for users without mise.
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by check-gate: markgate is not installed. Run 'mise install' at the repo root." >&2
  exit 2
fi

"${markgate[@]}" verify check >/dev/null 2>&1
check_status=$?

"${markgate[@]}" verify docs >/dev/null 2>&1
docs_status=$?

if [ "$check_status" -eq 0 ] && [ "$docs_status" -eq 0 ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status <gate>` so the
# error message tells the user *why* the gate is stale (digest differs vs
# expired by ttl vs child gate stale) instead of just naming the skill.
# Fails open: empty string when extraction fails (markgate too old, no
# parenthetical, or status itself errored), and the message falls back to
# the pre-0.3 generic hint text.
gate_reason() {
  "${markgate[@]}" status "$1" 2>/dev/null \
    | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }'
}

msg="Blocked by check-gate:"
if [ "$check_status" -ne 0 ]; then
  reason=$(gate_reason check)
  if [ -n "$reason" ]; then
    msg="$msg run /check first $reason;"
  else
    msg="$msg run /check first (or re-run if src/tests/config changed);"
  fi
fi
if [ "$docs_status" -ne 0 ]; then
  reason=$(gate_reason docs)
  if [ -n "$reason" ]; then
    msg="$msg run /check-docs first $reason;"
  else
    msg="$msg run /check-docs first (or re-run if src/docs/README/CLAUDE.md changed);"
  fi
fi
msg="$msg then retry the commit."
echo "$msg" >&2
exit 2
