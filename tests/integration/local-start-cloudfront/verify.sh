#!/usr/bin/env bash
# verify.sh — cdkl start-cloudfront integ test (#363, no AWS, no Docker)
#
# Serves a static-site CloudFront distribution locally: an S3 origin whose
# content is the BucketDeployment source asset resolved out of the cloud
# assembly + two CloudFront Functions (a viewer-request rewrite and a
# viewer-response header stamp). Asserts the full pipeline end to end:
#   - GET /        -> 200, default root object (index.html), and the
#                     viewer-response function's x-cdkl-fixture header.
#   - GET /foo     -> the viewer-request function rewrites it to
#                     /foo/index.html and the S3 origin serves that key.
#   - GET /missing -> the 403 -> /404.html (200) CustomErrorResponse fires
#                     (the SPA fallback for a missing key).
#   - OPTIONS /    -> the behavior's ResponseHeadersPolicy CORS answers the
#                     preflight (204 + Access-Control-Allow-Origin) and an
#                     actual GET with an allowed Origin carries it; a
#                     disallowed origin gets none.
#   - --watch      -> editing the site source re-synths + swaps the routing
#                     model under the live socket; the new content is served.
#   - SIGTERM frees the listening port.
#
#     bash tests/integration/local-start-cloudfront/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
PORT=18363
BASE="http://127.0.0.1:${PORT}"
TARGET="CdkLocalStartCloudFrontFixture/SiteDist"

CDKL_PID=""
OUT_FILE=$(mktemp)

