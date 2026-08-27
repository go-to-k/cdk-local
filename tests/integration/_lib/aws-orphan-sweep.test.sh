#!/usr/bin/env bash
# Behaviour test for tests/integration/_lib/aws-orphan-sweep.sh
# (issue go-to-k/cdk-local#601).
#
# WHY THIS FILE EXISTS AT ALL
#
# The sweep it covers used to be copy-pasteable prose in
# `.claude/skills/run-integ/SKILL.md`, and the fence around it asserted
# TEXT: that a query line still carried a `cdkl` anchor, that a guard
# statement still appeared >= 3 times, that no `cdk destroy` had come back.
# Those assertions caught four instances of one defect class only AFTER a
# human had found each one, because a text grep cannot execute a failure
# path -- and every one of the four WAS a failure path (wrong cwd, unset
# suffix, credential failure, an unrecognized error).
#
# So this file asserts nothing about the script's text. It RUNS the script
# with `aws` stubbed and asserts the VERDICT, and it asserts what the
# script ASKED the stub, not only what it answered: an exit code cannot
# distinguish "asked the right question and got no" from "asked the wrong
# question and got no". That distinction is exactly instance 1, where the
# sweep asked for a bare, un-suffixed stack name that could never match.
#
# BOTH HALVES ARE FENCED. Five of the eleven historical instances arrived
# through a FIX rather than through a scan, and the last one was in the
# REMEDIATION -- a hand-repaired `cdk destroy` that exits 0 silently on a
# name the app never synthesized. The script does not delete, it PRINTS a
# plan, so the plan is generated output and section 10 pins it by running.
#
# Must stay green under macOS system bash 3.2 as well as modern bash: no
# `mapfile`, no `declare -A`, no `${var,,}`.
#
# Run: bash tests/integration/_lib/aws-orphan-sweep.test.sh
set -u

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
INTEG_DIR=$(cd "${LIB_DIR}/.." && pwd)
SWEEP="${LIB_DIR}/aws-orphan-sweep.sh"
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

has() { # has <name> <haystack> <needle>
  case "$2" in
    *"$3"*) check "$1" 0 ;;
    *)      check "$1" 1 "output does not contain '$3'" ;;
  esac
}

hasnt() { # hasnt <name> <haystack> <needle>
  case "$2" in
    *"$3"*) check "$1" 1 "output unexpectedly contains '$3'" ;;
    *)      check "$1" 0 ;;
  esac
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

# --------------------------------------------------------------- the stub
#
# ONE stub, driven by environment variables, so a case declares only the
# AWS behaviour it cares about. It LOGS its argv: the assertions about what
# the sweep asked read that log.

STUB_BIN="${TMP}/bin"
AWS_LOG="${TMP}/aws.log"
mkdir -p "${STUB_BIN}"
cat > "${STUB_BIN}/aws" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${AWS_LOG}"
op=""
case "$*" in
  *"sts get-caller-identity"*)         op=sts ;;
  *"cloudformation describe-stacks"*)  op=stacks ;;
  *"ssm describe-parameters"*)         op=ssm ;;
  *"cloudformation list-exports"*)     op=exports ;;
  *"s3 ls"*)                           op=s3 ;;
  *) printf 'unexpected aws call: %s\n' "$*" >&2; exit 90 ;;
esac
case " ${AWS_FAIL_ON:-} " in
  *" ${op} "*) printf '%s\n' "${AWS_FAIL_MSG:-An unexpected error occurred}" >&2; exit 253 ;;
esac
case "${op}" in
  sts) printf '123456789012\n' ;;
  stacks)
    if [ "${AWS_STACK_EXISTS:-0}" = "1" ]; then
      printf '{"Stacks":[{"StackName":"s","StackStatus":"%s"}]}\n' "${AWS_STACK_STATUS:-CREATE_COMPLETE}"
    else
      printf 'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id s does not exist\n' >&2
      exit 254
    fi ;;
  ssm)     printf '%s\n' "${AWS_SSM_OUT:-}" ;;
  exports) printf '%s\n' "${AWS_EXPORTS_OUT:-}" ;;
  s3)      printf '%s\n' "${AWS_S3_OUT:-}" ;;
esac
exit 0
STUB_EOF
chmod +x "${STUB_BIN}/aws"

# A PATH with every tool the sweep needs EXCEPT `aws`, for the
# "aws is not installed" case. Symlinks rather than a copy so the real
# binaries are used.
NOAWS_BIN="${TMP}/bin-noaws"
mkdir -p "${NOAWS_BIN}"
for t in bash env cut awk dirname basename git sed grep sort cat mktemp rm head tr comm shasum sha256sum uname; do
  p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "${NOAWS_BIN}/$t"
done

# ------------------------------------------------------------- the driver

SWEEP_ENV=()
SWEEP_CWD=""
SWEEP_BIN=""
OUT=""
RC=0

sweep() { # sweep <args to aws-orphan-sweep.sh...>
  local bin="${SWEEP_BIN:-${SWEEP}}"
  local dir="${SWEEP_CWD:-${INTEG_DIR}}"
  : > "${AWS_LOG}"
  RC=0
  OUT=$(cd "${dir}" && PATH="${STUB_BIN}:${PATH}" env "AWS_LOG=${AWS_LOG}" \
          ${SWEEP_ENV[@]+"${SWEEP_ENV[@]}"} "${bin}" "$@" 2>&1) || RC=$?
  SWEEP_ENV=()
  SWEEP_CWD=""
  SWEEP_BIN=""
}

asked() { # asked <substring> -> 0 if the sweep made a matching aws call
  grep -qF -- "$1" "${AWS_LOG}"
}

