#!/usr/bin/env bash
# pr-review-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) on PRs
# whose size + bias factors trigger the /review-pr skill's
# `1-reviewer` or `3-axis` recommendation, unless the `pr-review`
# markgate marker is fresh AND bound to the PR's current HEAD sha.
#
# `gh pr create` is intentionally NOT gated — opening a PR for review
# should be allowed freely; the gate only fires at merge time.
# `inline`-tier PRs (small / docs-only / etc.) always pass through,
# matching the skill's own "no dispatch needed" recommendation.
#
# Sentinel-based PR-sha binding: the skill writes the PR's HEAD sha
# into `.markgate-pr-review-sha` (gitignored) right before
# `markgate set pr-review`. The gate's `include:` scope in
# .markgate.yml is just that file, so a new push to the PR rewrites
# the sentinel (next /review-pr run) and `markgate verify` reports
# stale automatically. No bespoke sha tracking inside the hook.

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
# `gate_pr_selector` too: without it the selector silently comes back EMPTY and
# the gate judges the wrong PR (or none) instead of refusing.
if ! declare -F gate_pr_selector >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_pr_selector is undefined (predates the shared PR-selector extractor?)." >&2
  exit 2
fi


# Read the PreToolUse payload (command + cwd) once — separate jq
# invocations would consume stdin twice.
input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored.
gate_matches "$cmd" "$GATE_RE_GH_PR_MERGE" || exit 0

# `gh pr merge` is a working-tree-agnostic remote operation, but
# markgate's marker is stored per-worktree at
# `<git rev-parse --absolute-git-dir>/markgate/`. The marker lands in
# the SAME worktree where `/review-pr <N>` ran (via
# `mise exec -- markgate set pr-review`). The convention shift is: set
# markers from the worktree you intend to merge from. The sentinel
# `.markgate-pr-review-sha` is already per-worktree (each worktree has
# its own root), so concurrent agents on different PRs in different
# worktrees no longer clobber each other's sentinels.
# Where the gated command will actually run: a `-C <path>` inside the MATCHED
# segment wins, else the last `cd <path>` segment before it, else the hook
# payload's cwd (see gate_target_dir in _command-match.sh).
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GH_PR_MERGE")

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# --- Parse the PR number from the command. -----------------------------
# Accepted shapes (gh pr merge syntax):
#   gh pr merge 123
#   gh pr merge 123 --auto
#   gh pr merge --auto 123
#   gh pr merge --squash --auto 123
#   gh pr merge --auto    (no number; merges PR for current branch)
#
# No numeric token means gh's "PR for the current branch" semantics, which the
# call below reproduces by passing no positional arg.
# Through the SHARED extractor. Two defects were folded into the old local one,
# and the second only became reachable once GATE_GH_C learned `-R`:
#   - `args="${cmd##*gh pr merge}"` does not strip under a repo flag, so...
#   - ...the arg loop scanned the WHOLE command for the first bare integer.
#     `sleep 30 && gh -R go-to-k/cdk-local pr merge 552 --squash` resolved to
#     `gh pr view 30` (measured 2026-08-25). The WRONG PR's additions, deletions
#     and file count then chose the review tier -- and if that PR is `inline`,
#     the real merge passes with no reviewer at all.
# The shared extractor scans only what follows the matched verb, so a leading
# numeric token cannot be read as the selector.
pr_number=$(gate_pr_selector "$cmd" "$GATE_RE_GH_PR_MERGE")
# The repo the command NAMES, passed through to this gate's own gh calls. Without
# it `gh -R go-to-k/OTHER pr merge 552` made the gate ask the LOCAL repo about
# its PR 552 -- right number, wrong repo, and indistinguishable from the correct
# case by both exit code and PR number.
cmd_repo=$(gate_cmd_repo "$cmd" "$GATE_RE_GH_PR_MERGE")

# --- Fetch PR stats via gh. --------------------------------------------
# Pass-through on any gh error so an unrelated infra outage doesn't
# block merges (fail-open posture, mirroring check-gate.sh).
if [ -n "$pr_number" ]; then
  # shellcheck disable=SC2086
  pr_json=$(gh pr view "$pr_number" ${cmd_repo:+--repo "$cmd_repo"} \
    --json additions,deletions,changedFiles,files,headRefOid,headRefName 2>/dev/null) || {
    printf 'pr-review-gate: gh pr view %s failed; allowing merge (infra fail-open)\n' "$pr_number" >&2
    exit 0
  }
