#!/usr/bin/env bash
# pr-body-item-number-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` / `gh pr edit` / `gh issue
# create` / `gh issue comment` / `gh api -X PATCH ... pulls|issues`
# invocations when the body file they pass via `--body-file <FILE>`
# (or `--field body=@<FILE>` / `-F body=@<FILE>`) contains `#N`
# tokens that GitHub will auto-link to issue/PR #N.
#
# This is the "review-fix #4 -> linked to unrelated PR #4" trap.
# A PR body containing `Must-fix #1`, `review-fix #4`, etc. is rendered
# by GitHub with each `#N` as a hyperlink to that issue/PR, which were
# unrelated changes — a reviewer clicks one, lands on the wrong PR,
# and the trace is lost.
#
# Detection rules:
#
#   ALLOWED (do NOT block):
#     - Issue-closing keywords (case-insensitive):
#         close[s]? #N, closed #N, fix[es]? #N, resolve[s]? #N
#       These are load-bearing for GitHub's auto-close behavior.
#     - Soft references: refs: #N, ref: #N, references #N, see #N
#     - Parenthetical: (#N)   — used by squash-merge commit messages
#       like `feat(...): subject (#231)`.
#     - Inside fenced code blocks (between matching ``` lines).
#     - Inside markdown URLs: github.com/.../issues/N, /pull/N,
#       /commit/<sha>. These don't render as `#N` auto-links.
#
#   BLOCKED:
#     - Item-number prefixes: Must-fix #N, review-fix #N, decision #N,
#       step #N, item #N, point #N, number #N, bullet #N, entry #N
#       (case-insensitive).
#     - Plain `#N` in prose without an allow-listed prefix or context.
#
# Override: there is no marker-based bypass. The fix is trivial
# (replace `#N` with `N`); a bypass would defeat the gate. Users who
# need to bypass can pass the body inline via `--body 'foo'` (the
# hook only inspects `--body-file` / `body=@<file>` shapes).

set -u

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


cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate the `gh` writers that take a body; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored. This gate acts on the body FILE, not on a working tree, so
# the matched regex is only used to decide whether to keep going.
gate_re=""
for gate_candidate in "$GATE_RE_GH_PR_CREATE" "$GATE_RE_GH_PR_EDIT" \
  "$GATE_RE_GH_ISSUE_CREATE" "$GATE_RE_GH_ISSUE_COMMENT" "$GATE_RE_GH_API"; do
  if gate_matches "$cmd" "$gate_candidate"; then
    gate_re="$gate_candidate"
    break
  fi
done
[ -n "$gate_re" ] || exit 0

if ! printf '%s' "$cmd" | grep -qE '(--body-file|body=@)'; then
  exit 0
fi

# Extract the body file path from the command. Shapes to handle:
#   --body-file <PATH>      (gh pr create / gh issue create / etc.)
#   --body-file=<PATH>      (alternate form)
#   --field body=@<PATH>    (gh api long form)
#   -F body=@<PATH>         (gh api short form)
#   --field "body=@<PATH>"  (quoted)
#
# We want a single best-effort extraction. If multiple body files are
# referenced, scan all of them.

extract_files() {
  local cmd="$1"
  # Use perl to handle quoted args robustly. Output is one path per
  # line. perl's regex is more permissive than bash's, and we
  # collapse single/double quotes around the value.
  printf '%s' "$cmd" | perl -ne '
    while (/--body-file[=[:space:]]+(["\x27]?)([^"\x27[:space:]]+)\1/g) { print "$2\n"; }
    while (/(?:--field|-F)[[:space:]]+(["\x27]?)body=@([^"\x27[:space:]]+)\1/g) { print "$2\n"; }
  '
}

