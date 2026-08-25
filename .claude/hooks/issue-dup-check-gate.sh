#!/usr/bin/env bash
# issue-dup-check-gate.sh -- block `gh issue create` unless the body carries a
# `Dup-check:` line recording that the OPEN issue list was searched for an issue
# already covering this root cause.
#
# WHY, FOR THIS REPO (measured 2026-08-25, go-to-k/cdk-local):
#
#   open issues                                        5
#   open issues carrying `Session-fit: next`           0
#   issues ever filed                                145
#   of those, skill-flow / cross-repo-mirror shaped   41
#
# cdk-local does NOT have the backlog-convergence problem its sibling cdkd
# has. Five open issues, none deferred, nothing umbrella-shaped: the argument
# from an unbounded open count is simply false here, and reproducing it would
# be a fabricated justification for a gate that is wanted for a different and
# verifiable reason.
#
# The reason here is the MIRROR PATH, which `/work-issues` section 10-c already
# names as a duplicate GENERATOR in its own text. Two measured pairs, both
# filed by this flow, both confirmed by reading the issue bodies:
#
#   go-to-k/cdk-local#528  2026-08-19T06:37:46Z  "... marker-sourcing, grep -cF,
#                                                 life-only-probe and
#                                                 branch-cleanup lessons ..."
#   go-to-k/cdk-local#531  2026-08-19T06:46:00Z  "... marker-sourcing, grep -cF,
#                                                 and life-only-probe lessons"
#
#     EIGHT MINUTES apart (8 m 14 s). #531's three lessons are a strict SUBSET
#     of #528's four -- same three sections, same evidence, different wording.
#     Both were then closed by one PR, go-to-k/cdk-local#532. #528's body shows
#     the near miss precisely: it records a FILE check against the merged
#     SKILL.md and a scan of the open PRs (go-to-k/cdk-local#523,
#     go-to-k/cdk-local#526), reporting them as carrying different lesson sets
#     -- and no check of the open ISSUE list, where its own duplicate landed
#     eight minutes later.
#
#   go-to-k/cdk-local#504  2026-08-19T03:14:05Z  "mirror the no-src verification
#                                                 tier into `/work-issues` section 8"
#   go-to-k/cdk-local#511  2026-08-19T04:29:26Z  "mirror the no-src verification
#                                                 tier into section 8, split by
#                                                 command-change vs prose-only"
#
#     SEVENTY-FIVE MINUTES apart, same target section, same upstream lesson.
#
# So the failure mode this gate fences is not "the backlog grows without
# bound"; it is "two hops of one lesson file the same issue, because the window
# nobody searches is the OPEN ISSUE list". Section 10-c already carries a
# three-window check -- merged file, then open PRs, then open issues. What the
# four bodies actually record is thinner than that check: #528 records the file
# and open-PR windows, #531 records the file window only, and #504 / #511 record
# no window at all. NONE of the four records an open-ISSUE search, which is the
# one window that would have caught each pair. Registration is not execution; this is the execution half.
#
# WHAT IS AND IS NOT GATED
#
#   gated:      gh issue create                       -- MINTS an issue
#               gh api repos/<o>/<r>/issues           -- the same mint, REST verb
#   not gated:  gh issue edit / gh issue comment      -- folding a finding into an
#                                                       issue that already exists is
#                                                       the outcome this gate steers
#                                                       toward; taxing it would
#                                                       penalise the cheap path and
#                                                       leave the costly one free
#
# THIS GATE DOES NOT SUPPRESS FINDINGS, AND MUST NEVER BE USED TO.
# `/work-issues` section 10-0 is explicit that `filed <= closed` is not a target
# and that an unfiled finding is strictly worse than a filed one, because it
# removes the defect from the record while leaving it in the product. Nothing
# here changes the threshold for writing a defect down. It changes only WHERE it
# gets written: into the open issue that already names its root cause, as a
# checklist row, rather than into a new issue number.
#
# If the search genuinely finds nothing, say so on the line and file: that is a
# PASS, and it is the expected outcome for a real new root cause.
#
# ACCEPTED FORMS (any line in the body starting with `Dup-check:`)
#
#   Dup-check: searched open issues for `no-src verification tier` -- none covers
#     this root cause
#   Dup-check: searched open issues for `marker sourcing` --
#     go-to-k/cdk-local#528 is the same AREA but a different root cause
#
# No bypass marker, matching non-english-text-gate.sh and
# closes-paren-form-gate.sh: running the search and writing one line is the
# entire ask, and a bypass would defeat the gate.

