#!/usr/bin/env bash
# verify.sh — cdkl start-cloudfront Lambda Function URL origin integ test (#376)
#
# Serves a CloudFront distribution whose default origin is a Lambda Function
# URL (origins.FunctionUrlOrigin). Unlike the S3-origin start-cloudfront test
# this one DOES use Docker: the backing Lambda is booted in a real RIE
# container and invoked with the Function URL (payload v2.0) request/response
# shape. Asserts the full pipeline end to end:
#   - GET /        -> 200, the Lambda's JSON echo (method=GET, path=/), the
#                     viewer-response function's x-cdkl-fixture header, and the
#                     Lambda's own x-lambda-origin header + Set-Cookie.
#   - POST /api    -> the request body reaches the Lambda and is echoed back,
#                     and the method/path are forwarded.
#   - SIGTERM frees the listening port AND tears down the Lambda container.
#
# Requires Docker. Run via `/run-integ local-start-cloudfront-lambda-url`
# (recommended) or directly:
#
#     bash tests/integration/local-start-cloudfront-lambda-url/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=18376
BASE="http://127.0.0.1:${PORT}"
TARGET="CdkLocalStartCloudFrontLambdaUrlFixture/ApiDist"

CDKL_PID=""
OUT_FILE=$(mktemp)
ROOT_BODY=$(mktemp)
POST_BODY=$(mktemp)

cleanup() {
  echo "==> Cleanup: stopping the server"
  if [[ -n "${CDKL_PID}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKL_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  # Belt-and-suspenders: remove any Lambda-origin container the run left behind.
  docker ps -aq --filter name=cdkl-alblambda- | xargs -r docker rm -f >/dev/null 2>&1 || true
  rm -f "${OUT_FILE}" "${ROOT_BODY}" "${POST_BODY}"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "----- server output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Pre-test port sweep (${PORT})"
if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then
  lsof -ti "tcp:${PORT}" | xargs -r kill -9 || true
fi

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Booting: cdkl start-cloudfront ${TARGET} --port ${PORT} --no-pull"
${CDKL} start-cloudfront "${TARGET}" --port "${PORT}" --no-pull > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for the server banner (Lambda container boot can take a moment)"
BOOTED=0
for _ in $(seq 1 240); do
  if grep -q "CloudFront distribution serving on" "${OUT_FILE}"; then BOOTED=1; break; fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then fail "server exited before it was ready"; fi
  sleep 0.5
done
[[ "${BOOTED}" -eq 1 ]] || fail "server did not print its ready banner in time"

# ---------------------------------------------------------------------------
# 1. GET / -> Lambda echo + viewer-response header + Lambda header + cookie.
# ---------------------------------------------------------------------------
echo "==> GET / (Lambda Function URL origin invoke + viewer-response header)"
ROOT_HEADERS=$(curl -fsS -D - -o "${ROOT_BODY}" "${BASE}/") || fail "GET / failed"
grep -qi "hello from the lambda function url origin" "${ROOT_BODY}" \
  || fail "GET / did not return the Lambda origin's body"
grep -qi '"method":"GET"' "${ROOT_BODY}" || fail "Lambda did not see method=GET"
grep -qi '"path":"/"' "${ROOT_BODY}" || fail "Lambda did not see path=/"
echo "${ROOT_HEADERS}" | grep -qi "x-cdkl-fixture: lambda-url" \
  || fail "viewer-response function header x-cdkl-fixture not present on GET /"
echo "${ROOT_HEADERS}" | grep -qi "x-lambda-origin: hit" \
  || fail "the Lambda's own x-lambda-origin header was not forwarded"
echo "${ROOT_HEADERS}" | grep -qi "set-cookie: origin_cookie=set" \
  || fail "the Lambda's Set-Cookie (v2 cookies[]) was not emitted"

# ---------------------------------------------------------------------------
# 2. POST /api with a body -> body forwarded to + echoed by the Lambda.
# ---------------------------------------------------------------------------
echo "==> POST /api (request body forwarded to the Lambda)"
curl -fsS -X POST -H 'content-type: application/json' -d '{"ping":"pong"}' \
  -o "${POST_BODY}" "${BASE}/api" || fail "POST /api failed"
grep -qi '"method":"POST"' "${POST_BODY}" || fail "Lambda did not see method=POST"
grep -qi '"path":"/api"' "${POST_BODY}" || fail "Lambda did not see path=/api"
grep -qi 'ping' "${POST_BODY}" || fail "POST body was not forwarded to the Lambda"

# ---------------------------------------------------------------------------
# 3. Teardown frees the port AND removes the Lambda container.
# ---------------------------------------------------------------------------
echo "==> SIGTERM and verify the port + Lambda container are freed"
kill -TERM "${CDKL_PID}" 2>/dev/null || true
for _ in $(seq 1 60); do
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then break; fi
  sleep 0.25
done
kill -0 "${CDKL_PID}" 2>/dev/null && fail "server did not exit on SIGTERM"
CDKL_PID=""
sleep 0.5
if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then fail "port ${PORT} still bound after shutdown"; fi
LEFTOVER=$(docker ps -q --filter name=cdkl-alblambda- | wc -l | tr -d ' ')
[[ "${LEFTOVER}" == "0" ]] || fail "Lambda origin container not cleaned up (${LEFTOVER} running)"

echo "PASS: cdkl start-cloudfront served the Lambda Function URL origin (GET echo + viewer-response header + cookie, POST body forwarding) and tore the container down."
