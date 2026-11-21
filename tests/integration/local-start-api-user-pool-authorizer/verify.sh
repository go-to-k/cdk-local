#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl start-api` behind aws-cdk-lib's
# `HttpUserPoolAuthorizer` (go-to-k/cdk-local#1001).
#
# The authorizer's JwtConfiguration.Issuer is a `Fn::Join` over
# `Ref AWS::Region` + `Ref <UserPool>` and its Audience is
# `[Ref <UserPoolClient>]`; `start-api` used to refuse the whole stack. This
# fixture deploys a real Cognito user pool + HTTP API via the upstream
# `cdk deploy`, mints real ID tokens, and asserts:
#   - no state source: boots, warns "JwtConfiguration.Issuer is an intrinsic"
#     (JWKS pass-through).
#   - --from-cfn-stack: issuer + audience resolved from the deployed stack, so
#     the real pool's JWKS is verified: client-A token -> 200 with the user's
#     sub; tampered signature / no header -> 401; client-B token (valid
#     signature, wrong audience) -> 401.
#   - REST v1 `CognitoUserPoolsAuthorizer` on the same pool
#     (go-to-k/cdk-local#1010), whose ProviderARNs is `Fn::GetAtt <Pool>.Arn`:
#     without a state source it boots, warns once per route naming the route,
#     and admits any Bearer token (JWKS pass-through); under --from-cfn-stack
#     the pool resolves, a real token -> 200 with the user's sub and a garbage
#     / tampered token or no header is denied.
#
# Run via `/run-integ local-start-api-user-pool-authorizer` or:
#
#     bash tests/integration/local-start-api-user-pool-authorizer/verify.sh
#
# Requires Docker, AWS credentials with deploy permissions, and the global
# `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
STACK="$(integ_stack_name CdkLocalStartApiUserPoolAuthorizerFixture)"
IMAGE="public.ecr.aws/lambda/nodejs:20"
CONTAINER_HOST="127.0.0.1"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-api-user-pool-authorizer"
CLI="node ${REPO_ROOT}/dist/cli.js"
USERNAME="integ-user"
PASSWORD="Integ-Pass-1234!aB"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed)"

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

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
  fi
  SERVER_PID=""
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
  ORPHANS=$(docker ps --filter "name=cdkl-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "[verify] cleaning up orphan containers"
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
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
CLIENT_A="$(stack_output ClientAId)"
CLIENT_B="$(stack_output ClientBId)"
for v in "${POOL_ID}" "${CLIENT_A}" "${CLIENT_B}"; do
  if [ -z "${v}" ] || [ "${v}" = "None" ]; then
    echo "[verify] FAIL: could not read stack outputs (pool=${POOL_ID} a=${CLIENT_A} b=${CLIENT_B})"
    exit 1
  fi
done
echo "[verify]   pool=${POOL_ID} clientA=${CLIENT_A} clientB=${CLIENT_B}"

echo "[verify] step 4: create a user and mint ID tokens for both clients"
aws cognito-idp admin-create-user --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --message-action SUPPRESS --region "${REGION}" >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --password "${PASSWORD}" --permanent --region "${REGION}"
USER_SUB="$(aws cognito-idp admin-get-user --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --region "${REGION}" --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)"
if [ -z "${USER_SUB}" ] || [ "${USER_SUB}" = "None" ]; then
  echo "[verify] FAIL: could not read the user's sub"
  exit 1
fi
mint_token() {
  aws cognito-idp admin-initiate-auth --user-pool-id "${POOL_ID}" --client-id "$1" \
    --auth-flow ADMIN_USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=${USERNAME},PASSWORD=${PASSWORD}" \
    --region "${REGION}" --query 'AuthenticationResult.IdToken' --output text
}
TOKEN_A="$(mint_token "${CLIENT_A}")"
TOKEN_B="$(mint_token "${CLIENT_B}")"
for t in "${TOKEN_A}" "${TOKEN_B}"; do
  case "${t}" in
    eyJ*.*.*) ;;
    *) echo "[verify] FAIL: minted token does not look like a JWT"; exit 1 ;;
  esac
done
# Tamper: flip one character in the middle of the signature segment (the last
# character carries unused base64url bits, so flipping it can leave the bytes
# unchanged).
SIG_PREFIX="${TOKEN_A%.*}"
SIG="${TOKEN_A##*.}"
if [ "${SIG:10:1}" = "A" ]; then FLIP="B"; else FLIP="A"; fi
TOKEN_TAMPERED="${SIG_PREFIX}.${SIG:0:10}${FLIP}${SIG:11}"
[ "${TOKEN_TAMPERED}" != "${TOKEN_A}" ] || { echo "[verify] FAIL: tamper was a no-op"; exit 1; }
echo "[verify]   user sub=${USER_SUB}; tokens minted"

