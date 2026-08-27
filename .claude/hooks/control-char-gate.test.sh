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
# byte: what the gate reads has to follow from the command. Review of the first
# fix found three more members of the SAME family, all of them measured, none of
# them visible to the 52 cases that were green at the time:
#
#   * a PATHSPEC on `git commit` is an implicit `--only`, so
#     `git commit -m x f.ts` commits the WORKING TREE and ignores the index;
#   * `git ls-files` is CWD-scoped while `git add -A` is whole-tree, so from a
#     SUBDIRECTORY the scan missed everything outside it -- no case had ever
#     used a subdirectory cwd;
#   * an UNKNOWN `git add` flag's value was read as a pathspec, which also
#     suppressed the whole-tree fallback.
#
# A third round found four more, including a FAIL-OPEN and a 90-second HANG, in
# the `rm` parser that had been added to avoid ONE false block. That parser is
# deleted rather than fixed again: a false PASS is what shipped a control byte
# to main, a false BLOCK costs one message and a second call, and the remedy now
# lives in the error text. What replaced the enumeration habit is the STATE x
# SHAPE table near the end of this file -- both earlier rounds missed cases
# because the tests reused whichever fixture state happened to work.
#
# And the ACCEPT block is as long, because widening a gate that every commit
# passes through is how a fix turns into a wedge -- `git commit -a` in
# particular must NOT pick up an untracked file, since `-a` does not, and
# DELETING the offending file is the remediation this gate's own message asks
# for, so it cannot be refused.
#
# HERMETICITY. Each axis is either pinned or measured-and-recorded:
#   git repo     every case gets its OWN `mktemp -d` + `git init`, populated by
#                its `setup` argument. No case reads this repository, so the
#                suite cannot pass or fail on the state of the worktree it runs
#                in -- measured by running it from the repo root with a dirty
#                tree, from /tmp, and from $HOME (not a repo at all): 115/115
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

# run_case <name> <want_exit> <setup> <cmd> [<want_fragment>] [repo|outside|<subdir>]
#
# 2 = blocked, 0 = allowed through. `{REPO}` in <cmd> is replaced with the
# case's repository path. <want_fragment> ("-" or omitted to skip) must appear
# in the gate's output: an exit code alone cannot tell "blocked on the right
# file" from "blocked on something else", which is the same lesson
# gate-command-recognition.test.sh learned by asserting what a gate ASKS its
# verifier rather than only what it answers.
#
# The last argument is the payload's `cwd`: the repo root, a directory that is
# NOT a repo, or a SUBDIRECTORY of the repo. That third mode is not decoration
# -- `git ls-files` lists only what is under its CWD while `git add -A` and
# `git commit -a` are whole-tree, so a scan run in a subdirectory silently
# missed everything else in the repository. No case used a subdirectory cwd,
# which is exactly why 52 green cases did not see it.
run_case() {
  local name="$1" want="$2" setup="$3" cmd="$4" frag="${5:--}" where="${6:-repo}"
  local repo got out payload cwd
  repo="$(mk_repo "$setup")"
  cmd="${cmd//\{REPO\}/$repo}"
  case "$where" in
    outside) cwd="$SANDBOX" ;;
    repo)    cwd="$repo" ;;
    *)       cwd="$repo/$where" ;;
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

# run_count <name> <want_offender_lines> <setup> <cmd> [repo|outside|<subdir>]
# Asserts the number of "  - <file>" lines. The gate collects a file once per
# PROVENANCE (staged blob / working-tree copy) and both are scanned, so the
# REPORT has to fold them back into one line -- otherwise the ordinary
# `git add -A && git commit` over an already-staged file names it twice.
run_count() {
  local name="$1" want="$2" setup="$3" cmd="$4" where="${5:-repo}"
  local repo out got cwd
  repo="$(mk_repo "$setup")"
  cmd="${cmd//\{REPO\}/$repo}"
  case "$where" in
    outside) cwd="$SANDBOX" ;;
    repo)    cwd="$repo" ;;
    *)       cwd="$repo/$where" ;;
  esac
  out=$(jq -nc --arg c "$cmd" --arg d "$cwd" \
      '{tool_name:"Bash", cwd:$d, tool_input:{command:$c}}' \
    | env -i PATH="$PINNED_PATH" HOME="$SANDBOX" bash "$GATE" 2>&1)
  got=$(printf '%s\n' "$out" | grep -c '^  - ')
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-62s %s\n' "$name" "($got reported)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s reported line(s), got %s)\n  out: %s\n' \
      "$name" "$want" "$got" "$out"
  fi
}