# Read a file's contents and emit only the lines (with line numbers,
# 1-indexed) that are subject to scanning — i.e. NOT inside fenced
# code blocks. URLs and code spans are filtered later inside the
# offender check.
strip_code_blocks() {
  awk '
    BEGIN { in_block = 0; lineno = 0 }
    {
      lineno++
      # A line whose trimmed form starts with ``` toggles the fence.
      if ($0 ~ /^[[:space:]]*```/) { in_block = !in_block; next }
      if (in_block) next
      printf "%d\t%s\n", lineno, $0
    }
  '
}

# Decide if a single line, after stripping URL contexts, contains a
# blocked `#N` token.
#
# Returns the FIRST blocked offender's surrounding text on stdout if
# found, empty otherwise. Exit code is 0 either way; the caller
# checks for empty output.
find_offender() {
  local line="$1"

  # 1. Strip URLs that contain /issues/N, /pull/N, /commit/<sha>, or
  #    just any http(s)://... URL — those have no `#N` auto-link.
  local stripped
  stripped=$(printf '%s' "$line" | perl -pe 's|https?://\S+||g')

  # 2. Strip backtick-quoted code spans: `...`. The content of code
  #    spans isn't auto-linked by GitHub.
  stripped=$(printf '%s' "$stripped" | perl -pe 's|`[^`]*`||g')

  # 3. Find the first `#N` that is NOT preceded by an allowed context.
  #    We use perl with a single pass that captures `#N` plus a few
  #    chars of left context, then evaluate each match.
  printf '%s' "$stripped" | perl -ne '
    while (/(.{0,32}?)(#\d+)\b/g) {
      my $left = $1;
      my $hit = $2;
      # ALLOWED: parenthetical like "(#231)" — left ends in "(".
      next if $left =~ /\($/;
      # ALLOWED: issue-closing keyword immediately before. The
      # keyword MUST start at a word boundary that is NOT a hyphen
      # (so "Must-fix" / "review-fix" do NOT match "fix"). We
      # require the keyword to be preceded by start-of-string or
      # whitespace (not -, _, etc.).
      #   close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved
      next if $left =~ /(?i)(?:^|\s)(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*$/;
      # ALLOWED: soft reference keywords.
      #   refs:, ref:, references, see
      next if $left =~ /(?i)(?:^|\s)(refs?:?|references|see)\s*$/;
      # Otherwise: BLOCKED. Print the hit and the full line context.
      print "$hit\n";
      last;
    }
  '
}

# Collect offenders: "<file>:<lineno>:<line>" entries, one per blocked
# line. We surface up to a small cap so the error stays readable.
declare -a OFFENDERS=()
MAX_REPORT=10

# When the named body file cannot be READ, scan the WHOLE COMMAND instead of
# skipping (go-to-k/cdk-local#637, ported from go-to-k/cdkd#2397). The hook runs
# BEFORE the command does, so whenever the heredoc that writes the body and the
# `gh` call that consumes it sit in ONE Bash call -- the publishing shape this
# repo mandates, since a gated command needs its own Bash call and the body has
# to exist by then -- the path does not exist yet. `[[ ! -f "$f" ]] && continue`
# made that a SILENT PASS.
#
# Both sibling gates already do this: `issue-dup-check-gate.sh` and
# `issue-classification-label-gate.sh` hit the same window and fall back to the
# command, each with a comment saying that failing closed there would refuse the
# flow the rules prescribe. So this is a port, not a design decision.
#
# A file that EXISTS is scanned too when the command REWRITES it, because then
# what is on disk is the PREVIOUS body -- the other half of the same window, and
# the one that reads as a working gate while judging text nobody submitted.
#
# Note the direction differs from `issue-dup-check-gate.sh`'s fallback and that
# is deliberate: this gate objects to content it FINDS, so scanning extra text
# can only add a refusal that names a real `#N`, while that gate needs to FIND a
# marker and so treats an unreadable path as a block.
cmd_writes_path() {
  local path="$1"
  CMD="$cmd" TARGET="$path" perl -0777 -e '
    my $cmd = $ENV{CMD};
    my $t   = quotemeta($ENV{TARGET});
    # `>` / `>>` / `tee [-a]` naming the path, quoted or bare. A heredoc body is
    # written through exactly this redirect (`cat > f <<EOF`), so matching the
    # redirect covers the heredoc shape without parsing heredocs.
    exit 0 if $cmd =~ /(?:>>?|\btee\b(?:\s+-a)?)\s*(["\x27]?)$t\1(?:\s|$)/;
    exit 1;
  ' 2>/dev/null
}

scan_text() {
  # $1 = label used in the offender report, $2 = the text to scan.
  local label="$1"
  while IFS=$'\t' read -r ln content; do
    [[ -z "$content" ]] && continue
    hit=$(find_offender "$content")
    if [[ -n "$hit" ]]; then
      OFFENDERS+=("$label:$ln: $content")
      if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
        return
      fi
    fi
  done < <(printf '%s' "$2" | strip_code_blocks)
}

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ ! -f "$f" ]]; then
    scan_text "<command>" "$cmd"
    if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
      break
    fi
    continue
  fi
  if cmd_writes_path "$f"; then
    scan_text "<command>" "$cmd"
    if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
      break
    fi
  fi

  while IFS=$'\t' read -r ln content; do
    [[ -z "$content" ]] && continue
    hit=$(find_offender "$content")
    if [[ -n "$hit" ]]; then
      OFFENDERS+=("$f:$ln: $content")
      if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
        break
      fi
    fi
  done < <(strip_code_blocks < "$f")

  if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
    break
  fi
done < <(extract_files "$cmd")

if [[ "${#OFFENDERS[@]}" -eq 0 ]]; then
  exit 0
fi

{
  echo "Blocked by pr-body-item-number-gate:"
  echo
  echo "Body file contains #N patterns that GitHub auto-links to issue/PR"
  echo "#N. This is the \"review-fix #4 -> linked to unrelated PR #4\" trap."
  echo
  echo "Found:"
  for entry in "${OFFENDERS[@]}"; do
    echo "  $entry"
  done
  echo
  echo "Fix:"
  echo "  - Item numbers: use bare numbers (e.g. 'Must-fix 1' not 'Must-fix #1')"
  echo "  - Real issue refs: keep 'closes #NNN' / '(#NNN)' / full URLs (allow-listed)"
} >&2
exit 2
