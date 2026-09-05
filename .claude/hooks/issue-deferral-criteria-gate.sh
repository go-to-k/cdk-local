#!/usr/bin/env bash
# issue-deferral-criteria-gate.sh — block `gh issue create` when the body's
# `Session-fit: next` line defers the work for a PR-SHAPED reason.
#
# WHY
#
# `Session-fit` answers ONE question: do I finish this in THIS session? The
# field reference is `.claude/rules/session-report.md`, and none of the
# criteria there is about the pull request -- splitting work across several PRs
# is normal, needs no permission and costs no session. `/work-issues` §5
# (`.claude/skills/work-issues/references/implement.md`) says so in as many
# words:
#
#   **"It needs its own PR" is NOT a `next` reason** -- it is a `now` item that
#   gets its own PR; the bar is the SESSION, not the diff. Writing
#   "independent review surface" on a `Session-fit` line is the
#   classify-by-MEANS error arriving through the PR boundary
#
# That bullet carries its own violation log: a hook missing from one sibling
# filed `next` on exactly that wording on 2026-09-01, re-classified `now` on
# the maintainer's challenge and shipped in the same session -- and the port
# then found four more defects a fresh session would not have looked for.
# go-to-k/cdkd repeated the class three times in one session on 2026-09-04
# (go-to-k/cdkd#2587 / go-to-k/cdkd#2588 / go-to-k/cdkd#2590, all three
# re-classified `now` and finished that same day). `/work-issues` §10-b is
# explicit about what happens to a rule that is written down and violated
# anyway: it escalates to a MECHANISM. This is that mechanism.
#
# WHAT IT ASKS FOR, AND WHAT IT DELIBERATELY DOES NOT
#
# It does NOT ask for a ritual. A gate demanding the body carry a "criteria
# audit" line is satisfiable by boilerplate, and a gate a sentence can satisfy
# measures typing rather than thinking. This one refuses the specific defect
# instead: a `next` line whose REASON is PR-SHAPED. Everything else passes
# untouched, including every legitimate `next` this repo documents --
#
#   Session-fit: next (not this session) -- a NEW integ fixture must be written
#   Session-fit: next (not this session) -- blocked on an upstream fix landing
#   Session-fit: next (not this session) -- verified by `/run-integ
#     local-start-api-watch` on an arm64 host, which a fresh session has
#
# and it never argues with a `Session-fit: now`, whatever that line says.
#
# It is also NOT a filing threshold: nothing here makes a finding harder to
# write down (an unfiled finding is strictly worse than a filed one). It
# changes one word in one line, or -- the outcome it actually steers toward --
# it makes you notice that the item is a `now`.
#
# WHY `unreviewable` IS IN THE VOCABULARY, AND WHY TWO RULES MOVED TO MEET IT
#
# The first cut of this port DROPPED the word (go-to-k/cdkd's copy carries it),
# because two passages here read as sanctioning a review-SIZE deferral:
# implement.md §5's "a sweep that would make the PR unreviewable is a genuine
# `next`", and .claude/rules/session-report.md's Calibration paragraph naming
# "review of a larger diff, which grows superlinearly" among the things to
# "defer on". A gate must not contradict its host repo's rules, so the word was
# left out and the divergence was fenced by two suite cases.
#
# REVERSED 2026-09-05, in the commit that carries this line. cdkd hit the
# identical tension and resolved it the OTHER way (go-to-k/cdkd#2619): the gate
# keeps `unreviewable` and the DOC is reworded, because review size is the
# SIGNAL you notice, not the criterion. Underneath it is verification the
# residue needs and this lane is not already paying -- which the `next` criteria
# list already contains. Both passages were rewritten alongside: §5's bullet now
# reads "a sweep whose residue carries its own verification is a genuine `next`"
# (the umbrella, the named sites and both drift tripwires kept verbatim), and
# Calibration now says review cost argues for SPLITTING the PR and belongs under
# `Effort`, not for ending the session. Three repos running one skill must not
# answer this differently: a divergence here is not local colour, it is one rule
# giving two answers, which is the defect this gate exists for.
#
# MEASURED, not argued (2026-09-05, `gh issue list --state all --limit 300`,
# 206 bodies, of which 74 carry a `Session-fit: next` FIELD LINE -- the anchored
# predicate this gate reads; state the predicate or the number cannot be
# reproduced, and here a bare `grep -i 'Session-fit: next'` happens to agree at
# 74):
#
#   vocabulary without `unreviewable`   fires on 10 of the 74 (14%)
#   this vocabulary (with it)           fires on 16 of the 74 (22%)
#
# The 10 are PR-SPLIT deferrals ("it wants its own PR and its own review", "must
# not share the mirror-split PR", "on an independent review surface"). The 6
# added are sweeps: go-to-k/cdk-local#569 (~54 fixtures), go-to-k/cdk-local#585
# (a repo-wide segmentation change), go-to-k/cdk-local#591 (30 fixtures),
# go-to-k/cdk-local#654 (20 fixtures), go-to-k/cdk-local#655 (a subsystem
# bundled into a 15-file PR already at the 3-axis tier) and
# go-to-k/cdk-local#665 (a fifth probe value on a three-round diff). Refusing
# those 6 is the INTENT rather than collateral: each named review size where it
# owed the claim underneath, and several already named the next session's
# verification command -- so a re-filing states the real criterion and passes.
#
# WHAT IS AND IS NOT GATED
#
#   gated:      gh issue create   -- the site where a deferral is FIRST decided
#               gh api repos/<o>/<r>/issues -- the same mint through REST
#   not gated:  gh issue edit     -- re-classification is the outcome this gate
#               gh issue comment     wants; taxing it would penalise the fix
#
# Same split, and the same reasoning, as issue-dup-check-gate.sh.
#
# KNOWN LIMITS, all measured rather than assumed:
#
#   - A body passed INLINE as one physical line has no line structure, so the
#     reason runs to the end of that line and a PR-shaped phrase belonging to a
#     later field is read as part of it. That is the over-approximating
#     direction (a loud, clearable block), and the file-borne shape this repo
#     mandates for issue bodies does not have it.
#   - A one-call body written to an EXISTING path by something other than a
#     heredoc (`printf > f`, `python3 -c ... > f`) cannot be extracted from the
#     command text, so the scan falls back to what is on disk -- the PREVIOUS
#     body. The heredoc shape, which is the one this repo mandates, is CLOSED
#     (see `segment_body_text` arm 1); this remainder is the same limit
#     pr-body-item-number-gate.sh carries and names.
#   - The vocabulary is a closed list, so a reworded PR-shaped reason passes.
#     Deliberate: see the note on PR_SHAPE_RE.
#   - A PR-shaped reason quoted INLINE, in running prose, to argue against it
#     still needs the bypass. A quote inside a ``` fence does not: fenced
#     blocks are stripped before the scan.
#
# ESCAPE HATCH: CDKL_SKIP_DEFERRAL_CRITERIA_GATE=1, honored from the hook's own
# process env AND from a leading assignment AT THE START of the command text.
# An agent's Bash call cannot populate a PreToolUse hook's environment -- the
# hook is spawned with the session's env -- so a text channel is the only one a
# refusal can honestly advertise (the go-to-k/cdkd#2368 lesson, where an
# advertised remediation silently did nothing). It is anchored at offset 0 of
# the command rather than at any command position, and that is a DELIBERATE
# narrowing: this repo's `_command-match.sh` has no `strip_noncommand_spans`,
# so a mid-command scan could not tell an assignment from the same text quoted
# inside a body, and a bypass that a body can spell is not a bypass. Offset 0
# cannot be inside a quoted span. `cd <repo> && CDKL_...=1 gh issue create` is
# therefore NOT a bypass -- put the assignment first, which is the spelling the
# refusal prints. The hatch exists for the case this gate cannot see: a body
# quoting someone else's PR-shaped reasoning in order to argue against it, and
# only for the INLINE quote. The commonest shape of that body, a ``` fenced
# exhibit, needs no bypass (see `scan_text`): a body should not have to disarm
# a gate to talk about the rule the gate enforces.

