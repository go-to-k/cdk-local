#!/usr/bin/env bash
# gh-pr-edit-deprecation-gate.sh
#
# PreToolUse hook. Blocks `gh pr edit --title` / `gh pr edit --body`
# because they currently fail SILENTLY due to a GraphQL
# Projects-classic deprecation warning: gh exits non-zero, prints the
# warning to stderr, and the title/body mutation is never applied.
# Diagnosing this wastes time when the PR appears unchanged after a
# command that "succeeded enough" to not throw.
#
# Recommended replacement is the raw REST API:
#
#   gh api -X PATCH repos/<owner>/<repo>/pulls/<num> \
#     -f title="..." \
#     -F body=@/tmp/pr-body.md
#
# This bypasses the deprecated GraphQL path.
#
# Other `gh pr edit` flags that don't touch title/body (e.g. labels,
# reviewers) pass through — those use a different code path that
# isn't affected by the deprecation.

set -u

# Shared, segment-aware command matching (go-to-k/cdk-local#541). Sourcing it
# gives this gate `gate_matches` and the GATE_RE_* verb regexes every gate now
# spells the same way.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate `gh pr edit`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored.
gate_matches "$cmd" "$GATE_RE_GH_PR_EDIT" || exit 0

# Only block if the invocation actually sets --title or --body.
if ! printf '%s' "$cmd" | grep -qE '(--title|--body|--body-file)\b'; then
  exit 0
fi

cat >&2 <<'EOF'
Blocked by gh-pr-edit-deprecation-gate: `gh pr edit --title` /
`--body` currently fails SILENTLY due to a GraphQL Projects-classic
deprecation warning. The mutation is not applied even though the
command appears to succeed.

Use the raw REST API instead:

  gh api -X PATCH repos/<owner>/<repo>/pulls/<num> \
    -f title="New title" \
    -F body=@/tmp/pr-body.md

  # Verify it actually applied:
  gh pr view <num> --json title,body -q '{title, body}'

`--body=@<file>` reads the file verbatim, sidestepping shell-escape
issues with backticks / apostrophes.

If a future gh release fixes the deprecation, this gate can be
removed.
EOF
exit 2
