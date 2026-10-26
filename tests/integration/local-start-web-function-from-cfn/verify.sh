#!/usr/bin/env bash
#
# Real-AWS validation for `cdkl start-web-function --from-cfn-stack`.
#
# The fixture app has two stacks, deployed with the fixture-pinned upstream
# CDK CLI (`aws-cdk` in package.json):
#
#   - a producer exporting one literal (SHARED_VALUE), and
#   - a consumer with an SSM parameter, an execution role (trusting Lambda AND
#     the account root) and a CfnWebFunction with ONE CfnWebFunctionRevision
#     whose ServiceConfig env holds a literal, a `Ref` (the parameter), an
#     `Fn::ImportValue` (the producer's export) and an `Fn::GetAtt` (the
#     role's Arn).
#
# Arms:
#
#   1. Baseline (no --from-cfn-stack): every intrinsic env var is warned and
#      dropped; the literal passes.
#   2. --from-cfn-stack: `Ref` -> the parameter's deployed physical id,
#      `Fn::ImportValue` -> the exported literal, `Fn::GetAtt` -> warned
#      ("could not substitute ... will be dropped") and absent — the
#      documented boundary (ListStackResources returns physical ids only, and
#      start-web-function makes no Lambda-API fallback lookup).
#   3. --from-cfn-stack --assume-role (bare): the revision's GetAtt
#      ExecutionRoleArn is resolved by the role's deployed name and Path, and
#      STS GetCallerIdentity INSIDE the container reports that assumed role.
#   4. Both stacks are deleted with `aws cloudformation delete-stack`
#      (consumer first, so the import is released before the export), then
#      the code bucket (every object version and delete marker first).
#
# The revision's code lives in a versioned bucket this script owns, not the
# CDK asset bucket: the Lambda Web service reads it as lambda.amazonaws.com,
# which the bootstrap bucket's policy grants nothing. It is uploaded under the
# asset's own `<hash>.zip` key, so the local cdk.out match still works.
#
# Run via `/run-integ local-start-web-function-from-cfn`. Requires Docker and
# AWS credentials allowed to deploy in the target account. Uses host ports
# 18480-18482.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
# Lane-unique names (issue #582).
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
PRODUCER_STACK="$(integ_stack_name CdkLocalWebFnFromCfnProducer)"
CONSUMER_STACK="$(integ_stack_name CdkLocalWebFnFromCfnConsumer)"
EXPORT_NAME="$(integ_scoped_name cdkl-webfn-from-cfn-shared)"
# The producer's SSM parameter (a stack resource: the CDK CLI skips a stack
# with none, which would leave the export uncreated). Deleted with its stack.
SHARED_PARAM="$(integ_scoped_name /cdkl-integ/webfn-from-cfn/shared)"
SHARED_VALUE="shared-from-webfn-producer" # kept in sync with the stack's SHARED_VALUE
IMAGE="public.ecr.aws/lambda/nodejs:24"
# The web function's literal FunctionName (kept in sync with bin/app.ts); the
# code bucket policy is scoped to its revisions.
FUNCTION_NAME="$(integ_scoped_name cdkl-integ-webfn-from-cfn)"
# A versioned code bucket this script owns. The Lambda Web service reads the
# revision's code as lambda.amazonaws.com, which the CDK bootstrap asset
# bucket grants nothing, so the code is uploaded here under the SAME
# `<hash>.zip` key the s3assets.Asset synthesizes (the local cdk.out match
# still works). Lane-suffixed, so the AWS orphan sweep owns it; bin/app.ts
# builds the same name.
CODE_BUCKET="$(integ_scoped_name cdkl-webfn-from-cfn-code)"
PORT=18480

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-web-function-from-cfn"
CLI="node ${REPO_ROOT}/dist/cli.js"

