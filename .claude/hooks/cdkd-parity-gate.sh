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

# Shared, segment-aware command matching (go-to-k/cdk-local#541). Sourcing it
# gives this gate `gate_matches`, `gate_target_dir`, and the GATE_RE_* verb
# regexes every gate now spells the same way.
# Fail OPEN if the shared matcher is missing: a hook that cannot decide must not
# break every Bash call with a `command not found` (go-to-k/cdk-local#542 review).
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
[ -r "$_gate_lib" ] || exit 0
. "$_gate_lib"

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr create`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored.
gate_matches "$cmd" "$GATE_RE_GH_PR_CREATE" || exit 0

# Where the gated command will actually run: a `-C <path>` inside the MATCHED
# segment wins, else the last `cd <path>` segment before it, else the hook
# payload's cwd (see gate_target_dir in _command-match.sh).
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GH_PR_CREATE")

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
# Read git state from the RESOLVED TARGET DIR, not the hook's own cwd: the hook
# process runs wherever the client launched it, so a scope decision taken here
# was about the wrong tree — empty diff in a clean main checkout (gate fires
# needlessly), or an unrelated tree's diff (gate skips wrongly). Same class as
# go-to-k/cdk-real-drift#1805.
if ! git -C "$target_dir" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
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
scope_touched=$(git -C "$target_dir" diff origin/main...HEAD --name-only 2>/dev/null \
  | grep -E '^src/cli/commands/|^src/internal\.ts$|^src/index\.ts$' \
  | head -1)
new_local_file=$(git -C "$target_dir" diff origin/main...HEAD --diff-filter=A --name-only 2>/dev/null \
  | grep -E '^src/local/.+\.ts$' \
  | head -1)
if [ -z "$scope_touched" ] && [ -z "$new_local_file" ]; then
  exit 0
fi

# --- cdkd tracking-issue enforcement (cat 1 / cat 2) ------------------------
# The marker proves the skill WALKED the categories; it does not prove a cdkd
# tracking issue was actually filed. For the two mechanically-unambiguous
# host-MUST-act categories we additionally require a cdkd issue reference in
# the per-worktree sentinel `.cdkd-parity-issue` (written by
# `/check-cdkd-parity` when it auto-files the issue):
#   cat 1 — a NEW command factory: a `src/cli/commands/local-*.ts` file added
#           (`--diff-filter=A`) whose added content declares
#           `export function createLocal<Verb>Command`. Mirrors
#           create-integ-gate.sh's factory-content check so a new non-factory
#           helper module does NOT fire it.
#   cat 2 — a NEW CLI option: a `+...addOption(new Option(...)` line added to
#           any `src/cli/commands/*.ts`.
# cat 3 (new src/local export) and cat 4 (behavior change) are NOT hard-blocked
# here — cat 3 is noisy and cat 4 is a judgment call; both rely on the marker
# (the skill walked + auto-filed). This keeps the hard block on the cases where
# cdkd unambiguously must wrap/inherit, without over-firing on internal
# refactors.
cat1_new_factory=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if git -C "$target_dir" diff origin/main...HEAD --diff-filter=A -- "$f" 2>/dev/null \
    | grep -qE '^\+[[:space:]]*export[[:space:]]+function[[:space:]]+createLocal[A-Z][A-Za-z]*Command'; then
    cat1_new_factory="$f"
    break
  fi
done < <(git -C "$target_dir" diff origin/main...HEAD --diff-filter=A --name-only 2>/dev/null \
  | grep -E '^src/cli/commands/local-[^/]+\.ts$')

cat2_new_option=""
# Same permissive pattern the skill's own detection uses (an added line that
# carries `addOption(...new Option`), so chained `.addOption(new Option(` /
# `cmd.addOption(new Option(` forms all match regardless of leading context.
if git -C "$target_dir" diff origin/main...HEAD -- 'src/cli/commands/*.ts' 2>/dev/null \
  | grep -qE '^\+.*addOption.*new Option'; then
  cat2_new_option="yes"
fi

if [ -n "$cat1_new_factory" ] || [ -n "$cat2_new_option" ]; then
  sentinel="$target_dir/.cdkd-parity-issue"
  if [ ! -f "$sentinel" ] || ! grep -q 'github\.com/go-to-k/cdkd/issues/' "$sentinel" 2>/dev/null; then
    if [ -n "$cat1_new_factory" ]; then
      cat_desc="a NEW subcommand factory ($cat1_new_factory)"
    else
      cat_desc="a NEW CLI option (addOption in src/cli/commands/**)"
    fi
    printf "Blocked by cdkd-parity-gate: this PR adds %s, which cdkd must inherit, but no cdkd tracking issue was filed.\n\n" "$cat_desc" >&2
    cat >&2 <<'EOF'
Required action — no exceptions:
  /check-cdkd-parity

For a new subcommand / new CLI option the skill files a tracking issue on
go-to-k/cdkd (so the cdkd agent inherits it by working its issue queue) and
records the issue URL in the per-worktree sentinel `.cdkd-parity-issue`. This
gate requires that sentinel to carry a `github.com/go-to-k/cdkd/issues/`
reference before `gh pr create` can proceed.

Do NOT hand-write the sentinel to bypass this — run the skill so the issue is
actually created.
EOF
    exit 2
  fi
fi
# ---------------------------------------------------------------------------

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
