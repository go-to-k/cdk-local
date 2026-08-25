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

# Extract the PR number through the SHARED extractor, which strips the matched
# verb -- flags and all -- rather than a literal `gh pr merge` prefix.
# `args="${command##*gh pr merge}"` was the old shape and it did not strip under
# a repo flag, so the number regex found nothing and this gate exited 0:
# `gh -R <owner/repo> pr merge 552 --squash` was FULLY bypassed while the plain
# form was refused (measured 2026-08-25 with a gh shim returning a body carrying
# `Closes (#12)`: plain rc=2, every flagged spelling rc=0 with gh never called).
pr_num=$(gate_pr_selector "$command" "$GATE_RE_GH_PR_MERGE")
# The repo the command NAMES, passed through to this gate's own gh calls. Without
# it `gh -R go-to-k/OTHER pr merge 552` made the gate ask the LOCAL repo about
# its PR 552 -- right number, wrong repo, and indistinguishable from the correct
# case by both exit code and PR number.
cmd_repo=$(gate_cmd_repo "$command" "$GATE_RE_GH_PR_MERGE")
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
if ! body=$(gh pr view "$pr_num" ${cmd_repo:+--repo "$cmd_repo"} --json body -q .body 2>"$gh_stderr"); then
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