set -u

# Shared, segment-aware command matching (go-to-k/cdk-local#541).
# Fail CLOSED if the shared matcher is missing or does not load: a gate that
# cannot decide must not wave the command through. `[ -r ... ] || exit 0` was the
# first shape in this hooks dir and it silently disabled the gate whenever the
# library was unreadable or truncated (go-to-k/cdkd#2130 review). The
# `declare -F` checks catch a partial source, where `.` succeeds but the
# function is missing, and the GATE_RE_* checks catch a library that predates
# this gate's constants.
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh is missing or unreadable, so" >&2
  echo "issue-dup-check-gate cannot evaluate the command. Restore the file; do" >&2
  echo "not work around the gate." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib" 2>/dev/null
if ! declare -F gate_matches >/dev/null 2>&1 \
  || ! declare -F gate_segments >/dev/null 2>&1 \
  || ! declare -F gate_target_dir >/dev/null 2>&1 \
  || [ -z "${GATE_RE_GH_ISSUE_CREATE:-}" ] \
  || [ -z "${GATE_RE_GH_API_ISSUE_CREATE:-}" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but is truncated or" >&2
  echo "predates GATE_RE_GH_API_ISSUE_CREATE, so issue-dup-check-gate cannot" >&2
  echo "evaluate the command. Restore the file; do not work around the gate." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)
