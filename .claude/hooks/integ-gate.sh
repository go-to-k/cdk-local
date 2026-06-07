#!/usr/bin/env bash
# integ-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) and
# `git merge` unless the `integ` markgate marker is fresh for
# the current content state. The gate's scope (see .markgate.yml)
# covers `src/**` and `tests/integration/**`; editing any of them
# invalidates the marker and forces a successful Docker-based
# `/run-integ <test-name>` run before the PR can be merged.
#
# The `.markgate.yml` integ gate also carries a 14-day TTL on top
# of the file-scope check, so the marker decays even when nothing
# changed in the repo — Docker base-image behavior, RIE binary, and
# host network plumbing drift over time, so a marker more than two
# weeks old no longer proves today's local code path works.
#
# WHY cwd-aware resolution: this repo is regularly worked in via
# `git worktree`. We read the actual git working tree the command
# will run against (via `git -C` or leading `cd <path>`) before
# consulting markgate. Convention: set markers from the worktree you
# intend to merge from.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` and `git merge`. `gh pr create` is
# intentionally NOT gated — opening a PR for review should be allowed
# even when the integ marker is stale; the gate only fires at merge
# time. Line-start anchored so `gh pr merge` / `git merge` substrings
# inside quoted argument bodies do NOT false-positive.
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])|^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?git[^|;&]*[[:space:]]merge([[:space:]]|$|[|;&`)])'; then
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

cd "$target_dir" 2>/dev/null || exit 0

# Scope short-circuit: the `integ` marker only matters for PRs that touch
# the Docker-exercised surface (`src/**` or `tests/integration/**`). When the
# PR diff vs origin/main touches NEITHER, skip the marker check so a docs /
# hooks / skills-only PR is not blocked by a stale-or-absent integ marker —
# which otherwise fires on EVERY merge from a fresh worktree (a new worktree
# has no per-worktree marker, so `markgate verify integ` reports "no marker"
# regardless of what the PR actually changed). Mirrors the origin/main diff
# base used by `create-integ-gate.sh` / `cdkd-parity-gate.sh`.
#
# Only short-circuit when the diff is computable. If origin/main is
# unresolvable (fresh clone, detached state), fall through to the marker
# check — the conservative choice, never weaker than the prior behavior.
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  if ! git diff origin/main...HEAD --name-only 2>/dev/null \
      | grep -qE '^(src/|tests/integration/)'; then
    exit 0
  fi
fi

if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by integ-gate: markgate is not installed. Run 'mise install' at the repo root." >&2
  exit 2
fi

"${markgate[@]}" verify integ >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status integ` so
# the error message tells the user *why* the gate is stale. With the
# 14d TTL configured in .markgate.yml, the stale reason is either
# "(digest differs)" (a src/** or tests/integration/** file changed)
# or "(expired by ttl: 14d, marker is Nd old)" (the marker aged out).
reason=$("${markgate[@]}" status integ 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

if [ -n "$reason" ]; then
  printf "Blocked by integ-gate: this PR touches src/** or tests/integration/** and the \`integ\` marker is stale %s.\n\n" "$reason" >&2
else
  cat >&2 <<'EOF_HEAD'
Blocked by integ-gate: this PR touches src/** or tests/integration/**
and the `integ` marker is stale.

EOF_HEAD
fi

cat >&2 <<'EOF'
Required action — no exceptions:
  /run-integ <test-name>            # e.g. local-invoke / local-start-api /
                                    # local-run-task / local-invoke-container /
                                    # local-invoke-from-cfn-stack /
                                    # local-invoke-layers / local-invoke-python /
                                    # local-invoke-ruby / local-invoke-java /
                                    # local-invoke-dotnet / local-invoke-provided

The /run-integ skill is the ONLY legitimate setter of this marker. It
runs the Docker-based fixture (no AWS deploy needed except for
`*-from-cfn-stack` tests) and only calls `markgate set integ` if ALL
of the following hold:
  - the verify.sh run exited cleanly,
  - 0 orphan containers / networks after the post-run docker sweep,
  - for *-from-cfn-stack tests: 0 orphan CloudFormation stacks.

Do NOT call `markgate set integ` directly from a shell to bypass this
hook. The whole point of the gate is that an unverified local code
path cannot reach main. If you believe the file in scope is genuinely
unrelated to local execution, narrow `.markgate.yml`'s integ scope —
do not bypass the marker.
EOF
exit 2
