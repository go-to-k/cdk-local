#!/usr/bin/env bash
#
# Real-AWS validation for `cdkl start-cloudfront --from-cfn-stack` resolving a
# deployed S3 origin whose bucket name is a PURE INTRINSIC, via
# `cloudfront:GetDistributionConfig` (issue #405 follow-up).
#
# The fixture's distribution origin DomainName is `Fn::Sub
# '${BN}.s3.${AWS::Region}.amazonaws.com'` (BN = the bucket name) — locally
# cdk-local cannot derive the bucket name (the label is the Sub var `${BN}`, not
# a literal and not a same-stack Fn::GetAtt), so it reads the DEPLOYED
# distribution config and parses the bucket name from the resolved origin
# DomainName. Exercising that requires a real deployed CloudFront distribution.
#
# NOTE: this deploys + destroys a CloudFront distribution, so it is SLOW
# (create + the disable-then-delete teardown can take 15-30 min total). The
# distribution is never served through — cdk-local reads the bucket directly
# with the dev credentials; the distribution only needs to exist for
# GetDistributionConfig.
#
# Steps:
#   1. install + build cdk-local + fixture deps
#   2. pre-flight orphan scan, then cdk deploy (bucket + CloudFront distribution)
#   3. upload content OUT OF BAND (aws s3 cp), i.e. NO BucketDeployment
#   4. --from-cfn-stack: GET / + a missing-route SPA fallback served from real S3
#      with the bucket resolved via GetDistributionConfig
#   5. baseline (no --from-cfn-stack): the origin is unresolved -> 502
#   6. cdk destroy --force (autoDeleteObjects empties the bucket) + port sweep
#
# Run via `/run-integ local-start-cloudfront-extbucket-from-cfn-stack`. Requires
# AWS credentials with CloudFront + S3 deploy permissions +
# `cloudfront:GetDistributionConfig` + `s3:GetObject` / `s3:PutObject`, and the
# global `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalStartCfExtBucketFromCfnFixture"
TARGET="${STACK}/Dist"
PORT_CFN=18396
PORT_BASE=18397

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-cloudfront-extbucket-from-cfn-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

CDKL_PID=""
WE_CREATED_STACK=0
BUCKET=""
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
    echo "[verify] teardown: cdk destroy ${STACK} (CloudFront delete is slow)"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  rm -f "${OUT_FILE}" "${BODY_FILE}" "${BODY_FILE}.code"
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
  ${CLI} start-cloudfront "${TARGET}" --port "${port}" --region "${REGION}" "$@" \
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
  echo "          cdk destroy ${STACK} --force --region ${REGION}"
  exit 1
fi

echo "[verify] step 2b: cdk deploy (bucket + CloudFront distribution) — SLOW"
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 2b ok: cdk deploy completed"

echo "[verify] step 2c: resolve the deployed bucket name"
BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)"
[ -n "${BUCKET}" ] && [ "${BUCKET}" != "None" ] || fail "could not resolve the deployed bucket name"
echo "[verify]   bucket=${BUCKET}"

echo "[verify] step 3: upload content OUT OF BAND (no BucketDeployment)"
echo '<h1>ext bucket via GetDistributionConfig</h1>' > "${BODY_FILE}"
aws s3 cp "${BODY_FILE}" "s3://${BUCKET}/index.html" --content-type text/html --region "${REGION}"

echo "[verify] step 4a: --from-cfn-stack — GET / resolves the bucket via GetDistributionConfig"
boot_and_get "${PORT_CFN}" "/" "${BODY_FILE}" --from-cfn-stack
echo "[verify]   status=$(cat "${BODY_FILE}.code") body=$(cat "${BODY_FILE}")"
[ "$(cat "${BODY_FILE}.code")" = "200" ] || fail "GET / did not return 200 from the deployed S3 origin"
grep -qi "ext bucket via GetDistributionConfig" "${BODY_FILE}" \
  || fail "GET / did not serve the out-of-band-uploaded index.html"
grep -qi "resolved via GetDistributionConfig" "${OUT_FILE}" \
  || fail "boot did not log resolution via GetDistributionConfig"

echo "[verify] step 4b: --from-cfn-stack — a missing route falls back to the SPA index"
boot_and_get "${PORT_CFN}" "/does/not/exist" "${BODY_FILE}" --from-cfn-stack
echo "[verify]   status=$(cat "${BODY_FILE}.code")"
[ "$(cat "${BODY_FILE}.code")" = "200" ] || fail "missing route did not return the 200 SPA fallback"
grep -qi "ext bucket via GetDistributionConfig" "${BODY_FILE}" \
  || fail "missing route did not fall back to /index.html"

echo "[verify] step 5: baseline (no --from-cfn-stack) — the origin is unresolved -> 502"
boot_and_get "${PORT_BASE}" "/" "${BODY_FILE}"
echo "[verify]   status=$(cat "${BODY_FILE}.code")"
[ "$(cat "${BODY_FILE}.code")" = "502" ] \
  || fail "baseline (no --from-cfn-stack) should 502 on the unresolved origin"

echo "[verify] PASS: start-cloudfront --from-cfn-stack resolved the deployed bucket via GetDistributionConfig (pure-intrinsic origin domain) and served its out-of-band content from real S3 (root + SPA fallback); baseline left the origin unresolved (502)."