# Called directly, never inside $( ): SERVER_PID must reach this shell so
# stop_server can reap the server. The port lands in SERVER_PORT.
start_server_and_get_port() {
  SERVER_PORT=""
  : >"${LOG_FILE}"
  # shellcheck disable=SC2086
  ${CLI} start-api \
    --container-host "${CONTAINER_HOST}" \
    --no-pull \
    "$@" \
    >"${LOG_FILE}" 2>&1 &
  SERVER_PID=$!

  local ready=0
  for _ in $(seq 1 120); do
    # Two APIs: wait for both banners.
    if [ "$(grep -c "Server listening" "${LOG_FILE}" 2>/dev/null)" -ge 2 ]; then
      ready=1
      break
    fi
    kill -0 "${SERVER_PID}" 2>/dev/null || break
    sleep 0.5
  done
  if [[ "${ready}" -eq 0 ]]; then
    echo "[verify] FAIL: start-api server did not come up. Log:" >&2
    cat "${LOG_FILE}" >&2
    return 1
  fi
  # The stack serves an HTTP API and a REST API, each on its own port.
  SERVER_PORT="$(grep -E 'Server listening on http://[^[:space:]]+\s+\(.*HTTP API v2\)' "${LOG_FILE}" \
    | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)"
  REST_PORT="$(grep -E 'Server listening on http://[^[:space:]]+\s+\(.*REST API v1\)' "${LOG_FILE}" \
    | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)"
  [ -n "${SERVER_PORT}" ] || { echo "[verify] FAIL: no HTTP API port in the start-api log" >&2; return 1; }
  [ -n "${REST_PORT}" ] || { echo "[verify] FAIL: no REST API port in the start-api log" >&2; return 1; }
}

# GET /rest-secure on the REST API; sets HTTP_CODE, body to BODY_FILE.
request_rest() {
  local port="$1" auth="$2"
  if [ -n "${auth}" ]; then
    HTTP_CODE="$(curl -s -o "${BODY_FILE}" -w '%{http_code}' \
      -H "Authorization: ${auth}" "http://127.0.0.1:${port}/rest-secure" || true)"
  else
    HTTP_CODE="$(curl -s -o "${BODY_FILE}" -w '%{http_code}' \
      "http://127.0.0.1:${port}/rest-secure" || true)"
  fi
}

# GET /secure; sets HTTP_CODE and writes the body to BODY_FILE. $2 is the
# Authorization header value ("" = send none).
request_secure() {
  local port="$1" auth="$2"
  if [ -n "${auth}" ]; then
    HTTP_CODE="$(curl -s -o "${BODY_FILE}" -w '%{http_code}' \
      -H "Authorization: ${auth}" "http://127.0.0.1:${port}/secure" || true)"
  else
    HTTP_CODE="$(curl -s -o "${BODY_FILE}" -w '%{http_code}' \
      "http://127.0.0.1:${port}/secure" || true)"
  fi
}

echo "[verify] step 5: no state source — boots with the intrinsic-issuer warning"
start_server_and_get_port
PORT_NOSTATE="${SERVER_PORT}"
echo "[verify]   server on port ${PORT_NOSTATE}"
grep -q 'JwtConfiguration.Issuer is an intrinsic' "${LOG_FILE}" || \
  fail "expected the 'JwtConfiguration.Issuer is an intrinsic' warning without a state source"
# #1010: the REST v1 Cognito authorizer's GetAtt ARN is warned per route.
grep -q 'ProviderARNs\[0\] is an intrinsic .*JWKS pass-through admits every Bearer token on route GET /rest-secure' "${LOG_FILE}" || \
  fail "expected the per-route ProviderARNs[0] warning naming GET /rest-secure without a state source"
OK=0
for _ in $(seq 1 30); do
  request_rest "${REST_PORT}" "Bearer garbage"
  if [ "${HTTP_CODE}" = "200" ]; then OK=1; break; fi
  sleep 1