else
  pr_json=$(gh pr view \
    --json additions,deletions,changedFiles,files,headRefOid,headRefName,number 2>/dev/null) || {
    echo "pr-review-gate: gh pr view failed; allowing merge (infra fail-open)" >&2
    exit 0
  }
  pr_number=$(printf '%s' "$pr_json" | jq -r '.number // ""' 2>/dev/null || echo "")
fi

# Parse counts.
loc=$(printf '%s' "$pr_json" | jq -r '(.additions // 0) + (.deletions // 0)' 2>/dev/null || echo 0)
fc=$(printf '%s' "$pr_json" | jq -r '.changedFiles // 0' 2>/dev/null || echo 0)
head_sha=$(printf '%s' "$pr_json" | jq -r '.headRefOid // ""' 2>/dev/null || echo "")
paths=$(printf '%s' "$pr_json" | jq -r '.files[].path' 2>/dev/null || echo "")

# Defensive: if any number is empty, fail open.
if [ -z "$loc" ] || [ -z "$fc" ]; then
  echo "pr-review-gate: could not parse PR stats; allowing merge (fail-open)" >&2
  exit 0
fi

# --- Compute final tier per the /review-pr heuristic. ------------------
# Reference: .claude/skills/review-pr/SKILL.md (steps 2-4). Logic
# duplicated here in Bash for hook-time evaluation; the duplication is
# intentional — the skill is the source of truth for output formatting
# and dispatch prompts, the hook only needs the final tier name. Keep
# these two in sync when editing.

# Base tier from (loc, fc):
#   loc < 300 OR fc < 5            -> inline
#   300 <= loc < 1000 AND 5 <= fc < 10 -> 1-reviewer
#   loc >= 1000 OR fc >= 10        -> 3-axis
base_tier="inline"
if [ "$loc" -ge 1000 ] || [ "$fc" -ge 10 ]; then
  base_tier="3-axis"
elif [ "$loc" -ge 300 ] && [ "$fc" -ge 5 ]; then
  base_tier="1-reviewer"
fi

# Bias factor scan.
up_bias=0
down_bias=0

# Up-bias path patterns: the security surface. A PR touching any of these is
# reviewed one tier higher than its size alone would give.
#
# The list is written out FOUR times -- here, `.claude/skills/review-pr/SKILL.md`,
# `.claude/rules/hooks.md` and `.claude/agents/pr-code-reviewer.md` -- and issue
# #506 found it had drifted in BOTH directions: the reviewer-agent copy had
# silently dropped one entry, and the list was far too small -- the issue named
# seven missing authn / credential / code-exec modules and an independent sweep
# of `src/**` found ~18 more, mostly the authorizer ENFORCEMENT points rather
# than the verifier modules already listed. 7 entries -> 32.
#
# The list-consistency case in `pr-review-gate.test.sh` (run by
# `vp run test:hooks`, wired into CI) now asserts the four agree, in the same
# order, and that every entry resolves to a real file, so a rename or a one-copy
# edit fails CI instead of quietly under-protecting.
# Adding a module here is the whole cost of covering it; when in doubt, add it.
UP_PATHS=(
  # Credential / secret material
  'src/utils/role-arn.ts'
  'src/utils/profile-resolver.ts'
  'src/cli/commands/local-profile-credentials-file.ts'
  'src/local/ecs-secrets-resolver.ts'
  'src/local/ssm-parameter-resolver.ts'
  'src/local/ecs-task-runner.ts'
  # Inbound auth: verification, enforcement, request signing
  'src/local/cognito-jwt.ts'
  'src/local/lambda-authorizer.ts'
  'src/local/sigv4-verify.ts'
  'src/local/authorizer-resolver.ts'
  'src/local/authorizer-cache.ts'
  'src/local/front-door-auth.ts'
  'src/local/agentcore-serve-auth.ts'
  'src/local/agentcore-sigv4-sign.ts'
  'src/local/http-server.ts'
  'src/local/front-door-server.ts'
  'src/local/agentcore-http-server.ts'
  'src/local/websocket-server.ts'
  'src/utils/url-authority.ts'
  # Untrusted code / argv / archive + path traversal
  'src/utils/docker-cmd.ts'
  'src/local/docker-runner.ts'
  'src/local/docker-image-builder.ts'
  'src/local/ecr-puller.ts'
  'src/assets/docker-build.ts'
  'src/local/image-override-engine.ts'
  'src/local/cloudfront-function-runtime.ts'
  'src/local/studio-dispatch.ts'
  'src/local/studio-serve-manager.ts'
  'src/local/studio-option-catalog.ts'
  'src/local/cloudfront-static-origin.ts'
  'src/local/lambda-resolver.ts'
  'src/local/agentcore-s3-bundle.ts'
  'src/local/layer-arn-materializer.ts'
)
# Membership is an exact string comparison, deliberately NOT a regex. An earlier
# draft joined the entries into an anchored ERE and escaped only `.`; a future
# entry carrying an unbalanced `(` or `[` would then make the whole alternation
# an INVALID ERE, `grep -qE` would exit 2, and the `if` below would read that as
# "no match" -- silently disabling the up-bias for every path in the PR. A
# security gate must not fail open on a typo, so there is no pattern to get
# wrong: `up_bias_path` compares `$1` against each entry verbatim.
up_bias_path() {
  local candidate="$1" up
  for up in "${UP_PATHS[@]}"; do
    [ "$candidate" = "$up" ] && return 0
  done
  return 1
}

