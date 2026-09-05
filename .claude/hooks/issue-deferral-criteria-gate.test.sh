#!/usr/bin/env bash
# Smoke tests for issue-deferral-criteria-gate.sh
#
# Run from anywhere:  bash .claude/hooks/issue-deferral-criteria-gate.test.sh
# `vp run test:hooks` globs `.claude/hooks/*.test.sh`, so this file is picked up
# with no registration step.
#
# The gate blocks `gh issue create` when the body's `Session-fit: next` line
# defers the work for a PR-SHAPED reason ("needs its own PR", "a separate PR",
# "independent review surface", "its own review surface"). Asserts, in both
# directions:
#
#   - BLOCK for every PR-shaped spelling in the vocabulary, inline and
#     file-borne
#   - BLOCK for `unreviewable` too, wrapped as well as inline. The port first
#     dropped that word because implement.md section 5 and
#     .claude/rules/session-report.md's Calibration paragraph both blessed a
#     review-SIZE deferral; both were reworded on 2026-09-05 (matching
#     go-to-k/cdkd#2619) so that review size is the SIGNAL and the criterion is
#     the verification the residue needs. These two cases are the fence against
#     the word drifting back OUT of the vocabulary.
#   - PASS for the same sweep re-stated in the criteria's terms — the umbrella
#     filing the reworded section 5 asks for. The pair is what makes the block
#     above a rewording tax rather than a filing threshold: an N-sites sweep is
#     still deferrable, it just has to say WHY in a term `Session-fit` owns.
#   - PASS  for every LEGITIMATE `next` reason, including one that mentions a
#     PR without being PR-SHAPED (an upstream PR is external input, which IS a
#     criterion) — the gate keys on the reasoning, not on the token `PR`
#   - PASS  for `Session-fit: now`, whatever its reason says, and for a body
#     with no `Session-fit` line at all: this gate has exactly one job and the
#     two sibling issue gates own filing hygiene
#   - PASS  for `gh issue edit` / `gh issue comment` carrying the same text —
#     re-classification is the outcome the gate steers toward
#   - PASS  outside an opted-in repo
#   - correct in BOTH directions on the `git commit -F <msg> && gh issue create
#     --body-file <body>` shape: `-F` is `git commit`'s flag as well as gh's
#     short `--body-file`, so an unscoped extraction reads the COMMIT MESSAGE
#     and manufactures a FALSE BLOCK from a neighbouring segment
#   - BLOCK on the one-call `heredoc -> file -> --body-file` shape when the path
#     ALREADY EXISTS (the go-to-k/cdk-local#637 window): a stale-but-clean file
#     makes a file-first gate judge the PREVIOUS body and pass, which is the
#     dangerous direction — a run that looks like a working gate
#   - PASS for a body ARGUING about this rule that quotes the refused line
#     inside a fenced code block, while the same quote UNFENCED still blocks
#   - BLOCK on a `**Session-fit:**` / `**Session-fit**:` bolded key
#   - PASS for a legitimate reason followed by a list item (this repo's own
#     report template nests the four fields as bullets)
#
# MUTATION-PROBED rather than asserted, re-measured 2026-09-05 over the 87
# cases below, under bash 3.2 (the harness default). A tally says how many
# cases ran, not what any of them fences, so each fence was broken in the real
# hook and the survivors counted:
#
#   always-`exit 0` stub                     fails 50   (nothing passes vacuously)
#   always-`exit 2` stub                     fails 43   (nor does anything block
#                                                        vacuously)
#   `next` polarity test -> `if true`        fails  2   -- exactly the two
#                                                        `Session-fit: now` cases
#   continuation boundary -> `if false`      fails  4   -- the sibling field-line
#                                                        case plus the bold-key,
#                                                        bullet and numbered-item
#                                                        cases: the boundary is
#                                                        load-bearing, not
#                                                        decoration
#   segment scoping reverted (scan `$cmd`)   fails  4   -- both neighbouring-
#                                                        segment cases, plus the
#                                                        subshell and command-
#                                                        substitution spellings
#   fence strip -> never matches             fails  2   -- exactly the two
#                                                        fenced-exhibit cases
#   bolded-key accept reverted               fails  2   -- exactly the two bold
#                                                        spellings
#   list-item boundary -> never matches      fails  2   -- exactly the bullet and
#                                                        numbered-item cases
#   heredoc arm 1 removed (file-first)       fails  3   -- the fail-open case, its
#                                                        false-block complement,
#                                                        and the relative spelling
#   `cmd_rewrites_either` -> `return 0`      fails  1   -- exactly the APPEND case,
#                                                        so "an append is not a
#                                                        rewrite" is fenced apart
#                                                        from "the command writes"
#   raw path spelling dropped                fails  1   -- exactly the relative
#                                                        case, so offering BOTH
#                                                        spellings to the matchers
#                                                        is fenced
#   `unreviewable` dropped from PR_SHAPE_RE  fails  2   -- exactly the two sweep
#                                                        cases, so the word is
#                                                        FENCED into the list
#                                                        rather than merely
#                                                        commented into it
#
# Keep these numbers current when cases are added — a stale count in a comment
# that exists to prove non-vacuity is itself the thing it warns about.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/issue-deferral-criteria-gate.sh"
pass=0
fail=0

