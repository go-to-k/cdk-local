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

# --- GATE_GH_C absorbs `-C` / `-R` / `--repo` for EVERY gh verb --------------
# It absorbed `-C <path>` only until 2026-08-25, which was a live gate bypass:
# `gh -R o/r pr merge 1 --squash` matched nothing and walked past verify-pr-gate
# and integ-gate. These pin the widened surface on every gh verb regex, since
# they all share the absorber.
want_match 0 "IC: -R <repo>"                  'gh -R go-to-k/cdk-local issue create -t x' "$IC"
want_match 0 "IC: --repo <repo>"              'gh --repo go-to-k/cdkd issue create -t x' "$IC"
want_match 0 "IC: -C and -R together"         'gh -C /w/t -R go-to-k/cdkd issue create -t x' "$IC"
want_match 0 "IC: quoted -C path"             'gh -C "/a b" issue create -t x' "$IC"
want_match 0 "IC: -R after a cd, chained"     'cd /w/t && gh -R go-to-k/cdkd issue create -t x' "$IC"
# THE bypass cases. Before the widening these matched NOTHING.
want_match 0 "pr merge: -R <repo>"            'gh -R go-to-k/cdk-local pr merge 1 --squash' "$M"
want_match 0 "pr merge: --repo <repo>"        'gh --repo go-to-k/cdk-local pr merge 1 --squash' "$M"
want_match 0 "pr create: -R <repo>"           'gh -R go-to-k/cdk-local pr create --fill' "$GATE_RE_GH_PR_CREATE"
want_match 0 "pr edit: -R <repo>"             'gh -R go-to-k/cdk-local pr edit 1 --body x' "$GATE_RE_GH_PR_EDIT"
want_match 0 "issue comment: -R <repo>"       'gh -R go-to-k/cdk-local issue comment 7 --body x' "$ICM"
want_match 0 "gh api: -R <repo>"              'gh -R go-to-k/cdk-local api repos/o/r/pulls/1' "$API"
# ALL THREE separators `gh` accepts, not just the space form. Verified against a
# real repo: `gh pr list --repo=go-to-k/cdkd`, `-R=go-to-k/cdkd` and the GLUED
# `-Rgo-to-k/cdkd` all return the same PR number. An explicit flag alternation
# fixed only the space form, so `gh --repo=o/r pr merge --squash` was still a
# bypass; GATE_FLAGS' `-[^[:space:]]+` token swallows all three whole.
want_match 0 "pr merge: --repo=<repo>"       'gh --repo=go-to-k/cdk-local pr merge 1 --squash' "$M"
want_match 0 "pr merge: -R=<repo>"           'gh -R=go-to-k/cdk-local pr merge 1 --squash' "$M"
want_match 0 "pr merge: -R<repo> glued"      'gh -Rgo-to-k/cdk-local pr merge 1 --squash' "$M"
want_match 0 "pr merge: -C=<path>"           'gh -C=/w/t pr merge 1 --squash' "$M"
want_match 0 "pr create: --repo=<repo>"      'gh --repo=go-to-k/cdk-local pr create --fill' "$GATE_RE_GH_PR_CREATE"
want_match 0 "IC: --repo=<repo>"             'gh --repo=go-to-k/cdk-local issue create -t x' "$IC"
want_match 0 "IC: -R=<repo>"                 'gh -R=go-to-k/cdk-local issue create -t x' "$IC"
want_match 0 "IC: -R<repo> glued"            'gh -Rgo-to-k/cdk-local issue create -t x' "$IC"
want_match 0 "IC: two flags, mixed seps"     'gh -C /w/t --repo=go-to-k/cdkd issue create -t x' "$IC"
want_match 0 "api mint: --repo=<repo>"       'gh --repo=go-to-k/cdkd api repos/go-to-k/cdkd/issues -f title=t' "$GATE_RE_GH_API_ISSUE_CREATE"
# The wider token must still not let one gh verb match a DIFFERENT one, and the
# `=`/glued forms are where a too-greedy absorber would show it first.
want_match 1 "glued -R: pr view is not create" 'gh -Rgo-to-k/cdk-local pr view 42' "$GATE_RE_GH_PR_CREATE"
want_match 1 "glued -R: pr create is not merge" 'gh -Rgo-to-k/cdk-local pr create --fill' "$M"
want_match 1 "--repo=: issue comment is not create" 'gh --repo=go-to-k/cdk-local issue comment 7 --body x' "$IC"
# A flag VALUE must not swallow the verb: GATE_FLAGS' optional value group could
# consume `pr`, and only backtracking saves it. Pin both directions.
want_match 0 "flag with no value, then verb"  'gh --draft pr create --fill' "$GATE_RE_GH_PR_CREATE"
want_match 0 "boolean flag before merge"      'gh --yes pr merge 1 --squash' "$M"
# The plain and `-C` spellings must keep the verdicts they already had --
# widening an absorber must not change what a verb regex means.
want_match 0 "IC: plain unchanged"            'gh issue create -t x' "$IC"
want_match 0 "IC: -C unchanged"               'gh -C /w/t issue create -t x' "$IC"
want_match 0 "pr merge: plain unchanged"      'gh pr merge 1 --squash' "$M"
want_match 0 "pr merge: -C unchanged"         'gh -C /w/t pr merge 1 --squash' "$M"
# ...and the absorber must not let one gh verb match a DIFFERENT gh verb, which
# is the failure mode a greedy flag run would introduce.
want_match 1 "pr merge: -R pr create is not merge" 'gh -R go-to-k/cdk-local pr create --fill' "$M"
want_match 1 "IC: -R issue comment is not create"  'gh -R go-to-k/cdk-local issue comment 7 --body x' "$IC"
want_match 1 "IC: -R pr create is not issue create" 'gh -R go-to-k/cdk-local pr create --fill' "$IC"
want_match 1 "pr create: -R pr view is not create"  'gh -R go-to-k/cdk-local pr view 42' "$GATE_RE_GH_PR_CREATE"
want_match 1 "IC: -R inside a string"              'echo "gh -R o/r issue create"' "$IC"

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

