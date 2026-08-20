#!/usr/bin/env bash
# _command-match.sh — shared command matching for the PreToolUse gate hooks.
# SOURCED, never executed: `. "$(dirname "${BASH_SOURCE[0]}")/_command-match.sh"`.
#
# WHY (go-to-k/cdk-local#541): every gate used to decide whether it applied
# with a LINE-START-anchored regex tolerating at most one leading `cd <path> &&`,
# so a gated verb anywhere else was invisible and the command ran UNGATED —
# `git add -A && git commit`, `cd <wt>; git commit`, `(cd <wt> && git commit)`,
# `GIT_EDITOR=true git commit`, all measured reaching git.
#
# The model: a Bash tool call is a COMMAND LIST. Segment it, then ask whether any
# SEGMENT is the gated command.
#
# Quoting is handled by NEUTRALISING separators inside quoted spans rather than
# blanking the span. The first version blanked them, which also erased the PATH in
# `cd "<worktree>" && git commit` and `git -C "<path>" commit`, so target-dir
# resolution silently fell back to the payload cwd and the gate passed a commit it
# should have blocked — a regression against the pre-refactor gates, caught in
# review of go-to-k/cdk-local#542. Segments therefore carry their original text;
# only the separator CHARACTERS inside quotes are swapped for placeholders while
# splitting, and swapped back afterwards. A verb inside a string still does not
# match, because the per-verb regexes are anchored at the segment START.

# Placeholders for separators that live inside quoted spans (never in real input).
GATE_SEP_AMP=$'\001'
GATE_SEP_SEMI=$'\002'
GATE_SEP_PIPE=$'\003'
GATE_SEP_SUBST=$'\004'

# One awk pass: join `\`-continuations, blank heredoc BODIES, neutralise
# separators inside quotes, and turn every real separator into a newline. Command
# substitutions (`$(...)` and backticks) become separators too — the text inside
# one RUNS, so `echo "$(git commit -m x)"` is a commit.
gate_segments_raw() {
  awk '
    # `q` is deliberately GLOBAL: a quoted span survives a newline, and a
    # `--body "…multi-line…"` argument is ONE span. Resetting it per line split a
    # PR body into segments and matched a `&& git commit` inside the prose
    # (caught in review of go-to-k/cdk-local#542).
    function flush_line(line,   i, n, c, out, prev) {
      out = ""; n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        prev = (i > 1) ? substr(line, i - 1, 1) : ""
        if (q == "") {
          if (c == "\"" || c == "'"'"'") { q = c; out = out c; continue }
          if (c == "$" && substr(line, i + 1, 1) == "(") { out = out "\n"; i++; continue }
          if (c == "`") { out = out "\n"; continue }
          if (c == "&" || c == ";" || c == "|") { out = out "\n"; continue }
          out = out c
          continue
        }
        # inside a quoted span
        if (c == "\\" && q == "\"") { out = out c substr(line, i + 1, 1); i++; continue }
        if (c == q) { q = ""; out = out c; continue }
        if (c == "&") { out = out SEP_AMP; continue }
        if (c == ";") { out = out SEP_SEMI; continue }
        if (c == "|") { out = out SEP_PIPE; continue }
        if (c == "$" && substr(line, i + 1, 1) == "(") { out = out SEP_SUBST "("; i++; continue }
        out = out c
      }
      return out
    }
    BEGIN { tag = ""; pending = ""; q = "" }
    {
      line = $0
      sub(/\r$/, "", line)
      if (tag != "") {                      # inside a heredoc body: data, not commands
        t = line
        gsub(/^[ \t]+|[ \t]+$/, "", t)
        if (t == tag) tag = ""
        print ""
        next
      }
      if (pending != "") { line = pending line; pending = "" }
      if (line ~ /\\$/) {                   # `\`-continuation: join with the next line
        sub(/\\$/, "", line)
        pending = line
        next
      }
      if (match(line, /<<-?[ \t]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/)) {
        t = substr(line, RSTART, RLENGTH)
        gsub(/^<<-?[ \t]*|["'"'"']/, "", t)
        tag = t
      }
      print flush_line(line)
    }
    END { if (pending != "") print flush_line(pending) }
  ' SEP_AMP="$GATE_SEP_AMP" SEP_SEMI="$GATE_SEP_SEMI" SEP_PIPE="$GATE_SEP_PIPE" \
    SEP_SUBST="$GATE_SEP_SUBST" <<< "$1"
}

