#!/usr/bin/env bash
#
# Real-AWS validation for `cdkl start-microvm --from-cfn-stack`.
#
# The fixture app has two stacks, deployed with the fixture-pinned upstream
# CDK CLI (`aws-cdk` in package.json):
#
#   - a producer exporting one literal (SHARED_VALUE), and
#   - a consumer with an SSM parameter, a build role and a CfnMicrovmImage
#     (really built in the cloud — CloudFormation waits for it) whose
#     EnvironmentVariables hold a literal, a `Ref` (the parameter), an
#     `Fn::ImportValue` (the producer's export) and an `Fn::GetAtt` (the build
#     role's Arn).
#
# Arms:
#
#   1. Baseline (no --from-cfn-stack): every intrinsic env var is warned and
#      dropped; the literal passes.
#   2. --from-cfn-stack: `Ref` -> the parameter's deployed physical id,
#      `Fn::ImportValue` -> the exported literal, `Fn::GetAtt` -> warned
#      ("could not substitute ... will be dropped") and absent — the
#      documented boundary (ListStackResources returns physical ids only).
#   3. Both stacks are deleted with `aws cloudformation delete-stack`
#      (consumer first, so the import is released before the export).
#
# Run via `/run-integ local-start-microvm-from-cfn`. Requires Docker and AWS
# credentials allowed to deploy in the target account (Lambda MicroVMs must be
# available in the region). Uses host ports 18490-18491.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
# Lane-unique names (issue #582).
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
PRODUCER_STACK="$(integ_stack_name CdkLocalMicrovmFromCfnProducer)"
CONSUMER_STACK="$(integ_stack_name CdkLocalMicrovmFromCfnConsumer)"
EXPORT_NAME="$(integ_scoped_name cdkl-microvm-from-cfn-shared)"
# The producer's SSM parameter (a stack resource: the CDK CLI skips a stack
# with none, which would leave the export uncreated). Deleted with its stack.
SHARED_PARAM="$(integ_scoped_name /cdkl-integ/microvm-from-cfn/shared)"
SHARED_VALUE="shared-from-microvm-producer" # kept in sync with the stack's SHARED_VALUE
BASE_IMAGE="public.ecr.aws/docker/library/node:24-slim"
PORT=18490

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-microvm-from-cfn"
CLI="node ${REPO_ROOT}/dist/cli.js"

# The image declares ARM_64; on an amd64 host build and run natively.
case "$(uname -m)" in
  arm64 | aarch64) PLATFORM="linux/arm64" ;;
  *) PLATFORM="linux/amd64" ;;
esac

# The fixture-pinned upstream CDK CLI, never whatever `cdk` is on PATH.
cdk() { "${TEST_DIR}/node_modules/.bin/cdk" "$@"; }

delete_stack() { # delete_stack <name>: delete-stack, then wait for it to be gone
  aws cloudformation delete-stack --stack-name "$1" --region "${REGION}"
  aws cloudformation wait stack-delete-complete --stack-name "$1" --region "${REGION}"
}

echo "[verify] region=${REGION} producer=${PRODUCER_STACK} consumer=${CONSUMER_STACK} export=${EXPORT_NAME} param=${SHARED_PARAM}"

CDKL_PID=""
# Every serve this run started: cleanup removes their containers by pid even
# after a run's CDKL_PID was cleared (a leftover found by terminate_run).
RUN_PIDS=()
OUT_FILE="$(mktemp)"
WE_CREATED_STACKS=0

containers_of() {
  docker ps -a --filter "name=cdkl-microvm-$1-" --format '{{.Names}}' || true
}

stop_server() {
  if [ -n "${CDKL_PID}" ] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do kill -0 "${CDKL_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
}

