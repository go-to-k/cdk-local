#!/usr/bin/env bash
# gh-pr-merge-worktree-gate.sh
#
# PreToolUse hook. Blocks a hand-run `gh pr merge` from inside a
# `.claude/worktrees/<branch>/` side worktree unless the `merge-pr`
# markgate marker is fresh — forcing every merge through the `/merge-pr`
# skill, which is the single chokepoint that:
#   - merges WITHOUT `--delete-branch` (so gh runs no local cleanup and
#     never trips the `'main' is already used by worktree` fatal), and
#   - then cleans the worktree + local branch + remote branch correctly
#     via `git -C <main>`.
#
# A hand-run `gh pr merge --squash --delete-branch` from a side worktree
# both trips that fatal AND leaves the worktree / local branch behind. By
# routing every worktree merge through `/merge-pr`, any future step added
# to the merge flow runs automatically — there's one path, not two.
#
# `/merge-pr` runs `markgate set merge-pr` (in its own step, BEFORE its
# `gh pr merge` call) so its own merge passes this gate; a hand-run merge
# that skipped the skill has no fresh marker and is blocked. The `merge-pr`
# gate carries a short TTL (see .markgate.yml) so a stale marker left by a
# crashed `/merge-pr` cannot authorize a later hand-run merge.
#
# Scope: ONLY side worktrees (`*/.claude/worktrees/*`). A merge from the
# main worktree does not hit the fatal and is left alone (fail-open).
#
# Cwd-aware: resolves the target git tree from the payload `cwd` + a
# preceding `cd <path>` segments + the last `gh -C <path>` (same resolution as
# integ-gate.sh) before consulting markgate, so the per-worktree marker
# state dir is read correctly.

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


input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored.
gate_matches "$cmd" "$GATE_RE_GH_PR_MERGE" || exit 0

# Where the gated command will actually run: a `-C <path>` inside the MATCHED
# segment wins, else the last `cd <path>` segment before it, else the hook
# payload's cwd (see gate_target_dir in _command-match.sh).
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GH_PR_MERGE")

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Resolve the absolute working-tree root. Only side worktrees under
# `.claude/worktrees/` are gated — the main worktree never hits the fatal.
toplevel=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
case "$toplevel" in
  */.claude/worktrees/*) ;;            # side worktree — gate it
  *) exit 0 ;;                          # main worktree / unknown — fail-open
esac

cd "$target_dir" 2>/dev/null || exit 0

if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  # markgate missing — fail-open (consistent with the other gates'
  # missing-tool handling; this gate is a convenience guardrail, not a
  # hard dependency).
  exit 0
fi

if "${markgate[@]}" verify merge-pr >/dev/null 2>&1; then
  exit 0
fi

cat >&2 <<'EOF'
Blocked by gh-pr-merge-worktree-gate: do not run `gh pr merge` by hand from a
side worktree — it trips the `'main' is already used by worktree` fatal (with
`--delete-branch`) and/or leaves the worktree + local branch uncleaned.

Required action:
  /merge-pr <N>

The `/merge-pr` skill is the single merge chokepoint: it squash-merges WITHOUT
`--delete-branch` (no fatal), cleans the worktree + local branch + remote
branch, and sets the `merge-pr` marker that authorizes its own `gh pr merge`.
A hand-run merge has no fresh marker, so it is blocked here.

This is intentionally the ONLY sanctioned way to merge from a worktree — never
call `markgate set merge-pr` directly to bypass it.
EOF
exit 2
