#!/usr/bin/env bash
# create-integ-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` (and the
# `cd <path> && gh pr create` / `gh -C <path> pr create` worktree forms)
# when ALL of the following hold:
#   1. The PR's diff vs origin/main ADDS a new command factory — a NEW
#      `src/cli/commands/local-<verb>.ts` file (`--diff-filter=A`) that
#      declares an `export function createLocal<Verb>Command(...)`. The
#      content check matters: `src/cli/commands/local-*.ts` also holds
#      non-factory helper modules (local-state-source.ts,
#      local-profile-credentials-file.ts), which must NOT trigger the
#      gate. A new subcommand factory is brand-new top-level user-facing
#      behavior with NO existing integ fixture, so it MUST ship its own
#      (the "every feature carries its integ" rule, mechanically
#      enforced for the one case where the need is unambiguous — a new
#      command always needs a new fixture).
#   2. The `create-integ` markgate marker is stale (digest differs /
#      never set).
#
# When either is false (no new factory, or marker fresh), exit 0 and
# `gh pr create` proceeds. EDITS to existing command files (`M` / `D`)
# never fire this gate — adding a flag to an existing command reuses
# that command's existing fixture, which integ-gate already covers.
#
# Pre-create-only, like cdkd-parity-gate: "a fixture was created for the
# new command" is a create-time judgment; re-blocking on a later
# same-PR edit would be friction without value. (integ-gate still
# enforces marker freshness at pre-merge time for any src / fixture
# touch.)
#
# cwd-aware (mirrors check-gate.sh / integ-gate.sh / cdkd-parity-gate.sh):
# resolves the target working tree from the payload `cwd` + leading
# `cd <path>` + the last `gh -C <path>` flag, so markgate's per-worktree
# marker store is consulted correctly.
#
# Fail-open: `gh` / `markgate` / `git` missing, or `origin/main`
# unresolvable -> exit 0 silently. A safety net, not a hard dependency.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr create`. Line-start anchored so a `gh pr create`
# substring inside a quoted argument body does NOT false-positive.
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

if ! command -v git >/dev/null 2>&1; then
  exit 0
fi
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

if ! command -v gh >/dev/null 2>&1; then
  exit 0
fi

if ! git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  exit 0
fi

# Fire ONLY on a NEW command FACTORY file. `src/cli/commands/local-*.ts`
# also holds non-factory helper modules (e.g. local-state-source.ts,
# local-profile-credentials-file.ts), so a filename match alone would
# false-positive on a new helper. Confirm each newly-ADDED file actually
# declares an `export function createLocal<Verb>Command(...)` before
# gating. An edit to an EXISTING command (a new flag, a behavior tweak)
# reuses that command's existing fixture and never fires here.
new_command=""
while IFS= read -r added; do
  [ -n "$added" ] || continue
  if grep -qE 'export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+createLocal[A-Za-z]*Command' "$added" 2>/dev/null; then
    new_command="$added"
    break
  fi
done < <(git diff origin/main...HEAD --diff-filter=A --name-only 2>/dev/null \
  | grep -E '^src/cli/commands/local-[^/]+\.ts$')
if [ -z "$new_command" ]; then
  exit 0
fi

# Prefer the `mise`-managed markgate; fall back to PATH; fail open.
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  exit 0
fi

"${markgate[@]}" verify create-integ >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

reason=$("${markgate[@]}" status create-integ 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

if [ -n "$reason" ]; then
  printf "Blocked by create-integ-gate: this PR adds a new command factory (%s) and the \`create-integ\` marker is stale %s.\n\n" "$new_command" "$reason" >&2
else
  printf "Blocked by create-integ-gate: this PR adds a new command factory (%s) and\nthe \`create-integ\` marker is stale.\n\n" "$new_command" >&2
fi

cat >&2 <<'EOF'
A new subcommand is brand-new user-facing behavior with no existing
integ fixture — it MUST ship its own. Required action:
  /create-integ <fixture-name>

The skill scaffolds a fixture (package.json pinned with `packageManager`
so `vp install` is a no-op, bin / lib / cdk.json / tsconfig / a verify.sh
harness), has you fill in the stack + assertions for the new command,
RUNS it via /run-integ, and sets this marker on a clean green run.

Only the skill sets `create-integ`. Calling `markgate set create-integ`
directly from a shell to bypass this hook defeats the point — a new
command without an exercised end-to-end fixture can ship a latent bug
behind a green unit suite.
EOF
exit 2