# run_timed <name> <want_exit> <max_seconds> <setup> <cmd> [<want_fragment>]
# Same as run_case plus a WALL-CLOCK bound. A correctness-only suite cannot see
# a gate that answers correctly in four minutes, and that is a real failure mode
# for a PreToolUse hook: it is in the path of every commit.
run_timed() {
  local name="$1" want="$2" budget="$3" setup="$4" cmd="$5" frag="${6:--}"
  local repo got out payload started elapsed
  repo="$(mk_repo "$setup")"
  payload=$(jq -nc --arg c "$cmd" --arg d "$repo" \
    '{tool_name:"Bash", cwd:$d, tool_input:{command:$c}}')
  started=$(date +%s)
  out=$(printf '%s' "$payload" | env -i PATH="$PINNED_PATH" HOME="$SANDBOX" \
    bash "$GATE" 2>&1); got=$?
  elapsed=$(( $(date +%s) - started ))
  if [ "$got" != "$want" ]; then
    fail=$((fail + 1)); printf 'FAIL %s (want exit %s, got %s)\n  out: %s\n' "$name" "$want" "$got" "$out"
    return
  fi
  if [ "$frag" != "-" ] && ! printf '%s' "$out" | grep -qF "$frag"; then
    fail=$((fail + 1)); printf 'FAIL %s (exit %s as wanted, but output does not name "%s")\n' "$name" "$got" "$frag"
    return
  fi
  if [ "$elapsed" -gt "$budget" ]; then
    fail=$((fail + 1)); printf 'FAIL %s took %ss, budget %ss\n' "$name" "$elapsed" "$budget"
    return
  fi
  pass=$((pass + 1)); printf 'OK   %-62s %s\n' "$name" "(exit $got, ${elapsed}s <= ${budget}s)"
}

# The offending files, written from escapes. `probe.ts` carries a NUL on line 1;
# `soh.ts` carries a 0x01, so the suite is not pinned to NUL alone.
NUL_FILE='printf "const a = \"x\000y\";\n" > probe.ts'
SOH_FILE='printf "const a = \"x\001y\";\n" > soh.ts'
# A committed, then locally MODIFIED, NUL file -- the only shape `git commit -a`
# actually stages.
TRACKED_NUL='echo clean > probe.ts; git add probe.ts; git commit -qm init; '"$NUL_FILE"
# The same shape at the repo ROOT, plus a subdirectory that a case can `cd` into.
# `root.ts` is COMMITTED CLEAN, so the index is clean and only the working copy
# carries the NUL -- which is what makes an index-only scan answer "clean".
ROOT_NUL='mkdir -p sub; echo hi > sub/a.ts; echo clean > root.ts; git add -A; git commit -qm init; printf "const a = \"x\000y\";\n" > root.ts'
# NUL written and STAGED, worktree copy identical. Used by the deletion block.
STAGED_NUL="$NUL_FILE; git add probe.ts"

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
# The reported LINE NUMBERS, which every case above happens to leave at 1. The
# batch reader localises `$/` for the name list; without that the inner file
# read also splits on NUL, each file comes back as a single "line", and every
# report says line 1 -- correct-looking and useless. A mutation dropping the
# `local` stayed 115/115 green until these two cases existed.
run_case "line number beyond the first"            2 'printf "a\nb\nconst x = \"q\000r\";\nd\n" > deep.ts' \
  'git add -A && git commit -m x' 'deep.ts (line(s): 3)'
run_case "several lines, comma-joined and capped"  2 'printf "a\nx\000\ny\nz\000\nw\000\nv\000\n" > many.ts' \
  'git add -A && git commit -m x' 'many.ts (line(s): 2,4,5)'
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
echo "== REFUSE: a PATHSPEC on git commit is an implicit --only =================="
# `git commit -m x f.ts` commits the WORKING-TREE content of f.ts and IGNORES
# the index for it. The commit-argument walk used to read flags only and let
# positionals fall through, so with the index clean this shipped a NUL. Reading
# the positional means also knowing which flags take a SEPARATE value, or `-m`'s
# own message text reads as a pathspec and the real one is never reached.
run_case "commit -m x <pathspec>"                  2 "$TRACKED_NUL" \
  'git commit -m x probe.ts' 'probe.ts (line(s): 1)'
