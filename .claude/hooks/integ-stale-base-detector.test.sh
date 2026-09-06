#!/usr/bin/env bash
# Smoke tests for integ-stale-base-detector.sh
#
# Run from anywhere:  bash .claude/hooks/integ-stale-base-detector.test.sh
# `vp run test:hooks` globs `.claude/hooks/*.test.sh`, so this file is picked up
# with no registration step.
#
# The hook is NON-BLOCKING by design (always exit 0), so the exit code carries
# no signal at all and every assertion here is about the MESSAGE. That is the
# opposite of the blocking gates' suites, and it is the whole risk of a warn
# hook: an always-`exit 0` stub passes any suite that only checks exit codes.
#
# MUTATION-PROBED, measured 2026-09-05 against the 24 cases below under bash 3.2,
# every mutation checked to have actually applied and every one restored:
#
#   `exit 0`, printing nothing            passed  8, FAILED 14  (every warn case)
#   the ALARMING arm printed always       passed 18, FAILED  4  (every soft case)
#   the SOFT arm printed always           passed 17, FAILED  5  (every alarming
#                                                      case except the
#                                                      "how far behind" line,
#                                                      which both arms print --
#                                                      which is why the two arms
#                                                      are asserted separately)
#   `main_files` 3-dot -> 2-dot           FAILED  2  -- the NO_OVERLAP and
#                                                      LANE_ONLY soft cases: a
#                                                      2-dot diff sweeps in the
#                                                      LANE's own file and prints
#                                                      the alarming arm
#   `branch_files` 3-dot -> 2-dot         FAILED  2  -- the NO_OVERLAP and
#                                                      MAIN_ONLY soft cases, the
#                                                      mirror image
#   `scope_re` -> `.` (match anything)    FAILED  1  -- exactly the
#                                                      out-of-scope-overlap arm
#                                                      case (its sibling asserts
#                                                      the behind-count, which is
#                                                      arm-independent)
#   `^` dropped from GATE_RE_INTEG_RUN   FAILED  1  -- exactly the quoted-MENTION
#                                                      case. It took a second
#                                                      writing: the first spelling
#                                                      ended the mention at the
#                                                      closing quote, so the
#                                                      regex's own trailing
#                                                      `([[:space:]]|$)` refused
#                                                      it either way and the case
#                                                      was INERT against the
#                                                      mutation it exists for
#   `overlap=0` initialiser -> `$behind`  FAILED  3  -- exactly the three fixtures
#                                                      where one side's in-scope
#                                                      list is EMPTY, so the
#                                                      recompute below never runs:
#                                                      LANE_ONLY, MAIN_ONLY,
#                                                      OOS_OVERLAP
#
# No direction passes vacuously. Asserted, in both directions:
#   - WARNS when the branch is behind origin/main and a fixture is being run
#   - names the OVERLAP (main's in-scope advance INTERSECTED with this branch's
#     own in-scope delta) when there is one, and says the marker will probably
#     survive when there is not -- the two arms give opposite advice, so
#     conflating them would make the hook lie
#   - SILENT when up to date, when the command only READS a verify.sh, when the
#     repo never opted in, and for a non-Bash tool
#   - the scope regex still matches `.markgate.yml`'s `integ` include list

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integ-stale-base-detector.sh"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pass=0
fail=0

TMPBASE=$(mktemp -d)
trap 'rm -rf "$TMPBASE"' EXIT

