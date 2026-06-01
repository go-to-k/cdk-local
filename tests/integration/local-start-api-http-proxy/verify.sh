#!/usr/bin/env bash
# verify.sh — local-start-api-http-proxy integ test (issue #250, gap G2)
#
# Exercises `cdkl start-api`'s REST v1 HTTP_PROXY happy path end-to-end.
# Boots a local mock HTTP server on 127.0.0.1:18091 that echoes the
# request method + path + headers + body. The fixture stack declares
# `ANY /echo` as an HTTP_PROXY integration to that URL.
#
# Phases:
#   1. GET /echo with `X-Integ-Trace: hello-G2`. Assert 200 +
#      response body contains the echoed method (`GET`), path
#      (`/echo`), AND the trace header value — proving header
#      pass-through to the upstream.
#   2. POST /echo with a JSON payload. Assert 200 + response body
#      contains the echoed payload — proving body pass-through.
#
# Run via `/run-integ local-start-api-http-proxy` (recommended) or:
#
#     bash tests/integration/local-start-api-http-proxy/verify.sh
#
# Requires Docker (for the Lambda RIE base image cdkl pulls during
# start-api boot, even though no Lambda is invoked in this fixture —
# start-api still preheats the base image).

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3739
MOCK_PORT=18091
CONTAINER_HOST="127.0.0.1"
BASE_URL="http://${CONTAINER_HOST}:${PORT}"
MOCK_URL="http://127.0.0.1:${MOCK_PORT}/echo"

LOG_FILE="$(mktemp)"
MOCK_LOG="$(mktemp)"
SERVER_PID=""
MOCK_PID=""

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "==> Sending SIGTERM to cdkl (pid ${SERVER_PID})"
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "${SERVER_PID}" 2>/dev/null || true
  fi
  if [[ -n "${MOCK_PID:-}" ]] && kill -0 "${MOCK_PID}" 2>/dev/null; then
    echo "==> Sending SIGTERM to mock-upstream (pid ${MOCK_PID})"
    kill -TERM "${MOCK_PID}" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "${MOCK_PID}" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "${MOCK_PID}" 2>/dev/null || true
  fi
  echo "==> Sweeping any orphan cdkl-* docker containers"
  docker ps --filter name=cdkl- -q | xargs -r docker rm -f >/dev/null 2>&1 || true
  if [[ -f "${LOG_FILE}" ]]; then
    echo "==> cdkl log (${LOG_FILE}):"
    cat "${LOG_FILE}" || true
    rm -f "${LOG_FILE}"
  fi
  rm -f "${MOCK_LOG}"
}
trap cleanup EXIT INT TERM

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# Start the mock upstream first so cdkl HTTP_PROXY dispatches reach
# a live listener.
echo "==> Starting mock upstream on ${MOCK_URL}"
node mock-upstream.mjs "${MOCK_PORT}" >"${MOCK_LOG}" 2>&1 &
MOCK_PID=$!

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "${MOCK_URL}" -o /dev/null 2>/dev/null; then
    break
  fi
  if ! kill -0 "${MOCK_PID}" 2>/dev/null; then
    echo "FAIL: mock-upstream exited before becoming reachable"
    cat "${MOCK_LOG}"
    exit 1
  fi
  sleep 0.5
done
if ! curl -fsS --max-time 2 "${MOCK_URL}" -o /dev/null 2>/dev/null; then
  echo "FAIL: mock-upstream never became reachable at ${MOCK_URL}"
  cat "${MOCK_LOG}"
  exit 1
fi
echo "    [mock-upstream ready] OK"

echo "==> Booting cdkl start-api on ${CONTAINER_HOST}:${PORT}"
${CDKL} start-api \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

echo "==> Waiting for cdkl listening banner"
for _ in $(seq 1 90); do
  if grep -q "Server listening on http://${CONTAINER_HOST}:${PORT}" "${LOG_FILE}" 2>/dev/null; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "FAIL: cdkl exited before reaching the listening banner"
    cat "${LOG_FILE}"
    exit 1
  fi
  sleep 1
done
if ! grep -q "Server listening" "${LOG_FILE}"; then
  echo "FAIL: cdkl did not produce listening banner within 90s"
  cat "${LOG_FILE}"
  exit 1
fi

# -----------------------------------------------------------------------
# PHASE 1 — GET /echo with X-Integ-Trace header.
# -----------------------------------------------------------------------
echo ""
echo "==> Phase 1: GET /echo with trace header"
RESP_FILE="$(mktemp)"
STATUS=$(curl -sS -o "${RESP_FILE}" -w '%{http_code}' \
  -H 'X-Integ-Trace: hello-G2' \
  "${BASE_URL}/echo")
BODY=$(cat "${RESP_FILE}")
rm -f "${RESP_FILE}"
echo "    status=${STATUS}"
echo "    body=${BODY}"
if [[ "${STATUS}" != "200" ]]; then
  echo "FAIL: expected 200 on GET /echo, got ${STATUS}"
  echo "----- cdkl log -----"; cat "${LOG_FILE}"; echo "--------------------"
  exit 1
fi
if ! echo "${BODY}" | grep -q '"method":"GET"'; then
  echo "FAIL: response body did not echo method=GET"
  exit 1
fi
if ! echo "${BODY}" | grep -q '"url":"/echo"'; then
  echo "FAIL: response body did not echo url=/echo"
  exit 1
fi
if ! echo "${BODY}" | grep -q '"traceHeader":"hello-G2"'; then
  echo "FAIL: response body did not forward the X-Integ-Trace header (header pass-through broken)"
  exit 1
fi
echo "    [GET /echo: method + path + header pass-through] OK"

# -----------------------------------------------------------------------
# PHASE 2 — POST /echo with JSON body.
# -----------------------------------------------------------------------
echo ""
echo "==> Phase 2: POST /echo with JSON body"
RESP_FILE="$(mktemp)"
STATUS=$(curl -sS -o "${RESP_FILE}" -w '%{http_code}' \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world","gap":"G2"}' \
  "${BASE_URL}/echo")
BODY=$(cat "${RESP_FILE}")
rm -f "${RESP_FILE}"
echo "    status=${STATUS}"
echo "    body=${BODY}"
if [[ "${STATUS}" != "200" ]]; then
  echo "FAIL: expected 200 on POST /echo, got ${STATUS}"
  echo "----- cdkl log -----"; cat "${LOG_FILE}"; echo "--------------------"
  exit 1
fi
if ! echo "${BODY}" | grep -q '"method":"POST"'; then
  echo "FAIL: response body did not echo method=POST"
  exit 1
fi
# The mock embeds the request body verbatim as a string under
# `"body":"..."`. Look for the original JSON payload substring.
if ! echo "${BODY}" | grep -q 'hello' || ! echo "${BODY}" | grep -q 'world'; then
  echo "FAIL: response body did not forward the POST request body (body pass-through broken)"
  exit 1
fi
echo "    [POST /echo: method + body pass-through] OK"

echo ""
echo "==> local-start-api-http-proxy integ PASSED"