run_case "commit -o -m x <pathspec> (--only)"      2 "$TRACKED_NUL" \
  'git commit -o -m x probe.ts' 'probe.ts'
run_case "commit --only -m x <pathspec>"           2 "$TRACKED_NUL" \
  'git commit --only -m x probe.ts' 'probe.ts'
run_case "commit -i -m x <pathspec> (--include)"   2 "$TRACKED_NUL" \
  'git commit -i -m x probe.ts' 'probe.ts'
run_case "commit -m x -- <pathspec>"               2 "$TRACKED_NUL" \
  'git commit -m x -- probe.ts' 'probe.ts'
run_case "commit -F msg.txt <pathspec>"            2 "$TRACKED_NUL; echo m > m.txt" \
  'git commit -F m.txt probe.ts' 'probe.ts'
# `-o` / `-i` with no pathspec of their own: cannot be scoped, so widen. BOTH
# spellings, because they are read by DIFFERENT code -- the long form by the
# `--only|--include` case arm, the short one by the short-flag cluster walk.
# Only pinning `-o` left the long arm unfenced: a mutation deleting it kept the
# suite 89/89 green.
run_case "commit -o with no pathspec widens"       2 "$TRACKED_NUL" \
  'git commit -o -m x' 'probe.ts'
run_case "commit --only with no pathspec widens"   2 "$TRACKED_NUL" \
  'git commit --only -m x' 'probe.ts'
run_case "commit --include with no pathspec widens" 2 "$TRACKED_NUL" \
  'git commit --include -m x' 'probe.ts'
run_case "commit -i with no pathspec widens"       2 "$TRACKED_NUL" \
  'git commit -i -m x' 'probe.ts'
run_case "commit -p (interactive hunks)"           2 "$TRACKED_NUL" \
  'git commit -p -m x' 'probe.ts'
run_case "commit --interactive"                    2 "$TRACKED_NUL" \
  'git commit --interactive' 'probe.ts'

echo
echo "== REFUSE: unrestricted staging is WHOLE-TREE, not CWD-scoped =============="
# `git ls-files` lists only what is under its CWD, while `git add -A` and
# `git commit -a` have been whole-tree since git 2.0. Run from a subdirectory,
# the scan used to miss a control byte anywhere else in the repository -- the
# same fail-open class as the issue itself, and invisible to every case that
# runs at the repo root.
run_case "from a subdir: add -A, NUL at the root"  2 "$ROOT_NUL" \
  'git add -A && git commit -m x' 'root.ts (line(s): 1)' sub
run_case "from a subdir: commit -am, NUL at root"  2 "$ROOT_NUL" \
  'git commit -am x' 'root.ts' sub
run_case "from a subdir: add -u, NUL at the root"  2 "$ROOT_NUL" \
  'git add -u && git commit -m x' 'root.ts' sub
run_case "from a subdir: commit <pathspec> upward" 2 "$ROOT_NUL" \
  'git commit -m x ../root.ts' 'root.ts' sub

echo
echo "== REFUSE: git stage is git add ==========================================="
run_case "git stage -A"                            2 "$NUL_FILE" \
  'git stage -A && git commit -m x' 'probe.ts'
run_case "git stage <pathspec>"                    2 "$NUL_FILE" \
  'git stage probe.ts && git commit -m x' 'probe.ts'

echo
echo "== REFUSE: an UNKNOWN git add flag must not suppress the fallback =========="
# The unknown flag's value used to be read as a pathspec, which ALSO set
# `seen_pathspec` and so suppressed the whole-tree fallback -- a fail-open, not
# a widen. An unknown flag now drops the restriction instead.
run_case "git add --future-flag <value>"           2 "$NUL_FILE" \
  'git add --future-flag somevalue && git commit -m x' 'probe.ts'
run_case "git add -Av (unrecognised cluster)"      2 "$NUL_FILE" \
  'git add -Av && git commit -m x' 'probe.ts'

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
# working tree is none of the gate's business.
run_case "unstaged NUL, plain commit (no add)"     0 "$NUL_FILE" \
  'git commit -m x'
