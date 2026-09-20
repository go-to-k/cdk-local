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
GM="$GATE_RE_GIT_MERGE"

want_match 0 "git merge after a fetch"        'git fetch && git merge --ff-only origin/main' "$GM"
want_match 1 "merge-base is not merge"        'git merge-base origin/main HEAD' "$GM"
want_match 1 "gh pr merge is not git merge"   'gh pr merge 1 --squash' "$GM"

# --- GATE_GH_C absorbs `-C` / `-R` / `--repo` for EVERY gh verb --------------
# An absorber that takes `-C <path>` only is a live gate bypass:
# `gh -R o/r pr merge 1 --squash` then matches nothing and walks past integ-gate.
# These pin the widened surface on every gh verb regex, since they all share the
# absorber. THE bypass cases: without the widening these match NOTHING.
want_match 0 "pr merge: -R <repo>"            'gh -R go-to-k/cdk-local pr merge 1 --squash' "$M"
want_match 0 "pr merge: --repo <repo>"        'gh --repo go-to-k/cdk-local pr merge 1 --squash' "$M"
# ALL THREE separators `gh` accepts, not just the space form. Verified against a
# real repo: `gh pr list --repo=go-to-k/cdkd`, `-R=go-to-k/cdkd` and the GLUED
# `-Rgo-to-k/cdkd` all return the same PR number. An explicit flag alternation
# fixed only the space form, so `gh --repo=o/r pr merge --squash` was still a
# bypass; GATE_FLAGS' `-[^[:space:]]+` token swallows all three whole.
want_match 0 "pr merge: --repo=<repo>"       'gh --repo=go-to-k/cdk-local pr merge 1 --squash' "$M"
want_match 0 "pr merge: -R=<repo>"           'gh -R=go-to-k/cdk-local pr merge 1 --squash' "$M"
want_match 0 "pr merge: -R<repo> glued"      'gh -Rgo-to-k/cdk-local pr merge 1 --squash' "$M"
want_match 0 "pr merge: -C=<path>"           'gh -C=/w/t pr merge 1 --squash' "$M"
# The wider token must still not let one gh verb match a DIFFERENT one, and the
# `=`/glued forms are where a too-greedy absorber would show it first.
want_match 1 "glued -R: pr create is not merge" 'gh -Rgo-to-k/cdk-local pr create --fill' "$M"
# A flag VALUE must not swallow the verb: GATE_FLAGS' optional value group could
# consume `pr`, and only backtracking saves it. Pin both directions.
want_match 0 "boolean flag before merge"      'gh --yes pr merge 1 --squash' "$M"
# The plain and `-C` spellings must keep the verdicts they already had --
# widening an absorber must not change what a verb regex means.
want_match 0 "pr merge: plain unchanged"      'gh pr merge 1 --squash' "$M"
want_match 0 "pr merge: -C unchanged"         'gh -C /w/t pr merge 1 --squash' "$M"
# ...and the absorber must not let one gh verb match a DIFFERENT gh verb, which
# is the failure mode a greedy flag run would introduce.
want_match 1 "pr merge: -R pr create is not merge" 'gh -R go-to-k/cdk-local pr create --fill' "$M"

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
# A `-C` AFTER the verb is an argument, not a flag of the verb run, so it must
# NOT steer the lookup -- the scan reads only the text the verb ERE consumed.
want_dir "/fallback" "-C after the verb is ignored" 'gh pr merge 1 --squash -C /w/t' /fallback "$M"
# Lowercase `git -c k=v` is not `-C` (the match is case-sensitive).
want_dir "/w/t" "git -c config before -C" 'git -c user.name=t -C /w/t commit -m x' /fallback "$C"
want_dir "/fallback" "git -c alone is not -C" 'git -c user.name=t commit -m x' /fallback "$C"
want_dir "/base" "-C= with an unexpanded variable falls back" 'gh -R o/r -C="$WT" pr merge 1' /base "$M"