set -u

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash issue-deferral-criteria-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
# The shared matcher lives at `_command-match.sh` here and at
# `lib/command-match.sh` in go-to-k/cdkd. Try both rather than forking the
# file: the two spellings are the ONLY difference between the copies, and a
# fork is how they drift. FAIL CLOSED -- a gate that cannot evaluate the
# command must not wave it through; `|| exit 0` here is what silently disabled
# ten sibling gates (go-to-k/cdkd#2130 review).
# shellcheck source=_command-match.sh
if ! . "$__hook_dir/_command-match.sh" 2>/dev/null \
  && ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null; then
  echo "Blocked: the shared command matcher (_command-match.sh or" >&2
  echo "lib/command-match.sh) is missing or unloadable, so" >&2
  echo "issue-deferral-criteria-gate cannot evaluate the command." >&2
  echo "Restore the file; do not work around the gate." >&2
  exit 2
fi
# A matcher that loaded but predates the constants this gate needs is the same
# hazard one step later. `declare -F` also catches a partial source.
if ! declare -F gate_matches >/dev/null 2>&1 \
  || ! declare -F gate_segments >/dev/null 2>&1 \
  || [ -z "${GATE_RE_GH_ISSUE_CREATE:-}" ]; then
  echo "Blocked: the shared command matcher loaded but is missing gate_matches," >&2
  echo "gate_segments or GATE_RE_GH_ISSUE_CREATE, so" >&2
  echo "issue-deferral-criteria-gate cannot evaluate the command." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool_name" = "Bash" ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

