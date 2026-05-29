#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl invoke-agentcore --from-cfn-stack`
# (issue #130, follow-up #147).
#
# `cdkl invoke-agentcore --from-cfn-stack` runs the agent LOCALLY and only
# READS the deployed stack's state, so the deployed AgentCore Runtime need
# not be healthy — it only has to exist. This exercises the --from-cfn-stack
# SSM resolution end-to-end against real AWS:
#   - GREETING: a Ref to an AWS::SSM::Parameter::Value<String> CFn parameter
#     (plain String) — resolved from SSM, kept inline on the docker argv.
#   - API_KEY:  a second SSM param swapped to a SecureString after deploy —
#     resolved with WithDecryption AND kept OFF the docker argv (issue #99
#     mechanism, mirrored for invoke-agentcore).
#   - STATIC_VALUE: a literal — confirms the normal-case passthrough.
#
# Steps: deploy via upstream cdk -> swap api-key to SecureString -> baseline
# invoke (both SSM env vars drop) -> --from-cfn-stack invoke (both resolve)
# -> --verbose off-argv assertion -> cdk destroy + delete SSM params.
#
# Run via `/run-integ local-invoke-agentcore-from-cfn` (recommended).
# Requires Docker, AWS credentials with deploy permissions, and the global
# `cdk` CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalInvokeAgentCoreFromCfnFixture"
TARGET="${STACK}/EchoAgent"
BASE_IMAGE="public.ecr.aws/docker/library/node:20-slim"

GREETING_PARAM="/cdkl-integ/invoke-agentcore-from-cfn/greeting"
GREETING_VALUE="hello-from-ssm-state"
API_KEY_PARAM="/cdkl-integ/invoke-agentcore-from-cfn/api-key"
API_KEY_PLACEHOLDER="placeholder-not-secret"
API_KEY_VALUE="s3cr3t-agentcore-9f3a2b"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-agentcore-from-cfn"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed)"

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${BASE_IMAGE} (one-time)"
docker pull --platform linux/arm64 "${BASE_IMAGE}" >/dev/null

echo "[verify] step 1d: installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

WE_CREATED_STACK=0
WE_CREATED_PARAM=0
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  if [ "${WE_CREATED_PARAM}" -eq 1 ]; then
    aws ssm delete-parameter --name "${GREETING_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
    aws ssm delete-parameter --name "${API_KEY_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists — clean up first via:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 2b: put the SSM parameters (Strings, pre-deploy)"
WE_CREATED_PARAM=1
aws ssm put-parameter --name "${GREETING_PARAM}" --value "${GREETING_VALUE}" \
  --type String --overwrite --region "${REGION}" >/dev/null
echo "[verify]   put ${GREETING_PARAM}=${GREETING_VALUE}"
# api-key starts as a plain String — CloudFormation rejects an
# AWS::SSM::Parameter::Value<String> template parameter that points at a
# SecureString. Swapped to a SecureString after deploy.
aws ssm put-parameter --name "${API_KEY_PARAM}" --value "${API_KEY_PLACEHOLDER}" \
  --type String --overwrite --region "${REGION}" >/dev/null
echo "[verify]   put ${API_KEY_PARAM}=${API_KEY_PLACEHOLDER} (String, pre-deploy)"

echo "[verify] step 3: cdk deploy (upstream CDK CLI)"
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

echo "[verify] step 3b: swap the api-key SSM parameter to a SecureString"
aws ssm delete-parameter --name "${API_KEY_PARAM}" --region "${REGION}" >/dev/null
aws ssm put-parameter --name "${API_KEY_PARAM}" --value "${API_KEY_VALUE}" \
  --type SecureString --region "${REGION}" >/dev/null
echo "[verify]   swapped ${API_KEY_PARAM} -> SecureString"