cleanup() {
  echo "==> Cleanup: stopping the server"
  if [[ -n "${CDKL_PID}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 40); do
      if ! kill -0 "${CDKL_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  # Restore any file the --watch scenario edited.
  if [[ -f site/index.html.bak ]]; then
    mv -f site/index.html.bak site/index.html
  fi
  rm -f "${OUT_FILE}"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "----- server output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

echo "==> Pre-test port sweep (${PORT})"
if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then
  lsof -ti "tcp:${PORT}" | xargs -r kill -9 || true
fi

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Booting: cdkl start-cloudfront ${TARGET} --port ${PORT} --watch"
${CDKL} start-cloudfront "${TARGET}" --port "${PORT}" --watch > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for the server banner"
BOOTED=0
for _ in $(seq 1 120); do
  if grep -q "CloudFront distribution serving on" "${OUT_FILE}"; then BOOTED=1; break; fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then fail "server exited before it was ready"; fi
  sleep 0.5
done
[[ "${BOOTED}" -eq 1 ]] || fail "server did not print its ready banner in time"

# ---------------------------------------------------------------------------
# 1. Default root object + viewer-response header.
# ---------------------------------------------------------------------------
echo "==> GET / (default root object + viewer-response header)"
ROOT_HEADERS=$(curl -fsS -D - -o /tmp/cdkl-cf-root.$$ "${BASE}/") || fail "GET / failed"
grep -qi "root page" /tmp/cdkl-cf-root.$$ || fail "GET / did not serve the root index.html"
echo "${ROOT_HEADERS}" | grep -qi "x-cdkl-fixture: start-cloudfront" \
  || fail "viewer-response function header x-cdkl-fixture not present on GET /"
rm -f /tmp/cdkl-cf-root.$$

# ---------------------------------------------------------------------------
# 2. viewer-request rewrite: /foo -> /foo/index.html.
# ---------------------------------------------------------------------------
echo "==> GET /foo (viewer-request rewrite -> /foo/index.html)"
FOO_BODY=$(curl -fsS "${BASE}/foo") || fail "GET /foo failed"
echo "${FOO_BODY}" | grep -qi "foo page" \
  || fail "viewer-request rewrite did not resolve /foo to /foo/index.html"

# ---------------------------------------------------------------------------
# 3. CustomErrorResponses SPA fallback: missing key -> 403 -> /404.html (200).
# ---------------------------------------------------------------------------
echo "==> GET /does-not-exist (403 -> /404.html (200) SPA fallback)"
MISS_STATUS=$(curl -s -o /tmp/cdkl-cf-miss.$$ -w '%{http_code}' "${BASE}/does-not-exist") || true
[[ "${MISS_STATUS}" == "200" ]] || fail "missing key did not return the custom-error 200 (got ${MISS_STATUS})"
grep -qi "spa fallback" /tmp/cdkl-cf-miss.$$ || fail "missing key did not serve the /404.html custom-error page"
rm -f /tmp/cdkl-cf-miss.$$

# ---------------------------------------------------------------------------
# 4. ResponseHeadersPolicy CORS: an OPTIONS preflight is answered at the edge
#    with the CORS headers, and an actual GET carries Access-Control-Allow-Origin.
# ---------------------------------------------------------------------------
echo "==> OPTIONS / preflight (ResponseHeadersPolicy CORS, allowed origin)"
PREFLIGHT_STATUS=$(curl -s -o /dev/null -D /tmp/cdkl-cf-pre.$$ -w '%{http_code}' \
  -X OPTIONS \
  -H 'Origin: http://127.0.0.1:5050' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  "${BASE}/") || true
[[ "${PREFLIGHT_STATUS}" == "204" ]] \
  || fail "CORS preflight did not return 204 (got ${PREFLIGHT_STATUS})"
grep -qi "access-control-allow-origin: http://127.0.0.1:5050" /tmp/cdkl-cf-pre.$$ \
  || fail "CORS preflight missing Access-Control-Allow-Origin for the allowed origin"
grep -qi "access-control-allow-methods: GET" /tmp/cdkl-cf-pre.$$ \
  || fail "CORS preflight missing Access-Control-Allow-Methods"
rm -f /tmp/cdkl-cf-pre.$$

echo "==> GET / with Origin (actual-response Access-Control-Allow-Origin)"
CORS_HEADERS=$(curl -fsS -D - -o /dev/null -H 'Origin: http://127.0.0.1:5050' "${BASE}/") \
  || fail "GET / with Origin failed"
echo "${CORS_HEADERS}" | grep -qi "access-control-allow-origin: http://127.0.0.1:5050" \
  || fail "actual GET response missing Access-Control-Allow-Origin"

echo "==> OPTIONS / preflight from a disallowed origin (no ACAO smuggled through)"
curl -s -o /dev/null -D /tmp/cdkl-cf-bad.$$ \
  -X OPTIONS \
  -H 'Origin: https://evil.example.com' \
  -H 'Access-Control-Request-Method: GET' \
  "${BASE}/" || true
if grep -qi "access-control-allow-origin" /tmp/cdkl-cf-bad.$$; then
  rm -f /tmp/cdkl-cf-bad.$$
  fail "disallowed origin received an Access-Control-Allow-Origin header"
fi
rm -f /tmp/cdkl-cf-bad.$$

# ---------------------------------------------------------------------------
# 5. --watch: edit the site source, expect the new content served after reload.
# ---------------------------------------------------------------------------
echo "==> --watch: edit site/index.html and expect the reload to serve it"
cp site/index.html site/index.html.bak
printf '<!doctype html><html><body><h1>reloaded root</h1></body></html>\n' > site/index.html
RELOADED=0
for _ in $(seq 1 120); do
  if curl -fsS "${BASE}/" 2>/dev/null | grep -qi "reloaded root"; then RELOADED=1; break; fi
  sleep 0.5
done
mv -f site/index.html.bak site/index.html
[[ "${RELOADED}" -eq 1 ]] || fail "--watch did not serve the edited site content after a reload"

# ---------------------------------------------------------------------------
# 6. Teardown frees the port.
# ---------------------------------------------------------------------------
echo "==> SIGTERM and verify the port is freed"
kill -TERM "${CDKL_PID}" 2>/dev/null || true
for _ in $(seq 1 40); do
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then break; fi
  sleep 0.25
done
kill -0 "${CDKL_PID}" 2>/dev/null && fail "server did not exit on SIGTERM"
CDKL_PID=""
sleep 0.5
if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then fail "port ${PORT} still bound after shutdown"; fi

echo "PASS: cdkl start-cloudfront served the viewer-request -> S3 origin -> viewer-response pipeline, the SPA fallback, ResponseHeadersPolicy CORS (preflight + actual-response), and a --watch reload."
