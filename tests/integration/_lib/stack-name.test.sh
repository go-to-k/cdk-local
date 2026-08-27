#!/usr/bin/env bash
# Smoke test for tests/integration/_lib/stack-name.sh and stack-name.ts
# (issue #582).
#
# What it pins, in the order the failure would hurt:
#
#   1. Every fixture that DEPLOYS to AWS sources the library and builds its
#      stack name through it. A new AWS-deploying fixture that hard-codes a
#      name reintroduces the exact defect this closes, and nothing else in
#      the repo would notice.
#   2. The base name in a fixture's `verify.sh` matches the base name in its
#      `bin/app.ts`, and the SCOPED names (SSM parameter paths,
#      CloudFormation export names) match between `verify.sh` and
#      `bin/*.ts` + `lib/*.ts`. Each pair is two copies of one string: if
#      they drift, `cdk deploy "${STACK}"` asks for a stack the app never
#      synthesized, or the fixture reads a parameter nothing created.
#   3. No deploying fixture leaves an account-global `cdkl` name as a BARE
#      literal -- that is the cross-lane collision itself, not a drift
#      between two spellings of it.
#   4. The suffix is stable within one worktree, differs between worktrees,
#      and every name it produces is still a legal CloudFormation stack name
#      (`[A-Za-z][A-Za-z0-9-]*`, max 128).
#   5. The TypeScript half is EXECUTED, not merely grepped, and the shell
#      half refuses to hand back an empty suffix when no hasher exists.
#
# Two properties of this file are load-bearing and easy to lose:
#
#   * The fixture-derived cases must not be able to go VACUOUS. The list is
#     derived by grepping for a deploy command, so a predicate that stops
#     matching silently deletes most of the suite while it still prints
#     `fail: 0`. Hence the population floor and the non-empty guards below.
#   * A grep-only agreement check cannot see a wrong IMPLEMENTATION. Both
#     function bodies of `stack-name.ts` were once replaceable with
#     `return base;` -- restoring the one-shared-stack defect for every
#     fixture -- with the suite still fully green. Hence section 5.
#
# Must stay green under macOS system bash 3.2 as well as modern bash: no
# `${var,,}`, no associative arrays.
#
# Run: bash tests/integration/_lib/stack-name.test.sh
set -u

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
INTEG_DIR=$(cd "${LIB_DIR}/.." && pwd)
LIB="${LIB_DIR}/stack-name.sh"
TS="${LIB_DIR}/stack-name.ts"
pass=0
fail=0

check() { # check <name> <ok:0|1> [detail]
  if [ "$2" -eq 0 ]; then
    pass=$((pass + 1))
    printf 'ok   %s\n' "$1"
  else
    fail=$((fail + 1))
    printf 'FAIL %s%s\n' "$1" "${3:+ -- $3}"
  fi
}

