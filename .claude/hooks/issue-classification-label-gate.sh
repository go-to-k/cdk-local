#!/usr/bin/env bash
# issue-classification-label-gate.sh — block `gh issue create` / `gh issue edit`
# when the issue BODY states a `Severity:` / `Effort:` value that the issue's
# LABELS do not carry.
#
# WHY
#
# CLAUDE.md's four classification fields (`Session-fit` / `Severity` / `Effort`
# / `Estimate`) live in the issue BODY as prose lines. That is the right place
# for the one-line reason each of them carries, and nothing here changes how
# they are written or displayed. But prose is invisible to every query the
# backlog is actually triaged with: `/work-issues` section 3's ranking rule 4
# ("higher `Severity` first, when BOTH candidates carry the line") can only be
# applied by opening each body, which is why it sits below a title-prefix
# heuristic rather than above it. `gh issue list --label severity:high` answers
# the same question in one call.
#
# So the two values that have a CLOSED set of tokens are mirrored onto labels:
#
#   Severity: high | medium | low   ->  severity:high | severity:medium | severity:low
#   Effort:   small | medium | large ->  effort:small  | effort:medium  | effort:large
#
# ONLY those two. `Session-fit` is re-decided when an issue is claimed (section
# 3 requires the claim comment to say why a recorded classification no longer
# applies), and a label that silently disagrees with the body is worse than no
# label at all. `Estimate` is a free-form duration with no closed value set --
# CLAUDE.md's own rule that it "must name what actually eats the time" is
# exactly what a label cannot hold.
#
# The prefixed full words are deliberate, and they are CLAUDE.md's own "no bare
# tokens" rule applied to a label: `Severity` and `Effort` share the token
# `medium`, and their initials collide in the dangerous direction (`L` is
# severity *low*, the least urgent thing there is, and effort *large*, the
# biggest). `severity:medium` / `effort:medium` cannot be confused; `M` can.
#
# WHAT IS AND IS NOT GATED
#
#   gated:      gh issue create   -- the filing site, where the four lines are
#                                    first written
#               gh issue edit     -- the CLAIM site: section 3 says most open
#                                    bodies are still in the old packed shape
#                                    and are upgraded to the four-line shape
#                                    when claimed, which is the moment
#                                    `Severity` first exists for them
#   not gated:  gh issue comment  -- a comment is not the issue's classification
#
# On `gh issue edit` the gate asks gh what labels the issue ALREADY carries, so
# re-editing an issue that is already labelled is not taxed; only a body whose
# stated value has no matching label is refused, and one `--add-label` clears
# it. That is also how the pre-existing backlog gets labelled: on touch, by the
# lane that is already holding the evidence, rather than by a bulk sweep that
# would manufacture guesses (section 3 forbids that sweep for the same reason).
#
# NO BYPASS MARKER, matching issue-dup-check-gate.sh: copying a value that is
# already written one line above onto a flag is the entire ask.

set -u

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash issue-classification-label-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."

# The shared matcher lives at `lib/command-match.sh` in cdkd and at
# `_command-match.sh` in the sibling repos this hook is mirrored into. Try both
# rather than forking the file: the two spellings are the ONLY difference
# between the three copies, and a fork is how they drift.
# shellcheck source=lib/command-match.sh
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  && ! . "$__hook_dir/_command-match.sh" 2>/dev/null; then
  echo "Blocked: the shared command matcher (lib/command-match.sh or" >&2
  echo "_command-match.sh) is missing or unloadable, so" >&2
  echo "issue-classification-label-gate cannot evaluate the command." >&2
  echo "Restore the file; do not work around the gate." >&2
  exit 2
fi
# FAIL CLOSED on a matcher that loaded but predates the constants this gate
# needs -- `|| exit 0` here is what silently disabled ten sibling gates
# (go-to-k/cdkd#2130 review).
if ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_segments >/dev/null \
  || [ -z "${GATE_RE_GH_ISSUE_CREATE:-}" ] \
  || [ -z "${GATE_RE_GH_ISSUE_EDIT:-}" ]; then
  echo "Blocked: the shared command matcher loaded but is missing gate_matches," >&2
  echo "gate_segments, GATE_RE_GH_ISSUE_CREATE or GATE_RE_GH_ISSUE_EDIT, so" >&2
  echo "issue-classification-label-gate cannot evaluate the command." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool_name" = "Bash" ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# Command-position matching, so a body or comment that merely QUOTES
