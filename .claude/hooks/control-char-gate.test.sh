#!/usr/bin/env bash
# Behavioral test for control-char-gate.sh, driven through the REAL hook with
# real PreToolUse payloads against real throwaway git repositories. Run from the
# repo root:
#   bash .claude/hooks/control-char-gate.test.sh
#
# WHAT THIS FILE EXISTS TO PIN (go-to-k/cdk-local#576). A PreToolUse hook runs
# BEFORE the command it gates, and the gate used to scan the INDEX only. So
#
#   git add -A && git commit -F msg.txt
#
# in ONE Bash call handed the gate the tree as it was BEFORE the `git add`:
# nothing was staged for the offending file, the gate found nothing, exit 0, and
# the control byte shipped. That happened on main. The gate was registered, did
# fire, and answered "clean" -- "registration is not execution" arriving through
# COMMAND SHAPE rather than through a broken matcher, which is precisely the
# class an exit-code-only fence cannot see.
#
# So the REFUSE block below is organised by the shape of the staging, not by the
# byte: what the gate reads has to follow from the command. And the ACCEPT block
# is as long, because widening a gate that every commit passes through is how a
# fix turns into a wedge -- `git commit -a` in particular must NOT pick up an
# untracked file, since `-a` does not.
#
# HERMETICITY. Each axis is either pinned or measured-and-recorded:
#   git repo     every case gets its OWN `mktemp -d` + `git init`, populated by
#                its `setup` argument. No case reads this repository, so the
#                suite cannot pass or fail on the state of the worktree it runs
#                in -- measured by running it from the repo root with a dirty
#                tree, from /tmp, and from $HOME (not a repo at all): 52/52
#                each time.
#   cwd          pinned per case through the payload's `cwd` field: the case's
#                own repo, or (for the `git -C` cases) a directory that is NOT a
#                repo at all, so only the flag can resolve the tree.
#   env          pinned with `env -i`; only PATH, HOME and the payload reach it.
#   PATH         pinned to /usr/bin:/bin, so the gate runs against the SYSTEM
#                git / perl / jq and the system `bash`. On macOS that is bash
#                3.2, which is deliberate: the shipped hook has to work under
#                whatever bash the user has, and the pre-fix gate used
#                `mapfile -d ''` -- "command not found" there, after which it
#                exited 1 having scanned nothing.
#   $HOME        pinned to a throwaway dir, so no user dotfile and no
#                ~/.gitconfig is read; user.name / user.email are set per repo.
#   clock        not read -- no TTL, no marker store.
#
# NO LITERAL CONTROL BYTES LIVE IN THIS FILE. The offending bytes are written by
# `printf` from `\000` / `\001` escapes at run time. Spelling one literally here
# is the very defect under test, and `tests/unit/no-control-bytes.test.ts` would
# fail CI over it.

set -u

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HOOKS/control-char-gate.sh"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

PINNED_PATH=/usr/bin:/bin

# Every one of these is load-bearing, and their absence would make the suite
# pass VACUOUSLY rather than fail: without `jq` the gate reads an EMPTY command
# and every ACCEPT case is satisfied by a gate that never ran; without `git` or
# `perl` the gate fails open by design and the same thing happens. So the
# harness refuses to run rather than reporting green over nothing.
for tool in jq git perl; do
  if ! PATH="$PINNED_PATH" command -v "$tool" >/dev/null 2>&1; then
    echo "FATAL: $tool is not on the pinned PATH ($PINNED_PATH), so cases would pass vacuously." >&2
    exit 1
  fi
done

pass=0; fail=0

# mk_repo <setup>
# A fresh repository with `setup` evaluated inside it. Prints its path.
mk_repo() {
  local r
  r="$(mktemp -d "$SANDBOX/repo.XXXXXX")"
  (
    cd "$r" || exit 1
    git init -q .
    git config user.email t@example.com
    git config user.name "Gate Test"
    git config commit.gpgsign false
    eval "$1"
  ) >/dev/null 2>&1
  printf '%s' "$r"
}

