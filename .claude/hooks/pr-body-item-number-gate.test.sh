#!/usr/bin/env bash
# Smoke tests for pr-body-item-number-gate.sh
#
# Run from anywhere:  bash .claude/hooks/pr-body-item-number-gate.test.sh
# `vp run test:hooks` globs `.claude/hooks/*.test.sh`, so this file is picked up
# with no registration step.
#
# The gate blocks a `gh` writer whose `--body-file` / `-F body=@` body carries a
# `#N` token GitHub would auto-link to an unrelated issue or PR. Asserts, in
# both directions:
#   - PASS  for the allow-listed contexts: `closes #N`, `(#N)`, a soft `refs: #N`,
#           a full GitHub URL, and anything inside a fenced code block
#   - BLOCK for item-number prefixes (`Must-fix #1`) and for a bare `#N` in prose
#   - BLOCK for the SAME-repo qualified `go-to-k/cdk-local#N` spelling, which
#           this repo deliberately refuses in a BODY -- `/work-issues` section
#           10-c names a full URL as the only body spelling and the qualified
#           form as the `.claude/**` one, so allowing it here would put the hook
#           and the skill in direct contradiction
#   - BLOCK for chained spellings, PASS for a command that merely QUOTES the verb
#   - both halves of the go-to-k/cdk-local#637 window, below
#
# Measured rather than asserted (2026-08-31, bash 5.3): an always-`exit 0` stub
# fails 8 of these and an always-`exit 2` stub fails 9, so neither direction
# can pass vacuously. Keep these numbers current when cases are added -- a stale
# count in a comment that exists to prove non-vacuity is itself the thing it
# warns about.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-body-item-number-gate.sh"
PASS=0
FAIL=0

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# write_file <name> <content>  -> echoes the absolute path
write_file() {
  printf '%s' "$2" > "$TMPROOT/$1"
  echo "$TMPROOT/$1"
}

# run <name> <command> <expected-exit>
run() {
  local name="$1" command="$2" expect="$3"
  local payload out rc
  payload=$(jq -n --arg c "$command" '{tool_name:"Bash", tool_input:{command:$c}}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    echo "PASS: $name (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect)"
    printf '%s\n' "$out" | sed 's/^/      /' | head -5
    FAIL=$((FAIL + 1))
  fi
}

# --- Fixture body files -----------------------------------------------------

CLEAN=$(write_file clean.md "# Title

Must-fix 1: thing one
Must-fix 2: thing two
")

ITEMNUM=$(write_file itemnum.md "# Title

Must-fix #1: thing one
")

BARE=$(write_file bare.md "# Title

The regression landed in #1234 and nobody noticed.
")

ALLOWED=$(write_file allowed.md "# Title

closes #1234
Backport of (#231).
refs: #99
See https://github.com/go-to-k/cdk-local/issues/512 for the trace.
")

FENCED=$(write_file fenced.md "# Title

\`\`\`
Must-fix #1: inside a fenced block, not auto-linked
\`\`\`
")

# The qualified same-repo spelling. Refused in a BODY on purpose -- see the
# header. Pinned so a future port of the sibling repo's allow arm cannot land
# here silently.
QUALIFIED=$(write_file qualified.md "# Title

Ported from go-to-k/cdk-local#587.
")

# --- Baseline behaviour -----------------------------------------------------

run "clean bare-number body passes"            "gh pr create --body-file $CLEAN"    0
run "item-number #N body blocked"              "gh pr create --body-file $ITEMNUM"  2
run "bare #N in prose blocked"                 "gh pr create --body-file $BARE"     2
run "allow-listed contexts pass"               "gh pr create --body-file $ALLOWED"  0
run "fenced code block passes"                 "gh pr create --body-file $FENCED"   0
run "same-repo qualified ref blocked in a body" "gh pr create --body-file $QUALIFIED" 2
run "gh issue create with #N body blocked"     "gh issue create --title t --body-file $ITEMNUM" 2
run "gh api -F body=@ with #N blocked"         "gh api -X PATCH repos/o/r/pulls/1 -F body=@$ITEMNUM" 2
run "chained: git push && gh pr create blocked" "git push && gh pr create --body-file $ITEMNUM" 2
run "quoted mention of the verb passes"        "echo \"then gh pr create --body-file $ITEMNUM\"" 0
run "no body file passes"                      "gh pr create --title t --body 'Must-fix #1'" 0
run "unrelated command passes"                 "ls -la" 0
run "empty command passes"                     "" 0

# --- go-to-k/cdk-local#637: the body file does not exist YET ----------------
# The hook runs BEFORE the command, so in the one-call `heredoc -> file ->
# --body-file` shape the path is absent and the pre-fix `[[ ! -f "$f" ]] &&
# continue` was a silent pass. Both sibling gates that hit this window already
# fall back to scanning the whole command; these pin the port.
ABSENT="$TMPROOT/never-written.md"
HEREDOC_BAD="cat > $ABSENT <<'EOF'
# Title

Must-fix #1: thing one
EOF
gh issue create --title t --body-file $ABSENT"
HEREDOC_OK="cat > $ABSENT <<'EOF'
# Title

Must-fix 1: thing one
EOF
gh issue create --title t --body-file $ABSENT"

run "one-call heredoc with #N in the body blocks" "$HEREDOC_BAD" 2
# The false-BLOCK direction is what the sibling gates' comments warn about: this
# is the shape the rules PRESCRIBE, so a clean body written the same way must
# pass. Without this case the arm above would also be satisfied by a hook that
# blocked every unreadable body file.
run "one-call heredoc with a clean body passes"   "$HEREDOC_OK" 0

# --- The other half of the same window --------------------------------------
# The path EXISTS, holding the PREVIOUS body, while the command rewrites it.
# Reading the file alone judges text nobody is submitting -- and does so while
# looking like a working gate, which is worse than the absent case.
STALE_REWRITE="cat > $CLEAN <<'EOF'
# Title

Must-fix #7: rewritten
EOF
gh pr create --body-file $CLEAN"
run "a stale body file is not trusted when the command rewrites it" "$STALE_REWRITE" 2

# The control that keeps the case above honest: the same clean file, NOT
# rewritten by the command, must still pass. (It is also `clean bare-number body
# passes` above, restated here so deleting either case leaves the pair visible.)
run "a clean body file the command does not rewrite passes" "gh pr create --body-file $CLEAN" 0

# --- Registration -----------------------------------------------------------
# A gate nothing invokes is a gate that does not fire, which no behavioural case
# above can detect.
registration_check() {
  local settings
  settings="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.claude/settings.json"
  if [ -f "$settings" ] && grep -q 'pr-body-item-number-gate.sh' "$settings"; then
    echo "PASS: registered in .claude/settings.json"; PASS=$((PASS + 1))
  else
    echo "FAIL: not registered in .claude/settings.json"; FAIL=$((FAIL + 1))
  fi
}
registration_check

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]
