#!/usr/bin/env bash
# integ-stale-base-detector.sh — PreToolUse hook (matcher: Bash), NON-BLOCKING.
#
# Warns, before a Docker integ fixture is spent, that the branch is behind
# `origin/main` — because a rebase after the run moves the merge base and can
# stale the very `integ` marker the run was spent to earn.
#
# WHY THE WARNING IS ABOUT THE MERGE BASE AND NOT ABOUT BEING BEHIND
#
#   `.markgate.yml`'s `integ` gate is the repo's only `hash: diff` gate:
#   the digest is THIS BRANCH'S DELTA against `merge-base(origin/main, HEAD)`
#   restricted to `src/**` + `tests/integration/**`. A rebase moves that base,
#   so the delta is recomputed — and it changes for exactly one population:
#
#     an in-scope file that BOTH `main` and this branch changed.
#
#   For a file only `main` touched, the branch's delta has no entry either way,
#   which is the whole point of `hash: diff` (`.markgate.yml`: "a `main` merge /
#   rebase that moves an in-scope file this branch did NOT touch leaves the
#   marker fresh ... while a `main` change to a file this branch ALSO changed
#   still stales it"). So this hook does not merely count what `main` brought:
#   it INTERSECTS main's in-scope advance with this branch's own in-scope delta,
#   and the two arms below give opposite advice on that intersection. A hook
#   that shouted on every advance would be ignored within a week, and one that
#   counted only main's side would shout on the common case.
#
#   That intersection is why this hook is NOT a copy of go-to-k/cdkd's, whose
#   integ gates guard a hand-listed set of destroy / deploy-engine / analyzer
#   paths and which counts main's side alone. Here the scope is two globs read
#   off `.markgate.yml`, and `integ-stale-base-detector.test.sh` FAILS if that
#   include list ever changes, so the regex below cannot silently drift from the
#   gate it is describing.
#
# WHY HERE AND NOT AT `markgate set integ`
#
#   The obvious placement is next to the marker write, and it is the wrong one:
#   by then the fixture run is already spent, so the warning can only tell you
#   the money is gone. This hook fires on the fixture INVOCATION, which is the
#   last moment a rebase is still free. `/run-integ` §5 is a Docker run whose
#   first-ever pull of `public.ecr.aws/lambda/*` is ~600 MB and whose measured
#   worst case (go-to-k/cdk-local#650) was a three-hour stall, so "one more run"
#   is not a rounding error here.
#
# WHY NON-BLOCKING
#
#   A deliberate run on an old base is legitimate (bisecting a regression,
#   reproducing an issue against a released tree), and a hard refusal there
#   would cost more than the waste it prevents. This hook is a discipline aid,
#   not a safety boundary — it exits 0 always, and its only effect is text on
#   stderr. Compare `integ-gate.sh`, which DOES block: that one guards the
#   merge, where being wrong is unrecoverable.
#
# WHAT IT DOES *NOT* ESCALATE
#
#   `.claude/skills/work-issues/references/verify.md` §8 already says to run the
#   integ LAST and that "even a comment-only change to an in-scope file stales
#   the marker", and §7 of `gates-and-pr.md` says to rebase when `main` advances
#   and re-run the gates. Neither states the interaction: a REBASE, all by
#   itself, can stale a marker that was earned by a run nobody re-ran. So unlike
#   the sibling in go-to-k/cdkd (an escalation of a written-down-and-violated
#   ordering rule), this hook fills a GAP in the written rules rather than
#   enforcing one of them, and the message names the two files that come
#   closest.
#
# NOISE CONTROL
#
#   Only fires for a command that actually RUNS an integ fixture. In this repo
#   there is exactly ONE such shape — `bash tests/integration/<name>/verify.sh`
#   (`/run-integ` §5) — because every fixture ships a `verify.sh`; re-derive
#   with `for d in tests/integration/*/; do [ -f "$d/verify.sh" ] || echo "$d";
#   done`, which printed only `_lib/` on 2026-09-05. That is the one place this
#   hook is SIMPLER than cdkd's, which needs a second arm for the four broad-set
#   fixtures that have no verify.sh. If a fixture ever ships without one, this
#   arm goes silent for it: the re-derivation command above is the fence.
#
#   Recognition goes through the SHARED matcher (`_command-match.sh`), which is
#   this repo's invariant for every hook wired to the `Bash` matcher and is
#   enforced by `_command-match.test.sh`. It is also strictly better than the
#   grep pair cdkd's copy carries: `gate_matches` anchors the regex at the start
#   of each SEGMENT, so `cat .../verify.sh`, `git diff .../verify.sh` and
#   `cd x && grep -n foo .../verify.sh` cannot match at all — no read-verb
#   exclusion list is needed, and the one KNOWN false positive of the grep
#   version (a fixture path inside an arbitrary quoted string) is gone too,
#   because segments respect quoting.
#
#   `tests/integration/_lib/aws-orphan-sweep.sh` and the other `_lib` scripts
#   are deliberately NOT matched: a sweep is what brackets the run, not the
#   spend itself.