# The same claim over a TRACKED file, which is the sharper half: the index entry
# EXISTS and is clean, and only the copy on disk is dirty. A gate that reads
# disk-first for every candidate would block a commit that is genuinely clean.
# Provenance is what keeps these two apart -- an index candidate is read out of
# the index and never off disk, and vice versa. The mirror image of this case is
# "staged NUL, worktree since cleaned" in the REFUSE block, which must still
# block; together they pin that neither side is simply winning.
run_case "clean staged blob, dirty working copy"   0 'echo clean > probe.ts; git add probe.ts; printf "x\000y\n" > probe.ts' \
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
# A flag VALUE is not a pathspec. Each of these would otherwise be read as an
# implicit `--only` on a file that happens to share the name.
run_case "commit -m <value that looks like a path>" 0 "$TRACKED_NUL" \
  'git commit --amend -m probe.ts'
run_case "commit --file <value>"                   0 "$TRACKED_NUL; echo m > m.txt" \
  'git commit --file m.txt'
run_case "commit --author <value>"                 0 "$TRACKED_NUL" \
  'git commit --amend --author "A U Thor <a@example.com>"'
run_case "commit -uall is -u all, not -a"          0 "$TRACKED_NUL" \
  'git commit -uall --amend --no-edit'
# A pathspec-RESTRICTED scan still runs where the command does, so a subdirectory
# pathspec must NOT reach out to the rest of the repo.
run_case "from a subdir: scoped add stays scoped"  0 "$ROOT_NUL" \
  'git add a.ts && git commit -m x' - sub

echo
echo "== REFUSE: a deletion later in the SAME command line is NOT modelled ======="
# These are DELIBERATE false blocks, and the message carries the remedy.
#
# An earlier revision parsed `rm` / `git rm` out of the command so that
# `rm bad.ts && git add -A && git commit` would pass. It bought one avoided
# false block and cost: a FAIL-OPEN (`git add -A && git commit && rm x` passed,
# because segment ORDER was never modelled, and the commit really did contain
# the byte), an abbreviation bypass (`git rm --ca`, which git accepts), a
# directory-expansion miss, and a 90-second hang. The parser is gone. This gate
# exists because a false PASS shipped a control byte to main; a false BLOCK
# costs one message and a second call.
run_case "rm in the same call is still blocked"    2 "$STAGED_NUL" \
  'rm probe.ts && git add -A && git commit -m drop-it' 'probe.ts'
run_case "git rm in the same call is still blocked" 2 "$STAGED_NUL" \
  'git rm -f probe.ts && git commit -m drop-it' 'probe.ts'
# ORDER. This is the shape the parser turned into a fail-open: the commit runs
# BEFORE the cleanup, so the byte really is in it and refusing is correct.
run_case "commit THEN rm (the byte IS committed)"  2 "$STAGED_NUL" \
  'git add -A && git commit -m x && rm probe.ts' 'probe.ts'
# ...and the reverse order, pinned so the direction is visible: a `git add`
# anywhere in the call makes the working tree in scope, whether or not it runs
# before the commit. ERRS TOWARD BLOCKING, by design.
run_case "commit THEN add (order not modelled)"    2 "$NUL_FILE" \
  'git commit -m x && git add -A' 'probe.ts'
# The remedy has to be IN the message, since it is now the whole mitigation for
# the cases above.
run_case "the block names the deletion remedy"     2 "$STAGED_NUL" \
  'rm probe.ts && git add -A && git commit -m drop-it' 'stage the deletion in its own'
# And the remedy must actually WORK: once the deletion is staged, the path is a
# `D` in the index, which `--diff-filter=ACM` excludes, so there is no candidate.
run_case "remedy: deletion already staged"         0 "$STAGED_NUL; rm probe.ts; git add -A" \
  'git commit -m drop-it'
# The other half of the remedy: `rm` in an EARLIER call, deletion not yet
# staged. Here the file's absence is a fact about the TREE rather than a reading
# of the command, and the staging in this call covers it.
run_case "remedy: rm earlier, staged in this call" 0 "$STAGED_NUL; rm probe.ts" \
  'git add -A && git commit -m drop-it'

echo
echo "== one report line per FILE, whatever its provenance ======================="
# The file is BOTH a staged blob and a dirty working copy here, and both are
# scanned. Before the keys were made root-relative, an index entry keyed off the
# command's directory and a working-tree entry keyed off the repo root, so from
# a subdirectory the same file was named twice.
run_count "staged AND dirty, at the repo root"     1 "$NUL_FILE; git add probe.ts; printf \"x\000z\n\" > probe.ts" \
  'git add -A && git commit -m x'