[ "${CDKL_SKIP_DEFERRAL_CRITERIA_GATE:-}" = "1" ] && exit 0
# The text channel, anchored at offset 0 -- see the ESCAPE HATCH note above for
# why it is not a general command-position scan.
case "$cmd" in
  CDKL_SKIP_DEFERRAL_CRITERIA_GATE=1[[:space:]]*) exit 0 ;;
esac

# Command-position matching, so a body or comment that merely QUOTES
# `gh issue create` does not arm the gate (.claude/rules/hooks.md). The verb
# that matched is kept, because `gate_target_dir` below has to read the SAME
# segment this gate is judging.
gate_re=""
for gate_candidate in "$GATE_RE_GH_ISSUE_CREATE" "${GATE_RE_GH_API_ISSUE_CREATE:-}"; do
  [ -n "$gate_candidate" ] || continue
  if gate_matches "$cmd" "$gate_candidate"; then
    gate_re="$gate_candidate"
    break
  fi
done
[ -n "$gate_re" ] || exit 0

# --- resolve the target directory ONCE --------------------------------------
# Both the opt-in check and the relative `--body-file` resolution need the same
# directory and must agree. `gate_target_dir` is this repo's shared resolver: a
# `-C <path>` inside the MATCHED segment wins, else the last `cd <path>` before
# it, else the payload cwd. Using it rather than a hand-rolled scan is what
# keeps `gh -C "/a b" issue create` and the
# `gh issue list --search x && cd <repo> && gh issue create` chain (the shape
# `/work-issues` §5 prescribes) resolving to the right tree.
target_dir="${hook_cwd:-$PWD}"
if declare -F gate_target_dir >/dev/null 2>&1; then
  _resolved=$(gate_target_dir "$cmd" "$target_dir" "$gate_re" 2>/dev/null || true)
  [ -n "$_resolved" ] && target_dir="$_resolved"
fi

# --- repo opt-in ------------------------------------------------------------
# A session rooted here regularly files issues in unrelated personal repos,
# where this repo's `Session-fit` vocabulary does not exist and a refusal is
# pure friction. So the gate fires only in a repo that opts in by carrying
# `.markgate.yml` at its root, matching issue-dup-check-gate.sh. The CWD's repo
# decides, not any `-R <owner/repo>`: `-R` names where the issue LANDS, the cwd
# names whose policy the session is operating under -- and the cross-repo
# mirror flow (`/work-issues` §10-c) files into a sibling from here, which is
# exactly a filing this repo wants classified.
optin_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$optin_top" ] || exit 0
[ -f "$optin_top/.markgate.yml" ] || exit 0

# --- the PR-shaped reason vocabulary ----------------------------------------
# Deliberately a SHORT closed list of the spellings implement.md §5 names as
# errors, not an attempt to enumerate every way a person could say "PR". The
# threat model is an agent reaching for the cheap justification it has seen
# before, not one evading a regex: someone who rewords the reason to dodge this
# has had to read the criteria to do it, which is the entire ask. `unreviewable`
# IS in the list, matching the sibling gates -- see the header for the
# 2026-09-05 reversal and the rule rewrites that came with it.
#
# `prs?` is bounded by `([^[:alnum:]]|$)` rather than `\b` -- `\b` is a GNU
# extension that BSD regcomp does not carry, so on macOS it would match nothing
# and the gate would be inert.
PR_SHAPE_RE='(own|separate)[[:space:]]+prs?([^[:alnum:]]|$)'
PR_SHAPE_RE="$PR_SHAPE_RE"'|shar(e|es|ing)[[:space:]]+((a|an|the|its|their)[[:space:]]+)?prs?([^[:alnum:]]|$)'
PR_SHAPE_RE="$PR_SHAPE_RE"'|(independent|separate)[[:space:]]+review[[:space:]]+surface'
PR_SHAPE_RE="$PR_SHAPE_RE"'|unreviewable'
PR_SHAPE_RE="$PR_SHAPE_RE"'|own[[:space:]]+review([^[:alnum:]]|$)'

