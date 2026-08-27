#!/usr/bin/env bash
# Smoke test for tests/integration/_lib/stack-name.sh (issue #582).
#
# What it pins, in the order the failure would hurt:
#
#   1. Every fixture that runs `cdk deploy` SOURCES the library and builds
#      its stack name through it. A new AWS-deploying fixture that
#      hard-codes a name reintroduces the exact defect this closes, and
#      nothing else in the repo would notice.
#   2. The base name in a fixture's `verify.sh` matches the base name in
#      its `bin/app.ts`. They are two copies of one string: if they drift,
#      `cdk deploy "${STACK}"` asks for a stack the app never synthesized.
#   3. The suffix is stable within one worktree, differs between
#      worktrees, and every name it produces is still a legal
#      CloudFormation stack name (`[A-Za-z][A-Za-z0-9-]*`, max 128).
#
# Run: bash tests/integration/_lib/stack-name.test.sh
set -u

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
INTEG_DIR=$(cd "${LIB_DIR}/.." && pwd)
LIB="${LIB_DIR}/stack-name.sh"
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

deploying=$(grep -l 'cdk deploy' "${INTEG_DIR}"/*/verify.sh)
for f in ${deploying}; do
  name=$(basename "$(dirname "$f")")
  if grep -q '_lib/stack-name.sh' "$f"; then
    check "${name}: verify.sh sources the shared library" 0
  else
    check "${name}: verify.sh sources the shared library" 1 "no source line"
  fi

  # Base names, in file order, from both copies.
  sh_bases=$(grep -oE 'integ_stack_name [A-Za-z][A-Za-z0-9-]*' "$f" \
    | awk '{print $2}' | sort)
  ts_bases=$(grep -ohE "integStackName\('[A-Za-z][A-Za-z0-9-]*'\)" "$(dirname "$f")"/bin/*.ts \
    | sed -E "s/integStackName\('([^']*)'\)/\1/" | sort)
  if [ -z "${sh_bases}" ]; then
    check "${name}: verify.sh builds its stack name via integ_stack_name" 1 "none found"
  elif [ "${sh_bases}" = "${ts_bases}" ]; then
    check "${name}: verify.sh and bin/app.ts agree on the base name(s)" 0
  else
    check "${name}: verify.sh and bin/app.ts agree on the base name(s)" 1 \
      "sh=[$(echo "${sh_bases}" | tr '\n' ' ')] ts=[$(echo "${ts_bases}" | tr '\n' ' ')]"
  fi
done

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

# Every real fixture name stays a legal CloudFormation stack name.
all_bases=$(grep -ohE 'integ_stack_name [A-Za-z][A-Za-z0-9-]*' "${INTEG_DIR}"/*/verify.sh \
  | awk '{print $2}' | sort -u)
bad=""
longest=0
while IFS= read -r base; do
  [ -n "${base}" ] || continue
  full="$(integ_stack_name "${base}")"
  [ "${#full}" -gt "${longest}" ] && longest=${#full}
  [[ "${full}" =~ ^[A-Za-z][A-Za-z0-9-]*$ ]] || bad="${bad} ${full}(charset)"
  [ "${#full}" -le 128 ] || bad="${bad} ${full}(len=${#full})"
done <<<"${all_bases}"
if [ -z "${bad}" ]; then
  check "every suffixed stack name is CFN-legal and <= 128 chars (longest=${longest})" 0
else
  check "every suffixed stack name is CFN-legal and <= 128 chars" 1 "${bad}"
fi

printf '\npass: %d  fail: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
