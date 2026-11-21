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
#   - JwtAgent (go-to-k/cdk-local#1010): a Cognito-backed customJwtAuthorizer
#     whose DiscoveryUrl is an Fn::Join over the pool and whose AllowedClients
#     is `Ref <Client>`. Without a state source it is served unverified with a
#     warning naming the runtime and DiscoveryUrl; under --from-cfn-stack both
#     resolve, so no token / a garbage token is rejected and a real token for
#     the client is accepted.
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
# Lane-unique stack name (issue #582): every AWS-deploying fixture used to
# hard-code ONE name, so two worktree lanes shared one CloudFormation stack.
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
STACK="$(integ_stack_name CdkLocalInvokeAgentCoreFromCfnFixture)"
TARGET="${STACK}/EchoAgent"
BASE_IMAGE="public.ecr.aws/docker/library/node:20-slim"

GREETING_PARAM="$(integ_scoped_name /cdkl-integ/invoke-agentcore-from-cfn/greeting)"
GREETING_VALUE="hello-from-ssm-state"
API_KEY_PARAM="$(integ_scoped_name /cdkl-integ/invoke-agentcore-from-cfn/api-key)"
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
JWT_ERR=""
JWT_STDOUT=""
cleanup() {
  rc=$?
  rm -f "${JWT_ERR}" "${JWT_STDOUT}"
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
  local err
  err="$(mktemp)"
  while [ $i -le $attempts ]; do
    if out=$(${CLI} invoke-agentcore "${args[@]}" 2>"${err}" | tail -1) && \
       echo "${out}" | grep -q '"runtime":"agentcore-from-cfn"'; then
      rm -f "${err}"
      printf '%s' "${out}"
      return 0
    fi
    if [ $i -lt $attempts ]; then
      echo "[verify]   invoke attempt ${i} failed (last stdout line: ${out}); stderr tail:" >&2
      tail -5 "${err}" >&2
      echo "[verify]   retrying..." >&2
      sleep 2
    fi
    i=$((i + 1))
  done
  echo "[verify]   all ${attempts} invoke attempts failed (last stdout line: ${out}); last attempt's stderr below:" >&2
  tail -20 "${err}" >&2
  rm -f "${err}"
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
# Control: the plain String GREETING keeps the inline `-e KEY=VALUE` form; the
# debug line masks every -e value, so it reads `-e "GREETING=***"` (shell-quoted).
echo "${DOCKER_RUN_LINE}" | grep -qE -- '-e "?GREETING=\*\*\*"?( |$)' || {
  echo "[verify] FAIL: expected the plain String GREETING to stay inline as -e GREETING=<value> (control), got: ${DOCKER_RUN_LINE}"
  exit 1
}
echo "[verify]   SecureString API_KEY routed off the argv; String GREETING stayed inline (control)."

echo "[verify] step 6b: JwtAgent without a state source — served unverified, warned (#1010)"
JWT_TARGET="${STACK}/JwtAgent"
JWT_ERR="$(mktemp)"
JWT_OUT=$(${CLI} invoke-agentcore "${JWT_TARGET}" 2>"${JWT_ERR}" | tail -1) || {
  echo "[verify] FAIL: JwtAgent invoke without state did not run (expected served unverified):"
  tail -20 "${JWT_ERR}"
  exit 1
}
echo "${JWT_OUT}" | grep -q '"runtime":"agentcore-from-cfn"' || {
  echo "[verify] FAIL: JwtAgent invoke without state: unexpected response: ${JWT_OUT}"
  exit 1
}
grep -q 'AgentCore Runtime JwtAgent[A-F0-9]*: CustomJWTAuthorizer.DiscoveryUrl could not be resolved (no deployed-state source is active)' "${JWT_ERR}" || {
  echo "[verify] FAIL: expected the DiscoveryUrl warning naming the runtime without a state source:"
  tail -20 "${JWT_ERR}"
  exit 1
}
echo "[verify]   no state: served unverified with the DiscoveryUrl warning"

echo "[verify] step 6c: JwtAgent under --from-cfn-stack — authorizer resolved and enforced (#1010)"
set +e
${CLI} invoke-agentcore "${JWT_TARGET}" --from-cfn-stack >/dev/null 2>"${JWT_ERR}"
RC_NO_TOKEN=$?
${CLI} invoke-agentcore "${JWT_TARGET}" --from-cfn-stack --bearer-token garbage >/dev/null 2>>"${JWT_ERR}"
RC_GARBAGE=$?
set -e
[ "${RC_NO_TOKEN}" -ne 0 ] && grep -q 'requires an inbound JWT' "${JWT_ERR}" || {
  echo "[verify] FAIL: --from-cfn-stack without a token: expected the auth-required refusal (rc=${RC_NO_TOKEN}):"
  tail -20 "${JWT_ERR}"
  exit 1
}
[ "${RC_GARBAGE}" -ne 0 ] && grep -q 'Inbound JWT rejected' "${JWT_ERR}" || {
  echo "[verify] FAIL: --from-cfn-stack with a garbage token: expected a rejection (rc=${RC_GARBAGE}):"
  tail -20 "${JWT_ERR}"
  exit 1
}
if grep -q 'DiscoveryUrl could not be resolved' "${JWT_ERR}"; then
  echo "[verify] FAIL: DiscoveryUrl still unresolved under --from-cfn-stack"
  exit 1
fi
stack_output() {
  aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
POOL_ID="$(stack_output PoolId)"
CLIENT_ID="$(stack_output ClientId)"
JWT_USER="integ-user"
JWT_PASS="Integ-Pass-1234!aB"
aws cognito-idp admin-create-user --user-pool-id "${POOL_ID}" --username "${JWT_USER}" \
  --message-action SUPPRESS --region "${REGION}" >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "${POOL_ID}" --username "${JWT_USER}" \
  --password "${JWT_PASS}" --permanent --region "${REGION}"
ACCESS_TOKEN="$(aws cognito-idp admin-initiate-auth --user-pool-id "${POOL_ID}" --client-id "${CLIENT_ID}" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters "USERNAME=${JWT_USER},PASSWORD=${JWT_PASS}" \
  --region "${REGION}" --query 'AuthenticationResult.AccessToken' --output text)"
case "${ACCESS_TOKEN}" in
  eyJ*.*.*) ;;
  *) echo "[verify] FAIL: minted access token does not look like a JWT"; exit 1 ;;