# ============================================================== 1. contract
# The argument surface. Every one of these must be distinguishable from
# clean: `1` (nothing was concluded) is not `0` (nothing is there).

sweep --help
eq "--help exits 0" "0" "${RC}"
has "--help states the exit-code contract" "${OUT}" "3 indeterminate"

sweep
eq "no argument exits 1, not 0" "1" "${RC}"

sweep --nonsense
eq "an unknown option exits 1" "1" "${RC}"

sweep no-such-fixture
eq "an unknown fixture exits 1" "1" "${RC}"
if asked "sts get-caller-identity"; then
  check "an unknown fixture makes no aws call" 1 "it queried AWS for a fixture that does not exist"
else
  check "an unknown fixture makes no aws call" 0
fi

sweep ../../etc
eq "a fixture name containing a path separator exits 1" "1" "${RC}"
has "a path separator is refused by name, not by a failed lookup" "${OUT}" \
    "must be a single directory name"

sweep local-invoke
eq "a fixture owning no AWS resource exits 0" "0" "${RC}"
if asked "sts get-caller-identity"; then
  check "a fixture owning no AWS resource makes no aws call" 1 "it queried AWS with nothing to sweep"
else
  check "a fixture owning no AWS resource makes no aws call" 0
fi

# ====================================================== 2. owner derivation
# Moved here from stack-name.test.sh, where it could only assert that the
# skill's markdown still CONTAINED a `grep -lE` predicate. Here the
# predicate is executed.

sweep --list-owners
eq "--list-owners exits 0" "0" "${RC}"
owner_count=$(printf '%s\n' "${OUT}" | grep -c '.')
# The floor is the count as of issue #601 and may only ever be RAISED: a
# drop means the predicate stopped matching, not that fixtures vanished.
if [ "${owner_count}" -ge 13 ]; then
  check "the AWS-owning fixture population is intact (${owner_count} >= 13)" 0
else
  check "the AWS-owning fixture population is intact" 1 \
    "derived ${owner_count} owners, expected >= 13; the predicate has gone stale"
fi

# The gate on the sweep has silently excluded a resource-owning fixture
# TWICE: `*-from-cfn-stack` missed three, and the widened `*-from-cfn*`
# still missed `local-invoke-assume-role`, which deploys a stack holding an
# IAM role. Compare the derivation against an INDEPENDENT criterion --
# sources the lane library, or creates a bucket out of band.
want=$( { grep -l 'stack-name.sh' "${INTEG_DIR}"/*/verify.sh
          grep -lE 'aws[[:space:]]+s3api[[:space:]]+create-bucket' "${INTEG_DIR}"/*/verify.sh; } \
        | sed "s#${INTEG_DIR}/##; s#/verify.sh##" | sort -u)
missing=$(comm -23 <(printf '%s\n' "${want}") <(printf '%s\n' "${OUT}" | sort) | tr '\n' ' ')
if [ -z "${missing}" ]; then
  check "--list-owners covers every AWS-owning fixture" 0
else
  check "--list-owners covers every AWS-owning fixture" 1 "misses:${missing}"
fi
has "--list-owners reaches local-invoke-assume-role (both historical globs missed it)" \
    "${OUT}" "local-invoke-assume-role"
has "--list-owners reaches the bucket-only owner" "${OUT}" "local-invoke-agentcore-froms3"

# ================================================== 3. cwd independence
# Instances 3 and 4 were both "run it from the wrong directory": the
# relative `source` failed, the helper was undefined, and the sweep either
# degraded to an account-wide filter or reported a false clean. The script
# resolves its library from its own BASH_SOURCE, so the caller's cwd must
# not be able to change any answer.

sweep local-invoke-from-cfn-stack
root_rc="${RC}"
root_out="${OUT}"
root_asked=$(cat "${AWS_LOG}")
# GUARD THE GUARD. The three equality assertions below compare the argv log
# of two runs; if the control run asked NOTHING, they all pass vacuously at
# "" = "". That is the same "equal exit codes are not enough" failure the
# hooks suite records.
if [ -n "${root_asked}" ]; then
  check "the cwd control run actually queried AWS (equality is not vacuous)" 0
else
  check "the cwd control run actually queried AWS (equality is not vacuous)" 1 \
    "the control run made no aws call, so the cwd comparisons below prove nothing"
fi

SWEEP_CWD="/"
sweep local-invoke-from-cfn-stack
eq "run from / produces the same exit code as from the repo" "${root_rc}" "${RC}"
eq "run from / asks AWS exactly the same questions" "${root_asked}" "$(cat "${AWS_LOG}")"

SWEEP_CWD="${TMP}"
sweep local-invoke-from-cfn-stack
eq "run from an unrelated temp dir produces the same exit code" "${root_rc}" "${RC}"
eq "run from an unrelated temp dir asks the same questions" "${root_asked}" "$(cat "${AWS_LOG}")"

# ========================================================== 4. clean verdict

sweep local-invoke-from-cfn-stack-multi-stack
eq "an all-clean sweep exits 0" "0" "${RC}"
has "an all-clean sweep says so" "${OUT}" "VERDICT: clean"

# WHAT IT ASKED, not only what it answered. Instance 1 asked for a bare
# base name, which can never match, and therefore always answered clean.
if asked "--stack-name CdkLocalInvokeMultiStackConsumer-"; then
  check "the stack query carries the lane suffix, not the bare base" 0
else
  check "the stack query carries the lane suffix, not the bare base" 1 \
    "asked: $(cat "${AWS_LOG}")"
fi
if grep -qE -- '--stack-name CdkLocalInvokeMultiStackConsumer( |$)' "${AWS_LOG}"; then
  check "the stack query is never the un-suffixed base name" 1 \
    "it asked for the bare base name, which can never match"