# An ABSENT `tool_name` is treated as Bash rather than as "not Bash": the
# payloads this hooks dir's own suites build carry only `cwd` + `tool_input`
# (see gate-command-recognition.test.sh), and defaulting the other way would
# make the gate exit 0 for every one of them -- inert while looking green.
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // "Bash"' 2>/dev/null || echo "Bash")
[ "$tool_name" = "Bash" ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# Command-position matching, so a body or comment that merely QUOTES
# `gh issue create` does not arm the gate (.claude/rules/hooks.md).
# Over-approximate the TRIGGER, be strict on RESOLUTION: the `gh api` arm here
# matches the issue COLLECTION path, reads included, and `seg_is_api_mint` below
# is what separates a POST from a GET. Arming on a read costs one no-op pass.
gate_matches "$cmd" "$GATE_RE_GH_ISSUE_CREATE" \
  || gate_matches "$cmd" "$GATE_RE_GH_API_ISSUE_CREATE" || exit 0

# --- 0. resolve the target directory ONCE -----------------------------------
# Both the opt-in check below and the relative `--body-file` resolution later
# need the same directory, and they must agree.
#
# The verb ERE is the ALTERNATION of the two MINT constants, never a bare `gh`.
# `gate_target_dir` stops at the first segment matching the ERE it is given, so
# a bare `gh` makes it stop at the first gh segment of any kind --
# `gh issue list --search x && cd <repo> && gh issue create ...`, the
# search-then-file chain this gate's own message prescribes, would never see the
# `cd`, the opt-in would resolve against the payload cwd, and the gate would
# exit 0. Deriving it from the two mint regexes also keeps GATE_GH_C's quoted
# alternative, without which `gh -C "/a b" issue create` matches no verb (the
# go-to-k/cdk-local#542 class .claude/rules/hooks.md records).
VERB_ERE="^((${GATE_RE_GH_ISSUE_CREATE#^})|(${GATE_RE_GH_API_ISSUE_CREATE#^}))"
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$VERB_ERE" 2>/dev/null || true)
[ -n "$target_dir" ] || target_dir="${hook_cwd:-$PWD}"

# NOTE ON `cd "$VAR"`, which differs from cdkd's `cmd_last_cd_target` in shape
# but not in outcome: `gate_target_dir` SKIPS a cd whose path is unexpanded and
# keeps the previous target (ultimately the payload cwd). For THIS gate that is
# the safe direction and needs no special arm. Two cases, both fine:
#   - the opt-in check then asks about the payload cwd instead of the real
#     target. Worst case the gate declines to fire in a repo it would have
#     gated, or fires in one it would not -- and the second is bounded by the
#     opt-in itself, which still requires a `.markgate.yml`.
#   - a RELATIVE `--body-file` then resolves against the wrong directory, the
#     file is unreadable, and the unreadable-file arm below falls back to
#     scanning the whole command with the ANCHORED marker. A body with no
#     `Dup-check:` line still BLOCKS. That is fail-closed.
# The `$VAR` case that genuinely needs its own refusal is an unexpanded
# `--body-file "$BODY"`, which is handled explicitly further down: there the
# gate would otherwise have to guess at the CONTENT it is supposed to check.

# --- 0b. repo opt-in ---------------------------------------------------------
# Same scoping every markgate-backed gate in this dir uses (branch-gate.sh,
# check-gate.sh, main-tree-branch-gate.sh): fire only in a repo that opts into
# this convention by carrying `.markgate.yml` at its root. A session working in
# cdk-local regularly files issues in unrelated personal repos, where this
# repo's root-cause-unit discipline is not the local convention and a refusal is
# pure friction.
#
# The CWD's repo decides, not any `-R <owner/repo>` in the command, and that is
# deliberate: `-R` names where the issue LANDS, while the cwd names which
# project's policy the session is operating under. Section 10-c's cross-repo
# mirror flow is exactly the case that makes the difference matter -- it runs
# `gh -R go-to-k/<sibling> issue create` from a cdk-local worktree, and those
# filings are precisely the ones this repo wants checked, since that flow is the
# documented duplicate generator in the header above.
#
# Unresolvable cwd, or a cwd outside any repo, means NOT gated. This is a
# discipline aid, not a safety boundary, so a rare miss costs less than a
# refusal in a context that never opted in.
optin_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$optin_top" ] || exit 0
[ -f "$optin_top/.markgate.yml" ] || exit 0

# TWO spellings of the same marker, and the difference is not cosmetic.
#
# In a body FILE the line structure is real, so the marker is anchored at the
# start of a line (optionally as a list item) -- which keeps a passing mention
# inside a sentence from satisfying the gate.
#
# In the raw COMMAND there is no such structure: an inline
# `--body 'Bug. Dup-check: ...'` is one line, so the same anchor never matches
# and the gate would refuse a body that carries exactly what it asks for. The
# command scan is therefore unanchored. The threat model is FORGETTING to run
# the search, not defeating the gate: someone who types the line without
# searching has already decided to, and no regex reaches that.
# `-i` on the greps rather than a `[Dd]` class, so `Dup-Check:` is accepted:
# refusing a capitalisation variant teaches people the gate is capricious, and
# nothing is gained by the strictness.
MARKER_RE_LINE='^[[:space:]]*([-*+>][[:space:]]+)?dup-check:'
MARKER_RE_LOOSE='dup-check:'

# BOTH scans are scoped to the SEGMENT that is the mint, never to the whole
# command, and that scoping is load-bearing rather than tidy.
#
# Unscoped, the gate has a demonstrated FAIL-OPEN in the shape this repo writes
# most: `git commit -F <msg> && gh issue create --body-file <no-marker>` passes,
# because `-F` is `git commit`'s flag as well as gh's short `--body-file`, so the
# extraction reads the COMMIT MESSAGE and finds the marker there -- and
# commit-msg-heredoc-gate.sh MANDATES `git commit -F <file>` in this repo, so
# that shape is the norm rather than an exotic one. Commit messages quote the
# lines they describe. The loose inline scan has the same hole for the same
# reason, in either command order.
#
# Every matching segment must carry the marker: a command opening two issues
# must record the search for both.
# Is this `gh api ... /issues` segment a MINT, or a READ? The path constant
# matches the collection, and the collection is also the LIST endpoint --
# `gh api repos/<o>/<r>/issues` and `gh api -X GET ... -f state=open` are reads,
# and refusing them (which this gate did) is pure friction with no duplicate
# anywhere in sight. gh sends GET unless told otherwise or unless fields are
# supplied, so:
#   explicit POST                      -> mint
#   any other explicit method          -> read (GET / PATCH / DELETE ...)
#   no method, but a `title=` field    -> mint (gh implies POST from fields)
#   otherwise                          -> read
seg_is_api_mint() {
  local seg="$1" method
  if [[ "$seg" =~ (-X|--method)[[:space:]=]+([A-Za-z]+) ]]; then
    method=$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:lower:]' '[:upper:]')
    [ "$method" = "POST" ] && return 0
    return 1
  fi
  printf '%s' "$seg" | grep -qE '(^|[[:space:]])(-f|-F|--field|--raw-field)[[:space:]=]+.?title=' && return 0
  # `--input <file>` (and `--input -`) also implies POST -- confirmed live:
  # `GH_DEBUG=api gh api rate_limit --input f.json` logs `> POST`. Without this
  # arm `gh api repos/<o>/<r>/issues --input body.json` mints an issue and the
  # gate waves it through, which is the same fail-open the `title=` arm exists
  # to close.
  printf '%s' "$seg" | grep -qE '(^|[[:space:]])--input([[:space:]=]|$)' && return 0
  return 1
}

