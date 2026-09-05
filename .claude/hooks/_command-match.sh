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

# Appended to a segment that is the LEFT side of a real `|` pipeline, and ONLY
# when a caller asks for it (`gate_segments_raw <cmd> "$GATE_PIPE_MARK"`). The
# ordinary separator pass collapses `&&`, `;` and `|` to the same newline, so no
# gate could tell "its exit status is the caller's" from "the shell threw its
# exit status away in favour of the last stage" (go-to-k/cdk-local#571). Default
# empty, so every existing caller gets byte-identical segments.
GATE_PIPE_MARK=$'\005'

# gate_segments_raw <cmd> [<pipe-mark>]
#
# One awk pass: join `\`-continuations, blank heredoc BODIES, neutralise
# separators inside quotes, and turn every real separator into a newline. Command
# substitutions (`$(...)` and backticks) become separators too — the text inside
# one RUNS, so `echo "$(git commit -m x)"` is a commit.
#
# <pipe-mark>, when non-empty, is appended to each segment that feeds a `|`
# pipeline, so a caller can ask which segments had their exit status discarded.
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
          # Closing a `$(…)` / backtick substitution that was opened from INSIDE
          # a double-quoted span (see the sub_open branch below). Until then the
          # body was left quoted, so `echo "$(gh pr merge 1 --squash)"` matched
          # NOTHING and ran ungated through every gate here -- the same class of
          # false accept as go-to-k/cdk-local#571, found by its test suite.
          #
          # The close RE-EMITS the enclosing quote character before the rest of
          # the span. Ending the body needs a newline, and that newline turns
          # the PROSE that follows the substitution into a fresh segment -- so
          # `--body "see $(date) then gh pr merge 1"` started a segment at
          # `then gh pr merge 1`, which `gate_strip_prefix` reduced to a live
          # verb. That is the go-to-k/cdkd#2130 prose-in-a-body regression,
          # re-entering through the other end. A leading quote character cannot
          # be stripped and no verb regex can match past it, so the trailing
          # prose is inert again while the body stays visible.
          if (sdepth > 0 && stype[sdepth] == "(" && c == "(") { sparen[sdepth]++; out = out c; continue }
          if (sdepth > 0 && stype[sdepth] == "(" && c == ")") {
            sparen[sdepth]--
            if (sparen[sdepth] <= 0) { out = out "\n" squote[sdepth]; q = squote[sdepth]; sdepth--; continue }
            out = out c; continue
          }
          if (sdepth > 0 && stype[sdepth] == "`" && c == "`") { out = out "\n" squote[sdepth]; q = squote[sdepth]; sdepth--; continue }
          # An escaped character outside quotes is LITERAL: `echo a\; git commit`
          # is ONE echo, and splitting on that `;` blocked it (go-to-k/cdkd#2130
          # test review).
          if (c == "\\") { out = out c substr(line, i + 1, 1); i++; continue }
          if ((c == "\"" || c == "'"'"'") && c != ignore_q) { q = c; out = out c; continue }
          # These three consume their `(` with `i++`, so it never reaches the
          # generic paren counter above. A NESTED substitution therefore closed
          # the OUTER one a paren early, which broke both ways:
          # `--body "ver $(echo $(date)) then git commit -m z"` re-emitted the
          # quote too soon and every git/gh gate then REFUSED it, while
          # `echo "$(echo $(date); gh pr merge 1 --squash)"` still matched
          # nothing. Count it here instead. The `stype` test matters: a backtick
          # substitution carries `sparen = 0` and must not be paren-tracked.
          if (c == "$" && substr(line, i + 1, 1) == "(") { if (sdepth > 0 && stype[sdepth] == "(") sparen[sdepth]++; out = out "\n"; i++; continue }
          # Process substitution runs its body too: `diff <(git commit) …`.
          if ((c == "<" || c == ">") && substr(line, i + 1, 1) == "(") { if (sdepth > 0 && stype[sdepth] == "(") sparen[sdepth]++; out = out "\n"; i++; continue }
          if (c == "`") { out = out "\n"; continue }
          # `||` is a logical OR, not a pipe: there the left exit status is
          # what DECIDES whether the right side runs, so it is never lost. Only
          # a single `|` (and `|&`) discards it. Consuming both characters also
          # drops the empty segment `||` used to produce, which `gate_segments`
          # was filtering out anyway. NOTE no apostrophes in this awk body --
          # it is a single-quoted shell string.
          if (c == "|" && substr(line, i + 1, 1) == "|") { out = out "\n"; i++; continue }
          if (c == "|") { out = out PIPE_MARK "\n"; continue }
          # `&` is a separator only when it is not part of a REDIRECTION.
          # `2>&1` used to split here, which cost the anchored verb regexes
          # nothing (the split lands after the verb) but put the pipe mark on
          # the wrong segment: `markgate verify integ 2>&1 | tail` marked the
          # `1` and reported the markgate segment as unpiped -- i.e. the exact
          # command from go-to-k/cdk-local#571 walked past its own gate.
          if (c == "&" && substr(line, i + 1, 1) == "&") { out = out "\n"; i++; continue }
          if (c == "&" && (substr(out, length(out), 1) == ">" || substr(out, length(out), 1) == "<")) { out = out c; continue }
          if (c == "&" && substr(line, i + 1, 1) == ">") { out = out c; continue }
          if (c == "&" || c == ";") { out = out "\n"; continue }
          out = out c
          continue
        }
        if (c == "\\" && q == "\"") { out = out c substr(line, i + 1, 1); i++; continue }
        if (c == q) { q = ""; out = out c; continue }
        # A command substitution inside a DOUBLE-quoted span RUNS. Leaving it
        # quoted is what let the bypass above through. Inside a SINGLE-quoted
        # span it is literal, so nothing changes there -- that asymmetry is the
        # whole point, and it is why this branch tests q rather than assuming.
        if (q == "\"" && c == "$" && substr(line, i + 1, 1) == "(") {
          sdepth++; squote[sdepth] = q; stype[sdepth] = "("; sparen[sdepth] = 1
          q = ""; out = out "\n"; i++; continue
        }
        if (q == "\"" && c == "`") {
          sdepth++; squote[sdepth] = q; stype[sdepth] = "`"; sparen[sdepth] = 0
          q = ""; out = out "\n"; continue
        }
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
      q = ""; tag = ""; pending = ""; outn = 0; open_span = ""; sdepth = 0
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
    SEP_SUBST="$GATE_SEP_SUBST" PIPE_MARK="${2:-}" <<< "$1"
}