else
  check "the stack query is never the un-suffixed base name" 0
fi
# PLURAL: this fixture owns two stacks, and its cleanup destroys the
# consumer first -- so an interrupted destroy orphans the PRODUCER, which
# is exactly the one a single-name scan would skip.
if asked "--stack-name CdkLocalInvokeMultiStackProducer-"; then
  check "both stacks of a multi-stack fixture are queried" 0
else
  check "both stacks of a multi-stack fixture are queried" 1 "the producer was never queried"
fi
# `describe-stacks --stack-name`, never a status filter: a status filter
# hid 16 of 23 statuses, `DELETE_IN_PROGRESS` among them.
if asked "stack-status-filter"; then
  check "the stack query does not filter by status" 1 \
    "a --stack-status-filter hides an orphan in any unlisted status"
else
  check "the stack query does not filter by status" 0
fi
hasnt "a clean sweep prints no remediation plan" "${OUT}" "REMEDIATION PLAN"

# ========================================================= 5. orphan verdict

SWEEP_ENV=(AWS_STACK_EXISTS=1)
sweep local-invoke-from-cfn-stack
eq "an existing stack exits 2 (orphan)" "2" "${RC}"
has "an existing stack is reported as an orphan" "${OUT}" "ORPHAN stack:"
has "an existing stack yields the orphan verdict" "${OUT}" "VERDICT: orphan"

# The scenario this sweep exists for: an INTERRUPTED `cdk destroy`.
SWEEP_ENV=(AWS_STACK_EXISTS=1 AWS_STACK_STATUS=DELETE_IN_PROGRESS)
sweep local-invoke-from-cfn-stack
eq "a DELETE_IN_PROGRESS stack does NOT read as clean" "2" "${RC}"
has "a DELETE_IN_PROGRESS stack surfaces its status" "${OUT}" "status=DELETE_IN_PROGRESS"

SWEEP_ENV=(AWS_SSM_OUT="/cdkl-integ/invoke-from-cfn-stack/db-host-LANE")
sweep local-invoke-from-cfn-stack
eq "an orphan SSM parameter exits 2" "2" "${RC}"
has "an orphan SSM parameter is reported" "${OUT}" "ORPHAN ssm-parameter:"

SWEEP_ENV=(AWS_EXPORTS_OUT="cdkl-multi-stack-shared-value-LANE	arn:aws:cfn:x")
sweep local-invoke-from-cfn-stack-multi-stack
eq "an orphan export exits 2" "2" "${RC}"
has "an orphan export is reported" "${OUT}" "ORPHAN cfn-export:"
has "an orphan export names its exporting stack" "${OUT}" "arn:aws:cfn:x"

# The lane-suffix filter is a NET for the whole lane, so a match that this
# fixture does not own is still this lane's orphan -- but saying which is
# the difference between a safe delete and a peer's live resource.
SWEEP_ENV=(AWS_SSM_OUT="/cdkl-ls-LANE/p000")
sweep local-invoke-from-cfn-stack
has "a match this fixture does not own is attributed to the lane, not the fixture" \
    "${OUT}" "(this lane, another fixture)"

# ================================================ 6. the unattributable one
# The froms3 bucket carries NO lane hash -- it is built from the account,
# the region and a timestamp -- so it can be REPORTED and never attributed.
# A distinct exit code lets a caller tell "stop and check by hand" from
# "delete this".

SWEEP_ENV=(AWS_S3_OUT="2026-01-01 00:00:00 cdkl-integ-froms3-123456789012-us-east-1-1700000000-42")
sweep local-invoke-agentcore-froms3
eq "a matching froms3 bucket exits 4 (report-only), not 2" "4" "${RC}"
has "the bucket is labelled unattributable" "${OUT}" "REPORT (UNATTRIBUTABLE) bucket:"
hasnt "the bucket is never called an orphan" "${OUT}" "ORPHAN bucket"
has "the bucket report warns it may be a live peer's" "${OUT}" "LIVE bucket"
has "the bucket verdict is report-only" "${OUT}" "VERDICT: report-only"

sweep local-invoke-agentcore-froms3
eq "no matching bucket exits 0" "0" "${RC}"
# Derived, not hard-coded: a second bucket-creating fixture must be swept
# without anyone remembering to add it here.
if asked "s3 ls"; then
  check "the bucket owner is swept for buckets" 0
else
  check "the bucket owner is swept for buckets" 1 "s3 ls was never called"
fi
sweep local-invoke-from-cfn-stack
if asked "s3 ls"; then
  check "a fixture that creates no bucket is not swept for buckets" 1 "it called s3 ls anyway"
else
  check "a fixture that creates no bucket is not swept for buckets" 0
fi

# ================================================== 7. indeterminate verdict
# Every query failing IN TURN. This is the section a text grep cannot have:
# each of these is a failure path, and instance 4 was a failure path that
# printed "AWS clean".

for op in sts stacks ssm exports; do
  SWEEP_ENV=("AWS_FAIL_ON=${op}")
  sweep local-invoke-from-cfn-stack
  eq "a failing '${op}' query exits 3 (indeterminate), never 0" "3" "${RC}"
  has "a failing '${op}' query says so" "${OUT}" "INDETERMINATE"
done

SWEEP_ENV=(AWS_FAIL_ON=s3)
sweep local-invoke-agentcore-froms3
eq "a failing 's3 ls' exits 3 (indeterminate), never 0" "3" "${RC}"

