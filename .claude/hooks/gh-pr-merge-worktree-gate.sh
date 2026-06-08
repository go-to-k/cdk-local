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
# leading `cd <path>` + the last `gh -C <path>` (same resolution as
# integ-gate.sh) before consulting markgate, so the per-worktree marker
# state dir is read correctly.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` (incl. `gh -C <path> pr merge`, `cd <path> && gh
# pr merge`, and `--auto`). Line-start anchored so a `gh pr merge` substring
# inside a quoted argument body does NOT false-positive.
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

target_dir="${hook_cwd:-$PWD}"

if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

if [[ "$cmd" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  if [[ "$c_target" != /* ]]; then
    c_target="$target_dir/$c_target"
  fi
  target_dir="$c_target"
fi

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