# ---------------------------------------------------------------------------
# Command STRINGS: which leading words RUN their quoted argument.
#
# `bash -c "<cmd>"` was the only shape recognised, so `mise exec -c "<cmd>"` --
# which runs its argument exactly the same way -- stayed ONE opaque token and
# EVERY gate here was blind to it (go-to-k/cdk-local#585):
#
#   mise exec -c "markgate verify integ | tail -5"   # not refused
#   mise exec -c "gh pr merge 1 --squash"            # reached gh ungated
#
# `mise x -c` and `rtx exec -c` are the same shape. `mise exec -- <cmd>` is NOT
# this shape -- there the command is ordinary argv rather than a string -- and
# it needs no recursion for the one regex that cares, since
# `GATE_RE_MARKGATE_VERDICT` absorbs the launcher itself via
# `GATE_MARKGATE_LAUNCH`.
#
# The obvious `^(bash|zsh|ksh|sh|mise|rtx)` is WRONG: `mise -c` is not a thing,
# only `mise exec -c` / `mise x -c` is, so the SUBCOMMAND is REQUIRED -- without
# it the recursion would descend into text that never runs.
#
# Every token class below EXCLUDES quote characters, and `-c` / `--command` is
# excluded from the flag run that may precede it. Both are about keeping the
# parse UNIQUE rather than about what mise accepts: `=~` is POSIX
# leftmost-longest, so an alternative able to start INSIDE a quoted span lets
# the flag run reach a LATER `-c` and hand back the wrong body --
# `mise exec -c "sh -c 'gh pr merge 1'"` would then recurse into
# `gh pr merge 1'"`, which no verb regex matches, i.e. the very under-match this
# fix exists to close.
GATE_MISE_CMD_FLAG="(-c|--command)"
GATE_MISE_VALUE_FLAG_NOCMD="(-C|--cd|-E|--env|-j|--jobs|--allow-env|--allow-net|--allow-read|--allow-write)"
GATE_CMDSTRING_VALUE="(\"[^\"]*\"|'[^']*'|[^-[:space:]\"'][^[:space:]\"']*)"
# One run of flags may sit before the subcommand and another between it and
# `-c`: a value-taking flag with its value, a boolean flag, or a `tool@version`
# pin (`mise exec node@20 -c "…"`).
GATE_CMDSTRING_FLAGS="([[:space:]]+(${GATE_MISE_VALUE_FLAG_NOCMD}[[:space:]]+${GATE_CMDSTRING_VALUE}|--?[A-Za-z][^[:space:]\"']*|[^[:space:]\"']+@[^[:space:]\"']+))*"
# Matches the PREFIX only -- the body is `${segment#"${BASH_REMATCH[0]}"}`, the
# same technique `gate_pr_selector` uses, so nothing depends on a capture index
# that the added alternative would renumber.
GATE_RE_CMDSTRING="^((bash|zsh|ksh|sh)[[:space:]]+-[a-z]*c[[:space:]]+|([^[:space:]]*/)?(mise|rtx)${GATE_CMDSTRING_FLAGS}[[:space:]]+(exec|x)${GATE_CMDSTRING_FLAGS}[[:space:]]+${GATE_MISE_CMD_FLAG}([[:space:]]+|=))"
#
# The PASSTHROUGH spelling of the same launcher, `mise exec -- <cmd>`, is NOT a
# command string: the rest of the argv IS the command, so it belongs with the
# LEADERS `gate_strip_prefix` already strips (`env`, `nohup`, `sudo`, `xargs`
# …). `exec` is in that list, but the `mise` word, its flags, its subcommand and
# the bare `--` are not -- and the list's `-[A-Za-z][^[:space:]]*` cannot absorb
# `--`, which has no LETTER after the dash. So every gate here except the
# markgate one was blind to it, in the same measurement as the `-c` hole above:
#
#   mise exec -- gh pr merge 1 --squash   # reached gh ungated
#   mise exec -- git commit -m x          # reached git ungated
#
# `GATE_RE_MARKGATE_VERDICT` was the lone exception -- it absorbs the launcher
# inside the verb regex itself, via `GATE_MARKGATE_LAUNCH` -- which is why the
# defect was found through a markgate pipe and this half of it was not.
#
# The SUBCOMMAND is required for the same reason it is above: `mise install` and
# `mise <verb>` are not passthroughs, and stripping one would hand every gate
# text that never ran as a command.
GATE_RE_LAUNCH_PASSTHRU="([^[:space:]]*/)?(mise|rtx)${GATE_CMDSTRING_FLAGS}[[:space:]]+(exec|x)${GATE_CMDSTRING_FLAGS}[[:space:]]+--"

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
    # `${s#"${BASH_REMATCH[0]}"}` rather than a trailing `(.*)$` capture: the
    # launcher-passthrough alternative brings its own groups, and any capture
    # added inside the alternation RENUMBERS a tail group. Reading the tail as
    # "whatever the match did not consume" is immune to that -- the same reason
    # `gate_pr_selector` scans from `BASH_REMATCH[0]`. Behaviour is unchanged:
    # `[[:space:]]+` is greedy either way, so the removed prefix is exactly the
    # leader plus its trailing run.
    if [[ "$s" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|nohup|time|timeout[[:space:]]+[^[:space:]]+|${GATE_RE_LAUNCH_PASSTHRU}|exec|then|do|else|elif|if|while|until|!|sudo|xargs|-[A-Za-z][^[:space:]]*|\{|\()[[:space:]]+ ]]; then
      s="${s#"${BASH_REMATCH[0]}"}"
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

# gate_segments <cmd> [<pipe-mark>]
#
# Print one command segment per line, in the ORIGINAL text (placeholders
# restored). <pipe-mark> is threaded straight through to `gate_segments_raw`,
# INCLUDING into the `bash -c` recursion below — a pipe inside `bash -c "…"` is
# a pipe, and dropping the argument there would have made the recursion the one
# blind spot of the piped-segment scan.
gate_segments() {
  local segment mark="${2:-}" piped inner body
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
    # Detach the pipe mark BEFORE `gate_strip_prefix` and re-attach after.
    # Left in place it is the segment's last character, so the trailing-space
    # and trailing-`)` trims both no-op: `markgate verify a | tail` came out as
    # `"markgate verify a "` and `(markgate verify a) | tail` as
    # `"markgate verify a)"`. Harmless for the start-anchored regexes in use
    # today, silently fatal for the first `$`-anchored one anybody writes.
    piped=""
    if [ -n "$mark" ] && [[ "$segment" == *"$mark"* ]]; then
      piped="$mark"
      segment="${segment//"$mark"/}"
    fi
    segment=$(gate_strip_prefix "$segment")
    # `bash -c "<cmd>"` RUNS its argument, and that argument is a command LIST:
    # matching it as ONE segment missed `bash -c "cd /w && git commit"`
    # (go-to-k/cdkd#2130 test review). Recurse ONLY here — re-segmenting every
    # segment would split a quoted `--body` whose prose contains `&&`.
    # `GATE_RE_CMDSTRING` carries the launcher-hosted spelling of the same shape
    # (`mise exec -c "<cmd>"`, go-to-k/cdk-local#585); see its definition above.
    if [[ "$segment" =~ $GATE_RE_CMDSTRING ]]; then
      # `$piped` is re-attached to every segment the recursion yields, because
      # the pipe belongs to the OUTER command: in `bash -c 'markgate verify a'
      # | tail` it is the whole `bash -c` whose exit status the shell discards,
      # and the recursion had been dropping that fact on the floor, so
      # `gate_piped_segments` emitted NOTHING and the gate passed. Note it is
      # `$piped` and not `$GATE_PIPE_MARK`: marking unconditionally would mark
      # the inner segments of an UN-piped `bash -c` too.
      body="${segment#"${BASH_REMATCH[0]}"}"
      while IFS= read -r inner; do printf '%s\n' "$inner$piped"; done \
        < <(gate_segments "$(gate_unquote_span "$body")" "$mark")
      continue
    fi
    # An `if`, not `[ … ] && printf`: under a caller's `set -e` the trailing
    # false test aborts the whole function, and the segments after it are never
    # emitted — a silent fail-open that depends on which gate sources this.
    if [ -n "$segment" ]; then printf '%s\n' "$segment$piped"; fi
  done < <(gate_segments_raw "$1" "$mark")
}

# gate_piped_segments <cmd>
#
# Print only the segments whose exit status the shell THROWS AWAY because they
# feed a `|` pipeline — the mark is stripped, so what comes out is ordinary
# segment text. A segment that is the LAST stage of a pipeline is NOT printed:
# there `$?` really is that command's own status.
gate_piped_segments() {
  local segment
  while IFS= read -r segment; do
    case "$segment" in
      *"$GATE_PIPE_MARK"*) printf '%s\n' "${segment//"$GATE_PIPE_MARK"/}" ;;
    esac
  done < <(gate_segments "$1" "$GATE_PIPE_MARK")
}

# gate_matches_piped <cmd> <extended-regex>
# 0 when any segment that FEEDS a pipe matches. The piped twin of
# `gate_matches`, same anchoring and same segment model.
gate_matches_piped() {
  local cmd="$1" re="$2" segment
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] && return 0
  done < <(gate_piped_segments "$cmd")
  return 1
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

# A shell WORD, which may EMBED quoted spans rather than being one: `-c`'s value
# in `git -c core.pager="less -C /evil" commit` is a single word whose middle is
# quoted. GATE_PATH_TOKEN cannot express that -- it is "a quoted span OR a bare
# run of non-space", so it splits `core.pager="less` at the first space and the
# tail `-C /evil"` reads as a fresh `-C` flag. That is how a QUOTED FLAG VALUE
# steered the target directory: `git -c core.pager="less -C /evil" commit -m y`
# resolved to /evil, and through branch-gate with the repo on `main` that turned
# rc=2 into rc=0. Pre-existing on origin/main, but the widened `-C` scan makes it
# reachable in more shapes, so it is fixed here.
GATE_EMBEDDING_TOKEN='(("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]"'"'"'])+)'

# The regexes, kept here so every gate spells its verb the same way. Each is
# anchored at the START of a segment; `git -C <path>` / `git -c k=v` and
# `gh -C <path>` are absorbed — including a QUOTED path containing spaces, which
# an earlier version could not parse, so `git -C "/a b" commit` matched nothing
# and ran ungated (go-to-k/cdk-local#542 review).
GATE_FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]-][^[:space:]]*))?)*'
# `gh`'s leading flags, absorbed with the SAME token shape `git`'s are -- this is
# literally GATE_FLAGS, not a parallel list, and that is the point.
#
# Two rounds of under-approximation here, both LIVE GATE BYPASSES rather than
# cosmetic gaps, because every `gh` verb regex below is built on this constant:
#
#   1. It absorbed `-C <path>` ONLY, so `gh -R <owner/repo> pr merge 1 --squash`
#      matched NOTHING and ran ungated. Driven through the real hooks with
#      markgate stubbed stale: verify-pr-gate answered 2 to `gh pr merge
#      1 --squash` and 0 to the `-R` spelling, on `pr create` too, and
#      integ-gate the same.
#   2. Replacing it with an explicit `(-C|-R|--repo)` alternation fixed only the
#      SPACE-separated form, because that alternation demanded `[[:space:]]+`
#      between the flag and its value. `gh` accepts three separators, verified
#      against a real repo -- `gh pr list --repo=go-to-k/cdkd`,
#      `gh pr list -R=go-to-k/cdkd` and the GLUED `gh pr list -Rgo-to-k/cdkd`
#      all return the same PR number -- so `gh --repo=<owner/repo> pr merge
#      --squash` still walked past verify-pr-gate, one keystroke from the
#      bypass just closed. The `-C` support had the same hole all along:
#      `gh -C=/w/t pr merge` did not match either.
#
# GATE_FLAGS' token is `-[^[:space:]]+`, which swallows `--repo=X`, `-R=X` and
# `-RX` WHOLE -- the value group is needed only for the space-separated form. So
# all three separators fall out of the token shape instead of being enumerated,
# which is why this is not an explicit flag list: an alternation has to spell
# each flag times each separator, and the glued form is the one it is most
# likely to miss. Being wider than "repo/dir flags" costs nothing, since a flag
# regex only decides which spellings REACH the verb -- `_command-match.test.sh`
# pins that no `gh` verb matches a DIFFERENT `gh` verb, which is the failure
# mode a flag absorber could actually introduce.
#
# Like GATE_FLAGS, this contributes THREE capture groups -- the same count the
# explicit alternation had, so no `BASH_REMATCH` index anywhere shifts.
#
# The equality of the plain and flagged spellings is asserted THROUGH the gates
# in `gate-command-recognition.test.sh`, not only at the regex level: a matcher
# test can only fail once someone already suspects the flag, which is how both
# rounds of this survived. Same defect and same fix as go-to-k/cdkd#2027 review
# round 4, whose GATE_GH_C is this same GATE_FLAGS.
GATE_GH_C="$GATE_FLAGS"
GATE_RE_GIT_COMMIT="^git${GATE_FLAGS}[[:space:]]+commit([[:space:]]|$)"
GATE_RE_GIT_PUSH="^git${GATE_FLAGS}[[:space:]]+push([[:space:]]|$)"
GATE_RE_GH_PR_CREATE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
GATE_RE_GH_PR_EDIT="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+edit([[:space:]]|$)"
GATE_RE_GH_PR_MERGE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)"

