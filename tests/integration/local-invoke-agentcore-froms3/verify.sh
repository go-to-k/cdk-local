#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl invoke-agentcore` fromS3
# CodeConfiguration bundles (issue #144).
#
# A fromS3 runtime points `AgentRuntimeArtifact.CodeConfiguration.Code.S3` at a
# pre-existing S3 object (a ZIP of the agent source). This test exercises the
# new download + extract + from-source build path against real S3:
#   - create a uniquely-named S3 bucket,
#   - zip the local `code-agent/` source and upload it as the bundle object,
#   - synth a stack whose `fromS3(...)` points at that literal bucket + key,
#   - `cdkl invoke-agentcore` downloads + extracts the bundle, builds it from
#     source (run the entrypoint as-is, no install), runs it on 8080, and POSTs the
#     event to /invocations,
#   - assert the response (runtime marker + injected GREETING + echoed event),
#   - delete the object + bucket.
#
# No CloudFormation deploy — fromS3 only needs the S3 object to exist; the
# template just references it. The agent itself runs locally in Docker.
#
# Run via `/run-integ local-invoke-agentcore-froms3` (recommended).
# Requires Docker and AWS credentials with s3:CreateBucket / PutObject /
# GetObject / DeleteObject / DeleteBucket on a fresh bucket.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalInvokeAgentCoreFromS3Fixture"
TARGET="${STACK}/S3Agent"
CODE_BASE_IMAGE="public.ecr.aws/docker/library/python:3.12-slim"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-agentcore-froms3"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} fromS3 bundle download + from-source build"

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${CODE_BASE_IMAGE} (one-time)"
docker pull --platform linux/arm64 "${CODE_BASE_IMAGE}" >/dev/null

echo "[verify] step 1d: installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SUFFIX="$(date +%s)-${RANDOM}"
BUCKET="cdkl-integ-froms3-${ACCOUNT_ID}-${REGION}-${SUFFIX}"
KEY="bundles/agent-${SUFFIX}.zip"

WE_CREATED_BUCKET=0
EVENT_FILE=""
cleanup() {
  rc=$?
  if [ "${WE_CREATED_BUCKET}" -eq 1 ]; then
    echo "[verify] cleanup: removing s3://${BUCKET}"
    aws s3 rm "s3://${BUCKET}" --recursive --region "${REGION}" >/dev/null 2>&1 || true
    aws s3api delete-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  rm -f "${TEST_DIR}/bundle.zip"
  [ -n "${EVENT_FILE}" ] && rm -f "${EVENT_FILE}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 2: create bucket s3://${BUCKET}"
WE_CREATED_BUCKET=1
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null
else
  aws s3api create-bucket --bucket "${BUCKET}" --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
fi

echo "[verify] step 3: zip code-agent/ and upload as the bundle object"
rm -f "${TEST_DIR}/bundle.zip"
(cd "${TEST_DIR}/code-agent" && zip -qr "${TEST_DIR}/bundle.zip" . -x '*.pyc' '__pycache__/*')
aws s3 cp "${TEST_DIR}/bundle.zip" "s3://${BUCKET}/${KEY}" --region "${REGION}" >/dev/null
echo "[verify]   uploaded s3://${BUCKET}/${KEY}"

echo "[verify] step 4: cdkl invoke-agentcore (fromS3 download + build + run)"
RESULT=$(${CLI} invoke-agentcore "${TARGET}" \
  -c "bundleBucket=${BUCKET}" -c "bundleKey=${KEY}" 2>/dev/null | tail -1)
echo "[verify]   response: ${RESULT}"
echo "${RESULT}" | grep -q '"runtime":"python-froms3"' || {
  echo "[verify] FAIL: expected the fromS3 from-source agent to respond, got: ${RESULT}"
  exit 1
}
echo "${RESULT}" | grep -q '"greeting":"hello-from-s3"' || {
  echo "[verify] FAIL: expected GREETING=hello-from-s3 (env injected), got: ${RESULT}"
  exit 1
}

echo "[verify] step 5: --event payload echoes through the fromS3 agent"
EVENT_FILE="$(mktemp)"
echo '{"prompt":"hello froms3"}' > "${EVENT_FILE}"
RESULT_EVENT=$(${CLI} invoke-agentcore "${TARGET}" \
  -c "bundleBucket=${BUCKET}" -c "bundleKey=${KEY}" --event "${EVENT_FILE}" 2>/dev/null | tail -1)
echo "[verify]   response: ${RESULT_EVENT}"
echo "${RESULT_EVENT}" | grep -q '"prompt":"hello froms3"' || {
  echo "[verify] FAIL: expected the echoed event from the fromS3 agent, got: ${RESULT_EVENT}"
  exit 1
}

echo ""
echo "[verify] All local-invoke-agentcore-froms3 checks passed"
