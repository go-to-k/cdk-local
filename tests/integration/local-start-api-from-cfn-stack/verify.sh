#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl start-api --from-cfn-stack`.
#
# Why this exists: the originally-reported bug was on `start-api` — an
# env var set to `Fn::GetAtt <SiblingFn>.Arn` warn-and-dropped under
# `--from-cfn-stack` because `ListStackResources` returns physical IDs
# only (no attributes). This integ deploys a fixture stack via the
# upstream `cdk deploy` (CloudFormation, not a host CLI), starts the
# Function-URL-fronted echo Lambda locally with `cdkl start-api`, and
# asserts BOTH:
#   - existing behavior: TABLE_NAME (Ref) substitutes, STATIC_VALUE
#     (literal) passes through, and the baseline (no flag) drops both
#     intrinsics.
#   - new behavior: SIBLING_ARN (Fn::GetAtt .Arn) is recovered from the
#     deployed function's already-resolved Environment.Variables.
#
# Steps:
#   1. install + build cdk-local (root) + docker pull
#   2. cdk deploy CdkLocalStartApiFromCfnStackFixture (upstream CDK CLI)
#   3. read deployed table name + sibling ARN from AWS
#   4. baseline: cdkl start-api (no flag) — assert TABLE_NAME / SIBLING_ARN
#      come through as "unset" (intrinsic-valued, default warn-and-drop).
#   5. cdkl start-api --from-cfn-stack — assert TABLE_NAME is the deployed
#      table name and SIBLING_ARN is the deployed sibling ARN.
#   6. cdk destroy --force
#
# Run via `/run-integ local-start-api-from-cfn-stack` (recommended) or:
#
#     bash tests/integration/local-start-api-from-cfn-stack/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions. Also
# requires the global `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalStartApiFromCfnStackFixture"
IMAGE="public.ecr.aws/lambda/nodejs:20"
CONTAINER_HOST="127.0.0.1"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-api-from-cfn-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed)"

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

LOG_FILE="$(mktemp)"
SERVER_PID=""

# Stop the running start-api server (if any) between the baseline and
# --from-cfn-stack passes, and on exit. SIGTERM -> 60s grace -> SIGKILL.
stop_server() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      kill -KILL "${SERVER_PID}" 2>/dev/null || true
    fi
  fi
  SERVER_PID=""
}