# See pr-body-item-number-gate.test.sh's header for the full derivation: the
# hook's `#!/usr/bin/env bash` shebang resolves through PATH, so measuring the
# SUBJECT under 3.2 needs a shim rather than just running this file under
# /bin/bash. Defaulted rather than opt-in, because nothing sets `HOOK_BASH` in
# `vp run test:hooks`.
HOOK_BASH="${HOOK_BASH:-/bin/bash}"
[ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
if [ -n "${HOOK_BASH:-}" ]; then
  HOOK_BASH_BIN="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")"
  case "$HOOK_BASH_BIN" in /*) ;; *) HOOK_BASH_BIN="$PWD/$HOOK_BASH_BIN" ;; esac
  HOOK_BASH_SHIM="$TMPBASE/bash32-shim"
  mkdir -p "$HOOK_BASH_SHIM"
  ln -sf "$HOOK_BASH_BIN" "$HOOK_BASH_SHIM/bash"
  PATH="$HOOK_BASH_SHIM:$PATH"
  export PATH
fi
printf 'hook interpreter: %s (bash %s)\n' \
  "$(command -v bash)" "$(bash -c 'echo "$BASH_VERSION"')"

# Without `jq` the hook reads an EMPTY command and every WARN case would go
# silent, i.e. pass vacuously in the SILENT direction and fail loudly in the
# other -- refuse to run rather than report over that.
for tool in jq git; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "FATAL: $tool is required; without it cases would not measure the hook." >&2
    exit 1
  }
done

run_hook() { "$HOOK_BASH" "$HOOK"; }

# Fixture trees. Real git repos, not mocks: what the hook reads is exactly
# `git rev-list --count`, `git diff --name-only` and `git branch --show-current`,
# so a mock would test the mock.
#
#   $OVERLAP       -- main and the lane both changed the SAME in-scope file
#   $NO_OVERLAP    -- both changed in-scope files, but DIFFERENT ones
#   $LANE_ONLY     -- the lane changed an in-scope file, main advanced docs-only
#   $MAIN_ONLY     -- main changed an in-scope file, the lane changed docs only
#   $INTEG_OVERLAP -- the overlap is under `tests/integration/**`, the include's
#                     second glob
#   $OOS_OVERLAP   -- main and the lane changed the same OUT-of-scope file
#   $UPTODATE      -- HEAD == origin/main
#   $NOOPTIN       -- behind and overlapping, but no .markgate.yml
OVERLAP="$TMPBASE/overlap"
NO_OVERLAP="$TMPBASE/no-overlap"
LANE_ONLY="$TMPBASE/lane-only"
MAIN_ONLY="$TMPBASE/main-only"
INTEG_OVERLAP="$TMPBASE/integ-overlap"
OOS_OVERLAP="$TMPBASE/oos-overlap"
UPTODATE="$TMPBASE/uptodate"
NOOPTIN="$TMPBASE/no-optin"

# build_repo <dir> <optin:yes|no> <main-file|-> <lane-file|->
# Leaves refs/remotes/origin/main at the tip of `main` (with <main-file>
# changed, if given) and HEAD on branch `lane`, forked at the base commit and
# carrying <lane-file> (if given). Both files are written with DIFFERENT content
# on each side when they are the same path, which is what makes the overlap real
# rather than nominal.
build_repo() {
  local d="$1" optin="$2" main_file="$3" lane_file="$4"
  mkdir -p "$d"
  git -C "$d" init -q -b main 2>/dev/null
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  [ "$optin" = yes ] && printf 'gates: {}\n' > "$d/.markgate.yml"
  mkdir -p "$d/tests/integration/local-demo"
  printf '#!/bin/sh\n' > "$d/tests/integration/local-demo/verify.sh"
  mkdir -p "$d/src"
  printf 'base\n' > "$d/src/shared.ts"
  printf 'base\n' > "$d/base.txt"
  git -C "$d" add -A >/dev/null
  git -C "$d" commit -qm base
  git -C "$d" branch -f lane HEAD
  if [ "$main_file" != "-" ]; then
    mkdir -p "$d/$(dirname "$main_file")"
    printf 'from main\n' > "$d/$main_file"
    git -C "$d" add -A >/dev/null
    git -C "$d" commit -qm "main advance"
  fi
  git -C "$d" update-ref refs/remotes/origin/main HEAD
  git -C "$d" checkout -q lane
  if [ "$lane_file" != "-" ]; then
    mkdir -p "$d/$(dirname "$lane_file")"
    printf 'from the lane\n' > "$d/$lane_file"
    git -C "$d" add -A >/dev/null
    git -C "$d" commit -qm "lane change"
  fi
}

build_repo "$OVERLAP"       yes src/shared.ts                          src/shared.ts
build_repo "$NO_OVERLAP"    yes src/other.ts                           src/lane.ts
build_repo "$LANE_ONLY"     yes docs/only.md                           src/lane.ts
build_repo "$MAIN_ONLY"     yes src/other.ts                           docs/lane.md
build_repo "$INTEG_OVERLAP" yes tests/integration/local-demo/verify.sh tests/integration/local-demo/verify.sh
build_repo "$OOS_OVERLAP"   yes .claude/rules/hooks.md                 .claude/rules/hooks.md
build_repo "$UPTODATE"      yes -                                      -
build_repo "$NOOPTIN"       no  src/shared.ts                          src/shared.ts

RUN_CMD='bash tests/integration/local-demo/verify.sh'
# The shape `/run-integ` section 5 actually prescribes: backgrounded with the
# output REDIRECTED to a log (never piped through tee).
RUN_CMD_LOG='bash tests/integration/local-demo/verify.sh > /tmp/integ-local-demo.log 2>&1'

# warns <name> <command> <cwd> <substring stderr must carry>
warns() {
  local name="$1" command="$2" cwd="$3" needle="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | run_hook 2>&1) && rc=0 || rc=$?
  # Exit 0 is asserted too: a warn hook that ever blocked would stop an integ
  # the operator deliberately started, which is the failure mode the
  # non-blocking design exists to avoid.
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qF "$needle"; then
    printf 'OK   %-62s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s (exit %s, expected 0 carrying %s)\n' "$name" "$rc" "$needle"
    printf '%s\n' "$out" | sed 's/^/       /' | head -8
    fail=$((fail + 1))
  fi
}

# silent <name> <command> <cwd>
silent() {
  local name="$1" command="$2" cwd="$3"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | run_hook 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
    printf 'OK   %-62s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s (exit %s, expected 0 and NO output)\n' "$name" "$rc"
    printf '%s\n' "$out" | sed 's/^/       /' | head -8
    fail=$((fail + 1))
  fi
}

echo "== the ALARMING arm: main's advance overlaps this branch's own delta ======="
warns 'overlap: reports how far behind'        "$RUN_CMD" "$OVERLAP" '1 commit(s) behind origin/main'
warns 'overlap: names the overlapping count'   "$RUN_CMD" "$OVERLAP" '1 in-scope file(s) arriving with them are files THIS BRANCH also'
warns 'overlap: says rebase first'             "$RUN_CMD" "$OVERLAP" 'Rebase FIRST'
warns 'overlap: names the marker at risk'      "$RUN_CMD" "$OVERLAP" '`integ` marker'
warns 'the redirected /run-integ spelling arms it' "$RUN_CMD_LOG" "$OVERLAP" 'Rebase FIRST'
# The include's SECOND glob. Covering only `src/**` would leave every
# fixture-only branch -- the ones most likely to be running an integ -- unwarned.
warns 'overlap under tests/integration/**'     "$RUN_CMD" "$INTEG_OVERLAP" 'Rebase FIRST'

echo "== the SOFT arm: behind, but the marker will probably survive =============="
# The two arms must give OPPOSITE advice. A hook that printed the alarming arm
# unconditionally would be ignored within a week.
warns 'disjoint in-scope changes: soft arm'    "$RUN_CMD" "$NO_OVERLAP" 'None of them overlap'
warns 'disjoint in-scope changes: still reports being behind' \
  "$RUN_CMD" "$NO_OVERLAP" 'behind origin/main'
# 3-dot vs 2-dot, main's side: main advanced DOCS-only while the lane carries
# its own in-scope commit. A 2-dot `git diff HEAD..origin/main` sweeps the
# lane's own file in and prints the alarming arm for nothing.
warns "lane has its own in-scope commit: judges MAIN's advance, not the lane's" \
  "$RUN_CMD" "$LANE_ONLY" 'None of them overlap'
# 3-dot vs 2-dot, the branch's side: main changed an in-scope file the lane
# never touched. A 2-dot `git diff origin/main..HEAD` reports main's own file as
# part of the branch's delta and manufactures an overlap.
warns "main changed a file this branch never touched: soft arm" \
  "$RUN_CMD" "$MAIN_ONLY" 'None of them overlap'
# The scope filter itself: a shared edit to a file OUTSIDE `src/**` /
# `tests/integration/**` cannot stale the `integ` marker.
warns 'out-of-scope overlap does not raise the alarm' \
  "$RUN_CMD" "$OOS_OVERLAP" 'None of them overlap'
warns 'out-of-scope overlap still reports being behind' \
  "$RUN_CMD" "$OOS_OVERLAP" 'behind origin/main'

echo "== both arms point at the local rules ====================================="
warns 'alarming arm cites verify.md section 8' "$RUN_CMD" "$OVERLAP"    'verify.md section 8'
warns 'soft arm cites markgate status integ'   "$RUN_CMD" "$NO_OVERLAP" 'markgate status integ'

echo "== SILENT ================================================================="
silent 'up to date: silent'                      "$RUN_CMD" "$UPTODATE"
silent 'not opted in (no .markgate.yml): silent' "$RUN_CMD" "$NOOPTIN"
# Reading a fixture is not running one. Without this the hook fires on every
# grep of the integ tree, which is how a warn hook trains people to ignore it.
silent 'grep of a verify.sh: silent' 'grep -n cdkl tests/integration/local-demo/verify.sh' "$OVERLAP"
silent 'cat of a verify.sh after a cd: silent'   'cd x && cat tests/integration/local-demo/verify.sh' "$OVERLAP"
silent 'the AWS orphan sweep is not a fixture run' \
  'bash tests/integration/_lib/aws-orphan-sweep.sh local-demo' "$OVERLAP"
silent 'unrelated command: silent'               'git status --porcelain' "$OVERLAP"
# The two cases that fence the SEGMENT-ANCHORED recognition, which is what
# this port has and cdkd's grep-pair copy does not. A quoted MENTION of the
# invocation is the false positive that copy documents as known and accepts;
# here it must be silent, and dropping the `^` from `GATE_RE_INTEG_RUN`
# reddens exactly this case.
silent 'a quoted MENTION of the invocation: silent' \
  'echo "then run: bash tests/integration/local-demo/verify.sh in the lane"' "$OVERLAP"
silent 'git diff of a verify.sh: silent' \
  'git diff tests/integration/local-demo/verify.sh' "$OVERLAP"

# Non-Bash tool: the hook must not read tool_input.command from a Write.
nonbash_check() {
  local out rc
  out=$(jq -n '{tool_name:"Write", tool_input:{file_path:"/x/verify.sh"}, cwd:"/tmp"}' \
    | run_hook 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
    printf 'OK   %-62s\n' "non-Bash tool: silent"
    pass=$((pass + 1))
  else
    printf 'FAIL non-Bash tool: silent (exit %s, output %s)\n' "$rc" "$out"
    fail=$((fail + 1))
  fi
}
nonbash_check

echo "== the scope regex still describes the gate it warns about ================="
# The hook's `scope_re` is a hand-written ERE for `.markgate.yml`'s `integ`
# include list. A hand copy of a config is exactly what goes stale unnoticed
# (the class `tests/unit/gates/markgate-include-globs.test.ts` exists for), so
# this reads the include block back and fails when it no longer holds exactly
# the two globs the regex encodes. Deliberately an EQUALITY check: a new entry
# means the regex is now incomplete, and a removed one means it over-warns.
scope_fence() {
  local yml="$REPO_ROOT/.markgate.yml" globs
  if [ ! -r "$yml" ]; then
    printf 'FAIL .markgate.yml not readable at %s\n' "$yml"
    fail=$((fail + 1))
    return
  fi
  # The `integ:` gate block, then its `include:` list. `awk` rather than a YAML
  # parser: the hook suites run with no node/pnpm environment.
  globs=$(awk '
    /^  integ:/            { in_gate = 1; next }
    in_gate && /^  [a-z]/  { in_gate = 0 }
    in_gate && /^    include:/ { in_inc = 1; next }
    in_inc && /^    [a-z]/ { in_inc = 0 }
    in_inc && /^      - / {
      line = $0
      sub(/^      - /, "", line)
      gsub(/"/, "", line)
      print line
    }
  ' "$yml" | sort | tr '\n' ' ')
  if [ "$globs" = "src/** tests/integration/** " ]; then
    printf 'OK   %-62s\n' "scope_re matches .markgate.yml's integ include list"
    pass=$((pass + 1))
  else
    printf 'FAIL .markgate.yml integ include is now [%s]; re-derive scope_re in %s\n' \
      "$globs" "$(basename "$HOOK")"
    fail=$((fail + 1))
  fi
}
scope_fence

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