# Down-bias buckets. Either ALL paths are docs/infra, or ALL paths
# are tests. Mixed -> no down-bias.
#
# Down-bias covers INERT documentation only. Files that change how the AGENT
# behaves -- CLAUDE.md, .claude/** (skills, agents, hooks, rules, settings),
# .markgate.yml -- were in this bucket and are not any more (issue #501): a
# wrong rule there propagates into every future session, which is the opposite
# of the low risk a down-bias assumes, and the `.*\.md` entry below would
# otherwise re-admit every SKILL.md through the back door. cdkd made the same
# change in its own copy of this gate; keep this regex, that one,
# `/review-pr`'s down-bias list, `.claude/skills/work-issues/SKILL.md` (its
# section 10-d describes this tier for skill-only PRs) and
# `.claude/rules/hooks.md` in sync.
AGENT_INSTRUCTION_REGEX='^(CLAUDE\.md|\.claude/.*|\.markgate\.yml)$'
DOWN_DOCS_REGEX='^(\.gitignore|README\.md|.*\.md|docs/.*|package\.json)$'
DOWN_TESTS_REGEX='^tests/.*'

all_docs=1
all_tests=1
saw_path=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  saw_path=1
  if up_bias_path "$p"; then
    up_bias=1
  fi
  # An agent-instruction path is never "docs" for tier purposes, even though
  # it is markdown and would match DOWN_DOCS_REGEX.
  if printf '%s' "$p" | grep -qE "$AGENT_INSTRUCTION_REGEX" \
    || ! printf '%s' "$p" | grep -qE "$DOWN_DOCS_REGEX"; then
    all_docs=0
  fi
  if ! printf '%s' "$p" | grep -qE "$DOWN_TESTS_REGEX"; then
    all_tests=0
  fi
# Herestring, not an unquoted heredoc: a heredoc body is expanded, so a PR
# file path containing `$(...)` or backticks would be command-substituted here
# on attacker-supplied data (any fork can open a PR adding such a path).
done <<<"$paths"

if [ "$saw_path" -eq 1 ] && { [ "$all_docs" -eq 1 ] || [ "$all_tests" -eq 1 ]; }; then
  down_bias=1
fi

