#!/usr/bin/env bash
# closes-paren-form-gate.sh — block `gh pr merge` when PR body uses
# `Closes (#N)` / `Fixes (#N)` / `Resolves (#N)` (closing-paren form),
# which does NOT trigger GitHub's auto-close because the keyword
# grammar requires parens-free `#N`.
#
# This hook fires PreToolUse on `gh pr merge` and short-circuits before
# the merge happens, so the user sees the error in time to either:
#   (a) rewrite the PR body to drop parens on the actual close keyword
#   (b) reword to a non-close-keyword incidental reference

set -euo pipefail

# Shared, segment-aware command matching (go-to-k/cdk-local#541). Sourcing it
# gives this gate `gate_matches` and the GATE_RE_* verb regexes every gate now
# spells the same way.
# Fail OPEN if the shared matcher is missing: a hook that cannot decide must not
# break every Bash call with a `command not found` (go-to-k/cdk-local#542 review).
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
[ -r "$_gate_lib" ] || exit 0
. "$_gate_lib"

input_json=$(cat)

tool_name=$(jq -r '.tool_name // empty' <<<"$input_json" 2>/dev/null || true)
[[ "$tool_name" == "Bash" ]] || exit 0

command=$(jq -r '.tool_input.command // empty' <<<"$input_json" 2>/dev/null || true)
[[ -n "$command" ]] || exit 0

# Only gate `gh pr merge`; anything else passes through. `gate_matches` splits
# the command into segments, so the verb is caught in ANY position — after a
# `git push &&`, after a `cd <wt>;`, inside a subshell — while a mention inside
# a quoted string or a heredoc body is still ignored (the plain substring test
# this used to run could not tell those apart).
gate_matches "$command" "$GATE_RE_GH_PR_MERGE" || exit 0

# Extract the LAST `gh pr merge ... N` occurrence so an earlier mention in the
# same command line does not confuse the positional parser.
trimmed="${command}"

# Extract PR number (positional integer after `gh pr merge`)
args="${trimmed##*gh pr merge}"
pr_num=$(echo "$args" | grep -oE '^[[:space:]]*[0-9]+' | head -1 | tr -d '[:space:]' || true)
[[ -n "$pr_num" ]] || exit 0
[[ "$pr_num" =~ ^[0-9]+$ ]] || exit 0

# Fetch PR body. Distinguish two failure modes:
#   (1) `gh pr view` exited non-zero (network / auth / rate-limit) — we
#       can't determine the body, so we can't prove the trap is absent.
#       Log a LOUD warning to stderr so the user sees the gate
#       couldn't verify and can check manually; exit 0 (fail-open by
#       policy — don't block offline workflows).
#   (2) `gh pr view` succeeded but body is empty — legitimate state
#       (PR with no body literally has nothing to match against). The
#       grep below handles empty input cleanly; no warning needed.
gh_stderr=$(mktemp)
trap 'rm -f "$gh_stderr"' EXIT
if ! body=$(gh pr view "$pr_num" --json body -q .body 2>"$gh_stderr"); then
  {
    echo "WARN: closes-paren-form-gate could not fetch PR #$pr_num body"
    echo "    (\`gh pr view\` exited non-zero — likely network / auth /"
    echo "     rate-limit). The merge will proceed, but the"
    echo "     'Closes (#N)' auto-close trap check did NOT run. If your"
    echo "     PR body uses 'Closes #N' or no close keyword at all, you"
    echo "     can ignore this warning. If you used 'Closes (#N)'"
    echo "     parens-form, the target issue will stay OPEN and you'll"
    echo "     need to manually \`gh issue close <N>\` after the merge."
    echo ""
    echo "     gh stderr:"
    sed 's/^/       /' "$gh_stderr"
  } >&2
  exit 0
fi

# Match `(closes?|fix(es)?|resolves?) (#N)` case-insensitive, only
# when the parens IMMEDIATELY follow the keyword + whitespace. This
# avoids false positives on text like `also closes some (#N) issue`
# (a parenthetical that happens to follow `closes` but isn't part of
# the close directive).
matches=$(echo "$body" | grep -inE '\b(close[sd]?|fix(es|ed)?|resolve[sd]?)[[:space:]]+\(#[0-9]+\)' || true)

if [[ -n "$matches" ]]; then
  {
    echo "Blocked by closes-paren-form-gate: PR #$pr_num body uses"
    echo "the parens form on a GitHub auto-close keyword, which does"
    echo "NOT trigger auto-close on merge. Offending lines:"
    echo ""
    echo "$matches" | sed 's/^/  /'
    echo ""
    echo "GitHub auto-close grammar requires parens-free \`#N\`:"
    echo "  OK: Closes #502.         (auto-close fires on merge)"
    echo "  NG: Closes (#502).       (silent no-op; issue stays OPEN)"
    echo ""
    echo "Two fixes:"
    echo "  1. If the close IS intended: drop the parens, e.g."
    echo "       sed -i '' 's/Closes (#\\([0-9]*\\))/Closes #\\1/g' <body-file>"
    echo "     then update via:"
    echo "       gh api -X PATCH repos/<owner>/<repo>/pulls/$pr_num -F body=@<file>"
    echo "  2. If the parens form was an incidental reference (not a"
    echo "     close directive): reword to drop the close keyword, e.g."
    echo "       'References (#502).' / 'See also (#502).'"
  } >&2
  exit 2
fi

exit 0