# --- gate_target_dir must not read inside a quoted flag VALUE ---------------
# `GATE_PATH_TOKEN` is "a quoted span OR a bare run of non-space", so it split
# `core.pager="less` at the first space and read the tail `-C /evil"` as a fresh
# `-C` flag: a quoted flag value STEERED the target directory, which turned a
# refusing rc=2 into rc=0 for the gate that read it. Tokens now EMBED quoted
# spans.
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
# non-sourcing hook under `matcher: '*'` left this suite at 229/0, so a gate
# registered that way would dodge the fence silently.
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
# cwd the verdict (`gate_target_dir`).
want_dir "/w/t"  "-C through the passthrough"  'mise exec -- git -C /w/t commit -m x' /base "$C"
want_dir "/w/t"  "cd then the passthrough"     'cd /w/t && mise exec -- git commit -m x' /base "$C"
want_dir "/w/t"  "gh -C through the passthrough" 'mise exec -- gh -C /w/t pr merge 1' /base "$M"
want_dir "/base" "passthrough with no -C"      'mise exec -- git commit -m x' /base "$C"
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

# The mark must never leak into ORDINARY segments, or every gate would see it.
if gate_segments 'markgate verify a | tail' | grep -q "$GATE_PIPE_MARK"; then
  fail=$((fail + 1)); printf 'FAIL the pipe mark leaked into gate_segments output\n'
else
  pass=$((pass + 1)); printf 'OK   gate_segments is unchanged by the pipe mark\n'
fi

# --- gate_verb_args -----------------------------------------------------------
# A gate that both MATCHES on a verb ERE and then READS the verb's arguments must
# get the arguments with the flag run already consumed, or it matches one way and
# parses another. The strip is `BASH_REMATCH[0]` of the same regex that armed the
# gate rather than a locally written prefix chop, which is what makes the two
# agree by construction.

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

want_args "origin HEAD" "args after a bare push"       'git push origin HEAD' "$P"
# The `-C /w/t` is consumed by the verb ERE, so it must NOT come back as an
# argument.
want_args "origin HEAD" "leading -C is absorbed"       'git -C /w/t push origin HEAD' "$P"
want_args "origin HEAD" "glued -C separator"           'git -C=/w/t push origin HEAD' "$P"
want_args "origin HEAD" "launcher passthrough"         'mise exec -- git push origin HEAD' "$P"
want_args '"a b"'       "a quoted argument stays whole" 'git push "a b"' "$P"
# One line per matching segment, so two pushes in one call are both readable.
want_args "origin a
origin b" "two push segments"                          'git push origin a; git push origin b' "$P"
want_args ""            "no matching segment"          'git commit -m x' "$P"
want_args "-am x"       "commit args"                  'git commit -am x' "$C"

# --- a mis-closed substitution span must not HIDE the verb inside it ---------
#
# `close_paren` / `close_backtick` decide where a `$( )` or backtick span ends.
# An EARLY closer is worse than none: returning 0 falls back to the stack, which
# is benign, but a wrong index truncates the body and resumes with the enclosing
# quote still open, so the REST of the real body is parsed as quoted prose and
# the verb inside it never starts a segment.
#
# All three shapes were UNGATED before the helpers learned about quotes and
# backslashes, and every hook suite stayed green throughout -- nothing pinned a
# MIS-closed span, only balanced ones. Unbalanced parens inside quotes are
# ordinary: grep counting a paren, sed substituting one, awk -F with one.
want_match 0 'paren inside a quoted string in the body does not end the span' \
  "$(printf 'echo "$(echo %s)%s ; git commit -m x)"' "'" "'")" "$C"
want_match 0 'backslash-escaped paren does not end the span' \
  'echo "$(echo \) ; git commit -m x)"' "$C"
want_match 0 'backslash-escaped backtick does not end the span' \
  'echo "`echo \` ; git commit -m x`"' "$C"
# The control: a balanced span must still be seen, or the three above would be
# satisfied by a matcher that matches everything.
want_match 0 'a balanced substitution body is still seen' \
  'echo "$(git commit -m x)"' "$C"
# The negative twin: no verb in the body means no match, so the cases above are
# not passing because the command matches regardless of the span.
want_match 1 'a mis-closed span with NO verb in it does not match' \
  "$(printf 'echo "$(echo %s)%s ; echo done)"' "'" "'")" "$C"
CASE_FLOOR=190
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
