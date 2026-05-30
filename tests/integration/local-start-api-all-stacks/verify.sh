#!/usr/bin/env bash
# verify.sh — local-start-api-all-stacks integ test
#
# Exercises `cdkl start-api --all-stacks` end-to-end against Docker + the
# AWS Lambda Node.js base image (which bundles RIE). The fixture stands
# up two CDK stacks, each with one HTTP API v2 + one Lambda:
#
#   - CdkLocalStartApiAllStacksA / PingApi  -> GET /ping -> PingHandler ("a")
#   - CdkLocalStartApiAllStacksB / PongApi  -> GET /pong -> PongHandler ("b")
#
# With `--all-stacks`, cdkl serves both APIs as a union — one local HTTP
# listener per API, each on its own auto-assigned port. The verify pipeline:
#
#   1. Launch `cdkl start-api --all-stacks` in the background.
#   2. Wait for both "Server listening" lines.
#   3. Extract the per-stack ports from the log.
#   4. curl each route on its own port; assert the response came from the
#      backing Lambda (greps for "stack":"a" / "stack":"b").
#
# Run via `/run-integ local-start-api-all-stacks` (recommended) or:
#
#     bash tests/integration/local-start-api-all-stacks/verify.sh
#
# Requires Docker.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3737

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# Container-host on Linux is 'host.docker.internal' but only resolves
# automatically on Docker Desktop. The server defaults to that, but
# Linux CI hosts (or any docker daemon without the magic alias) need
# the explicit `--add-host` plumbing — out of scope here, so we use
# 127.0.0.1. Matches what the local-start-api integ does.
CONTAINER_HOST="127.0.0.1"

LOG_FILE="$(mktemp)"
SERVER_PID=""

term_server() {
  local pid="$1" label="$2"
  if [[ -n "${pid:-}" ]] && kill -0 "${pid}" 2>/dev/null; then
    echo "==> Sending SIGTERM to ${label} (pid ${pid})"
    kill -TERM "${pid}" 2>/dev/null || true
    for i in $(seq 1 120); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${pid}" 2>/dev/null; then
      echo "==> ${label} did not exit within 120s; SIGKILL"
      kill -KILL "${pid}" 2>/dev/null || true
    fi
  fi
}

cleanup() {
  term_server "${SERVER_PID:-}" "server"
  ORPHANS=$(docker ps --filter "name=cdkl-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "==> Cleaning up orphan containers"
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT INT TERM

echo "==> Starting cdkl start-api --all-stacks on port ${PORT}"
${CDKL} start-api \
  --all-stacks \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  --no-pull \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

# With --all-stacks, cdkl launches one HTTP server per stack's API.
# This fixture has 2 stacks × 1 API each = 2 servers expected.
echo "==> Waiting for 2 servers (one per stack) to come up"
EXPECTED_SERVERS=2
READY=0
for i in $(seq 1 60); do
  # `grep -c` outputs "0" AND exits non-zero on zero matches, so a
  # naive `|| echo 0` concatenates both into "0\n0" and trips up
  # the `[[ ... -ge ... ]]` arithmetic. Capture stdout, then default
  # to 0 only when grep actually failed.
  count=$(grep -c "Server listening" "${LOG_FILE}" 2>/dev/null) || count=0
  if [[ "${count}" -ge "${EXPECTED_SERVERS}" ]]; then
    READY=1
    break
  fi
  sleep 0.5
done
if [[ "${READY}" -eq 0 ]]; then
  echo "FAIL: only ${count}/${EXPECTED_SERVERS} servers came up within 30s. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

echo "==> Server log preview:"
head -40 "${LOG_FILE}" | sed 's/^/    /'

# Extract per-stack ports from "Server listening on http://host:PORT  (ApiId (HTTP API v2))".
# cdkl's listener label is the API's CDK construct ID + the API kind; the stack
# name itself is not in the label. So we anchor by the API construct ID prefix
# (`PingApi` / `PongApi`) — distinct across the two stacks by design — followed
# by CDK's 8-hex-char suffix and the literal "(HTTP API v2)" kind tag, mirroring
# the construct-ID anchor pattern the local-start-api integ uses.
PORT_STACK_A=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(PingApi[A-F0-9]{8}\s+\(HTTP API v2\)\)' \
  "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
PORT_STACK_B=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(PongApi[A-F0-9]{8}\s+\(HTTP API v2\)\)' \
  "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
if [[ -z "${PORT_STACK_A}" || -z "${PORT_STACK_B}" ]]; then
  echo "FAIL: could not extract per-stack ports."
  echo "  PORT_STACK_A=${PORT_STACK_A}"
  echo "  PORT_STACK_B=${PORT_STACK_B}"
  echo "Log:"
  cat "${LOG_FILE}"
  exit 1
fi
echo "==> Listening: StackA on ${PORT_STACK_A}, StackB on ${PORT_STACK_B}"

# curl wrapper with retry — RIE container boot from cold can take several
# seconds, so a single curl may race the readiness of the warm container.
curl_assert() {
  local label="$1" url="$2" expect="$3"
  local response=""
  for attempt in 1 2 3 4 5 6 7 8; do
    if response=$(curl -sf "${url}" 2>&1); then
      if echo "${response}" | grep -q "${expect}"; then
        echo "    ok: ${label}"
        return 0
      fi
      echo "FAIL: ${label} response did not contain \"${expect}\". Response: ${response}"
      return 1
    fi
    sleep 1
  done
  echo "FAIL: ${label} curl failed after retries. URL: ${url}, last response: ${response}"
  return 1
}

echo "==> Smoke-testing both stacks via curl"
curl_assert "StackA GET /ping" "http://127.0.0.1:${PORT_STACK_A}/ping" '"stack":"a"'
curl_assert "StackB GET /pong" "http://127.0.0.1:${PORT_STACK_B}/pong" '"stack":"b"'

# Cross-check isolation: StackA's port must NOT route to StackB's handler.
# Treat both "200" AND "empty" as failures — empty means curl could not even
# reach the listener (connection refused / RIE container crashed), which would
# otherwise pass silently.
echo "==> Asserting per-stack isolation (StackA port does NOT serve /pong)"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT_STACK_A}/pong" || true)
if [[ -z "${STATUS}" || "${STATUS}" == "200" ]]; then
  echo "FAIL: StackA port for /pong returned \"${STATUS}\" — expected non-200, non-empty"
  exit 1
fi
echo "    ok: /pong on StackA port returned ${STATUS} (non-200 expected)"

echo "==> All local-start-api-all-stacks tests passed"