# The inline body values a segment carries, one per line. The loose scan runs
# over THESE rather than over the whole segment, because the segment also holds
# the TITLE: `gh issue create --title 'Dup-check: yes' --body '<no marker>'`
# satisfied the gate with a marker-free body (verified rc=0). A title is not a
# record of having searched anything.
seg_inline_bodies() {
  printf '%s' "$1" | perl -0777 -ne '
      my $Q = "\x27";
      # --body <v> / --body=<v>, quoted either way or bare. `--body-file` does
      # NOT match: `[=\s]` after `--body` cannot consume the `-` of `-file`.
      while (/--body[=\s]+("([^"]*)"|${Q}([^${Q}]*)${Q}|([^\s]+))/g) {
        print((defined($2) ? $2 : defined($3) ? $3 : $4), "\n");
      }
      while (/(?:^|\s)-b[=\s]+("([^"]*)"|${Q}([^${Q}]*)${Q}|([^\s]+))/g) {
        print((defined($2) ? $2 : defined($3) ? $3 : $4), "\n");
      }
      # `-f body=<v>` / `--field body=<v>` and friends. The QUOTED forms come
      # first and may contain spaces -- a single-quoted `body=x Dup-check: none` is one
      # value, and a bare-token-only pattern truncated it at the first space and
      # lost the marker. `body=@file` is excluded: that is a body FILE, and the
      # file scan below owns it.
      while (/(?:--field|--raw-field|-f|-F)[=\s]+${Q}body=([^${Q}]*)${Q}/g) { print "$1\n"; }
      while (/(?:--field|--raw-field|-f|-F)[=\s]+"body=([^"]*)"/g)    { print "$1\n"; }
      while (/(?:--field|--raw-field|-f|-F)[=\s]+body=([^"${Q}\s@][^"${Q}\s]*)/g) { print "$1\n"; }
    ' 2>/dev/null
}