# `gh issue create` does not arm the gate (.claude/rules/hooks.md).
gate_matches "$cmd" "$GATE_RE_GH_ISSUE_CREATE" \
  || gate_matches "$cmd" "$GATE_RE_GH_ISSUE_EDIT" || exit 0

target_dir="${hook_cwd:-$PWD}"

# --- repo opt-in (issue #1259's scoping) ------------------------------------
# A session in one of these repos regularly files issues in unrelated personal
# repos, where this classification discipline is not the local convention and a
# refusal is pure friction. So the gate fires only in a repo that opts in by
# carrying `.markgate.yml` at its root. The CWD's repo decides, not any
# `-R <owner/repo>` in the command: `-R` names where the issue LANDS, while the
# cwd names whose policy the session is operating under -- and the cross-repo
# mirror flow (/work-issues section 10-c) files into a sibling from here,
# which is exactly a filing this repo wants classified.
optin_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$optin_top" ] || exit 0
[ -f "$optin_top/.markgate.yml" ] || exit 0

# --- value extraction -------------------------------------------------------
# The key must be followed by at least one SPACE, and that is load-bearing
# rather than incidental: the label spelling is `severity:high` with no space,
# so this scan reads the BODY's `Severity: high` and never the `--label`
# argument sitting in the same command string. Without the space rule a
# `--label severity:low` would satisfy its own requirement.
classification_value() {
  local text="$1" key="$2" allowed="$3"
  printf '%s' "$text" \
    | grep -oiE "${key}:[[:space:]]+(${allowed})([^[:alnum:]]|\$)" \
    | head -1 \
    | grep -oiE "(${allowed})" \
    | head -1 \
    | tr '[:upper:]' '[:lower:]'
}

# Every `--label` / `--add-label` value in one segment, comma-split. The
# extraction is the same one gh-label-validity-gate.sh uses: the unquoted value
# is terminated by whitespace or a shell metacharacter, so a chained
# `--label X; other-cmd` captures `X`, not `X;`.
segment_labels() {
  printf '%s' "$1" \
    | grep -oE -- '--(add-)?label[= ]("[^"]+"|'\''[^'\'']+'\''|[^ ;&|()<>"'\'']+)' \
    | sed -E -e 's/^--(add-)?label[= ]//' -e 's/^["'\'']//' -e 's/["'\'']$//' \
    | tr ',' '\n' \
    | sed 's/^ *//;s/ *$//' \
    | grep -v '^$' || true
}

# The text a segment's body amounts to: the segment itself (covering an inline
# `--body '...'`), plus the contents of any readable `--body-file`, plus -- when
# a named body file cannot be read -- the WHOLE command. That last fallback is
# this repo's mandated `heredoc -> file -> --body-file` publishing shape, whose
# file does not exist yet at PreToolUse time; issue-dup-check-gate.sh documents
# the same window.
segment_body_text() {
  local seg="$1" f out
  out="$seg"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      *'$'*|*'`'*) out="$out