# Leading words that introduce a command without being one: env assignments,
# wrappers, and the keywords that open a compound statement.
gate_strip_prefix() {
  local s="$1"
  # Trim first: a segment split off after a separator starts with a space, and
  # every verb regex is anchored at the segment start.
  s="${s#"${s%%[![:space:]]*}"}"
  # `bash -c "<cmd>"` RUNS its argument, so a gated verb inside it is a gated
  # command (go-to-k/cdk-local#542 review).
  if [[ "$s" =~ ^(bash|zsh|ksh|sh)[[:space:]]+-[a-z]*c[[:space:]]+[\"\'](.*)[\"\'][[:space:]]*$ ]]; then
    s="${BASH_REMATCH[2]}"
  fi
  while [[ "$s" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|nohup|time|timeout[[:space:]]+[^[:space:]]+|exec|then|do|else|elif|\{|\()[[:space:]]+(.*)$ ]]; do
    s="${BASH_REMATCH[2]}"
  done
  # Any remaining grouping punctuation at either end (nested subshells).
  while [[ "$s" =~ ^[[:space:]]*[\(\{][[:space:]]*(.*)$ ]]; do s="${BASH_REMATCH[1]}"; done
  while [[ "$s" =~ ^(.*[^[:space:]])[[:space:]]*[\)\}][[:space:]]*$ ]]; do s="${BASH_REMATCH[1]}"; done
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Print one command segment per line, in the ORIGINAL text (placeholders restored).
gate_segments() {
  local segment
  while IFS= read -r segment; do
    segment="${segment//"$GATE_SEP_AMP"/&}"
    segment="${segment//"$GATE_SEP_SEMI"/;}"
    segment="${segment//"$GATE_SEP_PIPE"/|}"
    segment="${segment//"$GATE_SEP_SUBST"/$}"
    segment=$(gate_strip_prefix "$segment")
    [ -n "$segment" ] && printf '%s\n' "$segment"
  done < <(gate_segments_raw "$1")
}

# gate_matches <cmd> <extended-regex>
# 0 when any segment matches. Bash-native `=~` rather than a `grep` per segment:
# these hooks run on every matching Bash tool call, and the fork per segment per
# gate was measured at ~5x the whole gate suite's latency in review of
# go-to-k/cdk-local#542.
gate_matches() {
  local cmd="$1" re="$2" segment
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] && return 0
  done < <(gate_segments "$cmd")
  return 1
}

# A path token: a quoted span (either quote character) or a bare run of
# non-space. Held in a variable because a literal `[[ =~ ]]` pattern cannot carry
# both quote characters inside one bracket expression.
GATE_PATH_TOKEN='("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+)'

# The regexes, kept here so every gate spells its verb the same way. Each is
# anchored at the START of a segment; `git -C <path>` / `git -c k=v` and
# `gh -C <path>` are absorbed — including a QUOTED path containing spaces, which
# an earlier version could not parse, so `git -C "/a b" commit` matched nothing
# and ran ungated (go-to-k/cdk-local#542 review).
GATE_FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]-][^[:space:]]*))?)*'
GATE_GH_C='([[:space:]]+-C[[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+))?'
GATE_RE_GIT_COMMIT="^git${GATE_FLAGS}[[:space:]]+commit([[:space:]]|$)"
GATE_RE_GIT_PUSH="^git${GATE_FLAGS}[[:space:]]+push([[:space:]]|$)"
GATE_RE_GH_PR_CREATE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
GATE_RE_GH_PR_EDIT="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+edit([[:space:]]|$)"
GATE_RE_GH_PR_MERGE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)"

# cdk-local gates more verbs than its siblings; same construction.
GATE_RE_GIT_SWITCH="^git${GATE_FLAGS}[[:space:]]+switch([[:space:]]|$)"
GATE_RE_GIT_CHECKOUT="^git${GATE_FLAGS}[[:space:]]+checkout([[:space:]]|$)"
GATE_RE_GIT_MERGE="^git${GATE_FLAGS}[[:space:]]+merge([[:space:]]|$)"
GATE_RE_GH_ISSUE_CREATE="^gh${GATE_GH_C}[[:space:]]+issue[[:space:]]+create([[:space:]]|$)"
GATE_RE_GH_ISSUE_COMMENT="^gh${GATE_GH_C}[[:space:]]+issue[[:space:]]+comment([[:space:]]|$)"
GATE_RE_GH_API="^gh${GATE_GH_C}[[:space:]]+api([[:space:]]|$)"

# Strip one layer of surrounding quotes from a path token.
gate_unquote() {
  local p="$1"
  p="${p%\"}"; p="${p#\"}"
  p="${p%\'}"; p="${p#\'}"
  printf '%s' "$p"
}

# gate_target_dir <cmd> <fallback> <extended-regex>
# The working tree the gated command will actually run in:
#   1. a `-C <path>` inside the MATCHED segment wins (git -C / gh -C), else
#   2. the last `cd <path>` segment BEFORE the matched one, else
#   3. the fallback (the hook payload's cwd).
# Quoted paths survive: segments carry their original text (see the header).
gate_target_dir() {
  local cmd="$1" fallback="$2" re="$3"
  local target="$fallback" segment cd_target c_target remaining
  while IFS= read -r segment; do
    if [[ "$segment" =~ ^cd[[:space:]]+$GATE_PATH_TOKEN ]]; then
      cd_target=$(gate_unquote "${BASH_REMATCH[1]}")
      [ -z "$cd_target" ] && continue
      [[ "$cd_target" != /* ]] && cd_target="$target/$cd_target"
      target="$cd_target"
      continue
    fi
    [[ "$segment" =~ $re ]] || continue
    # Last `-C <path>` in this segment wins over any earlier cd.
    if [[ "$segment" =~ (git|gh)[[:space:]]+-C[[:space:]]+$GATE_PATH_TOKEN ]]; then
      c_target=""
      remaining="$segment"
      while [[ "$remaining" =~ (git|gh)[[:space:]]+-C[[:space:]]+$GATE_PATH_TOKEN ]]; do
        c_target="${BASH_REMATCH[2]}"
        remaining="${remaining#*"${BASH_REMATCH[0]}"}"
      done
      c_target=$(gate_unquote "$c_target")
      if [ -n "$c_target" ]; then
        [[ "$c_target" != /* ]] && c_target="$target/$c_target"
        target="$c_target"
      fi
    fi
    break
  done < <(gate_segments "$cmd")
  printf '%s' "$target"
}