# cdk-local gates more verbs than its siblings; same construction.
GATE_RE_GIT_SWITCH="^git${GATE_FLAGS}[[:space:]]+switch([[:space:]]|$)"
GATE_RE_GIT_CHECKOUT="^git${GATE_FLAGS}[[:space:]]+checkout([[:space:]]|$)"
GATE_RE_GIT_MERGE="^git${GATE_FLAGS}[[:space:]]+merge([[:space:]]|$)"
# control-char-gate: a `git add` in the SAME Bash call as the `git commit` is
# what makes the commit's content differ from the index the gate can see. A
# PreToolUse hook runs BEFORE its command, so `git add -A && git commit -F msg`
# presents the gate with the PRE-add index and the offending file is invisible
# (go-to-k/cdk-local#576). Built the same way every other verb here is, so
# `git -C <path> add`, a launcher prefix and quoted spans all reach it.
# `stage` is git's own built-in alias for `add` (not a user alias), so it has
# to be here or the staging scan is one synonym away from being skipped.
# The extra group is harmless: nothing reads a numbered BASH_REMATCH off
# this regex -- `gate_target_dir` and `gate_verb_args` use [0] only.
GATE_RE_GIT_ADD="^git${GATE_FLAGS}[[:space:]]+(add|stage)([[:space:]]|$)"
GATE_RE_GH_ISSUE_CREATE="^gh${GATE_GH_C}[[:space:]]+issue[[:space:]]+create([[:space:]]|$)"
# issue-classification-label-gate: the CLAIM site. `/work-issues` says most open
# bodies are still in the old packed shape and are upgraded to the four-line
# shape when the issue is claimed, so `edit` -- not `create` -- is where
# `Severity` first exists for the bulk of the backlog. `comment` stays absent:
# a comment is not the issue's classification.
GATE_RE_GH_ISSUE_EDIT="^gh${GATE_GH_C}[[:space:]]+issue[[:space:]]+edit([[:space:]]|$)"
GATE_RE_GH_ISSUE_COMMENT="^gh${GATE_GH_C}[[:space:]]+issue[[:space:]]+comment([[:space:]]|$)"
GATE_RE_GH_API="^gh${GATE_GH_C}[[:space:]]+api([[:space:]]|$)"

# markgate-pipe-gate: the markgate verbs whose whole answer is an EXIT CODE.
# `run` is `verify || (cmd && set)` sugar, so it has the identical property.
# `verify` prints NOTHING on the fresh path, so "no output, rc=0" is exactly
# what a healthy run looks like -- and exactly what `markgate verify integ
# 2>&1 | tail -5` reports for a STALE marker, because `$?` after a pipeline is
# the LAST stage. `markgate status` is deliberately ABSENT: its answer is on
# stdout, so piping it into `awk` is the correct use and every gate here does
# it (go-to-k/cdk-local#571).
#
# The launcher prefix absorbs the `mise exec -- markgate …` spelling every
# skill in this repo uses, plus `mise x`, an interposed tool pin
# (`mise exec markgate@0.4 -- markgate verify check`), and a path-qualified
# binary. It is anchored at the segment START like every other verb here, so a
# mention inside `echo`/`printf` is not a match -- the launcher is the ONLY
# thing allowed to precede `markgate`.
# The interposed run is restricted to things that can only be launcher
# arguments -- `--`, a flag, or a `tool@version` pin. An unrestricted
# `[^[:space:]]+` run instead made `mise exec -- rg markgate verify .claude |
# head` a FALSE BLOCK, which is a command someone auditing this very gate would
# type.
# Which flags TAKE A VALUE is enumerated rather than guessed, and this constant
# has now been wrong in all three possible directions, which is why:
#
#   too wide   an unrestricted `[^[:space:]]+` run absorbed the command word,
#              so `mise exec -- rg markgate verify .claude | head` -- the very
#              command someone auditing this gate types -- was a FALSE BLOCK.
#   too narrow allowing only `--` / a bare flag / a pin dropped every flag that
#              takes a value, so `mise exec -C /w -- markgate verify x | tail`
#              stopped blocking.
#   generic    giving EVERY flag an optional value made a BOOLEAN flag swallow
#              the command word instead, re-opening the false block one
#              keystroke away: `mise exec --raw rg markgate verify . | head`.
#              mise has many boolean flags (`--raw`, `-q`, `-v`, `-y`,
#              `--silent`, `--deny-all`, `--no-deps`, `--locked`).
#
# So: `--` is its own no-value alternative and comes FIRST (letting it take a
# value re-opens the false block, since `-- rg` would absorb); the value-taking
# flags are named; every other flag is boolean, which also covers the `=` and
# glued spellings because the token swallows them whole. The value alternation
# accepts a QUOTED value -- the same fix `GATE_FLAGS` needed for
# `git -C "/a b" commit` -- so `mise exec --cd "/w t" -- markgate ...` parses.
# An enumeration inherits the "too narrow" failure above, so it is taken from
# `mise exec --help` rather than from memory: these are ALL of its value-taking
# flags. The `--allow-*` sandbox four were missed on the first pass and were
# false negatives (the gate simply did not fire).
# Spelled as the union of the two halves defined above rather than as a second
# enumeration: `GATE_RE_CMDSTRING` needs this list MINUS `-c` / `--command`
# (which it matches itself), and a list written out twice is a list that drifts
# -- exactly the failure `UP_PATHS` keeps re-learning. Same language as before,
# only re-grouped; nothing indexes BASH_REMATCH on this regex.
GATE_MARKGATE_VALUE_FLAG="(${GATE_MISE_VALUE_FLAG_NOCMD}|${GATE_MISE_CMD_FLAG})"
GATE_MARKGATE_FLAG_VALUE="(\"[^\"]*\"|'[^']*'|[^-][^[:space:]]*)"
#
# The GLOBAL flag run before the subcommand (`mise -C /w exec -- markgate ...`)
# reuses the same alternation minus `--` and the pin, neither of which can
# precede a subcommand. Without it that spelling was under-matched, i.e. the
# gate simply did not fire -- the original defect, one flag position away.
GATE_MARKGATE_GLOBAL="([[:space:]]+(${GATE_MARKGATE_VALUE_FLAG}[[:space:]]+${GATE_MARKGATE_FLAG_VALUE}|--?[A-Za-z][^[:space:]]*))*"
GATE_MARKGATE_LAUNCH="(([^[:space:]]*/)?(mise|rtx)${GATE_MARKGATE_GLOBAL}[[:space:]]+(exec|x)([[:space:]]+(--|${GATE_MARKGATE_VALUE_FLAG}[[:space:]]+${GATE_MARKGATE_FLAG_VALUE}|--?[A-Za-z][^[:space:]]*|[^[:space:]]+@[^[:space:]]+))*[[:space:]]+)?"
GATE_RE_MARKGATE_VERDICT="^${GATE_MARKGATE_LAUNCH}([^[:space:]]*/)?markgate[[:space:]]+(verify|set|run)([[:space:]]|$)"
# The REST issue COLLECTION path, for issue-dup-check-gate. This matches the
# PATH ONLY -- it says nothing about the HTTP method, and the collection is also
# the READ endpoint (`gh api repos/<o>/<r>/issues` lists issues). An earlier
# comment here claimed a `title=` check the regex never performed, and the gate
# consequently refused plain reads: `gh api repos/go-to-k/cdk-local/issues` and
# `gh api -X GET … -f state=open` both exited 2. Deciding mint-vs-read needs the
# method and the fields, which is logic rather than a regex, so it lives in
# `issue-dup-check-gate.sh`'s `seg_is_api_mint` and this constant is only the
# trigger.
#
# The path must NOT continue past `issues`: that is what separates the
# collection from `/issues/<n>/comments` (a comment) and `/issues/<n>` (an
# edit), neither of which mints anything, and both of which are the CHEAP path
# the gate exists to steer toward. The trailing `\"` alternative catches a fully
# quoted path argument.
GATE_RE_GH_API_ISSUE_CREATE="^gh${GATE_GH_C}[[:space:]]+api([[:space:]]|$).*repos/[^[:space:]/]+/[^[:space:]/]+/issues([[:space:]]|$|\")"

# Strip one layer of surrounding quotes from a path token.
gate_unquote() {
  local p="$1"
  p="${p%\"}"; p="${p#\"}"
  p="${p%\'}"; p="${p#\'}"
  printf '%s' "$p"
}