# The phrase-match fence. The prose banned matching stderr for `does not
# exist` because a broken `source_profile` produces that phrase too. The
# script requires the `(ValidationError)` API error code as well, so this
# must NOT be read as "no such stack".
SWEEP_ENV=(AWS_FAIL_ON=stacks
           'AWS_FAIL_MSG=The source_profile "dev" referenced in the profile "x" does not exist')
sweep local-invoke-from-cfn-stack
eq "a credential-config error saying 'does not exist' is NOT clean" "3" "${RC}"

# Fail CLOSED if AWS ever rewords the missing-stack message: into
# indeterminate, never into clean. That direction is the whole reason the
# tighter two-token match is acceptable.
SWEEP_ENV=(AWS_FAIL_ON=stacks 'AWS_FAIL_MSG=Stack with id s could not be found')
sweep local-invoke-from-cfn-stack
eq "an unrecognized stack error fails closed into indeterminate" "3" "${RC}"

# Precedence: "I could not look" outranks "I found something", because a
# partial look cannot bound what it missed.
SWEEP_ENV=(AWS_STACK_EXISTS=1 AWS_FAIL_ON=ssm)
sweep local-invoke-from-cfn-stack
eq "indeterminate outranks orphan when both fire" "3" "${RC}"

# `aws` not installed at all.
SWEEP_BIN="${SWEEP}"
OUT=$(cd "${INTEG_DIR}" && PATH="${NOAWS_BIN}" "${SWEEP}" local-invoke-from-cfn-stack 2>&1) && RC=0 || RC=$?
eq "no aws binary on PATH exits 3, never 0" "3" "${RC}"
has "no aws binary on PATH says nothing was queried" "${OUT}" "nothing was queried"

# ==================================================== 8. the lane suffix
# Instance 3: with the suffix unresolved the filters degraded to
# `contains(Name,'-')` -- every hyphenated parameter in the ACCOUNT,
# `/prod/db-password` included. That is strictly worse than the
# peer-listing the filter was added to fix, so it must be impossible.

sweep local-invoke-from-cfn-stack
ssm_call=$(grep -F "describe-parameters" "${AWS_LOG}" | head -1)
exp_call=$(grep -F "list-exports" "${AWS_LOG}" | head -1)
if printf '%s' "${ssm_call}" | grep -qE "contains\(Name,'-[0-9a-f]{8}'\)"; then
  check "the SSM filter carries a resolved 8-hex lane suffix" 0
else
  check "the SSM filter carries a resolved 8-hex lane suffix" 1 "asked: ${ssm_call}"
fi
if printf '%s' "${exp_call}" | grep -qE "contains\(Name,'-[0-9a-f]{8}'\)"; then
  check "the export filter carries a resolved 8-hex lane suffix" 0
else
  check "the export filter carries a resolved 8-hex lane suffix" 1 "asked: ${exp_call}"
fi
# The degraded form, spelled out so it cannot come back unnoticed.
if grep -qF "contains(Name,'-')" "${AWS_LOG}"; then
  check "no filter degrades to the account-wide contains(Name,'-')" 1 \
    "an unresolved suffix selected every hyphenated name in the account"
else
  check "no filter degrades to the account-wide contains(Name,'-')" 0
fi
# BOTH conditions: the `cdkl` anchor bounds the blast radius to this repo's
# resources even if the suffix logic changes.
has "the SSM filter keeps the cdkl anchor" "${ssm_call}" "starts_with(Name,'/cdkl')"
has "the export filter keeps the cdkl anchor" "${exp_call}" "starts_with(Name,'cdkl')"

# A pre-set suffix (CI pin) is honoured end to end, into the query.
SWEEP_ENV=(INTEG_STACK_SUFFIX=deadbeef)
sweep local-invoke-from-cfn-stack
if asked "--stack-name CdkLocalInvokeFromCfnStackFixture-deadbeef"; then
  check "a pre-set lane suffix reaches the stack query" 0
else
  check "a pre-set lane suffix reaches the stack query" 1 "asked: $(cat "${AWS_LOG}")"
fi
if grep -qF "contains(Name,'-deadbeef')" "${AWS_LOG}"; then
  check "a pre-set lane suffix reaches the SSM / export filters" 0
else
  check "a pre-set lane suffix reaches the SSM / export filters" 1 "asked: $(cat "${AWS_LOG}")"
fi

# With no hasher on PATH `stack-name.sh` refuses to hand back a suffix. The
# sweep must fail rather than sweep with an empty one.
NOHASH_BIN="${TMP}/bin-nohash"
mkdir -p "${NOHASH_BIN}"
for t in bash env cut awk dirname basename git sed grep sort cat mktemp rm head tr; do
  p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "${NOHASH_BIN}/$t"
done
ln -sf "${STUB_BIN}/aws" "${NOHASH_BIN}/aws"
OUT=$(cd "${INTEG_DIR}" && PATH="${NOHASH_BIN}" env "AWS_LOG=${AWS_LOG}" \
        "${SWEEP}" local-invoke-from-cfn-stack 2>&1) && RC=0 || RC=$?
if [ "${RC}" -ne 0 ]; then
  check "an underivable lane suffix is not a clean verdict (rc=${RC})" 0
else
  check "an underivable lane suffix is not a clean verdict" 1 "exited 0 with no suffix"
fi

# ================================= 9. a sandbox tree, for the cases the real
# fixtures cannot express: a sabotaged library and two derivation failures.
#
# The script resolves everything from its own BASH_SOURCE, so a COPY of
# `_lib` in a scratch tree is a complete, isolated installation.

SANDBOX="${TMP}/sandbox/tests/integration"
mkdir -p "${SANDBOX}/_lib"
cp "${SWEEP}" "${LIB_DIR}/stack-name.sh" "${SANDBOX}/_lib/"
SANDBOX_SWEEP="${SANDBOX}/_lib/aws-orphan-sweep.sh"

