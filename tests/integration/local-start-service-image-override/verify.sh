#!/usr/bin/env bash
# verify.sh — local-start-service-image-override integ test
# (issues #238 / #240 / #244)
#
# Exercises `cdkl start-service --image-override` against a service
# whose container image is a clearly-fake ECR URI
# (`123456789012.dkr.ecr.us-east-1.amazonaws.com/cdkl-integ-placeholder:v1`).
# Without `--image-override`, the boot path detects the URI as
# "pinned to a deployed registry" and would refuse / fail to pull it.
# With `--image-override AppService=./webapp/Dockerfile`, the override
# engine substitutes a local Node Alpine build that replies with
# `OVERRIDE_OK`, proving the override path:
#
#   1. Detected the placeholder URI as pinned ("running image is
#      pinned to a deployed registry" WARN does NOT fire for
#      AppService because the override covered it).
#   2. Logged `Building override image for 'AppService'...` ahead of
#      `docker build`.
#   3. Booted the replica from the OVERRIDE image (request returns
#      `OVERRIDE_OK`, NOT a placeholder-image pull error).
#   4. SIGTERM tears every cdkl-* container + network down with no
#      orphans.
#
# Bonus second invocation: `--strict-overrides --image-override
# BadService=./webapp/Dockerfile`. `BadService` is NOT a real target
# so the engine's Stage 1 WARN ignores it; the real `AppService`
# remains uncovered; `enforceStrictOverrides` then throws with the
# message "--strict-overrides set, but 1 pinned target(s) remain
# uncovered: <target>." Asserts the boot exits non-zero with that
# message.
#
# Run via `/run-integ local-start-service-image-override` (recommended)
# or directly:
#
#     bash tests/integration/local-start-service-image-override/verify.sh
#
# Requires Docker. No AWS deploy.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
NODE_IMAGE="public.ecr.aws/docker/library/node:22-alpine"
HOST_PORT=8190

LOG_FILE="$(mktemp)"
CDKL_PID=""

