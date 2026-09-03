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
# 18 pass / 16 fail under `HOOK_BASH=/bin/bash` and 34 pass / 0 fail under
# `HOOK_BASH=/opt/homebrew/bin/bash` -- same suite, same mutant, only the
# interpreter differs. A shim that did not reach the subject would print the
# same tally twice.
#
# PATH keeps its existing entries after the shim rather than being replaced with
# `/usr/bin:/bin`: the hook needs `jq`, which is not in either on every machine.
if [ -n "${HOOK_BASH:-}" ]; then
  # RESOLVE A BARE NAME BEFORE TESTING IT. `-x` does no PATH lookup, so testing
  # the raw value FATALs on a perfectly good interpreter whenever HOOK_BASH is a
  # bare word rather than a path -- and `HOOK_BASH=bash` is the obvious spelling
  # for "whatever PATH gives", which is the shape the header above invites.
  #
  # THE JUSTIFICATION THAT USED TO STAND HERE NAMED A FILE THIS REPO DOES NOT
  # HAVE. It said `run-tests.sh` loops over the candidates and exports
  # `HOOK_BASH="$shell"`; that is true of CDKD's `.claude/hooks/run-tests.sh`,
  # which is where this guard was first needed and where it was measured (the
  # first shape of this block failed the whole 5.x pass with
  # `FATAL - HOOK_BASH is not an executable: bash` while the 3.2 pass, an
  # absolute `/bin/bash`, sailed through -- half the matrix gone, reported as a
  # FAIL rather than as silence, which is the only reason it was caught).
  #
  # In THIS repo the runner is `vp run test:hooks` (vite.config.ts), a plain
  # `for t in .claude/hooks/*.test.sh ...; do bash "$t"; done` under ONE shell
  # that exports no HOOK_BASH. Nothing here hands this file a bare word on its
  # own, so the guard covers the documented MANUAL invocation instead and the
  # comment now says which. The `ln -sf` below needs an absolute target anyway.
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