# The cloud runtime is arm64-only; on an amd64 host run the container natively.
case "$(uname -m)" in
  arm64 | aarch64) PLATFORM="linux/arm64"; PLATFORM_ARGS=() ;;
  *) PLATFORM="linux/amd64"; PLATFORM_ARGS=(--platform linux/amd64) ;;
esac

# The fixture-pinned upstream CDK CLI, never whatever `cdk` is on PATH.
cdk() { "${TEST_DIR}/node_modules/.bin/cdk" "$@"; }

delete_stack() { # delete_stack <name>: delete-stack, then wait for it to be gone
  aws cloudformation delete-stack --stack-name "$1" --region "${REGION}"
  aws cloudformation wait stack-delete-complete --stack-name "$1" --region "${REGION}"
}

echo "[verify] region=${REGION} producer=${PRODUCER_STACK} consumer=${CONSUMER_STACK} export=${EXPORT_NAME} param=${SHARED_PARAM}"

CDKL_PID=""
OUT_FILE="$(mktemp)"
WE_CREATED_STACKS=0
WE_CREATED_BUCKET=0

stop_server() {
  if [ -n "${CDKL_PID}" ] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 80); do kill -0 "${CDKL_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  CDKL_PID=""
}

cleanup() {
  rc=$?
  stop_server
  rm -f "${OUT_FILE}"
  # Gated on the sentinel: a pre-existing same-named stack (pre-flight exit)
  # is someone else's and is never deleted here.
  if [ "${WE_CREATED_STACKS}" -eq 1 ]; then
    [ "${rc}" -ne 0 ] && echo "[verify] FAIL (exit ${rc}) — deleting the fixture stacks"
    delete_stack "${CONSUMER_STACK}" || true
    delete_stack "${PRODUCER_STACK}" || true
  fi
  # After the stacks: the revision referenced the code until its stack went.
  [ "${WE_CREATED_BUCKET}" -eq 1 ] && reap_code_bucket
  exit "${rc}"
}

# Every version and delete marker of every object, then the bucket.
reap_code_bucket() { (
  set +e
  aws s3api list-object-versions --bucket "${CODE_BUCKET}" --region "${REGION}" \
    --query '[Versions[].[Key, VersionId], DeleteMarkers[].[Key, VersionId]][]' --output text 2>/dev/null \
    | while read -r key version; do
      [ -n "${key}" ] && [ "${key}" != "None" ] || continue
      aws s3api delete-object --bucket "${CODE_BUCKET}" --key "${key}" --version-id "${version}" \
        --region "${REGION}" >/dev/null 2>&1
    done
  aws s3api delete-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" >/dev/null 2>&1
) }
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "----- cdkl output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

# Boot `cdkl start-web-function` in the background and wait for its banner.
boot_serve() {
  stop_server
  : > "${OUT_FILE}"
  ${CLI} start-web-function "$@" --no-pull ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} > "${OUT_FILE}" 2>&1 &
  CDKL_PID=$!
  for _ in $(seq 1 240); do
    grep -q 'Server listening on http://' "${OUT_FILE}" && return 0
    kill -0 "${CDKL_PID}" 2>/dev/null || fail "start-web-function exited before it was ready"
    sleep 0.5
  done
  fail "start-web-function did not print its ready banner in time"
}

assert_no_orphans() {
  sleep 1
  local orphans
  orphans="$(docker ps -a --filter "name=cdkl-webfn-$1-" --format '{{.Names}}' || true)"
  [ -z "${orphans}" ] || fail "leftover web function container(s): ${orphans}"
}

echo "[verify] step 1: install + build cdk-local, fixture deps, base image"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
[ -d node_modules ] || vp install --prefer-offline
[ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || fail "the fixture-pinned aws-cdk CLI is not installed"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform "${PLATFORM}" "${IMAGE}" >/dev/null

echo "[verify] step 2: pre-flight — neither stack may already exist"
for stack in "${PRODUCER_STACK}" "${CONSUMER_STACK}"; do
  if aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] FAIL: ${stack} already exists — clean up first via:"
    echo "          aws cloudformation delete-stack --stack-name ${stack} --region ${REGION}"
    exit 1
  fi
