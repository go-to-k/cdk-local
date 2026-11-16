#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl start-alb` behind an
# `authenticate-cognito` action whose config is an intrinsic
# (go-to-k/cdk-local#1004).
#
# The listener's AuthenticateCognitoConfig is the shape
# `ListenerAction.authenticateCognito` emits: `UserPoolArn: Fn::GetAtt
# <Pool>.Arn`, `UserPoolClientId: Ref <Client>`. start-alb used to drop the
# guard and serve the route unauthenticated. This fixture deploys a real
# Cognito user pool + client + domain via the upstream `cdk deploy` (the ALB
# itself is condition-gated out of the deployment; see the stack file), mints
# real ID tokens, and asserts:
#   - no state source: boots, warns "UserPoolArn is an intrinsic", and an
#     anonymous request gets 401 (not the fixed-response 200).
#   - --from-cfn-stack: the pool ARN + client id resolve from the deployed
#     stack, so the real pool's JWKS is verified: valid token -> 200 "secret";
#     tampered signature / no header -> 401.
#
# Run via `/run-integ local-start-alb-cognito-from-cfn-stack` or:
#
#     bash tests/integration/local-start-alb-cognito-from-cfn-stack/verify.sh
#
# Requires Docker, AWS credentials with deploy permissions, and the global
# `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
STACK="$(integ_stack_name CdkLocalStartAlbCognitoFromCfnStackFixture)"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
LB_HOST_PORT=18296

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-alb-cognito-from-cfn-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"
USERNAME="integ-user"
PASSWORD="Integ-Pass-1234!aB"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed)"

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull "${SIDECAR_IMAGE}"

LOG_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"
SERVER_PID=""
POOL_ID=""

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      kill -KILL "${SERVER_PID}" 2>/dev/null || true
    fi
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  SERVER_PID=""
  docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
}

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "[verify] --- last server log ---" >&2
  cat "${LOG_FILE}" >&2 || true
  exit 1
}

# Gate the stack cleanup on a "we created the stack" sentinel so the EXIT
# trap never destroys a pre-existing same-named stack found by the
# pre-flight scan.
WE_CREATED_STACK=0
cleanup() {
  rc=$?
  stop_server
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  rm -f "${LOG_FILE}" "${BODY_FILE}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first via:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 3: cdk deploy (upstream CDK CLI)"
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

stack_output() {
  aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
POOL_ID="$(stack_output PoolId)"
CLIENT_ID="$(stack_output ClientId)"
for v in "${POOL_ID}" "${CLIENT_ID}"; do
  if [ -z "${v}" ] || [ "${v}" = "None" ]; then
    echo "[verify] FAIL: could not read stack outputs (pool=${POOL_ID} client=${CLIENT_ID})"
    exit 1
  fi
done
echo "[verify]   pool=${POOL_ID} client=${CLIENT_ID}"

# The ALB must NOT be deployed (it is condition-gated); only the template
# carries it. A deployed one would mean the fixture no longer isolates the
# local front-door.
if aws cloudformation describe-stack-resource --stack-name "${STACK}" \
  --logical-resource-id WebListener --region "${REGION}" >/dev/null 2>&1; then
  fail "the condition-gated WebListener was deployed"
fi

echo "[verify] step 4: create a user and mint an ID token"
aws cognito-idp admin-create-user --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --message-action SUPPRESS --region "${REGION}" >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --password "${PASSWORD}" --permanent --region "${REGION}"
TOKEN="$(aws cognito-idp admin-initiate-auth --user-pool-id "${POOL_ID}" --client-id "${CLIENT_ID}" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=${USERNAME},PASSWORD=${PASSWORD}" \
  --region "${REGION}" --query 'AuthenticationResult.IdToken' --output text)"
case "${TOKEN}" in
  eyJ*.*.*) ;;
  *) echo "[verify] FAIL: minted token does not look like a JWT"; exit 1 ;;
esac
# Tamper: flip one character in the middle of the signature segment (the last
# character carries unused base64url bits, so flipping it can leave the bytes
# unchanged).
SIG_PREFIX="${TOKEN%.*}"
SIG="${TOKEN##*.}"
if [ "${SIG:10:1}" = "A" ]; then FLIP="B"; else FLIP="A"; fi
TOKEN_TAMPERED="${SIG_PREFIX}.${SIG:0:10}${FLIP}${SIG:11}"
[ "${TOKEN_TAMPERED}" != "${TOKEN}" ] || { echo "[verify] FAIL: tamper was a no-op"; exit 1; }
echo "[verify]   token minted"

