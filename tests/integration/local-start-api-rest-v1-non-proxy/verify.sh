#!/usr/bin/env bash
# verify.sh — local-start-api-rest-v1-non-proxy integ test (#457)
#
# Exercises `cdkl start-api`'s REST v1 non-AWS_PROXY integration
# support end-to-end against Docker + the AWS Lambda Node.js base image
# (which bundles RIE).
#
# Routes covered:
#   - GET /mock-200  -> MOCK integration with request-template-driven
#                       statusCode + response-template VTL.
#   - GET /mock-404  -> same, asserts 404 selection.
#   - GET /http-proxy -> HTTP_PROXY to httpbin.org (tolerant of network
#                       isolation — accepts 200 OR 502).
#   - POST /aws-lambda -> AWS Lambda non-proxy integration with
#                         request-side AND response-side VTL.
#   - POST /parse-json-header -> MOCK whose request template runs
#                         `$util.parseJson` over a request HEADER.
#   - POST /parse-json-body   -> AWS Lambda non-proxy whose request template
#                         runs `$util.parseJson` over the request BODY.
#     Both assert the failure message does NOT echo the parsed input
#     (go-to-k/cdkd#2203).
#
# Run via `/run-integ local-start-api-rest-v1-non-proxy` (recommended)
# or directly:
#
#     bash tests/integration/local-start-api-rest-v1-non-proxy/verify.sh
#
# Requires Docker. No AWS deploy.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3738

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  pnpm install --prefer-offline
fi


CONTAINER_HOST="127.0.0.1"
LOG_FILE="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "==> Sending SIGTERM to server (pid ${SERVER_PID})"
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for i in $(seq 1 120); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      echo "==> Server did not exit within 120s; SIGKILL"
      kill -KILL "${SERVER_PID}" 2>/dev/null || true
    fi
  fi
  # Defense-in-depth: kill any cdkl-* container the server didn't
  # clean up on its own (the existing local-start-api integ uses the
  # same sweep).
  echo "==> Sweeping any orphan cdkl-* docker containers"
  docker ps --filter name=cdkl- -q | xargs -r docker rm -f >/dev/null 2>&1 || true

  if [[ -f "${LOG_FILE}" ]]; then
    echo "==> Server log (${LOG_FILE}):"
    cat "${LOG_FILE}" || true
    rm -f "${LOG_FILE}"
  fi
}
trap cleanup EXIT INT TERM

echo "==> Booting cdkl start-api on ${CONTAINER_HOST}:${PORT}"
${CDKL} start-api \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

# Wait for the listening banner.
echo "==> Waiting for server to listen"
for i in $(seq 1 60); do
  if grep -q "Server listening on http://${CONTAINER_HOST}:${PORT}" "${LOG_FILE}" 2>/dev/null; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "==> Server exited unexpectedly"
    exit 1
  fi
  sleep 1
done

if ! grep -q "Server listening" "${LOG_FILE}"; then
  echo "==> Server did not produce listening banner within 60s"
  exit 1
fi

BASE_URL="http://${CONTAINER_HOST}:${PORT}"

assert_status() {
  local url="$1"
  local method="${2:-GET}"
  local body="${3:-}"
  local extra_headers=("${@:4}")
  if [[ "${method}" == "GET" ]]; then
    curl -sS -o /tmp/resp.body -w "%{http_code}\n%{content_type}\n" "${url}"
  else
    curl -sS -o /tmp/resp.body -w "%{http_code}\n%{content_type}\n" \
      -X "${method}" -H 'Content-Type: application/json' -d "${body}" "${url}"
  fi
}

echo "==> Curl GET ${BASE_URL}/mock-200"
OUT="$(assert_status "${BASE_URL}/mock-200")"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "200" ]]; then
  echo "FAIL: expected 200 from /mock-200, got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi
BODY="$(cat /tmp/resp.body)"
echo "    body=${BODY}"
if ! echo "${BODY}" | grep -q '"source":"mock"'; then
  echo "FAIL: /mock-200 body does not contain source=mock; body was: ${BODY}"
  exit 1
fi

echo "==> Curl GET ${BASE_URL}/mock-404"
OUT="$(assert_status "${BASE_URL}/mock-404")"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "404" ]]; then
  echo "FAIL: expected 404 from /mock-404 (driven by request-template statusCode), got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi
BODY="$(cat /tmp/resp.body)"
echo "    body=${BODY}"
if ! echo "${BODY}" | grep -q 'not found'; then
  echo "FAIL: /mock-404 body does not contain the 404 response template content; body was: ${BODY}"
  exit 1
fi

echo "==> Curl GET ${BASE_URL}/http-proxy (tolerates network isolation)"
OUT="$(assert_status "${BASE_URL}/http-proxy")"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "200" && "${STATUS}" != "502" ]]; then
  echo "FAIL: expected 200 (network reachable) or 502 (network isolated) from /http-proxy, got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi

echo "==> Curl POST ${BASE_URL}/aws-lambda"
OUT="$(assert_status "${BASE_URL}/aws-lambda" POST '{"action":"greet","name":"Alice"}')"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "200" ]]; then
  echo "FAIL: expected 200 from /aws-lambda, got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi
BODY="$(cat /tmp/resp.body)"
echo "    body=${BODY}"
# Response template wraps the Lambda's `greeting` into {"data": <value>}.
# Verifies request-side VTL extracted `name` AND response-side VTL ran.
if ! echo "${BODY}" | grep -q 'Hello, Alice'; then
  echo "FAIL: /aws-lambda body does not show the round-tripped greeting; body was: ${BODY}"
  exit 1
fi
if ! echo "${BODY}" | grep -q '"data"'; then
  echo "FAIL: /aws-lambda body does not show the response-template wrapping; body was: ${BODY}"
  exit 1
fi

# --- go-to-k/cdkd#2203: the VTL parse failure must not echo the input ----
#
# `$util.parseJson(<something the caller sent>)` is the shape that put a
# prefix of the payload into the error message, and `vtlFailure` copies that
# message into the 502 RESPONSE BODY -- so the leak crossed the HTTP
# boundary, not just the terminal. Both request-carried vectors are covered:
# a HEADER (MOCK; its VTL context is built with a hardcoded empty body) and
# the BODY (AWS Lambda non-proxy, which gets the real body).
#
# Each vector proves its PREMISE in its own step first. Without that, a route
# that stopped reaching `$util.parseJson` would make the redaction assertion
# pass while fencing nothing -- which is exactly what the first cut of this
# fixture did, answering 502 with `argument length 0` because MOCK zeroes
# the body.
#
# The needle is 9 characters: V8 appends `...` only past its ~10-char
# window, so a SHORT input is quoted in FULL. That is the shape a whole
# password was recovered with.
NEEDLE='hunter2pw'