term_server() {
  if [[ -n "${CDKL_PID:-}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "==> Sending SIGTERM to cdk-local (pid ${CDKL_PID})"
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do
      kill -0 "${CDKL_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${CDKL_PID}" 2>/dev/null; then
      echo "==> cdk-local did not exit within 120s; SIGKILL"
      kill -KILL "${CDKL_PID}" 2>/dev/null || true
    fi
  fi
  CDKL_PID=""
}

cleanup() {
  term_server
  docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT INT TERM

echo "==> Pre-test orphan sweep"
docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
  | xargs -r docker rm -f >/dev/null 2>&1 || true
docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
  | xargs -r docker network rm >/dev/null 2>&1 || true

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${NODE_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# -----------------------------------------------------------------------
# PHASE 1 — `--image-override AppService=./webapp/Dockerfile` boots the
# service from the local override; the placeholder ECR URI is never
# pulled. Asserts the override build log, the OVERRIDE_OK response,
# and clean teardown.
# -----------------------------------------------------------------------

echo ""
echo "==> Phase 1: boot with --image-override (host port ${HOST_PORT})"
${CDKL} start-service CdkLocalStartServiceImageOverrideFixture:AppService \
  --image-override AppService=./webapp/Dockerfile \
  --no-interactive-overrides \
  --no-pull \
  --host-port "8080=${HOST_PORT}" \
  --container-host 127.0.0.1 \
  >"${LOG_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner (up to 240s; first boot builds the override image)"
BOOTED=0
for _ in $(seq 1 240); do
  if grep -q "Service(s) running:" "${LOG_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited before reaching the boot banner"
    echo "----- service output -----"
    cat "${LOG_FILE}"
    echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: service did not reach the boot banner within 240s"
  echo "----- service output -----"
  cat "${LOG_FILE}"
  echo "--------------------------"
  exit 1
fi

echo "==> Asserting the override-build log line surfaced"
# The engine logs `Building override image for '<target>' from '<path>' (tag=...)...`
# before kicking off `docker build`. Match on the prefix + the
# AppService target name so we know the boot path picked the right
# target.
if ! grep -qE "Building override image for '[^']*AppService' from '\./webapp/Dockerfile'" "${LOG_FILE}"; then
  echo "FAIL: 'Building override image for ... AppService ... from ./webapp/Dockerfile' line not found"
  echo "----- service output -----"
  cat "${LOG_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    [override build log] OK"

echo "==> Asserting the pinned-image WARN did NOT fire for AppService (override covered it)"
# The boot WARN ("running image is pinned to a deployed registry") only
# fires for pinned targets the override engine did NOT cover. AppService
# is covered, so the WARN must NOT name it. (We intentionally do not
# scan for the WARN line in general — a future template tweak could
# add a different pinned target — only for AppService specifically.)
if grep -q "'.*AppService.*': running image is pinned to a deployed registry" "${LOG_FILE}"; then
  echo "FAIL: pinned-image WARN fired for AppService despite --image-override coverage"
  echo "----- service output -----"
  cat "${LOG_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    [pinned-image WARN suppressed for AppService] OK"

echo "==> Curl-ing the override webapp on http://127.0.0.1:${HOST_PORT}/"
URL="http://127.0.0.1:${HOST_PORT}/"
PHASE1_OK=0
PHASE1_RESP=""
for _ in $(seq 1 90); do
  if PHASE1_RESP=$(curl -sf --max-time 3 "${URL}" 2>&1); then
    if [[ "${PHASE1_RESP}" == "OVERRIDE_OK" ]]; then
      PHASE1_OK=1
      break
    fi
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited while waiting for the override webapp to serve"
    echo "----- service output -----"
    cat "${LOG_FILE}"
    echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${PHASE1_OK}" -ne 1 ]]; then
  echo "FAIL: override webapp never returned 'OVERRIDE_OK' within 90s (last response: '${PHASE1_RESP}')"
  echo "----- service output -----"
  cat "${LOG_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    [GET / -> OVERRIDE_OK] OK"

echo "==> SIGTERM cdk-local and assert clean teardown"
term_server

LEAKED_CONTAINERS=$(docker ps -a --filter "name=cdkl-" --format '{{.Names}}' | wc -l | tr -d ' ')
LEAKED_NETS=$(docker network ls --filter "name=cdkl-" --format '{{.Name}}' | wc -l | tr -d ' ')
if [[ "${LEAKED_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEAKED_CONTAINERS} container(s) leaked post-teardown:"
  docker ps -a --filter "name=cdkl-" --format '{{.Names}}'
  exit 1
fi
if [[ "${LEAKED_NETS}" -ne 0 ]]; then
  echo "FAIL: ${LEAKED_NETS} network(s) leaked post-teardown:"
  docker network ls --filter "name=cdkl-" --format '{{.Name}}'
  exit 1
fi
echo "    [clean teardown] OK"

# -----------------------------------------------------------------------
# PHASE 2 — `--strict-overrides --image-override BadService=./webapp/Dockerfile`.
# `BadService` is NOT a real target; the engine's Stage 1 logs a WARN and
# ignores the mapping. The real `AppService` remains uncovered, so
# `enforceStrictOverrides` throws `LocalStartServiceError` with
# "--strict-overrides set, but 1 pinned target(s) remain uncovered".
# Assert the process exits non-zero with the expected message.
# -----------------------------------------------------------------------

echo ""
echo "==> Phase 2: --strict-overrides with a BadService override -> non-zero exit"
LOG_FILE_STRICT="$(mktemp)"
set +e
${CDKL} start-service CdkLocalStartServiceImageOverrideFixture:AppService \
  --strict-overrides \
  --image-override BadService=./webapp/Dockerfile \
  --no-interactive-overrides \
  --no-pull \
  --host-port "8080=$((HOST_PORT + 1))" \
  --container-host 127.0.0.1 \
  >"${LOG_FILE_STRICT}" 2>&1
STRICT_EXIT=$?
set -e

if [[ "${STRICT_EXIT}" -eq 0 ]]; then
  echo "FAIL: expected --strict-overrides boot to exit non-zero; got exit 0"
  echo "----- service output -----"
  cat "${LOG_FILE_STRICT}"
  echo "--------------------------"
  rm -f "${LOG_FILE_STRICT}"
  exit 1
fi
echo "    [exit ${STRICT_EXIT}] OK (non-zero as expected)"

if ! grep -q "strict-overrides set, but" "${LOG_FILE_STRICT}"; then
  echo "FAIL: the --strict-overrides error message was not surfaced"
  echo "----- service output -----"
  cat "${LOG_FILE_STRICT}"
  echo "--------------------------"
  rm -f "${LOG_FILE_STRICT}"
  exit 1
fi
if ! grep -qE "pinned target\(s\) remain uncovered" "${LOG_FILE_STRICT}"; then
  echo "FAIL: strict-overrides error did not name the uncovered pinned target(s)"
  cat "${LOG_FILE_STRICT}"
  rm -f "${LOG_FILE_STRICT}"
  exit 1
fi
echo "    [strict-overrides error names the uncovered pinned target] OK"
rm -f "${LOG_FILE_STRICT}"

# Defense-in-depth: a non-zero boot exit shouldn't leave orphans, but
# sweep just in case.
docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
  | xargs -r docker rm -f >/dev/null 2>&1 || true
docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
  | xargs -r docker network rm >/dev/null 2>&1 || true

echo ""
echo "==> local-start-service-image-override integ PASSED"