# gate_tokens <text>
#
# One shell token per line, with a QUOTED span kept WHOLE: `switch "my branch"`
# yields two tokens, not three. Callers unquote with `gate_unquote` when they
# want the bare value.
#
# It exists so a gate that must PARSE an argument list does not have to match
# `GATE_EMBEDDING_TOKEN` itself. Matching it in a hook is the go-to-k/cdkd#2200
# coupling: the hook reads a positional `${BASH_REMATCH[N]}` out of a pattern
# built from a SHARED constant, so widening that constant shifts the index and
# silently re-opens the gate. `unresolved-target-class.test.sh` fence 4 refuses
# that shape by name; the sanctioned answer is to pass the pattern to a helper,
# which is this. `gate_verb_rest` gives the same guarantee for the verb prefix.
#
# No `set -f` dance around the loop, unlike `gate_pr_selector`'s: that function
# feeds its tokens to `set --`, which word-splits and globs. This one only ever
# prints `"${BASH_REMATCH[1]}"`, and `[[ =~ ]]` does not glob, so a stray `*` in
# the text has nothing to expand against.
gate_tokens() {
  local rest="$1"
  while [[ "$rest" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN([[:space:]]+(.*))?$ ]]; do
    printf '%s\n' "${BASH_REMATCH[1]}"
    rest="${BASH_REMATCH[4]}"
    [ -n "$rest" ] || break
  done
  # TRUNCATION IS REPORTED, not swallowed. An UNBALANCED quote cannot be split
  # into words at all: `"[^"]*"` needs its closing quote and the bare-run
  # alternative excludes quote characters, so the pattern stops dead at the
  # opening one. Measured before this line existed: `gate_tokens "a'unbalanced"`
  # printed NOTHING and returned 0, and `gate_tokens "-b agent's-branch"`
  # printed only `-b` -- so a caller parsing an option grammar saw a command
  # with no arguments and allowed it. Silence is the one answer that is wrong
  # here; a caller can now refuse, or fall back to a coarser scan, but it can no
  # longer mistake a truncation for a short command line.
  [ -z "${rest//[[:space:]]/}" ]
}

# gate_word_is_literal <word>
#
# 0 when this shell WORD provably reaches the command as exactly the text it
# already carries; 1 when it does not, OR when this function cannot prove that
# it does. It is the SHELL-side twin of `main-tree-branch-gate.sh`'s "AN
# INCOMPLETE PARSE MAY NOT ALLOW": that gate refuses to relax a verdict on a GIT
# OPTION it cannot resolve, and this refuses to hand it a WORD whose expansion
# it cannot see.
#
# THE DEFAULT IS INVERTED, and that is the whole of this function. `gate_argv`
# below used to ENUMERATE the words the shell owns -- a redirection, a trailing
# `&`, a `#` comment -- and pass everything else through as an argument. Three
# rounds of fixes each added another spelling to that list, and each time the
# next round found the spelling still missing. Measured, in all three repos,
# with a branch that exists locally and the payload cwd set to the main tree:
#
#   git checkout <branch> $EMPTY            rc=0, want 2   HEAD MOVED
#   git checkout <branch> ${EMPTY}          rc=0, want 2   HEAD MOVED
#   git checkout <branch> {fd}>/dev/null    rc=0, want 2   HEAD MOVED
#   git checkout <branch> {fd}<f.txt        rc=0, want 2   HEAD MOVED
#
# An empty expansion VANISHES, so the gate counted a positional git never
# receives; bash's fd-variable redirection is a word git never receives at all.
# Both turned `git checkout <branch> <word>` into a two-positional FILE RESTORE
# and PASSED a command that really moves HEAD.
#
# So the question here is not "is this word one of the shell forms I know?" but
# "is every character in it one I can prove the shell leaves alone?".
#
# HOW A SHAPE NOBODY HAS THOUGHT OF LANDS ON REFUSE. Every shell construct is
# SPELLED, and spelled with characters. `GATE_INERT_CHARS` is a CLOSED list of
# characters that trigger no shell processing at all, so a construct built from
# anything else -- a syntax added to a future bash, one this file's author never
# met, one nobody has written down -- necessarily contains a character outside
# that list, and is refused without anyone having had to think of it. The only
# way a new construct could pass is by being spelled ENTIRELY in inert
# characters, which is a contradiction in terms: an inert character is one the
# shell does not act on. The list, not the construct catalogue, is therefore the
# thing to audit, and every member carries the reason it is inert.
#
# THE INERT SET, one character at a time. `A-Z a-z 0-9` need no argument.
#
#   _ - . / :   no shell meaning in any position. A leading `-` only makes the
#               word look like a flag, which is git's business, not the shell's.
#   @ +         special only as the extglob prefixes `@(...)` / `+(...)`, which
#               need `(`, and `(` is NOT inert.
#   ^           special only inside a `[^...]` bracket expression, which needs
#               `[`, and `[` is NOT inert. (History's `^old^new` is line-initial
#               and interactive-only.) `HEAD^` needs it.
#   %           special only as a JOB SPEC, and only as an argument to `jobs` /
#               `kill` / `fg` / `bg` -- never to `git`.
#   ,           special only inside a brace expansion, which needs `{`, and `{`
#               is NOT inert.
#   =           an assignment only in the COMMAND-word position, and every word
#               asked about here is an argument, past the verb. It must be here:
#               `--create=feat` is an ordinary long option.
#   #           a comment only as the FIRST character of a word, which is
#               rejected explicitly below. `has#hash` is a legal branch name and
#               the shell passes it through untouched.
#
# WHAT IS DELIBERATELY OUT, so the cost is visible rather than guessed. `$` and
# a backtick (an expansion this cannot see). `\` (an escape). `*` `?` `[` `]`
# (pathname expansion -- and under `nullglob` a non-matching pattern expands to
# NO words, the vanishing case again). `{` `}` (brace expansion, and the
# fd-variable redirection prefix `{fd}>`). `~` (tilde expansion). `!` (history
# expansion: off in a non-interactive shell, but this cannot see which shell it
# is). Every shell METACHARACTER -- `| & ; ( ) < >` and whitespace -- which the
# segmenter and tokenizer normally consume, so one arriving here is by
# definition unaccounted for. Two exclusions are strictly OVER-strict: `a~b` and
# `feat!` are literal to bash and this refuses them anyway. Over-strict means
# BLOCK, which is the direction this gate exists to fail in.
#
# QUOTING IS TRACKED, because it is what makes the punctuation above reachable.
# A word may EMBED quoted spans rather than BE one (see GATE_EMBEDDING_TOKEN),
# so the walk carries a quote state:
#   - inside a SINGLE-quoted span every character is literal, so nothing is
#     refused there;
#   - inside a DOUBLE-quoted span only `$`, a backtick and `\` stay active, so
#     only those three are refused;
#   - outside quotes the inert list decides.
# That is what keeps `git checkout -b 'feat$x'` an ordinary branch creation --
# a literal `$` in a branch name still behaves -- while an unquoted `$EMPTY` is
# refused.
#
# A word whose quote is still open at the end is refused too: it cannot be split
# into shell words at all, which is the same thing `gate_tokens` reports.
#
# WHAT THIS DOES NOT DECIDE: whether the word is an ARGUMENT. A redirection is
# spelled with `>` and would be refused here, yet it is perfectly accounted for
# -- `gate_argv` recognises it and drops it BEFORE asking this. Recognising a
# shell construct positively and proving a word literal are two different jobs,
# and only the second one has to fail closed.
GATE_INERT_CHARS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./:@+%,^=#'
# The same set as a GLOB CLASS, so a whole SPAN is decided in one operation
# rather than one character at a time. That is not a micro-optimisation: a hook
# runs on EVERY Bash tool call, and a per-character walk here is quadratic,
# because `${s:i:1}` in a UTF-8 locale walks to offset `i` every time. Measured
# on this machine (bash 5.3.9, en_US.UTF-8), an index-only loop over a string:
# 1 000 chars 0.010 s, 4 000 chars 0.043 s, 16 000 chars 0.478 s -- 16x the
# input for 48x the time. The chunked form below is 0.032 s at 16 000.
#
# `-` is LAST and `^` is not first, which is what keeps both LITERAL inside a
# bracket expression; `!` negates.
GATE_NOT_INERT_GLOB='*[!A-Za-z0-9_./:@+%,^=#-]*'
# Active inside a DOUBLE-quoted span: an expansion, a command substitution, an
# escape. Written with `$'...'` so the backslash and the backtick survive.
GATE_DQ_ACTIVE_GLOB=$'*[\\\\$\140]*'
GATE_QUOTE_CLASS=$'["\047]'
GATE_SQ=$'\047'
# The characters that end a scanning chunk. `$'[\\\\"\047#]'` yields `[\\"'#]`,
# and that doubling is load-bearing: `[\"'#]` does NOT contain a backslash --
# there the backslash escapes the quote and the class silently loses it.
# Verified in BOTH bash 3.2.57 and 5.3.9 against `ab\cd`, `ab"cd`, `ab'cd`,
# `abc#d` and `abcd`.
GATE_CHUNK_STOP=$'[\\\\"\047#]'
GATE_CHUNK_STOP_DQ=$'[\\\\"]'

gate_word_is_literal() {
  local w="$1" rest="$1" chunk q=""
  [ -n "$w" ] || return 1
  # A word STARTING with `#` opens a comment: the shell discards it and every
  # word after it, so it reaches the command as nothing at all.
  case "$w" in '#'*) return 1 ;; esac
  # The walk advances by SPANS, not characters: everything up to the next quote
  # character is tested with one glob, so the number of iterations is the number
  # of quote characters in the word rather than its length.
  while [ -n "$rest" ]; do
    if [ -z "$q" ]; then
      chunk="${rest%%$GATE_QUOTE_CLASS*}"
      case "$chunk" in $GATE_NOT_INERT_GLOB) return 1 ;; esac
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      q="${rest%"${rest#?}"}"
      rest="${rest#?}"
    elif [ "$q" = "$GATE_SQ" ]; then
      # Inside a SINGLE-quoted span every character is literal, so there is
      # nothing to test -- only the closer to find.
      chunk="${rest%%$GATE_SQ*}"
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      rest="${rest#?}"
      q=""
    else
      chunk="${rest%%\"*}"
      case "$chunk" in $GATE_DQ_ACTIVE_GLOB) return 1 ;; esac
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      rest="${rest#?}"
      q=""
    fi
  done
  # A quote still open means the word cannot be split into shell words at all.
  [ -z "$q" ]
}