assert_redacted() {
  local label="$1" body_file="$2" arg_len="$3"
  local body
  body="$(cat "${body_file}")"
  echo "    body=${body}"

  # POSITIVES first: "the needle is absent" alone is a confluence point that
  # any unrelated failure -- including one that never ran the template --
  # also satisfies.
  if ! echo "${body}" | grep -q 'VTL request-template evaluation failed'; then
    echo "FAIL: ${label}: 502 body is not the VTL failure envelope; body was: ${body}"
    exit 1
  fi
  if ! echo "${body}" | grep -q 'util.parseJson: the argument is not valid JSON'; then
    echo "FAIL: ${label}: 502 reason does not name the redacted parse failure; body was: ${body}"
    exit 1
  fi
  if ! echo "${body}" | grep -q 'SyntaxError'; then
    echo "FAIL: ${label}: 502 reason lost the input-independent discriminator; body was: ${body}"
    exit 1
  fi
  # Anchored with the trailing `)`: a bare `argument length 9` is a substring
  # of `argument length 90`, so an inflated count would slip through.
  if ! echo "${body}" | grep -q "argument length ${arg_len})"; then
    echo "FAIL: ${label}: 502 reason lost the argument-length detail; body was: ${body}"
    exit 1
  fi

  # THE NEGATIVE: no byte of the caller's payload may appear anywhere in the
  # response. This is THE assertion -- `vtlFailure` returns the reason in the
  # 502 body, which is the channel the defect travelled on.
  if echo "${body}" | grep -q "${NEEDLE}"; then
    echo "FAIL: ${label}: the 502 body ECHOES the caller payload (${NEEDLE}) -- go-to-k/cdkd#2203 regressed."
    echo "      body was: ${body}"
    exit 1
  fi
  # The server-log grep is a FORWARD fence, not a second proof: on today's
  # code `vtlFailure` RETURNS the outcome and nothing on that path logs the
  # reason, so this passes with the fix reverted. It is kept so that routing
  # the reason to a log later cannot reintroduce the leak unnoticed -- stated
  # rather than implied, because an assertion that cannot currently fail
  # otherwise reads as evidence it is not.
  if grep -q "${NEEDLE}" "${LOG_FILE}"; then
    echo "FAIL: ${label}: the server log ECHOES the caller payload (${NEEDLE}) -- go-to-k/cdkd#2203 regressed."
    exit 1
  fi
  echo "    ${label}: needle absent from the 502 body (and from the server log, which does not carry it today)"
}

echo "==> HEADER vector premise: POST ${BASE_URL}/parse-json-header with a VALID JSON header"
STATUS="$(curl -sS -o /tmp/resp.body -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'xpayload: {"any":"json"}' \
  -d '{}' "${BASE_URL}/parse-json-header")"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "200" ]]; then
  echo "FAIL: /parse-json-header must answer 200 for a valid JSON header, got ${STATUS}."
  echo "      The redaction assertion below would be INERT: the route is not reaching util.parseJson."
  cat /tmp/resp.body
  exit 1
fi
if ! grep -q '"parsed":true' /tmp/resp.body; then
  echo "FAIL: /parse-json-header valid case did not render the response template; body was: $(cat /tmp/resp.body)"
  exit 1
fi

echo "==> HEADER vector: POST ${BASE_URL}/parse-json-header with a NON-JSON header"
STATUS="$(curl -sS -o /tmp/resp.body -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H "xpayload: ${NEEDLE}" \
  -d '{}' "${BASE_URL}/parse-json-header")"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "502" ]]; then
  echo "FAIL: expected 502 from /parse-json-header for a non-JSON header, got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi
assert_redacted "header vector" /tmp/resp.body "${#NEEDLE}"

echo "==> BODY vector premise: POST ${BASE_URL}/parse-json-body with a VALID JSON body"
OUT="$(assert_status "${BASE_URL}/parse-json-body" POST '{"name":"Alice"}')"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "200" ]]; then
  echo "FAIL: /parse-json-body must answer 200 for a valid JSON body, got ${STATUS}."
  echo "      The redaction assertion below would be INERT: the route is not reaching util.parseJson."
  cat /tmp/resp.body
  exit 1
fi
if ! grep -q 'Hello, Alice' /tmp/resp.body; then
  echo "FAIL: /parse-json-body valid case did not round-trip through the Lambda; body was: $(cat /tmp/resp.body)"
  exit 1
fi

echo "==> BODY vector: POST ${BASE_URL}/parse-json-body with a NON-JSON body"
OUT="$(assert_status "${BASE_URL}/parse-json-body" POST "${NEEDLE}")"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "502" ]]; then
  echo "FAIL: expected 502 from /parse-json-body for a non-JSON body, got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi
assert_redacted "body vector" /tmp/resp.body "${#NEEDLE}"

echo "==> All REST v1 non-AWS_PROXY integration assertions passed (#457)"
