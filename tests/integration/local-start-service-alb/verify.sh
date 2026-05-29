#!/usr/bin/env bash
# verify.sh — cdkl start-service ALB front-door integ test (#86, no AWS deploy)
#
# Boots a 2-replica ECS Service that is ALB-fronted (LoadBalancers[] ->
# TargetGroup -> HTTP:80 Listener). Each replica is a tiny Python HTTP server
# that returns its own hostname. Asserts:
#   - The host-side ALB front-door endpoint comes up on the --lb-port host port.
#   - curl-ing it repeatedly returns HTTP 200 and reaches >= 2 distinct
#     replicas (round-robin across the local replica pool).
#   - SIGTERM tears every container + network + front-door socket down.
#
#     bash tests/integration/local-start-service-alb/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
WEB_IMAGE="public.ecr.aws/docker/library/python:3.12-alpine"
LB_HOST_PORT=18086 # non-privileged host port the front-door binds (listener port 80 remapped)

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

echo "==> Booting ALB-fronted service (DesiredCount=2), front-door on host port ${LB_HOST_PORT}"
# Remap the privileged listener port 80 to a non-privileged host port so the
# front-door binds without root (the macOS Docker Desktop privileged-port path).
${CDKL} start-service CdkLocalStartServiceAlbFixture:WebService \
  --container-host 127.0.0.1 --lb-port "80=${LB_HOST_PORT}" \
  > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner (up to 90s)"
BOOTED=0
for _ in $(seq 1 90); do
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
  echo "FAIL: service did not reach the boot banner within 90s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi

echo "==> Asserting the front-door banner was logged"
if ! grep -q "ALB front-door: http://127.0.0.1:${LB_HOST_PORT}" "${OUT_FILE}"; then
  echo "FAIL: front-door banner for host port ${LB_HOST_PORT} not found"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: front-door banner present"

echo "==> curl-ing the front-door until it serves 200 (replicas take a moment to start the HTTP server)"
READY=0
for _ in $(seq 1 60); do
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
  echo "FAIL: front-door never served a 200 within 60s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: front-door serving"

echo "==> Asserting round-robin reaches >= 2 distinct replicas"
# 20 requests is comfortably more than enough to hit both replicas under a
# round-robin (the pool rotates per request).
HOSTS_FILE=$(mktemp)
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:${LB_HOST_PORT}/" 2>/dev/null | awk '{print $2}' >> "${HOSTS_FILE}" || true
done
DISTINCT=$(sort -u "${HOSTS_FILE}" | grep -c . || true)
echo "    distinct replica hostnames seen: ${DISTINCT}"
sort "${HOSTS_FILE}" | uniq -c | sed 's/^/      /'
rm -f "${HOSTS_FILE}"
if [[ "${DISTINCT}" -lt 2 ]]; then
  echo "FAIL: expected the front-door to round-robin across >= 2 replicas, saw ${DISTINCT}"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: front-door load-balances across ${DISTINCT} replicas"

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
echo "==> local-start-service-alb test passed (front-door round-robined 2 replicas, clean teardown)"