# gate_strip_comment <text>
#
# <text> truncated at the first `#` that opens a shell COMMENT -- one at a WORD
# START (the beginning of the text, or after a space or tab) and outside any
# quoted span. Prints the text unchanged when there is none.
#
# WHY IT RUNS BEFORE THE SPLIT, which is the bug it fixes. `gate_argv` used to
# ask `gate_tokens` to split the WHOLE text and refuse on an unbalanced quote,
# then drop the comment inside the walk. An apostrophe INSIDE the comment is
# therefore weighed as a quote, so
#
#   git checkout main # don't switch lanes
#
# came back as a truncation and the gate blocked it -- measured rc=2 against a
# command that leaves HEAD exactly where it was ("Already on 'main'"). The
# comment justifying that order claimed "the text is a shell syntax error in the
# first place, so nothing legitimate is lost". That claim is FALSE and is not
# repeated: `bash -n "git checkout main # don't switch lanes"` reports VALID
# syntax, because the apostrophe is inside a comment and bash never sees it as a
# quote either. Cutting the comment first makes this file agree with the shell.
#
# The unbalanced-quote refusal it is often confused with survives untouched:
# `-b agent's-branch` has no comment to cut, so the text reaches `gate_tokens`
# whole and is still refused.
#
# THE SECOND PASS is `gate_segments_raw`'s `ignore_q` trick, for the same reason
# and with the same shape. If the first walk reaches the end with a quote still
# open, that character may not have been a quote at all, so the walk is redone
# with it literal and a comment is looked for again. `'unbalanced # x` then cuts
# to `'unbalanced `, which `gate_tokens` still refuses -- correctly: bash calls
# that one "unexpected EOF while looking for matching `''".
GATE_COMMENT_CUT=""
GATE_COMMENT_OPENQ=""
_gate_comment_cut() {
  local s="$1" iq="$2" rest="$1" pos=0 chunk c q="" prev=" "
  GATE_COMMENT_CUT="$s"
  GATE_COMMENT_OPENQ=""
  # A text with NO `#` anywhere can carry no comment, and that is the shape
  # essentially every command has. Returning here keeps the walk below off the
  # hot path entirely -- measured, 16 000 characters go from 0.92 s to 0.002 s.
  case "$s" in *'#'*) ;; *) return 0 ;; esac
  # SPANS, not characters, for the reason recorded on GATE_NOT_INERT_GLOB above:
  # a per-character walk is quadratic here. Each iteration jumps to the next
  # quote / backslash / `#`, so the iteration count is the number of those
  # characters rather than the length of the text. Only the CUT OFFSET is
  # tracked; the text is sliced once, at the end.
  while [ -n "$rest" ]; do
    if [ -z "$q" ]; then
      chunk="${rest%%$GATE_CHUNK_STOP*}"
    elif [ "$q" = "$GATE_SQ" ]; then
      chunk="${rest%%$GATE_SQ*}"
    else
      chunk="${rest%%$GATE_CHUNK_STOP_DQ*}"
    fi
    [ "$chunk" = "$rest" ] && break
    if [ -n "$chunk" ]; then
      prev="${chunk#"${chunk%?}"}"
      pos=$((pos + ${#chunk}))
      rest="${rest#"$chunk"}"
    fi
    c="${rest%"${rest#?}"}"
    if [ -z "$q" ]; then
      case "$c" in
        # An escaped character outside quotes is LITERAL, `\#` included. The
        # slice is `${rest:2}` rather than `${rest#??}`: with ONE character left
        # the `##` form matches nothing, leaves `rest` unchanged, and the loop
        # never terminates.
        '\') pos=$((pos + 2)); rest="${rest:2}"; prev=x; continue ;;
        '#') case "$prev" in
               ' '|'	') GATE_COMMENT_CUT="${s:0:pos}"; return 0 ;;
             esac ;;
        '"') [ "$c" = "$iq" ] || q="$c" ;;
        *) [ "$c" = "$GATE_SQ" ] && { [ "$c" = "$iq" ] || q="$c"; } ;;
      esac
    else
      if [ "$c" = '\' ] && [ "$q" = '"' ]; then
        pos=$((pos + 2)); rest="${rest:2}"; prev=x; continue
      fi
      [ "$c" = "$q" ] && q=""
    fi
    prev="$c"
    pos=$((pos + 1))
    rest="${rest#?}"
  done
  GATE_COMMENT_CUT="$s"
  GATE_COMMENT_OPENQ="$q"
  [ -z "$q" ]
}

gate_strip_comment() {
  if _gate_comment_cut "$1" ""; then
    printf '%s' "$GATE_COMMENT_CUT"
    return 0
  fi
  _gate_comment_cut "$1" "$GATE_COMMENT_OPENQ"
  printf '%s' "$GATE_COMMENT_CUT"
  return 0
}

# gate_argv <text>
#
# The ARGV a shell would hand the command, one token per line: the SHELL's own
# words are dropped -- a comment and everything after it, a redirection and,
# when it is not glued, its target. Returns 1 having printed nothing when the
# text cannot be split into words at all (the `gate_tokens` truncation), so a
# caller can refuse rather than parse a fragment.
#
# WHY THIS IS A SEPARATE FUNCTION FROM `gate_tokens`, and why an option parse
# must call THIS one. A gate that reads an option grammar is reading ARGV -- the
# vector the command itself receives -- and a shell WORD is not an ARGUMENT.
# `2>/dev/null`, `>`, `/dev/null` and `# switch lane` are all words, and git
# never sees any of them. Measured against the gate that first parsed
# `gate_tokens` output directly, with a branch that existed locally:
#
#   git checkout <branch> 2>/dev/null      rc=0, want 2
#   git checkout <branch> >/dev/null 2>&1  rc=0, want 2
#   git checkout <branch> # switch lane    rc=0, want 2
#
# -- every one a command that really moves HEAD, waved through because the extra
# WORDS were counted as extra ARGUMENTS and the command therefore read as a file
# restore. Callers that genuinely want the shell's words (a `-C` scan, a heredoc
# probe) keep `gate_tokens`; callers that want git's argv use this.
#
# WHAT IT DOES NOT PROMISE, stated because an earlier revision's silence here is
# the defect round 4 fixed: a line printed by this function is a shell WORD that
# is not a redirection and not a comment. It is NOT a promise that the word
# reaches the command as the text printed. `$EMPTY` is printed and reaches the
# command as NOTHING; `{fd}>/dev/null` is printed and reaches it as nothing
# either. A caller that COUNTS these words, or compares one against a name, must
# put every word through `gate_word_is_literal` and refuse to relax its verdict
# on a word that fails -- which is exactly what `main-tree-branch-gate.sh` does
# with `parse_certain`. Enumerating more shell forms HERE is the losing move; it
# was tried three times.
#
# The comment strip is deliberately NOT in `gate_segments`: that splitter feeds
# every gate in this library, and widening it is a change to all of them. Here
# the effect is bounded to callers that asked for argv.
GATE_REDIR_TOKEN='^([0-9]*(>>|>[|]|>&|>|<<<|<<-|<<|<&|<)|&>>|&>)(.*)$'

gate_argv() {
  local words tok want_target=0 text
  # The comment goes FIRST, before the split, so an apostrophe inside one is
  # never weighed as a quote (see `gate_strip_comment`). That also makes the
  # in-loop `'#'*` arm this function used to carry unreachable, so it is gone
  # rather than left as a second spelling of the same rule.
  text=$(gate_strip_comment "$1")
  words=$(gate_tokens "$text") || return 1
  while IFS= read -r tok; do
    # `gate_tokens` never emits an empty token (its pattern needs one character
    # at least), so the single blank line a `printf` of empty output produces is
    # the only thing this skips.
    [ -n "$tok" ] || continue
    if [ "$want_target" -eq 1 ]; then
      # The spaced target of the redirection operator just seen (`> /dev/null`).
      # It is dropped WITHOUT asking `gate_word_is_literal`, deliberately: a
      # redirection target is never an argument whatever it expands to. An empty
      # expansion there makes bash refuse the command outright ("ambiguous
      # redirect"), and a multi-word one is the same error -- neither can put a
      # word into argv.
      want_target=0
      continue
    fi
    # A bare `&`. On the GATE's path this is dead -- `gate_segments_raw` has
    # already split on it -- and it is kept because a DIRECT caller (this
    # library's own suite, a future gate parsing a raw fragment) still meets it.
    # Labelled rather than removed so the next reader does not re-derive that.
    [ "$tok" = '&' ] && continue
    if [[ "$tok" =~ $GATE_REDIR_TOKEN ]]; then
      # `2>&1` and `>/dev/null` carry their target GLUED; a bare `>` or `2>`
      # takes the next word as its target.
      [ -n "${BASH_REMATCH[3]}" ] || want_target=1
      continue
    fi
    printf '%s\n' "$tok"
  done <<EOF
$words
EOF
  return 0
}



# gate_verb_args <cmd> <verb-ere>
#
# Print, one line per matching segment, the text that FOLLOWS the matched verb
# in that segment -- flags included, because the verb ERE has already consumed
# the leading flag run. Nothing is printed for a command with no matching
# segment.
#
# This is `gate_pr_selector`'s first two lines, factored out: that function
# exists because four gates each rolled their own "strip the verb, then read the
# arguments" and all four broke the moment GATE_GH_C widened. The strip must
# come from the SAME constant that armed the gate -- `BASH_REMATCH[0]` of the
# verb ERE -- so a gate cannot match one way and parse another. A caller that
# wants something other than a PR number (control-char-gate wants `git add`'s
# pathspecs) gets the same guarantee here instead of writing the strip again.
gate_verb_args() {
  local cmd="$1" re="$2" segment
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    printf '%s\n' "${segment#"${BASH_REMATCH[0]}"}"
  done < <(gate_segments "$cmd")
}

