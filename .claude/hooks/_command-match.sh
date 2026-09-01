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