# run_case <name> <want_exit> <setup> <cmd> [<want_fragment>] [repo|outside]
#
# 2 = blocked, 0 = allowed through. `{REPO}` in <cmd> is replaced with the
# case's repository path. <want_fragment> ("-" or omitted to skip) must appear
# in the gate's output: an exit code alone cannot tell "blocked on the right
# file" from "blocked on something else", which is the same lesson
# gate-command-recognition.test.sh learned by asserting what a gate ASKS its
# verifier rather than only what it answers.
run_case() {
  local name="$1" want="$2" setup="$3" cmd="$4" frag="${5:--}" where="${6:-repo}"
  local repo got out payload cwd
  repo="$(mk_repo "$setup")"
  cmd="${cmd//\{REPO\}/$repo}"
  case "$where" in
    outside) cwd="$SANDBOX" ;;
    *)       cwd="$repo" ;;
  esac
  payload=$(jq -nc --arg c "$cmd" --arg d "$cwd" \
    '{tool_name:"Bash", cwd:$d, tool_input:{command:$c}}')
  out=$(printf '%s' "$payload" | env -i PATH="$PINNED_PATH" HOME="$SANDBOX" \
    bash "$GATE" 2>&1); got=$?
  if [ "$got" != "$want" ]; then
    fail=$((fail + 1))
    printf 'FAIL %s (want exit %s, got %s)\n  cmd: %s\n  out: %s\n' \
      "$name" "$want" "$got" "$cmd" "$out"
    return
  fi
  if [ "$frag" != "-" ] && ! printf '%s' "$out" | grep -qF "$frag"; then
    fail=$((fail + 1))
    printf 'FAIL %s (exit %s as wanted, but output does not name "%s")\n  out: %s\n' \
      "$name" "$got" "$frag" "$out"
    return
  fi
  pass=$((pass + 1)); printf 'OK   %-62s %s\n' "$name" "(exit $got)"
}

# The offending files, written from escapes. `probe.ts` carries a NUL on line 1;
# `soh.ts` carries a 0x01, so the suite is not pinned to NUL alone.
NUL_FILE='printf "const a = \"x\000y\";\n" > probe.ts'
SOH_FILE='printf "const a = \"x\001y\";\n" > soh.ts'
# A committed, then locally MODIFIED, NUL file -- the only shape `git commit -a`
# actually stages.
TRACKED_NUL='echo clean > probe.ts; git add probe.ts; git commit -qm init; '"$NUL_FILE"

echo "== REFUSE: the command stages, so the WORKING TREE is in the commit ========"
# THE case that fails on the pre-fix gate. Everything else in this block is a
# spelling of it.
run_case "issue repro: add -A && commit -m"        2 "$NUL_FILE" \
  'git add -A && git commit -m x' 'probe.ts (line(s): 1)'
# The literal shape from the issue: `git commit -F <file>` is what this repo's
# commit-msg-heredoc-gate MANDATES, so it is the spelling agents actually write.
run_case "issue repro: add -A && commit -F msg"    2 "$NUL_FILE; echo msg > m.txt" \
  'git add -A && git commit -F m.txt' 'probe.ts'
run_case "a 0x01, not only NUL"                    2 "$SOH_FILE" \
  'git add -A && git commit -m x' 'soh.ts (line(s): 1)'
run_case "git add --all (long form)"               2 "$NUL_FILE" \
  'git add --all && git commit -m x' 'probe.ts'
run_case "git add . "                              2 "$NUL_FILE" \
  'git add . && git commit -m x' 'probe.ts'
run_case "git add <the file itself>"               2 "$NUL_FILE" \
  'git add probe.ts && git commit -m x' 'probe.ts'
run_case "git add <dir> containing it"             2 'mkdir -p s; printf "x\000y\n" > s/probe.ts' \
  'git add s && git commit -m x' 's/probe.ts'
run_case "quoted pathspec with a space"            2 'mkdir -p "d i r"; printf "x\000y\n" > "d i r/probe.ts"' \
  'git add "d i r" && git commit -m x' 'd i r/probe.ts'
run_case "git add -u over a TRACKED modification"  2 "$TRACKED_NUL" \
  'git add -u && git commit -m x' 'probe.ts'
run_case "separate segments: add; commit"          2 "$NUL_FILE" \
  'git add -A; git commit -m x' 'probe.ts'
run_case "multi-line add then commit"              2 "$NUL_FILE" \
  'git add -A
git commit -m x' 'probe.ts'
run_case "cd <repo> && add -A && commit"           2 "$NUL_FILE" \
  'cd {REPO} && git add -A && git commit -m x' 'probe.ts' outside
run_case "git -C <repo> add / git -C <repo> commit" 2 "$NUL_FILE" \
  'git -C {REPO} add -A && git -C {REPO} commit -m x' 'probe.ts' outside
# The add and the commit naming DIFFERENT directories: both are scanned, which
# is the deliberate broad branch.
run_case "add -C <repo>, commit -C <repo> (split)" 2 "$NUL_FILE" \
  'git -C {REPO} add -A && cd {REPO} && git commit -m x' 'probe.ts' outside
# Launcher shapes. These must behave exactly like their plain spellings, which
# is what sourcing gate_segments / gate_strip_prefix buys instead of a second
# tokenizer written here (go-to-k/cdk-local#585).
run_case "mise exec -- git add"                    2 "$NUL_FILE" \
  'mise exec -- git add -A && git commit -m x' 'probe.ts'
