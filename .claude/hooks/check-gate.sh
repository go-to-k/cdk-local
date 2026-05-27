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
# leading `cd <path>` + last `git -C <path>` flag, exactly mirroring
# branch-gate.sh, so the markgate verify runs against the worktree the
# commit will actually land in.

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it. Reading via two separate jq invocations would
# consume stdin twice and the second read would see nothing.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit -- any other command passes through. The
# matcher tolerates `git -C <path> commit` / `git -c <key>=<val> commit`
# / `git --no-pager commit` / etc. by allowing zero or more flag tokens
# between `git` and the `commit` subcommand. Line-start anchored so
# `git commit` substrings inside quoted argument bodies
# (`gh issue create --body "we should run git commit later"`) do
# NOT false-positive into a hard block. The optional leading
# `cd <path> &&` prefix preserves the worktree-aware
# `cd <side> && git commit` chain shape. Trailing class
# `([[:space:]]|$|[|;&\`)])` ensures `commit` appears in the GIT
# SUBCOMMAND POSITION — not as the prefix of `commit-tree` /
# `commit-graph`.
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?git([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*[[:space:]]+commit([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Resolve where the git command will actually run (cwd-aware; mirrors
# branch-gate.sh — keep these in sync if either gains new resolution
# shapes).
target_dir="${hook_cwd:-$PWD}"

# `cd <path>` at the start of the command shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# `git -C <path>` beats any earlier cd; pick the LAST occurrence.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
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

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see (mirrors branch-gate.sh).
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