# (a) A library that exports an EMPTY suffix. This is instance 3's state
#     reached from the other side -- the guard inside the sweep, rather
#     than the library's own refusal.
mkdir -p "${TMP}/sandbox-empty/tests/integration/_lib"
cp "${SWEEP}" "${TMP}/sandbox-empty/tests/integration/_lib/"
cat > "${TMP}/sandbox-empty/tests/integration/_lib/stack-name.sh" <<'EMPTY_EOF'
#!/usr/bin/env bash
INTEG_STACK_SUFFIX=""
export INTEG_STACK_SUFFIX
integ_stack_name() { printf '%s' "$1"; }
integ_scoped_name() { printf '%s' "$1"; }
EMPTY_EOF
mkdir -p "${TMP}/sandbox-empty/tests/integration/fake/bin"
cat > "${TMP}/sandbox-empty/tests/integration/fake/verify.sh" <<'FAKE_EOF'
#!/usr/bin/env bash
source ../_lib/stack-name.sh
STACK="$(integ_stack_name FakeFixture)"
cdk deploy "${STACK}"
FAKE_EOF
SWEEP_BIN="${TMP}/sandbox-empty/tests/integration/_lib/aws-orphan-sweep.sh"
sweep fake
eq "an empty lane suffix exits 1, never sweeping account-wide" "1" "${RC}"
has "the empty suffix is refused for being empty, not for some other reason" "${OUT}" \
    "the lane suffix is empty"
if grep -qF "contains(Name,'-')" "${AWS_LOG}"; then
  check "an empty lane suffix never reaches an AWS filter" 1 "it queried with the degraded filter"
else
  check "an empty lane suffix never reaches an AWS filter" 0
fi

# (b) A fixture that DEPLOYS but from which no stack name can be derived.
#     Reporting clean here is instance 1 exactly: a sweep that looked at
#     nothing and said nothing is there.
mkdir -p "${SANDBOX}/nameless"
cat > "${SANDBOX}/nameless/verify.sh" <<'NAMELESS_EOF'
#!/usr/bin/env bash
cdk deploy SomeHardCodedName
NAMELESS_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep nameless
eq "a deploying fixture with no derivable stack name exits 1, not 0" "1" "${RC}"
has "it says why rather than reporting clean" "${OUT}" "no stack base name could be derived"

# (c) A fixture that creates a bucket but from which no literal prefix can
#     be derived. Same shape: a sweep that cannot name the resource must
#     not claim the resource is absent.
mkdir -p "${SANDBOX}/bucketless"
cat > "${SANDBOX}/bucketless/verify.sh" <<'BUCKETLESS_EOF'
#!/usr/bin/env bash
source ../_lib/stack-name.sh
STACK="$(integ_stack_name BucketlessFixture)"
BUCKET="${SOME_VAR}-bucket"
aws s3api create-bucket --bucket "${BUCKET}"
BUCKETLESS_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep bucketless
eq "a bucket-creating fixture with no derivable prefix exits 1, not 0" "1" "${RC}"
has "it names the underivable bucket prefix as the reason" "${OUT}" \
    "no literal bucket-name prefix could be derived"

# (d) The union derivation: a stack named ONLY in the CDK app, never in
#     verify.sh, must still be swept. "Derive every name it owns so a
#     caller cannot forget one" fails if the derivation reads one half.
mkdir -p "${SANDBOX}/apponly/bin"
cat > "${SANDBOX}/apponly/verify.sh" <<'APPONLY_EOF'
#!/usr/bin/env bash
cdk deploy --all
APPONLY_EOF
cat > "${SANDBOX}/apponly/bin/app.ts" <<'APPONLY_TS_EOF'
new Stack(app, integStackName('AppOnlyDeclaredStack'));
APPONLY_TS_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep apponly
if asked "--stack-name AppOnlyDeclaredStack-"; then
  check "a stack declared only in bin/app.ts is still swept" 0
else
  check "a stack declared only in bin/app.ts is still swept" 1 "asked: $(cat "${AWS_LOG}")"
fi

# ================================================== 10. the REMEDIATION half
# Five of the eleven historical instances arrived through a FIX, and the
# last one was in the remediation: `cdk destroy` needs `--app` context this
# cwd does not provide and, repaired by hand, exits 0 SILENTLY on a name
# the app never synthesized. The script does not delete -- deleting needs a
# live-peer judgment and a cross-stack order neither of which is derivable
# -- so it PRINTS a plan, and the plan is generated output that can be
# pinned by running rather than by grepping a markdown file.

SWEEP_ENV=(AWS_STACK_EXISTS=1)
sweep local-invoke-from-cfn-stack-multi-stack
plan="${OUT}"
has "an orphan prints a remediation plan" "${plan}" "REMEDIATION PLAN"
has "the plan remediates with aws cloudformation delete-stack" "${plan}" \
    "aws cloudformation delete-stack --stack-name"
has "the plan waits for the delete to complete" "${plan}" \
    "aws cloudformation wait stack-delete-complete"
# The exact line whose return left the previous fence at 84/0.
# Either spelling: the runnable command lines are emitted WITHOUT the
# `[sweep] ` prefix (so they are pasteable), the prose lines keep it.
if printf '%s\n' "${plan}" | grep -qE '^[[:space:]]*(\[sweep\][[:space:]]+)?cdk[[:space:]]+destroy'; then
  check "the plan never offers cdk destroy" 1 \
    "cdk destroy needs --app from this cwd and exits 0 on unmatched names"
else
  check "the plan never offers cdk destroy" 0
