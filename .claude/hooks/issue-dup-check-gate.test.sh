#!/usr/bin/env bash
# Smoke tests for issue-dup-check-gate.sh
#
# Run from anywhere:  bash .claude/hooks/issue-dup-check-gate.test.sh
# `vp run test:hooks` globs `.claude/hooks/*.test.sh`, so this file is picked up
# with no registration step.
#
# The gate blocks `gh issue create` (and the `gh api repos/<o>/<r>/issues` REST
# mint) unless the body carries a `Dup-check:` line. Asserts, in both
# directions:
#   - PASS  when a --body-file / -F body=@ / inline --body carries the marker
#   - BLOCK when it does not, including when the named body file is unreadable
#   - PASS  for the verbs deliberately NOT gated (edit / comment), which is the
#           whole point: folding into an existing issue must stay untaxed
#   - BLOCK for chained and `-R` / `cd` spellings, which is where the
#           line-start-anchored ancestors of this gate family leaked
#   - PASS  for a command that merely QUOTES the trigger
#   - PASS  in a repo that never opted in (no `.markgate.yml`)
#
# Measured rather than asserted (2026-08-25, bash 5.3, re-measured against the
# final case list): an always-`exit 0` stub fails 41 of these and an
# always-`exit 2` stub fails 45, so neither direction can pass vacuously. Keep
# these numbers current when cases are added -- a stale count in a comment that
# exists to prove non-vacuity is itself the thing it warns about.

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/issue-dup-check-gate.sh"
PASS=0
FAIL=0
# Two fixture trees, because the gate is repo-opt-in:
#   $TMPROOT  -- a git repo carrying `.markgate.yml`, so the gate fires
#   $NOOPTIN  -- a git repo without it, so the gate must stay silent
# Real repos rather than mocks: the opt-in decision is exactly what
# `git rev-parse --show-toplevel` reports, so mocking it would test nothing.
TMPBASE=$(mktemp -d)
trap 'rm -rf "$TMPBASE"' EXIT
TMPROOT="$TMPBASE/optin"
NOOPTIN="$TMPBASE/no-optin"
for d in "$TMPROOT" "$NOOPTIN"; do
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
done
printf 'gates: {}\n' > "$TMPROOT/.markgate.yml"

# run_msg <name> <command> <cwd> <expected-exit> <substring the stderr must carry>
# Both refusal arms exit 2, so the exit code alone cannot tell them apart --
# deleting one arm's message would otherwise leave the suite green.
run_msg() {
  local name="$1" command="$2" cwd="$3" expect="$4" needle="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ] && printf '%s' "$out" | grep -qF "$needle"; then
    echo "PASS: $name (exit $rc, message matched)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect carrying '$needle')"
    printf '%s\n' "$out" | sed 's/^/      /' | head -4
    FAIL=$((FAIL + 1))
  fi
}

