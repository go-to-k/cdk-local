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
    # `q` (the open quote character) is GLOBAL: a quoted span survives a newline,
    # and a `--body "…multi-line…"` argument is ONE span. Resetting it per line
    # split a PR body into segments and matched a `&& git commit` inside the
    # prose (go-to-k/cdk-local#542 review).
    #
    # `ignore_q` is set on the SECOND pass: if the whole input ends with a quote
    # still open, that character was not a quote at all (an apostrophe in
    # `echo dont do it`), and treating it as one swallowed every command after it
    # — fail open. The pass is redone with that character literal
    # (go-to-k/cdkd#2130).
    function flush_line(line,   i, n, c, out) {
      out = ""; n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (q == "") {
          # An escaped character outside quotes is LITERAL: `echo a\; git commit`
          # is ONE echo, and splitting on that `;` blocked it (go-to-k/cdkd#2130
          # test review).
          if (c == "\\") { out = out c substr(line, i + 1, 1); i++; continue }
          if ((c == "\"" || c == "'"'"'") && c != ignore_q) { q = c; out = out c; continue }
          if (c == "$" && substr(line, i + 1, 1) == "(") { out = out "\n"; i++; continue }
          # Process substitution runs its body too: `diff <(git commit) …`.
          if ((c == "<" || c == ">") && substr(line, i + 1, 1) == "(") { out = out "\n"; i++; continue }
          if (c == "`") { out = out "\n"; continue }
          if (c == "&" || c == ";" || c == "|") { out = out "\n"; continue }
          out = out c
          continue
        }
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
    # The line with every QUOTED span blanked, for the heredoc-opener test only:
    # `echo "use <<EOF here"` is a mention, and honouring it blanked the rest of
    # the command (go-to-k/cdkd#2130).
    function unquoted_part(line,   i, n, c, out, inq, prev2) {
      out = ""; inq = ""; n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        prev2 = (i > 2) ? substr(line, i - 2, 2) : ""
        if (inq == "") {
          # A quote right after `<<` (or `<<-`) is part of a heredoc TAG, not a
          # span: `cat <<'"'"'EOF'"'"'` is an ordinary opener. Blanking it lost the tag,
          # so the body was treated as commands and this repo blocked its own
          # scripts (go-to-k/cdkd#2130 review).
          if ((c == "\"" || c == "'"'"'") && (prev2 == "<<" || substr(line, i - 1, 1) == "-" && substr(line, i - 3, 2) == "<<")) { out = out c; continue }
          if ((c == "\"" || c == "'"'"'") && c != ignore_q) { inq = c; out = out " "; continue }
          out = out c
        } else {
          if (c == inq) inq = ""
          out = out " "
        }
      }
      return out
    }
    # Does a line equal to `t` appear later? An opener whose delimiter never
    # reappears is not a heredoc; honouring it swallowed the rest of the command
    # (go-to-k/cdkd#2130, fixed for the same shape in go-to-k/cdkd#1455).
    function terminated(t, from,   k, probe) {
      for (k = from; k <= total; k++) {
        probe = raw[k]
        sub(/\r$/, "", probe)
        gsub(/^[ \t]+|[ \t]+$/, "", probe)
        if (probe == t) return 1
      }
      return 0
    }
    function emit(i,   line, t, neutral, bare) {
      line = raw[i]
      sub(/\r$/, "", line)
      if (tag != "") {                      # heredoc body: data, not commands
        t = line
        gsub(/^[ \t]+|[ \t]+$/, "", t)
        if (t == tag) tag = ""
        outbuf[++outn] = ""
        return
      }
      if (pending != "") { line = pending line; pending = "" }
      if (line ~ /\\$/) {                   # `\`-continuation
        sub(/\\$/, "", line)
        pending = line
        return
      }
      neutral = flush_line(line)
      bare = unquoted_part(line)
      if (match(bare, /<<-?[ \t]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/)) {
        t = substr(bare, RSTART, RLENGTH)
        gsub(/^<<-?[ \t]*|["'"'"']/, "", t)
        if (terminated(t, i + 1)) tag = t
      }
      # A quoted span that continues past the newline is ONE argument, so its
      # lines must not become separate segments: a `--body "…"` whose second
      # line STARTS with a gated verb was matched and blocked (go-to-k/cdkd#2130
      # review). Join the continuation onto the segment that opened the span.
      if (open_span != "") {
        outbuf[outn] = outbuf[outn] " " neutral
      } else {
        outbuf[++outn] = neutral
      }
      open_span = q
    }
    function run_pass(   i) {
      q = ""; tag = ""; pending = ""; outn = 0; open_span = ""
      for (i = 1; i <= total; i++) emit(i)
      if (pending != "") outbuf[++outn] = flush_line(pending)
    }
    BEGIN { ignore_q = "" }
    { raw[NR] = $0; total = NR }
    END {
      run_pass()
      if (q != "") { ignore_q = q; run_pass() }   # that quote was not a quote
      for (i = 1; i <= outn; i++) print outbuf[i]
    }
  ' SEP_AMP="$GATE_SEP_AMP" SEP_SEMI="$GATE_SEP_SEMI" SEP_PIPE="$GATE_SEP_PIPE" \
    SEP_SUBST="$GATE_SEP_SUBST" <<< "$1"
}

# Leading words that introduce a command without being one: env assignments,
# wrappers, and the keywords that open a compound statement.
gate_strip_prefix() {
  local s="$1" prev=""
  s="${s#"${s%%[![:space:]]*}"}"
  # Strip leaders until stable: a `case <word> in` opener, a `<pattern>)` arm
  # label, compound-statement keywords, wrappers, and env assignments can nest
  # (`case a in a) sudo git commit`). `if|while|until|!|sudo|xargs` were missing,
  # so `if <verb>; then …`, `! <verb>` and `sudo <verb>` ran UNGATED — a
  # regression for every gate that traded an unanchored grep for this matcher
  # (go-to-k/cdkd#2130 review).
  while [ "$s" != "$prev" ]; do
    prev="$s"
    if [[ "$s" =~ ^[[:space:]]*case[[:space:]]+[^[:space:]]+[[:space:]]+in[[:space:]]+(.*)$ ]]; then
      s="${BASH_REMATCH[1]}"
    fi
    if [[ "$s" =~ ^[[:space:]]*[^\(\)\|\;\&[:space:]]+\)[[:space:]]*(.*)$ ]]; then
      s="${BASH_REMATCH[1]}"
    fi
    if [[ "$s" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|nohup|time|timeout[[:space:]]+[^[:space:]]+|exec|then|do|else|elif|if|while|until|!|sudo|xargs|-[A-Za-z][^[:space:]]*|\{|\()[[:space:]]+(.*)$ ]]; then
      s="${BASH_REMATCH[2]}"
    fi
    s="${s#"${s%%[![:space:]]*}"}"
  done
  # Any remaining grouping punctuation at either end (nested subshells).
  while [[ "$s" =~ ^[[:space:]]*[\(\{][[:space:]]*(.*)$ ]]; do s="${BASH_REMATCH[1]}"; done
  while [[ "$s" =~ ^(.*[^[:space:]])[[:space:]]*[\)\}][[:space:]]*$ ]]; do s="${BASH_REMATCH[1]}"; done
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Strip one surrounding quote pair from a whole argument (the `bash -c` body).
gate_unquote_span() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

# Print one command segment per line, in the ORIGINAL text (placeholders restored).
gate_segments() {
  local segment
  while IFS= read -r segment; do
    # NOT `${segment//"$GATE_SEP_AMP"/&}`: since bash 5.2 an `&` in the
    # replacement means the MATCHED TEXT, so the placeholder survived and a
    # quoted path containing `&` came back corrupted — the gate then failed to
    # resolve the tree and exited 0 (go-to-k/cdkd#2130 review). Version-dependent:
    # macOS bash 3.2 masks it.
    while [[ "$segment" == *"$GATE_SEP_AMP"* ]]; do
      segment="${segment%%"$GATE_SEP_AMP"*}&${segment#*"$GATE_SEP_AMP"}"
    done
    segment="${segment//"$GATE_SEP_SEMI"/;}"
    segment="${segment//"$GATE_SEP_PIPE"/|}"
    segment="${segment//"$GATE_SEP_SUBST"/$}"
    segment=$(gate_strip_prefix "$segment")
    # `bash -c "<cmd>"` RUNS its argument, and that argument is a command LIST:
    # matching it as ONE segment missed `bash -c "cd /w && git commit"`
    # (go-to-k/cdkd#2130 test review). Recurse ONLY here — re-segmenting every
    # segment would split a quoted `--body` whose prose contains `&&`.
    if [[ "$segment" =~ ^(bash|zsh|ksh|sh)[[:space:]]+-[a-z]*c[[:space:]]+(.*)$ ]]; then
      gate_segments "$(gate_unquote_span "${BASH_REMATCH[2]}")"
      continue
    fi
    # An `if`, not `[ … ] && printf`: under a caller's `set -e` the trailing
    # false test aborts the whole function, and the segments after it are never
    # emitted — a silent fail-open that depends on which gate sources this.
    if [ -n "$segment" ]; then printf '%s\n' "$segment"; fi
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
# `gh` flags for the ISSUE-MINT gate only: `-C <path>` AND `-R <owner/repo>` /
# `--repo <owner/repo>`, quoted alternatives included, repeatable so
# `gh -C /w/t -R o/r issue create` is absorbed too.
#
# A SEPARATE constant rather than a widening of GATE_GH_C, because GATE_GH_C is
# the flag absorber for every other gh verb regex in this file --
# GATE_RE_GH_PR_CREATE / _EDIT / _MERGE, GATE_RE_GH_ISSUE_CREATE,
# GATE_RE_GH_ISSUE_COMMENT and GATE_RE_GH_API -- which between them decide the
# trigger surface of verify-pr-gate, pr-review-gate, integ-gate,
# closes-paren-form-gate, gh-pr-merge-worktree-gate, non-english-text-gate,
# docs-inline-json-flag-gate, cdkd-parity-gate, create-integ-gate and
# pr-body-item-number-gate. Those surfaces must not change here.
#
# Why the issue mint needs the wider absorber and the others (for now) do not:
# `gh -R go-to-k/<target> issue create` is the CROSS-REPO MIRROR flow's own
# spelling -- `/work-issues` section 10-c runs it from one repo's worktree into
# a sibling -- and that flow is the documented duplicate GENERATOR that
# issue-dup-check-gate exists to fence (go-to-k/cdk-local#528 /
# go-to-k/cdk-local#531). A gate whose stated reason for existing is the mirror
# path but which does not match the mirror path's command is close to inert.
GATE_GH_CR='([[:space:]]+(-C|-R|--repo)[[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+))*'
# The REST spelling of MINTING an issue, for issue-dup-check-gate. `gh api
# repos/<o>/<r>/issues` with a `title=` field creates an issue, so the gate that
# refuses `gh issue create` has to refuse this too or the trigger is
# under-approximated. The path must NOT continue past `issues`, which is what
# separates a mint from `/issues/<n>/comments` (a comment) and `/issues/<n>`
# (an edit) -- neither of which mints anything, and both of which are the
# CHEAP path this gate exists to steer toward. The trailing `\"` alternative
# catches a fully quoted path argument. Built on GATE_GH_CR: this constant is
# NEW, so it has no existing consumer whose surface could change.
GATE_RE_GH_API_ISSUE_CREATE="^gh${GATE_GH_CR}[[:space:]]+api([[:space:]]|$).*repos/[^[:space:]/]+/[^[:space:]/]+/issues([[:space:]]|$|\")"

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
      # An UNEXPANDED path is not a path. `cd "$WT" && …` is the spelling this
      # flow mandates, and resolving it literally produced `<cwd>/$WT`, which no
      # `git -C` can read — so the gate could not resolve a tree and exited 0.
      # Skipping it falls back to the payload cwd, which fails CLOSED
      # (go-to-k/cdkd#2130 review).
      case "$cd_target" in *'$'*|*'`'*) continue ;; esac
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
      case "$c_target" in *'$'*|*'`'*) c_target="" ;; esac
      if [ -n "$c_target" ]; then
        [[ "$c_target" != /* ]] && c_target="$target/$c_target"
        target="$c_target"
      fi
    fi
    break
  done < <(gate_segments "$cmd")
  printf '%s' "$target"
}