OFFENDING_REASON=""

pr_shaped() { # <reason text> -> 0 when it is PR-shaped, and records it
  [[ $1 =~ $PR_SHAPE_RE ]] || return 1
  OFFENDING_REASON=$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  return 0
}

# Scan a body for a `Session-fit: next` line whose reason is PR-shaped.
#
# The reason continues onto WRAPPED lines, and that is not a refinement: an
# issue body written to 76 columns puts "needs its own PR" on the line AFTER
# `Session-fit: next (not this session) -- this touches a different subsystem
# and`, and a line-only scan would read the first half and pass. A continuation
# ends at a blank line, at the next `Key:` field (`Severity:` / `Effort:` /
# `Estimate:` / `Dup-check:` / `Notes:`, list-prefixed or not), at a LIST ITEM,
# or at a markdown heading -- so a wrapped reason is read whole while the
# SIBLING fields, which are nobody's reason, are not folded in.
#
# The LIST-ITEM boundary is not decoration either. This repo's own report
# template puts the four fields under a `- TODO #<N>` bullet as nested bullets,
# so a body reading
#
#   Session-fit: next (not this session) -- blocked on an upstream fix
#   - the sibling cleanup would need its own PR, so it is filed separately
#
# folded the bullet into the reason and refused a deferral whose stated reason
# is a documented criterion. A bullet starts a new block in markdown exactly
# like a blank line or a heading does; it is a boundary for the same reason.
#
# FENCED CODE BLOCKS are removed before the scan (the same allow-list
# pr-body-item-number-gate.sh applies, and for the same reason). A body arguing
# ABOUT this rule quotes the refused line to do it, and quoting it inside a
# ```text fence is how a markdown body says "this is an exhibit, not an
# assertion". Without the strip, the FIRST `Session-fit:` match wins and
# `break`s, so a body whose own classification is `Session-fit: now` is refused
# over the exhibit above it -- and the advertised remedy (the bypass variable)
# is exactly what a body of that shape should not have to reach for.
#
# A `**Session-fit:**` / `**Session-fit**:` spelling is read like the bare one:
# .claude/rules/session-report.md bolds every field name in its prose, so the
# spelling is one copy-paste away.
#
# `nocasematch` is enabled for the duration of this function and restored on the
# way out rather than set once at the top of the file, and that scoping is
# load-bearing: the shared matcher's `gate_matches` is a `[[ =~ ]]` too, so a
# file-wide `nocasematch` would silently widen EVERY gate verb this hook matches
# (`GH ISSUE CREATE` would arm it). It is used instead of a `[Ss]`-class regex
# or a `tr` pass because the reason has to be REPORTED BACK in its original
# casing, and lowercasing to match would mean carrying two copies of every line.
scan_text() { # <body text> -> 0 when the body carries a PR-shaped deferral
  local text="$1" line rest active=0 reason="" rc=1 nocase_was=0 fence=0 fence_mark=""
  # A fence line is `` ``` `` or `~~~`, indented or not. The CONTENT of the
  # block is invisible to the scan; the fence line itself also closes an open
  # continuation, because a fenced block starts a new markdown block exactly
  # like a heading does.
  # A fence OPENS only when its own closer appears later, and closes only on the
  # SAME marker. Both halves are load-bearing: latching on any opener with no
  # look-ahead makes an UNCLOSED fence blank every remaining line (rc=0 where
  # the pre-fence hook said 2), and ignoring the marker type lets a ``` line
  # inside a ~~~ block close it early. This is the exact class
  # .claude/rules/hooks.md documents for heredoc openers -- "latching onto any
  # <<WORD blanks every remaining line, fail open" -- so the look-ahead is
  # copied from that solution rather than re-derived.
  local fence_open_re='^[[:space:]]*(```|~~~)'
  # `[*_]*` on both sides of the colon accepts `**Severity:**` and
  # `**Severity**:`. Keeping the two boundary tests in sync with the key
  # spelling `session_fit_re` accepts is load-bearing: a body that bolds one
  # field bolds them all, so a bold-blind boundary would fold the whole field
  # block into the reason.
  local key_re='^[[:space:]]*([-*+>][[:space:]]+)?[*_]*[A-Za-z][A-Za-z_-]*[*_]*:'
  local item_re='^[[:space:]]*([-*+]|[0-9]+[.)])[[:space:]]+'
  local session_fit_re='session-fit[*_]*:[*_]*(.*)$'
  case "$(shopt -p nocasematch)" in *-s*) nocase_was=1 ;; esac
  shopt -s nocasematch
  # Buffered into an array rather than streamed, because the opener has to look
  # AHEAD for its own closer. Built with a read loop, not `mapfile` -- the hook
  # suites run under macOS bash 3.2 (`HOOK_BASH`), where `mapfile` does not
  # exist and would be a runtime error, which for a gate is a silent pass.
  local -a lines=()
  local n=0
  while IFS= read -r line; do
    lines[$n]="$line"
    n=$((n + 1))
  done <<EOF
