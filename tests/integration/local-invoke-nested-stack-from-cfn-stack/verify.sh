#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl invoke --from-cfn-stack` against a
# stack with NESTED stacks (go-to-k/cdk-local#986).
#
# A nested stack's template parameters (the parent values CDK passes in, e.g.
# the root stack's queue URL or a sibling nested stack's bucket name) have no
# resource of their own in the nested template; they must resolve from the
# PARENT's deployed state, with the nested physical stack found via
# DescribeStackResource on the parent.
#
# Steps:
#   1. install + build cdk-local (root) + install fixture deps + docker pull
#   2. cdk deploy CdklIntegNestedCfn-<lane> (upstream CDK CLI)
#   3. read the real bucket name / queue URL from CloudFormation
#   4. cdkl invoke <Stack>/Inner/InnerFn --from-cfn-stack: BUCKET + QUEUE_URL
#   5. cdkl invoke <Stack>/Inner/Deeper/DeepFn --from-cfn-stack: PARENT_BUCKET +
#      ROOT_QUEUE (the 2-hop chain)
#   6. cdk destroy --force
#
# Run via `/run-integ local-invoke-nested-stack-from-cfn-stack` (recommended)
# or directly:
#
#     bash tests/integration/local-invoke-nested-stack-from-cfn-stack/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the target
# account. Also requires the global `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
# Lane-unique stack name (issue #582).
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
STACK="$(integ_stack_name CdklIntegNestedCfn)"
IMAGE="public.ecr.aws/lambda/nodejs:20"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-nested-stack-from-cfn-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"
CDKL_STDERR="$(mktemp)"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed, nested stacks)"

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

# Gate the cleanup trap on a "we created the stack" sentinel so the EXIT trap
# never destroys a pre-existing same-named stack we did not create.
WE_CREATED_STACK=0
cleanup() {
  rc=$?
  ORPHANS=$(docker ps -a --filter "name=cdkl-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  rm -f "${CDKL_STDERR}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "[verify] --- captured stderr ---" >&2
  cat "${CDKL_STDERR}" >&2 || true
  exit 1
}

capture() {
  local out rc=0
  out="$("$@" 2>"${CDKL_STDERR}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] command exited ${rc}: $*" >&2
    echo "[verify] last stdout line: $(printf '%s\n' "${out}" | tail -1)" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "${CDKL_STDERR}" >&2
    return 0
  fi
  printf '%s\n' "${out}" | tail -1
}

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first via:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 3: cdk deploy (upstream CDK CLI)"
# Set the sentinel BEFORE `cdk deploy`: pre-flight verified the namespace is
# clean, so once we issue the deploy we OWN it.
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

echo "[verify] step 4: read the real bucket name + queue URL + nested stacks from CloudFormation"
resource_physical_id() {
  # $1 = stack, $2 = resource type, $3 = logical id prefix
  aws cloudformation list-stack-resources --stack-name "$1" --region "${REGION}" \
    --query "StackResourceSummaries[?ResourceType=='$2' && starts_with(LogicalResourceId, '$3')].PhysicalResourceId | [0]" \
    --output text
}
QUEUE_URL=$(resource_physical_id "${STACK}" AWS::SQS::Queue PQ)
INNER_STACK=$(resource_physical_id "${STACK}" AWS::CloudFormation::Stack Inner)
BUCKET=$(resource_physical_id "${INNER_STACK}" AWS::S3::Bucket B)
echo "[verify]   queue=${QUEUE_URL}"
echo "[verify]   inner nested stack=${INNER_STACK}"
echo "[verify]   bucket=${BUCKET}"
for v in "${QUEUE_URL}" "${INNER_STACK}" "${BUCKET}"; do
  if [ -z "${v}" ] || [ "${v}" = "None" ]; then
    fail "could not read a deployed physical id from CloudFormation"
  fi
done

field() {
  # $1 = json line, $2 = key
  printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)[process.argv[1]]))}catch{process.stdout.write("")}})' "$2"
}

echo "[verify] step 5: invoke ${STACK}/Inner/InnerFn --from-cfn-stack"
OUT=$(capture ${CLI} invoke "${STACK}/Inner/InnerFn" --from-cfn-stack --no-pull)
echo "[verify]   response: ${OUT}"
[ "$(field "${OUT}" BUCKET)" = "${BUCKET}" ] || fail "BUCKET expected ${BUCKET}, got: ${OUT}"
[ "$(field "${OUT}" QUEUE_URL)" = "${QUEUE_URL}" ] || fail "QUEUE_URL expected ${QUEUE_URL}, got: ${OUT}"

echo "[verify] step 6: invoke ${STACK}/Inner/Deeper/DeepFn --from-cfn-stack (2-hop chain)"
OUT=$(capture ${CLI} invoke "${STACK}/Inner/Deeper/DeepFn" --from-cfn-stack --no-pull)
echo "[verify]   response: ${OUT}"
[ "$(field "${OUT}" PARENT_BUCKET)" = "${BUCKET}" ] || fail "PARENT_BUCKET expected ${BUCKET}, got: ${OUT}"
[ "$(field "${OUT}" ROOT_QUEUE)" = "${QUEUE_URL}" ] || fail "ROOT_QUEUE expected ${QUEUE_URL}, got: ${OUT}"

echo "[verify] step 7: cdk destroy --force"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata
WE_CREATED_STACK=0
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} still exists after cdk destroy"
  exit 1
fi

echo ""
echo "[verify] All checks passed: --from-cfn-stack resolved nested-stack parameters from the parent's deployed state."