# Gate the stack cleanup on a "we created the stack" sentinel so the EXIT
# trap never destroys a pre-existing same-named stack found by the
# pre-flight scan.
WE_CREATED_STACK=0
cleanup() {
  rc=$?
  stop_server
  # Defense-in-depth: kill every cdkl-* container regardless of how the
  # server cleaned up (catches a server that crashed before dispose()).
  ORPHANS=$(docker ps --filter "name=cdkl-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "[verify] cleaning up orphan containers"
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  rm -f "${LOG_FILE}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first via:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 3: cdk deploy (upstream CDK CLI)"
# Set the sentinel BEFORE `cdk deploy`: pre-flight verified the namespace
# is clean, so once we issue the deploy we OWN it (cdk destroy is a no-op
# on stacks that never reached AWS).
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

echo "[verify] step 4: read the deployed table name + sibling ARN from AWS"
DEPLOYED_TABLE=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query 'StackResources[?ResourceType==`AWS::DynamoDB::Table`].PhysicalResourceId | [0]' \
  --output text)
echo "[verify]   deployed table: ${DEPLOYED_TABLE}"
if [ -z "${DEPLOYED_TABLE}" ] || [ "${DEPLOYED_TABLE}" = "None" ]; then
  echo "[verify] FAIL: could not read deployed table name from CloudFormation"
  exit 1
fi
SIBLING_NAME=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function' && contains(LogicalResourceId, 'SiblingHandler')].PhysicalResourceId | [0]" \
  --output text)
if [ -z "${SIBLING_NAME}" ] || [ "${SIBLING_NAME}" = "None" ]; then
  echo "[verify] FAIL: could not read deployed sibling function name from CloudFormation"
  exit 1
fi
DEPLOYED_SIBLING_ARN=$(aws lambda get-function \
  --function-name "${SIBLING_NAME}" \
  --region "${REGION}" \
  --query 'Configuration.FunctionArn' \
  --output text)
echo "[verify]   deployed sibling ARN: ${DEPLOYED_SIBLING_ARN}"
if [ -z "${DEPLOYED_SIBLING_ARN}" ] || [ "${DEPLOYED_SIBLING_ARN}" = "None" ]; then
  echo "[verify] FAIL: could not read deployed sibling ARN from Lambda"
  exit 1
fi

# Start `cdkl start-api` with the given extra args, wait for the Function
# URL server to bind, and echo its port on stdout. The server PID lands
# in the global SERVER_PID so stop_server / cleanup can reap it.
start_server_and_get_port() {
  : >"${LOG_FILE}"
  # shellcheck disable=SC2086
  ${CLI} start-api \
    --container-host "${CONTAINER_HOST}" \
    --no-pull \
    "$@" \
    >"${LOG_FILE}" 2>&1 &
  SERVER_PID=$!

  local ready=0
  for _ in $(seq 1 60); do
    if grep -q "Server listening" "${LOG_FILE}" 2>/dev/null; then
      ready=1
      break
    fi
    # Bail early if the server died.
    kill -0 "${SERVER_PID}" 2>/dev/null || break
    sleep 0.5
  done
  if [[ "${ready}" -eq 0 ]]; then
    echo "[verify] FAIL: start-api server did not come up. Log:" >&2
    cat "${LOG_FILE}" >&2
    return 1
  fi
  grep -E 'Server listening on http://' "${LOG_FILE}" \
    | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1
}

# curl the Function URL server (serves any path) with a cold-boot retry.
curl_echo() {
  local port="$1"
  local response=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if response=$(curl -sf "http://127.0.0.1:${port}/" 2>&1); then
      if echo "${response}" | grep -q '"tableName":'; then
        printf '%s' "${response}"
        return 0
      fi
    fi
    sleep 1
  done
  echo "[verify] FAIL: no JSON echo from start-api server on port ${port}. Last: ${response}" >&2
  cat "${LOG_FILE}" >&2
  return 1
}

echo "[verify] step 5: baseline start-api (no --from-cfn-stack) — expect both intrinsics dropped"
PORT_BASELINE=$(start_server_and_get_port)
echo "[verify]   server on port ${PORT_BASELINE}"
RESULT_BASELINE=$(curl_echo "${PORT_BASELINE}")
echo "[verify]   response: ${RESULT_BASELINE}"
stop_server
echo "${RESULT_BASELINE}" | grep -q '"tableName":"unset"' || {
  echo "[verify] FAIL: expected TABLE_NAME=unset in baseline, got: ${RESULT_BASELINE}"; exit 1;
}
echo "${RESULT_BASELINE}" | grep -q '"siblingArn":"unset"' || {
  echo "[verify] FAIL: expected SIBLING_ARN=unset in baseline, got: ${RESULT_BASELINE}"; exit 1;
}
echo "${RESULT_BASELINE}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: expected STATIC_VALUE=always-the-same in baseline, got: ${RESULT_BASELINE}"; exit 1;
}

echo "[verify] step 6: cdkl start-api --from-cfn-stack — expect deployed values"
PORT_FROM_CFN=$(start_server_and_get_port --from-cfn-stack)
echo "[verify]   server on port ${PORT_FROM_CFN}"
RESULT_FROM_CFN=$(curl_echo "${PORT_FROM_CFN}")
echo "[verify]   response: ${RESULT_FROM_CFN}"
stop_server
echo "${RESULT_FROM_CFN}" | grep -q "\"tableName\":\"${DEPLOYED_TABLE}\"" || {
  echo "[verify] FAIL: expected TABLE_NAME=${DEPLOYED_TABLE}, got: ${RESULT_FROM_CFN}"; exit 1;
}
echo "${RESULT_FROM_CFN}" | grep -q "\"siblingArn\":\"${DEPLOYED_SIBLING_ARN}\"" || {
  echo "[verify] FAIL: expected SIBLING_ARN=${DEPLOYED_SIBLING_ARN} (deployed-env GetAtt fallback), got: ${RESULT_FROM_CFN}"; exit 1;
}
echo "${RESULT_FROM_CFN}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: STATIC_VALUE regressed under --from-cfn-stack, got: ${RESULT_FROM_CFN}"; exit 1;
}

echo "[verify] step 7: cdk destroy --force"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata

echo ""
echo "[verify] All checks passed:"
echo "[verify]   - existing behavior intact: TABLE_NAME (Ref) substituted, STATIC_VALUE (literal) passed through, baseline drops both intrinsics."
echo "[verify]   - new behavior: SIBLING_ARN (Fn::GetAtt .Arn) recovered from the deployed function's resolved env via start-api."