# run_case_msg <name> <expect_exit> <stdin_json> <substring that MUST appear> \
#              [<substring that must NOT appear>] [<a second one>]
#
# BOTH REMEDY ARMS EXIT 2, so an rc-only case cannot tell the operation-specific
# wording from the plain one -- and the whole point of the operation-specific arm
# is that the plain one names a command git refuses. The verdict under test here
# is the TEXT, so the text is what is asserted.
#
# The forbidden needle for an operation row is `Re-attach first`, the literal
# opening of the fallback remedy LINE, and not the string `switch main`: the
# operation arms mention `switch main` themselves, in the sentence explaining why
# it is unavailable. A needle that also matches prose about the wrong answer
# cannot say whether the wrong answer was PRINTED.
#
# `grep -F --` because several needles start with a `-`.
run_case_msg() {
  local name="$1"; local want="$2"; local payload="$3"; local need="$4"
  local forbid="${5:-}"; local forbid2="${6:-}"
  local out got ok=1 why="" __f
  out=$(printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" 2>&1)
  printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" != "$want" ]; then ok=0; why="want exit $want, got $got"; fi
  if [ -n "$need" ] && ! printf '%s\n' "$out" | grep -qF -- "$need"; then
    ok=0; why="${why:+$why; }message lacks: $need"
  fi
  for __f in "$forbid" "$forbid2"; do
    if [ -n "$__f" ] && printf '%s\n' "$out" | grep -qF -- "$__f"; then
      ok=0; why="${why:+$why; }message must not contain: $__f"
    fi
  done
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name: $why\n  payload: $payload\n  output : $out\n"
    printf 'FAIL %s (%s)\n' "$name" "$why"
  fi
}

# run_case_head <name> <repo> <stdin_json> <remedy substring> <expected HEAD> \
#               <claim substring> [<substring that must NOT appear>]
#
# ASSERTS THE RESULTING HEAD, the observable the previous round did not take. That
# round verified every printed remedy EXITS 0 -- all nine do -- and the message
# then promised `--abort` would "re-attach", which is true for exactly one of the
# six operations. An exit status cannot see that; HEAD can.
#
# So this helper closes the loop rather than reading the message twice. It drives
# the hook, requires the sentence the message CLAIMS about HEAD, then EXTRACTS the
# printed remedy line verbatim (trailing `# comment` stripped), EVALS it, and
# compares the tree's actual HEAD against <expected HEAD>. Two independent things
# must agree with the measurement -- what git does, and what the message said git
# would do -- so a wrong remedy and a wrong promise each turn a row red alone.
#
# Running the line verbatim also proves it is COPY-PASTEABLE: the fixture path is
# a `/private/var` symlink target and the quoting is the hook's own.
#
# <expected HEAD> is the literal `branch <name>` or the literal `DETACHED`.
run_case_head() {
  local name="$1"; local repo="$2"; local payload="$3"; local need="$4"
  local want_head="$5"; local claim="$6"; local forbid="${7:-}"
  local out got line rc got_head ok=1 why=""
  out=$(printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" 2>&1)
  printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" != 2 ]; then ok=0; why="want exit 2, got $got"; fi
  if ! printf '%s\n' "$out" | grep -qF -- "$need"; then
    ok=0; why="${why:+$why; }message lacks the remedy: $need"
  fi
  if ! printf '%s\n' "$out" | grep -qF -- "$claim"; then
    ok=0; why="${why:+$why; }message lacks the HEAD claim: $claim"
  fi
  if [ -n "$forbid" ] && printf '%s\n' "$out" | grep -qF -- "$forbid"; then
    ok=0; why="${why:+$why; }message must not contain: $forbid"
  fi
  line=$(printf '%s\n' "$out" | grep -F -- "$need" | head -1)
  line="${line%%#*}"
  if [ -z "$line" ]; then
    ok=0; why="${why:+$why; }no remedy line to run"
  else
    eval "$line" >/dev/null 2>&1
    rc=$?
    if [ "$rc" != 0 ]; then ok=0; why="${why:+$why; }the printed remedy exited $rc"; fi
  fi
  got_head=$(git -C "$repo" symbolic-ref --short HEAD 2>/dev/null || echo "")
  if [ -n "$got_head" ]; then got_head="branch $got_head"; else got_head="DETACHED"; fi
  if [ "$got_head" != "$want_head" ]; then
    ok=0; why="${why:+$why; }HEAD after the remedy is '$got_head', want '$want_head'"
  fi
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (HEAD after remedy: %s)\n' "$name" "$got_head"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name: $why\n  payload: $payload\n  output : $out\n"
    printf 'FAIL %s (%s)\n' "$name" "$why"
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
# The payload cwd reached through an EXPLICIT SYMLINK to the main checkout, which
# is the fence for reason (ii) in the hook's toplevel-compare comment: the cwd
# carries whatever symlink the caller typed, the porcelain path does not.
#
# WHY IT NEEDS ITS OWN ROW even though the four rows above already die under the
# `$target_dir` mutation. They die for reason (ii) only because macOS's
# `mktemp -d` hands back a `/var` path git reports as `/private/var`, so the whole
# fixture is symlinked for free. Rebuild the same fixture on a NON-symlinked root
# and that mutation kills exactly one of the five -- the subdir row, for reason
# (i). `ci.yml` runs this suite via `vp run test:hooks` on `ubuntu-latest`, where
# `mktemp -d` returns a real `/tmp/...` path, so reason (ii) had NO coverage on
# the platform CI actually runs. This row dies on both roots.
ln -sfn "$mt_repo" "$TMPDIR/mt-link"
run_case "detached MAIN checkout via a SYMLINKED cwd: BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$TMPDIR/mt-link")"
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

# --- THE REMEDY MUST BE A COMMAND GIT ACCEPTS (go-to-k/cdkd#2402 review) ------
#
# The arm above blocks correctly and, before this round, printed
# `git -C <main> switch main` unconditionally. A conflicted rebase is one of the
# ways a MAIN checkout reaches a detached HEAD -- and `git pull` on `main` in the
# main checkout is this repo's own mandated post-merge sync, so the route is a
# documented one. Measured on git 2.53, mid-rebase in the main checkout:
#
#   git commit -m resolve   ->  rc=2 (correct)
#   the remedy it printed   ->  git -C <main> switch main
#   what git answers        ->  fatal: cannot switch branch while rebasing
#
# A gate that refuses correctly and then names an impossible command is worse
# than one that does not refuse, because the reader has nowhere to go. The block
# stays; the remedy now follows the operation.
#
# EVERY REMEDY BELOW WAS RUN, not just read: each `--abort` / `bisect reset` the
# gate printed was executed verbatim against the fixture and exited 0 (rebase,
# rebase -i, rebase --apply, am, cherry-pick, merge, revert, bisect).
#
# WHAT EACH ROW HOLDS DOWN, measured by mutating the hook and re-running this
# suite. TWO numbers per mutation, `<in this block> / <whole suite>`, because
# the resulting-HEAD block below shares these rows' subject and dies with them
# (cdkd numbers; the siblings differ only in the pre-existing case count):
#
#   never detect an operation                -> 7 / 15 (the six op rows + bisect)
#   report every operation as a `rebase`     -> 5 / 10 (am, cherry-pick, merge, revert, bisect)
#   drop the `applying` sentinel             -> 1 / 2  (am, and only am)
#   `<target_dir>/.git` for the git dir      -> 1 / 1  (the mid-rebase SUBDIR row)
#   always print the operation wording       -> 1 / 1  (the NOTHING-in-progress row)
#
# The one row below with no mutation against it is labelled a CONTROL where it
# stands, rather than left looking like a fence.
op_repo="$TMPDIR/op-repo"
op_wt="$TMPDIR/op-wt"
opg() { gc "$op_repo" "$@"; }
git init -q -b main "$op_repo"
touch "$op_repo/.markgate.yml"
mkdir -p "$op_repo/sub"
touch "$op_repo/sub/f.txt"
printf 'base\n' > "$op_repo/f.txt"
opg add -A
opg commit -q -m base
opg checkout -q -b other
printf 'other\n' > "$op_repo/f.txt"
opg commit -q -am other
opg checkout -q main
# Six more commits so `git bisect` lands on something that is NOT a branch tip:
# with a two-commit history it picks an endpoint and HEAD stays ATTACHED, and the
# bisect row would then be exercising the branch-NAME arm instead of this one.
for op_i in 1 2 3 4 5 6; do
  printf 'mine%s\n' "$op_i" > "$op_repo/f.txt"
  opg commit -q -am "m$op_i"
done
op_root=$(git -C "$op_repo" rev-list --max-parents=0 HEAD)
opg worktree add -q "$op_wt" -b lane/op
opg format-patch -q -1 other -o "$TMPDIR/op-patches" >/dev/null

# 1 + 2. A conflicted rebase, from the checkout root and from a SUBDIRECTORY of
# it. The subdir row is the one that fences RESOLVING the git dir rather than
# assuming `<target_dir>/.git`: there, `$target_dir` is `<main>/sub`, which has
# no `.git` of its own.
opg rebase other >/dev/null 2>&1
run_case_msg "detached MAIN mid-REBASE: remedy is 'rebase --abort', not 'switch main'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'Re-attach first'
run_case_msg "detached MAIN mid-REBASE from a SUBDIR: remedy still 'rebase --abort'" 2 \
  "$(printf '{"cwd":"%s/sub","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'Re-attach first'
# CONTROL, not a fence: the LINKED worktree is on a branch, so it exits at the
# branch-NAME arm and never reaches any of the new code. No mutation of the
# detection turns it red -- it is here to say the new arm changed nothing on the
# path a lane actually uses while the shared checkout is mid-rebase.
run_case "LINKED worktree while the MAIN checkout is mid-rebase: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$op_wt")"
opg rebase --abort >/dev/null 2>&1

# 3. `git am`. `rebase-apply/` is shared by `git am` and `git rebase --apply`, so
# the directory alone cannot name the remedy -- the `applying` sentinel inside it
# is what does. This row pins the `am` direction; the `rebase --apply` direction
# is pinned in the resulting-HEAD block below, and it is the one that matters
# more, because it fails QUIETLY. Measured on git 2.53: `git rebase --abort`
# inside an am session is LOUD (rc=128, `fatal: It looks like 'git am' is in
# progress. Cannot rebase.`), while `git am --abort` inside a `rebase --apply`
# session exits 0 with no output and leaves HEAD DETACHED where the right remedy
# lands on `main`. An earlier version of this comment cited "No rebase in
# progress?" for the first crossing; that string is what git says when NOTHING is
# in progress, a different condition.
opg checkout -q --detach main
opg am "$TMPDIR/op-patches"/*.patch >/dev/null 2>&1
run_case_msg "detached MAIN mid-AM: remedy is 'am --abort'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'am --abort' 'Re-attach first'
opg am --abort >/dev/null 2>&1

# 4-6. cherry-pick / merge / revert. Each is reachable here only from a tree that
# was ALREADY detached (on a branch, git leaves HEAD attached and the branch-NAME
# arm catches it), and each has its own marker file, so each needs its own row or
# deleting that branch of the detection survives.
opg checkout -q --detach main
opg cherry-pick other >/dev/null 2>&1
run_case_msg "detached MAIN mid-CHERRY-PICK: remedy is 'cherry-pick --abort'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'cherry-pick --abort' 'Re-attach first'
opg cherry-pick --abort >/dev/null 2>&1

opg checkout -q --detach main
opg merge other >/dev/null 2>&1
run_case_msg "detached MAIN mid-MERGE: remedy is 'merge --abort'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'merge --abort' 'Re-attach first'
opg merge --abort >/dev/null 2>&1

opg checkout -q --detach main
opg revert --no-edit other >/dev/null 2>&1
run_case_msg "detached MAIN mid-REVERT: remedy is 'revert --abort'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'revert --abort' 'Re-attach first'
opg revert --abort >/dev/null 2>&1

# 7. bisect, the one operation git does NOT refuse a `switch main` during -- it
# switches with a warning and leaves the bisect running. So the old wording was
# not a dead end here, only incomplete, and the remedy has a different SHAPE
# (`bisect reset`, no `--continue` / `--abort` pair), so this row forbids BOTH
# the generic operation wording and the fallback one.
opg checkout -q main
opg bisect start >/dev/null 2>&1
opg bisect bad >/dev/null 2>&1
opg bisect good "$op_root" >/dev/null 2>&1
run_case_msg "detached MAIN mid-BISECT: remedy is 'bisect reset'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'bisect reset' '--abort' 'Re-attach first'
opg bisect reset >/dev/null 2>&1

# 8. NOTHING in progress: the fallback wording is the one that must survive, and
# it is the row that says the detection is a discriminator rather than a rewrite.
opg checkout -q --detach main
run_case_msg "detached MAIN, NOTHING in progress: remedy stays 'switch main'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$op_repo")" \
  'Re-attach first: git -C' '--abort' 'rebase --continue'
opg checkout -q main

# --- THE REMEDY'S RESULTING HEAD (go-to-k/cdkd#2402 review round 3) -----------
#
# The block above asserts the remedy TEXT, and its header recorded that every
# printed remedy had been RUN and exited 0. Both were true and the message was
# still wrong: it promised `--abort` would "abandon it and re-attach", which
# happens in exactly one of the six operations. Measured on git 2.53, each
# printed remedy run verbatim against a detached MAIN checkout, HEAD read
# afterwards -- every one rc=0:
#
#   cherry-pick --abort   before DETACHED   after DETACHED
#   revert      --abort   before DETACHED   after DETACHED
#   merge       --abort   before DETACHED   after DETACHED
#   am          --abort   before DETACHED   after DETACHED
#   rebase      --abort   before DETACHED   after main       (started FROM main)
#   rebase      --abort   before DETACHED   after DETACHED   (started detached)
#   bisect reset          before DETACHED   after main
#
# EXIT STATUS WAS THE WRONG OBSERVABLE. Nine remedies exiting 0 is exactly what
# a message that leaves the user one step short also looks like, and no row here
# asserted the right thing, which is how the wording survived the round that
# checked all nine. The rows below RUN the printed command and assert where HEAD
# lands, beside the sentence the message claims about it -- so the claim and the
# outcome are pinned to each other and cannot drift apart again.
#
# WHAT EACH ROW HOLDS DOWN, measured by mutating the hook and re-running this
# suite (cdkd numbers; the siblings differ only in the pre-existing case count):
#
#   restore `# to abandon it and re-attach`, drop the conditional -> 7 of the 8.
#     Every operation row. The BISECT row SURVIVES, and that is the honest
#     number rather than the one predicted: `bisect reset` is a separate arm
#     with its own claim, which that mutation does not touch.
#   force `reattach_to=""`, never reading `head-name`             -> 2.
#     The two rebase-started-FROM-a-branch rows, one per backend.
#   force `reattach_to="main"` whenever a rebase is in progress   -> 1.
#     The rebase-started-DETACHED row, and only it.
#   `rebase-apply` branch of the sentinel set to `am`             -> 1.
#     The `rebase --apply` row -- the branch the `am`-direction row above
#     cannot see, and the one whose wrong answer is silent.
#
# All four tallies are identical in cdk-local and cdk-real-drift (7 / 2 / 1 / 1),
# measured the same way.
#
# The fixture is `op_repo` again, left on `main` by the block above. Each row
# builds its own state; running the printed remedy IS the assertion, and the
# teardown is a separate, explicit step -- see `op_reset` immediately below for
# why it cannot be the remedy itself.

# EACH ROW TEARS DOWN EXPLICITLY rather than relying on "the printed remedy
# cleaned up". The remedy IS the assertion here, so a mutant that stops printing
# one leaves the fixture MID-OPERATION and every row after it then fails for a
# reason that is not its own. Measured before this helper existed: dropping the
# `applying` sentinel red-lined the `am` row (correctly) and then cherry-pick,
# revert, merge and bisect (cascade) -- 6 rows for a defect that touches 1. A
# tally that cannot be attributed to a row is not a fence, it is noise.
#
# It also VERIFIES that it cleaned up, because `git am` and `git rebase --apply`
# SHARE `.git/rebase-apply`: if an abort leaves that directory behind, the next
# `git am` refuses to start ("previous rebase directory ... still exists") and
# the row that follows measures the RESIDUE instead of its own operation. That
# is not hypothetical -- it is how this suite went green on git 2.53 locally and
# red on the CI runner's older git, where the printed `am --abort` exited 128
# against a rebase-apply directory no am session owned. A fixture that cannot
# assert its own precondition reports the wrong defect.
op_reset() {
  opg rebase --abort >/dev/null 2>&1
  opg am --abort >/dev/null 2>&1
  opg cherry-pick --abort >/dev/null 2>&1
  opg revert --abort >/dev/null 2>&1
  opg merge --abort >/dev/null 2>&1
  opg bisect reset >/dev/null 2>&1
  opg checkout -q --force main >/dev/null 2>&1
  # DEFENCE, not a fence: no mutation on this machine reddens the two lines
  # below, because git 2.53's own `--abort` already removes them. They exist for
  # the git the CI runner has, where it did not. Labelled rather than counted.
  rm -rf "$op_repo/.git/rebase-apply" "$op_repo/.git/rebase-merge" 2>/dev/null
  rm -f "$op_repo/.git/CHERRY_PICK_HEAD" "$op_repo/.git/REVERT_HEAD" \
        "$op_repo/.git/MERGE_HEAD" "$op_repo/.git/BISECT_LOG" 2>/dev/null
  :
}

# Assert that a row's fixture actually entered the operation it is about. Called
# right after the setup and before the hook runs, so a fixture that silently did
# not start reports ITSELF rather than blaming the hook's remedy.
op_assert_inflight() {
  local want="$1" label="$2" found=""
  [ -d "$op_repo/.git/rebase-merge" ] && found="rebase"
  [ -d "$op_repo/.git/rebase-apply" ] && {
    if [ -f "$op_repo/.git/rebase-apply/applying" ]; then found="am"; else found="rebase"; fi
  }
  [ -f "$op_repo/.git/CHERRY_PICK_HEAD" ] && found="cherry-pick"
  [ -f "$op_repo/.git/REVERT_HEAD" ] && found="revert"
  [ -f "$op_repo/.git/MERGE_HEAD" ] && found="merge"
  [ -f "$op_repo/.git/BISECT_LOG" ] && found="bisect"
  if [ "$found" != "$want" ]; then
    fail=$((fail + 1))
    printf 'FAIL %s: fixture did not enter a %s (git reports: %s)\n' \
      "$label" "$want" "${found:-nothing}" >&2
    return 1
  fi
  return 0
}

# 1. rebase (merge backend) started FROM `main`: the ONE arm where `--abort`
# really does re-attach, and the row that pins the `head-name` READ.
opg rebase other >/dev/null 2>&1
run_case_head "mid-REBASE from main: 'rebase --abort' lands on main, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'branch main' "Either ending re-attaches HEAD to 'main'" 'NEITHER ending'
op_reset

# 2. The SAME operation started while ALREADY detached. Same `in progress`, same
# printed remedy, OPPOSITE outcome -- so a blanket sentence is wrong even inside
# `rebase`, and git's own `head-name` (the literal `detached HEAD` here, against
# `refs/heads/main` above) is the only thing that tells the two apart.
opg checkout -q --detach main
opg rebase other >/dev/null 2>&1
run_case_head "mid-REBASE started DETACHED: 'rebase --abort' stays detached, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

# 3. `git rebase --apply` -- the branch of the `rebase-apply` sentinel that NO
# row reached before. Mutating it to `inflight="am"`, the inverse of the `am`
# direction the block above pins, left all three suites fully green. It is the
# direction worth a row because it fails QUIETLY: measured on git 2.53 from this
# state, `git am --abort` exits 0 with no output and leaves HEAD DETACHED, where
# `git rebase --abort` lands on `main`. The reverse crossing is loud (rc=128,
# `fatal: It looks like 'git am' is in progress. Cannot rebase.`).
opg rebase --apply other >/dev/null 2>&1
run_case_head "mid-REBASE --apply: remedy is 'rebase --abort', never 'am --abort'" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'branch main' "Either ending re-attaches HEAD to 'main'" 'am --abort'
op_reset

# 4-7. am / cherry-pick / revert / merge -- the four the old wording got wrong.
# None of them detaches HEAD itself, so this arm is reachable for them only from
# an ALREADY-detached tree, and `--abort` restores exactly that.
opg checkout -q --detach main
opg am "$TMPDIR/op-patches"/*.patch >/dev/null 2>&1
op_assert_inflight am "mid-AM fixture"
run_case_head "mid-AM: 'am --abort' leaves HEAD DETACHED, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'am --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

opg checkout -q --detach main
opg cherry-pick other >/dev/null 2>&1
op_assert_inflight cherry-pick "mid-CHERRY-PICK fixture"
run_case_head "mid-CHERRY-PICK: 'cherry-pick --abort' leaves HEAD DETACHED, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'cherry-pick --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

opg checkout -q --detach main
opg revert --no-edit other >/dev/null 2>&1
op_assert_inflight revert "mid-REVERT fixture"
run_case_head "mid-REVERT: 'revert --abort' leaves HEAD DETACHED, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'revert --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

opg checkout -q --detach main
opg merge other >/dev/null 2>&1
op_assert_inflight merge "mid-MERGE fixture"
run_case_head "mid-MERGE: 'merge --abort' leaves HEAD DETACHED, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'merge --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

# 8. bisect, whose remedy has a different SHAPE and whose message makes its own
# claim ("this restores the branch you started from"). This row turns that claim
# into a measurement, the same way the seven above do for `--abort`.
opg bisect start >/dev/null 2>&1
opg bisect bad >/dev/null 2>&1
opg bisect good "$op_root" >/dev/null 2>&1
run_case_head "mid-BISECT: 'bisect reset' lands on main, as the message says" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'bisect reset' 'branch main' 'restores the branch you started from' '--abort'
op_reset
ran=$((pass + fail))
CASE_FLOOR=42
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