run_count "staged AND dirty, from a subdirectory"  1 'mkdir -p sub; printf "x\000y\n" > root.ts; git add root.ts; printf "x\000z\n" > root.ts' \
  'git add -A && git commit -m x' sub
run_count "a clean commit reports nothing"         0 'echo hi > a.txt' \
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
echo "== STATE x SHAPE: every combination, spelled out =========================="
# THE LESSON FROM TWO REVIEW ROUNDS. Round 1 shipped 52 green cases with two
# live blockers; round 2 shipped 93 with four. Both times the missing cases were
# shapes nobody had enumerated, and both times the tests reused whichever
# FIXTURE STATE happened to work. Listing command shapes is only half the space:
# what the gate answers depends just as much on where the bytes are.
#
# So the two axes are crossed exhaustively here. Six states of one NUL-bearing
# file, times four command shapes, all 24 spelled out with the reasoning:
#
#            S1 commit   S2 add -A   S3 commit   S4 commit
#            -m x        && commit   -am x       -m x f.ts
#   A untracked      0        2           0           0
#   B in HEAD        0        0           0           0
#   C tracked-mod    0        2           2           2
#   D staged         2        2           2           2
#   E staged/clean   2        2*          2*          2*
#   F deleted        2        0           0           0
#
# The cells marked * are KNOWN FALSE BLOCKS and the only ones in the table: the
# index blob is dirty, the working copy is clean, and a whole-tree staging would
# overwrite the index with that clean copy. Keeping the index scan is what
# catches the file staged EARLIER and untouched since, which no `ls-files
# --modified` will ever list; that is worth one false block in a state you reach
# only by staging a control byte and then cleaning the file without re-staging.
st_A='printf "const a = \"x\000y\";\n" > f.ts'
st_B='printf "const a = \"x\000y\";\n" > f.ts; git add f.ts; git commit -qm init'
st_C='echo clean > f.ts; git add f.ts; git commit -qm init; printf "const a = \"x\000y\";\n" > f.ts'
st_D='printf "const a = \"x\000y\";\n" > f.ts; git add f.ts'
st_E='printf "const a = \"x\000y\";\n" > f.ts; git add f.ts; echo clean > f.ts'
st_F='printf "const a = \"x\000y\";\n" > f.ts; git add f.ts; rm f.ts'

# A: untracked. Only a `git add` reaches it -- `-a` never stages an untracked
# file, and a commit pathspec on one is an error in git.
run_case "A untracked  x  commit -m"               0 "$st_A" 'git commit -m x'
run_case "A untracked  x  add -A && commit"        2 "$st_A" 'git add -A && git commit -m x' 'f.ts'
run_case "A untracked  x  commit -am"              0 "$st_A" 'git commit -am x'
run_case "A untracked  x  commit -m x f.ts"        0 "$st_A" 'git commit -m x f.ts'
# B: the byte is already in HEAD. Nothing here introduces it, so nothing blocks
# -- the gate judges what THIS commit adds, not what the history holds.
run_case "B in HEAD     x  commit -m"              0 "$st_B" 'git commit -m x'
run_case "B in HEAD     x  add -A && commit"       0 "$st_B" 'git add -A && git commit -m x'
run_case "B in HEAD     x  commit -am"             0 "$st_B" 'git commit -am x'
run_case "B in HEAD     x  commit -m x f.ts"       0 "$st_B" 'git commit -m x f.ts'
# C: committed clean, dirty on disk. The index is clean, so a plain commit is
# genuinely clean; every staging shape picks the file up.
run_case "C tracked-mod x  commit -m"              0 "$st_C" 'git commit -m x'
run_case "C tracked-mod x  add -A && commit"       2 "$st_C" 'git add -A && git commit -m x' 'f.ts'
run_case "C tracked-mod x  commit -am"             2 "$st_C" 'git commit -am x' 'f.ts'
run_case "C tracked-mod x  commit -m x f.ts"       2 "$st_C" 'git commit -m x f.ts' 'f.ts'
# D: staged, worktree identical. Every shape commits the byte.
run_case "D staged       x  commit -m"             2 "$st_D" 'git commit -m x' 'f.ts'
run_case "D staged       x  add -A && commit"      2 "$st_D" 'git add -A && git commit -m x' 'f.ts'
run_case "D staged       x  commit -am"            2 "$st_D" 'git commit -am x' 'f.ts'
run_case "D staged       x  commit -m x f.ts"      2 "$st_D" 'git commit -m x f.ts' 'f.ts'
# E: staged dirty, then cleaned on disk. S1 is CORRECT (the index blob is what a
# plain commit writes). S2-S4 are the table's only false blocks.
run_case "E staged/clean x  commit -m"             2 "$st_E" 'git commit -m x' 'f.ts'
run_case "E staged/clean x  add -A && commit  (*)" 2 "$st_E" 'git add -A && git commit -m x' 'f.ts'
run_case "E staged/clean x  commit -am        (*)" 2 "$st_E" 'git commit -am x' 'f.ts'
run_case "E staged/clean x  commit -m x f.ts  (*)" 2 "$st_E" 'git commit -m x f.ts' 'f.ts'
# F: staged, then gone from disk, deletion not yet staged. S1 really does commit
# the blob. The other three stage the deletion, so the blob leaves the tree --
# and the file's ABSENCE is a fact about the tree, not a reading of the command.
run_case "F deleted      x  commit -m"             2 "$st_F" 'git commit -m x' 'f.ts'
run_case "F deleted      x  add -A && commit"      0 "$st_F" 'git add -A && git commit -m x'
run_case "F deleted      x  commit -am"            0 "$st_F" 'git commit -am x'
run_case "F deleted      x  commit -m x f.ts"      0 "$st_F" 'git commit -m x f.ts'