esac
# The info line lands on stdout, the response is its last line.
JWT_STDOUT="$(mktemp)"
${CLI} invoke-agentcore "${JWT_TARGET}" --from-cfn-stack --bearer-token "${ACCESS_TOKEN}" \
  >"${JWT_STDOUT}" 2>"${JWT_ERR}" || {
  echo "[verify] FAIL: --from-cfn-stack with a real token did not run:"
  tail -20 "${JWT_ERR}"
  exit 1
}
JWT_OUT="$(tail -1 "${JWT_STDOUT}")"
echo "${JWT_OUT}" | grep -q '"runtime":"agentcore-from-cfn"' || {
  echo "[verify] FAIL: --from-cfn-stack with a real token: unexpected response: ${JWT_OUT}"
  exit 1
}
cat "${JWT_STDOUT}" "${JWT_ERR}" | grep -q 'Inbound JWT verified against https://cognito-idp\.' || {
  echo "[verify] FAIL: expected 'Inbound JWT verified against' the resolved Cognito discovery URL:"
  tail -20 "${JWT_STDOUT}" "${JWT_ERR}"
  exit 1
}
rm -f "${JWT_ERR}" "${JWT_STDOUT}"
echo "[verify]   --from-cfn-stack: no token / garbage rejected; real token verified and served"

echo "[verify] step 7: cdk destroy"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata
WE_CREATED_STACK=0
echo "[verify]   destroyed ${STACK}"

echo ""
echo "[verify] All local-invoke-agentcore-from-cfn checks passed"
