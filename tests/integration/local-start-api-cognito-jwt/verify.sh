#!/usr/bin/env bash
# verify.sh — local-start-api-cognito-jwt integ test (issue #250, gap G3)
#
# Exercises cdk-local's HTTP API v2 JWT authorizer verification path
# (`verifyJwtAuthorizer` -> JWKS fetch + signature + iss + aud + exp)
# end-to-end against a local JWKS sidecar.
#
# Fixture: `GET /protected` is gated by an HttpJwtAuthorizer whose
# Issuer is `http://127.0.0.1:19001`. verify.sh boots a JWKS sidecar
# on that URL, mints a valid + expired JWT signed by the sidecar's
# RSA private key, and curls the protected route.
#
# Phases:
#   1. Valid JWT (sig + iss + aud + exp all OK) -> 200 + the protected
#      Lambda's body (proving the authorizer admitted the request).
#   2. Expired JWT (exp in the past) -> 401, no Lambda invocation.
#
# HttpJwtAuthorizer (NOT HttpUserPoolAuthorizer) is used because
# Cognito's User Pool authorizer hardcodes the JWKS URL to the real
# `cognito-idp.<region>.amazonaws.com` endpoint, which cannot be
# redirected at a local sidecar. Both authorizer kinds share the same
# `verifyJwtAuthorizer` code path in cdk-local; the only divergence is
# the JWKS URL builder, and exercising the non-Cognito branch covers
# every assertion (signature / iss / aud / exp) the Cognito branch
# would.
#
# Run via `/run-integ local-start-api-cognito-jwt` (recommended) or:
#
#     bash tests/integration/local-start-api-cognito-jwt/verify.sh
#
# Requires Docker (for the Lambda RIE base image) + Node (for the
# JWKS sidecar + JWT signer; comes from .node-version).

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3740
SIDECAR_PORT=19001
SIDECAR_ISSUER="http://127.0.0.1:${SIDECAR_PORT}"
SIDECAR_AUDIENCE="cdkl-integ-g3-aud"
CONTAINER_HOST="127.0.0.1"
BASE_URL="http://${CONTAINER_HOST}:${PORT}"

LOG_FILE="$(mktemp)"
SIDECAR_LOG="$(mktemp)"
SERVER_PID=""
SIDECAR_PID=""

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "${SERVER_PID}" 2>/dev/null || true
  fi
  if [[ -n "${SIDECAR_PID:-}" ]] && kill -0 "${SIDECAR_PID}" 2>/dev/null; then
    kill -TERM "${SIDECAR_PID}" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "${SIDECAR_PID}" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "${SIDECAR_PID}" 2>/dev/null || true
  fi
  docker ps --filter name=cdkl- -q | xargs -r docker rm -f >/dev/null 2>&1 || true
  if [[ -f "${LOG_FILE}" ]]; then
    echo "==> cdkl log (${LOG_FILE}):"
    cat "${LOG_FILE}" || true
    rm -f "${LOG_FILE}"
  fi
  rm -f "${SIDECAR_LOG}"
}
trap cleanup EXIT INT TERM

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Starting JWKS sidecar on ${SIDECAR_ISSUER}"
node jwks-sidecar.mjs "${SIDECAR_PORT}" >"${SIDECAR_LOG}" 2>&1 &
SIDECAR_PID=$!
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "${SIDECAR_ISSUER}/.well-known/jwks.json" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${SIDECAR_PID}" 2>/dev/null; then
    echo "FAIL: JWKS sidecar exited before becoming reachable"
    cat "${SIDECAR_LOG}"
    exit 1
  fi
  sleep 0.5
done
if ! curl -fsS --max-time 2 "${SIDECAR_ISSUER}/.well-known/jwks.json" >/dev/null 2>&1; then
  echo "FAIL: JWKS sidecar never became reachable at ${SIDECAR_ISSUER}"
  cat "${SIDECAR_LOG}"
  exit 1
