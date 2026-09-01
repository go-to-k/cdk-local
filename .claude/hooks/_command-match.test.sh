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
#
# The population is the hooks REGISTERED FOR BASH in `.claude/settings.json`, not
# every `*.sh` in the directory. Until the first Stop hook landed the two sets
# were the same, so iterating the directory was iterating the Bash gates by
# coincidence; `stop-unmerged-lane-warn.sh` receives no command at all and was
# failed by a fence asking it to parse one. Deriving the set from REGISTRATION
# rather than from a hand-written exemption list is what keeps a new Bash gate
# from dodging: it is in the population the moment it is wired up, and a list
# would have to be remembered.
#
# The direction that would go silent is a hook registered NOWHERE -- it would
# leave the population without being exempt -- so that is a FAIL of its own
# below, and it is a real defect anyway (a hook that never runs).
HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SETTINGS="$HOOK_DIR/../settings.json"

# Two lists, one pass over the settings: hooks wired to a Bash matcher, and
# every hook wired to anything at all.
bash_hooks=$(python3 - "$SETTINGS" <<'PYEOF'
import json, sys, os

# A group receives Bash commands when it is a TOOL event AND its matcher either
# names Bash or matches everything. The first revision asked only whether the
# string 'Bash' appears in the matcher, which handed a free pass to exactly the
# shape that receives the MOST -- a `PreToolUse` group with the matcher omitted,
# empty, `*` or `.*`, which fires on every tool. Measured: registering a
# non-sourcing hook under `matcher: '*'` left this suite at 229/0. It is also
# the shape this repo just added (the `Stop` group carries no matcher), so the
# next gate copied from it would have dodged the fence silently.
TOOL_EVENTS = ('PreToolUse', 'PostToolUse')

def bashy(m):
    return m is None or m.strip() in ('', '*', '.*') or 'Bash' in m

def name(h):
    parts = (h.get('command') or '').split()
    for tok in reversed(parts):
        if tok.endswith('.sh'):
            return os.path.basename(tok)
    return os.path.basename(parts[0]) if parts else ''

s = json.load(open(sys.argv[1]))
out = set()
for event, groups in s.get('hooks', {}).items():
    if event not in TOOL_EVENTS:
        continue
    for g in groups:
        if not bashy(g.get('matcher')):
            continue
        for h in g.get('hooks', []):
            n = name(h)
            if n:
                out.add(n)
print('\n'.join(sorted(out)))
PYEOF
)
any_hooks=$(python3 - "$SETTINGS" <<'PYEOF'
import json, sys, os

def name(h):
    parts = (h.get('command') or '').split()
    for tok in reversed(parts):
        if tok.endswith('.sh'):
            return os.path.basename(tok)
    return os.path.basename(parts[0]) if parts else ''

s = json.load(open(sys.argv[1]))
out = set()
for event, groups in s.get('hooks', {}).items():
    for g in groups:
        for h in g.get('hooks', []):
            n = name(h)
            if n:
                out.add(n)
print('\n'.join(sorted(out)))
PYEOF
)

# A parser floor: "found nothing" must not read as "everything is fine".
#
# The floor has to be INDEPENDENT of the parse it is checking. A first attempt
# derived it as `dir_count - non_bash`, where `non_bash` was itself "not in
# $bash_hooks" -- so the bound equalled `bash_count` by construction and the
# check could not fail for any input. The bound now comes from a SECOND method
# over the same file: a raw grep for distinct hook script names. If the python
# silently loses entries, the two disagree; if the grep is what breaks, the
# `-lt 1` arm still catches an empty parse.
bash_count=$(printf '%s\n' "$bash_hooks" | grep -c '\.sh$' || true)
any_count=$(printf '%s\n' "$any_hooks" | grep -c '\.sh$' || true)
# Scoped to the `hooks` block, not the whole file: `settings.json` also carries
# a `permissions.allow` array whose entries are `Bash(...)` patterns, and one of
# those naming a `.sh` reds this check with nothing wrong with the parse.
raw_count=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get("hooks", {})))' "$SETTINGS" |
  grep -o '[A-Za-z0-9_-]*\.sh' | sort -u | grep -c . || true)

if [ "${bash_count:-0}" -lt 1 ]; then
  fail=$((fail + 1))
  printf 'FAIL settings parse found no Bash hooks at all -- the fence is blind\n'
elif [ "${any_count:-0}" -ne "${raw_count:-0}" ]; then
  fail=$((fail + 1))
  printf 'FAIL settings parse found %s hook scripts, a raw scan of the hooks block found %s -- the two disagree, so one of them is losing entries\n' \
    "$any_count" "$raw_count"
else
  pass=$((pass + 1))
  printf 'OK   settings parse found %s hook scripts (%s of them Bash), agreeing with a raw scan\n' \
    "$any_count" "$bash_count"
fi

