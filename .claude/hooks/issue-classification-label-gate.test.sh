#!/usr/bin/env bash
# Smoke tests for issue-classification-label-gate.sh
#
# The gate blocks `gh issue create` / `gh issue edit` when the BODY states a
# `Severity:` / `Effort:` value that the issue's labels do not carry. Asserts,
# in both directions:
#   - PASS  when the command carries the matching `--label` / `--add-label`
#   - BLOCK when it carries none, or carries a DIFFERENT value (a label that
#           disagrees with the body is the failure mode this exists to stop)
#   - PASS  when the body states no classification at all, and when the old
#           packed shape writes `Effort: ~1-3 h` -- a DURATION, which
#           /work-issues section 3 says must NOT be read as the new `Effort`
#   - PASS  when the LABEL SPELLING appears in the command but no body line
#           does. The label form has no space after the colon and the body form
#           does, and that separation is the whole gate: relaxing the scan's
#           `[[:space:]]+` to `*` makes a `--label` satisfy its own requirement
#           and makes a passing mention of `severity:high` in a TITLE demand a
#           label. Both of those are fenced below
#   - edit: PASS when gh reports the label is ALREADY on the issue, BLOCK when
#           it reports none, PASS when gh cannot answer (fail open -- a
#           transient gh failure must not stop a body edit)
#   - PASS  for verbs deliberately not gated (`gh issue comment`), for a command
#           that merely QUOTES the trigger, and in a repo that never opted in
#
# Measured rather than asserted (2026-08-26): an always-`exit 0` stub fails 7 of
# these and an always-`exit 2` stub fails all 25, so neither direction can pass
# vacuously. A targeted mutant -- the scan's `[[:space:]]+` relaxed to `*` --
# fails 2, both named in the list above.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/issue-classification-label-gate.sh"
PASS=0
FAIL=0

# Two fixture trees, because the gate is repo-opt-in:
#   $TMPROOT  -- a git repo carrying `.markgate.yml`, so the gate fires
#   $NOOPTIN  -- a git repo without it, so the gate must stay silent
TMPBASE=$(mktemp -d)
trap 'rm -rf "$TMPBASE"' EXIT
TMPROOT="$TMPBASE/optin"
NOOPTIN="$TMPBASE/no-optin"
for d in "$TMPROOT" "$NOOPTIN"; do
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
done
printf 'gates: {}\n' > "$TMPROOT/.markgate.yml"

# A PATH-stubbed `gh`, because the edit arm asks the real service what labels an
# issue already carries. The stub answers from GH_STUB_LABELS and fails when
# GH_STUB_FAIL is set, which is the only way to exercise the fail-open arm.
STUBDIR="$TMPBASE/bin"
mkdir -p "$STUBDIR"
cat > "$STUBDIR/gh" <<'STUB'
#!/usr/bin/env bash
if [ -n "${GH_STUB_FAIL:-}" ]; then exit 1; fi
printf '%s\n' ${GH_STUB_LABELS:-}
STUB
chmod +x "$STUBDIR/gh"
PATH="$STUBDIR:$PATH"
export PATH

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
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
    FAIL=$((FAIL + 1))
  fi
}

# run_msg <name> <command> <cwd> <expected-exit> <substring the stderr must carry>
# The refusal names WHICH label is missing; asserting the exit code alone let an
# earlier draft report `effort:` for a missing `severity:` and stay green.
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
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
    FAIL=$((FAIL + 1))
  fi
}

BODY_BOTH="$TMPROOT/both.md"
cat > "$BODY_BOTH" <<'B'
The provider drops the field.

Dup-check: searched open issues -- none covers this root cause
Session-fit: next (not this session) -- needs a new fixture
Severity: high -- deploy silently ships a resource missing the property
Effort: large (L) -- a new integ fixture has to be written
Estimate: ~3 h+ -- the fixture deploys a NAT gateway
B

BODY_PACKED="$TMPROOT/packed.md"
cat > "$BODY_PACKED" <<'B'
The old packed shape, from before the five-field split.

Session-fit: next (not this session) -- Effort: ~1-3 h
Severity: medium -- one provider is missing a property
B

BODY_NONE="$TMPROOT/none.md"
printf 'Just a feature request, no classification lines.\n' > "$BODY_NONE"

# --- create -----------------------------------------------------------------
run "create: both labels present" \
  "gh issue create -t x --body-file $BODY_BOTH --label severity:high --label effort:large" \
  "$TMPROOT" 0
run_msg "create: no labels at all" \
  "gh issue create -t x --body-file $BODY_BOTH" \
  "$TMPROOT" 2 "severity:high"
run_msg "create: severity labelled, effort missing" \
  "gh issue create -t x --body-file $BODY_BOTH --label severity:high" \
  "$TMPROOT" 2 "effort:large"