fi
echo "    [sidecar JWKS reachable] OK"

echo "==> Booting cdkl start-api on ${BASE_URL}"
${CDKL} start-api \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 90); do
  if grep -q "Server listening on http://${CONTAINER_HOST}:${PORT}" "${LOG_FILE}" 2>/dev/null; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "FAIL: cdkl exited before reaching the listening banner"
    cat "${LOG_FILE}"
    exit 1
  fi
  sleep 1
done
if ! grep -q "Server listening" "${LOG_FILE}"; then
  echo "FAIL: cdkl did not produce listening banner within 90s"
  cat "${LOG_FILE}"
  exit 1
fi

# -----------------------------------------------------------------------
# PHASE 1 — Valid JWT -> 200 + protected Lambda body.
# -----------------------------------------------------------------------
echo ""
echo "==> Phase 1: valid JWT -> 200"
VALID_JWT=$(node sign-jwt.mjs --iss "${SIDECAR_ISSUER}" --aud "${SIDECAR_AUDIENCE}" --exp-offset 300)

RESP_FILE="$(mktemp)"
# Poll a couple of times so the JWKS cache fetch + first-request warmup
# doesn't race the assertion.
READY=0
LAST_STATUS=""
LAST_BODY=""
for _ in $(seq 1 30); do
  STATUS=$(curl -sS -o "${RESP_FILE}" -w '%{http_code}' \
    -H "Authorization: Bearer ${VALID_JWT}" \
    "${BASE_URL}/protected")
  LAST_STATUS="${STATUS}"
  LAST_BODY=$(cat "${RESP_FILE}")
  if [[ "${STATUS}" == "200" ]]; then
    READY=1
    break
  fi
  if [[ "${STATUS}" == "401" ]]; then
    # 401 on a valid JWT is a hard failure (the verifier rejected it).
    # Bail early so we see the cdkl log.
    break
  fi
  sleep 1
done
rm -f "${RESP_FILE}"
if [[ "${READY}" -ne 1 ]]; then
  echo "FAIL: expected 200 on valid JWT; got status=${LAST_STATUS}"
  echo "----- response body -----"; echo "${LAST_BODY}"; echo "-------------------------"
  echo "----- cdkl log -----"; cat "${LOG_FILE}"; echo "--------------------"
  exit 1
fi
echo "    status=${LAST_STATUS}"
echo "    body=${LAST_BODY}"
if ! echo "${LAST_BODY}" | grep -q '"protected":true'; then
  echo "FAIL: protected Lambda's body marker ('protected:true') missing"
  exit 1
fi
echo "    [200 + protected Lambda body] OK"

# -----------------------------------------------------------------------
# PHASE 2 — Expired JWT -> 401.
# -----------------------------------------------------------------------
echo ""
echo "==> Phase 2: expired JWT -> 401"
EXPIRED_JWT=$(node sign-jwt.mjs --iss "${SIDECAR_ISSUER}" --aud "${SIDECAR_AUDIENCE}" --exp-offset -60)

RESP_FILE="$(mktemp)"
STATUS=$(curl -sS -o "${RESP_FILE}" -w '%{http_code}' \
  -H "Authorization: Bearer ${EXPIRED_JWT}" \
  "${BASE_URL}/protected")
BODY=$(cat "${RESP_FILE}")
rm -f "${RESP_FILE}"
echo "    status=${STATUS}"
echo "    body=${BODY}"
if [[ "${STATUS}" != "401" ]]; then
  echo "FAIL: expected 401 on expired JWT; got ${STATUS}"
  echo "----- cdkl log -----"; cat "${LOG_FILE}"; echo "--------------------"
  exit 1
fi
echo "    [401 on expired JWT] OK"

echo ""
echo "==> local-start-api-cognito-jwt integ PASSED"
echo "    (valid JWT -> 200; expired JWT -> 401)"