$text
EOF
  local i=0 j
  while [ "$i" -lt "$n" ]; do
    line="${lines[$i]}"
    i=$((i + 1))
    if [[ $line =~ $fence_open_re ]]; then
      local mark="${BASH_REMATCH[1]}" closes=0
      if [ "$fence" = "1" ]; then
        # Close only on the marker that opened it.
        if [ "$mark" = "$fence_mark" ]; then fence=0; fence_mark=""; fi
        continue
      fi
      # Open only if this same marker recurs LATER; a stray fence line must not
      # swallow the rest of the body.
      j=$i
      while [ "$j" -lt "$n" ]; do
        case "${lines[$j]}" in
          *"$mark"*)
            if [[ ${lines[$j]} =~ ^[[:space:]]*"$mark" ]]; then closes=1; break; fi
            ;;
        esac
        j=$((j + 1))
      done
      if [ "$closes" = "1" ]; then
        fence=1
        fence_mark="$mark"
        if [ "$active" = "1" ]; then
          active=0
          if pr_shaped "$reason"; then rc=0; break; fi
        fi
        continue
      fi
      # Not a real fence -- fall through and treat it as ordinary text.
    fi
    if [ "$fence" = "1" ]; then
      continue
    fi
    if [ "$active" = "1" ]; then
      if [[ $line =~ ^[[:space:]]*$ ]] \
        || [[ $line =~ $key_re ]] \
        || [[ $line =~ $item_re ]] \
        || [[ $line =~ ^[[:space:]]*\# ]]; then
        active=0
        if pr_shaped "$reason"; then rc=0; break; fi
      else
        reason="$reason $line"
      fi
    fi
    if [[ $line =~ $session_fit_re ]]; then
      # A second `Session-fit:` closes whatever the first one opened.
      if [ "$active" = "1" ]; then
        if pr_shaped "$reason"; then rc=0; break; fi
      fi
      rest="${BASH_REMATCH[1]}"
      # ONLY `next` is gated. `now` is never refused, whatever its reason says
      # -- an agent talking itself INTO finishing the work needs no supervision.
      # A line stating neither token (an old packed body, a `Session-fit` in
      # prose) is not a deferral decision this gate can read, so it passes.
      if [[ $rest =~ ^[[:space:]]*next([^[:alpha:]]|$) ]]; then
        reason="$rest"
        active=1
      else
        active=0
        reason=""
      fi
    fi
  done
  if [ "$rc" != "0" ] && [ "$active" = "1" ]; then
    pr_shaped "$reason" && rc=0
  fi
  [ "$nocase_was" = "1" ] || shopt -u nocasematch
  return "$rc"
}

# --- reading the body the command is about to WRITE -------------------------
# These three are this repo's own extraction, lifted from
# pr-body-item-number-gate.sh (go-to-k/cdk-local#637), whose comments carry the
# full derivation; the subtleties are restated here only where this gate would
# break without them.
#
# `cmd_appends_path` and `cmd_rewrites_path` answer DIFFERENT questions and must
# not be collapsed: `>>` / `tee -a` APPEND, so what is on disk is the FIRST HALF
# of the body being submitted and still has to be scanned; only `>` / `tee`
# supersede it.
cmd_rewrites_path() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e '
    my $c = $ENV{CMD};
    my $t = quotemeta($ENV{TARGET});
    # (?<!>) keeps `>>f` out of the `>f` arm while leaving `1>f` / `2>f` in it.
    # The trailing class covers the TIGHT spellings -- `>f<<EOF`, `>f;`, `>f&&`
    # -- which a `(?:\s|$)` terminator misses, and `>f<<EOF` is the very shape
    # this exists for.
    exit 0 if $c =~ /(?<!>)>\s*(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
    exit 0 if $c =~ /\btee\b(?!\s+-a\b)(?:\s+-[^a\s-][^\s]*)*\s+(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
    exit 1;
  ' 2>/dev/null
}

cmd_appends_path() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e '
    my $c = $ENV{CMD};
    my $t = quotemeta($ENV{TARGET});
    exit 0 if $c =~ />>\s*(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
    exit 0 if $c =~ /\btee\b(?:\s+-[^\s]*)*\s+-a\b(?:\s+-[^\s]*)*\s+(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
    exit 1;
  ' 2>/dev/null
}

# EVERY heredoc body that writes the path, in order. Both orders
# (`cat > f <<EOF` and `cat <<EOF > f`), quoted and unquoted delimiters, and
# `<<-`, whose terminator may be indented by TABS only -- stripping all leading
# whitespace makes an indented `  EOF` INSIDE the body end the extraction early,
# so everything after it goes unscanned while bash still submits it. The STATUS,
# not the output, reports whether a heredoc was found: an empty heredoc body is
# legal and prints nothing.
heredoc_bodies_for() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e '
    my $c = $ENV{CMD};
    my $t = quotemeta($ENV{TARGET});
    my @lines = split /\n/, $c, -1;
    my @out;
    my $found = 0;
    for (my $i = 0; $i <= $#lines; $i++) {
      my $l = $lines[$i];
      next unless $l =~ /(?:>>?|\btee\b(?:\s+-[^\s]*)*)\s*(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
      next unless $l =~ /(<<-?)\s*(["\x27]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
      my $dash  = ($1 eq "<<-");
      my $delim = $3;
      $found = 1;
      my $j = $i + 1;
      while ($j <= $#lines) {
        my $probe = $lines[$j];
        $probe =~ s/^\t+// if $dash;
        last if $probe eq $delim;
        push @out, $lines[$j];
        $j++;
      }
      # Resume AFTER this body and do NOT stop at the first: one path can be
      # written by more than one heredoc in one command.
      $i = $j;
    }
    print join("\n", @out), "\n" if @out;
    exit($found ? 0 : 1);
  ' 2>/dev/null
}

# Each matcher is offered BOTH spellings of the path -- the one the command
# writes and the one it hands to gh -- because they need not be the same string
# (`cat > /abs/b.md ... --body-file b.md`), and either half alone leaves that
# shape unscanned: the write-detection matches against the RAW COMMAND TEXT, so
# handed only the resolved absolute path it matches nothing whenever the command
# writes a RELATIVE or `~/` path. The short-circuit on equality saves a perl
# spawn on the common absolute spelling.
cmd_rewrites_either() { # <raw spelling> <resolved path>
  cmd_rewrites_path "$1" && return 0
  [ "$1" = "$2" ] && return 1
  cmd_rewrites_path "$2"
}
cmd_appends_either() { # <raw spelling> <resolved path>
  cmd_appends_path "$1" && return 0
  [ "$1" = "$2" ] && return 1
  cmd_appends_path "$2"
}
heredoc_bodies_either() { # <raw spelling> <resolved path>
  heredoc_bodies_for "$1" && return 0
  [ "$1" = "$2" ] && return 1
  heredoc_bodies_for "$2"
}

# The BODY text of ONE segment, in descending order of specificity:
#
#   1. the HEREDOC BODY that this command writes to the named `--body-file`,
#      when it writes one -- this is the arm that closes the fail-open
#   2. the contents of the file at that path, unless arm 1 fired AND the command
#      REWRITES the path (an APPEND leaves the existing content as the first
#      half of the submitted body)
#   3. the WHOLE command, when such a path was named, cannot be read, and no
#      heredoc writes it -- a `printf > f` body, or an unresolvable `$VAR` path
#   4. the inline `--body` value, plus the `-f`/`--field` `body=` forms the REST
#      mint uses, quote-aware so a multi-word body stays one value
#
# ARM 1 IS NOT AN OPTIMISATION. The hook runs BEFORE the command, so in the
# one-call `heredoc -> file -> --body-file` shape this repo MANDATES, the path
# either does not exist yet or still holds what a PREVIOUS call left there. A
# file-first read judges that previous body, so a stale-but-clean file makes the
# gate INERT against the body actually being submitted -- the go-to-k/cdk-local#637
# window, closed here at the outset rather than after a measurement.
#
# There is deliberately NO last-resort "scan the whole segment" arm, which is
# where this diverges from issue-classification-label-gate.sh. That gate must
# find a value SOMEWHERE or its labels mean nothing; this one objects to content
# it FINDS, so a fallback that folds `--title` and `--label` text in can only
# manufacture false blocks -- a title reading `Session-fit: next handling for its
# own PR` is a title about the rule, not a deferral. pr-body-item-number-gate.sh
# reached the same verdict from its own measurement.
segment_body_text() { # <segment>
  local seg="$1" f f_raw out="" hd have_hd
  while IFS= read -r f_raw; do
    [ -n "$f_raw" ] || continue
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT. Treat it like an unreadable path and fall back to the whole command
    # rather than refusing: unlike dup-check, this gate demands nothing be
    # PRESENT, so "cannot read" is not evidence of a violation.
    case "$f_raw" in
      *'$'*|*'`'*) out="$out
$cmd"; continue ;;
    esac
    # BOTH spellings are kept. `f` is the path to READ; `f_raw` is the path as
    # the command SPELLS it.
    #
    # A literal `~` in the command string is text, not something to expand -- a
    # real tilde would already have been expanded by the shell before gh ran.
    # shellcheck disable=SC2088
    f="$f_raw"
    case "$f" in
      /*) ;;
      "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
      *) f="$target_dir/$f" ;;
    esac
    hd=""
    have_hd=0
    if [ ! -r "$f" ] || cmd_rewrites_either "$f_raw" "$f" || cmd_appends_either "$f_raw" "$f"; then
      hd=$(heredoc_bodies_either "$f_raw" "$f") && have_hd=1
    fi
    if [ "$have_hd" = "1" ]; then
      out="$out
$hd"
      # Only a REWRITE supersedes what is on disk. After an append the file is
      # still the first half of the submitted body.
      if cmd_rewrites_either "$f_raw" "$f"; then
        continue
      fi
    fi
    if [ -r "$f" ]; then
      out="$out
$(cat "$f" 2>/dev/null || true)"
    elif [ "$have_hd" != "1" ]; then
      out="$out
$cmd"
    fi
  # `body=@` is matched FIRST so an `-F body=@path` is not also read as a bare
  # `-F path`. The bare `-F <path>` arm is not optional: `-F` is gh's short
  # `--body-file`.
  done < <(printf '%s' "$seg" | perl -0777 -ne '
      while (/(?:--field|--raw-field|-F)[=\s]+(["\x27]?)body=\@([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/--body-file[=\s]+(["\x27]?)([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/(?:^|\s)-F[=\s]+(["\x27]?)([^"\x27\s=]+)\1(?=\s|$)/g) { print "$2\n"; }
    ' 2>/dev/null)

  if [ -n "$out" ]; then
    printf '%s' "$out"
    return 0
  fi

  printf '%s' "$seg" | perl -0777 -ne '
    while (/(?:^|\s)--body[=\s]+("(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\S+)/g) {
      my $v = $1;
      $v =~ s/^["\x27]//; $v =~ s/["\x27]$//;
      print "$v\n";
    }
    while (/(?:^|\s)(?:-f|--field|--raw-field)[=\s]+("(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\S+)/g) {
      my $v = $1;
      $v =~ s/^["\x27]//; $v =~ s/["\x27]$//;
      next unless $v =~ s/^body=//;
      next if $v =~ /^\@/;
      print "$v\n";
    }' 2>/dev/null
}

# EVERY scan is scoped to the SEGMENT that is the `gh issue create`, never to
# the whole command, and the scoping is load-bearing in BOTH directions here.
# `-F` is `git commit`'s flag as well as gh's short `--body-file`, so an
# unscoped extraction reads the COMMIT MESSAGE -- and commit messages quote the
# lines they describe (the commit introducing this gate quotes a PR-shaped
# `Session-fit: next` line as the thing it refuses). Unscoped, that commit's own
# `git commit -F <msg> && gh issue create --body-file <clean>` would have been
# refused over text that is not the issue body at all.
offending_seg=""
while IFS= read -r seg; do
  if ! gate_matches "$seg" "$GATE_RE_GH_ISSUE_CREATE"; then
    if [ -z "${GATE_RE_GH_API_ISSUE_CREATE:-}" ] \
      || ! gate_matches "$seg" "$GATE_RE_GH_API_ISSUE_CREATE"; then
      continue
    fi
  fi
  body_text=$(segment_body_text "$seg")
  [ -n "$body_text" ] || continue
  if scan_text "$body_text"; then
    offending_seg="$seg"
    break
  fi
done < <(gate_segments "$cmd")

[ -n "$offending_seg" ] || exit 0

{
  echo "Blocked by issue-deferral-criteria-gate: this \`gh issue create\` body"
  echo "defers the work with a PR-SHAPED reason:"
  echo ""
  echo "  Session-fit: ${OFFENDING_REASON}"
  echo ""
  echo "PR shape is not a \`Session-fit\` criterion. From"
  echo "\`.claude/skills/work-issues/references/implement.md\` section 5:"
  echo ""
  echo "  \"'It needs its own PR' is NOT a \`next\` reason -- it is a \`now\`"
  echo "   item that gets its own PR; the bar is the SESSION, not the diff."
  echo "   Writing 'independent review surface' on a \`Session-fit\` line is"
  echo "   the classify-by-MEANS error arriving through the PR boundary.\""
  echo ""
  echo "What this repo DOES accept for a \`next\`, per"
  echo "\`.claude/rules/session-report.md\` and implement.md section 5:"
  echo ""
  echo "  - you can NAME the concrete command the next session will run to"
  echo "    verify the fix, and a FRESH session plainly has it (an existing"
  echo "    \`local-*\` fixture needing only Docker, a \`vp test run <path>\""
  echo "    assertion, an ordinary \`gh\` query) -- and RUNNING an existing"
  echo "    integ is never a deferral reason (median 85 s over 268 rows)"
  echo "  - what the Calibration paragraph calls genuinely expensive: WRITING"
  echo "    a new fixture, an integ that FAILS, or a verifier bound to a host"
  echo "    / account this session cannot reach"
  echo "  - external input: an upstream fix, a maintainer decision, a quota"
  echo "  - a SWEEP whose RESIDUE carries its own verification -- file an"
  echo "    umbrella naming every site, and say which sites this lane DID"
  echo "    close (implement.md section 5). State it in the CRITERIA's terms:"
  echo "    review size is the signal you noticed, and \`unreviewable\` is"
  echo "    refused here for that reason -- name the verification the residue"
  echo "    needs and this lane is not already paying, or it is a \`now\`."
  echo ""
  echo "And nothing is a \`next\` inside a cross-repo scope the user framed as"
  echo "one session. If none of the above fires, this is a \`now\`: ask what the"
  echo "next session would have to RE-DERIVE -- a probe, a measurement, a shape"
  echo "just proved correct in a sibling repo does not survive in an issue body."
  echo ""
  echo "Two ways out, both of which leave the gate doing its job:"
  echo ""
  echo "  - re-classify: \`Session-fit: now (do it in this session)\` -- and do"
  echo "    it in this session, splitting the PR if the diff wants splitting"
  echo "  - re-state the real reason, if one of the criteria above genuinely"
  echo "    fires, and NAME the next session's verification command beside it"
  echo ""
  echo "Deliberate exception (a body QUOTING PR-shaped reasoning INLINE, in"
  echo "prose, in order to argue against it -- a quote inside a \`\`\` fenced"
  echo "block needs no bypass; fenced blocks are not scanned). The assignment"
  echo "must come FIRST in the command, before any \`cd\`:"
  echo ""
  echo "  CDKL_SKIP_DEFERRAL_CRITERIA_GATE=1 gh issue create ..."
  echo ""
  echo "Rules: .claude/rules/session-report.md (the four TODO fields);"
  echo "/work-issues section 5 (\"'It needs its own PR' is NOT a \`next\` reason\")."
} >&2
exit 2