eq() { # eq <name> <expected> <actual>
  if [ "$2" = "$3" ]; then check "$1" 0; else check "$1" 1 "expected '$2', got '$3'"; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

# ---------------------------------------------------------------- 1 + 2
# Structural: the fixtures and the library agree.

# Which fixtures deploy to AWS. The predicate must survive an intervening
# flag: a fixture running `cdk --app "npx tsx bin/app.ts" deploy ...` is
# every bit as much a deployer as one running the bare `cdk deploy`, and a
# literal `'cdk deploy'` grep generates NO cases for it -- so the exact
# regression this file exists to catch would walk straight past it while
# the suite still reported `fail: 0`.
#
# `cdk` is matched as a WORD: without the leading boundary, `[^;&|]*`
# lets `cdkl` in a header comment such as
# `# verify.sh -- cdkl start-alb ... (no AWS deploy)` run all the way to
# the word `deploy` and pull five non-deploying fixtures in.
DEPLOY_RE='(^|[^[:alnum:]_])(cdk[^;&|]*[[:space:]]deploy|aws[[:space:]]+cloudformation[[:space:]]+(deploy|create-stack))([[:space:]]|$)'
# The floor is the count as of issue #582. It may only ever be RAISED: a
# drop means the predicate stopped matching, not that fixtures vanished.
DEPLOYING_FLOOR=12

deploying=$(grep -lE "${DEPLOY_RE}" "${INTEG_DIR}"/*/verify.sh)
deploying_count=$(printf '%s\n' "${deploying}" | grep -c '.')

if [ "${deploying_count}" -ge "${DEPLOYING_FLOOR}" ]; then
  check "the deploying-fixture population is intact (${deploying_count} >= ${DEPLOYING_FLOOR})" 0
else
  check "the deploying-fixture population is intact" 1 \
    "matched ${deploying_count} verify.sh, expected >= ${DEPLOYING_FLOOR}; the detection predicate has gone stale and most of this suite is no longer generated"
fi

# `while read` rather than `for f in ${deploying}`: an unquoted expansion
# word-splits a worktree path containing a space.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  dir=$(dirname "$f")
  name=$(basename "${dir}")

  if grep -q '_lib/stack-name.sh' "$f"; then
    check "${name}: verify.sh sources the shared library" 0
  else
    check "${name}: verify.sh sources the shared library" 1 "no source line"
  fi

  # Base stack names, from both copies. The base may be written quoted or
  # bare -- `integ_stack_name "Base"` is correct shell, and demanding the
  # bare spelling made it fail with a misleading "none found".
  sh_bases=$(grep -oE "integ_stack_name [\"']?[A-Za-z][A-Za-z0-9-]*" "$f" \
    | sed -E "s/^integ_stack_name [\"']?//" | sort -u)
  ts_bases=$(grep -ohE "integStackName\('[A-Za-z][A-Za-z0-9-]*'\)" "${dir}"/bin/*.ts \
    | sed -E "s/integStackName\('([^']*)'\)/\1/" | sort -u)
  if [ -z "${sh_bases}" ]; then
    check "${name}: verify.sh builds its stack name via integ_stack_name" 1 "none found"
  elif [ "${sh_bases}" = "${ts_bases}" ]; then
    check "${name}: verify.sh and bin/app.ts agree on the base name(s)" 0
  else
    check "${name}: verify.sh and bin/app.ts agree on the base name(s)" 1 \
      "sh=[$(echo "${sh_bases}" | tr '\n' ' ')] ts=[$(echo "${ts_bases}" | tr '\n' ' ')]"
  fi

  # SCOPED names -- SSM parameter paths and CloudFormation export names.
  # Same two-copies-of-one-string problem as the stack name, and previously
  # unguarded in both directions. Read from bin/ AND lib/: unlike the stack
  # name (always constructed in bin/app.ts), a scoped name is usually
  # declared beside the construct that owns it, in lib/.
  sh_scoped=$(grep -oE "integ_scoped_name [\"']?[/A-Za-z][A-Za-z0-9/_.-]*" "$f" \
    | sed -E "s/^integ_scoped_name [\"']?//" | sort -u)
  ts_scoped=$(cat "${dir}"/bin/*.ts "${dir}"/lib/*.ts 2>/dev/null \
    | grep -oE "integScopedName\('[^']*'\)" \
    | sed -E "s/integScopedName\('([^']*)'\)/\1/" | sort -u)
  if [ -z "${sh_scoped}" ]; then
    # Legitimate: a fixture whose scoped names live only in the CDK app
    # (nothing in verify.sh names them). The bare-literal check below is
    # what covers that case.
    check "${name}: verify.sh names no scoped name (app-side only)" 0
  else
    scoped_missing=""
    while IFS= read -r b; do
      [ -n "$b" ] || continue
      printf '%s\n' "${ts_scoped}" | grep -Fxq -- "$b" || scoped_missing="${scoped_missing} ${b}"
    done <<<"${sh_scoped}"
    if [ -z "${scoped_missing}" ]; then
      check "${name}: verify.sh and bin|lib/*.ts agree on the scoped name(s)" 0
    else
      check "${name}: verify.sh and bin|lib/*.ts agree on the scoped name(s)" 1 \
        "in verify.sh but not in the app:${scoped_missing}; app has [$(echo "${ts_scoped}" | tr '\n' ' ')]"
    fi
  fi

  # No account-global name may be a BARE literal. Drift between two
  # spellings is what the check above catches; this catches the collision
  # itself -- an SSM path or export name reverted to a plain string, which
  # every lane in the account would then create under one name.
  bare=$(grep -rnE "'/?cdkl-[A-Za-z0-9/_.-]*'" "${dir}"/bin "${dir}"/lib 2>/dev/null \
    | grep -v 'integScopedName(' || true)
  if [ -z "${bare}" ]; then
    check "${name}: no bare account-global 'cdkl-*' literal in the app" 0
  else
    check "${name}: no bare account-global 'cdkl-*' literal in the app" 1 \
      "$(echo "${bare}" | tr '\n' ' ')"
  fi
done <<<"${deploying}"

# ------------------------------------------------------------------- 3
# The derivation itself.

# shellcheck source=./stack-name.sh
source "${LIB}"

case "${INTEG_STACK_SUFFIX}" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    check "suffix is 8 lowercase hex characters" 0 ;;
  *)
    check "suffix is 8 lowercase hex characters" 1 "got '${INTEG_STACK_SUFFIX}'" ;;
esac

eq "integ_stack_name is stable within a process" \
   "$(integ_stack_name Base)" "$(integ_stack_name Base)"

# Stable across separate processes in the same tree.
a=$(env -u INTEG_STACK_SUFFIX bash -c "source '${LIB}'; printf '%s' \"\${INTEG_STACK_SUFFIX}\"")
b=$(env -u INTEG_STACK_SUFFIX bash -c "source '${LIB}'; printf '%s' \"\${INTEG_STACK_SUFFIX}\"")
eq "suffix is stable across processes in one worktree" "$a" "$b"

# Distinct across worktrees: three separate trees, each with its own copy
# of the library at the same relative path.
declare -a suffixes=()
for lane in lane-one lane-two lane-three; do
  root="${TMP}/${lane}"
  mkdir -p "${root}/tests/integration/_lib"
  cp "${LIB}" "${root}/tests/integration/_lib/stack-name.sh"
  git -C "${root}" init -q 2>/dev/null || true
  s=$(env -u INTEG_STACK_SUFFIX bash -c \
      "source '${root}/tests/integration/_lib/stack-name.sh'; printf '%s' \"\${INTEG_STACK_SUFFIX}\"")
  suffixes+=("$s")
  # And stable when re-derived from that same tree.
  s2=$(env -u INTEG_STACK_SUFFIX bash -c \
      "source '${root}/tests/integration/_lib/stack-name.sh'; printf '%s' \"\${INTEG_STACK_SUFFIX}\"")
  eq "${lane}: suffix is stable across repeated derivations" "$s" "$s2"
done
uniq_count=$(printf '%s\n' "${suffixes[@]}" "${INTEG_STACK_SUFFIX}" | sort -u | wc -l | tr -d ' ')
eq "four distinct trees produce four distinct suffixes" "4" "${uniq_count}"

# Pre-set value wins (CI pin / this test's own forcing).
forced=$(INTEG_STACK_SUFFIX=deadbeef bash -c "source '${LIB}'; integ_stack_name Base")
eq "a pre-set INTEG_STACK_SUFFIX is honored" "Base-deadbeef" "${forced}"
forced_scoped=$(INTEG_STACK_SUFFIX=deadbeef bash -c "source '${LIB}'; integ_scoped_name /cdkl-integ/p")
eq "a pre-set INTEG_STACK_SUFFIX is honored by integ_scoped_name" "/cdkl-integ/p-deadbeef" "${forced_scoped}"

# The exported variable name must NOT start with `CDK`. The aws-cdk CLI is
# yargs-based with `.env('CDK')`, so it maps every CDK-prefixed environment
# variable onto a CLI option: the earlier `CDKL_INTEG_STACK_SUFFIX` spelling
# made every `cdk deploy` / `cdk destroy` print
# `Unknown option(s): --lIntegStackSuffix. These will be ignored.`
# Noise here, but a tail that camelCases onto a REAL cdk option would change
# deploy behaviour silently.
exported=$(bash -c "source '${LIB}'; compgen -e | grep -c '^CDK' || true")
eq "the library exports no CDK-prefixed variable" "0" "${exported}"

# ...and the derivation still works when the caller's environment is clean of
# CDK-prefixed variables, which is what the fixtures actually run under.
clean=$(env -i PATH="$PATH" HOME="$HOME" bash -c "source '${LIB}'; integ_stack_name Base")
if [[ "${clean}" =~ ^Base-[0-9a-f]{8}$ ]]; then
  check "a CDK-free environment still derives an 8-hex suffix" 0
else
  check "a CDK-free environment still derives an 8-hex suffix" 1 "expected 'Base-<8hex>', got '${clean}'"
fi

# ------------------------------------------------------------------- 4
# The hasher fallback chain, including the branch that must REFUSE.
#
# `INTEG_STACK_SUFFIX="$(_integ_lane_hash ...)"` discards the function's
# exit status, so the no-hasher `return 1` used to leave the suffix EMPTY
# and hand every lane the same un-suffixed name -- the defect itself,
# restored by the error path. Both branches are driven with a stubbed PATH.

stub_path() { # stub_path <dir> <tool>...
  local dir="$1" t p
  shift
  mkdir -p "${dir}"
  for t in "$@"; do
    p=$(command -v "$t" 2>/dev/null) && ln -s "$p" "${dir}/$t" 2>/dev/null
  done
}
# `env` and `bash` are re-execed through the stubbed PATH, so they must be
# in it too. `shasum` / `sha256sum` are deliberately absent from both.
STUB_BASE_TOOLS="bash env cut awk dirname basename git sed grep"
# shellcheck disable=SC2086  # the tool list must word-split
stub_path "${TMP}/bin-cksum" ${STUB_BASE_TOOLS} cksum
# shellcheck disable=SC2086
stub_path "${TMP}/bin-nohash" ${STUB_BASE_TOOLS}

cksum_out=$(env -u INTEG_STACK_SUFFIX PATH="${TMP}/bin-cksum" \
  bash -c "source '${LIB}'; integ_stack_name Base" 2>/dev/null)
if [[ "${cksum_out}" =~ ^Base-[0-9a-f]{8}$ ]]; then
  check "the cksum fallback still yields a non-empty 8-hex suffix" 0
else
  check "the cksum fallback still yields a non-empty 8-hex suffix" 1 \
    "expected 'Base-<8hex>', got '${cksum_out}'"
fi

env -u INTEG_STACK_SUFFIX PATH="${TMP}/bin-nohash" \
  bash -c "source '${LIB}'" >/dev/null 2>&1
nohash_rc=$?
if [ "${nohash_rc}" -ne 0 ]; then
  check "with no hasher on PATH, sourcing the library FAILS" 0
else
  check "with no hasher on PATH, sourcing the library FAILS" 1 "source returned 0"
fi

nohash_out=$(env -u INTEG_STACK_SUFFIX PATH="${TMP}/bin-nohash" \
  bash -c "source '${LIB}'; integ_stack_name Base" 2>/dev/null)
if [ -z "${nohash_out}" ]; then
  check "with no hasher on PATH, no un-suffixed name is produced" 0
else
  check "with no hasher on PATH, no un-suffixed name is produced" 1 \
    "expected nothing, got '${nohash_out}' (an empty suffix is the shared-name defect)"
fi

# ------------------------------------------------------------------- 5
# The TypeScript half, EXECUTED rather than grepped.

NODE_TS_OPTS=""
ts_supported=0
if node --input-type=module -e "await import('file://${TS}');" >/dev/null 2>&1; then
  ts_supported=1
elif node --experimental-strip-types --input-type=module -e "await import('file://${TS}');" >/dev/null 2>&1; then
  ts_supported=1
  NODE_TS_OPTS="--experimental-strip-types"
fi

ts_eval() { # ts_eval <suffix|-> <js-expression over the module `m`>
  # shellcheck disable=SC2086  # NODE_TS_OPTS is "" or exactly one flag
  if [ "$1" = "-" ]; then
    env -u INTEG_STACK_SUFFIX node ${NODE_TS_OPTS} --input-type=module -e \
      "const m = await import('file://${TS}'); process.stdout.write(String($2));"
  else
    env "INTEG_STACK_SUFFIX=$1" node ${NODE_TS_OPTS} --input-type=module -e \
      "const m = await import('file://${TS}'); process.stdout.write(String($2));"
  fi
}

if [ "${ts_supported}" -eq 0 ]; then
  # NOT skipped: skipping is how this half went uncovered in the first
  # place. `.node-version` pins 24, where type stripping is native.
  for c in \
    "integStackName appends a pre-set suffix" \
    "integScopedName appends a pre-set suffix" \
    "integStackName falls back to the bare base" \
    "integScopedName falls back to the bare base" \
    "the TS and shell halves build the same name"; do
    check "${c}" 1 "node cannot run ${TS}: needs Node >= 22.6 (type stripping); .node-version pins 24"
  done
else
  eq "integStackName appends a pre-set suffix" \
     "B-deadbeef" "$(ts_eval deadbeef "m.integStackName('B')")"
  eq "integScopedName appends a pre-set suffix" \
     "/cdkl-integ/p-deadbeef" "$(ts_eval deadbeef "m.integScopedName('/cdkl-integ/p')")"
  # The documented un-suffixed fallback: a bare `cdk synth` by hand keeps
  # the historical name.
  eq "integStackName falls back to the bare base" \
     "B" "$(ts_eval - "m.integStackName('B')")"
  eq "integScopedName falls back to the bare base" \
     "/cdkl-integ/p" "$(ts_eval - "m.integScopedName('/cdkl-integ/p')")"
  # The two halves are two implementations of one rule; a fixture is
  # correct only while they agree.
  eq "the TS and shell halves build the same name" \
     "$(INTEG_STACK_SUFFIX=deadbeef bash -c "source '${LIB}'; integ_stack_name Base")" \
     "$(ts_eval deadbeef "m.integStackName('Base')")"
fi

# ------------------------------------------------------------------- 6
# Every real fixture name stays a legal CloudFormation stack name.

all_bases=$(grep -ohE "integ_stack_name [\"']?[A-Za-z][A-Za-z0-9-]*" "${INTEG_DIR}"/*/verify.sh \
  | sed -E "s/^integ_stack_name [\"']?//" | sort -u)
if [ -n "${all_bases}" ]; then
  check "the CFN-legality check has base names to check" 0
else
  # Without this the loop below iterates zero times and reports
  # `longest=0` as a pass -- a vacuous green.
  check "the CFN-legality check has base names to check" 1 \
    "no integ_stack_name call sites found under ${INTEG_DIR}/*/verify.sh"
fi
bad=""
longest=0
while IFS= read -r base; do
  [ -n "${base}" ] || continue
  full="$(integ_stack_name "${base}")"
  [ "${#full}" -gt "${longest}" ] && longest=${#full}
  [[ "${full}" =~ ^[A-Za-z][A-Za-z0-9-]*$ ]] || bad="${bad} ${full}(charset)"
  [ "${#full}" -le 128 ] || bad="${bad} ${full}(len=${#full})"
done <<<"${all_bases}"
if [ -n "${all_bases}" ] && [ -z "${bad}" ]; then
  check "every suffixed stack name is CFN-legal and <= 128 chars (longest=${longest})" 0
elif [ -z "${all_bases}" ]; then
  check "every suffixed stack name is CFN-legal and <= 128 chars" 1 "nothing to check"
else
  check "every suffixed stack name is CFN-legal and <= 128 chars" 1 "${bad}"
fi

# ---------------------------------------------------------------------------
# 6. `/run-integ`'s orphan sweep stays lane-scoped.
#
# The skill tells an agent to DELETE what these queries return, under the
# heading "never end the run with orphan AWS resources". That makes an
# unfiltered query actively harmful rather than merely noisy, and it went wrong
# twice while this change was being written: first a bare `/cdkl` prefix that
# listed every LANE's parameters, then a suffix filter with no guard, which
# degrades to `contains(Name,'-')` -- every hyphenated parameter in the ACCOUNT
# -- the moment the relative `source` fails. Nothing else in the repo reads that
# file, so a future edit could drop either half silently.
SKILL="${INTEG_DIR}/../../.claude/skills/run-integ/SKILL.md"
if [ -f "${SKILL}" ]; then
  # Assert per QUERY LINE, not over a sed range. The first version of this
  # fence extracted `/describe-parameters/,/list-exports/p`, whose range ENDS
  # on the `list-exports \` line -- before its own `--query`. Deleting the
  # exports filter (restoring the cross-lane defect, on the output whose prose
  # says it matters MORE) left the suite at 73/0.
  ssm_q=$(grep -F "Parameters[?starts_with(Name,'/cdkl')" "${SKILL}")
  exp_q=$(grep -F "Exports[?starts_with(Name,'cdkl')" "${SKILL}")

  for pair in "SSM:${ssm_q}" "exports:${exp_q}"; do
    label="${pair%%:*}"
    query="${pair#*:}"
    if [ -z "${query}" ]; then
      check "run-integ's ${label} sweep keeps the cdkl anchor" 1 "no anchored query line found"
      check "run-integ's ${label} sweep filters by the lane suffix" 1 "no anchored query line found"
      continue
    fi
    check "run-integ's ${label} sweep keeps the cdkl anchor" 0
    case "${query}" in
      *"contains(Name,'-\${INTEG_STACK_SUFFIX}')"*)
        check "run-integ's ${label} sweep filters by the lane suffix" 0 ;;
      *)
        check "run-integ's ${label} sweep filters by the lane suffix" 1 "no suffix filter in the ${label} query" ;;
    esac
  done

  # Structural, not token-presence: the guard must be a real `: "${VAR:?...}"`
  # statement at the start of a line, so prose merely MENTIONING it does not
  # satisfy the check. Both the pre-flight scan and the post-run sweep need it.
  guards=$(grep -cE '^[[:space:]]*: "\$\{INTEG_STACK_SUFFIX:\?' "${SKILL}")
  if [ "${guards}" -ge 3 ]; then
    check "run-integ aborts when the lane suffix is unresolved (${guards} guards)" 0
  else
    check "run-integ aborts when the lane suffix is unresolved" 1 \
      "expected >= 3 guard statements (pre-flight stack, post-run stack, sweeps), found ${guards}"
  fi

  # The gate on steps 4 and 7 has silently excluded a resource-owning fixture
  # TWICE: `*-from-cfn-stack` missed three, and the widened `*-from-cfn*` still
  # missed `local-invoke-assume-role`, which deploys a stack holding an IAM
  # role. Pin that the skill DERIVES the set rather than globbing it, and that
  # the fixture both globs missed is reachable by the derivation.
  case "$(grep -c 'owners=\$(grep -lE' "${SKILL}")" in
    0) check "run-integ derives the AWS fixture set instead of globbing it" 1 "no derivation command in the skill" ;;
    *) check "run-integ derives the AWS fixture set instead of globbing it" 0 ;;
  esac
  if grep -lq 'stack-name.sh' "${INTEG_DIR}/local-invoke-assume-role/verify.sh" 2>/dev/null; then
    check "the derivation reaches local-invoke-assume-role (both globs missed it)" 0
  else
    check "the derivation reaches local-invoke-assume-role (both globs missed it)" 1 \
      "it no longer sources the lane library, so the derived set would skip it"
  fi

  # The recipe no longer EMITS a verdict for the stack scans -- it prints the
  # raw `describe-stacks` result and tells the reader to judge. That is the
  # retreat after eight instances of a recipe claiming "clean" while not having
  # looked, so what the fence pins is the ABSENCE of a claim, which is a
  # property rather than a spelling.
  #
  # Counted with `grep -c` on occurrences, over non-comment lines, with
  # `[[:space:]]+` between words -- the previous line-grep version was defeated
  # by a two-space `aws  cloudformation` and by a backslash continuation, both
  # of which the recipe itself uses elsewhere.
  code=$(grep -vE '^[[:space:]]*#' "${SKILL}")

  # JOIN CONTINUATIONS FIRST. The previous two versions of this check grepped
  # LINES, and both stack scans are backslash continuations -- so a verdict
  # appended to the continuation line sits on a line with no `aws cloudformation`
  # and scored zero. Measured: appending `2>/dev/null || echo "(no orphan stack)"`
  # to the continuation, and restoring an `if/then/else` form with no `||` at
  # all, were BOTH green against the line-based check.
  joined=$(printf '%s\n' "${code}" | sed -e :a -e '/\\$/N; s/\\\n//; ta')

  # 1. The scans must EXIST. Round 7 asserted this and the retreat dropped it:
  #    deleting both blocks outright, leaving the guards and prose, was green --
  #    a recipe with no scan at all is the purest "clean without looking".
  scans=$(printf '%s\n' "${joined}" | grep -cE 'aws[[:space:]]+cloudformation[[:space:]]+describe-stacks')
  if [ "${scans}" -ge 2 ]; then
    check "run-integ still HAS both stack scans (${scans})" 0
  else
    check "run-integ still HAS both stack scans" 1 "found ${scans}, want >= 2 (pre-flight and post-run)"
  fi

  # 2. No verdict attached to a stack query, on the JOINED command.
  verdicts=$(printf '%s\n' "${joined}" \
    | grep -E 'aws[[:space:]]+cloudformation[[:space:]]+describe-stacks' \
    | grep -cE '\|\||&&')
  case "${verdicts}" in
    0) check "run-integ's stack scans emit no clean verdict of their own" 0 ;;
    *) check "run-integ's stack scans emit no clean verdict of their own" 1 \
         "${verdicts} stack query/queries carry a ||/&& verdict -- that is what produced eight false ones" ;;
  esac

  # 3. No `2>/dev/null` on a stack query: it sends the clean case and the
  #    could-not-look case into the same silence, which was instance one's
  #    mechanism. Unfenced until now, and its rationale comment was deleted
  #    along with the machinery it described.
  silenced=$(printf '%s\n' "${joined}" \
    | grep -E 'aws[[:space:]]+cloudformation[[:space:]]+describe-stacks' \
    | grep -cE '2>[[:space:]]*/dev/null')
  case "${silenced}" in
    0) check "run-integ's stack scans do not silence stderr" 0 ;;
    *) check "run-integ's stack scans do not silence stderr" 1 \
         "${silenced} stack query/queries discard stderr, which is how the clean and could-not-look cases became indistinguishable" ;;
  esac

  # No stderr phrase-matching, in either quote style.
  case "$(printf '%s\n' "${code}" | grep -cE "grep -[a-zA-Z]* *[\"']does not exist")" in
    0) check "run-integ does not classify a stack scan by matching stderr" 0 ;;
    *) check "run-integ does not classify a stack scan by matching stderr" 1 \
         "a 'does not exist' phrase match is back; it fires on credential-config errors too" ;;
  esac

  # No `--stack-status-filter`: it hid 16 of 23 statuses, `DELETE_IN_PROGRESS`
  # -- an interrupted `cdk destroy`, this sweep's own scenario -- among them.
  case "$(printf '%s\n' "${code}" | grep -c 'stack-status-filter')" in
    0) check "run-integ's stack scans do not filter by status" 0 ;;
    *) check "run-integ's stack scans do not filter by status" 1 \
         "a --stack-status-filter is back; it hides an orphan in any unlisted status" ;;
  esac

  # Both the suffix AND the resolved name are guarded. The suffix guard alone is
  # a PROXY: `stack-name.sh` documents pre-setting it in the environment, so it
  # can be satisfied while `integ_stack_name` is undefined and `STACK` empty.
  suffix_guards=$(printf '%s\n' "${code}" | grep -cE '^[[:space:]]*: "\$\{INTEG_STACK_SUFFIX:\?')
  stack_guards=$(printf '%s\n' "${code}" | grep -cE '^[[:space:]]*: "\$\{STACK:\?')
  if [ "${suffix_guards}" -ge 3 ] && [ "${stack_guards}" -ge 2 ]; then
    check "run-integ guards the suffix (${suffix_guards}) and the resolved name (${stack_guards})" 0
  else
    check "run-integ guards the suffix and the resolved name" 1 \
      "suffix=${suffix_guards} (want >= 3), stack=${stack_guards} (want >= 2)"
  fi

  # EXECUTE the derivation predicate rather than asserting its text. The old
  # check asserted the fixture sources `stack-name.sh`, which is the criterion
  # the predicate REPLACED -- so gutting the predicate stayed green.
  pred=$(printf '%s\n' "${code}" | grep -oE "grep -lE '[^']+'" | head -1 | sed "s/^grep -lE '//;s/'\$//")
  if [ -z "${pred}" ]; then
    check "run-integ's derivation predicate is extractable and covers every AWS-owning fixture" 1 \
      "no 'grep -lE' predicate found in the skill"
  else
    derived=$(cd "${INTEG_DIR}/.." && grep -lE "${pred}" integration/*/verify.sh 2>/dev/null | sed 's#integration/##;s#/verify.sh##' | sort)
    want=$( { grep -l 'stack-name.sh' "${INTEG_DIR}"/*/verify.sh; grep -lE 'aws[[:space:]]+s3api[[:space:]]+create-bucket' "${INTEG_DIR}"/*/verify.sh; } \
            | sed "s#${INTEG_DIR}/##;s#/verify.sh##" | sort -u)
    missing=$(comm -23 <(printf '%s\n' "${want}") <(printf '%s\n' "${derived}") | tr '\n' ' ')
    if [ -z "${missing}" ]; then
      check "run-integ's derivation predicate covers every AWS-owning fixture ($(printf '%s\n' "${derived}" | grep -c .))" 0
    else
      check "run-integ's derivation predicate covers every AWS-owning fixture" 1 "misses:${missing}"
    fi
  fi

else
  check "run-integ SKILL.md is present to check" 1 "not found at ${SKILL}"
fi

printf '\npass: %d  fail: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