set -u

# Shared, segment-aware command matching. Sourcing it is the repo-wide
# invariant for a hook on the `Bash` matcher (`_command-match.test.sh`).
#
# Unlike every GATE here, a missing library exits 0 rather than 2. Fail-CLOSED
# is the right default for a hook whose job is to REFUSE; this one refuses
# nothing, so "fail closed" would mean blocking an integ run the operator
# deliberately started — the exact harm the non-blocking design exists to
# avoid. The cost of the open direction is one missing nudge.
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
[ -r "$_gate_lib" ] || exit 0
# shellcheck source=/dev/null
. "$_gate_lib" 2>/dev/null || exit 0
declare -F gate_matches >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool" = "Bash" ] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# The fixture-run shape, anchored per segment by `gate_matches`. `[^|;&]*`
# rather than `.*` keeps the path from running past a chained command in the
# same segment text.
GATE_RE_INTEG_RUN='^(bash|sh)[[:space:]]+[^|;&]*verify\.sh([[:space:]]|$)'
gate_matches "$cmd" "$GATE_RE_INTEG_RUN" || exit 0

cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cwd" ] || cwd=$PWD
[ -d "$cwd" ] || exit 0

# Opt-in: only in a repo that uses markgate, matching `issue-dup-check-gate.sh`'s
# convention. Without markgate there is no `hash: diff` marker to stale, so the
# warning would be noise.
top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$top" ] || exit 0
[ -f "$top/.markgate.yml" ] || exit 0

# NO `git fetch` here. A PreToolUse hook runs on every matching Bash call and
# must stay fast and side-effect-free; a fetch would add network latency to the
# critical path and mutate refs behind the user. The trade is that this reads
# the LAST-FETCHED `origin/main`, so it under-reports when the local ref is
# itself stale — under-reporting is the safe direction for a non-blocking nudge.
git -C "$cwd" rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0

behind=$(git -C "$cwd" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
case "$behind" in ''|*[!0-9]*) exit 0 ;; esac
[ "$behind" -gt 0 ] || exit 0

branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)
[ -n "$branch" ] || branch='(detached HEAD)'

# The `integ` gate's include list, as an ERE. DERIVED from `.markgate.yml`'s
# `integ:` block (`src/**` + `tests/integration/**`) and fenced against it by
# `integ-stale-base-detector.test.sh`, which re-reads that block and fails when
# it no longer holds exactly those two entries — a hand-copied scope that drifts
# from the gate is a hook describing a gate that no longer exists.
scope_re='^src/|^tests/integration/'

# BOTH sides, both three-dot, and the difference between the two spellings is
# load-bearing in each:
#   main_files   -- what MAIN brought since the merge base (`HEAD...origin/main`).
#                   Two dots would sweep in this lane's own commits and blame
#                   them on main.
#   branch_files -- what THIS BRANCH changed since the merge base
#                   (`origin/main...HEAD`), which is the population `hash: diff`
#                   actually digests.
# The intersection is what a rebase can change; see the header.
main_files=$(git -C "$cwd" diff --name-only HEAD...origin/main 2>/dev/null | grep -E "$scope_re" || true)
branch_files=$(git -C "$cwd" diff --name-only origin/main...HEAD 2>/dev/null | grep -E "$scope_re" || true)

overlap=0
if [ -n "$main_files" ] && [ -n "$branch_files" ]; then
  # `grep -Fx -f` and not a shell loop: an exact, whole-line set intersection,
  # with the file lists as data rather than as patterns.
  overlap=$(printf '%s\n' "$main_files" \
    | grep -cFx -f <(printf '%s\n' "$branch_files") 2>/dev/null || true)
fi
case "$overlap" in ''|*[!0-9]*) overlap=0 ;; esac

{
  echo "NOTE integ-stale-base-detector: '$branch' is $behind commit(s) behind origin/main."
  if [ "$overlap" -gt 0 ]; then
    echo "  $overlap in-scope file(s) arriving with them are files THIS BRANCH also"
    echo "  changed (src/** / tests/integration/**), so a rebase after this run WILL"
    echo "  recompute this branch's delta against a moved merge base and stale the"
    echo "  \`integ\` marker the run is about to earn — a second Docker fixture run."
    echo "  Rebase FIRST (git fetch origin && git rebase origin/main), then run this once."
  else
    echo "  None of them overlap this branch's own in-scope changes, so the \`integ\`"
    echo "  marker (hash: diff vs merge-base, see .markgate.yml) will probably survive"
    echo "  a rebase — but the unit suite and the built dist/ are still from an older"
    echo "  base."
  fi
  echo "  See .claude/skills/work-issues/references/verify.md section 8 and"
  echo "  gates-and-pr.md section 7; confirm afterwards with"
  echo "  \`mise exec -- markgate status integ\`."
  echo "  Deliberately running against an older base (a bisect, a repro)? Ignore this."
} >&2

exit 0
