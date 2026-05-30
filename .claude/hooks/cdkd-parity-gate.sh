#!/usr/bin/env bash
# cdkd-parity-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` (and the
# `cd <path> && gh pr create` / `gh -C <path> pr create` worktree forms)
# when ALL of the following hold:
#   1. The PR's diff vs origin/main touches the cdkd-parity gate's scope:
#      - any change under `src/cli/commands/**`, `src/internal.ts`, or
#        `src/index.ts` (the library-surface scope), OR
#      - a NEW `.ts` file added under `src/local/**`
#        (`--diff-filter=A`). Edits to existing `src/local/**` files
#        are intentionally NOT in scope, since most touches there are
#        internal refactors that don't change host-CLI surface — but a
#        brand-new file is the strongest signal that a host-facing
#        helper may need to be exported from `src/internal.ts`.
#   2. The `cdkd-parity` markgate marker is stale (digest differs / never set).
#
# When either condition is false (out-of-scope diff, or marker fresh), the
# hook exits 0 and the `gh pr create` proceeds.
#
# Pre-create-only. The skill records a judgment, not a behavior assertion,
# so re-checking at pre-merge time is redundant — `/verify-pr` surfaces the
# marker stamp implicitly via its checklist.
#
# WHY cwd-aware: cdk-local is regularly worked in via `git worktree`, and
# markgate stores marker state per-worktree at
# `<git rev-parse --absolute-git-dir>/markgate/`. We resolve the target
# working tree from the PreToolUse payload's `cwd` field plus leading
# `cd <path>` and the last `gh -C <path>` flag, exactly mirroring
# check-gate.sh / integ-gate.sh.
#
# Fail-open behavior:
#   - `gh` missing OR `markgate` missing -> exit 0 silently. The hook is
#     a safety net, not a hard dependency.
#   - `git` missing or no `origin/main` ref -> exit 0 silently. We cannot
#     compute the diff scope, so we cannot fairly block.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr create`. `gh pr merge` is intentionally NOT gated — the
# parity question is a pre-create judgment; once the marker has been set,
# subsequent re-merges shouldn't re-block on a stale marker for a small
# follow-up. Line-start anchored so `gh pr create` substrings inside quoted
# argument bodies do NOT false-positive.
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+create([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

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

# `gh -C <path>` beats any earlier cd; pick the LAST occurrence.
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

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see.
if ! command -v git >/dev/null 2>&1; then
  exit 0
fi
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# Fail-open if `gh` is unavailable. The gh tool is required as a hook
# trigger (we only fire on `gh pr create`), but a missing binary at this
# point still means we can't assert correctness, so pass through.
if ! command -v gh >/dev/null 2>&1; then
  exit 0
fi

# Fail-open if origin/main is not resolvable (fresh clone with no fetch
# yet, weird remote setup, etc.).
if ! git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  exit 0
fi

# Compute the diff scope. If nothing in the gate's scope changed, the PR
# can't drift the cdkd parity surface — pass through.
#
# Two independent signals trigger the gate:
#   - Any path under `src/cli/commands/**`, `src/internal.ts`, or
#     `src/index.ts` (the library-surface scope).
#   - A NEW `.ts` file added under `src/local/**`
#     (`--diff-filter=A`). A new file there is the strongest signal
#     that a host-facing helper may have been introduced without an
#     explicit `src/internal.ts` re-export — exactly the case
#     `/check-cdkd-parity`'s category 3 walk-through is meant to catch.
#     Edits to EXISTING `src/local/**` files (`M` / `D`) are excluded
#     so internal refactors don't fire the gate.
scope_touched=$(git diff origin/main...HEAD --name-only 2>/dev/null \
  | grep -E '^src/cli/commands/|^src/internal\.ts$|^src/index\.ts$' \
  | head -1)
new_local_file=$(git diff origin/main...HEAD --diff-filter=A --name-only 2>/dev/null \
  | grep -E '^src/local/.+\.ts$' \
  | head -1)
if [ -z "$scope_touched" ] && [ -z "$new_local_file" ]; then
  exit 0
fi

# Prefer the `mise`-managed markgate via `mise exec --` so the repo's
# canonical version wins; fall back to PATH; fail open if neither.
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  exit 0
fi

"${markgate[@]}" verify cdkd-parity >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status cdkd-parity` so
# the error message tells the user *why* the gate is stale (digest differs
# vs marker never set).
reason=$("${markgate[@]}" status cdkd-parity 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

trigger_desc="cdk-local's library surface (src/cli/commands/** | src/internal.ts | src/index.ts)"
if [ -z "$scope_touched" ] && [ -n "$new_local_file" ]; then
  trigger_desc="a NEW file under src/local/** (potential host-facing helper)"
fi

if [ -n "$reason" ]; then
  printf "Blocked by cdkd-parity-gate: this PR touches %s and the \`cdkd-parity\` marker is stale %s.\n\n" "$trigger_desc" "$reason" >&2
else
  printf "Blocked by cdkd-parity-gate: this PR touches %s and\nthe \`cdkd-parity\` marker is stale.\n\n" "$trigger_desc" >&2
fi

cat >&2 <<'EOF'
Required action — no exceptions:
  /check-cdkd-parity

The skill walks four categories that the host CLI (cdkd) needs to
inherit when cdk-local's library surface changes:
  1. New subcommand factory     — exported from src/index.ts?
                                  cdkd notified?
  2. New CLI option             — added inside add<Cmd>SpecificOptions?
                                  contract test green?
  3. New public helper / type   — exported from src/internal.ts?
                                  JSDoc names host-side use case?
  4. Behavior change            — cdkd informed? migration note in body?

Only call `markgate set cdkd-parity` when every check passes or is
explicitly N/A. Calling it directly from a shell to bypass this hook
defeats the whole point — the gate exists because these questions were
informally skipped twice during the ALB work.
EOF
exit 2