TMPBASE=$(mktemp -d)
trap 'rm -rf "$TMPBASE"' EXIT

# bash 3.2 is NOT exercised on the HOOK by running THIS FILE under /bin/bash.
# The hook's shebang is `#!/usr/bin/env bash`, which resolves through PATH and
# finds whatever bash is first there -- Homebrew 5.x on a dev Mac -- so
# `/bin/bash <suite>` would measure the SUITE under 3.2 and the SUBJECT under
# 5.x. `HOOK_BASH` puts a `bash` shim first on PATH so the shebang, the explicit
# `bash "$HOOK"` calls, and any `bash` the hook itself spawns all follow the
# harness. DEFAULTED to `/bin/bash` (3.2 on macOS) rather than left opt-in,
# matching `pr-body-item-number-gate.test.sh` and `gate-command-recognition.test.sh`
# in this repo: nothing sets `HOOK_BASH` in `vp run test:hooks`, so an opt-in
# fence measures 5.x in CI forever. Override with
# `HOOK_BASH=/opt/homebrew/bin/bash bash <this file>` to take the 5.x tally.
# It matters here specifically: this hook uses `shopt -s nocasematch`, `[[ =~ ]]`
# with variable regexes, an array built by a read loop (NOT `mapfile`, which
# does not exist in 3.2) and process substitution.
HOOK_BASH="${HOOK_BASH:-/bin/bash}"
[ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
if [ -n "${HOOK_BASH:-}" ]; then
  # Resolved to an ABSOLUTE path first: `HOOK_BASH=bash` would otherwise make
  # `ln -sf bash <shim>/bash` a symlink pointing at ITSELF, and every hook
  # invocation would die on ELOOP -- a suite-wide red with a cause nowhere near
  # the hook.
  HOOK_BASH_BIN="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")"
  case "$HOOK_BASH_BIN" in /*) ;; *) HOOK_BASH_BIN="$PWD/$HOOK_BASH_BIN" ;; esac
  HOOK_BASH_SHIM="$TMPBASE/bash32-shim"
  mkdir -p "$HOOK_BASH_SHIM"
  ln -sf "$HOOK_BASH_BIN" "$HOOK_BASH_SHIM/bash"
  PATH="$HOOK_BASH_SHIM:$PATH"
  export PATH
fi
# PRINTED, not merely honoured: a suite that does not say which interpreter it
# measured cannot be read as evidence about either one.
printf 'hook interpreter: %s (bash %s)\n' \
  "$(command -v bash)" "$(bash -c 'echo "$BASH_VERSION"')"

# `jq` must exist for the hook to parse the payload. Without it the hook reads
# an EMPTY command and every BLOCK case would pass vacuously, so refuse to run
# rather than report a green suite over nothing. `perl` is what the heredoc
# extraction runs on; `git` is what the repo opt-in reads.
for tool in jq perl git; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "FATAL: $tool is required; without it cases would pass vacuously." >&2
    exit 1
  }
done

invoke_hook() { # <hook path>; reads stdin
  "$HOOK_BASH" "$1"
}
invoke_hook_env() { # <VAR=value> <hook path>; reads stdin
  env "$1" "$HOOK_BASH" "$2"
}

# Two fixture trees, because the gate is repo-opt-in:
#   $OPTIN   -- a git repo carrying `.markgate.yml`, so the gate fires
#   $NOOPTIN -- a git repo without it, so the gate must stay silent
# Real repos rather than mocks: the opt-in decision is exactly what
# `git rev-parse --show-toplevel` reports, so mocking it would test nothing.
OPTIN="$TMPBASE/optin"
NOOPTIN="$TMPBASE/no-optin"
for d in "$OPTIN" "$NOOPTIN"; do
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
done
printf 'gates: {}\n' > "$OPTIN/.markgate.yml"

# run <name> <command> <cwd> <expected-exit>
run() {
  local name="$1" command="$2" cwd="$3" expect="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | invoke_hook "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    printf 'OK   %-62s (exit %s)\n' "$name" "$rc"
    pass=$((pass + 1))
  else
    printf 'FAIL %s (exit %s, expected %s)\n' "$name" "$rc" "$expect"
    printf '%s\n' "$out" | sed 's/^/       /' | head -5
    fail=$((fail + 1))
  fi
}

# run_msg <name> <command> <cwd> <expected-exit> <substring the stderr carries>
# The refusal QUOTES the offending line back, and that is the half a bare exit
# code cannot see: a gate that blocks while naming the wrong line teaches the
# reader to distrust it.
run_msg() {
  local name="$1" command="$2" cwd="$3" expect="$4" needle="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | invoke_hook "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ] && printf '%s' "$out" | grep -qF "$needle"; then
    printf 'OK   %-62s (message matched)\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s (exit %s, expected %s carrying %s)\n' "$name" "$rc" "$expect" "$needle"
    printf '%s\n' "$out" | sed 's/^/       /' | head -6
    fail=$((fail + 1))
  fi
}

# run_env <name> <VAR=value> <command> <cwd> <expected-exit>
run_env() {
  local name="$1" env_assign="$2" command="$3" cwd="$4" expect="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | invoke_hook_env "$env_assign" "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    printf 'OK   %-62s (exit %s)\n' "$name" "$rc"
    pass=$((pass + 1))
  else
    printf 'FAIL %s (exit %s, expected %s)\n' "$name" "$rc" "$expect"
    fail=$((fail + 1))
  fi
}

# --- fixtures ---------------------------------------------------------------
# Every body carries the full four-field block, because that is the shape a real
# filing has: a fixture holding only the `Session-fit` line would not exercise
# the continuation boundary at all, and the boundary is what keeps `Severity:`
# from being read as part of the reason.
mkbody() { # <path> <session-fit line>
  {
    printf 'The ALB router drops a nested condition on reload.\n\n'
    printf '%s\n' "$2"
    printf 'Severity: medium -- the condition is silently not applied\n'
    printf 'Effort: small (S) -- edit plus unit tests\n'
    printf 'Estimate: ~30 min -- the unit fixture already exists\n'
    printf 'Dup-check: searched open issues for `nested condition` -- none covers it\n'
  } > "$1"
}

OWNPR="$OPTIN/own-pr.md"
SEPPR="$OPTIN/separate-pr.md"
SURFACE="$OPTIN/surface.md"
SEPSURFACE="$OPTIN/sep-surface.md"
SHAREPR="$OPTIN/share-pr.md"
OWNREVIEW="$OPTIN/own-review.md"
FIXTURE="$OPTIN/fixture.md"
UPSTREAM="$OPTIN/upstream.md"
NAMEDCMD="$OPTIN/named-cmd.md"
NOWPR="$OPTIN/now-pr.md"
NOFIT="$OPTIN/no-fit.md"
WRAPPED="$OPTIN/wrapped.md"
SIBLING="$OPTIN/sibling.md"
CAPS="$OPTIN/caps.md"
SWEEP="$OPTIN/sweep.md"
SWEEPWRAP="$OPTIN/sweep-wrapped.md"
SWEEPOK="$OPTIN/sweep-restated.md"

mkbody "$OWNPR"     'Session-fit: next (not this session) -- this needs its own PR'
mkbody "$SEPPR"     'Session-fit: next (not this session) -- a separate PR, so the diff stays small'
mkbody "$SURFACE"   'Session-fit: next (not this session) -- an independent review surface'
mkbody "$SEPSURFACE" 'Session-fit: next (not this session) -- a separate review surface from this lane'
mkbody "$SHAREPR"   'Session-fit: next (not this session) -- a schema bump must not share a PR with a fix'
# The literal 2026-09-02 spelling implement.md section 5 records as the error.
mkbody "$OWNREVIEW" 'Session-fit: next (not this session) -- a behaviour change across three repos with its own review surface'
# The legitimate criteria, in this repo's own vocabulary.
mkbody "$FIXTURE"   'Session-fit: next (not this session) -- a NEW integ fixture must be written'
# A `next` whose reason MENTIONS a PR without being PR-SHAPED: an upstream PR is
# external input, which IS a criterion. This is the control that keeps the
# vocabulary closed -- widen the regex to any mention of `PR` and this fails.
mkbody "$UPSTREAM"  'Session-fit: next (not this session) -- blocked on upstream PR aws/aws-cdk#123 landing'
# The honest use of `next` implement.md section 5 describes: NAME the command.
mkbody "$NAMEDCMD"  'Session-fit: next (not this session) -- verified by /run-integ local-start-alb-watch on an arm64 host, which a fresh session has'
# `now` is never argued with, whatever the reason says.
mkbody "$NOWPR"     'Session-fit: now (do it in this session) -- it lands in files this session has open; it will get its own PR'
mkbody "$CAPS"      'SESSION-FIT: NEXT (NOT THIS SESSION) -- IT NEEDS ITS OWN PR'
# The sweep deferral, spelled the way implement.md section 5 USED to print it.
# Refused since 2026-09-05: review size is the signal, not the criterion, and a
# body reaching for `unreviewable` has skipped saying what verification the
# residue needs. The word being live here is what keeps this gate answering the
# same way as its two sibling repos.
mkbody "$SWEEP"     'Session-fit: next (not this session) -- a sweep of all 14 sites would make the PR unreviewable; umbrella filed'
# The SAME sweep, re-stated in the criteria's terms -- the umbrella filing the
# reworded section 5 asks for. Without this case the block above would read as a
# filing threshold; with it, it reads as the rewording tax it is.
mkbody "$SWEEPOK"   'Session-fit: next (not this session) -- the residue is 13 more fixtures, each needing a Docker run this lane is not paying for; umbrella filed naming every site'

# No `Session-fit` line at all: other gates own filing hygiene, this one has
# exactly one job.
{
  printf 'The ALB router drops a nested condition on reload.\n\n'
  printf 'Fixing it needs its own PR because the diff touches two subsystems.\n'
} > "$NOFIT"
# The reason WRAPS. A 76-column issue body routinely puts the PR-shaped half on
# the following line, and a line-only scan reads the first half and passes.
{
  printf 'The ALB router drops a nested condition on reload.\n\n'
  printf 'Session-fit: next (not this session) -- this touches a different\n'
  printf 'subsystem entirely and so needs its own PR\n'
  printf 'Severity: low -- internal tidiness\n'
} > "$WRAPPED"
# The same, wrapped: `unreviewable` may arrive on a continuation line, which a
# line-only scan would read past -- the refusal has to survive the wrap exactly
# as the PR-SPLIT spellings do.
{
  printf 'Fourteen call sites share one wrong assumption.\n\n'
  printf 'Session-fit: next (not this session) -- sweeping every site would\n'
  printf 'make the PR unreviewable, so the umbrella lists them\n'
  printf 'Severity: low -- internal tidiness\n'
} > "$SWEEPWRAP"
# The complement of the WRAPPED case: the PR-shaped words sit on a SIBLING FIELD
# line, which is nobody's `Session-fit` reason. Folding the following lines in
# unconditionally turns this into a false block.
{
  printf 'The ALB router drops a nested condition on reload.\n\n'
  printf 'Session-fit: next (not this session) -- a NEW integ fixture must be written\n'
  printf 'Notes: it will land as its own PR once the fixture exists\n'
} > "$SIBLING"

# --- fence / bold / list-item fixtures --------------------------------------
# A body ARGUING ABOUT this rule quotes the refused line to do it, inside a
# ```text fence, and classifies ITSELF `now`. Without the fence strip the first
# `Session-fit:` match wins and `break`s, so the exhibit is read as the body's
# own decision and the filing is refused -- with a remedy (the bypass) that a
# body of this shape should never have to reach for.
FENCED="$OPTIN/fenced.md"
{
  printf 'The deferral gate should not need a bypass to be discussed.\n\n'
  printf 'The line it refuses looks like:\n\n'
  printf '```text\n'
  printf 'Session-fit: next (not this session) -- this needs its own PR\n'
  printf '```\n\n'
  printf 'Session-fit: now (do it in this session) -- the evidence exists only here\n'
  printf 'Severity: medium -- the rule is unenforced until this lands\n'
} > "$FENCED"
# The control that keeps the strip honest: the SAME quotation in running prose,
# unfenced, is indistinguishable from an assertion and still blocks (the inline
# quote is what the bypass is for).
UNFENCED="$OPTIN/unfenced.md"
{
  printf 'The deferral gate should not need a bypass to be discussed.\n\n'
  printf 'The line it refuses looks like:\n\n'
  printf 'Session-fit: next (not this session) -- this needs its own PR\n\n'
  printf 'Session-fit: now (do it in this session) -- the evidence exists only here\n'
} > "$UNFENCED"
# An UNCLOSED fence must NOT swallow the rest of the body. Latching on any
# opener with no look-ahead is the exact class .claude/rules/hooks.md documents
# for heredoc openers ("blanks every remaining line, fail open").
UNCLOSED_FENCE="$OPTIN/unclosed-fence.md"
{
  printf 'Dup-check: searched.\n\n'
  printf '```text\n'
  printf 'a fence nobody closed\n\n'
  printf 'Session-fit: next (not this session) -- this needs its own PR\n'
  printf 'Severity: low -- probe\n'
} > "$UNCLOSED_FENCE"
# A ``` line INSIDE a ~~~ block must not close it, and the ~~~ block must not
# stay open past its own closer.
MIXED_FENCE="$OPTIN/mixed-fence.md"
{
  printf 'Dup-check: searched.\n\n'
  printf '~~~text\n'
  printf 'an inner ``` line\n'
  printf '~~~\n\n'
  printf 'Session-fit: next (not this session) -- this needs its own PR\n'
  printf 'Severity: low -- probe\n'
} > "$MIXED_FENCE"
# A ~~~ fence is a fence too.
FENCED_TILDE="$OPTIN/fenced-tilde.md"
{
  printf 'Quoting the refused line:\n\n'
  printf '~~~\n'
  printf 'Session-fit: next (not this session) -- this needs its own PR\n'
  printf '~~~\n\n'
  printf 'Session-fit: now (do it in this session) -- it lands in open files\n'
} > "$FENCED_TILDE"

# A BOLDED key. .claude/rules/session-report.md bolds every field name, so
# the bolded spelling is one copy-paste away -- and `rest` would otherwise
# become `** next (not this session) ...`, which the `^[[:space:]]*next`
# polarity test rejects, passing a PR-shaped deferral in silence. Both markdown
# spellings, because they put the asterisks on opposite sides of the colon.
BOLDFIT="$OPTIN/bold-fit.md"
{
  printf 'The ALB router drops a nested condition on reload.\n\n'
  printf '**Session-fit:** next (not this session) -- this needs its own PR\n'
  printf '**Severity:** medium -- the condition is silently not applied\n'
} > "$BOLDFIT"
BOLDFIT2="$OPTIN/bold-fit-2.md"
{
  printf 'The ALB router drops a nested condition on reload.\n\n'
  printf '**Session-fit**: next (not this session) -- it deserves its own review\n'
} > "$BOLDFIT2"
# The control: a bolded key with a LEGITIMATE reason must still pass. Without
# the matching `[*_]*` in the continuation boundary, `**Severity:**` stops
# looking like a field line and the sibling text folds into the reason.
BOLDOK="$OPTIN/bold-ok.md"
{
  printf 'The ALB router drops a nested condition on reload.\n\n'
  printf '**Session-fit:** next (not this session) -- a NEW integ fixture must be written\n'
  printf '**Severity:** low -- internal tidiness\n'
  printf '**Notes:** it will land as its own PR once the fixture exists\n'
} > "$BOLDOK"

# A legitimate reason followed by a BULLET -- the shape this repo's own report
# template produces, where the four fields are nested bullets under a
# `- TODO #<N>` item.
BULLET="$OPTIN/bullet.md"
{
  printf 'The deploy path cannot be exercised without the upstream fix.\n\n'
  printf 'Session-fit: next (not this session) -- blocked on an upstream fix landing\n'
  printf -- '- the sibling cleanup would need its own PR, so it is filed separately\n'
  printf 'Severity: low -- nothing regresses meanwhile\n'
} > "$BULLET"
# The control: the boundary must not become a blanket amnesty. PR-shaped text on
# the `Session-fit` line itself still blocks, bullet or no bullet.
BULLETBAD="$OPTIN/bullet-bad.md"
{
  printf 'Session-fit: next (not this session) -- this needs its own PR\n'
  printf -- '- an unrelated follow-up bullet\n'
} > "$BULLETBAD"
# Numbered list items are list items too.
NUMLIST="$OPTIN/numlist.md"
{
  printf 'Session-fit: next (not this session) -- blocked on an upstream fix landing\n'
  printf '1. the sibling cleanup would need its own PR\n'
} > "$NUMLIST"

# A commit message that QUOTES a PR-shaped deferral -- the realistic shape,
# since the commit introducing this gate has to describe what it refuses.
COMMITMSG="$TMPBASE/commit-msg.txt"
{
  printf 'chore(hooks): refuse PR-shaped Session-fit deferrals\n\n'
  printf 'The line this gate refuses looks like:\n\n'
  printf 'Session-fit: next (not this session) -- this needs its own PR\n'
} > "$COMMITMSG"
CLEANMSG="$TMPBASE/clean-msg.txt"
printf 'chore(hooks): add a gate\n' > "$CLEANMSG"

echo "== BLOCK: every PR-shaped spelling ========================================="
run "inline --body: its own PR"        "gh issue create --title t --body 'Bug. Session-fit: next -- this needs its own PR'" "$OPTIN" 2
run "body-file: its own PR"            "gh issue create --title t --body-file $OWNPR"      "$OPTIN" 2
run "body-file: separate PR"           "gh issue create --title t --body-file $SEPPR"      "$OPTIN" 2
run "body-file: independent review surface" "gh issue create --body-file $SURFACE"         "$OPTIN" 2
run "body-file: separate review surface"    "gh issue create --body-file $SEPSURFACE"      "$OPTIN" 2
run "body-file: must not share a PR"   "gh issue create --body-file $SHAREPR"              "$OPTIN" 2
run "body-file: its own review surface (the 2026-09-02 spelling)" \
  "gh issue create --body-file $OWNREVIEW"                                                 "$OPTIN" 2
run "inline --body: sharing a PR"      "gh issue create --body 'Session-fit: next -- sharing a PR with the fix would hide it'" "$OPTIN" 2
run "matching is case-insensitive"     "gh issue create --body-file $CAPS"                 "$OPTIN" 2
run "the reason may WRAP onto the next line" "gh issue create --body-file $WRAPPED"        "$OPTIN" 2
run "body-file: an unreviewable SWEEP"      "gh issue create --body-file $SWEEP"            "$OPTIN" 2
run "the same word across a WRAPPED reason" "gh issue create --body-file $SWEEPWRAP"        "$OPTIN" 2

echo "== PASS: every legitimate deferral ========================================="
run "the sweep RE-STATED in the criteria's terms" "gh issue create --body-file $SWEEPOK"    "$OPTIN" 0
run "a NEW integ fixture must be written" "gh issue create --body-file $FIXTURE"            "$OPTIN" 0
run "external input: an upstream PR"      "gh issue create --body-file $UPSTREAM"           "$OPTIN" 0
run "the honest next: names the command"  "gh issue create --body-file $NAMEDCMD"           "$OPTIN" 0
run "Session-fit: now mentioning its own PR" "gh issue create --body-file $NOWPR"           "$OPTIN" 0
run "inline now mentioning its own PR"    "gh issue create --body 'Session-fit: now -- and it gets its own PR'" "$OPTIN" 0
run "no Session-fit line at all"          "gh issue create --body-file $NOFIT"              "$OPTIN" 0
run "inline body, no Session-fit line"    "gh issue create --body 'Needs its own PR, obviously.'" "$OPTIN" 0
run "PR words on a SIBLING field line"    "gh issue create --body-file $SIBLING"            "$OPTIN" 0

echo "== verbs deliberately NOT gated ==========================================="
# Re-classifying an already-filed issue is the outcome this gate steers toward,
# so the verbs that do it must never be taxed.
run "gh issue edit passes"        "gh issue edit 12 --body-file $OWNPR"      "$OPTIN" 0
run "gh issue comment passes"     "gh issue comment 12 --body-file $OWNPR"   "$OPTIN" 0
run "gh pr create passes"         "gh pr create --body-file $OWNPR"          "$OPTIN" 0
run "gh issue list passes"        "gh issue list --state open --search foo"  "$OPTIN" 0

echo "== the REST mint =========================================================="
run "gh api issues POST, PR-shaped" "gh api repos/go-to-k/cdk-local/issues -f title=t -f 'body=Session-fit: next -- needs its own PR'" "$OPTIN" 2
run "gh api issues POST, legitimate" "gh api repos/go-to-k/cdk-local/issues -f title=t -f 'body=Session-fit: next -- a NEW integ fixture must be written'" "$OPTIN" 0
run "gh api comments is not a mint"  "gh api repos/go-to-k/cdk-local/issues/5/comments -f 'body=Session-fit: next -- own PR'" "$OPTIN" 0

echo "== spellings a line-start-anchored matcher would leak ======================"
run "chained after && blocks"      "git push && gh issue create --body-file $OWNPR"   "$OPTIN" 2
run "chained after ; blocks"       "echo done; gh issue create --body-file $OWNPR"    "$OPTIN" 2
run "subshell blocks"              "(gh issue create --body-file $OWNPR)"             "$OPTIN" 2
run "command substitution blocks"  "URL=\$(gh issue create --body-file $OWNPR)"       "$OPTIN" 2
run "gh -R <repo> issue create blocks" "gh -R go-to-k/cdk-local issue create --body-file $OWNPR" "$OPTIN" 2

echo "== the scans are scoped to the gh SEGMENT ================================="
# `-F` is `git commit`'s flag as well as gh's short `--body-file`, so an
# unscoped extraction reads the COMMIT MESSAGE. Both orderings, and both
# directions, because scoping only "after the verb" fixes just one of them.
run "PR-shaped text in a NEIGHBOURING segment passes" \
  "git commit -F $COMMITMSG && gh issue create --body-file $FIXTURE" "$OPTIN" 0
run "neighbouring segment, gh first, passes" \
  "gh issue create --body-file $FIXTURE && git commit -F $COMMITMSG" "$OPTIN" 0
# The other direction: a clean neighbour must not shadow the real body.
run "clean commit -F before a PR-shaped body still blocks" \
  "git commit -F $CLEANMSG && gh issue create --body-file $OWNPR" "$OPTIN" 2
run "clean commit -F after a PR-shaped body still blocks" \
  "gh issue create --body-file $OWNPR && git commit -F $CLEANMSG" "$OPTIN" 2

echo "== repo opt-in scope ======================================================"
cp "$OWNPR" "$NOOPTIN/own-pr.md"
run "no .markgate.yml: not gated"     "gh issue create --body-file $NOOPTIN/own-pr.md" "$NOOPTIN" 0
run "outside any git repo: not gated" "gh issue create --body-file $OWNPR"             "$TMPBASE" 0
run "-R sibling from an opted-in cwd" "gh -R go-to-k/cdkd issue create --body-file $OWNPR" "$OPTIN" 2

echo "== relative paths and the cd chain ========================================"
run "relative body-file via payload cwd" "gh issue create --body-file own-pr.md"                "$OPTIN" 2
run "relative body-file via leading cd"  "cd $OPTIN && gh issue create --body-file own-pr.md"   "/"      2
# `gate_target_dir` reads the last `cd` BEFORE the matched segment, so the
# search-then-cd-then-file chain `/work-issues` section 5 prescribes resolves.
run "search, cd, then file (PR-shaped)"  "gh issue list --state open --search x && cd $OPTIN && gh issue create --body-file own-pr.md" "$TMPBASE" 2
run "search, cd, then file (legitimate)" "gh issue list --state open --search x && cd $OPTIN && gh issue create --body-file fixture.md" "$TMPBASE" 0
# `gh -C <dir>` in the matched segment wins over the payload cwd.
run "gh -C <dir> resolves the opt-in tree" "gh -C $OPTIN issue create --body-file own-pr.md" "$TMPBASE" 2

echo "== more body-file spellings ==============================================="
run "--body-file=<p> form"      "gh issue create --body-file=$OWNPR"       "$OPTIN" 2
run "--body-file=<p> legitimate" "gh issue create --body-file=$FIXTURE"    "$OPTIN" 0
run "quoted --body-file path"   "gh issue create --body-file \"$OWNPR\""   "$OPTIN" 2
run "-F body=@ form"            "gh issue create -F body=@$OWNPR"          "$OPTIN" 2
run "bare -F <file> form"       "gh issue create -F $OWNPR"                "$OPTIN" 2
run "--raw-field body=@ form"   "gh issue create --raw-field body=@$OWNPR" "$OPTIN" 2

echo "== the unreadable-path window ============================================="
# Unlike issue-dup-check-gate.sh, an unreadable body file must NOT block: that
# gate demands a line be PRESENT, so "cannot read" is evidence of a miss, while
# this one objects to content it FINDS and a refusal would be unclearable.
run "unreadable body-file, nothing offending" "gh issue create --body-file $OPTIN/nope.md" "$OPTIN" 0
run "unexpanded \$VAR path, nothing offending" "gh issue create --body-file \"\$BODY\""    "$OPTIN" 0
run "unexpanded \$VAR path, PR-shaped inline"  "gh issue create --body-file \"\$BODY\" --title 'x' # Session-fit: next -- own PR" "$OPTIN" 2

echo "== heredoc -> file -> --body-file in ONE command ==========================="
# The file does not exist at PreToolUse time. This is the repo's mandated
# publishing shape, so a PR-shaped body written that way must still be caught,
# and a legitimate one must still pass.
HD_BAD="cat > $OPTIN/hd.md <<'EOF'
The ALB router drops a nested condition.

Session-fit: next (not this session) -- this needs its own PR
EOF
gh issue create --body-file $OPTIN/hd.md"
HD_OK="cat > $OPTIN/hd2.md <<'EOF'
The ALB router drops a nested condition.

Session-fit: next (not this session) -- a NEW integ fixture must be written
EOF
gh issue create --body-file $OPTIN/hd2.md"
run "heredoc body is PR-shaped"  "$HD_BAD" "$OPTIN" 2
run "heredoc body is legitimate" "$HD_OK"  "$OPTIN" 0

echo "== the heredoc window when the path ALREADY EXISTS ========================="
# The go-to-k/cdk-local#637 shape with a file already on disk: reading the file
# alone judges a body nobody is submitting, in BOTH directions -- it can miss,
# and it can BLOCK a clean submission quoting a line that will not exist.
STALE_OK="$OPTIN/stale-ok.md"
mkbody "$STALE_OK" 'Session-fit: next (not this session) -- a NEW integ fixture must be written'
STALE_BAD="$OPTIN/stale-bad.md"
mkbody "$STALE_BAD" 'Session-fit: next (not this session) -- this needs its own PR'
run "existing CLEAN file, heredoc rewrites it PR-shaped" \
  "cat > $STALE_OK <<'EOF'
Session-fit: next (not this session) -- this needs its own PR
EOF
gh issue create --body-file $STALE_OK" "$OPTIN" 2
run "existing PR-shaped file, heredoc rewrites it CLEAN" \
  "cat > $STALE_BAD <<'EOF'
Session-fit: next (not this session) -- a NEW integ fixture must be written
EOF
gh issue create --body-file $STALE_BAD" "$OPTIN" 0
# An APPEND does not supersede: the file is the FIRST HALF of the submitted
# body, so its PR-shaped line is still being published. Collapsing `rewrites`
# and `appends` into one predicate is the regression this pins.
run "APPEND leaves the existing PR-shaped half scanned" \
  "cat >> $STALE_BAD <<'EOF'
Estimate: ~30 min -- the unit fixture already exists
EOF
gh issue create --body-file $STALE_BAD" "$OPTIN" 2
# The RELATIVE spelling. The write-detection matches against raw command TEXT,
# so handing it only the resolved absolute path leaves this shape unscanned.
STALE_REL_OK="$OPTIN/stale-rel.md"
mkbody "$STALE_REL_OK" 'Session-fit: next (not this session) -- a NEW integ fixture must be written'
run "relative spelling, existing file, heredoc PR-shaped" \
  "cd $OPTIN && cat > stale-rel.md <<'EOF'
Session-fit: next (not this session) -- this needs its own PR
EOF
gh issue create --body-file stale-rel.md" "/" 2

echo "== a body ARGUING about the rule: fenced blocks are not scanned ============"
run "fenced backtick-text exhibit, own fit is now" "gh issue create --body-file $FENCED"       "$OPTIN" 0
run "fenced ~~~ exhibit, own fit is now"           "gh issue create --body-file $FENCED_TILDE" "$OPTIN" 0
run "the same quote UNFENCED still blocks"         "gh issue create --body-file $UNFENCED"     "$OPTIN" 2
run "an UNCLOSED fence does not swallow the body"  "gh issue create --body-file $UNCLOSED_FENCE" "$OPTIN" 2
run "a mismatched inner marker does not close a ~~~ block" "gh issue create --body-file $MIXED_FENCE" "$OPTIN" 2

echo "== a BOLDED key is still a key ============================================"
run "bold **Session-fit:** PR-shaped"  "gh issue create --body-file $BOLDFIT"  "$OPTIN" 2
run "bold **Session-fit**: PR-shaped"  "gh issue create --body-file $BOLDFIT2" "$OPTIN" 2
run "bold key, legitimate reason"      "gh issue create --body-file $BOLDOK"   "$OPTIN" 0

echo "== a LIST ITEM ends the reason, like a blank line or a heading ============="
run "legitimate reason then a bullet"        "gh issue create --body-file $BULLET"    "$OPTIN" 0
run "legitimate reason then a numbered item" "gh issue create --body-file $NUMLIST"   "$OPTIN" 0
run "PR-shaped ON the fit line, then a bullet" "gh issue create --body-file $BULLETBAD" "$OPTIN" 2

echo "== quoted mentions of the trigger ========================================="
run "quoted mention in commit message" "git commit -m 'docs: explain gh issue create --body-file flow'" "$OPTIN" 0
run "quoted mention in echo"           "echo 'run: gh issue create --body-file own-pr.md'"             "$OPTIN" 0

echo "== the escape hatch, both channels ========================================"
run_env "bypass via the process env" "CDKL_SKIP_DEFERRAL_CRITERIA_GATE=1" \
  "gh issue create --body-file $OWNPR" "$OPTIN" 0
# The TEXT channel is the only one an agent's Bash call can actually deliver (a
# PreToolUse hook is spawned with the session env), and it is the spelling the
# refusal advertises -- go-to-k/cdkd#2368, where the advertised remediation
# silently did nothing and the suite certified the failure.
run "bypass via a leading assignment at the START of the command" \
  "CDKL_SKIP_DEFERRAL_CRITERIA_GATE=1 gh issue create --body-file $OWNPR" "$OPTIN" 0
# The DELIBERATE narrowing: not at offset 0, not a bypass. This repo's matcher
# has no `strip_noncommand_spans`, so a mid-command scan could not tell an
# assignment from the same text quoted inside a body -- and the refusal prints
# the assignment-first spelling for exactly this reason.
run "assignment after a cd is NOT a bypass" \
  "cd $OPTIN && CDKL_SKIP_DEFERRAL_CRITERIA_GATE=1 gh issue create --body-file own-pr.md" "$OPTIN" 2
# A QUOTED mention of the bypass is not a bypass.
run "quoted mention of the bypass does not bypass" \
  "gh issue create --title 'CDKL_SKIP_DEFERRAL_CRITERIA_GATE=1 is the hatch' --body-file $OWNPR" "$OPTIN" 2

echo "== the refusal names the offending line and the local rules ================"
run_msg "refusal quotes the offending reason" "gh issue create --body-file $OWNPR" "$OPTIN" 2 \
  "this needs its own PR"
# The quoted line is RENDERED as a body would spell it -- `Session-fit:` then a
# space -- rather than stitched back on without one.
run_msg "refusal renders the key with its space" "gh issue create --body-file $OWNPR" "$OPTIN" 2 \
  "Session-fit: next (not this session) -- this needs its own PR"
run_msg "refusal names THIS repo's rule files" "gh issue create --body-file $OWNPR" "$OPTIN" 2 \
  ".claude/skills/work-issues/references/implement.md"
run_msg "refusal names the session-report field reference" "gh issue create --body-file $OWNPR" "$OPTIN" 2 \
  ".claude/rules/session-report.md"
run_msg "refusal names the sanctioned sweep carve-out" "gh issue create --body-file $OWNPR" "$OPTIN" 2 \
  "RESIDUE carries its own verification"
run_msg "refusal names the bypass, with the CDKL_ prefix" "gh issue create --body-file $OWNPR" "$OPTIN" 2 \
  "CDKL_SKIP_DEFERRAL_CRITERIA_GATE=1"

echo "== the library guard must FAIL CLOSED ====================================="
lib_fail_closed() {
  local tmp out rc
  tmp=$(mktemp -d)
  cp "$HOOK" "$tmp/gate.sh"          # no _command-match.sh beside it
  chmod +x "$tmp/gate.sh"
  out=$(jq -n --arg d "$OPTIN" '{tool_name:"Bash", tool_input:{command:"gh issue create --body-file /nope.md"}, cwd:$d}' \
        | invoke_hook "$tmp/gate.sh" 2>&1) && rc=0 || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF "command-match.sh"; then
    printf 'OK   %-62s (exit %s)\n' "unloadable library fails CLOSED" "$rc"
    pass=$((pass + 1))
  else
    printf 'FAIL unloadable library should exit 2 naming the library (got %s)\n' "$rc"
    fail=$((fail + 1))
  fi
}
lib_fail_closed

echo "== the hook is actually REGISTERED ========================================"
# The suite invokes the hook directly, so it would not otherwise notice the hook
# being dropped from .claude/settings.json. The TS-side twin
# (tests/unit/hooks/gate-if-matchers.test.ts) checks the `if:` patterns; this
# one is here so a shell-only run still sees a de-registration.
registration_check() {
  local settings
  settings="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.claude/settings.json"
  if [ -f "$settings" ] && grep -q 'issue-deferral-criteria-gate.sh' "$settings"; then
    printf 'OK   %-62s\n' "registered in .claude/settings.json"
    pass=$((pass + 1))
  else
    printf 'FAIL not registered in .claude/settings.json\n'
    fail=$((fail + 1))
  fi
}
registration_check

echo "== payload edge cases ====================================================="
run "empty command passes" "" "$OPTIN" 0
nonbash_check() {
  local out rc
  out=$(jq -n '{tool_name:"Edit", tool_input:{file_path:"/tmp/x"}}' | invoke_hook "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'OK   %-62s (exit %s)\n' "non-Bash tool passes" "$rc"
    pass=$((pass + 1))
  else
    printf 'FAIL non-Bash tool should pass (got %s)\n' "$rc"
    fail=$((fail + 1))
  fi
}
nonbash_check

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
