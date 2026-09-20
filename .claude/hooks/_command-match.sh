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
    # QUOTE- AND ESCAPE-AWARE. A naive depth count returns an EARLY closer for
    # a `)` that is data rather than structure, and an early closer is worse
    # than none: `return 0` falls back to the stack (the benign direction),
    # while a wrong index truncates the body and resumes with `q` still `"`, so
    # the REST of the real body is parsed as quoted prose and the verb inside it
    # never starts a segment. Measured, `gate_matches ... GATE_RE_GIT_COMMIT`:
    #
    #   echo "$(echo <sq>)<sq> ; git commit -m x)"   was UNGATED
    #   echo "$(echo \) ; git commit -m x)"          was UNGATED
    #   echo "$(git commit -m x)"                    GATED  (control)
    #
    # where <sq> is a literal single quote, spelled out rather than written:
    # this whole awk program is a SHELL single-quoted string, so one apostrophe
    # in a comment ends it and hands the rest of the file to bash as code. That
    # has now broken this file three times in one session.
    #
    # Unbalanced parens inside quotes are ordinary -- grep counting a paren, sed
    # substituting one, awk -F with one -- so this is not a corner case.
    function close_paren(line, from,   j, depth, c, iq, d) {
      depth = 1; iq = ""
      for (j = from; j <= length(line); j++) {
        c = substr(line, j, 1)
        # SINGLE quotes first, and BEFORE the backslash arm: inside them a
        # backslash is LITERAL, so `\047a\\\047` closes at its second quote.
        # Skipping the backslash there consumed the closer, left `iq` open, and
        # the span never closed -- and in the QUOTED branch a `return 0` does
        # NOT fall back harmlessly: `extra` is populated only when a closer is
        # found, so the body was never scanned. Measured, that made
        # `echo "$(printf \047a\\\047 ; git commit -m x)"` UNGATED.
        # ... but an ANSI-C span is the OPPOSITE: in `$\047...\047` a backslash
        # ESCAPES, so `\\\047` does NOT close it. Tracked as its own state
        # rather than folded into the plain single-quote arm, which read the
        # escaped quote as the closer, left `iq` open past the real one, and
        # made the same shape ungated the other way round:
        #   echo "$(printf $\047a\\\047b\047 ; git commit -m x)"   ungated
        # This is the rule the `$GW` prelude in this same file already states.
        #
        # The sigil is found by scanning FORWARD from the `$`, never by looking
        # BACK from the quote. A one-character look-back cannot tell a real
        # ANSI-C sigil from a `$` that is ESCAPED, or that is the second half
        # of `$$` (the PID) -- both are a literal dollar followed by a PLAIN
        # single-quoted string, where a backslash-quote CLOSES. Reading those
        # as ANSI-C held `iq` open past the real closer, `close_paren` returned
        # 0, and in the double-quoted branch the body was never scanned as a
        # command at all. Measured in cdkd by differential fuzz against real
        # bash over 20,312 substitution bodies: the look-back spelling produced
        # 15 fail-opens the revision before it did not have.
        #
        # Forward is correct BECAUSE of the arm order: an escaped `$` is eaten
        # by the backslash arm below before its `$` is ever examined here, and
        # `$$` steps over its own second character.
        if (iq == "A") { if (c == "\\") { j++; continue }
                         if (c == "\047") iq = ""; continue }
        if (iq == "\047") { if (c == iq) iq = ""; continue }
        if (c == "\\") { j++; continue }
        if (iq != "") { if (c == iq) iq = ""; continue }
        if (c == "$") { d = substr(line, j + 1, 1)
                        if (d == "$") { j++; continue }
                        if (d == "\047") { iq = "A"; j++; continue }
                        continue }
        if (c == "\"") { iq = c; continue }
        if (c == "\047") { iq = "\047"; continue }

        if (c == "(") depth++
        else if (c == ")") { depth--; if (depth == 0) return j }
      }
      return 0
    }
    # The offset of the CLOSING backtick relative to `from`, or 0 when the span
    # does not close. `index()` cannot be used: it takes the next backtick even
    # when it is BACKSLASH-ESCAPED, which truncated the body the same way an
    # early paren did -- `echo "\x60echo \\\x60 ; git commit -m x\x60"` was
    # UNGATED. Returns the same 1-based offset `index()` did, so call sites are
    # unchanged.
    function close_backtick(s,   j, c) {
      for (j = 1; j <= length(s); j++) {
        c = substr(s, j, 1)
        if (c == "\\") { j++; continue }
        if (c == "\140") return j
      }
      return 0
    }
    function flush_line(line,   i, n, c, out, cp, bt) {
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
          # An ANSI-C span, the same state close_paren tracks. Without it this
          # machine opens a PLAIN span on the quote and the escaped quote
          # inside closes it early, so the rest of the body is read as code and
          # a second substitution splits the line in the wrong place. Measured
          # in cdkd against its real branch-gate: that shape passed a commit on
          # main and a git checkout at rc=0, on main and on every revision of
          # the branch that fixed close_paren alone. The two quote machines in
          # this file must agree -- one of them being right is what let it
          # survive the round that fixed the other.
          #
          # `$$` FIRST, as close_paren does it: the second dollar is the PID s,
          # and what follows is a PLAIN span where the escaped quote CLOSES.
          # Adding the ANSI-C arm without this step-over opens a span on
          # `$$\047` that never closes, so the rest of the line -- separators
          # included -- becomes data, and both the commit and the checkout gate
          # walk through. Measured in cdkd, where the arm shipped without it for
          # one round. Porting one arm of a pair is how the round before that
          # arrived half-applied; diff the two machines arm by arm.
          if (c == "$" && substr(line, i + 1, 1) == "$") { out = out c substr(line, i + 1, 1); i++; continue }
          if (c == "$" && substr(line, i + 1, 1) == "\047" && ignore_q != "\047") {
            q = "A"; out = out c substr(line, i + 1, 1); i++; continue
          }
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
        # A backslash ESCAPES in a double-quoted span and in an ANSI-C one; in
        # a plain single-quoted span it is literal, which is why q == \047 is
        # not in this test.
        if (c == "\\" && (q == "\"" || q == "A")) { out = out c substr(line, i + 1, 1); i++; continue }
        if (c == q || (q == "A" && c == "\047")) { q = ""; out = out c; continue }
        # A command substitution inside a DOUBLE-quoted span RUNS. Leaving it
        # quoted is what let the bypass above through. Inside a SINGLE-quoted
        # span it is literal, so nothing changes there -- that asymmetry is the
        # whole point, and it is why this branch tests q rather than assuming.
        # DUAL-EMIT when the span CLOSES on this line: collapse it to the
        # placeholder inline and queue the body as its own segment. The stack
        # arms below still handle a span that runs past the newline.
        #
        # WHY, measured: pushing onto the stack emits a `\n`, which SPLITS the
        # enclosing text. A body like
        #
        #   --body "Session-fit: next (not this session) -- the `x` fix needs
        #           its own PR"
        #
        # became three segments, so `Session-fit:` and the PR-shaped clause
        # landed in different ones and issue-deferral-criteria-gate returned 0
        # where cdkd and cdk-real-drift both return 2. Backticks and `$( )` are
        # ordinary in the bodies this flow writes, so that is a live bypass, not
        # a corner. Collapsing keeps the enclosing text ONE segment while the
        # body stays visible as a command in its own right -- the same trade
        # cdkd makes (go-to-k/cdkd#2027 / go-to-k/cdkd#2339).
        if (q == "\"" && c == "$" && substr(line, i + 1, 1) == "(") {
          cp = close_paren(line, i + 2)
          if (cp > 0) {
            extrabuf[++extran] = substr(line, i + 2, cp - i - 2)
            out = out SEP_SUBST
            i = cp
            continue
          }
          sdepth++; squote[sdepth] = q; stype[sdepth] = "("; sparen[sdepth] = 1
          q = ""; out = out "\n"; i++; continue
        }
        if (q == "\"" && c == "`") {
          # Backticks do not nest, so the closer is simply the next one.
          bt = close_backtick(substr(line, i + 1))
          if (bt > 0) {
            extrabuf[++extran] = substr(line, i + 1, bt - 1)
            out = out SEP_SUBST
            i = i + bt
            continue
          }
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
    function run_pass(   i, rounds, batch, bn, bi, blines) {
      q = ""; tag = ""; pending = ""; outn = 0; open_span = ""; sdepth = 0
      extran = 0; delete extrabuf
      for (i = 1; i <= total; i++) emit(i)
      if (pending != "") outbuf[++outn] = flush_line(pending)
      # Drain the substitution bodies queued by flush_line, so a command
      # SUBSTITUTION is still scanned as a command in its own right. Bounded: a
      # body can queue more (nested substitutions), so cap the rounds rather
      # than trusting the input to terminate. Each body is run through
      # flush_line so its OWN separators split it.
      rounds = 0
      while (extran > 0 && rounds < 8) {
        bn = extran; batch = ""
        for (bi = 1; bi <= bn; bi++) batch = batch extrabuf[bi] "\n"
        extran = 0; delete extrabuf
        q = ""
        bi = split(batch, blines, "\n")
        for (i = 1; i <= bi; i++) {
          if (blines[i] == "") continue
          outbuf[++outn] = flush_line(blines[i])
        }
        rounds++
      }
      # Hitting the cap DROPS the remaining bodies, i.e. stops scanning
      # commands, so it is announced rather than swallowed -- a silent drop is
      # the fail-open direction this file exists to avoid.
      if (extran > 0) {
        printf "gate_segments: substitution nesting deeper than 8; %d queued body/bodies were NOT scanned\n", extran > "/dev/stderr"
      }
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
# is handled by `GATE_RE_LAUNCH_PASSTHRU` below.
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
# same technique `gate_verb_args` uses, so nothing depends on a capture index
# that the added alternative would renumber.
GATE_RE_CMDSTRING="^((bash|zsh|ksh|sh)[[:space:]]+-[a-z]*c[[:space:]]+|([^[:space:]]*/)?(mise|rtx)${GATE_CMDSTRING_FLAGS}[[:space:]]+(exec|x)${GATE_CMDSTRING_FLAGS}[[:space:]]+${GATE_MISE_CMD_FLAG}([[:space:]]+|=))"
#
# The PASSTHROUGH spelling of the same launcher, `mise exec -- <cmd>`, is NOT a
# command string: the rest of the argv IS the command, so it belongs with the
# LEADERS `gate_strip_prefix` already strips (`env`, `nohup`, `sudo`, `xargs`
# …). `exec` is in that list, but the `mise` word, its flags, its subcommand and
# the bare `--` are not -- and the list's `-[A-Za-z][^[:space:]]*` cannot absorb
# `--`, which has no LETTER after the dash, so without this constant every gate
# is blind to it:
#
#   mise exec -- gh pr merge 1 --squash   # reaches gh ungated
#   mise exec -- git commit -m x          # reaches git ungated
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
    # `gate_verb_args` scans from `BASH_REMATCH[0]`. Behaviour is unchanged:
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
      # the pipe belongs to the OUTER command: in `bash -c 'git commit -m x'
      # | tail` it is the whole `bash -c` whose exit status the shell discards.
      # Note it is `$piped` and not `$GATE_PIPE_MARK`: marking unconditionally
      # would mark the inner segments of an UN-piped `bash -c` too.
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
# NO PRODUCTION CONSUMER since `branch-gate.sh` went, and KEPT anyway: it is the
# specimen verb this library's own suite is written against -- 138 of its cases
# use it to exercise SEGMENTATION, quoting, heredocs and substitutions, none of
# which is about `git commit`. Deleting it means re-pointing all of them at a
# live verb, and a mechanical re-point silently changes what a case means (a
# `git add -A && git commit` shape has no `git push` twin). If you want it gone,
# re-point the suite deliberately rather than deleting the constant; it costs
# one line to keep.
GATE_RE_GIT_COMMIT="^git${GATE_FLAGS}[[:space:]]+commit([[:space:]]|$)"
GATE_RE_GIT_PUSH="^git${GATE_FLAGS}[[:space:]]+push([[:space:]]|$)"
GATE_RE_GH_PR_MERGE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)"

GATE_RE_GIT_MERGE="^git${GATE_FLAGS}[[:space:]]+merge([[:space:]]|$)"

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
# Gates that each rolled their own "strip the verb, then read the arguments"
# all broke the moment GATE_GH_C widened, so the strip lives here instead. It
# must come from the SAME constant that armed the gate -- `BASH_REMATCH[0]` of
# the verb ERE -- so a gate cannot match one way and parse another. A caller
# that
# wants something other than a PR number (post-merge-orphan-push-gate wants
# `git push`'s remote and branch) gets the same guarantee here instead of
# writing the strip again.
gate_verb_args() {
  local cmd="$1" re="$2" segment
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    printf '%s\n' "${segment#"${BASH_REMATCH[0]}"}"
  done < <(gate_segments "$cmd")
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