seg_has_marker() {
  local seg="$1" f body

  # inline `--body '...'`: the marker is in the body VALUE, not anywhere in the
  # segment. `--body-file` values are excluded by construction (`--body-file`
  # does not match `--body[=\s]`), so a PATH that happens to contain the word
  # cannot satisfy this either.
  while IFS= read -r body; do
    [ -n "$body" ] || continue
    if printf '%s' "$body" | grep -qiE "$MARKER_RE_LOOSE"; then
      return 0
    fi
  done < <(seg_inline_bodies "$seg")

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT. Refuse, but through the dedicated message arm below: a bare "check
    # the path" is unclearable when the file does carry the line.
    case "$f" in
      *'$'*|*'`'*) unresolvable_path="$f"; return 1 ;;
    esac
    # A literal `~` in the command string is text, not something to expand -- a
    # real tilde would already have been expanded by the shell before gh ran.
    # shellcheck disable=SC2088
    case "$f" in
      /*) ;;
      "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
      *) f="$target_dir/$f" ;;
    esac
    if [ ! -f "$f" ]; then
      # The file may not exist YET. `heredoc -> file -> --body-file` in ONE
      # command is a legitimate and common publishing shape here (this repo's
      # gh-pr-edit-deprecation-gate.sh prescribes `-F body=@<file>`, and
      # commit-msg-heredoc-gate.sh pushes bodies into files generally), and at
      # PreToolUse time the heredoc has not run. After the segment scoping,
      # treating that as a miss would be a false BLOCK on a shape the flow
      # itself prescribes, which is the worse direction.
      #
      # So fall back to the WHOLE command, with the ANCHORED marker: a heredoc
      # body carries real line structure, so the same line-start rule applies
      # and a passing mention inside a sentence still does not satisfy it. This
      # is the one place a cross-segment read is allowed, and its window is
      # narrow by construction -- it opens only when the named body file cannot
      # be read at all.
      #
      # KNOWN ASYMMETRY, accepted rather than fixed. The fallback is ANCHORED, so
      # a heredoc (whose body has real line structure) PASSES while the
      # equivalent `printf 'Dup-check: ...\n' > f.md && gh issue create
      # --body-file f.md` BLOCKS -- in the printf form the marker sits mid-line,
      # after `printf '`. Both directions were verified. This is the
      # fail-CLOSED direction and it is trivially clearable (write the body with
      # a heredoc, pass `--body` inline, or create the file in an earlier
      # command), whereas un-anchoring the fallback would let any passing
      # mention anywhere in the command satisfy the gate.
      if printf '%s' "$cmd" | grep -qiE "$MARKER_RE_LINE"; then
        return 0
      fi
      continue
    fi
    found_body_file=1
    if grep -qiE "$MARKER_RE_LINE" "$f"; then
      return 0
    fi
  # This extraction is a near-copy of pr-body-item-number-gate.sh's
  # `extract_files`, deliberately not shared, and it has already DIVERGED in
  # three ways: it runs on ONE SEGMENT rather than the whole command, it adds
  # the bare `-F <file>` arm (gh's short `--body-file`), and its caller treats
  # an unreadable path as a BLOCK where that hook simply skips the file. The
  # third is a deliberate opposite -- that gate objects to content it FINDS, so
  # a missed read costs one warning, while a missed read here costs the gate.
  # Stated rather than left to be discovered: if you fix a path-extraction bug
  # in either, check the other.
  done < <(printf '%s' "$seg" | perl -0777 -ne '
      while (/--body-file[=\s]+(["\x27]?)([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/(?:--field|--raw-field|-F)[=\s]+(["\x27]?)body=\@([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/(?:^|\s)-F[=\s]+(["\x27]?)([^"\x27\s=]+)\1(?=\s|$)/g) { print "$2\n"; }
    ' 2>/dev/null)
  return 1
}

found_body_file=0
unresolvable_path=""
offending=""
while IFS= read -r seg; do
  if [[ "$seg" =~ $GATE_RE_GH_ISSUE_CREATE ]]; then
    :
  elif [[ "$seg" =~ $GATE_RE_GH_API_ISSUE_CREATE ]]; then
    # The path alone does not say mint; the collection is the LIST endpoint too.
    seg_is_api_mint "$seg" || continue
  else
    continue
  fi
  if ! seg_has_marker "$seg"; then
    offending="$seg"
    break
  fi
done < <(gate_segments "$cmd")

[ -n "$offending" ] || exit 0

if [ -n "$unresolvable_path" ]; then
  {
    echo "Blocked by issue-dup-check-gate: the --body-file path \`$unresolvable_path\`"
    echo "carries an unexpanded variable or substitution, and this gate reads the"
    echo "command TEXT rather than the shell's expansion of it, so it cannot open"
    echo "the file to look for the \`Dup-check:\` line."
    echo ""
    echo "This refuses rather than guessing, per the fail-closed convention in"
    echo ".claude/rules/hooks.md. Two ways to clear it, both of which leave the"
    echo "gate doing its job:"
    echo ""
    echo "  - pass the path literally:  gh issue create --body-file /abs/path.md"
    echo "  - or carry the line inline: gh issue create --body \"...Dup-check: ...\""
  } >&2
  exit 2
fi

{
  echo "Blocked by issue-dup-check-gate: this \`gh issue create\` body carries no"
  echo "\`Dup-check:\` line, so nothing records that the OPEN issue list was"
  echo "searched for an issue already covering this root cause."
  if [ "$found_body_file" = "0" ]; then
    echo ""
    echo "(No readable --body-file was found in the command either. If you passed"
    echo " one, check the path: an unreadable body file is treated as a miss, not"
    echo " as a pass.)"
  fi
  echo ""
  echo "Run the search first -- search the CONCEPT, not this instance's spelling."
  echo "go-to-k/cdk-local#531 duplicated go-to-k/cdk-local#528 eight minutes later"
  echo "with a strict subset of its lessons, and go-to-k/cdk-local#511 duplicated"
  echo "go-to-k/cdk-local#504 after 75 minutes. Not one of those four bodies"
  echo "records an open-ISSUE search:"
  echo ""
  echo "  gh issue list --state open --limit 200 --search '<root-cause concept>' \\"
  echo "    --json number,title"
  echo "  gh issue list --state open --limit 200 --json number,title,body \\"
  echo "    --jq '.[] | select((.body // \"\") | test(\"<shared symbol / call / assumption>\";\"i\"))"
  echo "          | \"\\(.number)\\t\\(.title)\"'"
  echo ""
  echo "  \`(.body // \"\")\`, not \`.body\`: an issue filed with no body makes"
  echo "  \`test\` abort the whole jq program, so one body-less issue silently"
  echo "  costs you the entire window."
  echo ""
  echo "On a HIT, do not create -- fold the finding into that issue as a"
  echo "checklist row, which keeps the defect on the record while the open count"
  echo "stays one-per-root-cause:"
  echo ""
  echo "  U=\$(mktemp)   # NOT a fixed /tmp path: parallel lanes share the scratchpad"
  echo "  gh issue view <hit> --json body -q .body > \"\$U\" \\"
  echo "    && [ -s \"\$U\" ] \\"
  echo "    && printf -- '- [ ] <site>: <one line, plus where the evidence is>\\n' >> \"\$U\" \\"
  echo "    && gh issue edit <hit> --body-file \"\$U\""
  echo ""
  echo "  The chaining and the -s test are load-bearing, not style: the redirect"
  echo "  truncates \$U before gh runs, so an unchained recipe whose \`view\` fails"
  echo "  (wrong number, transient error) replaces the umbrella's WHOLE body with"
  echo "  the single new row -- destroying every previously folded finding through"
  echo "  the very procedure meant to preserve them."
  echo ""
  echo "On a MISS, that is a real new root cause -- file it, and record the"
  echo "search in the body:"
  echo ""
  echo "  Dup-check: searched open issues for <terms> -- none covers this root cause"
  echo ""
  echo "This gate never asks you to drop a finding. /work-issues section 10-0 is"
  echo "explicit that \`filed <= closed\` is not a target and that an unfiled"
  echo "finding is worse than a filed one. It changes only WHERE the finding is"
  echo "written, so an open issue counts one unresolved root cause rather than"
  echo "one unfixed site."
  echo ""
  echo "Rule: .claude/skills/work-issues/SKILL.md section 5 (\"N sites of one root"
  echo "cause is ONE issue and ONE PR, never N issues\")."
} >&2
exit 2