fi
has "the plan explains why not cdk destroy" "${plan}" "exits 0 SILENTLY"
# The remediation's own instance of the defect class: pasting the BASE name
# deletes nothing and reports success.
has "the plan names the SUFFIXED consumer stack" "${plan}" \
    "delete-stack --stack-name CdkLocalInvokeMultiStackConsumer-"
has "the plan names the SUFFIXED producer stack" "${plan}" \
    "delete-stack --stack-name CdkLocalInvokeMultiStackProducer-"
if printf '%s\n' "${plan}" | grep -qE -- '--stack-name CdkLocalInvokeMultiStackConsumer( |$)'; then
  check "the plan never names an un-suffixed base as a delete target" 1 \
    "a base name matches nothing and reports success"
else
  check "the plan never names an un-suffixed base as a delete target" 0
fi
has "the plan warns about a live peer before deleting" "${plan}" "LIVE PEER"
has "the plan states the dependency-order requirement" "${plan}" "DEPENDENCY order"
has "the plan requires re-running the sweep afterwards" "${plan}" "RE-RUN THIS SWEEP"

# An unattributable finding must be quarantined from the delete commands.
SWEEP_ENV=(AWS_S3_OUT="2026-01-01 00:00:00 cdkl-integ-froms3-123456789012-us-east-1-1700000000-42")
sweep local-invoke-agentcore-froms3
has "an unattributable finding is quarantined in the plan" "${OUT}" \
    "do NOT delete without checking"
hasnt "an unattributable finding gets no delete command" "${OUT}" "delete-stack --stack-name"

# ============================== 11. a COMMENTED command is not a command
# BLOCKER 1, reproduced before it was fixed. `/create-integ`'s scaffold
# ships a commented-out `# cdk deploy "${STACK}" ...` block
# (`.claude/skills/create-integ/SKILL.md`). Matching the raw file text
# classified every freshly scaffolded Docker-only fixture as AWS-owning,
# found no stack name inside it, and died rc=1 -- and since `/run-integ`
# runs this sweep unconditionally and stops on any non-zero, that blocked
# `/create-integ`'s own verification step for every new fixture.
#
# The block this file replaced already had the discipline
# (`code=$(grep -vE '^[[:space:]]*#' ...)`) and it was lost in the move,
# which is why the property now has cases of its own rather than only a fix.

mkdir -p "${SANDBOX}/scaffolded"
cat > "${SANDBOX}/scaffolded/verify.sh" <<'SCAFFOLD_EOF'
#!/usr/bin/env bash
[ -d node_modules ] || vp install --prefer-offline
# --- *-from-cfn-stack only: deploy first ---
# WE_CREATED_STACK=1
# cdk deploy "${STACK}" --require-approval never --no-version-reporting \
#   --no-asset-metadata --no-path-metadata --region "${REGION}"
echo "[verify] step 2: assert the new behavior"
SCAFFOLD_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep scaffolded
eq "a freshly scaffolded fixture (commented cdk deploy) exits 0, not 1" "0" "${RC}"
has "it is classified as owning no AWS resource" "${OUT}" "owns no real AWS resource"
if asked "sts get-caller-identity"; then
  check "a commented deploy triggers no AWS call" 1 "it queried AWS for a commented-out command"
else
  check "a commented deploy triggers no AWS call" 0
fi

# The bucket half of the same predicate.
mkdir -p "${SANDBOX}/commented-bucket"
cat > "${SANDBOX}/commented-bucket/verify.sh" <<'CB_EOF'
#!/usr/bin/env bash
# aws s3api create-bucket --bucket "${BUCKET}" --region "${REGION}"
echo "[verify] docker only"
CB_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep commented-bucket
eq "a commented create-bucket does not make a fixture AWS-owning" "0" "${RC}"

# ...and the derivation reads the same stripped body, so a commented-out
# stack name is not swept either. An extra queried name cannot report a
# false clean, but it CAN manufacture a false orphan against a same-named
# stack, and it would desynchronise the call-site count in section 12.
mkdir -p "${SANDBOX}/commented-name/bin"
cat > "${SANDBOX}/commented-name/verify.sh" <<'CN_EOF'
#!/usr/bin/env bash
STACK="$(integ_stack_name LiveStack)"
# STACK_OLD="$(integ_stack_name RetiredStack)"
cdk deploy "${STACK}"
CN_EOF
cat > "${SANDBOX}/commented-name/bin/app.ts" <<'CN_TS_EOF'
new Stack(app, integStackName('LiveStack'));
// new Stack(app, integStackName('RetiredAppStack'));
CN_TS_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep commented-name
eq "a fixture whose only live stack name is uncommented exits 0" "0" "${RC}"
if asked "--stack-name LiveStack-"; then
  check "the live stack name is queried" 0
else
  check "the live stack name is queried" 1 "asked: $(cat "${AWS_LOG}")"
fi
if asked "RetiredStack"; then
  check "a commented-out shell stack name is not queried" 1 "it swept a commented name"
else
  check "a commented-out shell stack name is not queried" 0
fi
if asked "RetiredAppStack"; then
  check "a commented-out TypeScript stack name is not queried" 1 "it swept a commented name"
else
  check "a commented-out TypeScript stack name is not queried" 0
fi

# The predicate must still reach every real owner after the strip.
sweep --list-owners
post_strip=$(printf '%s\n' "${OUT}" | grep -c '.')
eq "comment-stripping does not shrink the owner set" "${owner_count}" "${post_strip}"

# ======================= 12. a PARTIAL derivation must never reach "clean"
# BLOCKER 2, reproduced before it was fixed. The old guard fired only when
# NOTHING was derivable, so a fixture with two stacks where one name is
# built from a shell variable queried ONE of them and printed
# `VERDICT: clean` / rc=0 -- instance 1 (a sweep reporting clean over
# something it never looked at) narrowed to one stack of several rather
# than closed.