done
[ "${OK}" -eq 1 ] || fail "REST, no state: garbage token expected 200 (pass-through), last got ${HTTP_CODE}"
request_rest "${REST_PORT}" "Bearer ${TOKEN_A}"
[ "${HTTP_CODE}" = "200" ] || fail "REST, no state: a real token expected 200 (pass-through), got ${HTTP_CODE}"
grep -q 'ApiKeyRequired is not enforced .*route GET /rest-secure is served without an x-api-key check' "${LOG_FILE}" || \
  fail "expected the per-route ApiKeyRequired warning for GET /rest-secure"
echo "[verify]   REST, no state: warned per route (ProviderARNs, ApiKeyRequired); garbage and real tokens -> 200 (pass-through)"
stop_server

echo "[verify] step 6: --from-cfn-stack — issuer + audience resolved from the stack"
start_server_and_get_port --from-cfn-stack
PORT_CFN="${SERVER_PORT}"
echo "[verify]   server on port ${PORT_CFN}"
grep -q 'Server listening' "${LOG_FILE}" || fail "sentinel: no 'Server listening' in the log"
if grep -q 'JwtConfiguration.Issuer is an intrinsic' "${LOG_FILE}"; then
  fail "issuer still reported as an intrinsic under --from-cfn-stack"
fi
if grep -q 'JWKS unreachable' "${LOG_FILE}"; then
  fail "JWKS unreachable under --from-cfn-stack (issuer did not resolve to the real pool)"
fi

OK=0
for _ in $(seq 1 30); do
  request_secure "${PORT_CFN}" "Bearer ${TOKEN_A}"
  if [ "${HTTP_CODE}" = "200" ]; then OK=1; break; fi
  sleep 1
done
[ "${OK}" -eq 1 ] || fail "client-A token: expected 200, last got ${HTTP_CODE} body=$(cat "${BODY_FILE}")"
grep -q "\"sub\":\"${USER_SUB}\"" "${BODY_FILE}" || \
  fail "client-A token: body sub mismatch (want ${USER_SUB}): $(cat "${BODY_FILE}")"
echo "[verify]   client-A token -> 200, sub matches"

request_secure "${PORT_CFN}" "Bearer ${TOKEN_TAMPERED}"
[ "${HTTP_CODE}" = "401" ] || fail "tampered token: expected 401, got ${HTTP_CODE}"
echo "[verify]   tampered token -> 401"

request_secure "${PORT_CFN}" ""
[ "${HTTP_CODE}" = "401" ] || fail "no Authorization header: expected 401, got ${HTTP_CODE}"
echo "[verify]   no header -> 401"

request_secure "${PORT_CFN}" "Bearer ${TOKEN_B}"
[ "${HTTP_CODE}" = "401" ] || fail "client-B token (wrong audience): expected 401, got ${HTTP_CODE}"
echo "[verify]   client-B token (wrong audience) -> 401"

# #1010: the REST v1 Cognito authorizer resolves its pool from the stack.
if grep -q 'ProviderARNs\[0\] is an intrinsic' "${LOG_FILE}"; then
  fail "REST ProviderARNs still reported as an intrinsic under --from-cfn-stack"
fi
OK=0
for _ in $(seq 1 30); do
  request_rest "${REST_PORT}" "Bearer ${TOKEN_A}"
  if [ "${HTTP_CODE}" = "200" ]; then OK=1; break; fi
  sleep 1
done
[ "${OK}" -eq 1 ] || fail "REST real token: expected 200, last got ${HTTP_CODE} body=$(cat "${BODY_FILE}")"
grep -q "\"sub\":\"${USER_SUB}\"" "${BODY_FILE}" || \
  fail "REST real token: body sub mismatch (want ${USER_SUB}): $(cat "${BODY_FILE}")"
echo "[verify]   REST real token -> 200, sub matches"
# A denied token answers 401 or 403 depending on the deny kind; never 2xx.
for bad in "Bearer garbage" "Bearer ${TOKEN_TAMPERED}" ""; do
  request_rest "${REST_PORT}" "${bad}"
  case "${HTTP_CODE}" in
    401|403) ;;
    *) fail "REST denied token (${bad:0:16}...): expected 401/403, got ${HTTP_CODE}" ;;
  esac
done
echo "[verify]   REST garbage / tampered / no header -> denied"
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
echo "[verify]   - no state source: boots with the intrinsic-issuer warning (JWKS pass-through)."
echo "[verify]   - --from-cfn-stack: issuer + audience resolved; 200 / tampered 401 / no-header 401 / wrong-audience 401."
echo "[verify]   - REST v1 Cognito (#1010): no state -> per-route warning + pass-through; --from-cfn-stack -> real token 200, garbage / tampered / none denied."