$cmd"; continue ;;
    esac
    # shellcheck disable=SC2088
    case "$f" in
      /*) ;;
      "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
      *) f="$target_dir/$f" ;;
    esac
    if [ -r "$f" ]; then
      out="$out
$(cat "$f" 2>/dev/null || true)"
    else
      out="$out
$cmd"
    fi
  done < <(printf '%s' "$seg" | perl -0777 -ne '
      while (/--body-file[=\s]+(["\x27]?)([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/(?:--field|--raw-field|-F)[=\s]+(["\x27]?)body=\@([^"\x27\s]+)\1/g) { print "$2\n"; }
    ' 2>/dev/null)
  printf '%s' "$out"
}

# The labels an EXISTING issue already carries, for the `gh issue edit` arm.
# Fails OPEN (prints nothing and lets the caller treat it as "unknown, do not
# block") on any gh error: this is a discipline aid, not a safety boundary, and
# a transient gh failure must not stop a body edit.
existing_labels() {
  local seg="$1" num repo_args
  num=$(printf '%s' "$seg" | sed -nE 's#.*/issues/([0-9]+).*#\1#p' | head -1)
  if [ -z "$num" ]; then
    num=$(printf '%s' "$seg" \
      | sed -nE 's/.*issue[[:space:]]+edit[[:space:]]+["'\'']?#?([0-9]+).*/\1/p' | head -1)
  fi
  [ -n "$num" ] || return 1
  repo_args=$(printf '%s' "$seg" \
    | sed -nE 's/.*[[:space:]](-R|--repo)[= ]["'\'']?([^ "'\'']+).*/\2/p' | head -1)
  if [ -n "$repo_args" ]; then
    gh issue view "$num" -R "$repo_args" --json labels -q '.labels[].name' 2>/dev/null
  else
    (cd "$target_dir" 2>/dev/null && gh issue view "$num" --json labels -q '.labels[].name' 2>/dev/null)
  fi
}

has_label() {
  printf '%s\n' "$2" | grep -qFx -- "$1"
}

offending_seg=""
missing=""
while IFS= read -r seg; do
  is_edit=0
  if gate_matches "$seg" "$GATE_RE_GH_ISSUE_EDIT"; then
    is_edit=1
  elif ! gate_matches "$seg" "$GATE_RE_GH_ISSUE_CREATE"; then
    continue
  fi

  body_text=$(segment_body_text "$seg")
  sev=$(classification_value "$body_text" 'severity' 'high|medium|low')
  eff=$(classification_value "$body_text" 'effort' 'small|medium|large')
  # An old packed body writes `Effort: ~1-3 h`, which is a DURATION rather than
  # one of the three verification-cycle kinds (/work-issues section 3). No token
  # matches, so no label is demanded -- reading that field as the new `Effort`
  # is the misreading section 3 warns about, and this gate must not force it.
  [ -n "$sev" ] || [ -n "$eff" ] || continue

  known=$(segment_labels "$seg")
  if [ "$is_edit" = "1" ]; then
    prior=$(existing_labels "$seg" || true)
    if [ -n "$prior" ]; then
      known="$known
$prior"
    elif [ -z "$known" ]; then
      # Unknown issue number, or gh could not answer: fail OPEN rather than
      # refuse a body edit over a label we cannot see.
      continue
    fi
  fi

  seg_missing=""
  if [ -n "$sev" ] && ! has_label "severity:$sev" "$known"; then
    seg_missing="${seg_missing}  - severity:${sev}   (body says \`Severity: ${sev}\`)"$'\n'
  fi
  if [ -n "$eff" ] && ! has_label "effort:$eff" "$known"; then
    seg_missing="${seg_missing}  - effort:${eff}   (body says \`Effort: ${eff}\`)"$'\n'
  fi
  if [ -n "$seg_missing" ]; then
    offending_seg="$seg"
    missing="$seg_missing"
    is_edit_offending="$is_edit"
    break
  fi
done < <(gate_segments "$cmd")

[ -n "$offending_seg" ] || exit 0

if [ "${is_edit_offending:-0}" = "1" ]; then
  flag="--add-label"
  verb="gh issue edit"
else
  flag="--label"
  verb="gh issue create"
fi

{
  echo "Blocked by issue-classification-label-gate: this \`${verb}\` states a"
  echo "classification in the body that the issue's labels do not carry."
  echo ""
  echo "Missing label(s):"
  printf '%s' "$missing"
  echo ""
  echo "Add them to the same command -- the body text stays exactly as written,"
  echo "the labels are a second copy of the SAME two values:"
  echo ""
  echo "  ${verb} ... ${flag} severity:<high|medium|low> ${flag} effort:<small|medium|large>"
  echo ""
  echo "Why: the four classification fields live in the body as prose, which no"
  echo "\`gh issue list\` query can read. /work-issues section 3's ranking rule 4"
  echo "(\"higher Severity first\") therefore costs one \`gh issue view\` per"
  echo "candidate, while \`gh issue list --label severity:high\` is one call."
  echo "Only Severity and Effort are mirrored: Session-fit is re-decided at claim"
  echo "time and a stale label would be worse than none, and Estimate is a"
  echo "free-form duration with no closed value set."
  echo ""
  echo "If the label does not exist yet in this repo, create it once:"
  echo "  gh label create 'severity:high' --description '...' --color 'b60205'"
  echo ""
  echo "Rule: CLAUDE.md -> the four TODO classification fields."
} >&2
exit 2