# --- gate_target_dir: `-C` is ORDER-INDEPENDENT within the flag run ----------
# The scan used to anchor on `(git|gh)[[:space:]]+-C`, so `-C` had to sit
# IMMEDIATELY after the command word and FLAG ORDER decided the verdict:
# `gh -C /w/t -R o/r pr merge` resolved, `gh -R o/r -C /w/t pr merge` fell back
# to the payload cwd. That is a live bypass -- driven through verify-pr-gate
# with the `-C` target's marker STALE and the payload cwd's FRESH, the
# `-R`-first spellings returned rc=0 and the merge was judged against a
# different worktree's marker. Until this block there was NO want_dir case for
# the `=` / multi-flag resolution at all.
want_dir "/w/t" "-C first, then -R"        'gh -C /w/t -R o/r pr merge 1 --squash' /fallback "$M"
want_dir "/w/t" "-R first, then -C"        'gh -R o/r -C /w/t pr merge 1 --squash' /fallback "$M"
want_dir "/w/t" "--repo= first, then -C"   'gh --repo=o/r -C /w/t pr merge 1 --squash' /fallback "$M"
want_dir "/w/t" "-R first, then -C="       'gh -R o/r -C=/w/t pr merge 1 --squash' /fallback "$M"
want_dir "/w/t" "glued -R, glued -C"       'gh -Ro/r -C/w/t pr merge 1 --squash' /fallback "$M"
want_dir "/w/t" "-C= alone"                'gh -C=/w/t pr merge 1 --squash' /fallback "$M"
want_dir "/w/t" "-C glued alone"           'gh -C/w/t pr merge 1 --squash' /fallback "$M"
want_dir "/w t" "-R first, quoted -C path" 'gh -R o/r -C "/w t" pr merge 1 --squash' /fallback "$M"
want_dir "/w/t" "last -C wins, after -R"   'gh -R o/r -C /a -C /w/t pr merge 1 --squash' /fallback "$M"
want_dir "/w/t" "-C after -R on issue create" 'gh -R o/r -C /w/t issue create -t x' /fallback "$IC"
# A `-C` AFTER the verb is an argument, not a flag of the verb run, so it must
# NOT steer the lookup -- the scan reads only the text the verb ERE consumed.
want_dir "/fallback" "-C after the verb is ignored" 'gh pr merge 1 --squash -C /w/t' /fallback "$M"
# Lowercase `git -c k=v` is not `-C` (the match is case-sensitive).
want_dir "/w/t" "git -c config before -C" 'git -c user.name=t -C /w/t commit -m x' /fallback "$C"
want_dir "/fallback" "git -c alone is not -C" 'git -c user.name=t commit -m x' /fallback "$C"
want_dir "/base" "-C= with an unexpanded variable falls back" 'gh -R o/r -C="$WT" pr merge 1' /base "$M"

# --- gate_pr_selector: DIRECT cases -----------------------------------------
# It was fenced only indirectly, through the gates in
# gate-command-recognition.test.sh. A helper four gates depend on for the PR
# they judge deserves cases at its own level.
want_sel() {
  local want="$1" label="$2" cmd="$3" re="$4" got
  got=$(gate_pr_selector "$cmd" "$re")
  [ -z "$got" ] && got="(none)"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  want: %s\n  got:  %s\n' "$label" "$want" "$got"
  fi
}
want_sel "552"    "plain positional"            'gh pr merge 552 --squash' "$M"
want_sel "552"    "-R before the verb"          'gh -R go-to-k/x pr merge 552 --squash' "$M"
want_sel "552"    "--repo= before the verb"     'gh --repo=go-to-k/x pr merge 552 --squash' "$M"
want_sel "552"    "glued -R before the verb"    'gh -Rgo-to-k/x pr merge 552 --squash' "$M"
want_sel "552"    "flags before the number"     'gh pr merge --squash --auto 552' "$M"
want_sel "552"    "short boolean before number" 'gh pr merge -d 552' "$M"
want_sel "552"    "--flag=value before number"  'gh pr merge --body=x 552' "$M"
want_sel "552"    "numeric token BEFORE the verb is not the selector" \
  'sleep 30 && gh -R go-to-k/x pr merge 552 --squash' "$M"
