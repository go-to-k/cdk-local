#!/usr/bin/env bash
# verify.sh — cdkl start-cloudfront Lambda@Edge integ test (#400)
#
# Serves a CloudFront distribution whose default behavior wires ONE Lambda
# function to both the viewer-request and viewer-response event types. This
# DOES use Docker: the Lambda@Edge function is booted in a real RIE container
# and invoked with the Lambda@Edge event shape ({ Records: [{ cf }] }). The S3
# origin content is served from the local BucketDeployment asset. Asserts:
#   - GET /go  -> the viewer-request function short-circuits with a 302 -> /
#                 (a request-stage generated response).
#   - GET /    -> the viewer-request function continues to the origin (200, the
#                 root page), and the viewer-response function stamps the
#                 x-edge-stamp response header (a response-stage modification).
#   - SIGTERM frees the listening port AND tears down the Lambda@Edge container.
#
# Requires Docker. Run via `/run-integ local-start-cloudfront-edge` (recommended)
# or directly:
#
#     bash tests/integration/local-start-cloudfront-edge/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=18400
BASE="http://127.0.0.1:${PORT}"
TARGET="CdkLocalStartCloudFrontEdgeFixture/EdgeDist"

CDKL_PID=""
OUT_FILE=$(mktemp)
BODY=$(mktemp)

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
  rm -f "${OUT_FILE}" "${BODY}" "${OUT_FILE}.hdr"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "----- server output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

echo "==> Docker available + pull ${IMAGE}"
docker version --format '{{.Server.Version}}' >/dev/null
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

echo "==> Waiting for the server banner (Lambda@Edge container boot can take a moment)"
BOOTED=0
for _ in $(seq 1 240); do
  if grep -q "CloudFront distribution serving on" "${OUT_FILE}"; then BOOTED=1; break; fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then fail "server exited before it was ready"; fi
  sleep 0.5
done
[[ "${BOOTED}" -eq 1 ]] || fail "server did not print its ready banner in time"

# ---------------------------------------------------------------------------
# 1. GET /go -> viewer-request Lambda@Edge short-circuits with a 302 redirect.
# ---------------------------------------------------------------------------
echo "==> GET /go (viewer-request Lambda@Edge -> 302 redirect to /)"
GO_STATUS=$(curl -s -o /dev/null -D "${OUT_FILE}.hdr" -w '%{http_code}' "${BASE}/go") || true
[[ "${GO_STATUS}" == "302" ]] || fail "GET /go did not get the edge 302 (got ${GO_STATUS})"
grep -qi "location: /" "${OUT_FILE}.hdr" || fail "GET /go 302 missing the Location: / header"

# ---------------------------------------------------------------------------
# 2. GET / -> viewer-request continues to origin; viewer-response stamps header.
# ---------------------------------------------------------------------------
echo "==> GET / (viewer-request continues; viewer-response stamps x-edge-stamp)"
ROOT_HEADERS=$(curl -fsS -D - -o "${BODY}" "${BASE}/") || fail "GET / failed"
grep -qi "root page" "${BODY}" || fail "GET / did not serve the origin root page"
echo "${ROOT_HEADERS}" | grep -qi "x-edge-stamp: edge" \
  || fail "viewer-response Lambda@Edge did not stamp the x-edge-stamp response header"

# ---------------------------------------------------------------------------
# 3. Teardown frees the port + the Lambda@Edge container.
# ---------------------------------------------------------------------------
echo "==> SIGTERM and verify the port is freed"
kill -TERM "${CDKL_PID}" 2>/dev/null || true
for _ in $(seq 1 60); do
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then break; fi
  sleep 0.25
done
kill -0 "${CDKL_PID}" 2>/dev/null && fail "server did not exit on SIGTERM"
CDKL_PID=""
sleep 0.5
if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then fail "port ${PORT} still bound after shutdown"; fi

echo "PASS: cdkl start-cloudfront ran a Lambda@Edge function locally — a viewer-request 302 short-circuit and a viewer-response header stamp — over the S3 origin pipeline."