done

echo "[verify] step 2b: the versioned code bucket, readable by the Lambda Web service"
if aws s3api head-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: bucket ${CODE_BUCKET} already exists — a leftover of an earlier run (see aws-orphan-sweep.sh)"
  exit 1
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
WE_CREATED_BUCKET=1
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" >/dev/null
else
  aws s3api create-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
fi
aws s3api put-bucket-versioning --bucket "${CODE_BUCKET}" --region "${REGION}" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-policy --bucket "${CODE_BUCKET}" --region "${REGION}" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": {\"Service\": \"lambda.amazonaws.com\"},
    \"Action\": [\"s3:GetObject\", \"s3:GetObjectVersion\"],
    \"Resource\": \"arn:aws:s3:::${CODE_BUCKET}/*\",
    \"Condition\": {
      \"StringEquals\": {\"aws:SourceAccount\": \"${ACCOUNT}\"},
      \"ArnLike\": {\"aws:SourceArn\": \"arn:aws:lambda:${REGION}:${ACCOUNT}:web-function/${FUNCTION_NAME}/revision/*\"}
    }
  }]
}"
# A placeholder until the upload returns the real version id (synth only).
export CODE_VERSION="pending"

echo "[verify] step 2c: synth to read the asset key, upload web/ zipped under it"
cdk synth "${CONSUMER_STACK}" --no-version-reporting -q >/dev/null
CODE_KEY="$(node -e '
  const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const v = t.Outputs && t.Outputs.CodeKey && t.Outputs.CodeKey.Value;
  if (typeof v !== "string" || !/^[0-9a-f]{64}\.zip$/.test(v)) process.exit(1);
  console.log(v);
' "cdk.out/${CONSUMER_STACK}.template.json")" || fail "no literal <hash>.zip CodeKey output in the synthesized template"
ZIP_DIR="$(mktemp -d)"
(cd web && zip -q "${ZIP_DIR}/code.zip" index.js)
CODE_VERSION="$(aws s3api put-object --bucket "${CODE_BUCKET}" --key "${CODE_KEY}" \
  --body "${ZIP_DIR}/code.zip" --region "${REGION}" --query VersionId --output text)"
rm -rf "${ZIP_DIR}"
case "${CODE_VERSION}" in
  "" | None | null) fail "the code upload returned no version id: '${CODE_VERSION}'" ;;
esac
export CODE_VERSION
echo "[verify]   s3://${CODE_BUCKET}/${CODE_KEY} version ${CODE_VERSION}"

echo "[verify] step 3: cdk deploy producer + consumer (pinned upstream CDK CLI)"
WE_CREATED_STACKS=1
cdk deploy "${PRODUCER_STACK}" "${CONSUMER_STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
REF_PHYSICAL="$(aws cloudformation describe-stack-resource --stack-name "${CONSUMER_STACK}" \
  --logical-resource-id "$(aws cloudformation list-stack-resources --stack-name "${CONSUMER_STACK}" --region "${REGION}" \
    --query "StackResourceSummaries[?ResourceType=='AWS::SSM::Parameter'].LogicalResourceId | [0]" --output text)" \
  --region "${REGION}" --query 'StackResourceDetail.PhysicalResourceId' --output text)"
ROLE_NAME="$(aws cloudformation list-stack-resources --stack-name "${CONSUMER_STACK}" --region "${REGION}" \
  --query "StackResourceSummaries[?ResourceType=='AWS::IAM::Role'].PhysicalResourceId | [0]" --output text)"
[ -n "${REF_PHYSICAL}" ] && [ "${REF_PHYSICAL}" != "None" ] || fail "no deployed SSM parameter physical id"
[ -n "${ROLE_NAME}" ] && [ "${ROLE_NAME}" != "None" ] || fail "no deployed execution role name"
echo "[verify]   parameter=${REF_PHYSICAL} role=${ROLE_NAME}"
TARGET="${CONSUMER_STACK}/WebFn"