cleanup() {
  rc=$?
  stop_server
  for pid in ${RUN_PIDS[@]+"${RUN_PIDS[@]}"}; do
    for name in $(containers_of "${pid}"); do docker rm -f "${name}" >/dev/null 2>&1 || true; done
  done
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

# Boot `cdkl start-microvm` in the background and wait for its banner.
boot_run() {
  : > "${OUT_FILE}"
  ${CLI} start-microvm "$@" --platform "${PLATFORM}" > "${OUT_FILE}" 2>&1 &
  CDKL_PID=$!
  RUN_PIDS+=("${CDKL_PID}")
  for _ in $(seq 1 480); do
    grep -q 'Press ^C to terminate the MicroVM(s).' "${OUT_FILE}" && return 0
    kill -0 "${CDKL_PID}" 2>/dev/null || fail "start-microvm exited before it was ready"
    sleep 0.5
  done
  fail "start-microvm did not print its ready banner in time"
}

# SIGTERM the run, wait for THAT pid to exit 0, and require its containers gone.
terminate_run() {
  local pid="${CDKL_PID}"
  kill -TERM "${pid}"
  set +e
  wait "${pid}"
  local rc=$?
  set -e
  CDKL_PID=""
  [ "${rc}" -eq 0 ] || fail "start-microvm exited ${rc} on SIGTERM (want 0)"
  local left
  left="$(containers_of "${pid}")"
  [ -z "${left}" ] || fail "leftover MicroVM container(s) after SIGTERM: ${left}"
}

echo "[verify] step 1: install + build cdk-local, fixture deps, base image"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
[ -d node_modules ] || vp install --prefer-offline
[ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || fail "the fixture-pinned aws-cdk CLI is not installed"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform "${PLATFORM}" "${BASE_IMAGE}" >/dev/null

echo "[verify] step 2: pre-flight — neither stack may already exist; pick the base image version"
for stack in "${PRODUCER_STACK}" "${CONSUMER_STACK}"; do
  if aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] FAIL: ${stack} already exists — clean up first via:"
    echo "          aws cloudformation delete-stack --stack-name ${stack} --region ${REGION}"
    exit 1
  fi
done
BASE_ARN="arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1"
MICROVM_BASE_IMAGE_VERSION="$(aws lambda-microvms list-managed-microvm-image-versions \
  --image-identifier "${BASE_ARN}" --region "${REGION}" \
  --query "items[?status=='AVAILABLE'].imageVersion" --output text | tr '\t' '\n' | sort -n | tail -1)"
[ -n "${MICROVM_BASE_IMAGE_VERSION}" ] || fail "no AVAILABLE version of ${BASE_ARN}"
export MICROVM_BASE_IMAGE_VERSION
echo "[verify]   base image ${BASE_ARN} version ${MICROVM_BASE_IMAGE_VERSION}"

echo "[verify] step 3: cdk deploy producer + consumer (pinned upstream CDK CLI; waits for the image build)"
WE_CREATED_STACKS=1
cdk deploy "${PRODUCER_STACK}" "${CONSUMER_STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
REF_PHYSICAL="$(aws cloudformation list-stack-resources --stack-name "${CONSUMER_STACK}" --region "${REGION}" \
  --query "StackResourceSummaries[?ResourceType=='AWS::SSM::Parameter'].PhysicalResourceId | [0]" --output text)"
[ -n "${REF_PHYSICAL}" ] && [ "${REF_PHYSICAL}" != "None" ] || fail "no deployed SSM parameter physical id"
echo "[verify]   parameter=${REF_PHYSICAL}"
TARGET="${CONSUMER_STACK}/Image"

echo "[verify] step 4: baseline (no --from-cfn-stack) — intrinsic env vars are dropped"
boot_run "${TARGET}" --port "${PORT}"
BODY="$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/")"
echo "${BODY}" | grep -q '"staticValue":"always-the-same"' || fail "literal env missing: ${BODY}"
echo "${BODY}" | grep -q '"refValue":null' || fail "Ref env not dropped without a state source: ${BODY}"
echo "${BODY}" | grep -q '"importedValue":null' || fail "ImportValue env not dropped: ${BODY}"
echo "${BODY}" | grep -q '"getattValue":null' || fail "GetAtt env not dropped: ${BODY}"
for key in REF_VALUE IMPORTED_VALUE GETATT_VALUE; do
  grep -q "Environment variable ${key} contains a CloudFormation intrinsic and was dropped" "${OUT_FILE}" \
    || fail "no drop warning for ${key}"
done
terminate_run

echo "[verify] step 5: --from-cfn-stack — Ref and Fn::ImportValue resolve, Fn::GetAtt is warned and dropped"
boot_run "${TARGET}" --from-cfn-stack --port "$((PORT + 1))"
BODY="$(curl -s --max-time 10 "http://127.0.0.1:$((PORT + 1))/")"
echo "${BODY}" | grep -q "\"refValue\":\"${REF_PHYSICAL}\"" || fail "Ref not resolved to ${REF_PHYSICAL}: ${BODY}"
echo "${BODY}" | grep -q "\"importedValue\":\"${SHARED_VALUE}\"" || fail "ImportValue not resolved: ${BODY}"
echo "${BODY}" | grep -q '"getattValue":null' || fail "GetAtt unexpectedly resolved: ${BODY}"
echo "${BODY}" | grep -q '"staticValue":"always-the-same"' || fail "literal env regressed: ${BODY}"
# One line carries the whole warning. A line naming GETATT_VALUE and
# "could not substitute" without the full phrase means the wording drifted.
GETATT_RE='could not substitute env var GETATT_VALUE \(.*\)\. Override it via --env-vars or it will be dropped'
if ! grep -Eq "${GETATT_RE}" "${OUT_FILE}"; then
  DRIFTED="$(grep 'GETATT_VALUE' "${OUT_FILE}" | grep 'could not substitute' | head -1 || true)"
  [ -z "${DRIFTED}" ] || fail "the GetAtt warning wording drifted: ${DRIFTED}"
  fail "no GetAtt substitution warning"
fi
echo "[verify]   ${BODY}"
terminate_run

echo "[verify] step 6: delete the stacks (consumer first, then producer)"
delete_stack "${CONSUMER_STACK}"
delete_stack "${PRODUCER_STACK}"
WE_CREATED_STACKS=0

echo "[verify] PASS"