# Multi-subagent fix-back heuristic. Same data as the skill: count
# commits on the PR branch whose message starts with `fix:` / `fix(`.
branch=$(printf '%s' "$pr_json" | jq -r '.headRefName // ""' 2>/dev/null || echo "")
if [ -n "$branch" ] && git rev-parse --verify --quiet "origin/$branch" >/dev/null 2>&1; then
  # `$(… || echo 0)` is WRONG here: `grep -c` already prints `0` before exiting
  # 1 on no match, so the fallback APPENDS and the substitution is `0\n0` --
  # which makes the test below print `[: 0\n0: integer expression expected` on
  # every gated merge. The outcome happened to be correct (non-numeric is not
  # `-gt 1`), which is exactly why it survived: a real parse failure would look
  # identical. Assign, then default on the assignment's own exit status.
  fix_count=$(git log "origin/main..origin/$branch" --oneline 2>/dev/null \
    | grep -cE '^[a-f0-9]+ fix(\(|:)') || fix_count=0
  if [ "${fix_count:-0}" -gt 1 ]; then
    up_bias=1
  fi
fi

# Resolve precedence: if both fire, up wins (security beats convenience).
if [ "$up_bias" -eq 1 ]; then
  down_bias=0
fi

# Apply bias to base.
final_tier="$base_tier"
if [ "$up_bias" -eq 1 ]; then
  case "$base_tier" in
    inline) final_tier="1-reviewer" ;;
    1-reviewer) final_tier="3-axis" ;;
    3-axis) final_tier="3-axis" ;;  # clamp
  esac
elif [ "$down_bias" -eq 1 ]; then
  case "$base_tier" in
    3-axis) final_tier="1-reviewer" ;;
    1-reviewer) final_tier="inline" ;;
    inline) final_tier="inline" ;;  # clamp
  esac
fi

# --- inline tier: always pass through. ---------------------------------
if [ "$final_tier" = "inline" ]; then
  exit 0
fi

# --- 1-reviewer / 3-axis: verify the marker. ---------------------------
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by pr-review-gate: markgate is not installed. Run 'mise install' at the repo root." >&2
  exit 2
fi

"${markgate[@]}" verify pr-review >/dev/null 2>&1
status=$?

# Also verify the sentinel file's content matches the PR's HEAD sha.
# markgate verify already enforces this via the digest, but reading
# the sentinel directly lets the error message name the mismatch
# explicitly ("marker bound to <other-sha>, PR is at <current-sha>")
# rather than the generic "(digest differs)" markgate emits.
recorded_sha=""
if [ -f .markgate-pr-review-sha ]; then
  recorded_sha=$(head -c 100 .markgate-pr-review-sha 2>/dev/null | tr -d '[:space:]')
fi

if [ "$status" -eq 0 ] && [ -n "$head_sha" ] && [ "$recorded_sha" = "$head_sha" ]; then
  exit 0
fi

# Render the block message. Names the offending PR, the resolved tier,
# the stats that produced it, and the required action.
pr_label="${pr_number:-<current-branch-PR>}"
sha_short=$(printf '%s' "$head_sha" | cut -c1-7)

cat >&2 <<EOF_HEAD
Blocked by pr-review-gate: PR #${pr_label} (${loc} LOC, ${fc} files) requires \`${final_tier}\` review before merge.

PR HEAD sha: ${sha_short:-<unknown>}
Marker state: $(if [ -n "$recorded_sha" ]; then printf 'bound to %s (mismatch)' "$(printf '%s' "$recorded_sha" | cut -c1-7)"; else printf 'unset'; fi)

EOF_HEAD

cat >&2 <<'EOF'
Required action:
  /review-pr <PR-number>

The skill applies the size + bias heuristic, dispatches the recommended
reviewer count (1 or 3), waits for findings, and sets the pr-review
marker bound to the current PR HEAD sha ONLY when no blockers remain.

The skill is the ONLY legitimate setter of this marker. Do NOT call
`markgate set pr-review` directly — the whole point of the gate is
that an un-reviewed large / security-sensitive PR cannot reach main.
A new push to the PR invalidates the marker automatically (the
sentinel rewrite changes the digest), so re-run /review-pr after
addressing reviewer findings.

If the orchestrator believes the heuristic is wrong for this PR
(e.g. a 1500-LOC mechanical rename that genuinely needs no review),
the correct path is a code-comment in the PR explaining why and a
manual `markgate set pr-review` with the user's explicit go-ahead.
EOF
exit 2
