#!/usr/bin/env bash
# Smoke test for branch-gate.sh's VERDICTS.
#
# Run from the repo root: `bash .claude/hooks/branch-gate.test.sh`, or via
# `vp run test:hooks`, which globs `.claude/hooks/*.test.sh`.
#
# WHY THIS FILE EXISTS AT ALL, when `gate-command-recognition.test.sh` already
# drives this hook: that suite's subject is WHICH COMMANDS reach a gate, and it
# says so in its own header ("the gates' own verdict logic is out of scope
# here"). It carries five branch-gate rows as a by-product. What it has no
# fixture for is the shape the verdict actually turns on -- a MAIN checkout that
# owns a LINKED worktree, with either one detached -- and its 297-case floor
# makes it the wrong place to grow one. The sibling repos cdkd and
# cdk-real-drift have carried a `branch-gate.test.sh` for months; this repo's
# absence was the gap, not the duplication.
#
# Why a shell script and not a vitest test: the hook IS a shell script, and the
# contract IS the stdin JSON payload plus the exit code. A TypeScript wrapper
# would test the wrapper.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/branch-gate.sh"

# Per-run scratch dir; cleaned on EXIT.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# --- BASH INTERPRETER FENCE --------------------------------------------------
# Running this SUITE under bash 3.2 does not run the HOOK under it: the hook is
# `#!/usr/bin/env bash`, which resolves through PATH and finds whatever bash is
# first there. So the interpreter is an explicit symlink at the FRONT of PATH,
# the shape `gate-command-recognition.test.sh` in this directory already uses.
# Default `/bin/bash` (macOS's 3.2);
# `HOOK_BASH=/opt/homebrew/bin/bash bash .claude/hooks/branch-gate.test.sh`
# takes the 5.x tally. An explicitly set HOOK_BASH that is not executable is
# FATAL rather than a silent fall-back: a typo'd override that quietly ran the
# default would report the version it did not run.
#
# PROVEN TO REACH THE HOOK, not merely to be exported. With `;;&` (a bash-4
# `case` terminator, a PARSE error under 3.2 and valid syntax under 5.x)
# injected into the hook's detached-HEAD arm, this suite reports
# 17 pass / 7 fail under `HOOK_BASH=/bin/bash` and 24 pass / 0 fail under
# `HOOK_BASH=/opt/homebrew/bin/bash` -- same suite, same mutant, only the
# interpreter differs. A shim that did not reach the subject would print the
# same tally twice.
#
# PATH keeps its existing entries after the shim rather than being replaced with
# `/usr/bin:/bin`: the hook needs `jq`, which is not in either on every machine.
if [ -n "${HOOK_BASH:-}" ]; then
  # RESOLVE A BARE NAME BEFORE TESTING IT. `run-tests.sh` loops over the
  # CANDIDATES `bash` and `/bin/bash` and exports `HOOK_BASH="$shell"`, so the
  # PATH shell arrives here as the bare word `bash` -- and `-x` does no PATH
  # lookup, so testing the raw value FATALs on a perfectly good interpreter.
  # Measured: the first shape of this block failed the whole suite with
  # `FATAL - HOOK_BASH is not an executable: bash` on the 5.x pass of
  # `bash .claude/hooks/run-tests.sh`, while the 3.2 pass (an absolute
  # `/bin/bash`) passed -- so half the matrix went missing and the tally said
  # FAIL rather than saying nothing, which is the only reason it was caught.
  # The `ln -sf` below needs an absolute target anyway.
  case "$HOOK_BASH" in
    */*) ;;
    *) HOOK_BASH="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")" ;;
  esac
  if [ ! -x "$HOOK_BASH" ]; then
    printf 'FATAL - HOOK_BASH is not an executable: %s\n' "$HOOK_BASH" >&2
    exit 1
  fi
else
  HOOK_BASH=/bin/bash
  [ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
  [ -n "$HOOK_BASH" ] && [ -x "$HOOK_BASH" ] || {
    printf 'FATAL - no usable bash found for the hook\n' >&2
    exit 1
  }
fi
SHIM="$TMPDIR/bin"; mkdir -p "$SHIM"
ln -sf "$HOOK_BASH" "$SHIM/bash"
printf 'hook interpreter: %s (bash %s)\n' "$HOOK_BASH" \
  "$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')"

gc() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }

# A repo on `main` and one on a feature branch, both opted in via a
# `.markgate.yml` at the repo root (the gate protects only repos that carry
# one -- cdkd#1259).
main_repo="$TMPDIR/main-repo"
feature_repo="$TMPDIR/feature-repo"
git init -q -b main "$main_repo"
gc "$main_repo" commit -q --allow-empty -m init
git init -q -b feature/x "$feature_repo"
gc "$feature_repo" commit -q --allow-empty -m init
touch "$main_repo/.markgate.yml" "$feature_repo/.markgate.yml"

# A repo WITHOUT `.markgate.yml` — a personal blog, a scratch clone — where
# committing straight to main is the normal workflow and this gate must not
# fire.
optout_repo="$TMPDIR/optout-repo"
git init -q -b main "$optout_repo"
gc "$optout_repo" commit -q --allow-empty -m init

# --- DETACHED-HEAD fixture (go-to-k/cdkd#2402) -------------------------------
# A MAIN checkout that owns a real LINKED worktree. `main_repo` above cannot
# discriminate the two halves of the detached verdict, because it has no linked
# worktree for the allowed half to live in.
mt_repo="$TMPDIR/mt-repo"
mt_wt="$TMPDIR/mt-wt"
git init -q -b main "$mt_repo"
touch "$mt_repo/.markgate.yml"
mkdir -p "$mt_repo/sub"
touch "$mt_repo/sub/f.txt"
gc "$mt_repo" add -A
gc "$mt_repo" commit -q -m init
mt_sha=$(git -C "$mt_repo" rev-parse HEAD)
gc "$mt_repo" worktree add -q "$mt_wt" -b lane/y
# The same fixture at a path containing a SPACE. `git worktree list --porcelain`
# emits one `worktree <path>` line, and reading it with awk's `$2` truncates at
# the space -- the compare then never matches and the gate stands down over a
# main checkout it mis-read. `substr($0, 10)` reads the whole field; the spaced
# cases below are what say so.
mt_spaced="$TMPDIR/mt repo spaces"
mt_spaced_wt="$TMPDIR/mt wt spaces"
git init -q -b main "$mt_spaced"
touch "$mt_spaced/.markgate.yml"
gc "$mt_spaced" commit -q --allow-empty -m init
mt_spaced_sha=$(git -C "$mt_spaced" rev-parse HEAD)
gc "$mt_spaced" worktree add -q "$mt_spaced_wt" -b lane/s

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <stdin_json>
run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local got out
  out=$(printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" 2>&1) || true
  printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name: want exit $want, got $got\n  payload: $payload\n  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- BRANCH-NAME verdicts (the behaviour that predates #2402) ----------------

run_case "non-git command always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"ls -la"}}' "$main_repo")"
run_case "git status on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$main_repo")"
run_case "git commit on a feature branch allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$feature_repo")"
run_case "git commit on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$main_repo")"
run_case "git push on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin main"}}' "$main_repo")"
# The target is where the command RUNS, not where the session sits.
run_case "git -C <main> commit from a feature cwd blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m oops"}}' "$feature_repo" "$main_repo")"
run_case "cd <feature> && git commit from a main cwd allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git commit -m wip"}}' "$main_repo" "$feature_repo")"
# Repo opt-in scope (cdkd#1259).
run_case "git commit on main in a non-opted-in repo allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m ok"}}' "$optout_repo")"
# A dir that is not inside a git repo at all: nothing to read, so nothing to
# gate. This row is the GENUINE "cannot see it" case -- kept distinct from the
# detached rows below, because the two used to be described as one thing.
run_case "non-git target dir allowed (genuinely nothing to see)" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$TMPDIR")"
run_case "empty stdin allowed" 0 ''

# --- DETACHED HEAD (go-to-k/cdkd#2402) ---------------------------------------
#
# `symbolic-ref --short HEAD` is EMPTY on a detached HEAD, so the gate's
# `case "$branch" in main|master)` matched neither arm and fell to `exit 0`.
# Measured on a scratch opted-in repo before the fix, same payload both times:
# rc=2 on `main`, rc=0 once detached -- while `main-tree-branch-gate.sh` passes
# `git checkout <sha>` in the main checkout, so the route to that state is one
# allowed command.
#
# BOTH POLARITIES ARE PINNED, because the fix has an allowed half that is easy
# to lose: a detached HEAD in a LINKED worktree is what this repo's own
# `stop-unmerged-lane-warn.sh` tells a session to do (`git switch --detach
# origin/main`) when it must not remove its worktree.

git -C "$mt_repo" checkout -q --detach "$mt_sha"

run_case "detached HEAD in the MAIN checkout: commit BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$mt_repo")"
run_case "detached HEAD in the MAIN checkout: push BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin HEAD"}}' "$mt_repo")"
# The cwd one level DOWN. The gate compares TOPLEVELS rather than the raw
# resolved dir, so a subdirectory of the main checkout is still the main
# checkout. `main_tree_of` in main-tree-branch-gate.sh compares the raw dir and
# would answer "not the main checkout" here.
run_case "detached HEAD in the MAIN checkout, cwd a SUBDIR: BLOCKED" 2 \
  "$(printf '{"cwd":"%s/sub","tool_input":{"command":"git commit -m oops"}}' "$mt_repo")"
# Reached by `-C` from a LINKED worktree cwd, so the verdict is on the RESOLVED
# tree and not on where the session happens to be sitting.
run_case "detached MAIN checkout via -C from a worktree: BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m oops"}}' "$mt_wt" "$mt_repo")"
# Polarity control at the VERB level: the new arm must not turn this gate into
# "refuse everything in a detached main checkout".
run_case "detached HEAD in the MAIN checkout: git status still allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$mt_repo")"
# The LINKED worktree, while the MAIN checkout is still detached -- so a gate
# that blocked on "some tree in this repo is detached" would fail here.
run_case "LINKED worktree on a branch, main checkout detached: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_wt")"

git -C "$mt_repo" checkout -q main

# The main checkout on a FEATURE branch, with a linked worktree present: the
# control that says the block above is about DETACHMENT and not about being the
# main checkout of a repo that has worktrees.
git -C "$mt_repo" checkout -q -b feat/z
run_case "MAIN checkout on a feature branch: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_repo")"
git -C "$mt_repo" checkout -q main
# ...and back on `main` it blocks again, by NAME, exactly as before.
run_case "MAIN checkout re-attached to main: commit BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$mt_repo")"

# The ALLOWED half: a detached HEAD in a LINKED worktree.
git -C "$mt_wt" switch -q --detach "$mt_sha"
run_case "detached HEAD in a LINKED worktree: STILL ALLOWED" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_wt")"
run_case "detached HEAD in a LINKED worktree, cwd a SUBDIR: STILL ALLOWED" 0 \
  "$(printf '{"cwd":"%s/sub","tool_input":{"command":"git commit -m wip"}}' "$mt_wt")"
run_case "detached LINKED worktree via -C from the main checkout: ALLOWED" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m wip"}}' "$mt_repo" "$mt_wt")"
git -C "$mt_wt" switch -q lane/y

# A detached MAIN checkout whose PATH CONTAINS A SPACE. Both polarities, so a
# reader can see the space is the only variable.
git -C "$mt_spaced" checkout -q --detach "$mt_spaced_sha"
run_case "detached HEAD in a SPACED main checkout: BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$mt_spaced")"
run_case "detached HEAD in a SPACED linked worktree: ALLOWED" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_spaced_wt")"
git -C "$mt_spaced" checkout -q main

# The OPT-IN still governs the new arm: a detached HEAD in a repo with no
# `.markgate.yml` is none of this gate's business.
git -C "$optout_repo" checkout -q --detach HEAD
run_case "detached HEAD in a NON-opted-in repo: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m ok"}}' "$optout_repo")"
git -C "$optout_repo" checkout -q main

# A floor, so a fixture that silently stops building cannot report an all-clear
# over a suite that ran three rows.
# Counted BEFORE the failure below is added, or the message reports a tally the
# floor did not judge.
ran=$((pass + fail))
CASE_FLOOR=24
if [ "$ran" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$ran" "$CASE_FLOOR"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