run_case "bash -c hosting both"                    2 "$NUL_FILE" \
  'bash -c "git add -A && git commit -m x"' 'probe.ts'
run_case "mise exec -c hosting both"               2 "$NUL_FILE" \
  'mise exec -c "git add -A && git commit -m x"' 'probe.ts'
run_case "leading env assignment"                  2 "$NUL_FILE" \
  'FOO=1 git add -A && git commit -m x' 'probe.ts'
run_case "inside a subshell"                       2 "$NUL_FILE" \
  '(git add -A && git commit -m x)' 'probe.ts'

echo
echo "== REFUSE: git commit -a stages TRACKED MODIFICATIONS ======================"
run_case "commit -am over a tracked modification"  2 "$TRACKED_NUL" \
  'git commit -am x' 'probe.ts'
run_case "commit -a -m over a tracked modification" 2 "$TRACKED_NUL" \
  'git commit -a -m x' 'probe.ts'
run_case "commit --all over a tracked modification" 2 "$TRACKED_NUL" \
  'git commit --all -m x' 'probe.ts'

echo
echo "== REFUSE: shapes the gate cannot compute, so it scans MORE ================"
# Each of these is a deliberate over-approximation: a false block costs one
# message and a re-run, a false pass is the bug this gate exists for.
run_case "git add -p (interactive: cannot compute)" 2 "$NUL_FILE" \
  'git add -p && git commit -m x' 'probe.ts'
run_case "git add -i (interactive: cannot compute)" 2 "$NUL_FILE" \
  'git add -i && git commit -m x' 'probe.ts'
run_case "--pathspec-from-file (spec is in a file)" 2 "$NUL_FILE; echo probe.ts > list" \
  'git add --pathspec-from-file=list && git commit -m x' 'probe.ts'
run_case "unexpanded pathspec (git add \$FILE)"     2 "$NUL_FILE" \
  'git add $FILE && git commit -m x' 'probe.ts'
# `git add -f` bounded by a pathspec really can stage a gitignored file, so
# --exclude-standard is dropped for exactly that shape.
run_case "git add -f over a gitignored file"       2 "$NUL_FILE; echo probe.ts > .gitignore" \
  'git add -f probe.ts && git commit -m x' 'probe.ts'

echo
echo "== REFUSE: the pre-existing INDEX scan is untouched ========================"
run_case "already staged, plain git commit"        2 "$NUL_FILE; git add -A" \
  'git commit -m x' 'probe.ts (line(s): 1)'
run_case "already staged, commit -F"               2 "$NUL_FILE; git add -A; echo m > m.txt" \
  'git commit -F m.txt' 'probe.ts'
# Staged dirty, then CLEANED in the worktree: the staged blob is what gets
# committed, so the index scan has to survive a clean working copy.
run_case "staged NUL, worktree since cleaned"      2 "$NUL_FILE; git add probe.ts; echo clean > probe.ts" \
  'git commit -m x' 'probe.ts'

echo
echo "== ACCEPT: nothing the commit will contain has a control byte =============="
# THE regression the fix must not break: no staging in the command, so the
# working tree is none of the gate's business and the index is clean.
run_case "unstaged NUL, plain commit (no add)"     0 "$NUL_FILE" \
  'git commit -m x'
# The three cases below carry a TRACKED, LOCALLY MODIFIED NUL file, not an
# untracked one, and that is the whole point of them: they exist to catch a
# false read of `--all` / `-a`, and `-a` stages tracked modifications ONLY. Over
# an untracked file a wrongly-widened `-a` still finds nothing, so the case
# would pass under the very mutation it is meant to fence -- measured, not
# assumed: with `--all` relaxed to a `--a*` prefix (so `--amend` reads as
# `--all`) and with the short-cluster walk no longer stopping at a value-taking
# flag (so `-Fa` reads as `-a`), the untracked spelling of these cases stayed
# 51/51 GREEN.
# `--amend` / `--allow-empty` / `--author` all begin `--a` and none of them
# stages anything, so the long-form match has to be exact.
run_case "commit --amend is not --all"             0 "$TRACKED_NUL" \
  'git commit --amend --no-edit'
run_case "commit --allow-empty is not --all"       0 "$TRACKED_NUL" \
  'git commit --allow-empty -m x'
# `-F` takes a value, so the `a` in `-Fa` is a message FILENAME and not `--all`.
# Reading it as `-a` would be a false widen; the cluster walk stops at `F`.
run_case "commit -Fa is -F a, not -a"              0 "$TRACKED_NUL; printf x > a" \
  'git commit -Fa'