run_msg "create: label DISAGREES with the body" \
  "gh issue create -t x --body-file $BODY_BOTH --label severity:low --label effort:large" \
  "$TMPROOT" 2 "severity:high"
run "create: comma-separated labels" \
  "gh issue create -t x --body-file $BODY_BOTH --label severity:high,effort:large" \
  "$TMPROOT" 0
run "create: old packed body demands only severity" \
  "gh issue create -t x --body-file $BODY_PACKED --label severity:medium" \
  "$TMPROOT" 0
run "create: body with no classification lines" \
  "gh issue create -t x --body-file $BODY_NONE" \
  "$TMPROOT" 0
# The separation the whole gate rests on: a label carries no space after the
# colon, a body line does. Without it this command would demand the label its
# own `--label` names and every command would pass vacuously.
run "create: a bare --label does not satisfy itself" \
  "gh issue create -t x --body-file $BODY_NONE --label severity:high" \
  "$TMPROOT" 0
# The other half of the same separation: a label SPELLING quoted in a title is
# not a classification. Relaxing the space rule turns this into a refusal.
run "create: the label spelling in a TITLE is not a classification" \
  "gh issue create -t 'add a severity:high label to the tracker' --body-file $BODY_NONE" \
  "$TMPROOT" 0
run "create: inline --body carrying the lines" \
  "gh issue create -t x --body 'Broken. Severity: medium -- workaround exists. Effort: small (S) -- unit tests only.' --label severity:medium --label effort:small" \
  "$TMPROOT" 0
run_msg "create: inline --body, labels absent" \
  "gh issue create -t x --body 'Broken. Severity: medium -- workaround exists.'" \
  "$TMPROOT" 2 "severity:medium"
run "create: chained after another command" \
  "git status && gh issue create -t x --body-file $BODY_BOTH --label severity:high --label effort:large" \
  "$TMPROOT" 0
run_msg "create: chained, labels absent" \
  "git status && gh issue create -t x --body-file $BODY_BOTH" \
  "$TMPROOT" 2 "severity:high"

# --- heredoc -> file -> --body-file in ONE command --------------------------
# The file does not exist at PreToolUse time, so the scan falls back to the
# whole command. This is the repo's mandated publishing shape.
HD_NO="cat > $TMPROOT/hd.md <<'EOF'
Severity: high -- users hit it in normal operation
EOF
gh issue create -t x --body-file $TMPROOT/hd.md"
HD_OK="cat > $TMPROOT/hd2.md <<'EOF'
Severity: high -- users hit it in normal operation
EOF
gh issue create -t x --body-file $TMPROOT/hd2.md --label severity:high"
run_msg "heredoc body, label absent" "$HD_NO" "$TMPROOT" 2 "severity:high"
run "heredoc body, label present"    "$HD_OK" "$TMPROOT" 0

# --- edit -------------------------------------------------------------------
GH_STUB_LABELS="bug severity:high" \
  run "edit: issue already carries the label" \
  "gh issue edit 42 --body-file $BODY_BOTH --add-label effort:large" \
  "$TMPROOT" 0
GH_STUB_LABELS="bug" \
  run_msg "edit: issue carries neither" \
  "gh issue edit 42 --body-file $BODY_BOTH" \
  "$TMPROOT" 2 "severity:high"
GH_STUB_LABELS="bug" \
  run "edit: both supplied on the command" \
  "gh issue edit 42 --body-file $BODY_BOTH --add-label severity:high --add-label effort:large" \
  "$TMPROOT" 0
GH_STUB_FAIL=1 \
  run "edit: gh cannot answer -- fail open" \
  "gh issue edit 42 --body-file $BODY_BOTH" \
  "$TMPROOT" 0
GH_STUB_LABELS="bug" \
  run "edit: issue number unresolvable -- fail open" \
  "gh issue edit --body-file $BODY_BOTH" \
  "$TMPROOT" 0

# --- not gated / not armed --------------------------------------------------
run "gh issue comment is not gated" \
  "gh issue comment 42 --body-file $BODY_BOTH" \
  "$TMPROOT" 0
run "a command that merely QUOTES the trigger" \
  "echo 'gh issue create -t x --body \"Severity: high\"'" \
  "$TMPROOT" 0
run "repo that never opted in" \
  "gh issue create -t x --body-file $BODY_BOTH" \
  "$NOOPTIN" 0
run "empty command passes" "" "$TMPROOT" 0

payload=$(jq -n '{tool_name:"Edit", tool_input:{file_path:"/tmp/x"}}')
out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
if [ "${rc:-0}" -eq 0 ]; then echo "PASS: non-Bash tool passes (exit 0)"; PASS=$((PASS + 1))
else echo "FAIL: non-Bash tool passes (exit ${rc:-0})"; FAIL=$((FAIL + 1)); fi

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]