want_sel "552"    "an earlier merge mention does not win" \
  'echo "gh pr merge 11" && gh pr merge 552 --squash' "$M"
want_sel "(none)" "no positional means current branch" 'gh pr merge --squash' "$M"
want_sel "(none)" "a branch name is not a number"      'gh pr merge my-branch --squash' "$M"
want_sel "(none)" "a URL positional is not a number"   'gh pr merge https://github.com/o/r/pull/552' "$M"
want_sel "(none)" "verb not present"                   'gh pr view 552' "$M"
want_sel "552"    "pr edit selector"                   'gh -R go-to-k/x pr edit 552 --body x' "$GATE_RE_GH_PR_EDIT"
# THE POLARITY of the flag enumeration, pinned in both directions. VALUELESS
# flags are enumerated; every other `-...` consumes its next token. The opposite
# polarity -- enumerating value-takers -- was tried and is strictly worse,
# because the two failure modes are not symmetric:
#
#   unlisted VALUE-TAKER   -> its value stays in the walk -> a plausible integer
#                             becomes the selector -> a DIFFERENT PR is judged.
#                             Measured: `gh pr merge -t 42 552` resolved to 42.
#   unlisted VALUELESS     -> it eats the number -> selector EMPTY -> the caller
#                             falls back to current-branch semantics.
#
# Wrong-PR is severe, no-PR is not, so the empty results below are the DESIRED
# outcome, not a gap.
want_sel "552"    "--disable-auto is valueless"    'gh pr merge --disable-auto 552' "$M"
want_sel "552"    "--admin is valueless"           'gh pr merge --admin 552' "$M"
want_sel "552"    "-d short boolean"               'gh pr merge -d 552' "$M"
want_sel "2195"   "--delete-branch --squash"       'gh pr merge --delete-branch --squash 2195' "$M"
want_sel "(none)" "an unknown future flag yields EMPTY, not a wrong PR" \
  'gh pr merge --some-new-flag 552' "$M"
# The verb ERE absorbs only what PRECEDES the verb, so a repo flag written AFTER
# it lands in this walk. Unlisted => value-taking => the slug is consumed and the
# real number is found. Under the value-taker polarity `-R` was treated as
# valueless and the SLUG became the selector.
want_sel "552"    "-R <slug> after the verb"       'gh pr merge -R go-to-k/cdk-local 552 --squash' "$M"
want_sel "552"    "--repo <slug> after the verb"   'gh pr merge --repo go-to-k/cdk-local 552' "$M"
want_sel "552"    "-t <title> after the verb"      'gh pr merge -t 42 552' "$M"
want_sel "552"    "--body-file value is skipped"   'gh pr merge --body-file /tmp/b.md 552' "$M"
want_sel "552"    "--match-head-commit is skipped" 'gh pr merge --match-head-commit abc123 552' "$M"
want_sel "552"    "-b value is skipped"            'gh pr merge -b text 552' "$M"
# The FINAL NUMERIC GUARD: every caller wants a PR number, so a non-numeric
# positional must yield empty rather than be handed on.
want_sel "(none)" "a repo slug alone is not a PR number" 'gh pr merge go-to-k/cdk-local' "$M"

# --- gate_target_dir must not read inside a quoted flag VALUE ---------------
# `GATE_PATH_TOKEN` is "a quoted span OR a bare run of non-space", so it split
# `core.pager="less` at the first space and read the tail `-C /evil"` as a fresh
# `-C` flag: a quoted flag value STEERED the target directory, and through
# branch-gate on `main` that turns rc=2 into rc=0. Tokens now EMBED quoted spans.
want_dir "/fallback" "-C inside a quoted flag value is not a flag" \
  'git -c core.pager="less -C /evil" commit -m y' /fallback "$C"
want_dir "/fallback" "-C inside a single-quoted value is not a flag" \
  "git -c core.pager='less -C /evil' commit -m y" /fallback "$C"
want_dir "/w/t" "a real -C still wins after a quoted value" \
  'git -c a.b="x -C /evil" -C /w/t commit -m y' /fallback "$C"
want_dir "/w/t" "-c k=v then -C still resolves" 'git -c k=v -C /w/t commit -m y' /fallback "$C"

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
