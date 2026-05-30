#!/usr/bin/env bash
# verify.sh — cdkl start-alb authenticate-oidc full JWT-verification integ test
#
# Complements `local-start-alb-auth` (which covers the no-token -> 401
# wiring + --no-verify-auth bypass) by exercising the verifier's real
# signature + iss + aud + exp checks against a LOCAL JWKS sidecar.
#
# The fixture stack declares an authenticate-oidc action whose Issuer is
# `http://127.0.0.1:19000`. A Node sidecar (jwks-sidecar.mjs) running on
# that URL serves:
#
#   GET /.well-known/openid-configuration -> { issuer, jwks_uri }
#   GET /.well-known/jwks.json            -> { keys: [<RSA public JWK>] }
#
# `sign-jwt.mjs` mints JWTs signed by the sidecar's embedded RSA-2048
# private key. The local front-door fetches the JWKS from the sidecar
# and verifies the token end-to-end (no real Cognito / IdP needed).
#
# Phases:
#
#   PHASE 1 — valid JWT signed by the sidecar's key -> 200 (signature
#             + iss + aud + exp all check out).
#   PHASE 2 — expired JWT (exp in the past) -> 401.
#   PHASE 3 — wrong-aud JWT (signed correctly but `aud` not the
#             configured client id) -> 401.
#
# Requires Docker (for the ECS replicas) + Node (for the sidecar +
# signer; comes from .node-version).
#
#     bash tests/integration/local-start-alb-auth-jwks/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
WEB_IMAGE="public.ecr.aws/docker/library/python:3.12-alpine"
LB_HOST_PORT=18290
SIDECAR_PORT=19000
SIDECAR_ISSUER="http://127.0.0.1:${SIDECAR_PORT}"
SIDECAR_AUDIENCE="cdkl-test-client"

CDKL_PID=""
SIDECAR_PID=""

