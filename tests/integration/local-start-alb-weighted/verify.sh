#!/usr/bin/env bash
# verify.sh — local-start-alb-weighted integ test (issue #250, gap G5)
#
# Exercises `cdkl start-alb`'s weighted forward distribution.
# Listener default action is a `forward` with two TargetGroups[]:
# `blue` at weight 60, `green` at weight 40. Two DesiredCount=1 ECS
# services back them; each replies with its role tag (`blue` /
# `green`).
#
# verify.sh:
#   1. Boots `cdkl start-alb` against the fixture.
#   2. Waits for the front-door + both replicas to come up
#      (initial poll: `curl /` until we've seen BOTH roles at least
#      once, so the assertion phase starts with both replicas in
#      the pool).
#   3. Sends 100 GETs in a sequential loop and counts the
#      `blue` / `green` responses.
#   4. Asserts the split is within +/- 10 of the 60/40 target
#      (`50 <= blue <= 70`, `30 <= green <= 50`). The window is
#      wider than the binomial 1-sigma (~5) so the test isn't flaky
#      on a fair PRNG, but tight enough to catch a broken
#      implementation (always-pick-first / 50/50 / 100/0).
#   5. Clean teardown.
#
# Run via `/run-integ local-start-alb-weighted` (recommended) or:
#
#     bash tests/integration/local-start-alb-weighted/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
WEB_IMAGE="public.ecr.aws/docker/library/python:3.12-alpine"
LB_HOST_PORT=18093
CDKL_PID=""

cleanup() {
  echo "==> Cleanup: stopping cdkl + sweeping orphans"
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

echo "==> Booting cdkl start-alb (blue + green, DesiredCount=1 each) on listener port 80 -> host port ${LB_HOST_PORT}"
${CDKL} start-alb CdkLocalStartAlbWeightedFixture:WebLB \
  --container-host 127.0.0.1 --lb-port "80=${LB_HOST_PORT}" \
  >"${OUT_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner (up to 180s)"
BOOTED=0
for _ in $(seq 1 180); do
  if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited before reaching the boot banner"
    cat "${OUT_FILE}"
    exit 1
  fi
  sleep 1
done
if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: services did not reach the boot banner within 180s"
  cat "${OUT_FILE}"
  exit 1
fi

# Wait until BOTH replicas have answered at least once. Without this
# step the first ~20 requests can land before the slower replica is
# fully ready, biasing the count in a way that has nothing to do with
# the weighted-pick implementation.
echo "==> Waiting for both replicas to serve at least once (warmup)"
SEEN_BLUE=0
SEEN_GREEN=0
WARMUP_OK=0
for _ in $(seq 1 120); do
  RESP=$(curl -fsS --max-time 3 "http://127.0.0.1:${LB_HOST_PORT}/" 2>/dev/null || true)
  case "${RESP}" in
    blue*) SEEN_BLUE=1 ;;
    green*) SEEN_GREEN=1 ;;
  esac
  if [[ "${SEEN_BLUE}" -eq 1 && "${SEEN_GREEN}" -eq 1 ]]; then
    WARMUP_OK=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited during warmup"
    cat "${OUT_FILE}"
    exit 1
  fi
  sleep 1
done
if [[ "${WARMUP_OK}" -ne 1 ]]; then
  echo "FAIL: never saw BOTH replicas serve within warmup window (blue=${SEEN_BLUE}, green=${SEEN_GREEN})"
  cat "${OUT_FILE}"
  exit 1
fi
echo "    [warmup: blue + green both serving] OK"

# -----------------------------------------------------------------------
# 100-sample weighted-distribution count.
# -----------------------------------------------------------------------
echo ""
echo "==> Sending 100 GETs and counting blue/green responses"
TOTAL=100
BLUE=0
GREEN=0
OTHER=0
for _ in $(seq 1 "${TOTAL}"); do
  RESP=$(curl -fsS --max-time 5 "http://127.0.0.1:${LB_HOST_PORT}/" 2>/dev/null || echo "FETCH_FAIL")
  case "${RESP}" in
    blue*) BLUE=$((BLUE + 1)) ;;
    green*) GREEN=$((GREEN + 1)) ;;
    *) OTHER=$((OTHER + 1)) ;;
  esac
done

echo "    blue=${BLUE}  green=${GREEN}  other=${OTHER}  total=${TOTAL}"

if [[ "${OTHER}" -ne 0 ]]; then
  echo "FAIL: ${OTHER} request(s) returned an unexpected body"
  cat "${OUT_FILE}"
  exit 1
fi
if [[ "$((BLUE + GREEN))" -ne "${TOTAL}" ]]; then
  echo "FAIL: blue+green (${BLUE}+${GREEN}) does not sum to ${TOTAL}"
  exit 1
fi

# +/-10 window around the 60/40 target. Wide enough that a fair 60/40
# PRNG passes comfortably (binomial 1-sigma is ~5), tight enough to
# catch a broken implementation. Stricter check: each tail must hit
# at least 1 (catches "always-pick-first" / 100/0 regressions even
# if the warmup just-happened-to see both once).
EXPECTED_BLUE=60
EXPECTED_GREEN=40
TOL=10
BLUE_LO=$((EXPECTED_BLUE - TOL))
BLUE_HI=$((EXPECTED_BLUE + TOL))
GREEN_LO=$((EXPECTED_GREEN - TOL))
GREEN_HI=$((EXPECTED_GREEN + TOL))

if [[ "${BLUE}" -lt "${BLUE_LO}" || "${BLUE}" -gt "${BLUE_HI}" ]]; then
  echo "FAIL: blue count ${BLUE} outside +/-${TOL} window around ${EXPECTED_BLUE} (allowed: ${BLUE_LO}..${BLUE_HI})"
  exit 1
fi
if [[ "${GREEN}" -lt "${GREEN_LO}" || "${GREEN}" -gt "${GREEN_HI}" ]]; then
  echo "FAIL: green count ${GREEN} outside +/-${TOL} window around ${EXPECTED_GREEN} (allowed: ${GREEN_LO}..${GREEN_HI})"
  exit 1
fi
echo "    [blue/green split within +/-${TOL} of 60/40] OK"

# -----------------------------------------------------------------------
# Teardown
# -----------------------------------------------------------------------
echo ""
echo "==> SIGTERM cdk-local + assert clean teardown"
kill -TERM "${CDKL_PID}"
EXITED=0
for _ in $(seq 1 90); do
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then EXITED=1; break; fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdk-local did not exit within 90s after SIGTERM"
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
echo "==> local-start-alb-weighted integ PASSED"
