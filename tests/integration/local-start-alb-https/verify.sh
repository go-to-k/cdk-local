#!/usr/bin/env bash
# verify.sh — cdkl start-alb HTTPS termination integ test
#
# Names an ALB that has BOTH an HTTP:80 listener and an HTTPS:443 listener,
# each forwarding to the same 2-replica web service. The local front-door
# terminates HTTPS using either a user-supplied `--tls-cert` / `--tls-key`
# pair OR (as exercised here) an auto-generated self-signed cert cached
# under `$XDG_CACHE_HOME/cdk-local/alb-https/`.
#
# Asserts:
#   - The HTTP and HTTPS front-door banners both appear (banner uses
#     "ALB front-door: http://..." and "ALB front-door: https://...").
#   - curl -k https://<host>:<https-port>/ returns 200 with the same
#     "replica <hostname>" payload as the HTTP path.
#   - Round-robin works over HTTPS too (>= 2 distinct replica hostnames).
#   - SIGTERM tears every container + network + both front-door sockets
#     down cleanly.
#
# Requires Docker AND openssl on PATH (the auto-gen cert path shells out to
# `openssl req -x509 ...`). Linux CI runners and macOS Docker Desktop both
# satisfy this by default.
#
#     bash tests/integration/local-start-alb-https/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
WEB_IMAGE="public.ecr.aws/docker/library/python:3.12-alpine"
LB_HTTP_PORT=18186
LB_HTTPS_PORT=18443

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

echo "==> Verifying prerequisites"
docker version --format '{{.Server.Version}}' >/dev/null
command -v openssl >/dev/null || { echo "FAIL: openssl required for the auto-gen cert path"; exit 1; }

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${WEB_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT

echo "==> start-alb: HTTP on ${LB_HTTP_PORT}, HTTPS on ${LB_HTTPS_PORT}"
# Listener ports 80 and 443 are both privileged; remap each to a
# non-privileged host port so the front-door binds without root.
# `--tls` opts the HTTPS:443 listener into real local TLS termination with an
# auto-generated self-signed cert (the path this fixture asserts) — without it
# a cloud-HTTPS listener is served over plain HTTP locally by default, so the
# HTTPS front-door banner never appears.
${CDKL} start-alb CdkLocalStartAlbHttpsFixture:WebLB \
  --container-host 127.0.0.1 \
  --tls \
  --lb-port "80=${LB_HTTP_PORT}" \
  --lb-port "443=${LB_HTTPS_PORT}" \
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

echo "==> Asserting BOTH front-door banners were logged"
if ! grep -q "ALB front-door: http://127.0.0.1:${LB_HTTP_PORT}" "${OUT_FILE}"; then
  echo "FAIL: HTTP front-door banner for host port ${LB_HTTP_PORT} not found"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
if ! grep -q "ALB front-door: https://127.0.0.1:${LB_HTTPS_PORT}" "${OUT_FILE}"; then
  echo "FAIL: HTTPS front-door banner for host port ${LB_HTTPS_PORT} not found"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: HTTP + HTTPS banners both present"

echo "==> Waiting for the HTTPS front-door to serve 200 (replicas take a moment to start)"
# curl -k bypasses self-signed cert verification; we only care that TLS
# handshake completes and the backing replica responds 200.
READY=0
for _ in $(seq 1 60); do
  if curl -ksS --max-time 5 "https://127.0.0.1:${LB_HTTPS_PORT}/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited while waiting for the HTTPS front-door to serve"
    echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${READY}" -ne 1 ]]; then
  echo "FAIL: HTTPS front-door never served a 200 within 60s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: HTTPS front-door serving"

echo "==> Asserting HTTPS payload matches the backing replicas"
HTTPS_BODY=$(curl -ksS --max-time 5 "https://127.0.0.1:${LB_HTTPS_PORT}/" 2>/dev/null)
if [[ ! "${HTTPS_BODY}" =~ ^replica\  ]]; then
  echo "FAIL: HTTPS response did not start with 'replica '. Got: ${HTTPS_BODY}"
  exit 1
fi
echo "    OK: HTTPS body: ${HTTPS_BODY}"

echo "==> Asserting HTTPS round-robin reaches >= 2 distinct replicas"
HOSTS_FILE=$(mktemp)
for _ in $(seq 1 20); do
  curl -ksS --max-time 5 "https://127.0.0.1:${LB_HTTPS_PORT}/" 2>/dev/null | awk '{print $2}' >> "${HOSTS_FILE}" || true
done
DISTINCT_HTTPS=$(sort -u "${HOSTS_FILE}" | grep -c . || true)
echo "    distinct replica hostnames (HTTPS): ${DISTINCT_HTTPS}"
sort "${HOSTS_FILE}" | uniq -c | sed 's/^/      /'
rm -f "${HOSTS_FILE}"
if [[ "${DISTINCT_HTTPS}" -lt 2 ]]; then
  echo "FAIL: HTTPS front-door did not round-robin across >= 2 replicas (saw ${DISTINCT_HTTPS})"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: HTTPS front-door load-balances across ${DISTINCT_HTTPS} replicas"

echo "==> Sanity-checking HTTP path still works alongside HTTPS"
HTTP_BODY=$(curl -fsS --max-time 5 "http://127.0.0.1:${LB_HTTP_PORT}/" 2>/dev/null)
if [[ ! "${HTTP_BODY}" =~ ^replica\  ]]; then
  echo "FAIL: HTTP response did not start with 'replica '. Got: ${HTTP_BODY}"
  exit 1
fi
echo "    OK: HTTP body: ${HTTP_BODY}"

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

echo "==> Asserting both front-door sockets are closed"
if curl -ksS --max-time 2 "https://127.0.0.1:${LB_HTTPS_PORT}/" >/dev/null 2>&1; then
  echo "FAIL: HTTPS front-door on host port ${LB_HTTPS_PORT} still accepting connections after SIGTERM"
  exit 1
fi
if curl -fsS --max-time 2 "http://127.0.0.1:${LB_HTTP_PORT}/" >/dev/null 2>&1; then
  echo "FAIL: HTTP front-door on host port ${LB_HTTP_PORT} still accepting connections after SIGTERM"
  exit 1
fi

echo ""
echo "==> local-start-alb-https test passed (auto-gen self-signed cert path, dual HTTP + HTTPS, clean teardown)"
