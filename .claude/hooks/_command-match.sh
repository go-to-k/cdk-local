#!/usr/bin/env bash
# _command-match.sh — shared command matching for the PreToolUse gate hooks.
# SOURCED, never executed: `. "$(dirname "${BASH_SOURCE[0]}")/_command-match.sh"`.
#
# WHY this exists (go-to-k/cdk-local#541): every gate used to decide whether
# it applied with a LINE-START-anchored regex, optionally tolerating one leading
# `cd <path> &&`. So a gated verb in any other position was invisible:
#
#   git add -A && git commit -m "…"     <- the commonest commit spelling there is
#   cd <wt>; git commit -m "…"          <- semicolon instead of &&
#   (cd <wt> && git commit -m "…")      <- subshell
#   GIT_EDITOR=true git commit -m "…"   <- leading env assignment
#
# all reached git ungated, and an ungated command looks exactly like one that
# passed. Measured on 2026-08-20 right after go-to-k/cdk-local#540 gave every
# gate its own single-pattern `if` — before that, all seventeen `if` clauses
# used an unsupported ` or ` join and no gate ran at all, so the matcher bug
# had never been reachable enough to notice.
#
# The model: a Bash tool call is a COMMAND LIST. Split it into segments and ask
# whether ANY segment is the gated command. Quoted spans are blanked first, so a
# separator or a command name inside a string cannot create a phantom segment —
# `echo "run git commit later"` is still not a commit.

# Blank the CONTENT of quoted spans, preserving length so offsets and the
# surrounding structure survive. Unterminated quotes blank to end of input, which
# is the conservative reading (that text is not a command).
gate_blank_quotes() {
  awk '
    {
      line = $0; out = ""; q = ""
      n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (q == "") {
          if (c == "\"" || c == "'"'"'") { q = c; out = out c; continue }
          out = out c
        } else {
          if (c == "\\" && q == "\"") { out = out "  "; i++; continue }
          if (c == q) { q = ""; out = out c; continue }
          out = out " "
        }
      }
      print out
    }
  ' <<< "$1"
}

# Blank the BODY of every heredoc, keeping the line count. A heredoc body is data
# the shell hands to a program, not a command list — and this repo's own flow
# writes PR bodies with `gh pr create --body-file <<EOF ... git commit ... EOF`,
# which would otherwise trip the commit gates on its own prose.
gate_blank_heredocs() {
  awk '
    BEGIN { tag = "" }
    {
      if (tag != "") {
        line = $0
        gsub(/^[ \t]+|[ \t]+$/, "", line)
        if (line == tag) { tag = "" ; print $0 ; next }
        print ""
        next
      }
      if (match($0, /<<-?[ \t]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/)) {
        t = substr($0, RSTART, RLENGTH)
        gsub(/^<<-?[ \t]*|["'"'"']/, "", t)
        tag = t
      }
      print $0
    }
  ' <<< "$1"
}

# Print one command segment per line: split on && || ; | newline, and drop the
# grouping punctuation ( ) { } that wraps a subshell or brace group.
gate_segments() {
  local blanked
  blanked=$(gate_blank_quotes "$(gate_blank_heredocs "$1")")
  printf '%s' "$blanked" |
    sed -E 's/\|\||&&|;|\||\n/\n/g' |
    sed -E 's/^[[:space:]]*[({][[:space:]]*//; s/[[:space:]]*[)}][[:space:]]*$//' |
    sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' |
    grep -v '^$'
}

# Strip leading `VAR=value` assignments and an `env`/`command`/`nohup` wrapper, so
# `GIT_EDITOR=true git commit` and `env git commit` are seen as `git commit`.
gate_strip_prefix() {
  printf '%s' "$1" | sed -E 's/^(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|nohup)[[:space:]]+)*//'
}

# gate_matches <cmd> <extended-regex>
# 0 when any segment matches the regex (anchored at the segment start, after the
# prefix strip). The regex is the SAME per-verb shape each gate used to carry.
gate_matches() {
  local cmd="$1" re="$2" segment
  while IFS= read -r segment; do
    segment=$(gate_strip_prefix "$segment")
    printf '%s' "$segment" | grep -qE "$re" && return 0
  done < <(gate_segments "$cmd")
  return 1
}

# The regexes, kept here so every gate spells its verb the same way. Each is
# anchored at the START of a segment; `git -C <path>` / `git -c k=v` and
# `gh -C <path>` are absorbed.
GATE_RE_GIT_COMMIT='^git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)'
GATE_RE_GIT_PUSH='^git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+push([[:space:]]|$)'
GATE_RE_GH_PR_CREATE='^gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'
GATE_RE_GH_PR_EDIT='^gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+edit([[:space:]]|$)'
GATE_RE_GH_PR_MERGE='^gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'

# cdk-local also gates these verbs (cdk-real-drift, the repo this helper was
# ported from, has no gate for them): branch switching, a local merge, and the
# `gh issue` / `gh api` writers whose bodies pr-body-item-number-gate inspects.
GATE_RE_GIT_SWITCH='^git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+switch([[:space:]]|$)'
GATE_RE_GIT_CHECKOUT='^git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+checkout([[:space:]]|$)'
GATE_RE_GIT_MERGE='^git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+merge([[:space:]]|$)'
GATE_RE_GH_ISSUE_CREATE='^gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+issue[[:space:]]+create([[:space:]]|$)'
GATE_RE_GH_ISSUE_COMMENT='^gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+issue[[:space:]]+comment([[:space:]]|$)'
GATE_RE_GH_API='^gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+api([[:space:]]|$)'

# gate_target_dir <cmd> <fallback> <extended-regex>
# The working tree the gated command will actually run in:
#   1. a `-C <path>` inside the MATCHED segment wins (git -C / gh -C), else
#   2. the last `cd <path>` segment BEFORE the matched one, else
#   3. the fallback (the hook payload's cwd).
# Relative paths resolve against the fallback, then against each other, which is
# what a `cd a && cd b` chain does.
gate_target_dir() {
  local cmd="$1" fallback="$2" re="$3"
  local target="$fallback" segment stripped cd_target c_target remaining
  while IFS= read -r segment; do
    stripped=$(gate_strip_prefix "$segment")
    if [[ "$stripped" =~ ^cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
      cd_target="${BASH_REMATCH[1]}"
      cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
      cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
      [[ "$cd_target" != /* ]] && cd_target="$target/$cd_target"
      target="$cd_target"
      continue
    fi
    printf '%s' "$stripped" | grep -qE "$re" || continue
    # Last `-C <path>` in this segment wins over any earlier cd.
    if [[ "$stripped" =~ (git|gh)[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
      c_target=""
      remaining="$stripped"
      while [[ "$remaining" =~ (git|gh)[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
        c_target="${BASH_REMATCH[2]}"
        remaining="${remaining#*"${BASH_REMATCH[0]}"}"
      done
      c_target="${c_target%\"}"; c_target="${c_target#\"}"
      c_target="${c_target%\'}"; c_target="${c_target#\'}"
      [[ "$c_target" != /* ]] && c_target="$target/$c_target"
      target="$c_target"
    fi
    break
  done < <(gate_segments "$cmd")
  printf '%s' "$target"
}
