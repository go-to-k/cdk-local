#!/usr/bin/env bash
#
# Real-AWS validation for `cdkl start-web-function --from-cfn-stack`.
#
# The fixture app has two stacks, deployed with the fixture-pinned upstream
# CDK CLI (`aws-cdk` in package.json):
#
#   - a producer exporting one literal (SHARED_VALUE), and
#   - a consumer with an SSM parameter, an execution role (trusting Lambda AND
#     the account root) and a CfnWebFunction with ONE CfnWebFunctionRevision
#     whose ServiceConfig env holds a literal, a `Ref` (the parameter), an
#     `Fn::ImportValue` (the producer's export) and an `Fn::GetAtt` (the
#     role's Arn).
#
# Arms:
#
#   1. Baseline (no --from-cfn-stack): every intrinsic env var is warned and
#      dropped; the literal passes.
#   2. --from-cfn-stack: `Ref` -> the parameter's deployed physical id,
#      `Fn::ImportValue` -> the exported literal, `Fn::GetAtt` -> warned
#      ("could not substitute ... will be dropped") and absent — the
#      documented boundary (ListStackResources returns physical ids only, and
#      start-web-function makes no Lambda-API fallback lookup).
#   3. --from-cfn-stack --assume-role (bare): the revision's GetAtt
#      ExecutionRoleArn is resolved by the role's deployed name and Path, and
#      STS GetCallerIdentity INSIDE the container reports that assumed role.
#   4. Both stacks are deleted with `aws cloudformation delete-stack`
#      (consumer first, so the import is released before the export).
#
# Run via `/run-integ local-start-web-function-from-cfn`. Requires Docker and
# AWS credentials allowed to deploy in the target account. Uses host ports
# 18480-18482.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
# Lane-unique names (issue #582).
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
PRODUCER_STACK="$(integ_stack_name CdkLocalWebFnFromCfnProducer)"
CONSUMER_STACK="$(integ_stack_name CdkLocalWebFnFromCfnConsumer)"
EXPORT_NAME="$(integ_scoped_name cdkl-webfn-from-cfn-shared)"
# The producer's SSM parameter (a stack resource: the CDK CLI skips a stack
# with none, which would leave the export uncreated). Deleted with its stack.
SHARED_PARAM="$(integ_scoped_name /cdkl-integ/webfn-from-cfn/shared)"
SHARED_VALUE="shared-from-webfn-producer" # kept in sync with the stack's SHARED_VALUE
IMAGE="public.ecr.aws/lambda/nodejs:24"
PORT=18480

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-web-function-from-cfn"
CLI="node ${REPO_ROOT}/dist/cli.js"

# The cloud runtime is arm64-only; on an amd64 host run the container natively.
case "$(uname -m)" in
  arm64 | aarch64) PLATFORM="linux/arm64"; PLATFORM_ARGS=() ;;
  *) PLATFORM="linux/amd64"; PLATFORM_ARGS=(--platform linux/amd64) ;;
esac

# The fixture-pinned upstream CDK CLI, never whatever `cdk` is on PATH.
cdk() { "${TEST_DIR}/node_modules/.bin/cdk" "$@"; }

delete_stack() { # delete_stack <name>: delete-stack, then wait for it to be gone
  aws cloudformation delete-stack --stack-name "$1" --region "${REGION}"
  aws cloudformation wait stack-delete-complete --stack-name "$1" --region "${REGION}"
}

echo "[verify] region=${REGION} producer=${PRODUCER_STACK} consumer=${CONSUMER_STACK} export=${EXPORT_NAME} param=${SHARED_PARAM}"

CDKL_PID=""
OUT_FILE="$(mktemp)"
WE_CREATED_STACKS=0

stop_server() {
  if [ -n "${CDKL_PID}" ] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 80); do kill -0 "${CDKL_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  CDKL_PID=""
}

cleanup() {
  rc=$?
  stop_server
  rm -f "${OUT_FILE}"
  # Gated on the sentinel: a pre-existing same-named stack (pre-flight exit)
  # is someone else's and is never deleted here.
  if [ "${WE_CREATED_STACKS}" -eq 1 ]; then
    [ "${rc}" -ne 0 ] && echo "[verify] FAIL (exit ${rc}) — deleting the fixture stacks"
    delete_stack "${CONSUMER_STACK}" || true
    delete_stack "${PRODUCER_STACK}" || true
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "----- cdkl output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

# Boot `cdkl start-web-function` in the background and wait for its banner.
boot_serve() {
  stop_server
  : > "${OUT_FILE}"
  ${CLI} start-web-function "$@" --no-pull ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} > "${OUT_FILE}" 2>&1 &
  CDKL_PID=$!
  for _ in $(seq 1 240); do
    grep -q 'Server listening on http://' "${OUT_FILE}" && return 0
    kill -0 "${CDKL_PID}" 2>/dev/null || fail "start-web-function exited before it was ready"
    sleep 0.5
  done
  fail "start-web-function did not print its ready banner in time"
}

assert_no_orphans() {
  sleep 1
  local orphans
  orphans="$(docker ps -a --filter "name=cdkl-webfn-$1-" --format '{{.Names}}' || true)"
  [ -z "${orphans}" ] || fail "leftover web function container(s): ${orphans}"
}

