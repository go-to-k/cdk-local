#!/usr/bin/env bash
# verify.sh — cdkl start-alb path-pattern routing integ test (#123, no AWS deploy)
#
# Names an Application Load Balancer whose single HTTP:80 listener path-routes
# across TWO ECS services:
#   - default action  -> web service (DesiredCount=2), replies "web <hostname>"
#   - path-pattern /api/* (ListenerRule priority 10) -> api service (DesiredCount=1),
#     replies "api <hostname>"
# Asserts:
#   - The host-side ALB front-door endpoint comes up on the --lb-port host port.
#   - GET /            -> reaches the web service AND round-robins >= 2 replicas.
#   - GET /api/ping    -> path-routed to the api service ("api ...").
#   - GET /            and GET /api/ping reach DIFFERENT services.
#   - SIGTERM tears every container + network + front-door socket down.
#
#     bash tests/integration/local-start-alb-routing/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
WEB_IMAGE="public.ecr.aws/docker/library/python:3.12-alpine"
LB_HOST_PORT=18087 # non-privileged host port the front-door binds (listener port 80 remapped)

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

echo "==> start-alb: naming the ALB (web DesiredCount=2 + api DesiredCount=1), front-door on host port ${LB_HOST_PORT}"
# Remap the privileged listener port 80 to a non-privileged host port so the
# front-door binds without root (the macOS Docker Desktop privileged-port path).
${CDKL} start-alb CdkLocalStartAlbRoutingFixture:WebLB \
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

echo "==> Asserting the front-door banner + the /api/* rule were logged"
if ! grep -q "ALB front-door: http://127.0.0.1:${LB_HOST_PORT}" "${OUT_FILE}"; then
  echo "FAIL: front-door banner for host port ${LB_HOST_PORT} not found"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
if ! grep -q "path /api/\*" "${OUT_FILE}"; then
  echo "FAIL: path rule '/api/*' not logged in the front-door routing table"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: front-door banner + /api/* rule present"

echo "==> curl-ing / until the front-door serves 200 (replicas take a moment to start)"
READY=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${LB_HOST_PORT}/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited while waiting for the front-door to serve"
    echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${READY}" -ne 1 ]]; then
  echo "FAIL: front-door never served a 200 on / within 90s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: front-door serving"

echo "==> Asserting GET / reaches the WEB service and round-robins >= 2 replicas"
WEB_HOSTS_FILE=$(mktemp)
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:${LB_HOST_PORT}/" 2>/dev/null >> "${WEB_HOSTS_FILE}" || true
done
echo "    sample / responses:"; sort "${WEB_HOSTS_FILE}" | uniq -c | sed 's/^/      /'
if grep -qv '^web ' "${WEB_HOSTS_FILE}"; then
  echo "FAIL: GET / returned a non-web response (default action should route to the web service)"
  cat "${WEB_HOSTS_FILE}"
  exit 1
fi
WEB_DISTINCT=$(awk '{print $2}' "${WEB_HOSTS_FILE}" | sort -u | grep -c . || true)
rm -f "${WEB_HOSTS_FILE}"
echo "    distinct web replica hostnames: ${WEB_DISTINCT}"
if [[ "${WEB_DISTINCT}" -lt 2 ]]; then
  echo "FAIL: expected / to round-robin across >= 2 web replicas, saw ${WEB_DISTINCT}"
  exit 1
fi
echo "    OK: / round-robins ${WEB_DISTINCT} web replicas"

echo "==> Asserting GET /api/ping is path-routed to the API service"
API_READY=0
API_RESP=""
for _ in $(seq 1 60); do
  API_RESP=$(curl -fsS "http://127.0.0.1:${LB_HOST_PORT}/api/ping" 2>/dev/null || true)
  if [[ -n "${API_RESP}" ]]; then
    API_READY=1
    break
  fi
  sleep 1
done
if [[ "${API_READY}" -ne 1 ]]; then
  echo "FAIL: /api/ping never served a 200 within 60s (api replica not ready / not routed)"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    /api/ping response: ${API_RESP}"
if [[ "${API_RESP}" != api\ * ]]; then
  echo "FAIL: /api/ping was not path-routed to the api service (got: ${API_RESP})"
  exit 1
fi
echo "    OK: /api/ping path-routed to the api service"

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
echo "==> local-start-alb-routing test passed (default -> web round-robin, /api/* -> api, clean teardown)"
