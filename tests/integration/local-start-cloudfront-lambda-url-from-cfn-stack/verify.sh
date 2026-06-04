#!/usr/bin/env bash
#
# Real-AWS validation for `cdkl start-cloudfront --from-cfn-stack` on a Lambda
# Function URL origin (issue #380).
#
# The front-door Lambda path (start-cloudfront's Function URL origin) now
# resolves its container env through the SAME shared helper as `cdkl invoke`,
# so a Function URL origin Lambda gets its declared env vars + --from-cfn-stack
# intrinsic substitution + --assume-role creds. The only way to exercise the
# state round-trip is to deploy via the upstream `cdk` CLI and serve locally.
#
# Steps:
#   1. install + build cdk-local + fixture deps + docker pull
#   2. pre-flight orphan scan, then cdk deploy (upstream CDK CLI)
#   3. read the deployed DynamoDB table's physical name from CloudFormation
#   4. --from-cfn-stack: serve the distribution + curl through the CDN ->
#      assert the Lambda saw TABLE_NAME == the deployed table name (intrinsic
#      env var resolved), STATIC_VALUE == the literal, and the viewer-response
#      header is stamped.
#   5. baseline (no --from-cfn-stack): assert TABLE_NAME == "unset" (the
#      intrinsic is dropped) while STATIC_VALUE still passes through.
#   6. cdk destroy --force + Lambda container / port sweep.
#
# Run via `/run-integ local-start-cloudfront-lambda-url-from-cfn-stack`.
# Requires Docker, AWS credentials with deploy permissions, and the global
# `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalStartCfFnUrlFromCfnFixture"
TARGET="${STACK}/ApiDist"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT_CFN=18381
PORT_BASE=18382

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-cloudfront-lambda-url-from-cfn-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

CDKL_PID=""
WE_CREATED_STACK=0
OUT_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"

stop_server() {
  if [ -n "${CDKL_PID}" ] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "${CDKL_PID}" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  CDKL_PID=""
}

cleanup() {
  rc=$?
  stop_server
  # Belt-and-suspenders: remove any Function URL origin Lambda container.
  docker ps -aq --filter name=cdkl-alblambda- | xargs -r docker rm -f >/dev/null 2>&1 || true
  if [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] teardown: cdk destroy ${STACK}"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  rm -f "${OUT_FILE}" "${BODY_FILE}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "----- server output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

# boot_and_get <port> <body-out> [extra cdkl flags...]
# Boots `cdkl start-cloudfront` and GETs `/` through the CDN once.
boot_and_get() {
  local port="$1" body_out="$2"
  shift 2
  : > "${OUT_FILE}"
  if lsof -ti "tcp:${port}" >/dev/null 2>&1; then
    lsof -ti "tcp:${port}" | xargs -r kill -9 || true
  fi
  ${CLI} start-cloudfront "${TARGET}" --port "${port}" --no-pull "$@" > "${OUT_FILE}" 2>&1 &
  CDKL_PID=$!
  local booted=0
  for _ in $(seq 1 240); do
    if grep -q "CloudFront distribution serving on" "${OUT_FILE}"; then booted=1; break; fi
    kill -0 "${CDKL_PID}" 2>/dev/null || fail "server exited before it was ready"
    sleep 0.5
  done
  [ "${booted}" -eq 1 ] || fail "server did not print its ready banner in time"
  curl -fsS -D "${OUT_FILE}.hdr" -o "${body_out}" "http://127.0.0.1:${port}/" || fail "GET / failed"
  stop_server
}

echo "[verify] region=${REGION} stack=${STACK}"

echo "[verify] step 1: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
echo "[verify] step 1b: docker available + pull ${IMAGE}"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull "${IMAGE}"
echo "[verify] step 1c: install fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 2b: cdk deploy (upstream CDK CLI)"
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 2b ok: cdk deploy completed"

echo "[verify] step 3: read the deployed DynamoDB table name"
DEPLOYED_TABLE=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query 'StackResources[?ResourceType==`AWS::DynamoDB::Table`].PhysicalResourceId | [0]' \
  --output text)
echo "[verify]   deployed table: ${DEPLOYED_TABLE}"
[ -n "${DEPLOYED_TABLE}" ] && [ "${DEPLOYED_TABLE}" != "None" ] \
  || fail "could not read deployed table name from CloudFormation"

echo "[verify] step 4: --from-cfn-stack — serve the distribution + GET / through the CDN"
boot_and_get "${PORT_CFN}" "${BODY_FILE}" --from-cfn-stack
echo "[verify]   response: $(cat "${BODY_FILE}")"
grep -q "\"tableName\":\"${DEPLOYED_TABLE}\"" "${BODY_FILE}" \
  || fail "--from-cfn-stack did not resolve TABLE_NAME to the deployed table '${DEPLOYED_TABLE}'"
grep -q '"staticValue":"static-ok"' "${BODY_FILE}" || fail "STATIC_VALUE literal not present"
grep -qi "x-cdkl-fixture: lambda-url-from-cfn" "${OUT_FILE}.hdr" \
  || fail "viewer-response header not stamped over the Lambda origin response"

echo "[verify] step 5: baseline (no --from-cfn-stack) — TABLE_NAME drops"
boot_and_get "${PORT_BASE}" "${BODY_FILE}"
echo "[verify]   response: $(cat "${BODY_FILE}")"
grep -q '"tableName":"unset"' "${BODY_FILE}" \
  || fail "baseline (no --from-cfn-stack) should have dropped the intrinsic TABLE_NAME to 'unset'"
grep -q '"staticValue":"static-ok"' "${BODY_FILE}" || fail "STATIC_VALUE literal not present in baseline"

rm -f "${OUT_FILE}.hdr"
echo "[verify] PASS: start-cloudfront --from-cfn-stack resolved the Function URL origin Lambda's intrinsic TABLE_NAME to the deployed table; baseline dropped it."