# Called directly, never inside $( ): SERVER_PID must reach this shell so
# stop_server can reap the server.
start_alb() {
  : >"${LOG_FILE}"
  ${CLI} start-alb "${STACK}:WebLB" \
    --container-host 127.0.0.1 \
    --lb-port "80=${LB_HOST_PORT}" \
    "$@" \
    >"${LOG_FILE}" 2>&1 &
  SERVER_PID=$!

  local ready=0
  for _ in $(seq 1 120); do
    if grep -q "Service(s) running:" "${LOG_FILE}" 2>/dev/null; then
      ready=1
      break
    fi
    kill -0 "${SERVER_PID}" 2>/dev/null || break
    sleep 1
  done
  [ "${ready}" -eq 1 ] || fail "start-alb did not reach the boot banner"
  for _ in $(seq 1 60); do
    local code
    code="$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:${LB_HOST_PORT}/" || true)"
    if [ -n "${code}" ] && [ "${code}" != "000" ]; then return 0; fi
    kill -0 "${SERVER_PID}" 2>/dev/null || break
    sleep 1
  done
  fail "the front-door never answered on port ${LB_HOST_PORT}"
}

# GET /; sets HTTP_CODE and writes the body to BODY_FILE. $1 is the
# Authorization header value ("" = send none).
request_root() {
  local auth="$1"
  if [ -n "${auth}" ]; then
    HTTP_CODE="$(curl -s -o "${BODY_FILE}" -w '%{http_code}' --max-time 10 \
      -H "Authorization: ${auth}" "http://127.0.0.1:${LB_HOST_PORT}/" || true)"
  else
    HTTP_CODE="$(curl -s -o "${BODY_FILE}" -w '%{http_code}' --max-time 10 \
      "http://127.0.0.1:${LB_HOST_PORT}/" || true)"
  fi
}

echo "[verify] step 5: no state source — the guard is kept, anonymous -> 401"
start_alb
grep -q 'UserPoolArn is an intrinsic' "${LOG_FILE}" || \
  fail "expected the 'UserPoolArn is an intrinsic' warning without a state source"
grep -q -- '--from-cfn-stack' "${LOG_FILE}" || fail "the warning does not name --from-cfn-stack"
request_root ""
[ "${HTTP_CODE}" = "401" ] || fail "no state, no header: expected 401, got ${HTTP_CODE} body=$(cat "${BODY_FILE}")"
if grep -q 'secret' "${BODY_FILE}"; then fail "no state, no header: the fixed-response body was served"; fi
echo "[verify]   no state, no header -> 401"
stop_server

echo "[verify] step 6: --from-cfn-stack — pool ARN + client id resolved from the stack"
start_alb --from-cfn-stack
if grep -q 'is an intrinsic' "${LOG_FILE}"; then
  fail "a guard field still reported as an intrinsic under --from-cfn-stack"
fi
if grep -q 'could not be resolved' "${LOG_FILE}"; then
  fail "the client id did not resolve under --from-cfn-stack"
fi

OK=0
for _ in $(seq 1 30); do
  request_root "Bearer ${TOKEN}"
  if [ "${HTTP_CODE}" = "200" ]; then OK=1; break; fi
  sleep 1
done
[ "${OK}" -eq 1 ] || fail "valid token: expected 200, last got ${HTTP_CODE} body=$(cat "${BODY_FILE}")"
grep -q '^secret$' "${BODY_FILE}" || fail "valid token: unexpected body $(cat "${BODY_FILE}")"
if grep -q 'JWKS pass-through mode' "${LOG_FILE}"; then
  fail "JWKS pass-through under --from-cfn-stack (the guard did not resolve to the real pool)"
fi
echo "[verify]   valid token -> 200 secret"

request_root "Bearer ${TOKEN_TAMPERED}"
[ "${HTTP_CODE}" = "401" ] || fail "tampered token: expected 401, got ${HTTP_CODE}"
echo "[verify]   tampered token -> 401"

request_root ""
[ "${HTTP_CODE}" = "401" ] || fail "no Authorization header: expected 401, got ${HTTP_CODE}"
echo "[verify]   no header -> 401"
stop_server

echo "[verify] step 7: cdk destroy --force"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata

DESCRIBE_ERR="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" 2>&1 >/dev/null || true)"
case "${DESCRIBE_ERR}" in
  *"does not exist"*) ;;
  *) echo "[verify] FAIL: stack not confirmed gone: ${DESCRIBE_ERR}"; exit 1 ;;
esac
POOL_ERR="$(aws cognito-idp describe-user-pool --user-pool-id "${POOL_ID}" --region "${REGION}" 2>&1 >/dev/null || true)"
case "${POOL_ERR}" in
  *ResourceNotFoundException*) ;;
  *) echo "[verify] FAIL: user pool not confirmed gone: ${POOL_ERR}"; exit 1 ;;
esac

echo ""
echo "[verify] All checks passed:"
echo "[verify]   - no state source: guard kept (intrinsic warning), anonymous -> 401."
echo "[verify]   - --from-cfn-stack: guard resolved; valid 200 / tampered 401 / no-header 401."
