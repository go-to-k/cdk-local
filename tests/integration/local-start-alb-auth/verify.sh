#!/usr/bin/env bash
# verify.sh — cdkl start-alb authenticate-cognito guard integ test
#
# Names an ALB whose default action is `authenticate-cognito` -> `forward`,
# and walks the two ends of the local guard:
#
#   PHASE A — guard ENFORCING (default):
#     `cdkl start-alb` (no --no-verify-auth)
#     curl http://...  WITHOUT Authorization -> 401 + WWW-Authenticate: Bearer
#
#   PHASE B — guard BYPASSED:
#     `cdkl start-alb --no-verify-auth`
#     curl http://...  WITHOUT Authorization -> 200 "replica <hostname>"
#
# Together these prove the auth-check is wired into the front-door (401
# fires before forward) AND that `--no-verify-auth` short-circuits the
# whole check for local-dev convenience. JWT verification paths
# (signature / iss / aud / exp against the JWKS / OIDC discovery URL)
# are covered by `tests/unit/local/cognito-jwt.test.ts` — out of scope
# here.
#
# Requires Docker.
#
#     bash tests/integration/local-start-alb-auth/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
WEB_IMAGE="public.ecr.aws/docker/library/python:3.12-alpine"
LB_HOST_PORT=18280

CDKL_PID=""

cleanup() {
  echo "==> Cleanup: stopping any leftover containers + networks"
  if [[ -n "${CDKL_PID:-}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKL_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
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

# wait_for_boot — poll the cdkl log for the boot banner, then for the
# front-door to start serving (which may take a few seconds longer than
# the banner under slow Docker daemons).
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

# term_cdkl — gracefully tear down the currently-running cdkl front-door
# between phase A and phase B so each phase starts from a clean slate.
term_cdkl() {
  if [[ -n "${CDKL_PID:-}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKL_PID}" 2>/dev/null; then break; fi
      sleep 1
    done
    wait "${CDKL_PID}" 2>/dev/null || true
  fi
  CDKL_PID=""
  docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
}

# =============================================================================
# PHASE A — guard ENFORCING: no --no-verify-auth, no Authorization header.
# =============================================================================
PHASE_A_LOG=$(mktemp)
trap 'rm -f "${PHASE_A_LOG}" "${PHASE_B_LOG:-}"; cleanup' EXIT

echo ""
echo "==> Phase A: cdkl start-alb (guard ENFORCING, no --no-verify-auth)"
${CDKL} start-alb CdkLocalStartAlbAuthFixture:WebLB \
  --container-host 127.0.0.1 --lb-port "80=${LB_HOST_PORT}" \
  > "${PHASE_A_LOG}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner"
wait_for_boot "${PHASE_A_LOG}"

# The front-door binds the listener port immediately after the boot banner.
# Wait until the socket is accepting connections (any HTTP response code
# is fine here — 401 is the expected one, and that proves the guard fires).
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
    echo "----- cdk-local output -----"; cat "${PHASE_A_LOG}"; echo "----------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${SAW_RESPONSE}" -ne 1 ]]; then
  echo "FAIL: front-door never returned a response within 60s"
  cat "${PHASE_A_LOG}"
  exit 1
fi

echo "==> Asserting unauthenticated GET returns 401"
# `-i` includes headers so we can also assert the WWW-Authenticate response
# header tells the caller HOW to authenticate (Bearer realm).
RESP=$(curl -sS -i --max-time 5 "http://127.0.0.1:${LB_HOST_PORT}/" 2>&1)
STATUS_LINE=$(echo "${RESP}" | head -1)
if ! echo "${STATUS_LINE}" | grep -qE 'HTTP/[0-9.]+ 401'; then
  echo "FAIL: expected 401 from guard-enforcing front-door, got: ${STATUS_LINE}"
  echo "----- response -----"; echo "${RESP}"; echo "--------------------"
  exit 1
fi
if ! echo "${RESP}" | grep -qiE '^WWW-Authenticate:[[:space:]]*Bearer'; then
  echo "FAIL: expected WWW-Authenticate: Bearer header on 401 response, got:"
  echo "${RESP}"
  exit 1
fi
echo "    OK: 401 + WWW-Authenticate: Bearer (guard fires before forward)"

echo "==> Phase A: tearing down before phase B"
term_cdkl
rm -f "${PHASE_A_LOG}"

# =============================================================================
# PHASE B — guard BYPASSED: --no-verify-auth, no Authorization header.
# =============================================================================
PHASE_B_LOG=$(mktemp)

echo ""
echo "==> Phase B: cdkl start-alb --no-verify-auth (guard BYPASSED)"
${CDKL} start-alb CdkLocalStartAlbAuthFixture:WebLB \
  --container-host 127.0.0.1 --lb-port "80=${LB_HOST_PORT}" \
  --no-verify-auth \
  > "${PHASE_B_LOG}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner"
wait_for_boot "${PHASE_B_LOG}"

echo "==> curl-ing the front-door until it serves 200 (replicas take a moment)"
READY=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${LB_HOST_PORT}/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited while waiting for the bypassed front-door to serve"
    cat "${PHASE_B_LOG}"
    exit 1
  fi
  sleep 1
done
if [[ "${READY}" -ne 1 ]]; then
  echo "FAIL: bypassed front-door never returned a 200 within 60s"
  cat "${PHASE_B_LOG}"
  exit 1
fi

echo "==> Asserting unauthenticated GET returns 200 with replica body"
BODY=$(curl -fsS --max-time 5 "http://127.0.0.1:${LB_HOST_PORT}/" 2>&1)
if [[ ! "${BODY}" =~ ^replica\  ]]; then
  echo "FAIL: bypassed front-door response did not start with 'replica '. Got: ${BODY}"
  exit 1
fi
echo "    OK: 200 with body \"${BODY}\" (--no-verify-auth bypassed the guard)"

echo "==> Phase B: tearing down"
term_cdkl
rm -f "${PHASE_B_LOG}"

echo ""
echo "==> local-start-alb-auth tests passed (guard 401 + --no-verify-auth bypass)"