echo "[verify] step 4: baseline (no --from-cfn-stack) — intrinsic env vars are dropped"
boot_serve "${TARGET}" --port "${PORT}"
BODY="$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/")"
echo "${BODY}" | grep -q '"staticValue":"always-the-same"' || fail "literal env missing: ${BODY}"
echo "${BODY}" | grep -q '"refValue":null' || fail "Ref env not dropped without a state source: ${BODY}"
echo "${BODY}" | grep -q '"importedValue":null' || fail "ImportValue env not dropped: ${BODY}"
echo "${BODY}" | grep -q '"getattValue":null' || fail "GetAtt env not dropped: ${BODY}"
for key in REF_VALUE IMPORTED_VALUE GETATT_VALUE; do
  grep -q "Environment variable ${key} contains a CloudFormation intrinsic and was dropped" "${OUT_FILE}" \
    || fail "no drop warning for ${key}"
done
BASE_PID="${CDKL_PID}"
stop_server
assert_no_orphans "${BASE_PID}"

echo "[verify] step 5: --from-cfn-stack — Ref and Fn::ImportValue resolve, Fn::GetAtt is warned and dropped"
boot_serve "${TARGET}" --from-cfn-stack --port "$((PORT + 1))"
BODY="$(curl -s --max-time 10 "http://127.0.0.1:$((PORT + 1))/")"
echo "${BODY}" | grep -q "\"refValue\":\"${REF_PHYSICAL}\"" || fail "Ref not resolved to ${REF_PHYSICAL}: ${BODY}"
echo "${BODY}" | grep -q "\"importedValue\":\"${SHARED_VALUE}\"" || fail "ImportValue not resolved: ${BODY}"
echo "${BODY}" | grep -q '"getattValue":null' || fail "GetAtt unexpectedly resolved: ${BODY}"
echo "${BODY}" | grep -q '"staticValue":"always-the-same"' || fail "literal env regressed: ${BODY}"
grep -q 'could not substitute env var GETATT_VALUE' "${OUT_FILE}" || fail "no GetAtt substitution warning"
grep -q 'it will be dropped' "${OUT_FILE}" || fail "the GetAtt warning does not say the value is dropped"
WHO="$(curl -s --max-time 20 "http://127.0.0.1:$((PORT + 1))/whoami")"
echo "${WHO}" | grep -q "assumed-role/${ROLE_NAME}/" && fail "the execution role was assumed without --assume-role: ${WHO}"
echo "[verify]   ${BODY}"
CFN_PID="${CDKL_PID}"
stop_server
assert_no_orphans "${CFN_PID}"

echo "[verify] step 6: --from-cfn-stack --assume-role (bare) — the GetAtt ExecutionRoleArn is assumed"
boot_serve "${TARGET}" --from-cfn-stack --assume-role --port "$((PORT + 2))"
WHO="$(curl -s --max-time 20 "http://127.0.0.1:$((PORT + 2))/whoami")"
echo "${WHO}" | grep -qE "\"arn\":\"arn:aws[a-z-]*:sts::[0-9]{12}:assumed-role/${ROLE_NAME}/" \
  || fail "STS inside the container is not the execution role ${ROLE_NAME}: ${WHO}"
echo "[verify]   ${WHO}"
AR_PID="${CDKL_PID}"
stop_server
assert_no_orphans "${AR_PID}"

echo "[verify] step 7: delete the stacks (consumer first, then producer)"
delete_stack "${CONSUMER_STACK}"
delete_stack "${PRODUCER_STACK}"
WE_CREATED_STACKS=0
reap_code_bucket
WE_CREATED_BUCKET=0
if aws s3api head-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
  fail "code bucket ${CODE_BUCKET} still exists after teardown"
fi

echo "[verify] PASS"