invoke_with_retry() {
  local args=("$@")
  local attempts=3
  local i=1
  while [ $i -le $attempts ]; do
    if out=$(${CLI} invoke-agentcore "${args[@]}" 2>/dev/null | tail -1) && \
       echo "${out}" | grep -q '"runtime":"agentcore-from-cfn"'; then
      printf '%s' "${out}"
      return 0
    fi
    if [ $i -lt $attempts ]; then
      echo "[verify]   invoke attempt ${i} failed, retrying..." >&2
      sleep 2
    fi
    i=$((i + 1))
  done
  echo "[verify]   all ${attempts} invoke attempts failed; last stderr below:" >&2
  ${CLI} invoke-agentcore "${args[@]}" 2>&1 | tail -15 >&2
  return 1
}

echo "[verify] step 4: baseline invoke (no --from-cfn-stack) — SSM env vars drop"
RESULT_BASELINE=$(invoke_with_retry "${TARGET}")
echo "[verify]   response: ${RESULT_BASELINE}"
echo "${RESULT_BASELINE}" | grep -q '"greeting":"unset"' || {
  echo "[verify] FAIL: expected GREETING dropped (intrinsic warn-and-drop) without --from-cfn-stack, got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"apiKey":"unset"' || {
  echo "[verify] FAIL: expected API_KEY dropped without --from-cfn-stack, got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: expected STATIC_VALUE=always-the-same in baseline, got: ${RESULT_BASELINE}"
  exit 1
}

echo "[verify] step 5: --from-cfn-stack invoke — SSM values resolve into env"
RESULT_FROM_CFN=$(invoke_with_retry "${TARGET}" --from-cfn-stack)
echo "[verify]   response: ${RESULT_FROM_CFN}"
echo "${RESULT_FROM_CFN}" | grep -q "\"greeting\":\"${GREETING_VALUE}\"" || {
  echo "[verify] FAIL: expected GREETING=${GREETING_VALUE} (SSM String resolved), got: ${RESULT_FROM_CFN}"
  exit 1
}
echo "${RESULT_FROM_CFN}" | grep -q "\"apiKey\":\"${API_KEY_VALUE}\"" || {
  echo "[verify] FAIL: expected API_KEY=${API_KEY_VALUE} (decrypted SecureString resolved fresh), got: ${RESULT_FROM_CFN}"
  exit 1
}
echo "${RESULT_FROM_CFN}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: STATIC_VALUE regressed under --from-cfn-stack, got: ${RESULT_FROM_CFN}"
  exit 1
}

echo "[verify] step 6: assert the decrypted SecureString is kept OFF the docker argv"
DEBUG_OUT=$(${CLI} invoke-agentcore "${TARGET}" --from-cfn-stack --verbose 2>&1 || true)
DOCKER_RUN_LINE=$(echo "${DEBUG_OUT}" | grep -E '(^| )run .* -e ' | grep -- '-e API_KEY' | head -1)
if [ -z "${DOCKER_RUN_LINE}" ]; then
  echo "[verify] FAIL: could not find the 'docker run' debug line carrying -e API_KEY in --verbose output"
  echo "${DEBUG_OUT}" | tail -20
  exit 1
fi
echo "${DOCKER_RUN_LINE}" | grep -qE -- '-e API_KEY( |$)' || {
  echo "[verify] FAIL: API_KEY not in the value-less '-e API_KEY' form on the docker argv: ${DOCKER_RUN_LINE}"
  exit 1
}
if echo "${DOCKER_RUN_LINE}" | grep -q "${API_KEY_VALUE}"; then
  echo "[verify] FAIL: decrypted SecureString value LEAKED onto the docker run argv: ${DOCKER_RUN_LINE}"
  exit 1
fi
# Control: the plain String GREETING keeps the inline form.
echo "${DOCKER_RUN_LINE}" | grep -q "GREETING=${GREETING_VALUE}" || {
  echo "[verify] FAIL: expected the plain String GREETING to stay inline as -e GREETING=<value> (control), got: ${DOCKER_RUN_LINE}"
  exit 1
}
echo "[verify]   SecureString API_KEY routed off the argv; String GREETING stayed inline (control)."

echo "[verify] step 7: cdk destroy"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata
WE_CREATED_STACK=0
echo "[verify]   destroyed ${STACK}"

echo ""
echo "[verify] All local-invoke-agentcore-from-cfn checks passed"