mkdir -p "${SANDBOX}/partial"
cat > "${SANDBOX}/partial/verify.sh" <<'PARTIAL_EOF'
#!/usr/bin/env bash
CONSUMER="$(integ_stack_name PartialConsumer)"
PRODUCER_BASE="PartialProducer"
PRODUCER="$(integ_stack_name "${PRODUCER_BASE}")"
cdk deploy "${PRODUCER}" "${CONSUMER}"
PARTIAL_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep partial
eq "a partially derivable fixture exits 1, never 0" "1" "${RC}"
has "it names the unresolvable count as the reason" "${OUT}" \
    "stack name(s) are built from a variable or expression"
hasnt "it does not print a clean verdict" "${OUT}" "VERDICT: clean"
if asked "--stack-name PartialConsumer-"; then
  check "it refuses BEFORE querying the half it could resolve" 1 \
    "it queried one stack and then refused; the refusal must precede any claim"
else
  check "it refuses BEFORE querying the half it could resolve" 0
fi

# The same defect on the TypeScript side.
mkdir -p "${SANDBOX}/partial-ts/bin"
cat > "${SANDBOX}/partial-ts/verify.sh" <<'PTS_EOF'
#!/usr/bin/env bash
cdk deploy --all
PTS_EOF
cat > "${SANDBOX}/partial-ts/bin/app.ts" <<'PTS_TS_EOF'
new Stack(app, integStackName('LiteralStack'));
new Stack(app, integStackName(computedBase));
PTS_TS_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep partial-ts
eq "a non-literal integStackName() in the app exits 1, never 0" "1" "${RC}"

# GUARD THE GUARD. The obvious implementation -- compare the NUMBER of
# derived names against the NUMBER of call sites -- dies on a correct
# fixture, because naming the same base twice (once to deploy, once to
# destroy) is normal and `sort -u` collapses it. Counting UNRESOLVABLE call
# sites instead is duplicate-safe, and this case is what says so.
mkdir -p "${SANDBOX}/duplicated"
cat > "${SANDBOX}/duplicated/verify.sh" <<'DUP_EOF'
#!/usr/bin/env bash
STACK="$(integ_stack_name DupFixture)"
cdk deploy "${STACK}"
echo "cleanup: $(integ_stack_name DupFixture)"
DUP_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep duplicated
eq "naming one base twice is NOT a partial derivation" "0" "${RC}"

# The scoped-name analogue WARNS rather than dies: those are found by a
# lane-wide filter that never consults the derived names, so an
# unresolvable one degrades attribution and can never hide a finding.
mkdir -p "${SANDBOX}/partial-scoped"
cat > "${SANDBOX}/partial-scoped/verify.sh" <<'PSC_EOF'
#!/usr/bin/env bash
STACK="$(integ_stack_name ScopedFixture)"
P="$(integ_scoped_name "${SOME_PATH}")"
cdk deploy "${STACK}"
PSC_EOF
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep partial-scoped
eq "an unresolvable SCOPED name warns instead of dying" "0" "${RC}"
has "the scoped warning is visible, not silent" "${OUT}" \
    "scoped-name call site(s)"

# `--list-owners` runs the SAME predicate but over the whole tree, and it
# needs its own case.
#
# THE MOST INSTRUCTIVE RESULT IN THE PROBE TABLE, recorded because the
# shape recurs. Mutant MB1d reverts ONLY this call site to a raw
# (un-stripped) read, restoring the exact Blocker-1 defect in the one
# function an agent calls to SEE the owner set -- and it SURVIVED: the
# suite stayed fully green at 128/128. Not because the assertions were
# weak, but because the population they ran against could not express the
# defect: no fixture in the real tree happens to carry a commented-out
# `cdk deploy`, and the sandbox fixtures that do live in a DIFFERENT
# INTEG_DIR that `--list-owners` never reads.
#
# The lesson is that a test's POPULATION is part of its coverage. Three
# sibling call sites were fenced by cases that ran against controlled
# input; this one was fenced only by cases that ran against whatever the
# repo happened to contain, so it was fenced by luck. The fix is not a
# stronger assertion -- it is moving the assertion to where the population
# is controlled, which is what these three cases do. Re-probed after: MB1d
# kills two of them.
SWEEP_BIN="${SANDBOX_SWEEP}"
sweep --list-owners
sandbox_owners="${OUT}"
if printf '%s\n' "${sandbox_owners}" | grep -qx 'scaffolded'; then
  check "--list-owners excludes a fixture whose only deploy is commented" 1 \
    "the scaffolded fixture was listed as AWS-owning"
else
  check "--list-owners excludes a fixture whose only deploy is commented" 0
fi
if printf '%s\n' "${sandbox_owners}" | grep -qx 'commented-bucket'; then
  check "--list-owners excludes a fixture whose only create-bucket is commented" 1 \
    "the commented-bucket fixture was listed as AWS-owning"
else
  check "--list-owners excludes a fixture whose only create-bucket is commented" 0
fi
# ...and it must still SEE a live one, so the two checks above cannot pass
# by the predicate matching nothing at all.
if printf '%s\n' "${sandbox_owners}" | grep -qx 'commented-name'; then
  check "--list-owners still sees a fixture with a live deploy beside a comment" 0
else
  check "--list-owners still sees a fixture with a live deploy beside a comment" 1 \
    "the predicate matched nothing; the exclusions above are vacuous"
fi

