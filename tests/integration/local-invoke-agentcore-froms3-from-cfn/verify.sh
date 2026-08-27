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
# create time. The stack handles this via a `BucketDeployment` custom resource
# the Runtime `addDependency`s, so a SINGLE `cdk deploy` uploads the bundle
# and creates the Runtime in the right order (issue #162). verify.sh just has
# to zip the code-agent into `bundle-source/agent.zip` BEFORE the deploy so
# the BucketDeployment asset picks it up.
#
# Run via `/run-integ local-invoke-agentcore-froms3-from-cfn` (recommended).
# Requires Docker, AWS credentials with deploy + S3 permissions, and the global
# `cdk` CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
# Lane-unique stack name (issue #582): every AWS-deploying fixture used to
# hard-code ONE name, so two worktree lanes shared one CloudFormation stack.
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
STACK="$(integ_stack_name CdkLocalInvokeAgentCoreFromS3FromCfnFixture)"
TARGET="${STACK}/S3Agent"
CODE_BASE_IMAGE="public.ecr.aws/docker/library/python:3.12-slim"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-agentcore-froms3-from-cfn"
CLI="node ${REPO_ROOT}/dist/cli.js"

# --- capture (issue #577) --------------------------------------------------
# Under `set -euo pipefail` the shape
#     VAR=$(${CLI} invoke ... 2>/dev/null | tail -1)
# aborts the WHOLE script at the ASSIGNMENT when the CLI exits non-zero:
# pipefail fails the pipeline, the command substitution fails, and `set -e`
# kills the script BEFORE the grep, before the FAIL message, and before the
# stderr re-run each FAIL branch does for diagnosis. The operator is left
# with no response, no assertion and no stderr -- and for a *-from-cfn-stack
# fixture the EXIT trap then destroys the stack, taking the evidence too.
#
# `capture` runs the command with its exit status captured EXPLICITLY, so
# `set -e` never fires. On a non-zero exit it prints the status and the tail
# of the captured stderr, then still emits the (possibly empty) last stdout
# line, so the assertion runs, FAILS, and prints its own diagnostic -- with
# the evidence in the log. On the happy path it emits the last NON-BLANK line of
# stdout with stderr suppressed. That differs from the old shape only when stdout
# ends in blank lines: the old shape yielded an empty string there, this yields
# the last non-blank line.
CDKL_STDERR="$(mktemp)"
# Registered immediately, matching the other fixtures: `trap cleanup EXIT` is
# installed further down, so without this a failure in between leaks the file.
trap 'rm -f "${CDKL_STDERR}"' EXIT
capture() {
  local out rc=0
  out="$("$@" 2>"${CDKL_STDERR}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] command exited ${rc}: $*" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "${CDKL_STDERR}" >&2
  fi
  printf '%s\n' "${out}" | tail -1
}

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
  # rc=$? MUST be the first statement: it captures the SCRIPT's exit status.
  # Any command above it (an `rm -f`, which always succeeds) overwrites $? and
  # makes the `exit "${rc}"` below report 0 for a FAILED run.
  rc=$?
  rm -f "${CDKL_STDERR}"
  if [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] cleanup: cdk destroy ${STACK} (autoDeleteObjects empties the bucket)"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  rm -rf "${TEST_DIR}/bundle-source"
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

echo "[verify] step 3: stage bundle-source/agent.zip for the BucketDeployment asset"
rm -rf "${TEST_DIR}/bundle-source"
mkdir -p "${TEST_DIR}/bundle-source"
(cd "${TEST_DIR}/code-agent" && zip -qr "${TEST_DIR}/bundle-source/agent.zip" . -x '*.pyc' '__pycache__/*')

echo "[verify] step 4: cdk deploy (BucketDeployment uploads bundle before the Runtime)"
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 4 ok: bucket + bundle + Runtime deployed in one pass"

echo "[verify] step 5: read the deployed bucket name from the stack output (for the log)"
BUCKET=$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='BundleBucketName'].OutputValue" --output text)
if [ -z "${BUCKET}" ] || [ "${BUCKET}" = "None" ]; then
  echo "[verify] FAIL: could not read BundleBucketName stack output"
  exit 1
fi
echo "[verify]   bundle bucket: s3://${BUCKET}"

echo "[verify] step 6: cdkl invoke-agentcore --from-cfn-stack (resolves Ref -> ${BUCKET})"
set +e
OUT_STEP6=$(${CLI} invoke-agentcore "${TARGET}" --from-cfn-stack 2>&1)
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
OUT_NO_STATE=$(${CLI} invoke-agentcore "${TARGET}" 2>&1)
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
RESULT_EVENT=$(capture ${CLI} invoke-agentcore "${TARGET}" --from-cfn-stack --event "${EVENT_FILE}")
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
