#!/usr/bin/env bash
# verify.sh — cdkl start-alb host-header + fixed-response routing integ test
# (#123 deferred listener-rule slice, no AWS deploy)
#
# Names an Application Load Balancer whose single HTTP:80 listener routes by the
# request Host header across TWO ECS services, with a fixed-response default:
#   - default action            -> fixed-response 418, body "default-fixed"
#   - host-header api.cdklocal.test (ListenerRule priority 10) -> api service
#   - host-header web.cdklocal.test (ListenerRule priority 20) -> web service
# Asserts:
#   - The host-side ALB front-door endpoint comes up on the --lb-port host port.
#   - The host-header rules were logged in the front-door routing table.
#   - GET / with Host: api.cdklocal.test -> reaches the api service.
#   - GET / with Host: web.cdklocal.test -> reaches the web service (different svc).
#   - GET / with an unmatched Host        -> the fixed-response default (418
#     "default-fixed"), synthesized by the front-door with no backing replica.
#   - SIGTERM tears every container + network + front-door socket down.
#
#     bash tests/integration/local-start-alb-routing-conditions/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
WEB_IMAGE="public.ecr.aws/docker/library/python:3.12-alpine"
LB_HOST_PORT=18088 # non-privileged host port the front-door binds (listener port 80 remapped)

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

OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT

echo "==> start-alb: naming the ALB (web + api, DesiredCount=1 each), front-door on host port ${LB_HOST_PORT}"
# Remap the privileged listener port 80 to a non-privileged host port so the
# front-door binds without root (the macOS Docker Desktop privileged-port path).
${CDKL} start-alb CdkLocalStartAlbRoutingConditionsFixture:WebLB \
  --container-host 127.0.0.1 --lb-port "80=${LB_HOST_PORT}" \
  > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner (up to 120s)"
BOOTED=0
for _ in $(seq 1 120); do
  if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited before reaching the boot banner"
    echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: services did not reach the boot banner within 120s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi

echo "==> Asserting the front-door banner + the host-header rules + fixed-response default were logged"
if ! grep -q "ALB front-door: http://127.0.0.1:${LB_HOST_PORT}" "${OUT_FILE}"; then
  echo "FAIL: front-door banner for host port ${LB_HOST_PORT} not found"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
if ! grep -q "host api.cdklocal.test" "${OUT_FILE}"; then
  echo "FAIL: host-header rule 'api.cdklocal.test' not logged in the front-door routing table"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
if ! grep -q "default -> fixed-response 418" "${OUT_FILE}"; then
  echo "FAIL: fixed-response default action not logged in the front-door routing table"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: front-door banner + host-header rules + fixed-response default present"

echo "==> Asserting the fixed-response default serves immediately (no backing replica needed)"
# The front-door binds before any replica is up; a fixed-response default needs
# no pool, so an unmatched-Host request should return 418 "default-fixed" at once.
FIXED_READY=0
for _ in $(seq 1 30); do
  FIXED_CODE=$(curl -s -o /tmp/cdkl-cond-fixed.$$ -w '%{http_code}' \
    -H 'Host: nomatch.cdklocal.test' "http://127.0.0.1:${LB_HOST_PORT}/" 2>/dev/null || true)
  if [[ "${FIXED_CODE}" == "418" ]]; then
    FIXED_READY=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited while waiting for the fixed-response default"
    echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
    exit 1
  fi
  sleep 1
done
FIXED_BODY=$(cat /tmp/cdkl-cond-fixed.$$ 2>/dev/null || true)
rm -f /tmp/cdkl-cond-fixed.$$
if [[ "${FIXED_READY}" -ne 1 ]]; then
  echo "FAIL: unmatched-Host request never returned the fixed-response 418 within 30s (got '${FIXED_CODE}')"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
if [[ "${FIXED_BODY}" != "default-fixed" ]]; then
  echo "FAIL: fixed-response body mismatch (expected 'default-fixed', got '${FIXED_BODY}')"
  exit 1
fi
echo "    OK: unmatched Host -> fixed-response 418 'default-fixed'"

echo "==> curl-ing the api host until a replica answers (replicas take a moment to start)"
API_READY=0
API_RESP=""
for _ in $(seq 1 90); do
  API_RESP=$(curl -fsS -H 'Host: api.cdklocal.test' "http://127.0.0.1:${LB_HOST_PORT}/" 2>/dev/null || true)
  if [[ -n "${API_RESP}" ]]; then
    API_READY=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited while waiting for the api host to serve"
    echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${API_READY}" -ne 1 ]]; then
  echo "FAIL: Host: api.cdklocal.test never served a 200 within 90s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    api host response: ${API_RESP}"
if [[ "${API_RESP}" != api\ * ]]; then
  echo "FAIL: Host: api.cdklocal.test was not host-routed to the api service (got: ${API_RESP})"
  exit 1
fi
echo "    OK: Host: api.cdklocal.test host-routed to the api service"

echo "==> Asserting Host: web.cdklocal.test is host-routed to the WEB service"
WEB_READY=0
WEB_RESP=""
for _ in $(seq 1 60); do
  WEB_RESP=$(curl -fsS -H 'Host: web.cdklocal.test' "http://127.0.0.1:${LB_HOST_PORT}/" 2>/dev/null || true)
  if [[ -n "${WEB_RESP}" ]]; then
    WEB_READY=1
    break
  fi
  sleep 1
done
if [[ "${WEB_READY}" -ne 1 ]]; then
  echo "FAIL: Host: web.cdklocal.test never served a 200 within 60s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    web host response: ${WEB_RESP}"
if [[ "${WEB_RESP}" != web\ * ]]; then
  echo "FAIL: Host: web.cdklocal.test was not host-routed to the web service (got: ${WEB_RESP})"
  exit 1
fi
echo "    OK: Host: web.cdklocal.test host-routed to the web service"

echo "==> Asserting the two hosts reach DIFFERENT services"
if [[ "${API_RESP%% *}" == "${WEB_RESP%% *}" ]]; then
  echo "FAIL: both hosts reached the same service role (api='${API_RESP}', web='${WEB_RESP}')"
  exit 1
fi
echo "    OK: api host and web host reach different services"

echo "==> Sending SIGTERM to cdk-local (${CDKL_PID})"
kill -TERM "${CDKL_PID}"

echo "==> Waiting for cdk-local to exit (up to 60s)"
EXITED=0
for _ in $(seq 1 60); do
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then EXITED=1; break; fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdk-local did not exit within 60s after SIGTERM"
  kill -KILL "${CDKL_PID}" 2>/dev/null || true
  exit 1
fi
wait "${CDKL_PID}" 2>/dev/null || true
CDKL_PID=""

echo "==> Asserting clean teardown — no leftover containers"
LEFTOVER_CONTAINERS=$(docker ps -a --filter "name=cdkl-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_CONTAINERS} containers still present after SIGTERM"
  docker ps -a --filter "name=cdkl-" --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
  exit 1
fi

echo "==> Asserting clean teardown — no leftover networks"
LEFTOVER_NETS=$(docker network ls --filter "name=cdkl-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_NETS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_NETS} docker networks still present after SIGTERM"
  docker network ls --filter "name=cdkl-"
  exit 1
fi

echo "==> Asserting the front-door socket is closed"
if curl -fsS --max-time 2 "http://127.0.0.1:${LB_HOST_PORT}/" >/dev/null 2>&1; then
  echo "FAIL: front-door on host port ${LB_HOST_PORT} still accepting connections after SIGTERM"
  exit 1
fi

echo ""
echo "==> local-start-alb-routing-conditions test passed (host-header -> api/web, fixed-response default, clean teardown)"
