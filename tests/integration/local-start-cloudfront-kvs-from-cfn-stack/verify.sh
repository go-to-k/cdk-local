#!/usr/bin/env bash
#
# Real-AWS validation for `cdkl start-cloudfront --from-cfn-stack` against a
# CloudFront KeyValueStore (issue #399).
#
# A CloudFront Function's `cf.kvs().get(key)` read is served by the real
# `cloudfront-keyvaluestore` `GetKey` data-plane API: --from-cfn-stack resolves
# the deployed store's ARN from the stack's resources, then a local request
# reads the DEPLOYED key. The only way to exercise the GetKey round-trip + the
# deployed-ARN resolution is to deploy via the upstream `cdk` CLI and serve
# locally. No Docker (pure S3 + KVS + CloudFront Function).
#
# Steps:
#   1. install + build cdk-local + fixture deps
#   2. pre-flight orphan scan, then cdk deploy (upstream CDK CLI), which seeds
#      the KeyValueStore with /go -> /foo/index.html
#   3. --from-cfn-stack: serve the distribution + GET /go -> assert the KVS
#      rewrite to /foo/index.html fired (the deployed store's value, read via
#      GetKey)
#   4. baseline (no --from-cfn-stack): GET /go -> the read fails (no binding),
#      so /go is served unrewritten (404, NOT the foo page)
#   5. cdk destroy --force + port sweep
#
# Run via `/run-integ local-start-cloudfront-kvs-from-cfn-stack`. Requires AWS
# credentials with deploy permissions + `cloudfront-keyvaluestore:GetKey`, and
# the global `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalStartCfKvsFromCfnFixture"
TARGET="${STACK}/SiteDist"
PORT_CFN=18391
PORT_BASE=18392

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-cloudfront-kvs-from-cfn-stack"
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

# boot_and_get <port> <uri> <body-out> [extra cdkl flags...]
boot_and_get() {
  local port="$1" uri="$2" body_out="$3"
  shift 3
  : > "${OUT_FILE}"
  if lsof -ti "tcp:${port}" >/dev/null 2>&1; then
    lsof -ti "tcp:${port}" | xargs -r kill -9 || true
  fi
  # -c withDistribution=true synths the distribution side locally (the deployed
  # stack is store-only); --from-cfn-stack (when passed) resolves the KVS ARN.
  ${CLI} start-cloudfront "${TARGET}" --port "${port}" -c withDistribution=true "$@" \
    > "${OUT_FILE}" 2>&1 &
  CDKL_PID=$!
  local booted=0
  for _ in $(seq 1 240); do
    if grep -q "CloudFront distribution serving on" "${OUT_FILE}"; then booted=1; break; fi
    kill -0 "${CDKL_PID}" 2>/dev/null || fail "server exited before it was ready"
    sleep 0.5
  done
  [ "${booted}" -eq 1 ] || fail "server did not print its ready banner in time"
  curl -s -o "${body_out}" -w '%{http_code}' "http://127.0.0.1:${port}${uri}" > "${body_out}.code" || true
  stop_server
}

echo "[verify] region=${REGION} stack=${STACK}"

echo "[verify] step 1: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
echo "[verify] step 1b: install fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 2b: cdk deploy (upstream CDK CLI) — seeds the KeyValueStore"
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 2b ok: cdk deploy completed"

echo "[verify] step 3: --from-cfn-stack — GET /go reads the deployed store via GetKey"
boot_and_get "${PORT_CFN}" "/go" "${BODY_FILE}" --from-cfn-stack
echo "[verify]   status=$(cat "${BODY_FILE}.code") body=$(cat "${BODY_FILE}")"
grep -qi "foo page" "${BODY_FILE}" \
  || fail "--from-cfn-stack did not rewrite /go to /foo/index.html via the deployed KeyValueStore (GetKey)"

echo "[verify] step 4: baseline (no --from-cfn-stack) — /go is NOT rewritten"
boot_and_get "${PORT_BASE}" "/go" "${BODY_FILE}"
echo "[verify]   status=$(cat "${BODY_FILE}.code") body=$(cat "${BODY_FILE}")"
if grep -qi "foo page" "${BODY_FILE}"; then
  fail "baseline (no --from-cfn-stack) should NOT have rewritten /go (the KVS read should fail unbound)"
fi
grep -qi "no binding resolved it" "${OUT_FILE}" \
  || fail "baseline did not warn that the KeyValueStore association was unbound"

rm -f "${BODY_FILE}.code"
echo "[verify] PASS: start-cloudfront --from-cfn-stack read the deployed CloudFront KeyValueStore via GetKey and rewrote /go to /foo/index.html; baseline left it unbound."