for gate in "$HOOK_DIR"/*.sh; do
  base=$(basename "$gate")
  case "$base" in _*.sh | *.test.sh) continue ;; esac

  if ! printf '%s\n' "$any_hooks" | grep -qxF -- "$base"; then
    fail=$((fail + 1))
    printf 'FAIL %s is registered in no hook event -- it never runs\n' "$base"
    continue
  fi

  # The exemption is not unconditional, and this is the SECOND direction of the
  # same invariant. Above: a hook wired to Bash must source the matcher. Here: a
  # hook that SOURCES the matcher must be wired to Bash -- sourcing it is
  # evidence the hook parses commands, so being on a non-Bash matcher means it
  # never receives one and is INERT, the exact class this file exists for.
  #
  # Without this arm the Bash population had no bound at all once the old
  # literal `-lt 10` floor was replaced (the cross-check above compares the
  # ANY-event parse, not this one). Measured by a review round: moving 22 of the
  # 33 entries into a second `PreToolUse` group with `matcher: "Edit|Write"` --
  # the routine "new group, wrong matcher" slip -- silently exempted eleven live
  # gates including `branch-gate.sh` and left the suite at 218/0. A count-based
  # bound would also have been brittle, since a legitimate Edit-only hook is a
  # normal thing to add; that hook simply does not source the matcher, so this
  # arm passes it.
  if ! printf '%s\n' "$bash_hooks" | grep -qxF -- "$base"; then
    if grep -q '_command-match.sh' "$gate"; then
      fail=$((fail + 1))
      printf 'FAIL %s sources the command matcher but is not registered under a Bash matcher -- it parses commands it never receives\n' "$base"
    else
      pass=$((pass + 1))
      printf 'OK   %s receives no Bash command and does not parse one\n' "$base"
    fi
    continue
  fi

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

# --- go-to-k/cdk-local#585: the LAUNCHER-hosted command string ----------------
# `mise exec -c "<cmd>"` RUNS its argument exactly as `bash -c` does, but the
# segment starts with `mise`, so the recursion never fired and every gate here
# was blind to the spelling.
want_match 0 "mise exec -c body"             'mise exec -c "git commit -m x"' "$C"
want_match 0 "mise x -c body"                'mise x -c "gh pr merge 1 --squash"' "$M"
want_match 0 "rtx exec -c body"              'rtx exec -c "gh pr merge 1 --squash"' "$M"
want_match 0 "absolute launcher path"        '/opt/homebrew/bin/mise exec -c "git commit -m x"' "$C"
want_match 0 "--command long spelling"       'mise exec --command "git commit -m x"' "$C"
want_match 0 "--command= glued spelling"     'mise exec --command="git commit -m x"' "$C"
want_match 0 "single-quoted body"            "mise exec -c 'git commit -m x'" "$C"
want_match 0 "flag between exec and -c"      'mise exec --cd /w -c "git commit -m x"' "$C"
want_match 0 "quoted flag value before -c"   'mise exec --cd "/w t" -c "git commit -m x"' "$C"
want_match 0 "boolean flag before -c"        'mise exec --raw -c "git commit -m x"' "$C"
want_match 0 "global flag before exec"       'mise -C /w exec -c "git commit -m x"' "$C"
want_match 0 "tool pin before -c"            'mise exec node@20 -c "git commit -m x"' "$C"
want_match 0 "inner chain inside the body"   'mise exec -c "cd /w && git commit -m x"' "$C"
# A `-c` INSIDE the body must not be mistaken for the launcher's own. `=~` is
# POSIX leftmost-longest, so a token class able to start inside a quoted span
# lets the flag run reach the inner `-c` and hand back `git commit -m x'"'"'"`,
# which no verb regex matches -- the under-match this fix exists to close.
want_match 0 "nested sh -c inside the body"  "mise exec -c \"sh -c 'git commit -m x'\"" "$C"
# The SUBCOMMAND is required: `mise -c` is not a thing, so recursing there would
# descend into text that never runs.
want_match 1 "bare mise -c does not recurse" 'mise -c "git commit -m x"' "$C"
want_match 1 "bare rtx -c does not recurse"  'rtx -c "git commit -m x"' "$C"
want_match 1 "mise run -c is not exec"       'mise run -c "git commit -m x"' "$C"
# ...and a MENTION inside the body is still only a mention.
want_match 1 "echo of the verb in the body"  'mise exec -c "echo git commit -m x"' "$C"
want_match 1 "grep pattern in the body"      "mise exec -c \"rg 'git commit' .\"" "$C"
want_match 1 "the launcher form as prose"    'echo "mise exec -c \"git commit\""' "$C"

# ...and the PASSTHROUGH half of the same launcher. `mise exec -- <cmd>` hands
# the rest of the argv to the command, so it is a LEADER rather than a command
# string, and `gate_strip_prefix` knew nothing about it: every gate except the
# markgate one (whose verb regex absorbs the launcher itself) saw `mise` and
# stopped. Measured on the pre-fix tree: BOTH lines below were a MISS while
# their unprefixed twins matched.
want_match 0 "mise exec -- gh pr merge"       'mise exec -- gh pr merge 1 --squash' "$M"
want_match 0 "mise exec -- git commit"        'mise exec -- git commit -m x' "$C"
want_match 0 "mise exec -- git push"          'mise exec -- git push origin HEAD' "$P"
want_match 0 "mise x -- passthrough"          'mise x -- gh pr merge 1' "$M"
want_match 0 "rtx exec -- passthrough"        'rtx exec -- gh pr merge 1' "$M"
want_match 0 "absolute launcher path, --"     '/opt/homebrew/bin/mise exec -- git commit -m x' "$C"
want_match 0 "global flag before exec --"     'mise -C /w exec -- git commit -m x' "$C"
want_match 0 "exec flag before --"            'mise exec --cd /w -- git commit -m x' "$C"
want_match 0 "quoted exec flag value before --" 'mise exec --cd "/w t" -- git commit -m x' "$C"
want_match 0 "boolean exec flag before --"    'mise exec --raw -- git commit -m x' "$C"
want_match 0 "tool pin before --"             'mise exec node@20 -- git commit -m x' "$C"
want_match 0 "cd && launcher passthrough"     'cd /w/t && mise exec -- git commit -m x' "$C"
# The OVER-STRIP direction, which nothing else here looks for: a leader that
# strips too eagerly turns a MENTION into a match, and that failure is a false
# BLOCK on every gate at once. The subcommand requirement is what fences it --
# `mise install` / `mise ls` / `mise settings set x` are not passthroughs.
want_match 1 "passthrough of a grep is prose" 'mise exec -- rg "gh pr merge" .' "$M"
want_match 1 "passthrough of an unrelated cmd" 'mise exec -- vp run test' "$C"
want_match 1 "mise install is not exec"       'mise install -- git commit -m x' "$C"
want_match 1 "bare mise -- is not exec"       'mise -- git commit -m x' "$C"
want_match 1 "mise ls -- is not exec"         'mise ls -- git commit -m x' "$C"
want_match 1 "two words before exec --"       'mise settings set x exec -- git commit -m x' "$C"
want_match 1 "the passthrough as prose"       'echo "mise exec -- git commit -m x"' "$C"
# The stripped leader must leave the SEGMENT parseable by the helpers that read
# the verb's own flag run out of it. A surviving leader would hand the payload
# cwd the verdict (`gate_target_dir`) or the wrong PR (`gate_pr_selector`).
want_dir "/w/t"  "-C through the passthrough"  'mise exec -- git -C /w/t commit -m x' /base "$C"
want_dir "/w/t"  "cd then the passthrough"     'cd /w/t && mise exec -- git commit -m x' /base "$C"
want_dir "/w/t"  "gh -C through the passthrough" 'mise exec -- gh -C /w/t pr merge 1' /base "$M"
want_dir "/base" "passthrough with no -C"      'mise exec -- git commit -m x' /base "$C"
want_sel "552"   "selector through the passthrough" 'mise exec -- gh pr merge 552 --squash' "$M"
want_sel "552"   "selector through passthrough + -R" \
  'mise exec -- gh -R go-to-k/cdk-local pr merge 552 --squash' "$M"
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

# --- go-to-k/cdk-local#571: a command substitution inside a DOUBLE-quoted span
# RUNS, so its body is commands. Leaving it quoted made every gate here blind to
# it: measured on origin/main, all three of these matched NOTHING.
want_match 0 "quoted substitution runs"           'echo "$(git commit -m x)"' "$C"
want_match 0 "quoted backtick substitution runs"  'echo "`git commit -m x`"' "$C"
want_match 0 "nested quoted substitution"         'X="$(echo "$(git commit -m x)")"' "$C"
want_match 0 "quoted substitution, gh verb"       'echo "$(gh pr merge 1 --squash)"' "$M"
# ...and the asymmetry that makes the fix safe rather than a blanket unquoting:
# inside a SINGLE-quoted span a substitution is literal text, so it must stay
# invisible. Without this pair the fix could have been "stop honouring quotes".
want_match 1 "single-quoted substitution is literal" "echo '\$(git commit -m x)'" "$C"
want_match 1 "single-quoted backticks are literal"   "echo '\`git commit -m x\`'" "$C"
# The go-to-k/cdkd#2130 regression this could have reintroduced: a `--body`
# whose PROSE follows a closed substitution is still prose, because `q` returns
# to the double quote when the substitution ends.
want_match 1 "prose after a closed substitution" 'gh pr create --body "see $(date) then git commit -m x"' "$C"

# NESTED substitutions. The `$(` / `<(` / `>(` branches consume their `(`
# without counting it, so the outer substitution used to close a paren early.
# That broke BOTH ways, and only the second half is the bypass -- the first is a
# new FALSE BLOCK, which is why both directions are pinned here.
want_match 1 "nested substitution in a body stays prose" \
  'gh pr create --body "ver $(echo $(date)) then git commit -m z"' "$C"
want_match 0 "nested substitution really runs"       'echo "$(echo $(date); gh pr merge 1 --squash)"' "$M"
want_match 0 "process substitution inside a quoted one" 'echo "$(cat <(git commit -m x))"' "$C"
# `<(` needs the same paren count as `$(`, and only the FALSE-BLOCK direction
# discriminates: with the count removed the line above still matches (the verb
# is inside the substitution either way), while this one flips from no-match to
# MATCH and every git/gh gate starts refusing an ordinary `gh pr create`.
want_match 1 "process substitution in a body stays prose" \
  'gh pr create --body "ver $(cat <(date)) then git commit -m z"' "$C"

# --- go-to-k/cdk-local#571: `gate_piped_segments` / `gate_matches_piped` ------
# The distinction the ordinary segmenter cannot make, because it collapses `&&`,
# `;` and `|` to the same newline: whose exit status does the shell REPORT?
MG="$GATE_RE_MARKGATE_VERDICT"

# want_piped <expect 0|1> <label> <command> <regex>
want_piped() {
  local want="$1" label="$2" cmd="$3" re="$4" got
  if gate_matches_piped "$cmd" "$re"; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s got %s) :: %s\n' "$label" "$want" "$got" "$cmd"
  fi
}

want_piped 0 "verdict feeds a pipe"            'mise exec -- markgate verify integ 2>&1 | tail -5' "$MG"
want_piped 0 "bare markgate feeds a pipe"      'markgate verify check | grep state' "$MG"
want_piped 0 "set feeds a pipe"                'mise exec -- markgate set integ | tee /tmp/l' "$MG"
want_piped 0 "|& feeds a pipe"                 'markgate set integ |& tee /tmp/l' "$MG"
want_piped 1 "|| is a status TEST, not a pipe" 'mise exec -- markgate set integ || echo NOPE' "$MG"
want_piped 1 "&& is a status TEST, not a pipe" 'markgate verify check && gh pr merge 1' "$MG"
want_piped 1 "un-piped verdict"                'mise exec -- markgate verify integ >/dev/null 2>&1; rc=$?' "$MG"
want_piped 1 "last stage of a pipeline"        'echo x | markgate verify check' "$MG"
want_piped 1 "status is not a verdict verb"    'mise exec -- markgate status integ | awk "/state/"' "$MG"
# `2>&1` is a REDIRECTION, not a separator. Splitting on its `&` put the pipe
# mark on the trailing `1`, so the issue's own repro walked past the gate.
want_piped 0 "2>&1 before the pipe"            'markgate verify integ 2>&1 | tail -5' "$MG"
want_piped 0 "&> before the pipe"              'markgate verify integ &> /dev/null | tail -5' "$MG"
# ...while a REAL bare `&` still separates.
want_match 0 "bare & still separates"          'sleep 0 & markgate verify check' "$MG"

want_piped 0 "run is a verdict verb too"        'mise exec -- markgate run check -- vp run check | tail -5' "$MG"
# The launcher prefix must absorb LAUNCHER ARGUMENTS only. An unrestricted run
# of words made this a false block -- and it is the command someone auditing
# this very gate would type.
want_piped 1 "mise exec -- rg <pattern> is not markgate" 'mise exec -- rg markgate verify .claude | head' "$MG"
# A launcher flag that TAKES A VALUE must still reach the verb. Tightening the
# interposed run to close the `rg` false block above dropped these, turning
# BLOCK into pass -- so the two cases are pinned as a PAIR, since either fix
# alone re-breaks the other.
want_piped 0 "mise exec -C <dir> -- markgate"  'mise exec -C /w -- markgate verify x | tail' "$MG"
want_piped 0 "mise exec --cd <dir> -- markgate" 'mise exec --cd /w -- markgate verify x | tail' "$MG"
want_piped 0 "mise exec -j <n> -- markgate"    'mise exec -j 4 -- markgate set integ | tee /tmp/l' "$MG"
want_piped 1 "mise exec -C <dir> -- rg is not markgate" 'mise exec -C /w -- rg markgate verify . | head' "$MG"
# ...and a BOOLEAN launcher flag must NOT swallow the command word. Giving every
# flag an optional value (the fix for the two cases above) re-opened the `rg`
# false block one keystroke away. mise has many boolean flags: `--raw`, `-q`,
# `-v`, `-y`, `--silent`, `--deny-all`, `--no-deps`, `--locked`.
want_piped 1 "boolean flag then rg"            'mise exec --raw rg markgate verify . | head' "$MG"
want_piped 1 "short boolean flag then rg"      'mise exec -q rg markgate verify . | head' "$MG"
want_piped 1 "boolean flag then grep"          'mise exec --silent grep -rn markgate verify . | head' "$MG"
want_piped 0 "boolean flag then -- markgate"   'mise exec --raw -- markgate verify x | tail' "$MG"
want_piped 0 "two boolean flags then markgate" 'mise exec -q --raw -- markgate verify x | tail' "$MG"
# A QUOTED flag value -- the same shape `GATE_FLAGS` needed for
# `git -C "/a b" commit`. A `[^-][^[:space:]]*` value cannot span it.
want_piped 0 "quoted launcher flag value"      'mise exec --cd "/w t" -- markgate verify x | tail' "$MG"
# The `--allow-*` sandbox flags take a value too, and were missed when the
# enumeration was first written -- the failure mode an enumeration always has.
want_piped 0 "--allow-net <host> before --"    'mise exec --allow-net github.com -- markgate verify integ | tail' "$MG"
want_piped 0 "--allow-read <path> before --"   'mise exec --allow-read /w -- markgate verify integ | tail' "$MG"
# A value-taking flag whose "value" is the command word itself must still fall
# back to the boolean parse rather than eating it.
want_piped 0 "-C directly before markgate"     'mise exec -C markgate verify x | tail' "$MG"
# A GLOBAL flag sits BEFORE the subcommand. Without its own absorber this was
# under-matched -- the gate simply did not fire, which is the original defect
# one flag position away.
want_piped 0 "global -C <dir> before exec"     'mise -C /w exec -- markgate verify x | tail' "$MG"
want_piped 0 "global --cd <dir> before exec"   'mise --cd /w exec -- markgate set integ | tee /tmp/l' "$MG"
want_piped 0 "global boolean flag before exec" 'mise -q exec -- markgate verify x | tail' "$MG"
want_piped 1 "global flag, then rg not markgate" 'mise -C /w exec -- rg markgate verify . | head' "$MG"
# ...and a NON-FLAG word is not a global flag. This replaces a
# `mise --version | head` case that was VACUOUS: that segment holds no
# `markgate` substring at all, so no spelling of these constants could ever
# match it -- it was a proof, not a probe. This one is the too-wide direction
# the whole chain fights: with the global run unrestricted, `ls` is absorbed,
# the later `exec` satisfies the subcommand, and an ordinary `mise ls` becomes
# a FALSE BLOCK.
want_piped 1 "a non-flag word is not a global flag" 'mise ls exec -- markgate verify x | tail' "$MG"
want_piped 1 "two non-flag words before exec"  'mise settings set x exec -- markgate verify a | tail' "$MG"
# The pipe belongs to the OUTER command, so the `bash -c` recursion has to carry
# the mark inward: it used to drop it and `gate_piped_segments` emitted nothing.
want_piped 0 "bash -c body, outer pipe"        "bash -c 'markgate verify a' | tail" "$MG"
want_piped 0 "bash -c double-quoted body"      'bash -c "mise exec -- markgate verify a" | tail' "$MG"
want_piped 1 "bash -c body, NOT piped"         "bash -c 'markgate verify a'" "$MG"
# go-to-k/cdk-local#585: the launcher-hosted spelling of the same recursion.
want_piped 0 "mise exec -c body, inner pipe"   'mise exec -c "markgate verify integ | tail"' "$MG"
want_piped 0 "mise x -c body, inner pipe"      'mise x -c "markgate set integ | cat"' "$MG"
want_piped 0 "rtx exec -c body, inner pipe"    'rtx exec -c "markgate verify integ | tail"' "$MG"
want_piped 0 "mise exec -c body, OUTER pipe"   "mise exec -c 'markgate verify a' | tail" "$MG"
want_piped 1 "mise exec -c body, NOT piped"    'mise exec -c "markgate verify integ"' "$MG"
want_piped 1 "mise exec -c rg is not markgate" 'mise exec -c "rg markgate verify ."' "$MG"
want_piped 1 "bare mise -c is not a launcher"  'mise -c "markgate verify integ | tail"' "$MG"
want_piped 0 "mise exec with a tool pin"       'mise exec markgate@0.4 -- markgate verify integ | cat' "$MG"
# Multi-line: the pipe is on a later line than the verb, and on the SAME line as
# a different one. A segmenter that only ever saw line 1 passed both.
want_piped 0 "multi-line, pipe on line two"    'cd /w/t
markgate verify integ | tail -5' "$MG"
want_piped 0 "backslash continuation"          'markgate verify integ \
  | tail -5' "$MG"
want_piped 1 "multi-line, un-piped"            'cd /w/t
markgate verify integ >/dev/null 2>&1; rc=$?' "$MG"

# `gate_piped_segments` must print the piped segments and ONLY those, with the
# marker stripped -- a caller reading them as ordinary text is the contract.
got=$(gate_piped_segments 'markgate verify a | tail; markgate verify b' | tr '\n' '/')
if [ "$got" = "markgate verify a/" ]; then
  pass=$((pass + 1)); printf 'OK   gate_piped_segments prints only the piped segment\n'
else
  fail=$((fail + 1)); printf 'FAIL gate_piped_segments printed: %s\n' "$got"
fi
got=$(gate_piped_segments '(markgate verify a) | tail')
if [ "$got" = "markgate verify a" ]; then
  pass=$((pass + 1)); printf 'OK   gate_piped_segments emits ordinary segment text\n'
else
  fail=$((fail + 1)); printf 'FAIL gate_piped_segments emitted: [%s]\n' "$got"
fi
# The mark must never leak into ORDINARY segments, or every gate would see it.
if gate_segments 'markgate verify a | tail' | grep -q "$GATE_PIPE_MARK"; then
  fail=$((fail + 1)); printf 'FAIL the pipe mark leaked into gate_segments output\n'
else
  pass=$((pass + 1)); printf 'OK   gate_segments is unchanged by the pipe mark\n'
fi

# --- GATE_RE_GIT_ADD + gate_verb_args (go-to-k/cdk-local#576) ------------------
# control-char-gate has to know whether the SAME Bash call also stages, because
# a PreToolUse hook runs before the command and the index it can read is the
# PRE-add one. The verb regex is built like every other one here, so the flagged
# and launcher spellings must reach it identically -- and `gate_verb_args` must
# hand back the arguments with the flag run already consumed, so the gate cannot
# match one way and parse another.
A="$GATE_RE_GIT_ADD"

want_match 0 "bare git add"                  'git add -A' "$A"
want_match 0 "git add before a commit"       'git add -A && git commit -m x' "$A"
want_match 0 "git -C <path> add"             'git -C /w/t add -A && git commit -m x' "$A"
want_match 0 "git -C=<path> add (glued sep)" 'git -C=/w/t add -A' "$A"
want_match 0 "launcher passthrough"          'mise exec -- git add -A' "$A"
want_match 0 "inside bash -c"                'bash -c "git add -A && git commit -m x"' "$A"
want_match 1 "add inside a string"           'echo "then git add -A"' "$A"
want_match 1 "git add-something is not add"  'git add--interactive' "$A"
want_match 1 "commit is not add"             'git commit -m x' "$A"
want_match 1 "a pathspec named add"          'git rm add' "$A"

# want_args <expected, newline-joined> <label> <command> <regex>
want_args() {
  local want="$1" label="$2" cmd="$3" re="$4" got
  got=$(gate_verb_args "$cmd" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  want: [%s]\n  got:  [%s]\n' "$label" "$want" "$got"
  fi
}

want_args "-A"          "args after a bare add"        'git add -A' "$A"
# The `-C /w/t` is consumed by the verb ERE, so it must NOT come back as an
# argument -- that is the whole reason the strip is BASH_REMATCH[0] of the same
# regex that armed the gate rather than a locally written prefix chop.
want_args "-A"          "leading -C is absorbed"       'git -C /w/t add -A' "$A"
want_args "src/a.ts"    "a pathspec"                   'git add src/a.ts && git commit -m x' "$A"
want_args '"d i r"'     "a quoted pathspec stays whole" 'git add "d i r"' "$A"
# One line per matching segment, so two adds in one call are both readable.
want_args "-u
docs" "two add segments"                              'git add -u; git add docs' "$A"
want_args ""            "no matching segment"          'git commit -m x' "$A"
want_args "-am x"       "commit args, for the -a scan" 'git commit -am x' "$C"

# `stage` is git's own alias for `add`, so the staging scan must reach it.
want_match 0 "git stage -A"                  'git stage -A && git commit -m x' "$A"
want_match 0 "git -C <path> stage"           'git -C /w/t stage src' "$A"
want_match 1 "git stash is not git stage"    'git stash push -m x' "$A"
want_args "-A"          "args after git stage"         'git stage -A' "$A"


# --- gate_verb_args_dir: the tree AND the args, per segment, from one walk ----
#
# `want_dir` above measures `gate_target_dir`, which answers for the WHOLE
# command. These measure the per-segment answer, and the FIRST of them is the
# anti-drift fence: on a single-segment command the two functions must agree, so
# the deliberate copy of the cd / `-C` reading inside `gate_verb_args_dir`
# cannot drift from the original without a red case.
want_lines() { # <expected, newline-joined> <label> <cmd> <fallback> <re>
  local want="$1" label="$2" cmd="$3" fallback="$4" re="$5" got
  got=$(gate_verb_args_dir "$cmd" "$fallback" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  want: %s\n  got:  %s\n' "$label" "$want" "$got"
  fi
}

TAB=$(printf '\t')
for _probe in 'git push origin main' 'cd /a/b && git push origin main' \
              'git -C /w/t push origin main' 'cd /a/b && git -C /w/t push origin main' \
              'cd /a/b && cd c && git push origin main'; do
  _one=$(gate_target_dir "$_probe" /fallback "$P")
  _each=$(gate_verb_args_dir "$_probe" /fallback "$P")
  _each="${_each%%$TAB*}"
  if [ "$_one" = "$_each" ]; then
    pass=$((pass + 1)); printf 'OK   per-segment dir agrees with gate_target_dir :: %s\n' "$_probe"
  else
    fail=$((fail + 1)); printf 'FAIL per-segment dir disagrees :: %s\n  whole: %s\n  seg:   %s\n' "$_probe" "$_one" "$_each"
  fi
done
unset _probe _one _each

# ...and the part `gate_target_dir` CANNOT express: two segments, two trees.
want_lines "/w/one${TAB}origin a
/w/two${TAB}origin b" "two -C segments resolve independently" \
  'git -C /w/one push origin a && git -C /w/two push origin b' /fallback "$P"
# A `cd` PERSISTS into the next segment; a `-C` binds only its own command.
want_lines "/a/b${TAB}origin a
/a/b${TAB}origin b" "a cd carries into later segments" \
  'cd /a/b && git push origin a && git push origin b' /fallback "$P"
want_lines "/a/b${TAB}origin a
/w/t${TAB}origin b
/a/b${TAB}origin c" "a -C does not leak into the next segment" \
  'cd /a/b && git push origin a && git -C /w/t push origin b && git push origin c' /fallback "$P"
# An UNEXPANDED path is skipped, exactly as `gate_target_dir` skips it, so the
# segment falls back to the running cd state rather than to a literal `$W`.
want_lines "/fallback${TAB}origin a" "an unexpanded -C falls back, not to a literal" \
  'git -C "$W" push origin a' /fallback "$P"



# --- gate_tokens ---------------------------------------------------------------
#
# The argument-list splitter main-tree-branch-gate parses options with. It lives
# HERE rather than in the gate because matching `GATE_EMBEDDING_TOKEN` inside a
# hook and then reading a positional `${BASH_REMATCH[N]}` out of it is the
# go-to-k/cdkd#2200 coupling: widening the shared constant shifts the index and
# silently re-opens the gate. Pinned here so the gate can rely on it.
tok_case() { # name, text, expected newline-joined tokens
  local name="$1" text="$2" want="$3" got
  got=$(gate_tokens "$text")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   gate_tokens: %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL gate_tokens: %s\n  text: [%s]\n  want: [%s]\n  got : [%s]\n' "$name" "$text" "$want" "$got"
  fi
}
tok_case "plain words" " -b feat" "$(printf -- '-b\nfeat')"
tok_case "leading and trailing space" "   feat   " "feat"
tok_case "empty text yields nothing" "" ""
tok_case "only whitespace yields nothing" "    " ""
tok_case "a double-quoted span stays ONE token" ' -c "wt feat new"' "$(printf -- '-c\n"wt feat new"')"
tok_case "a single-quoted span stays ONE token" " -c 'wt feat new'" "$(printf -- "-c\n'wt feat new'")"
tok_case "a glued flag value is not split" " --orphan=feat" "--orphan=feat"
tok_case "a bare -- survives as its own token" " some-feature -- README.md" "$(printf -- 'some-feature\n--\nREADME.md')"
tok_case "an unquoted glob is not expanded" " *" "*"
tok_case "runs of spaces collapse" " a     b" "$(printf -- 'a\nb')"


# --- gate_argv ------------------------------------------------------------------
#
# `gate_tokens` splits SHELL WORDS; this splits git's ARGV, which is what an
# option parse actually reads. The difference is not cosmetic: a redirection, its
# spaced target, a trailing `&` and a `#` comment are all WORDS and none of them
# is an ARGUMENT, and counting them as arguments is what made
# `git checkout <branch> 2>/dev/null` read as a two-positional file restore and
# PASS through main-tree-branch-gate (measured rc=0, want 2, on a command that
# really moves HEAD).
argv_case() { # name, text, expected newline-joined argv, expected rc
  local name="$1" text="$2" want="$3" wantrc="${4:-0}" got gotrc
  got=$(gate_argv "$text"); gotrc=$?
  if [ "$got" = "$want" ] && [ "$gotrc" = "$wantrc" ]; then
    pass=$((pass + 1)); printf 'OK   gate_argv: %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL gate_argv: %s\n  text: [%s]\n  want: [%s] rc=%s\n  got : [%s] rc=%s\n' \
      "$name" "$text" "$want" "$wantrc" "$got" "$gotrc"
  fi
}
argv_case "plain words are argv unchanged" " -b feat" "$(printf -- '-b\nfeat')"
argv_case "a glued redirection is dropped" " feat 2>/dev/null" "feat"
argv_case "two glued redirections are dropped" " feat >/dev/null 2>&1" "feat"
argv_case "an append redirection is dropped" " feat 2>>log" "feat"
argv_case "a SPACED redirection drops its target too" " feat > /dev/null" "feat"
argv_case "a numbered spaced redirection drops its target" " feat 2> log" "feat"
argv_case "an input redirection is dropped" " feat < in" "feat"
argv_case "a trailing & is dropped" " feat &" "feat"
argv_case "a comment ends the argv" " feat # switch lane" "feat"
argv_case "a comment ends it even mid-list" " a # b -- c" "a"
# The COMMENT rule keys on an UNQUOTED leading `#`. A quoted one is an argument
# the shell passes through, and the token still carries its quotes here.
argv_case "a QUOTED # is an argument, not a comment" " '#branch'" "'#branch'"
argv_case "a # inside a word is not a comment" " feat#1" "feat#1"
# CONTROLS: the things that look like the above and are NOT shell syntax.
argv_case "a bare -- survives" " feat -- README.md" "$(printf -- 'feat\n--\nREADME.md')"
argv_case "a digit-only word is not a redirection" " --unified 3 feat" "$(printf -- '--unified\n3\nfeat')"
argv_case "a quoted span survives whole" ' -c "wt feat new"' "$(printf -- '-c\n"wt feat new"')"
# An UNBALANCED quote cannot be split at all. Reporting it is the whole point:
# `gate_tokens` used to return the prefix it managed and rc=0, so `-b
# agent's-branch` yielded the single token `-b` and the gate read a bare
# `git checkout`.
argv_case "an unbalanced quote returns 1 and nothing" " -b agent's-branch" "" 1
argv_case "an unbalanced quote at the start returns 1" " a'unbalanced" "" 1
argv_case "empty text is not a truncation" "" "" 0
# CONTROL, not a fence: `gate_argv` feeds its loop from a HEREDOC, and a heredoc
# delimiter is matched in the SCRIPT text rather than in an expansion -- so a
# token that happens to spell the delimiter cannot end the body early. Nothing
# reddens this today; it is here so a rewrite that re-scans the value (an `eval`,
# a here-string built from it) has a case to fail.
argv_case "a token spelling the heredoc delimiter survives" " EOF -- x" "$(printf -- 'EOF\n--\nx')"


# A FLOOR on the case total. Every `for` loop above expands a LIST, and emptying
# one -- or deleting a case -- removes assertions SILENTLY while the tally still
# reads `fail: 0`. No suite in this repo had one, so the only thing standing
# between a gutted loop and a green run was somebody noticing the number move.
# Raise it when cases are added; never lower it to make a red run green.
# --- gate_word_is_literal -------------------------------------------------------
#
# The INVERTED default. `gate_argv` above splits words; this answers whether a
# word reaches the command as the text it carries, and it answers NO by default.
# Three rounds of `main-tree-branch-gate` fixes each taught the stripper one more
# shell form and each time the next round found the form still missing -- last
# `$EMPTY` (an empty expansion VANISHES, so the gate counted a positional git
# never receives) and `{fd}>/dev/null` (bash's fd-variable redirection, a word
# git never receives at all). Both turned a real branch switch into a two-
# positional file restore and PASSED.
#
# The cases below are therefore in two halves, and the SECOND half is what makes
# the first mean anything: if the inert list quietly shrank, the refusals would
# all still pass while every ordinary command started blocking.
lit_case() { # name, word, want-rc
  local name="$1" word="$2" wantrc="$3" gotrc
  gate_word_is_literal "$word"; gotrc=$?
  if [ "$gotrc" = "$wantrc" ]; then
    pass=$((pass + 1)); printf 'OK   gate_word_is_literal: %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL gate_word_is_literal: %s\n  word: [%s]\n  want rc=%s got rc=%s\n' \
      "$name" "$word" "$wantrc" "$gotrc"
  fi
}
# REFUSED -- every one of these is a word the shell may rewrite or remove.
lit_case "an unquoted \$ expansion is refused" '$EMPTY' 1
lit_case "a braced \$ expansion is refused" '${EMPTY}' 1
lit_case "a \$ inside DOUBLE quotes is still refused" '"$f"' 1
lit_case "a backtick substitution is refused" '`date`' 1
lit_case "a backslash escape is refused" 'a\b' 1
lit_case "the fd-variable redirection prefix is refused" '{fd}>/dev/null' 1
lit_case "a brace word is refused" '{a,b}' 1
lit_case "a glob star is refused" '*.ts' 1
lit_case "a glob question mark is refused" 'a?b' 1
lit_case "a bracket expression is refused" 'a[bc]' 1
lit_case "a leading tilde is refused" '~/x' 1
lit_case "a history bang is refused" 'a!b' 1
lit_case "a metacharacter that reached here is refused" 'a;b' 1
lit_case "a pipe is refused" 'a|b' 1
lit_case "a redirection character is refused" '>x' 1
lit_case "a subshell paren is refused" '(x)' 1
lit_case "a leading # is refused (it opens a comment)" '#branch' 1
lit_case "an unbalanced quote is refused" "'open" 1
lit_case "the empty word is refused" '' 1
# ADMITTED -- the other half. Each of these is an ordinary git argument, and the
# gate's ALLOW arms are unreachable without them.
lit_case "a plain name is literal" 'feat' 0
lit_case "a slashed, dotted, dashed name is literal" 'feat/x-1.2' 0
lit_case "a glued long-option value is literal" '--create=feat' 0
lit_case "a caret revision is literal" 'HEAD^' 0
lit_case "a # INSIDE a word is literal" 'has#hash' 0
lit_case "a comma is literal without a brace" 'a,b' 0
lit_case "a colon and an at-sign are literal" 'a:b@c' 0
lit_case "a plus and a percent are literal" 'a+b%c' 0
lit_case "a SINGLE-quoted \$ is literal" "'feat\$x'" 0
lit_case "a single-quoted space is literal" "'my branch'" 0
lit_case "a DOUBLE-quoted plain word is literal" '"main"' 0
lit_case "an embedded quoted span is literal" 'core.pager="less"' 0

# --- gate_strip_comment ---------------------------------------------------------
#
# The cut happens BEFORE the split, which is the whole fix: an apostrophe inside
# a comment used to be weighed as a quote, so `git checkout main # don't switch
# lanes` came back a truncation and the gate blocked a command bash calls valid
# and git answers with "Already on 'main'".
cut_case() { # name, text, want
  local name="$1" text="$2" want="$3" got
  got=$(gate_strip_comment "$text")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   gate_strip_comment: %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL gate_strip_comment: %s\n  text: [%s]\n  want: [%s]\n  got : [%s]\n' \
      "$name" "$text" "$want" "$got"
  fi
}
cut_case "a comment is cut at the word start" 'main # switch lane' 'main '
cut_case "an APOSTROPHE inside the comment does not poison it" \
  "main # don't switch lanes" 'main '
cut_case "a # mid-word is not a comment" 'feat#1' 'feat#1'
cut_case "a # inside a quoted span is not a comment" "main -- 'a#b'" "main -- 'a#b'"
# The DISCRIMINATING half of that pair: with a SPACE before it, the `#` sits at
# what would be a word start if the quotes were not tracked, so a cut here is
# exactly what dropping the quote state produces. The case above cannot see
# that -- its `#` is preceded by `a` either way.
cut_case "a # at a word start INSIDE quotes is still not a comment" \
  "main -- 'a #b' tail" "main -- 'a #b' tail"
cut_case "an escaped # is not a comment" 'main \# x' 'main \# x'
cut_case "text with no comment is unchanged" '-b feat' '-b feat'
# The SECOND PASS, the `ignore_q` trick `gate_segments_raw` already uses: the
# leading `'` never closes, so on the retry it is treated as literal and the
# comment is found. The result is still unsplittable, and `gate_argv` still
# refuses it -- correctly, since bash calls that text a syntax error.
cut_case "an unclosed quote is retried with the quote literal" \
  "'unbalanced # x" "'unbalanced "

# --- gate_argv: round 4 ---------------------------------------------------------
argv_case "a comment carrying an apostrophe no longer truncates" \
  " main # don't switch lanes" "main"
# SPACED redirection operators. Each of these drops BOTH words; dropping an
# operator from GATE_REDIR_TOKEN makes the operator itself read as an argument,
# which is the FAIL-OPEN direction (an extra positional relaxes the gate's
# verdict to "file restore").
argv_case "a spaced append redirection drops its target" " feat 2>> log" "feat"
argv_case "a spaced clobber redirection drops its target" " feat >| out" "feat"
argv_case "a spaced dup-out redirection drops its target" " feat >& out" "feat"
argv_case "a spaced dup-in redirection drops its target" " feat <& 3" "feat"
argv_case "a spaced &> redirection drops its target" " feat &> out" "feat"
argv_case "a spaced &>> redirection drops its target" " feat &>> out" "feat"

CASE_FLOOR=442
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