echo "[verify] step 1: install + build cdk-local, fixture deps, base image"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
[ -d node_modules ] || vp install --prefer-offline
[ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || fail "the fixture-pinned aws-cdk CLI is not installed"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform "${PLATFORM}" "${IMAGE}" >/dev/null

echo "[verify] step 2: pre-flight — neither stack may already exist"
for stack in "${PRODUCER_STACK}" "${CONSUMER_STACK}"; do
  if aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] FAIL: ${stack} already exists — clean up first via:"
    echo "          aws cloudformation delete-stack --stack-name ${stack} --region ${REGION}"
    exit 1
  fi
done

echo "[verify] step 3: cdk deploy producer + consumer (pinned upstream CDK CLI)"
WE_CREATED_STACKS=1
cdk deploy "${PRODUCER_STACK}" "${CONSUMER_STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
REF_PHYSICAL="$(aws cloudformation describe-stack-resource --stack-name "${CONSUMER_STACK}" \
  --logical-resource-id "$(aws cloudformation list-stack-resources --stack-name "${CONSUMER_STACK}" --region "${REGION}" \
    --query "StackResourceSummaries[?ResourceType=='AWS::SSM::Parameter'].LogicalResourceId | [0]" --output text)" \
  --region "${REGION}" --query 'StackResourceDetail.PhysicalResourceId' --output text)"
ROLE_NAME="$(aws cloudformation list-stack-resources --stack-name "${CONSUMER_STACK}" --region "${REGION}" \
  --query "StackResourceSummaries[?ResourceType=='AWS::IAM::Role'].PhysicalResourceId | [0]" --output text)"
[ -n "${REF_PHYSICAL}" ] && [ "${REF_PHYSICAL}" != "None" ] || fail "no deployed SSM parameter physical id"
[ -n "${ROLE_NAME}" ] && [ "${ROLE_NAME}" != "None" ] || fail "no deployed execution role name"
echo "[verify]   parameter=${REF_PHYSICAL} role=${ROLE_NAME}"
TARGET="${CONSUMER_STACK}/WebFn"

echo "[verify] step 4: baseline (no --from-cfn-stack) — intrinsic env vars are dropped"
boot_serve "${TARGET}" --port "${PORT}"
BODY="$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/")"
echo "${BODY}" | grep -q '"staticValue":"always-the-same"' || fail "literal env missing: ${BODY}"
echo "${BODY}" | grep -q '"refValue":null' || fail "Ref env not dropped without a state source: ${BODY}"
echo "${BODY}" | grep -q '"importedValue":null' || fail "ImportValue env not dropped: ${BODY}"
echo "${BODY}" | grep -q '"getattValue":null' || fail "GetAtt env not dropped: ${BODY}"
for key in REF_VALUE IMPORTED_VALUE GETATT_VALUE; do
  grep -q "Environment variable ${key} contains a CloudFormation intrinsic and was dropped" "${OUT_FILE}" \
    || fail "no drop warning for ${key}"
done
BASE_PID="${CDKL_PID}"
stop_server
assert_no_orphans "${BASE_PID}"

echo "[verify] step 5: --from-cfn-stack — Ref and Fn::ImportValue resolve, Fn::GetAtt is warned and dropped"
boot_serve "${TARGET}" --from-cfn-stack --port "$((PORT + 1))"
BODY="$(curl -s --max-time 10 "http://127.0.0.1:$((PORT + 1))/")"
echo "${BODY}" | grep -q "\"refValue\":\"${REF_PHYSICAL}\"" || fail "Ref not resolved to ${REF_PHYSICAL}: ${BODY}"
echo "${BODY}" | grep -q "\"importedValue\":\"${SHARED_VALUE}\"" || fail "ImportValue not resolved: ${BODY}"
echo "${BODY}" | grep -q '"getattValue":null' || fail "GetAtt unexpectedly resolved: ${BODY}"
echo "${BODY}" | grep -q '"staticValue":"always-the-same"' || fail "literal env regressed: ${BODY}"
grep -q 'could not substitute env var GETATT_VALUE' "${OUT_FILE}" || fail "no GetAtt substitution warning"
grep -q 'it will be dropped' "${OUT_FILE}" || fail "the GetAtt warning does not say the value is dropped"
WHO="$(curl -s --max-time 20 "http://127.0.0.1:$((PORT + 1))/whoami")"
echo "${WHO}" | grep -q "assumed-role/${ROLE_NAME}/" && fail "the execution role was assumed without --assume-role: ${WHO}"
echo "[verify]   ${BODY}"
CFN_PID="${CDKL_PID}"
stop_server
assert_no_orphans "${CFN_PID}"

echo "[verify] step 6: --from-cfn-stack --assume-role (bare) — the GetAtt ExecutionRoleArn is assumed"
boot_serve "${TARGET}" --from-cfn-stack --assume-role --port "$((PORT + 2))"
WHO="$(curl -s --max-time 20 "http://127.0.0.1:$((PORT + 2))/whoami")"
echo "${WHO}" | grep -qE "\"arn\":\"arn:aws[a-z-]*:sts::[0-9]{12}:assumed-role/${ROLE_NAME}/" \
  || fail "STS inside the container is not the execution role ${ROLE_NAME}: ${WHO}"
echo "[verify]   ${WHO}"
AR_PID="${CDKL_PID}"
stop_server
assert_no_orphans "${AR_PID}"

echo "[verify] step 7: delete the stacks (consumer first, then producer)"
delete_stack "${CONSUMER_STACK}"
delete_stack "${PRODUCER_STACK}"
WE_CREATED_STACKS=0

echo "[verify] PASS"