# gate_verb_args_dir <cmd> <fallback-dir> <verb-ere>
#
# `gate_verb_args` plus the working tree EACH matching segment runs in: one
# "<dir><TAB><args-after-the-verb>" line per matching segment.
#
# WHY the tree has to come out of the SAME walk. `gate_target_dir` answers for
# the WHOLE COMMAND -- its walk breaks at the first matching segment -- so a
# gate that judges every segment judges them all against segment 1's tree.
# Measured against this repo's real main checkout and its real linked worktree,
# driving main-tree-branch-gate with a payload cwd of the MAIN tree:
#
#   git -C <worktree> switch -c a && git switch -c b     rc=0, want 2  BYPASS
#   git -C <worktree> checkout -b a && git checkout -b b rc=0, want 2  BYPASS
#   git switch main && git -C <worktree> switch -c a     rc=2, want 0  FALSE BLOCK
#
# The bypass is the `git fetch && git switch -c` one this branch already closed,
# one operator further along: segment 1 resolves to a linked worktree, the gate
# stands down for the whole command, and segment 2 -- running in the SHARED main
# tree -- is never judged. The false block refuses a branch creation IN a linked
# worktree, which is exactly what the worktree convention mandates. Both
# directions were live at the head that shipped `main_tree_of`'s "called per
# matched segment" comment; the comment described an intent the code did not
# have.
#
# Callers split the line with `${line%%<TAB>*}` / `${line#*<TAB>}`, NOT with
# `IFS=$'\t' read -r dir args`: tab is IFS whitespace, so that spelling folds a
# TAB RUN inside the args and silently drops one.
#
# The `cd` / `-C` reading is a deliberate copy of gate_target_dir's rather than
# a shared helper, because that function BREAKS at the verb -- the one thing
# this walk must not do -- and it has other callers riding on that. The helper
# harness pins the two against each other on the single-segment shape so the
# copy cannot drift silently.
gate_verb_args_dir() {
  local cmd="$1" fallback="$2" re="$3"
  local target="$fallback" segment cd_target c_target remaining verb_run tok seg_target
  while IFS= read -r segment; do
    if [[ "$segment" =~ ^cd[[:space:]]+$GATE_PATH_TOKEN ]]; then
      cd_target=$(gate_unquote "${BASH_REMATCH[1]}")
      # An UNEXPANDED path is not a path; skipping it falls back to the payload
      # cwd, which fails CLOSED for this gate (go-to-k/cdkd#2130 review).
      case "$cd_target" in *'$'*|*'`'*) continue ;; esac
      [ -z "$cd_target" ] && continue
      [[ "$cd_target" != /* ]] && cd_target="$target/$cd_target"
      target="$cd_target"
      continue
    fi
    [[ "$segment" =~ $re ]] || continue
    # Saved BEFORE the token walk below: every `[[ =~ ]]` in it overwrites
    # BASH_REMATCH.
    verb_run="${BASH_REMATCH[0]}"
    # A `cd` persists into the next segment; a `-C` binds only its own command.
    # So the segment's dir starts from the running cd state and is overridden
    # locally, never written back.
    seg_target="$target"
    c_target=""
    remaining="$verb_run"
    while [[ "$remaining" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; do
      tok="${BASH_REMATCH[1]}"
      remaining="${BASH_REMATCH[3]}"
      [ -n "$tok" ] || break
      case "$tok" in
        -C=*) c_target="${tok#-C=}" ;;
        -C)
          if [[ "$remaining" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; then
            c_target="${BASH_REMATCH[1]}"
            remaining="${BASH_REMATCH[3]}"
          fi
          ;;
        -C*) c_target="${tok#-C}" ;;
        *) ;;
      esac
    done
    if [ -n "$c_target" ]; then
      c_target=$(gate_unquote "$c_target")
      case "$c_target" in *'$'*|*'`'*) c_target="" ;; esac
      if [ -n "$c_target" ]; then
        [[ "$c_target" != /* ]] && c_target="$seg_target/$c_target"
        seg_target="$c_target"
      fi
    fi
    printf '%s\t%s\n' "$seg_target" "${segment#"$verb_run"}"
  done < <(gate_segments "$cmd")
  return 0
}

# gate_pr_selector <command> <verb-ere>
#
# Print the PR number the guarded command targets, or NOTHING when it carries no
# positional (gh's "the PR for the current branch" semantics). The caller
# decides what "nothing" means; this function never guesses one.
#
# WHY THIS IS SHARED, and why a local prefix strip is not good enough.
# Four gates each rolled their own extraction, and all four broke the moment
# GATE_GH_C learned to absorb `-R <owner/repo>`. Widening the absorber makes the
# flagged command REACH the gate; it does nothing about the gate then parsing it.
# Measured 2026-08-25 against `gh -R go-to-k/cdk-local pr merge 552 --squash`:
#
#   closes-paren-form-gate   `args="${cmd##*gh pr merge}"` does not strip, the
#                            number regex finds nothing, exit 0 -- gh never
#                            called. The plain form exits 2. Fully bypassed.
#   non-english-text-gate    a hard-coded `-C`-only PR-number regex misses, so it
#   docs-inline-json-flag    falls back to `gh pr view --json number`, the
#                            CURRENT BRANCH's PR: `pr diff 999` instead of 552.
#                            The verdict is about someone else's diff.
#   pr-review-gate           same failed strip, then its arg loop scans the WHOLE
#                            command for the first bare integer, so
#                            `sleep 30 && gh -R o/r pr merge 552` resolves to 30.
#                            The wrong PR's size decides the review tier.
#
# So the extraction is derived from the SAME constant that decides the trigger:
# the verb ERE is anchored at the segment start and already absorbs every flag
# spelling, so `BASH_REMATCH[0]` is exactly the part to remove, whatever flags it
# swallowed. A gate can no longer match one way and parse another.
gate_pr_selector() {
  local cmd="$1" re="$2" segment args tok
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    # Everything after the matched verb -- flags included, because the verb ERE
    # consumed them. Scanning starts here rather than at the segment start, which
    # is what stops a leading `sleep 30 &&` from being read as the PR number.
    args="${segment#"${BASH_REMATCH[0]}"}"
    # Walk with GATE_EMBEDDING_TOKEN, not `set -- $args`. Word-splitting breaks a
    # QUOTED flag value at its first space, so `gh pr merge --subject "chore: x"
    # 2195` split into `"chore:` and `x"`, the flag consumed only the first half,
    # and the second half -- a non-numeric positional -- ended the walk empty.
    # Embedding tokens keep the value whole. It also removes the globbing hazard
    # entirely (an unquoted `$args` let a literal `*` expand against the CWD:
    # measured with files `77` and `aaa` present, `gh pr merge --some-flag * 552`
    # resolved to 77) -- nothing is ever expanded now, so no `set -f` is needed.
    while [[ "$args" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; do
      tok="${BASH_REMATCH[1]}"
      args="${BASH_REMATCH[3]}"
      [ -n "$tok" ] || break
      case "$tok" in
        --*=*) continue ;;
        # Enumerate the VALUELESS flags; treat every other `-...` as consuming
        # the next token.
        #
        # THE DIRECTION OF STALENESS IS THE WHOLE ARGUMENT, and it is asymmetric.
        # This file briefly had the opposite polarity -- value-takers enumerated
        # -- and that is strictly worse:
        #
        #   enumerate value-takers -> an unlisted VALUE-TAKING flag leaves its
        #     value in the walk -> a plausible integer becomes the selector ->
        #     the gate judges a DIFFERENT PR. Measured: `gh pr merge -t 42 552`
        #     resolved to 42.
        #   enumerate valueless    -> an unlisted VALUELESS flag eats the number
        #     -> the selector is EMPTY -> the caller falls back to gh's
        #     current-branch semantics, or declines.
        #
        # Wrong-PR is severe; no-PR is not. Note this also covers the flags the
        # verb ERE does NOT absorb: it only swallows what precedes the verb, so
        # `gh pr merge -R <slug> 552` puts `-R` into THIS walk.
        #
        # The short spellings are gh pr merge's own valueless flags (`-d`
        # delete-branch, `-s` squash, `-m` merge, `-r` rebase); they are listed
        # because omitting them costs the number for the commonest hand-typed
        # form. `--match-head-commit`, `--body`, `-b`, `--body-file`, `-F`, `-t`,
        # `--subject`, `-R`, `--repo` are all deliberately ABSENT: they take
        # values, and being unlisted is now the SAFE side.
        --squash|--merge|--rebase|--auto|--disable-auto|--admin|--delete-branch|-d|-s|-m|-r)
          continue ;;
        -*)
          # consume this flag's value
          if [[ "$args" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; then
            args="${BASH_REMATCH[3]}"
          fi
          continue ;;
        *)
          # THE FINAL NUMERIC GUARD. Every caller wants a PR NUMBER, so a
          # non-numeric positional -- a branch name, a URL, or a repo slug that
          # an unlisted flag left behind -- must yield EMPTY rather than be
          # handed on. Stop rather than walk on: continuing would find a digit
          # further along that belongs to something else entirely.
          if [[ "$tok" =~ ^[0-9]+$ ]]; then printf '%s' "$tok"; fi
          return 0 ;;
      esac
    done
    return 0
  done < <(gate_segments "$cmd")
  return 0
}

# gate_cmd_repo <command> <verb-ere>
#
# Print the `-R <owner/repo>` / `--repo <owner/repo>` the guarded command names,
# or nothing when it names none. All three of gh's separators are handled, and
# tokens embed quoted spans (see GATE_EMBEDDING_TOKEN), so a repo slug inside a
# quoted flag value is not mistaken for the flag.
#
# WHY: a gate resolves the PR NUMBER and then asks `gh pr view <N>` from the
# resolved directory, WITHOUT the repo flag -- so `gh -R go-to-k/OTHER pr merge
# 552` made every gate judge the LOCAL repo's PR 552. Right number, wrong repo,
# and no assertion anywhere could see it because the exit code and the number
# are both indistinguishable from the correct case. The gates pass this through
# to their own gh calls so the question they ask matches the command they guard.
gate_cmd_repo() {
  local cmd="$1" re="$2" segment remaining tok found=""
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    # The WHOLE segment, not just the verb run: gh accepts the repo flag on
    # either side of the verb, and `gh pr merge -R <slug> 552` writes it after.
    # A segment is one command, so any repo flag in it belongs to this
    # invocation.
    remaining="$segment"
    while [[ "$remaining" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; do
      tok="${BASH_REMATCH[1]}"
      remaining="${BASH_REMATCH[3]}"
      [ -n "$tok" ] || break
      case "$tok" in
        --repo=*) found="${tok#--repo=}" ;;
        -R=*)     found="${tok#-R=}" ;;
        -R|--repo)
          if [[ "$remaining" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; then
            found="${BASH_REMATCH[1]}"; remaining="${BASH_REMATCH[3]}"
          fi ;;
        -R*) found="${tok#-R}" ;;
        *) ;;
      esac
    done
    break
  done < <(gate_segments "$cmd")
  found=$(gate_unquote "$found")
  # An unexpanded value is not a repo; better to ask about the local one than
  # about a literal `$VAR`.
  case "$found" in *'$'*|*'`'*) found="" ;; esac
  # Must look like owner/repo, or it is some other flag's value.
  [[ "$found" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || found=""
  printf '%s' "$found"
}

# gate_target_dir <cmd> <fallback> <extended-regex>
# The working tree the gated command will actually run in:
#   1. a `-C <path>` inside the MATCHED segment wins (git -C / gh -C), else
#   2. the last `cd <path>` segment BEFORE the matched one, else
#   3. the fallback (the hook payload's cwd).
# Quoted paths survive: segments carry their original text (see the header).
gate_target_dir() {
  local cmd="$1" fallback="$2" re="$3"
  local target="$fallback" segment cd_target c_target remaining verb_run tok
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
    # A `-C <path>` in the MATCHED VERB'S OWN FLAG RUN wins over any earlier cd.
    #
    # Scanned out of `BASH_REMATCH[0]` -- the text the verb ERE just consumed,
    # i.e. `gh <every leading flag> pr merge` -- rather than by anchoring on
    # `(git|gh)[[:space:]]+-C`. That anchor required `-C` to sit IMMEDIATELY
    # after the command word, so FLAG ORDER silently decided the verdict:
    #
    #   gh -C /w/t -R o/r pr merge 1   -> /w/t        (resolved)
    #   gh -R o/r -C /w/t pr merge 1   -> payload cwd (NOT resolved)
    #
    # and the second is a live bypass, not a cosmetic asymmetry. Driven through
    # verify-pr-gate with the `-C` target's marker STALE and the payload cwd's
    # marker FRESH, the `-R`-first spellings returned rc=0 -- the merge was
    # judged against a DIFFERENT worktree's marker and allowed. This is the same
    # class as the two bypasses already closed on this branch: GATE_GH_C admits
    # the flagged command to the verb, and a downstream reader still assumes the
    # old adjacent-flag layout. Sourcing the scan from the ERE's own match is
    # what makes the two agree by construction instead of by maintenance.
    #
    # `(^|[[:space:]])` rather than a command word, so `-C` is found wherever it
    # sits in the run; the separator is optional and may be `=`, matching
    # GATE_GH_C's token (`-C /w/t`, `-C=/w/t`, `-C/w/t`, quoted paths). NOTE the
    # path is BASH_REMATCH[3]: both the leading boundary and the optional
    # separator are groups. Lowercase `git -c k=v` does not match -- `[[ =~ ]]`
    # is case-sensitive unless nocasematch is set, which nothing here sets.
    verb_run="${BASH_REMATCH[0]}"
    # Walk the flag run TOKEN BY TOKEN, with tokens that embed quoted spans, so
    # a `-C` inside a quoted flag VALUE is part of that value and never a flag
    # of its own (see GATE_EMBEDDING_TOKEN). A regex scan over the whole run
    # cannot make that distinction: it has no notion of where a word begins.
    c_target=""
    remaining="$verb_run"
    while [[ "$remaining" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; do
      tok="${BASH_REMATCH[1]}"
      remaining="${BASH_REMATCH[3]}"
      [ -n "$tok" ] || break
      case "$tok" in
        -C=*) c_target="${tok#-C=}" ;;
        -C)
          # value is the NEXT token
          if [[ "$remaining" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; then
            c_target="${BASH_REMATCH[1]}"
            remaining="${BASH_REMATCH[3]}"
          fi
          ;;
        -C*) c_target="${tok#-C}" ;;
        *) ;;
      esac
    done
    if [ -n "$c_target" ]; then
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

# ---------------------------------------------------------------------------
# PORTED FROM cdkd (go-to-k/cdkd#2639). Kept TEXTUALLY IDENTICAL to that
# copy apart from path references, so a `diff` across the three repos is the
# review: the defects this closes were found by porting, and the vocabulary
# DIVERGING between repos is itself one of them.
# ---------------------------------------------------------------------------
# ── A shell WORD, for the gates that extract with PERL ─────────────────────
#
# `GATE_PATH_TOKEN` and `_GATE_WORD_CHAR` are bash EREs, usable only from
# `[[ =~ ]]`. FIVE gates -- issue-deferral-criteria, gh-body-english,
# issue-dup-check, issue-classification-label and pr-body-item-number -- pull a
# `--body-file` path or an inline `--body` value out of RAW command text with
# `perl -0777` instead, because they need a GLOBAL scan over a multi-line slurp
# and `[[ =~ ]]` gives neither. Derive the list rather than trusting this
# sentence -- `grep -l GATE_PERL_WORD .claude/hooks/*-gate.sh` -- because an earlier
# revision of THIS comment said "three" while five files consumed it, which is
# the same stale-sibling-note class the constant exists to end.
# All of them spelled the value class `(["']?)([^"'\s]+)\1`, and that shape had
# THREE MEASURED holes, all fail-OPEN (go-to-k/cdkd, 2026-09-05):
#
#   gh issue create --body-file "<dir with space>/x.md"
#     The bare class cannot span the space, and with the optional quote group
#     unset it cannot start on the quote either, so NOTHING is extracted and
#     the gate judges an empty body. Measured: issue-deferral-criteria-gate
#     rc=0 on a PR-shaped deferral where the unquoted spelling gave 2, and
#     gh-body-english-gate rc=0 on a JAPANESE body where the unquoted spelling
#     gave 2 -- the English-only rule was bypassable by putting the body file
#     in a directory whose name contains a space.
#
#   gh api repos/O/R/issues -f body='<text>'
#     gh's OWN documented spelling puts the quote INSIDE the value, after the
#     `body=`. An alternation tried AFTER the literal `body=` falls through to
#     `\S+` and captures `body='a`. Measured on issue-deferral-criteria-gate:
#     rc=0, where `-f 'body=<text>'` (quote OUTSIDE, the only shape its suite
#     covered) gave 2.
#
# So the value class is defined ONCE, here, rather than a fourth time in the
# next hook that needs it. `GATE_PERL_WORD` is a perl PRELUDE, not a regex: a
# caller prefixes it to its own program --
#
#   perl -0777 -ne "$GATE_PERL_WORD"'
#     while (/--body-file[=\s]+($GW)/g) { print gate_unq($1), "\n"; }'
#
# -- and it defines two names:
#
#   $GW        ONE shell word that may EMBED quoted spans: the perl twin of
#              `_GATE_WORD_CHAR`. `body='a b c'` is one word, `"/a b/x.md"` is
#              one word, and a bare run still stops at whitespace.
#   gate_unq   the shell's own unquoting of such a word, so a caller gets the
#              string gh actually receives: spans unwrapped, and `\X` unescaped
#              exactly where the shell would unescape it (inside a
#              double-quoted span only for `\ " $` and a backtick; never inside
#              a single-quoted one, which takes no escapes).
#
# UNBALANCED quotes are not a regression risk here: `$GW`'s bare alternative
# excludes both quote characters, so a word like `/tmp/o'neill/x.md` stops at
# the apostrophe -- which is exactly where the old class stopped too.
#
# A hook using this MUST also assert `GATE_PERL_WORD` is non-empty in its
# library-load guard. Left undefined, `$GW` interpolates as the EMPTY string,
# `($GW)` then matches empty at every position, and the extraction yields empty
# values that every caller skips -- a silent fail-open, which is the exact
# class this constant closes.
#
# The apostrophes below are spelled `\x27` -- a PERL escape, valid in a regex
# and in a substitution alike -- because this is a bash SINGLE-QUOTED string
# and a literal apostrophe would end it. The `'"'"'` idiom used elsewhere in
# this file would work too, and is unreadable at this density.
GATE_PERL_WORD='
  # ANSI-C quoting is the FIRST alternative on purpose. `$` is an ordinary
  # character to the bare class below, so without this arm `$\x27...\x27` was
  # split into a bare `$` plus a plain single-quoted span -- which took the body
  # LITERALLY, so `--body $\x27日本語\x27` reached the English-only
  # gate as the ASCII text `$日本語` and passed, while bash sent
  # Japanese. Its inner `\\.` also differs from the plain single-quote arm:
  # inside `$\x27...\x27` a backslash ESCAPES, so `\\\x27` does not close it.
  my $GW = qr/(?:\$\x27(?:[^\x27\\]|\\.)*\x27|"(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\\.|[^\s"\x27;|&()<>\x60])+/;
  # ANSI-C escape decoding, used only by the `$\x27...\x27` arm of gate_unq.
  #
  # EVERYTHING IS NORMALISED TO BYTES AND DECODED ONCE AT THE END, and each half
  # of that is load-bearing:
  #
  #   bash itself is mixed -- `\xHH` and `\NNN` emit raw BYTES while `\uXXXX`
  #   emits a CHARACTER -- so the only representation both agree on is the byte
  #   string bash would actually pass. Hence `\u` is encoded rather than left
  #   wide.
  #
  #   The LITERAL run has to be encoded too, and missing that was a live
  #   BYPASS. The callers run under mixed `-C` settings: the path extraction has
  #   none, the non-English body scan uses `-CSD`, where the input string is
  #   ALREADY decoded. So a literal non-ASCII character sitting next to an
  #   escape produced a string that was half characters and half bytes, the
  #   closing `utf8::decode` refused it as invalid UTF-8, and the whole value
  #   stayed Latin-1 -- which `NON_ENGLISH_RE` (CJK / Hangul) never matches.
  #   Measured against the real hook:
  #
  #     --body $\x27\u65e5\u672c\u8a9e\x27         rc=2   blocked
  #     --body $\x27<one accent>\u65e5\u672c\u8a9e\x27  rc=0   BYPASS
  #     --body $\x27<one accent>\xe6\x97\xa5\x27        rc=0   BYPASS
  #
  #   Both bypasses publish Japanese, and the carrier is an ordinary Latin-1
  #   accent that is not itself blocked, so nothing looks wrong.
  #
  #   `utf8::is_utf8` guards the encode: encoding unconditionally is correct for
  #   the `-CSD` caller and DOUBLE-encodes for the byte-mode ones, which is the
  #   same defect facing the other way.
  #
  # A value that is not valid UTF-8 once assembled is left exactly as built --
  # utf8::decode returns false without modifying it, which is the right answer
  # for a genuinely binary `\xNN` payload.
  sub gate_ansi_c {
    my ($v) = @_;
    my %simple = ("a"=>"\a","b"=>"\b","e"=>"\e","E"=>"\e","f"=>"\f",
                  "n"=>"\n","r"=>"\r","t"=>"\t","v"=>"\013",
                  "\\"=>"\\","\x27"=>"\x27","\""=>"\"","?"=>"?");
    my $o = "";
    my $add = sub {                 # append as BYTES, whatever we were handed
      my ($t) = @_;
      utf8::encode($t) if utf8::is_utf8($t);
      $o .= $t;
    };
    while (length $v) {
      # `& 255`: bash truncates an octal escape to a byte, so `\400` is NUL and
      # not U+0100.
      if    ($v =~ s/^\\x([0-9A-Fa-f]{1,2})//)    { $o .= chr(hex($1) & 255); }
      elsif ($v =~ s/^\\([0-7]{1,3})//)           { $o .= chr(oct($1) & 255); }
      elsif ($v =~ s/^\\u([0-9A-Fa-f]{1,4})//)    { $add->(pack("U", hex($1))); }
      elsif ($v =~ s/^\\U([0-9A-Fa-f]{1,8})//)    { $add->(pack("U", hex($1))); }
      elsif ($v =~ s/^\\c(.)//)                   { $o .= chr(ord(uc $1) & 255 ^ 64); }
      elsif ($v =~ s/^\\(.)//s)                   { $add->(exists $simple{$1} ? $simple{$1} : "\\" . $1); }
      elsif ($v =~ s/^([^\\]+)//s)                { $add->($1); }
      else                                         { $v =~ s/^(.)//s; $add->($1); }
    }
    # DECODE PER BYTE, not all-or-nothing and not per malformed RUN. Two
    # spellings were measured and both lose data:
    #
    #   utf8::decode          refuses the WHOLE string on one malformed byte
    #                         and leaves it Latin-1, so a single stray byte
    #                         turned CJK detection off for everything:
    #                         `--body $\x27\xff\xe6\x97\xa5\x27` gave rc=0.
    #   Encode::decode        swallows the bytes FOLLOWING a bad lead byte as
    #                         part of the malformed run -- the same input came
    #                         back as one U+FFFD, the Japanese character gone.
    #
    # `gate_utf8_lenient` decodes maximal VALID sequences and emits exactly one
    # U+FFFD per un-decodable BYTE, so a valid character next to a stray byte
    # survives and is still judged. That is what has to reach the class test:
    # gh sends the bytes, and whatever the receiver renders, the Japanese
    # character in them is published.
    return gate_utf8_lenient($o);
  }

  # Byte string -> character string, lenient. The alternation is the standard
  # UTF-8 well-formedness table (RFC 3629): no overlongs, no surrogates, no
  # code point above U+10FFFF -- an over-permissive matcher here would decode a
  # surrogate-encoded sequence into a character the class test then treats as
  # ordinary text.
  sub gate_utf8_lenient {
    my ($b) = @_;
    my $o = "";
    while (length $b) {
      if ($b =~ s/^((?:[\x00-\x7F]|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2})+)//s) {
        my $t = $1;
        utf8::decode($t);
        $o .= $t;
      } else {
        $b =~ s/^.//s;
        $o .= "\x{FFFD}";
      }
    }
    return $o;
  }
  sub gate_unq {
    my ($t) = @_;
    my $o = "";
    while (length $t) {
      if ($t =~ s/^"((?:[^"\\]|\\.)*)"//s) {
        my $s = $1; $s =~ s/\\([\\"\$`])/$1/gs; $o .= $s;
      } elsif ($t =~ s/^\$\x27((?:[^\x27\\]|\\.)*)\x27//s) { $o .= gate_ansi_c($1);
      } elsif ($t =~ s/^\x27([^\x27]*)\x27//s) { $o .= $1;
      } elsif ($t =~ s/^\\(.)//s)              { $o .= $1;
      } elsif ($t =~ s/^([^"\x27\\]+)//s)      { $o .= $1;
      } else { $t =~ s/^(.)//s; $o .= $1; }
    }
    return $o;
  }
'

# `GATE_PERL_WORD` is one shared literal that five blocking gates interpolate,
# so its failure mode is the one this whole mechanism must not have: every
# consumer runs `perl ... 2>/dev/null`, so a prelude that is PRESENT but does
# not COMPILE produces no output, no stderr, and no exit-code change -- the
# gates simply extract nothing and pass. Measured: a non-empty, non-compiling
# prelude silently disarmed four gates at once (a Japanese body, a PR-shaped
# deferral, an unlabelled `Severity: high`, and a bare `#4` all reached rc=0).
#
# `[ -n "$GATE_PERL_WORD" ]` cannot see that, so it is not the guard -- it is
# only the cheap first half. This is the second half: run the prelude on a
# known input and require the known answer. Call it AFTER a gate has armed, not
# at library-load: the library is sourced by every hook on every Bash call,
# while an armed gate is already about to fork perl anyway.
#
# Returns 0 when the prelude is usable, 1 otherwise. Callers must fail CLOSED.
# Memoised fail-closed wrapper: probe once per process, at the first point a
# gate is actually about to extract, then remember. `$1` is the gate's own name
# so the refusal says which one refused.
# RESET AT LOAD. `__GATE_PW_OK` is an ordinary shell variable, so without this
# it is inheritable: `__GATE_PW_OK=1 gh issue create ...` made the probe report
# a working prelude it never ran, and a Japanese body passed at rc=0 against a
# deliberately broken library (measured). A guard whose whole job is to fail
# closed on a tampered library must not be disable-able by one env var.
__GATE_PW_OK=

gate_perl_word_or_die() {
  if [ "${__GATE_PW_OK:-}" != "1" ]; then
    if gate_perl_word_ok; then
      __GATE_PW_OK=1
    else
      echo "Blocked by $1: .claude/hooks/_command-match.sh defines GATE_PERL_WORD," >&2
      echo "but running it does not return the expected value -- the prelude is missing," >&2
      echo "outdated, or does not compile. Every extraction in this gate runs perl with" >&2
      echo "stderr discarded, so a broken prelude would silently extract NOTHING and the" >&2
      echo "gate would PASS whatever it was meant to refuse. Refusing instead." >&2
      echo "Fix the library (or restore it from origin/main) and retry." >&2
      return 1
    fi
  fi
  return 0
}

gate_perl_word_ok() {
  [ -n "${GATE_PERL_WORD:-}" ] || return 1
  # FOUR dimensions, not one. The first cut asserted a single quoted-span pair,
  # and a review measured two preludes that passed it while carrying a live
  # bypass: a one-revision-STALE library (no ANSI-C arm -- which is exactly the
  # state a sibling repo mid-port is in), and one hardcoded to the probe's own
  # input. A guard that pins one dimension certifies one dimension.
  #
  # Each line below is a different arm of `$GW` / `gate_unq`, chosen because
  # each was a measured fail-open in its own right:
  #   1  a QUOTED span containing a space
  #   2  a BACKSLASH-escaped space
  #   3  an ANSI-C span, decoded rather than taken literally
  #   4  the metacharacter STOP (the word must not swallow the `;`)
  gate_pw_probe_() {
    printf '%s' "$2" | perl -0777 -ne "$GATE_PERL_WORD"'
      while (/--body-file[=\s]+($GW)/g) { print gate_unq($1) }' 2>/dev/null
  }
  [ "$(gate_pw_probe_ q 'x --body-file "/a b/p.md"')" = '/a b/p.md' ] || return 1
  [ "$(gate_pw_probe_ b 'x --body-file /a\ b/p.md')"  = '/a b/p.md' ] || return 1
  [ "$(gate_pw_probe_ a "x --body-file \$'/a\\'b/p.md' rest")" = "/a'b/p.md" ] || return 1
  [ "$(gate_pw_probe_ m 'x --body-file /a/p.md; echo hi')" = '/a/p.md' ] || return 1
  return 0
}
