#!/usr/bin/env bash
# Smoke test for _command-match.sh, the shared segment matcher every gate uses.
# Run from the repo root: `bash .claude/hooks/_command-match.test.sh`
#
# The cases are the spellings go-to-k/cdk-local#541 measured running UNGATED
# against the old line-start-anchored regexes, plus the negatives that must stay
# out (a verb inside a string, a different verb, a lookalike).

set -u

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"

pass=0; fail=0

# want_match <expect 0|1> <label> <command> <regex>
want_match() {
  local want="$1" label="$2" cmd="$3" re="$4" got
  if gate_matches "$cmd" "$re"; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s got %s) :: %s\n' "$label" "$want" "$got" "$cmd"
  fi
}

# want_dir <expected> <label> <command> <fallback> <regex>
want_dir() {
  local want="$1" label="$2" cmd="$3" fallback="$4" re="$5" got
  got=$(gate_target_dir "$cmd" "$fallback" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  want: %s\n  got:  %s\n' "$label" "$want" "$got"
  fi
}

C="$GATE_RE_GIT_COMMIT"
P="$GATE_RE_GIT_PUSH"
M="$GATE_RE_GH_PR_MERGE"

# --- the spellings that used to bypass ---------------------------------------
want_match 0 "bare git commit"              'git commit -m x' "$C"
want_match 0 "git add -A && git commit"     'git add -A && git commit -m x' "$C"
want_match 0 "cd && git commit"             'cd /w/t && git commit -m x' "$C"
want_match 0 "cd ; git commit"              'cd /w/t; git commit -m x' "$C"
want_match 0 "no spaces around &&"          'cd /w/t&&git commit -m x' "$C"
want_match 0 "subshell"                     '(cd /w/t && git commit -m x)' "$C"
want_match 0 "leading env assignment"       'GIT_EDITOR=true git commit -m x' "$C"
want_match 0 "env wrapper"                  'env git commit -m x' "$C"
want_match 0 "git -C <path> commit"         'git -C /w/t commit -m x' "$C"
want_match 0 "git -c k=v commit"            'git -c user.name=t commit -m x' "$C"
want_match 0 "three-segment chain"          'vp run check && git add -A && git commit -m x' "$C"
want_match 0 "pipe into another command"    'git commit -m x | tee log' "$C"
want_match 0 "gh pr merge after a push"     'git push && gh pr merge 1 --squash' "$M"
want_match 0 "git push in second position"  'echo go && git push origin HEAD' "$P"

# --- negatives ----------------------------------------------------------------
want_match 1 "verb inside a double-quoted string" 'echo "next: git commit -m x"' "$C"
want_match 1 "verb inside a single-quoted string" "echo 'run git commit later'" "$C"
want_match 1 "heredoc body mentioning the verb"   'cat <<EOF
git commit -m x
EOF' "$C"
want_match 1 "different verb"                     'git status --short' "$C"
want_match 1 "commit as an argument, not a verb"  'git log --grep commit' "$C"
want_match 1 "push is not commit"                 'git push origin HEAD' "$C"
want_match 1 "gh pr create is not merge"          'gh pr create --fill' "$M"

# --- the verbs cdk-local adds --------------------------------------------------
SW="$GATE_RE_GIT_SWITCH"
CO="$GATE_RE_GIT_CHECKOUT"
GM="$GATE_RE_GIT_MERGE"
IC="$GATE_RE_GH_ISSUE_CREATE"
ICM="$GATE_RE_GH_ISSUE_COMMENT"
API="$GATE_RE_GH_API"

want_match 0 "git switch after a cd"          'cd /w/t && git switch -c feat/x' "$SW"
want_match 1 "switch inside a string"         'echo "then git switch main"' "$SW"
want_match 1 "switch is not checkout"         'git switch main' "$CO"

want_match 0 "git checkout in second position" 'git fetch origin && git checkout main' "$CO"
want_match 1 "checkout inside a string"        "echo 'git checkout main next'" "$CO"

want_match 0 "git merge after a fetch"        'git fetch && git merge --ff-only origin/main' "$GM"
want_match 1 "merge-base is not merge"        'git merge-base origin/main HEAD' "$GM"
want_match 1 "gh pr merge is not git merge"   'gh pr merge 1 --squash' "$GM"

want_match 0 "gh issue create after a write"  'cat > /tmp/b.md <<EOF
body
EOF
gh issue create --body-file /tmp/b.md' "$IC"
want_match 1 "issue create inside a string"   'echo "run gh issue create later"' "$IC"

want_match 0 "gh issue comment in a chain"    'git push && gh issue comment 7 --body-file /tmp/b.md' "$ICM"
want_match 1 "issue create is not comment"    'gh issue create --fill' "$ICM"

want_match 0 "gh api after a cd"              'cd /w/t && gh api -X PATCH repos/o/r/pulls/1 -F body=@/tmp/b.md' "$API"
want_match 1 "api inside a string"            'echo "next: gh api repos/o/r"' "$API"
want_match 1 "gh pr create is not gh api"     'gh pr create --fill' "$API"

# --- GATE_GH_CR: `-R <owner/repo>` absorbed, for the ISSUE-MINT gate only -----
# `gh -R go-to-k/<target> issue create` is the cross-repo mirror flow's own
# spelling and the reason issue-dup-check-gate exists, so its verb regex is
# built on GATE_GH_CR rather than the `-C`-only GATE_GH_C.
MINT="^gh${GATE_GH_CR}[[:space:]]+issue[[:space:]]+create([[:space:]]|\$)"
want_match 0 "mint: plain"                    'gh issue create -t x' "$MINT"
want_match 0 "mint: -R <repo>"                'gh -R go-to-k/cdk-local issue create -t x' "$MINT"
want_match 0 "mint: --repo <repo>"            'gh --repo go-to-k/cdkd issue create -t x' "$MINT"
want_match 0 "mint: -C <path>"                'gh -C /w/t issue create -t x' "$MINT"
want_match 0 "mint: -C and -R together"       'gh -C /w/t -R go-to-k/cdkd issue create -t x' "$MINT"
want_match 0 "mint: quoted -C path"           'gh -C "/a b" issue create -t x' "$MINT"
want_match 0 "mint: -R after a cd, chained"   'cd /w/t && gh -R go-to-k/cdkd issue create -t x' "$MINT"
want_match 1 "mint: -R issue comment"         'gh -R go-to-k/cdk-local issue comment 7 --body x' "$MINT"
want_match 1 "mint: -R pr create"             'gh -R go-to-k/cdk-local pr create --fill' "$MINT"
want_match 1 "mint: inside a string"          'echo "gh -R o/r issue create"' "$MINT"

# The SHARED constant is deliberately NOT widened: pr-body-item-number-gate.sh
# consumes it, and the other gh verb regexes share GATE_GH_C, so its surface
# must stay exactly as it was. These pin that surface in both directions -- the
# `-R` miss is a KNOWN gap in those gates, reported separately, not something
# this lane changed.
want_match 0 "shared IC: plain still matches"  'gh issue create -t x' "$IC"
want_match 0 "shared IC: -C still matches"     'gh -C /w/t issue create -t x' "$IC"
want_match 1 "shared IC: -R unchanged (known gap)" 'gh -R go-to-k/cdk-local issue create -t x' "$IC"
want_match 1 "shared PR create: -R unchanged (known gap)" 'gh -R go-to-k/cdk-local pr create --fill' "$GATE_RE_GH_PR_CREATE"

# --- the REST mint (issue-dup-check-gate) -------------------------------------
# `gh api repos/<o>/<r>/issues` creates an issue; the path must NOT continue
# past `issues`, which is what separates a mint from a comment or an edit.
APIIC="$GATE_RE_GH_API_ISSUE_CREATE"
want_match 0 "gh api issues POST"             'gh api repos/go-to-k/cdk-local/issues -f title=t' "$APIIC"
want_match 0 "gh api issues POST after a cd"  'cd /w/t && gh api repos/go-to-k/cdkd/issues -f title=t' "$APIIC"
want_match 0 "gh api issues POST with -R"     'gh -R go-to-k/cdkd api repos/go-to-k/cdkd/issues -f title=t' "$APIIC"
want_match 1 "gh api issue comments"          'gh api repos/go-to-k/cdk-local/issues/5/comments -f body=x' "$APIIC"
want_match 1 "gh api issue PATCH"             'gh api -X PATCH repos/go-to-k/cdk-local/issues/5 -f body=x' "$APIIC"
want_match 1 "gh api pulls is not issues"     'gh api repos/go-to-k/cdk-local/pulls -f title=t' "$APIIC"
want_match 1 "gh issue create is not gh api"  'gh issue create --fill' "$APIIC"

want_dir "/w/t" "gh -C on an issue comment"   'gh -C /w/t issue comment 7 --body x' /fallback "$ICM"
want_dir "/w/t" "cd before a git switch"      'cd /w/t && git switch main' /fallback "$SW"

# --- target directory ---------------------------------------------------------
want_dir "/fallback"  "no cd, no -C"           'git commit -m x' /fallback "$C"
want_dir "/w/t"       "leading cd"             'cd /w/t && git commit -m x' /fallback "$C"
want_dir "/w/t"       "cd in an earlier segment" 'cd /w/t && git add -A && git commit -m x' /fallback "$C"
want_dir "/w/b"       "chained cd"             'cd /w && cd /w/b && git commit -m x' /fallback "$C"
want_dir "/fallback/rel" "relative cd"         'cd rel && git commit -m x' /fallback "$C"
want_dir "/w/t"       "git -C beats cd"        'cd /other && git -C /w/t commit -m x' /fallback "$C"
want_dir "/w/t"       "gh -C on a merge"       'gh -C /w/t pr merge 1 --squash' /fallback "$M"
want_dir "/fallback"  "cd AFTER the verb does not count" 'git commit -m x && cd /w/t' /fallback "$C"

# --- every gate is actually converted -----------------------------------------
# The matcher only helps a gate that uses it. This pins the conversion so a new
# gate (or a revert) cannot quietly go back to a line-start-anchored `grep`.
HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for gate in "$HOOK_DIR"/*.sh; do
  base=$(basename "$gate")
  case "$base" in _*.sh | *.test.sh) continue ;; esac
  if grep -q '_command-match.sh' "$gate"; then
    pass=$((pass + 1)); printf 'OK   %s sources the matcher\n' "$base"
  else
    fail=$((fail + 1)); printf 'FAIL %s does not source _command-match.sh\n' "$base"
  fi
  if grep -q "grep -qE '\^\[\[:space:\]\]\*(cd\[" "$gate"; then
    fail=$((fail + 1)); printf 'FAIL %s still has a line-start-anchored matcher\n' "$base"
  else
    pass=$((pass + 1)); printf 'OK   %s has no line-start-anchored matcher\n' "$base"
  fi
done

# --- the review findings from go-to-k/cdk-local#542 --------------------------
# Every one of these was measured WRONG in the first version of this helper.
want_match 0 "bare & separator"              'sleep 0 & git commit -m x' "$C"
want_match 0 "command substitution"          'echo $(git commit -m x)' "$C"
want_match 0 "substitution into a variable"  'SHA=$(git commit -m x)' "$C"
want_match 0 "backtick substitution"         'echo `git commit -m x`' "$C"
want_match 0 "bash -c wrapper"               'bash -c "git commit -m x"' "$C"
want_match 0 "if/then compound"              'if true; then git commit -m x; fi' "$C"
want_match 0 "for/do compound"               'for f in a; do git commit -m x; done' "$C"
want_match 0 "timeout wrapper"               'timeout 60 git commit -m x' "$C"
want_match 0 "time wrapper"                  'time git commit -m x' "$C"
want_match 0 "nested subshells"              '( ( git commit -m x ) )' "$C"
want_match 0 "backslash continuation"        'git \
  commit -m x' "$C"
want_match 0 "quoted -C path with a space"   'git -C "/w t" commit -m x' "$C"

# The quote machinery only earns its keep on a separator INSIDE a string: without
# it these match, and the gates start blocking ordinary `echo`s.
want_match 1 "&& inside a quoted string"     'echo "step && git commit -m x"' "$C"
want_match 1 "; inside a quoted string"      "echo 'step ; git commit -m x'" "$C"
want_match 1 "| inside a quoted string"      'echo "step | git commit -m x"' "$C"
# A quoted span survives a NEWLINE: a `--body "…"` argument is one span, and this
# repo writes PR bodies that quote shell examples.
want_match 1 "multi-line quoted body" 'gh pr create --body "line one
line two && git commit -m x
line three"' "$C"
want_match 1 "CRLF heredoc terminator" 'cat <<EOF
body
EOF
echo done' "$C"

want_dir "/w t"   "quoted cd path"   'cd "/w t" && git commit -m x' /fb "$C"
want_dir "/w t"   "quoted -C path"   'git -C "/w t" commit -m x' /fb "$C"
want_dir "/fb"    "-C in a NON-matched segment is ignored" \
  'git -C /elsewhere status && git commit -m x' /fb "$C"

# --- heredoc termination (go-to-k/cdkd#2130, found porting this to cdkd) -------
# An opener whose delimiter never appears again does NOT open a heredoc. Honouring
# it swallowed the rest of the command: `cat <<EOF` + prose + a real commit was a
# NO MATCH — fail open, and the shape a PR-body-writing session produces daily.
want_match 0 "unterminated heredoc does not swallow the command" 'cat <<EOF
some prose
git commit -m x' "$C"
want_match 1 "terminated heredoc blanks its body" 'cat <<EOF
git commit -m x
EOF' "$C"
want_match 0 "command AFTER a terminated heredoc still matches" 'cat <<EOF
prose
EOF
git commit -m x' "$C"
want_match 1 "a body-only mention is not a command" 'gh pr create --body-file - <<EOF
run git commit when done
EOF' "$C"

# --- quote recovery + quoted heredoc mention (go-to-k/cdkd#2130) --------------
# An apostrophe in a word is not a quote: treating it as one left the span open
# and swallowed every command after it.
want_match 0 "apostrophe in a word, then a real commit" "echo don't; git commit -m y" "$C"
want_match 0 "apostrophe with && after it" "echo it's fine && git commit -m x" "$C"
# A heredoc opener inside a quoted span is a MENTION, not an opener.
want_match 0 "quoted <<X mention does not open a heredoc" 'echo "use <<EOF here"
git commit -m x
EOF' "$C"
# Balanced quotes must still hide their contents.
want_match 1 "balanced quotes still hide a separator" 'echo "step && git commit -m x"' "$C"
want_match 1 "balanced single quotes still hide one" "echo 'step ; git commit -m x'" "$C"

# --- compound statements, wrappers, process substitution (go-to-k/cdkd#2130) ---
# Every one of these ran UNGATED before, and each is a regression against the
# unanchored greps some gates used to carry.
want_match 0 "if ... then <verb>"        'if true; then git commit -m x; fi' "$C"
want_match 0 "while ... do <verb>"       'while :; do git commit -m x; done' "$C"
want_match 0 "until ... do <verb>"       'until false; do git commit -m x; done' "$C"
want_match 0 "negation"                  '! git commit -m x' "$C"
want_match 0 "sudo wrapper"              'sudo git commit -m x' "$C"
want_match 0 "xargs wrapper"             'xargs -I{} git commit -m {}' "$C"
want_match 0 "case arm"                  'case a in a) git commit -m x;; esac' "$C"
want_match 0 "process substitution"      'diff <(git commit -m x) /dev/null' "$C"
want_match 0 "output process substitution" 'tee >(git commit -m x) < f' "$C"

# A quoted span that CONTINUES past the newline is one argument: its lines are
# not separate commands, even when one of them starts with a gated verb.
want_match 1 "multi-line quoted body line starting with the verb" 'gh pr create --body "intro
git commit -m x was the step
end"' "$C"
# ... and a QUOTED heredoc tag is an ordinary opener, so its body is still data.
want_match 1 "quoted heredoc tag still hides its body" "cat <<'EOF'
git commit -m x
EOF" "$C"

want_dir "/tmp/a&b" "quoted path containing an ampersand" \
  'cd "/tmp/a&b" && git commit -m x' /fb "$C"

# --- unexpanded paths (go-to-k/cdkd#2130 spec review) -------------------------
# `cd "$WT" && …` is the spelling this flow MANDATES. Resolving it literally gave
# `<cwd>/$WT`, which no `git -C` can read, so the gate could not resolve a tree
# and exited 0. Falling back to the payload cwd fails CLOSED instead.
want_dir "/base" "cd with an unexpanded variable falls back" 'cd "$WT" && git commit -m x' /base "$C"
want_dir "/base" "cd with a command substitution falls back" 'cd "$(pwd)" && git commit -m x' /base "$C"
want_dir "/base" "-C with an unexpanded variable falls back" 'git -C "$WT" commit -m x' /base "$C"
want_dir "/real/path" "a real quoted path still resolves" 'cd "/real/path" && git commit -m x' /base "$C"
# The verb is still SEEN in all of those — only the directory falls back.
want_match 0 "unexpanded cd still matches the verb" 'cd "$WT" && git commit -m x' "$C"
want_match 0 "xargs behind a pipe" 'echo f | xargs git commit -m x' "$C"

# --- go-to-k/cdkd#2130 test review: two real defects, and the unpinned rest ----
want_match 0 "bash -c with an inner chain" 'bash -c "cd /w && git commit -m x"' "$C"
want_match 0 "process substitution"        'diff <(git commit -m x) b' "$C"
# An escaped separator outside quotes is LITERAL — one `echo`, not two commands.
want_match 1 "escaped semicolon is literal" 'echo a\; git commit -m x' "$C"
# Behaviour that was already right but pinned by nothing.
want_match 1 "ANSI-C quoting hides its contents" "echo \$'x; git commit'" "$C"
want_match 0 "parameter expansion default runs"  'echo ${V:-a; git commit -m x}' "$C"
want_match 1 "# comment holding the verb"        'echo hi # git commit -m x' "$C"
want_match 1 "grep pattern is not a verb"        'git log --grep commit' "$C"
want_match 1 "grep=pattern is not a verb"        'git log --grep=commit' "$C"
want_match 1 "an ordinary task run"              'vp run test' "$C"
# The quoted-span protection is what stops a gate firing on prose: pin it with a
# separator INSIDE the quotes, which is the only shape that can distinguish it.
want_match 1 "separator inside a quoted body" 'gh issue create --body "run vp check && git commit -m x"' "$C"

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