# ...and the same cluster must still FIND the `a` when it really is a flag, so
# the stop rule cannot degrade into "never read a cluster at all". That is the
# `commit -am` case in the REFUSE block above.
# `-a` stages TRACKED modifications only. An UNTRACKED file is not one, and
# getting this wrong in either direction is a defect rather than a rounding.
run_case "commit -am over an UNTRACKED NUL file"   0 "$NUL_FILE" \
  'git commit -am x'
run_case "commit --all over an UNTRACKED NUL file" 0 "$NUL_FILE" \
  'git commit --all -m x'
# `git add -u` likewise cannot introduce an untracked file.
run_case "git add -u with the NUL file UNTRACKED"  0 "$NUL_FILE" \
  'git add -u && git commit -m x'
run_case "clean tree, add -A && commit"            0 'echo hi > a.txt' \
  'git add -A && git commit -m x'
run_case "pathspec that does not cover the file"   0 "$NUL_FILE; echo hi > b.txt" \
  'git add b.txt && git commit -m x'
run_case "gitignored NUL file, add -A"             0 "$NUL_FILE; echo probe.ts > .gitignore" \
  'git add -A && git commit -m x'
# Tab / LF / CR are legal text and must never be reported.
run_case "tab and CRLF only"                       0 'printf "a\tb\r\nc\n" > t.ts' \
  'git add -A && git commit -m x'
# A symlink's blob is the link TARGET PATH, not the pointee's bytes, so a link
# to a control-byte-bearing file adds nothing to the commit. Following it would
# report a file that is not in the commit at all -- the false-block direction.
run_case "symlink to a NUL file is not followed"   0 'printf "x\000y\n" > real.ts; ln -s real.ts link.ts; echo real.ts > .gitignore' \
  'git add -A && git commit -m x'
echo
echo "== ACCEPT: binary/asset extensions are skipped on BOTH scans ==============="
run_case "NUL in a .png, staged by the command"    0 'printf "x\000y" > i.png' \
  'git add -A && git commit -m x'
run_case "NUL in a .woff2, already staged"         0 'printf "x\000y" > f.woff2; git add -A' \
  'git commit -m x'
run_case "uppercase .PNG (case-insensitive skip)"  0 'printf "x\000y" > I.PNG' \
  'git add -A && git commit -m x'

echo
echo "== ACCEPT: not a gated command ============================================="
run_case "git push"                                0 "$NUL_FILE; git add -A" 'git push origin HEAD'
run_case "git add on its own (no commit)"          0 "$NUL_FILE" 'git add -A'
run_case "a quoted mention of the command"         0 "$NUL_FILE; git add -A" 'echo "git commit -m x"'
run_case "git commit-tree is not git commit"       0 "$NUL_FILE; git add -A" 'git commit-tree HEAD^{tree}'
run_case "empty command"                           0 "$NUL_FILE; git add -A" ''

echo
echo "== the harness itself ======================================================"
# The gate must FAIL CLOSED when the shared library is unusable, rather than
# waving every commit through. Two shapes: absent, and present-but-older -- a
# copy predating `gate_verb_args`, which is what READS `git add`'s pathspecs. On
# an older copy the staging scan would be silently absent, i.e. exactly the
# false pass go-to-k/cdk-local#576 is about, so it must not degrade to exit 0.
#
# The expected message fragment is load-bearing rather than decoration: deleting
# the library trips BOTH the readability guard and the `declare -F` guard after
# the failed source, so asserting only "exit 2 mentioning _command-match.sh"
# would be satisfied twice over and neither guard would be fenced.
fail_closed() {
  local name="$1" want="$2" mutate="$3" tmp out rc repo
  tmp="$SANDBOX/lib.$RANDOM"; mkdir -p "$tmp"
  cp "$GATE" "$tmp/"
  cp "$HOOKS/_command-match.sh" "$tmp/"
  eval "$mutate"
  repo="$(mk_repo "$NUL_FILE")"
  out=$(jq -nc --arg d "$repo" \
      '{tool_name:"Bash",cwd:$d,tool_input:{command:"git add -A && git commit -m x"}}' \
    | env -i PATH="$PINNED_PATH" HOME="$SANDBOX" bash "$tmp/control-char-gate.sh" 2>&1); rc=$?
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF "$want"; then
    pass=$((pass + 1)); printf 'OK   %-62s %s\n' "$name" "(exit $rc)"
  else
    fail=$((fail + 1)); printf 'FAIL %s must exit 2 saying "%s" (got %s)\n  out: %s\n' \
      "$name" "$want" "$rc" "$out"
  fi
}
fail_closed "library absent" "is missing or unreadable" \
  'rm -f "$tmp/_command-match.sh"'
fail_closed "library predates gate_verb_args" "gate_verb_args is undefined" \
  'perl -0pi -e "s/^gate_verb_args\(\) \{.*?^\}\n//ms" "$tmp/_command-match.sh"'

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
