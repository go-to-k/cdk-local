#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl invoke-agentcore` fromS3 bundles
# with an INTRINSIC `Code.S3.Bucket` resolved via `--from-cfn-stack` (issue #157).
#
# The fixture stack creates a CDK-managed `s3.Bucket` and passes its `Ref`
# (`bucket.bucketName`) as the `fromS3` artifact bucket — the common
# "create the bundle bucket alongside the agent" pattern that the literal-bucket
# path (#144) can't resolve locally.
#
# `AWS::BedrockAgentCore::Runtime` CFn validates the bundle object exists at
# create time, so the test deploys in TWO PASSES:
#   1. `cdk deploy -c withRuntime=false` creates just the bucket,
#   2. verify.sh zips + uploads the code-agent bundle,
#   3. `cdk deploy -c withRuntime=true` adds the Runtime referencing the
#      now-populated bucket via `bucket.bucketName` (a same-stack `Ref`).
#   4. `cdkl invoke-agentcore <target> --from-cfn-stack` resolves the Ref to
#      the deployed bucket's physical name and downloads the bundle.
#   5. `cdk destroy` removes everything (autoDeleteObjects empties the bucket).
#
# Run via `/run-integ local-invoke-agentcore-froms3-from-cfn` (recommended).
# Requires Docker, AWS credentials with deploy + S3 permissions, and the global
# `cdk` CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalInvokeAgentCoreFromS3FromCfnFixture"
TARGET="${STACK}/S3Agent"
CODE_BASE_IMAGE="public.ecr.aws/docker/library/python:3.12-slim"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-agentcore-froms3-from-cfn"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} fromS3 intrinsic Code.S3.Bucket (Ref) + --from-cfn-stack"

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

WE_CREATED_STACK=0
EVENT_FILE=""
cleanup() {
  rc=$?
  if [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] cleanup: cdk destroy ${STACK} (autoDeleteObjects empties the bucket)"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  rm -f "${TEST_DIR}/bundle.zip"
  [ -n "${EVENT_FILE}" ] && rm -f "${EVENT_FILE}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists — clean up first via:"
  echo "          cdk destroy ${STACK} --force --region ${REGION}"
  exit 1
fi

echo "[verify] step 3a: cdk deploy (bucket-only, withRuntime=false)"
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  -c withRuntime=false \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3a ok: bucket deployed"

echo "[verify] step 3b: read the deployed bucket name from the stack output"
BUCKET=$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='BundleBucketName'].OutputValue" --output text)
if [ -z "${BUCKET}" ] || [ "${BUCKET}" = "None" ]; then
  echo "[verify] FAIL: could not read BundleBucketName stack output"
  exit 1
fi
echo "[verify]   bundle bucket: s3://${BUCKET}"

echo "[verify] step 3c: zip code-agent/ and upload as the bundle object (before Runtime create)"
rm -f "${TEST_DIR}/bundle.zip"
(cd "${TEST_DIR}/code-agent" && zip -qr "${TEST_DIR}/bundle.zip" . -x '*.pyc' '__pycache__/*')
aws s3 cp "${TEST_DIR}/bundle.zip" "s3://${BUCKET}/bundles/agent.zip" --region "${REGION}" >/dev/null

echo "[verify] step 3d: cdk deploy (withRuntime=true) — Runtime validates the bundle exists"
cdk deploy "${STACK}" \
  -c withRuntime=true \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3d ok: Runtime deployed"

echo "[verify] step 6: cdkl invoke-agentcore --from-cfn-stack (resolves Ref -> ${BUCKET})"
set +e
# cdkl runs the same CDK app — pass -c withRuntime=true so the synth includes
# the Runtime resource the deployed stack also has.
OUT_STEP6=$(${CLI} invoke-agentcore "${TARGET}" --from-cfn-stack -c withRuntime=true 2>&1)
RC_STEP6=$?
set -e
RESULT=$(echo "${OUT_STEP6}" | tail -1)
echo "[verify]   exit=${RC_STEP6}"
echo "[verify]   response: ${RESULT}"
[[ ${RC_STEP6} -eq 0 ]] || {
  echo "[verify] FAIL: cdkl invoke-agentcore exited ${RC_STEP6}. Full output:"
  echo "${OUT_STEP6}" | tail -40
  exit 1
}
echo "${RESULT}" | grep -q '"runtime":"python-froms3-ref"' || {
  echo "[verify] FAIL: expected the fromS3-via-Ref from-source agent to respond, got: ${RESULT}"
  exit 1
}
echo "${RESULT}" | grep -q '"greeting":"hello-from-s3-ref"' || {
  echo "[verify] FAIL: expected GREETING=hello-from-s3-ref (env injected), got: ${RESULT}"
  exit 1
}

echo "[verify] step 7: WITHOUT --from-cfn-stack, intrinsic Code.S3.Bucket fails fast"
set +e
OUT_NO_STATE=$(${CLI} invoke-agentcore "${TARGET}" -c withRuntime=true 2>&1)
RC_NO_STATE=$?
set -e
[[ ${RC_NO_STATE} -ne 0 ]] || {
  echo "[verify] FAIL: expected a non-zero exit without --from-cfn-stack, got 0. Output: ${OUT_NO_STATE}"
  exit 1
}
echo "${OUT_NO_STATE}" | grep -q -- "--from-cfn-stack" || {
  echo "[verify] FAIL: expected an actionable 'pass --from-cfn-stack' error, got: ${OUT_NO_STATE}"
  exit 1
}

echo "[verify] step 8: --event payload echoes through the fromS3-via-Ref agent"
EVENT_FILE="$(mktemp)"
echo '{"prompt":"hello froms3 ref"}' > "${EVENT_FILE}"
RESULT_EVENT=$(${CLI} invoke-agentcore "${TARGET}" --from-cfn-stack -c withRuntime=true --event "${EVENT_FILE}" 2>/dev/null | tail -1)
echo "[verify]   response: ${RESULT_EVENT}"
echo "${RESULT_EVENT}" | grep -q '"prompt":"hello froms3 ref"' || {
  echo "[verify] FAIL: expected the echoed event from the fromS3-via-Ref agent, got: ${RESULT_EVENT}"
  exit 1
}

echo "[verify] step 9: cdk destroy (autoDeleteObjects empties the bucket)"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata
WE_CREATED_STACK=0
echo "[verify]   destroyed ${STACK}"

echo ""
echo "[verify] All local-invoke-agentcore-froms3-from-cfn checks passed"