# ============================ 13. the skill still CALLS the sweep, per step
# The one deleted assertion with no counterpart. It existed because
# "green with the post-run scan deleted and the pre-flight one duplicated"
# had been MEASURED -- hence per-STEP ranges rather than a whole-file count.
# Without this, deleting the step-7 invocation leaves the suite fully green.

SKILL="${INTEG_DIR}/../../.claude/skills/run-integ/SKILL.md"
if [ -f "${SKILL}" ]; then
  pre_calls=$(sed -n '/^4\. \*\*AWS pre-flight sweep/,/^5\. \*\*Run the test/p' "${SKILL}" \
    | grep -c 'aws-orphan-sweep\.sh' || true)
  post_calls=$(sed -n '/^7\. \*\*Verify AWS cleanup/,/^8\. \*\*Report results/p' "${SKILL}" \
    | grep -c 'aws-orphan-sweep\.sh' || true)
  if [ "${pre_calls}" -ge 1 ]; then
    check "run-integ step 4 invokes the sweep script (${pre_calls})" 0
  else
    check "run-integ step 4 invokes the sweep script" 1 \
      "no aws-orphan-sweep.sh call in the pre-flight step; the sweep is never run"
  fi
  if [ "${post_calls}" -ge 1 ]; then
    check "run-integ step 7 invokes the sweep script (${post_calls})" 0
  else
    check "run-integ step 7 invokes the sweep script" 1 \
      "no aws-orphan-sweep.sh call in the post-run step; step 9 would set the marker unswept"
  fi
else
  check "run-integ SKILL.md is present to check" 1 "not found at ${SKILL}"
fi

# ==================================================== 14. the remaining nits

# The credentials probe must carry the region: a region that rejects the
# caller has to fail as ONE clear line, not as N unrecognized errors.
sweep local-invoke-from-cfn-stack
if grep -F "sts get-caller-identity" "${AWS_LOG}" | grep -qF -- "--region"; then
  check "the credentials probe carries --region" 0
else
  check "the credentials probe carries --region" 1 "asked: $(grep -F 'sts get-caller-identity' "${AWS_LOG}")"
fi

# The remediation's runnable lines must be literally pasteable -- the skill
# says "run what it printed", and a `[sweep] `-prefixed line is not a
# command.
SWEEP_ENV=(AWS_STACK_EXISTS=1)
sweep local-invoke-from-cfn-stack
if printf '%s\n' "${OUT}" | grep -qE '^[[:space:]]+aws cloudformation delete-stack --stack-name [A-Za-z0-9-]+ --region [a-z0-9-]+$'; then
  check "the delete-stack line is pasteable (no [sweep] prefix)" 0
else
  check "the delete-stack line is pasteable (no [sweep] prefix)" 1 \
    "no unprefixed delete-stack line found"
fi
if printf '%s\n' "${OUT}" | grep -qE '^[[:space:]]+aws cloudformation wait stack-delete-complete --stack-name [A-Za-z0-9-]+ --region [a-z0-9-]+$'; then
  check "the wait line is pasteable (no [sweep] prefix)" 0
else
  check "the wait line is pasteable (no [sweep] prefix)" 1 "no unprefixed wait line found"
fi

# Usage on a missing argument goes to stderr like every other error. It used
# to go to stdout while `-*` went to stderr, so a caller redirecting one
# stream saw half the failures.
usage_stdout=$(cd "${INTEG_DIR}" && PATH="${STUB_BIN}:${PATH}" "${SWEEP}" 2>/dev/null) || true
if [ -z "${usage_stdout}" ]; then
  check "a missing argument writes nothing to stdout" 0
else
  check "a missing argument writes nothing to stdout" 1 "stdout carried: ${usage_stdout}"
fi
usage_stderr=$(cd "${INTEG_DIR}" && PATH="${STUB_BIN}:${PATH}" "${SWEEP}" 2>&1 >/dev/null) || true
has "a missing argument explains itself on stderr" "${usage_stderr}" "no fixture name given"
# `--help` is NOT an error, so it keeps stdout.
help_stdout=$(cd "${INTEG_DIR}" && PATH="${STUB_BIN}:${PATH}" "${SWEEP}" --help 2>/dev/null) || true
has "--help still writes to stdout" "${help_stdout}" "Usage:"

# A PRE-SET suffix is interpolated into a JMESPath string literal and into
# stack names, so it must be a plain token. A quote would rewrite the filter
# expression; a one- or two-character value makes `contains` match most of
# the account -- the account-wide degradation arriving through the CI pin
# instead of through an empty variable.
for bad in "a'b" 'x"y' 'ab' '-lead' 'has space' '../etc'; do
  SWEEP_ENV=("INTEG_STACK_SUFFIX=${bad}")
  sweep local-invoke-from-cfn-stack
  eq "a malformed pre-set suffix '${bad}' exits 1, never sweeping" "1" "${RC}"
  if grep -qF "${bad}" "${AWS_LOG}" 2>/dev/null; then
    check "the malformed suffix '${bad}' never reaches an AWS filter" 1 "it was interpolated into a query"
  else
    check "the malformed suffix '${bad}' never reaches an AWS filter" 0
  fi
done
# ...and a legitimate CI pin still works.
SWEEP_ENV=(INTEG_STACK_SUFFIX=ci-job-4711)
sweep local-invoke-from-cfn-stack
eq "a legitimate non-hex CI pin is still honoured" "0" "${RC}"
if asked "--stack-name CdkLocalInvokeFromCfnStackFixture-ci-job-4711"; then
  check "the CI pin reaches the stack query" 0
else
  check "the CI pin reaches the stack query" 1 "asked: $(cat "${AWS_LOG}")"
fi

printf '\npass: %d  fail: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
