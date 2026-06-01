#!/usr/bin/env bash
# verify.sh — local-start-alb-redirect integ test (issue #250, gap G4)
#
# Exercises `cdkl start-alb`'s redirect-action path end-to-end. The
# fixture stack declares an HTTP:80 listener whose DEFAULT action is
# a redirect to:
#
#   Protocol   = HTTPS
#   Host       = redirected.cdklocal.test
#   Port       = 443
#   Path       = /relocated/#{path}
#   StatusCode = HTTP_302
#
# `#{path}` is ALB's placeholder for the original request path (sans
# leading slash); cdk-local's front-door substitutes it.
#
# The default port 443 + protocol HTTPS triggers cdk-local's
# `isDefaultPort` branch (omits the port from the resolved Location),
# matching real ALB behavior.
#
# Phases:
#   1. `GET /foo/bar` -> 302 +
#      `Location: https://redirected.cdklocal.test/relocated/foo/bar`.
#   2. `GET /baz` -> 302 +
#      `Location: https://redirected.cdklocal.test/relocated/baz`.
#      Two different paths confirm `#{path}` is per-request, not
#      cached / interned.
#   3. Clean teardown — no leftover Docker containers / networks
#      (the fixture has no ECS service so the only thing to clean
#      is the front-door socket).
#
# Run via `/run-integ local-start-alb-redirect` (recommended) or:
#
#     bash tests/integration/local-start-alb-redirect/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
LB_HOST_PORT=18092
CDKL_PID=""

cleanup() {
  echo "==> Cleanup: stopping cdk-local + sweeping orphans"
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
# The redirect fixture has no ECS service, but start-alb's emulator
# still wants Docker available for sidecar setup paths. Surface a
# clear error if Docker isn't running.
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT

echo "==> Booting cdkl start-alb on listener port 80 -> host port ${LB_HOST_PORT}"
${CDKL} start-alb CdkLocalStartAlbRedirectFixture:WebLB \
  --container-host 127.0.0.1 --lb-port "80=${LB_HOST_PORT}" \
  >"${OUT_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner (up to 120s)"
BOOTED=0
for _ in $(seq 1 120); do
  if grep -qE "Service\(s\) running|ALB front-door: http" "${OUT_FILE}" 2>/dev/null; then
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
  echo "FAIL: ALB front-door did not surface within 120s"
  cat "${OUT_FILE}"
  exit 1
fi

echo "==> Asserting the front-door banner names host port ${LB_HOST_PORT}"
if ! grep -q "ALB front-door: http://127.0.0.1:${LB_HOST_PORT}" "${OUT_FILE}"; then
  echo "FAIL: front-door banner for host port ${LB_HOST_PORT} not found"
  cat "${OUT_FILE}"
  exit 1
fi
echo "    [front-door banner] OK"

# A redirect default action serves immediately — no replica needed. Poll a
# couple of times in case the front-door socket takes a moment to bind.
echo ""
echo "==> Phase 1: GET /foo/bar -> 302 + Location"
READY=0
LAST_STATUS=""
LAST_LOC=""
for _ in $(seq 1 30); do
  # `-D-` writes headers to stdout; we grep for status + Location.
  RAW=$(curl -sS -o /dev/null -D- --max-time 5 \
    "http://127.0.0.1:${LB_HOST_PORT}/foo/bar" 2>&1 || true)
  LAST_STATUS=$(echo "${RAW}" | head -1 | tr -d '\r')
  LAST_LOC=$(echo "${RAW}" | grep -i '^Location:' | head -1 | tr -d '\r')
  if [[ "${LAST_STATUS}" == HTTP/*\ 302* ]]; then
    READY=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited mid-phase"
    cat "${OUT_FILE}"
    exit 1
  fi
  sleep 1
done
if [[ "${READY}" -ne 1 ]]; then
  echo "FAIL: expected '302' status for /foo/bar; last status='${LAST_STATUS}'"
  echo "----- raw response headers -----"; echo "${RAW}"; echo "--------------------------------"
  cat "${OUT_FILE}"
  exit 1
fi
echo "    status=${LAST_STATUS}"
echo "    ${LAST_LOC}"
EXPECTED_LOC="Location: https://redirected.cdklocal.test/relocated/foo/bar"
if [[ "${LAST_LOC}" != "${EXPECTED_LOC}" ]]; then
  echo "FAIL: Location header mismatch"
  echo "  expected: '${EXPECTED_LOC}'"
  echo "  got:      '${LAST_LOC}'"
  exit 1
fi
echo "    [302 + Location with substituted #{path}] OK"

echo ""
echo "==> Phase 2: GET /baz -> 302 + Location (per-request #{path})"
RAW=$(curl -sS -o /dev/null -D- --max-time 5 \
  "http://127.0.0.1:${LB_HOST_PORT}/baz" 2>&1 || true)
PHASE2_STATUS=$(echo "${RAW}" | head -1 | tr -d '\r')
PHASE2_LOC=$(echo "${RAW}" | grep -i '^Location:' | head -1 | tr -d '\r')
echo "    status=${PHASE2_STATUS}"
echo "    ${PHASE2_LOC}"
if [[ "${PHASE2_STATUS}" != HTTP/*\ 302* ]]; then
  echo "FAIL: expected 302 for /baz, got '${PHASE2_STATUS}'"
  cat "${OUT_FILE}"
  exit 1
fi
EXPECTED_LOC2="Location: https://redirected.cdklocal.test/relocated/baz"
if [[ "${PHASE2_LOC}" != "${EXPECTED_LOC2}" ]]; then
  echo "FAIL: Location header mismatch"
  echo "  expected: '${EXPECTED_LOC2}'"
  echo "  got:      '${PHASE2_LOC}'"
  exit 1
fi
echo "    [302 + Location with second #{path}] OK"

echo ""
echo "==> SIGTERM cdk-local + assert clean teardown"
kill -TERM "${CDKL_PID}"

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

LEFTOVER_CONTAINERS=$(docker ps -a --filter "name=cdkl-" --format '{{.ID}}' | wc -l | tr -d ' ')
LEFTOVER_NETS=$(docker network ls --filter "name=cdkl-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_CONTAINERS} containers leaked post-teardown"
  docker ps -a --filter "name=cdkl-" --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
  exit 1
fi
if [[ "${LEFTOVER_NETS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_NETS} networks leaked post-teardown"
  docker network ls --filter "name=cdkl-"
  exit 1
fi

if curl -fsS --max-time 2 "http://127.0.0.1:${LB_HOST_PORT}/" >/dev/null 2>&1; then
  echo "FAIL: front-door on host port ${LB_HOST_PORT} still accepting connections after SIGTERM"
  exit 1
fi

echo ""
echo "==> local-start-alb-redirect integ PASSED"