echo
echo "== BOUNDED TIME on a repo with a large ignored tree ========================"
# `git add -f <pathspec>` is the one shape that may scan gitignored content, and
# a pathspec of `.` drags in the entire ignored tree. Measured before the fix:
# 4,001 candidates and 25 s here (44,563 and >90 s in the reviewer's worktree),
# one `perl` fork each. A gate that wedges every commit is worse than the bug it
# prevents, so the listing is probed and the exclusion only dropped when small,
# and the working-tree scan is now ONE perl process rather than one per file.
#
# The budget is deliberately far below the pre-fix number and far above the
# post-fix one (measured 0.11 s), so it discriminates without being flaky on a
# loaded CI box.
BIG_IGNORED='echo "ignored/" > .gitignore; mkdir -p ignored; i=0; while [ $i -lt 4000 ]; do printf "padding\n" > "ignored/f$i.txt"; i=$((i + 1)); done; printf "const a = \"x\000y\";\n" > probe.ts; git add .gitignore'
run_timed "add -f . over 4000 ignored files"       2 20 "$BIG_IGNORED" \
  'git add -f . && git commit -m x' 'probe.ts'
run_timed "add -A over 4000 ignored files"         2 20 "$BIG_IGNORED" \
  'git add -A && git commit -m x' 'probe.ts'
# The cap's effect is BEHAVIOURAL, not only temporal -- which matters, because
# batching alone already makes 4,000 files fast, so a wall-clock budget cannot
# see the cap at all (measured: removing the cap kept the suite green until this
# case existed). Here 300 ignored files each carry a NUL and the cap is 200, so
# `--exclude-standard` is KEPT and exactly one file -- the unignored probe.ts --
# is reported. That is the documented narrow trade, pinned: without the cap the
# gate would report 301 files and print a 301-line error.
BIG_IGNORED_NUL='echo "ignored/" > .gitignore; mkdir -p ignored; i=0; while [ $i -lt 300 ]; do printf "q\000r\n" > "ignored/f$i.ts"; i=$((i + 1)); done; printf "const a = \"x\000y\";\n" > probe.ts; git add .gitignore'
run_count "add -f . past the cap reports only the unignored" 1 "$BIG_IGNORED_NUL" \
  'git add -f . && git commit -m x'
# ...and the narrow `-f` that CAN cheaply reach ignored content still does, so
# the cap is a bound rather than a silent removal of the capability.
run_case "add -f <one ignored file> still scans"   2 'printf "const a = \"x\000y\";\n" > ig.ts; echo ig.ts > .gitignore' \
  'git add -f ig.ts && git commit -m x' 'ig.ts'

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