cleanup() {
  echo "==> Cleanup: stopping any leftover containers + networks + sidecar"
  if [[ -n "${CDKL_PID:-}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKL_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  if [[ -n "${SIDECAR_PID:-}" ]] && kill -0 "${SIDECAR_PID}" 2>/dev/null; then
    kill -TERM "${SIDECAR_PID}" 2>/dev/null || true
    for _ in $(seq 1 30); do
      if ! kill -0 "${SIDECAR_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${SIDECAR_PID}" 2>/dev/null || true
  fi
  docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Pre-test orphan sweep"
cleanup

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${WEB_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# Boot the JWKS sidecar in the background. The local front-door will
# fetch `<issuer>/.well-known/jwks.json` from it during JWT verification.
echo "==> Starting JWKS sidecar on port ${SIDECAR_PORT}"
SIDECAR_LOG=$(mktemp)
node jwks-sidecar.mjs "${SIDECAR_PORT}" > "${SIDECAR_LOG}" 2>&1 &
SIDECAR_PID=$!

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "${SIDECAR_ISSUER}/.well-known/jwks.json" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${SIDECAR_PID}" 2>/dev/null; then
    echo "FAIL: JWKS sidecar exited before becoming reachable"
    echo "----- sidecar output -----"; cat "${SIDECAR_LOG}"; echo "--------------------------"
    exit 1
  fi
  sleep 0.5
done
if ! curl -fsS --max-time 2 "${SIDECAR_ISSUER}/.well-known/jwks.json" >/dev/null 2>&1; then
  echo "FAIL: JWKS sidecar never became reachable at ${SIDECAR_ISSUER}"
  cat "${SIDECAR_LOG}"
  exit 1
fi
echo "    OK: sidecar serving JWKS at ${SIDECAR_ISSUER}"

# wait_for_boot — poll the cdkl log for the boot banner.
wait_for_boot() {
  local out_file="$1"
  for _ in $(seq 1 90); do
    if grep -q "Service(s) running:" "${out_file}" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
      echo "FAIL: cdk-local exited before reaching the boot banner"
      echo "----- cdk-local output -----"; cat "${out_file}"; echo "----------------------------"
      return 1
    fi
    sleep 1
  done
  echo "FAIL: cdk-local did not reach the boot banner within 90s"
  echo "----- cdk-local output -----"; cat "${out_file}"; echo "----------------------------"
  return 1
}

# Boot the front-door once and run all three JWT phases against it.
CDKL_LOG=$(mktemp)
echo ""
echo "==> Starting cdkl start-alb (authenticate-oidc enforcing)"
${CDKL} start-alb CdkLocalStartAlbAuthJwksFixture:WebLB \
  --container-host 127.0.0.1 --lb-port "80=${LB_HOST_PORT}" \
  > "${CDKL_LOG}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner"
wait_for_boot "${CDKL_LOG}"

# Wait for the front-door socket to accept connections (any HTTP status
# proves the listener is bound — 401 is the expected unauthenticated
# response and confirms the guard fires).
echo "==> Waiting for the front-door to respond on host port ${LB_HOST_PORT}"
SAW_RESPONSE=0
for _ in $(seq 1 60); do
  STATUS=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:${LB_HOST_PORT}/" 2>/dev/null || true)
  if [[ -n "${STATUS}" && "${STATUS}" != "000" ]]; then
    SAW_RESPONSE=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited while waiting for the front-door"
    cat "${CDKL_LOG}"
    exit 1
  fi
  sleep 1
done
if [[ "${SAW_RESPONSE}" -ne 1 ]]; then
  echo "FAIL: front-door never returned a response within 60s"
  cat "${CDKL_LOG}"
  exit 1
fi

# =============================================================================
# PHASE 1 — Valid JWT (signature + iss + aud + exp all valid) -> 200.
# =============================================================================
echo ""
echo "==> Phase 1: valid JWT -> 200"
VALID_JWT=$(node sign-jwt.mjs --iss "${SIDECAR_ISSUER}" --aud "${SIDECAR_AUDIENCE}" --exp-offset 300)

# Replicas may take a few seconds to come up; poll until a 200 with the
# expected body is served, but bail early if the response is a 401
# (would mean JWT verification failed, not just that replicas aren't
# ready yet).
READY=0
for _ in $(seq 1 60); do
  RESP=$(curl -sS -i --max-time 5 -H "Authorization: Bearer ${VALID_JWT}" "http://127.0.0.1:${LB_HOST_PORT}/" 2>&1 || true)
  STATUS_LINE=$(echo "${RESP}" | head -1)
  if echo "${STATUS_LINE}" | grep -qE 'HTTP/[0-9.]+ 200'; then
    BODY=$(echo "${RESP}" | awk 'BEGIN{p=0} /^\r?$/{p=1;next} p{print}')
    if [[ "${BODY}" == replica\ * ]]; then
      READY=1
      break
    fi
  fi
  if echo "${STATUS_LINE}" | grep -qE 'HTTP/[0-9.]+ 401'; then
    echo "FAIL: valid JWT was rejected with 401"
    echo "----- response -----"; echo "${RESP}"; echo "--------------------"
    echo "----- cdk-local log -----"; cat "${CDKL_LOG}"; echo "-------------------------"
    exit 1
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited mid-phase"
    cat "${CDKL_LOG}"
    exit 1
  fi
  sleep 1
done
if [[ "${READY}" -ne 1 ]]; then
  echo "FAIL: valid JWT never produced a 200 + replica body within 60s"
  echo "----- last response -----"; echo "${RESP}"; echo "-------------------------"
  echo "----- cdk-local log -----"; cat "${CDKL_LOG}"; echo "-------------------------"
  exit 1
fi
echo "    OK: 200 + replica body (signature + iss + aud + exp all verified)"

# =============================================================================
# PHASE 2 — Expired JWT (exp in the past, signature still valid) -> 401.
# =============================================================================
echo ""
echo "==> Phase 2: expired JWT -> 401"
EXPIRED_JWT=$(node sign-jwt.mjs --iss "${SIDECAR_ISSUER}" --aud "${SIDECAR_AUDIENCE}" --exp-offset -60)
RESP=$(curl -sS -i --max-time 5 -H "Authorization: Bearer ${EXPIRED_JWT}" "http://127.0.0.1:${LB_HOST_PORT}/" 2>&1)
STATUS_LINE=$(echo "${RESP}" | head -1)
if ! echo "${STATUS_LINE}" | grep -qE 'HTTP/[0-9.]+ 401'; then
  echo "FAIL: expected 401 for expired JWT, got: ${STATUS_LINE}"
  echo "----- response -----"; echo "${RESP}"; echo "--------------------"
  exit 1
fi
echo "    OK: 401 for expired JWT (exp claim in the past rejected)"

# =============================================================================
# PHASE 3 — Wrong-aud JWT (signature + iss + exp valid, aud mismatch) -> 401.
# =============================================================================
echo ""
echo "==> Phase 3: wrong-aud JWT -> 401"
WRONG_AUD_JWT=$(node sign-jwt.mjs --iss "${SIDECAR_ISSUER}" --aud "some-other-client" --exp-offset 300)
RESP=$(curl -sS -i --max-time 5 -H "Authorization: Bearer ${WRONG_AUD_JWT}" "http://127.0.0.1:${LB_HOST_PORT}/" 2>&1)
STATUS_LINE=$(echo "${RESP}" | head -1)
if ! echo "${STATUS_LINE}" | grep -qE 'HTTP/[0-9.]+ 401'; then
  echo "FAIL: expected 401 for wrong-aud JWT, got: ${STATUS_LINE}"
  echo "----- response -----"; echo "${RESP}"; echo "--------------------"
  exit 1
fi
echo "    OK: 401 for wrong-aud JWT (audience allowlist mismatch rejected)"

# All three phases passed.
echo ""
echo "==> local-start-alb-auth-jwks tests passed"
echo "    (valid JWT -> 200; expired JWT -> 401; wrong-aud JWT -> 401)"

# Cleanup runs via the EXIT trap.
rm -f "${CDKL_LOG}" "${SIDECAR_LOG}"
