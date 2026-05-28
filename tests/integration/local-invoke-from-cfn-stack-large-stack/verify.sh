#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl invoke --from-cfn-stack`
# against a stack with MORE than 100 resources.
#
# Why this exists: the `--from-cfn-stack` provider reads the deployed
# stack's physical IDs from CloudFormation. CloudFormation's
# `DescribeStackResources` returns only the FIRST 100 resources of a
# stack (AWS-documented hard cap, no pagination token), so a stack with
# more than 100 resources silently loses its tail — every `Ref` to a
# dropped resource then warn-and-drops its Lambda env var. The provider
# must instead walk the paginated `ListStackResources`, which returns
# every resource across pages.
#
# The fixture stack has 105 SSM parameters + one Lambda (> 100 resources
# total). The Lambda's env carries one intrinsic-valued var per parameter
# (`Ref` -> parameter name) and returns how many survived substitution.
#
# Steps:
#   1. install + build cdk-local (root) + install fixture deps + docker pull
#   2. cdk deploy CdkLocalInvokeFromCfnStackLargeFixture (upstream CDK CLI)
#   3. baseline: cdkl invoke (no --from-cfn-stack) — assert paramCount=0
#      (every intrinsic-valued env var dropped via warn-and-drop).
#   4. cdkl invoke --from-cfn-stack — assert paramCount=105, i.e. ALL
#      parameters resolved even though the stack exceeds the 100-resource
#      DescribeStackResources cap, and STATIC_VALUE still passes through.
#   5. cdk destroy --force
#
# Run via `/run-integ local-invoke-from-cfn-stack-large-stack` (recommended)
# or directly:
#
#     bash tests/integration/local-invoke-from-cfn-stack-large-stack/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the
# target account. Also requires the global `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalInvokeFromCfnStackLargeFixture"
IMAGE="public.ecr.aws/lambda/nodejs:20"
EXPECTED_COUNT=105

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-from-cfn-stack-large-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed, >100 resources)"

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

# Gate the cleanup trap on a "we created the stack" sentinel so the EXIT
# trap never destroys a pre-existing same-named stack we did not create.
WE_CREATED_STACK=0
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first via:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 3: cdk deploy (upstream CDK CLI) — 105 SSM params + 1 Lambda"
# Set the sentinel BEFORE `cdk deploy`: pre-flight has verified the
# namespace is clean, so once we issue the deploy we OWN the namespace
# (cdk destroy is a no-op on stacks that never reached AWS).
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

# Sanity-check the deployed stack really exceeds the 100-resource cap so
# this test is exercising the pagination path and not silently passing on
# a small stack (e.g. if PARAM_COUNT is ever lowered below the cap).
# Count logical IDs across ALL pages. `--query 'length(...)'` is wrong here:
# the AWS CLI auto-paginates and applies the query per page, emitting one
# length per page (e.g. "100\n7") instead of the total. Projecting the IDs
# to text and counting words sums correctly across pages.
RESOURCE_COUNT=$(aws cloudformation list-stack-resources \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query 'StackResourceSummaries[].LogicalResourceId' \
  --output text | wc -w | tr -d ' ')
echo "[verify] step 3b: deployed resource count = ${RESOURCE_COUNT}"
if [ "${RESOURCE_COUNT}" -le 100 ]; then
  echo "[verify] FAIL: stack has ${RESOURCE_COUNT} resources (<=100); this fixture must exceed the DescribeStackResources cap to be meaningful"
  exit 1
fi

# Local invoke is flaky on cold dockers: retry up to 3 times.
invoke_with_retry() {
  local args=("$@")
  local attempts=3
  local i=1
  while [ $i -le $attempts ]; do
    if out=$(${CLI} invoke "${args[@]}" 2>/dev/null | tail -1) && \
       echo "${out}" | grep -q '"paramCount":'; then
      printf '%s' "${out}"
      return 0
    fi
    if [ $i -lt $attempts ]; then
      echo "[verify]   invoke attempt ${i} failed, retrying..." >&2
      sleep 2
    fi
    i=$((i+1))
  done
  echo "[verify]   all ${attempts} invoke attempts failed; last stderr below:" >&2
  ${CLI} invoke "${args[@]}" 2>&1 | tail -10 >&2
  return 1
}

echo "[verify] step 4: cdkl invoke (no --from-cfn-stack) — expect paramCount=0"
RESULT_BASELINE=$(invoke_with_retry "${STACK}/CountParamsHandler" --no-pull)
echo "[verify]   response: ${RESULT_BASELINE}"
echo "${RESULT_BASELINE}" | grep -q '"paramCount":0' || {
  echo "[verify] FAIL: expected paramCount=0 (intrinsic env vars dropped without a state source), got: ${RESULT_BASELINE}"
  exit 1
}

echo "[verify] step 5: cdkl invoke --from-cfn-stack — expect paramCount=${EXPECTED_COUNT}"
# Bare --from-cfn-stack uses the host stack name verbatim as the CFn
# stack name, which matches the deployed name here.
RESULT_FROM_CFN=$(invoke_with_retry "${STACK}/CountParamsHandler" --from-cfn-stack --no-pull)
echo "[verify]   response: ${RESULT_FROM_CFN}"
echo "${RESULT_FROM_CFN}" | grep -q "\"paramCount\":${EXPECTED_COUNT}" || {
  echo "[verify] FAIL: expected paramCount=${EXPECTED_COUNT} (all params resolved past the 100-resource cap), got: ${RESULT_FROM_CFN}"
  exit 1
}
echo "${RESULT_FROM_CFN}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: STATIC_VALUE regressed under --from-cfn-stack, got: ${RESULT_FROM_CFN}"
  exit 1
}

echo "[verify] step 6: cdk destroy --force"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata

echo ""
echo "[verify] All checks passed: --from-cfn-stack resolved all ${EXPECTED_COUNT} parameters across the >100-resource pagination boundary."