# run_nomsg <name> <command> <cwd> <expected-exit> <substring the stderr must NOT carry>
# The complement of run_msg. A conditional block in an error message needs BOTH
# directions pinned; only asserting its presence lets the condition be deleted.
run_nomsg() {
  local name="$1" command="$2" cwd="$3" expect="$4" needle="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ] && ! printf '%s' "$out" | grep -qF "$needle"; then
    echo "PASS: $name (exit $rc, message correctly omits it)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect WITHOUT '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

# run <name> <command> <cwd> <expected-exit>
run() {
  local name="$1" command="$2" cwd="$3" expect="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    echo "PASS: $name (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect)"
    echo "$out" | sed 's/^/      /' | head -5
    FAIL=$((FAIL + 1))
  fi
}

# The payload shape this hooks dir's OTHER suites build carries no `tool_name`
# (gate-command-recognition.test.sh). Defaulting an absent one to "not Bash"
# would make the gate inert for every such payload while looking green, so the
# default is pinned here in both directions.
run_no_tool_name() {
  local name="$1" command="$2" cwd="$3" expect="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    echo "PASS: $name (exit $rc)"; PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect)"; FAIL=$((FAIL + 1))
  fi
}

# run_nonbash <name> <expected-exit>
run_nonbash() {
  local payload out rc
  payload=$(jq -n '{tool_name:"Edit", tool_input:{file_path:"/tmp/x"}}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$2" ]; then echo "PASS: $1 (exit $rc)"; PASS=$((PASS + 1))
  else echo "FAIL: $1 (exit $rc, expected $2)"; FAIL=$((FAIL + 1)); fi
}

WITH="$TMPROOT/with.md"
WITHOUT="$TMPROOT/without.md"
LIST="$TMPROOT/list.md"
LOWER="$TMPROOT/lower.md"
MIDLINE="$TMPROOT/midline.md"
PLUSLIST="$TMPROOT/plus.md"
COMMITMSG="$TMPBASE/commit-msg.txt"
printf 'Some defect.\n\nDup-check: searched open issues for `route discovery` -- none covers this root cause\n' > "$WITH"
printf 'Some defect.\n\nSession-fit: next (not this session) -- needs a new fixture\n' > "$WITHOUT"
printf 'Some defect, no marker at all.\n' > "$TMPROOT/dup-check-notes.md"
printf 'Some defect.\n\n- Dup-check: searched open issues for `authorizer cache` -- none covers this\n' > "$LIST"
printf 'Some defect.\n\ndup-check: searched open issues -- none covers this root cause\n' > "$LOWER"
# The marker only mid-sentence. This is what fences MARKER_RE_LINE's ANCHOR:
# without a case whose ONLY occurrence is mid-line, the anchor could be swapped
# for the loose form and the suite would stay green -- the split the gate's
# header calls load-bearing would have no discriminating case at all.
printf 'Some defect.\n\nWe ran a dup-check: nothing turned up, honest.\n' > "$MIDLINE"
printf 'Some defect.\n\n+ Dup-Check: searched open issues -- none covers this\n' > "$PLUSLIST"
# A commit message that QUOTES the marker at LINE START, which is the realistic
# shape -- a commit message quoting the line it requires, and this repo's
# commit-msg-heredoc-gate mandates `git commit -F <file>` so the shape is the
# norm. Mid-sentence would make this fixture pass for the WRONG reason:
# MARKER_RE_LINE's anchor rejects it regardless of scoping, so the case would
# stay green with the segment scoping removed and fence nothing.
printf 'chore: add the gate\n\nThe body must carry a line of this form:\n\nDup-check: searched open issues -- none covers this root cause\n' > "$COMMITMSG"

# --- the two directions, file-borne -----------------------------------------
run "body-file carries Dup-check"        "gh issue create --title t --body-file $WITH"    "$TMPROOT" 0
run "body-file lacks Dup-check"          "gh issue create --title t --body-file $WITHOUT" "$TMPROOT" 2
run "marker as a list item"              "gh issue create --title t --body-file $LIST"    "$TMPROOT" 0
run "marker lowercased"                  "gh issue create --title t --body-file $LOWER"   "$TMPROOT" 0
run "-F body=@ form carries marker"      "gh issue create -F body=@$WITH"                 "$TMPROOT" 0
run "-F body=@ form lacks marker"        "gh issue create -F body=@$WITHOUT"              "$TMPROOT" 2
run "bare -F <file> carries marker"      "gh issue create -F $WITH"                       "$TMPROOT" 0

# An unreadable body file must BLOCK, not pass. "Cannot read" being treated as
# "nothing to object to" is the fail-open that made twelve sibling gates inert
# (go-to-k/cdkd#2027).
run "body-file path does not exist"      "gh issue create --body-file $TMPROOT/nope.md"   "$TMPROOT" 2

# Relative --body-file resolves against the payload cwd, and against a `cd` in
# command position before the verb.
run "relative body-file via payload cwd" "gh issue create --body-file with.md"                     "$TMPROOT" 0
run "relative body-file via leading cd"  "cd $TMPROOT && gh issue create --body-file with.md"      "/"        0
run "relative body-file, cd, no marker"  "cd $TMPROOT && gh issue create --body-file without.md"   "/"        2

# --- the two directions, inline ---------------------------------------------
run "inline --body carries marker"       "gh issue create --title t --body 'Bug. Dup-check: searched open issues -- none covers this'" "$TMPROOT" 0
run "inline --body lacks marker"         "gh issue create --title t --body 'Bug. Nothing else.'"                                       "$TMPROOT" 2

# --- verbs deliberately NOT gated -------------------------------------------
run "gh issue edit passes"               "gh issue edit 12 --body-file $WITHOUT"          "$TMPROOT" 0
run "gh issue comment passes"            "gh issue comment 12 --body-file $WITHOUT"       "$TMPROOT" 0
run "gh pr create passes"                "gh pr create --body-file $WITHOUT"              "$TMPROOT" 0
run "gh issue list passes"               "gh issue list --state open --search foo"        "$TMPROOT" 0

# --- spellings the line-start-anchored ancestors leaked ---------------------
run "chained after && blocks"            "git push && gh issue create --body-file $WITHOUT" "$TMPROOT" 2
run "chained after ; blocks"             "echo done; gh issue create --body-file $WITHOUT"  "$TMPROOT" 2
# `gh -R <owner/repo> issue create` is the CROSS-REPO MIRROR flow's own
# spelling, and that flow is this gate's whole reason for existing -- so this
# pair is the headline case, not an edge one. `GATE_GH_C` absorbed `-C <path>`
# only until 2026-08-25, so `GATE_RE_GH_ISSUE_CREATE` did not match these at all
# -- the same gap that let `gh -R o/r pr merge` walk past verify-pr-gate and
# integ-gate. Widening the shared absorber fixed all of them at once.
run "gh -R <repo> issue create blocks"   "gh -R go-to-k/cdk-local issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh -R <repo> with marker passes"    "gh -R go-to-k/cdk-local issue create --body-file $WITH"    "$TMPROOT" 0
run "gh --repo <repo> blocks"            "gh --repo go-to-k/cdkd issue create --body-file $WITHOUT"  "$TMPROOT" 2
run "gh --repo <repo> with marker passes" "gh --repo go-to-k/cdkd issue create --body-file $WITH"    "$TMPROOT" 0
# The `-C` and plain forms must keep the verdicts they had before the widening.
run "gh -C <dir> issue create blocks"    "gh -C $TMPROOT issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh -C <dir> with marker passes"     "gh -C $TMPROOT issue create --body-file $WITH"    "$TMPROOT" 0
run "gh -C and -R together blocks"       "gh -C $TMPROOT -R go-to-k/cdkd issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh -R on a comment still passes"    "gh -R go-to-k/cdkd issue comment 7 --body-file $WITHOUT"  "$TMPROOT" 0
# All three separators `gh` accepts. The GLUED form has no separator at all and
# is the one a hand-written flag alternation misses.
run "gh --repo=<repo> blocks"            "gh --repo=go-to-k/cdkd issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh -R=<repo> blocks"                "gh -R=go-to-k/cdkd issue create --body-file $WITHOUT"     "$TMPROOT" 2
run "gh -R<repo> glued blocks"           "gh -Rgo-to-k/cdkd issue create --body-file $WITHOUT"      "$TMPROOT" 2
run "gh -R<repo> glued with marker"      "gh -Rgo-to-k/cdkd issue create --body-file $WITH"         "$TMPROOT" 0
run "gh api mint with --repo= blocks"    "gh --repo=go-to-k/cdkd api repos/go-to-k/cdkd/issues -f title=t" "$TMPROOT" 2
run "subshell blocks"                    "(gh issue create --body-file $WITHOUT)"           "$TMPROOT" 2
run "command substitution blocks"        "URL=\$(gh issue create --body-file $WITHOUT)"     "$TMPROOT" 2

# --- quoted-body false-positive cases ---------------------------------------
# A command that merely NAMES the trigger must not fire the gate.
run "quoted mention in commit message"   "git commit -m 'docs: explain gh issue create --body-file flow'" "$TMPROOT" 0
run "quoted mention in echo"             "echo 'run: gh issue create --body-file x.md'"                   "$TMPROOT" 0

# --- repo opt-in scope -------------------------------------------------------
# A repo that never opted in must not inherit this repo's filing discipline.
# The control directly below it is what keeps these from passing merely because
# the gate is broken.
run "no .markgate.yml: not gated"        "gh issue create --body-file $NOOPTIN/x.md"       "$NOOPTIN" 0
run "outside any git repo: not gated"    "gh issue create --body-file $TMPBASE/x.md"       "$TMPBASE" 0
run "-R sibling from an opted-in cwd"    "gh -R go-to-k/cdkd issue create --body-file $WITHOUT" "$TMPROOT" 2

# --- the marker must be a LINE in a body file, not a passing mention --------
run "body-file marker only mid-sentence" "gh issue create --body-file $MIDLINE"  "$TMPROOT" 2
run "+ list prefix and odd caps accepted" "gh issue create --body-file $PLUSLIST" "$TMPROOT" 0

# --- the scans are scoped to the mint SEGMENT -------------------------------
# `-F` is `git commit`'s flag as well as gh's short `--body-file`, so an
# unscoped extraction reads the COMMIT MESSAGE and finds the marker there. Both
# orderings, because scoping only "after the verb" fixes just one of them.
run "commit -F before, gh after"  "git commit -F $COMMITMSG && gh issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh before, commit -F after"  "gh issue create --body-file $WITHOUT && git commit -F $COMMITMSG" "$TMPROOT" 2
run "grep -F pattern is not a body" "grep -F dup-check: $COMMITMSG && gh issue create --body-file $WITHOUT" "$TMPROOT" 2

# --- the opt-in `cd` must survive an EARLIER gh ----------------------------
# `gate_target_dir` stops at the first segment matching the ERE it is given, so
# a bare `gh` verb ERE makes it stop at the first gh segment and miss the `cd`.
# That is exactly the search-then-file chain this gate's own message prescribes.
run "search, cd, then file (no marker)" "gh issue list --state open --search x && cd $TMPROOT && gh issue create --body-file without.md" "$TMPBASE" 2
run "search, cd, then file (marker)"    "gh issue list --state open --search x && cd $TMPROOT && gh issue create --body-file with.md"    "$TMPBASE" 0

# --- the REST mint --------------------------------------------------------
run "gh api issues POST, no marker" "gh api repos/go-to-k/cdk-local/issues -f title=t -f body=x"                  "$TMPROOT" 2
run "gh api issues POST, marker"    "gh api repos/go-to-k/cdk-local/issues -f title=t -f 'body=x Dup-check: none'" "$TMPROOT" 0
run "gh api comments is not a mint" "gh api repos/go-to-k/cdk-local/issues/5/comments -f body=x"                   "$TMPROOT" 0
run "gh api issue edit is not a mint" "gh api -X PATCH repos/go-to-k/cdk-local/issues/5 -f body=x"                 "$TMPROOT" 0
# The issue COLLECTION path is also the LIST endpoint. `gh api .../issues` and
# `-X GET` are READS and must pass -- refusing them (which this gate did) is
# pure friction with no duplicate in sight. gh sends GET unless told otherwise
# or unless fields are supplied, so a `title=` field means mint.
run "gh api issues GET is a read"    "gh api repos/go-to-k/cdk-local/issues"                         "$TMPROOT" 0
run "gh api issues -X GET is a read" "gh api -X GET repos/go-to-k/cdk-local/issues -f state=open"    "$TMPROOT" 0
run "gh api issues -X DELETE"        "gh api -X DELETE repos/go-to-k/cdk-local/issues"               "$TMPROOT" 0
run "gh api issues -X POST blocks"   "gh api -X POST repos/go-to-k/cdk-local/issues -f title=t -f body=x" "$TMPROOT" 2
run "gh api quoted body= with marker" "gh api repos/go-to-k/cdk-local/issues -f title=t -f 'body=x Dup-check: none'" "$TMPROOT" 0
# `--input <file>` / `--input -` implies POST too (confirmed live: `GH_DEBUG=api
# gh api rate_limit --input f.json` logs `> POST`), so it mints an issue and must
# be gated like `-f title=`.
run "gh api --input mints"           "gh api repos/go-to-k/cdk-local/issues --input body.json"  "$TMPROOT" 2
run "gh api --input - mints"         "gh api repos/go-to-k/cdk-local/issues --input -"          "$TMPROOT" 2
run "gh api --input on a comment"    "gh api repos/go-to-k/cdk-local/issues/5/comments --input body.json" "$TMPROOT" 0

# The loose inline scan reads the BODY VALUE, not the whole segment. A TITLE is
# not a record of having searched anything, and `--title 'Dup-check: yes'`
# satisfied the gate with a marker-free body until this was scoped.
run "marker in --title does not count" "gh issue create --title 'Dup-check: yes' --body 'no marker here'" "$TMPROOT" 2
run "marker in --body still counts"    "gh issue create --title 'Dup-check: yes' --body 'x Dup-check: none'" "$TMPROOT" 0
run "-b short body flag"               "gh issue create -b 'Dup-check: searched, none'"                "$TMPROOT" 0
run "--body=<v> equals form"           "gh issue create --body=\"Dup-check: none\""                    "$TMPROOT" 0
# A --body-file PATH containing the word must not satisfy the loose scan: the
# body flag extractor cannot see `--body-file` (the `-` of `-file` is not `=` or
# space), so this falls through to the FILE scan and blocks on a marker-free file.
run "dup-check in the body-file PATH" "gh issue create --body-file $TMPROOT/dup-check-notes.md"       "$TMPROOT" 2
# ...and the COLON in MARKER_RE_LOOSE needs its own discriminator. The case
# above is a control: it blocks for the unrelated reason that the FILE carries
# no marker, so dropping the colon from the pattern is caught by nothing. This
# one puts `dup-check` WITHOUT a colon in the BODY, where the loose scan reads,
# so it is the case that fails if the colon goes.
run "dup-check without a colon in --body" "gh issue create --body 'see the dup-check notes file'" "$TMPROOT" 2

# --- more body-file spellings ----------------------------------------------
run "--body-file=<p> form"          "gh issue create --body-file=$WITH"        "$TMPROOT" 0
run "--body-file=<p> without"       "gh issue create --body-file=$WITHOUT"     "$TMPROOT" 2
run "quoted --body-file path"       "gh issue create --body-file \"$WITHOUT\"" "$TMPROOT" 2
run "--field body=@ without"        "gh issue create --field body=@$WITHOUT"   "$TMPROOT" 2
run "--raw-field body=@ with"       "gh issue create --raw-field body=@$WITH"  "$TMPROOT" 0

# --- both refusal arms carry their own message ------------------------------
run_msg "missing-marker message"    "gh issue create --body-file $WITHOUT" "$TMPROOT" 2 "carries no"
run_msg "unreadable-path message"   "gh issue create --body-file $TMPROOT/nope.md" "$TMPROOT" 2 "No readable --body-file"
# ...and the hint must be SUPPRESSED when a body file WAS read, or `found_body_file`
# is inert: both needles above appear in the readable-file branch too, so pinning
# `found_body_file=0` left the suite fully green. This is the missing direction.
run_nomsg "readable body file omits the path hint" "gh issue create --body-file $WITHOUT" "$TMPROOT" 2 "No readable --body-file"
# An unexpanded variable is refused through its OWN arm: a bare "check the path"
# is unclearable when the file does carry the line.
run_msg "unexpanded \$VAR message"  "gh issue create --body-file \"\$BODY\"" "$TMPROOT" 2 "unexpanded variable"

# --- the library-load guard must FAIL CLOSED -------------------------------
# Swapping the whole guard for `. lib || exit 0` leaves every other case green.
lib_fail_closed() {
  local tmp out rc
  tmp=$(mktemp -d)
  cp "$HOOK" "$tmp/gate.sh"          # no _command-match.sh beside it
  chmod +x "$tmp/gate.sh"
  out=$(jq -n '{tool_name:"Bash", tool_input:{command:"gh issue create --body-file /nope.md"}, cwd:"/"}' \
        | "$tmp/gate.sh" 2>&1) && rc=0 || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF "is missing or unreadable"; then
    echo "PASS: unloadable library fails CLOSED (exit $rc)"; PASS=$((PASS + 1))
  else
    echo "FAIL: unloadable library should exit 2 naming the library (got $rc)"; FAIL=$((FAIL + 1))
  fi
}
lib_fail_closed

# A library present but TRUNCATED past this gate's constants: `.` succeeds and
# `gate_matches` exists, so only the GATE_RE_* checks catch it.
lib_truncated_fails_closed() {
  local tmp out rc
  tmp=$(mktemp -d)
  cp "$HOOK" "$tmp/gate.sh"
  chmod +x "$tmp/gate.sh"
  sed '/^GATE_RE_GH_API_ISSUE_CREATE=/d' "$(dirname "$HOOK")/_command-match.sh" > "$tmp/_command-match.sh"
  out=$(jq -n '{tool_name:"Bash", tool_input:{command:"gh issue create --body-file /nope.md"}, cwd:"/"}' \
        | "$tmp/gate.sh" 2>&1) && rc=0 || rc=$?
  rm -rf "$tmp"
  # `_command-match.sh` alone appears in BOTH load-failure messages, so it
  # cannot tell the truncated arm from the missing arm. Pin the wording unique
  # to arm 2.
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF "loaded but is truncated"; then
    echo "PASS: library missing the constant fails CLOSED (exit $rc)"; PASS=$((PASS + 1))
  else
    echo "FAIL: truncated library should exit 2 naming the TRUNCATED arm (got $rc)"; FAIL=$((FAIL + 1))
  fi
}
lib_truncated_fails_closed

# --- the hook is actually REGISTERED ---------------------------------------
# The suite invokes the hook directly, so it would not otherwise notice the
# hook being dropped from .claude/settings.json. The `if:` matchers themselves
# are asserted by tests/unit/hooks/gate-if-matchers.test.ts.
registration_check() {
  local settings
  settings="$(cd "$(dirname "$0")/../.." && pwd)/.claude/settings.json"
  if [ -f "$settings" ] && grep -q 'issue-dup-check-gate.sh' "$settings"; then
    echo "PASS: registered in .claude/settings.json"; PASS=$((PASS + 1))
  else
    echo "FAIL: not registered in .claude/settings.json"; FAIL=$((FAIL + 1))
  fi
}
registration_check

# --- heredoc -> file -> --body-file in ONE command --------------------------
# The file does not exist at PreToolUse time. It must PASS when the heredoc body
# carries the marker at line start -- and still BLOCK when it does not.
HD_OK="cat > $TMPROOT/hd.md <<'EOF'
Some defect.

Dup-check: searched open issues -- none covers this root cause
EOF
gh issue create --body-file $TMPROOT/hd.md"
HD_NO="cat > $TMPROOT/hd2.md <<'EOF'
Some defect, nothing else.
EOF
gh issue create --body-file $TMPROOT/hd2.md"
run "heredoc body carries the marker" "$HD_OK" "$TMPROOT" 0
run "heredoc body lacks the marker"   "$HD_NO" "$TMPROOT" 2
# The fallback uses the ANCHORED marker, so a passing mention does not satisfy it.
HD_MID="cat > $TMPROOT/hd3.md <<'EOF'
We ran a dup-check: nothing turned up.
EOF
gh issue create --body-file $TMPROOT/hd3.md"
run "heredoc body mentions it mid-line" "$HD_MID" "$TMPROOT" 2

run "empty command passes" "" "$TMPROOT" 0
run_no_tool_name "absent tool_name is treated as Bash (blocks)" "gh issue create --body-file $WITHOUT" "$TMPROOT" 2
run_no_tool_name "absent tool_name is treated as Bash (passes)" "gh issue create --body-file $WITH"    "$TMPROOT" 0
run_nonbash "non-Bash tool passes" 0

# --- the shared GATE_PERL_WORD value class, and its guard --------------------
# Ported with the class from go-to-k/cdkd#2639. Three spellings were LIVE
# fail-opens here before the port, each measured rc=0 where the plain path gave
# 2: a quoted path containing a SPACE, a BACKSLASH-escaped one, and the GLUED
# `-F<path>` gh accepts. They are cases rather than a note because a value class
# that enumerates quote POSITIONS grows a new hole every time gh accepts another
# spelling.
GWDIR="$TMPROOT/gw dir"
mkdir -p "$GWDIR"
printf 'A body with no marker at all.\n' > "$GWDIR/nomark.md"
printf 'Dup-check: searched open+closed, no match\nBody.\n' > "$GWDIR/ok.md"
run "spaced --body-file path, no Dup-check, blocks" \
  "gh issue create -t x --body-file \"$GWDIR/nomark.md\"" "$TMPROOT" 2
# The FALSE BLOCK this gate carried: it fails CLOSED on an unreadable path, so a
# compliant body at a spaced path was refused for a marker it DID have.
run "spaced --body-file path, WITH Dup-check, passes" \
  "gh issue create -t x --body-file \"$GWDIR/ok.md\"" "$TMPROOT" 0
run "backslash-escaped path, WITH Dup-check, passes" \
  "gh issue create -t x --body-file ${GWDIR// /\\ }/ok.md" "$TMPROOT" 0

# --- the GATE_PERL_WORD guard is wired here, and CANNOT be fenced by a case ---
#
# The other two gates assert it: with a non-compiling prelude they exit 2 on a
# payload they normally pass, and deleting `gate_perl_word_or_die` reddens those
# cases. This gate cannot have that case, and the reason is worth stating rather
# than leaving as an absence.
#
# It fails CLOSED on an unreadable body by design (see the header): with no path
# extracted, `seg_has_marker` returns 1 and the gate BLOCKS. A broken prelude
# extracts nothing, so it lands on that same refusal -- exit 2 with the guard
# and exit 2 without it. Measured: removing `gate_perl_word_or_die` leaves this
# suite fully green, both before and after the payload was corrected.
#
# The first version of these cases passed the body-file path UNQUOTED through a
# directory whose name has a space, which made them doubly vacuous -- they were
# testing the unreadable-path refusal, not the guard. Quoting fixed that half
# and revealed the structural half underneath.
#
# The guard stays wired anyway. Relying on a coincidence of polarity is exactly
# what made this file's original miss invisible, and a later edit to
# `seg_has_marker` could reverse it without anyone noticing this gate had been
# leaning on it.

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]
