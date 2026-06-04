#!/usr/bin/env bash
#
# Real-AWS validation for `cdkl start-cloudfront --from-cfn-stack` serving an S3
# origin from the DEPLOYED bucket on demand (issue #405).
#
# The front/back-split case: the CDK repo defines the CloudFront distribution +
# S3 bucket, but the static files are uploaded out of band (a separate frontend
# repo / pipeline), so there is NO BucketDeployment source asset to serve
# locally. --from-cfn-stack resolves the deployed bucket's physical NAME from
# the stack's resources (ListStackResources), and a local request reads the
# object from real S3 on demand (GetObject). The only way to exercise the
# deployed-bucket resolution + the real-S3 read is to deploy via the upstream
# `cdk` CLI, upload content out of band, and serve locally. No Docker (pure S3
# + CloudFront routing).
#
# Steps:
#   1. install + build cdk-local + fixture deps
#   2. pre-flight orphan scan, then cdk deploy (upstream CDK CLI) — the BUCKET
#      ALONE (the slow CloudFront distribution is local-synth-only)
#   3. upload content OUT OF BAND (aws s3 cp), i.e. NO BucketDeployment
#   4. --from-cfn-stack: GET / -> the deployed bucket's index.html (read from
#      real S3); GET a nested asset; GET a missing route -> the SPA fallback
#   5. baseline (no --from-cfn-stack): the S3 origin is unresolved -> 502
#   6. cdk destroy --force (autoDeleteObjects empties the bucket) + port sweep
#
# Run via `/run-integ local-start-cloudfront-s3-from-cfn-stack`. Requires AWS
# credentials with deploy permissions + s3:PutObject / s3:GetObject on the
# fixture bucket, and the global `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalStartCfS3FromCfnFixture"
TARGET="${STACK}/SiteDist"
PORT_CFN=18394
PORT_BASE=18395

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-cloudfront-s3-from-cfn-stack"
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
    echo "[verify] teardown: cdk destroy ${STACK}"
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
  # -c withDistribution=true synths the distribution side locally (the deployed
  # stack is bucket-only); --from-cfn-stack (when passed) resolves the bucket.
  ${CLI} start-cloudfront "${TARGET}" --port "${port}" --region "${REGION}" \
    -c withDistribution=true "$@" > "${OUT_FILE}" 2>&1 &
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

echo "[verify] step 2b: cdk deploy (upstream CDK CLI) — the bucket only"
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
echo '<h1>deployed s3 root</h1>' > "${BODY_FILE}"
aws s3 cp "${BODY_FILE}" "s3://${BUCKET}/index.html" --content-type text/html --region "${REGION}"
echo 'console.log("deployed asset");' > "${BODY_FILE}"
aws s3 cp "${BODY_FILE}" "s3://${BUCKET}/assets/app.js" --content-type text/javascript --region "${REGION}"

echo "[verify] step 4a: --from-cfn-stack — GET / serves the deployed index.html from real S3"
boot_and_get "${PORT_CFN}" "/" "${BODY_FILE}" --from-cfn-stack
echo "[verify]   status=$(cat "${BODY_FILE}.code") body=$(cat "${BODY_FILE}")"
[ "$(cat "${BODY_FILE}.code")" = "200" ] || fail "GET / did not return 200 from the deployed S3 origin"
grep -qi "deployed s3 root" "${BODY_FILE}" \
  || fail "GET / did not serve the out-of-band-uploaded index.html from real S3"
grep -qi "serving from deployed S3" "${OUT_FILE}" \
  || fail "boot did not log the deployed-S3 origin promotion"

echo "[verify] step 4b: --from-cfn-stack — GET a nested asset"
boot_and_get "${PORT_CFN}" "/assets/app.js" "${BODY_FILE}" --from-cfn-stack
echo "[verify]   status=$(cat "${BODY_FILE}.code")"
[ "$(cat "${BODY_FILE}.code")" = "200" ] || fail "GET /assets/app.js did not return 200"
grep -qi "deployed asset" "${BODY_FILE}" || fail "GET /assets/app.js did not serve the uploaded asset"

echo "[verify] step 4c: --from-cfn-stack — a missing route falls back to the SPA index (CustomErrorResponses)"
boot_and_get "${PORT_CFN}" "/does/not/exist" "${BODY_FILE}" --from-cfn-stack
echo "[verify]   status=$(cat "${BODY_FILE}.code") body=$(cat "${BODY_FILE}")"
[ "$(cat "${BODY_FILE}.code")" = "200" ] || fail "missing route did not return the 200 SPA fallback"
grep -qi "deployed s3 root" "${BODY_FILE}" \
  || fail "missing route did not fall back to /index.html from real S3"

echo "[verify] step 5: baseline (no --from-cfn-stack) — the S3 origin is unresolved -> 502"
boot_and_get "${PORT_BASE}" "/" "${BODY_FILE}"
echo "[verify]   status=$(cat "${BODY_FILE}.code")"
[ "$(cat "${BODY_FILE}.code")" = "502" ] \
  || fail "baseline (no --from-cfn-stack) should 502 on the unresolved S3 origin"
grep -qi "no resolvable local source" "${OUT_FILE}" \
  || fail "baseline did not warn that the S3 origin had no resolvable local source"

echo "[verify] PASS: start-cloudfront --from-cfn-stack resolved the deployed bucket and served its out-of-band content from real S3 on demand (root, nested asset, SPA fallback); baseline left the origin unresolved (502)."
