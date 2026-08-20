#!/usr/bin/env bash
# integ-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) and
# `git merge` unless the `integ` markgate marker is fresh for
# the current branch delta. The gate's scope (see .markgate.yml)
# covers `src/**` and `tests/integration/**`; a change THIS BRANCH
# makes to any of them invalidates the marker and forces a successful
# Docker-based `/run-integ <test-name>` run before the PR can be merged.
#
# The gate runs on markgate's `hash: diff` mode (0.4+): the digest is
# this branch's delta against `merge-base(origin/main, HEAD)` restricted
# to that scope, NOT the working tree's content. So a `main` merge /
# rebase that moves an in-scope file this branch did not touch leaves
# the marker fresh, while an overlapping `main` change still stales it.
# See .claude/rules/hooks.md "integ-gate (pre-merge)" and issue #498.
#
# The `.markgate.yml` integ gate also carries a 14-day TTL on top
# of the diff-scope check, so the marker decays even when nothing
# changed in the repo — Docker base-image behavior, RIE binary, and
# host network plumbing drift over time, so a marker more than two
# weeks old no longer proves today's local code path works.
#
# WHY cwd-aware resolution: this repo is regularly worked in via
# `git worktree`. We read the actual git working tree the command
# will run against (via `git -C` or a preceding `cd <path>`) before
# consulting markgate. Convention: set markers from the worktree you
# intend to merge from.

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

# Only gate `gh pr merge` and `git merge`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored. `gate_re` keeps whichever verb matched so the target-dir
# resolution below reads the right segment.
gate_re=""
for gate_candidate in "$GATE_RE_GH_PR_MERGE" "$GATE_RE_GIT_MERGE"; do
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
# unresolvable (fresh clone, a worktree that never fetched), fall
# through — but note that under `hash: diff` this is NOT a marker check
# any more: markgate exits 2 on an unresolvable base ref for `verify`,
# `status` and `set` alike, so the merge is blocked with the generic
# message and re-running `/run-integ` CANNOT clear it (its own
# `markgate set integ` fails the same way). The fix is `git fetch
# origin`. Still conservative — it blocks rather than passes.
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
# "(digest differs)" (this branch's src/** or tests/integration/**
# delta changed) or "(expired by ttl: 14d, marker is Nd old)" (the
# marker aged out). The `state:` line format is unchanged by the
# `hash: diff` mode — it only adds `base:` / `merge base:` lines
# above, so this awk still finds the parenthetical.
#
# Under `hash: diff`, `markgate status` can also exit 2 with a
# "no delta against merge-base" error (empty TOTAL branch delta, i.e.
# a clean base branch) or a 'base ref does not resolve' error. Both
# write to stderr, so `reason` comes back empty and the generic
# message below is used. The empty-delta one cannot actually reach
# here: an empty delta means an empty diff, so the scope short-circuit
# above always exits 0 first. Note an empty IN-SCOPE delta is a
# different thing — markgate ACCEPTS it with a warning and exit 0.
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
