#!/usr/bin/env bash
# verify.sh — cdkl start-cloudfront integ test (#363, no AWS; Docker only for WebDist)
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
#   - WebDist (go-to-k/cdkd#5516): a Lambda Web Function endpoint origin runs
#     the revision the endpoint weights pick in a container (Docker) and the
#     origin request is forwarded to it, with the viewer-response function and
#     the ResponseHeadersPolicy CORS applied over its response; a /deploy/*
#     behavior reaches a second endpoint whose code is an extract: false
#     BucketDeployment. SIGTERM removes every web function container.
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
  if [[ -n "${WARN_PID:-}" ]] && kill -0 "${WARN_PID}" 2>/dev/null; then
    kill -KILL "${WARN_PID}" 2>/dev/null || true
  fi
  if [[ -n "${WEB_PID:-}" ]] && kill -0 "${WEB_PID}" 2>/dev/null; then
    kill -TERM "${WEB_PID}" 2>/dev/null || true
    for _ in $(seq 1 80); do
      if ! kill -0 "${WEB_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${WEB_PID}" 2>/dev/null || true
  fi
  if [[ -n "${WEB_OUT:-}" ]]; then rm -f "${WEB_OUT}"; fi
  if [[ -n "${WEB_HEADERS_FILE:-}" ]]; then rm -f "${WEB_HEADERS_FILE}"; fi
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

# The --kvs-file key is a KeyValueStore HANDLE: its logical id, its construct
# path, or its bare construct id (issue #465). We pass the bare construct id
# `RoutesKvs` — the stable, ergonomic form — instead of the hash-suffixed logical
# id, so this run exercises the construct-id -> logical-id normalization
# end-to-end (the binding still matches strictly by logical id). cdkl resolves it
# from the synthesized template's aws:cdk:path; no standalone synth + grep needed.
KVS_KEY="RoutesKvs"
KVS_FILE="$(pwd)/kvs.json"

echo "==> Booting: cdkl start-cloudfront ${TARGET} --port ${PORT} --watch --kvs-file ${KVS_KEY}=${KVS_FILE}"
${CDKL} start-cloudfront "${TARGET}" --port "${PORT}" --watch \
  --kvs-file "${KVS_KEY}=${KVS_FILE}" > "${OUT_FILE}" 2>&1 &
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
# 2b. KeyValueStore-backed viewer-request rewrite (--kvs-file): the /kv/*
#     behavior's function reads cf.kvs().get('/kv/go') -> '/foo/index.html'
#     from the local JSON map, exercising the import-cf-from-cloudfront
#     transform + cf.kvs() runtime path with no AWS (issue #399). The
#     --kvs-file key here is the BARE CONSTRUCT ID `RoutesKvs`, so a passing
#     rewrite proves the construct-id -> logical-id normalization too (#465).
# ---------------------------------------------------------------------------
echo "==> GET /kv/go (KeyValueStore rewrite -> /foo/index.html via --kvs-file RoutesKvs=...)"
KV_BODY=$(curl -fsS "${BASE}/kv/go") || fail "GET /kv/go failed"
echo "${KV_BODY}" | grep -qi "foo page" \
  || fail "KeyValueStore-backed rewrite did not resolve /kv/go to /foo/index.html"
# The binding resolved, so the unbound-KVS warning must NOT have fired.
if grep -qi "no binding resolved it" "${OUT_FILE}"; then
  fail "the KeyValueStore association was reported unbound despite --kvs-file"
fi

# ---------------------------------------------------------------------------
# 2c. Buffer global in a cloudfront-js-2.0 function: the /secure/* behavior's
#     Basic-Auth function builds the expected Authorization header with
#     Buffer.from('user:pass').toString('base64'). Previously this failed with
#     "Buffer is not defined" (issue #410).
# ---------------------------------------------------------------------------
echo "==> GET /secure/x without credentials (Basic-Auth function -> 401)"
SEC_STATUS=$(curl -s -o /dev/null -D /tmp/cdkl-cf-sec.$$ -w '%{http_code}' "${BASE}/secure/x") || true
[[ "${SEC_STATUS}" == "401" ]] \
  || fail "Basic-Auth function did not return 401 without credentials (got ${SEC_STATUS}; a 5xx would mean Buffer is undefined)"
grep -qi "www-authenticate: Basic" /tmp/cdkl-cf-sec.$$ || fail "401 missing the WWW-Authenticate header"
rm -f /tmp/cdkl-cf-sec.$$
echo "==> GET /secure/x with correct credentials (Buffer-built check passes -> root page)"
SEC_BODY=$(curl -fsS -u user:pass "${BASE}/secure/x") \
  || fail "GET /secure/x with credentials failed (a Buffer ReferenceError would 5xx)"
echo "${SEC_BODY}" | grep -qi "root page" \
  || fail "authorized /secure/x did not rewrite to the root page (Buffer-based auth check)"
if grep -qi "Buffer is not defined" "${OUT_FILE}"; then
  fail "the server logged 'Buffer is not defined' — the cloudfront-js-2.0 Buffer global is missing"
fi

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

# ---------------------------------------------------------------------------
# 7. --cache-origin without --from-cfn-stack: the flag only feeds the
#    deployed-S3 read-through reader (built solely under --from-cfn-stack), so
#    here it is a no-op. A boot-time WARN must fire so the no-op is never
#    silent (the main port was freed above, so reuse it).
# ---------------------------------------------------------------------------
echo "==> Booting with --cache-origin (no --from-cfn-stack): expect the no-op WARN"
WARN_OUT=$(mktemp)
${CDKL} start-cloudfront "${TARGET}" --port "${PORT}" --cache-origin > "${WARN_OUT}" 2>&1 &
WARN_PID=$!
WARNED=0
for _ in $(seq 1 120); do
  if grep -q "cache-origin has no effect without --from-cfn-stack" "${WARN_OUT}"; then WARNED=1; break; fi
  if ! kill -0 "${WARN_PID}" 2>/dev/null; then break; fi
  sleep 0.5
done
kill -TERM "${WARN_PID}" 2>/dev/null || true
for _ in $(seq 1 40); do
  if ! kill -0 "${WARN_PID}" 2>/dev/null; then break; fi
  sleep 0.25
done
kill -KILL "${WARN_PID}" 2>/dev/null || true
if [[ "${WARNED}" -ne 1 ]]; then
  echo "----- --cache-origin server output -----" >&2
  cat "${WARN_OUT}" >&2 || true
  rm -f "${WARN_OUT}"
  echo "FAIL: --cache-origin without --from-cfn-stack did not emit the no-op WARN" >&2
  exit 1
fi
rm -f "${WARN_OUT}"

# ---------------------------------------------------------------------------
# 8. WebDist: Lambda Web Function endpoint origins (go-to-k/cdkd#5516).
#    start-cloudfront has no --platform, so the server runs at the runtime's
#    cloud architecture (linux/arm64) as start-web-function does by default;
#    on an amd64 host that container runs under emulation.
# ---------------------------------------------------------------------------
WEB_PORT=18364
WEB_BASE="http://127.0.0.1:${WEB_PORT}"
WEB_TARGET="CdkLocalStartCloudFrontFixture/WebDist"
WEB_IMAGE="public.ecr.aws/lambda/nodejs:24"
# No `|| true`: a failing `docker ps` must fail the run, not read as "no orphans".
web_orphans() { docker ps -a --filter name=cdkl-webfn- --format '{{.Names}}'; }

echo "==> WebDist: Docker available + ${WEB_IMAGE} (linux/arm64) present"
docker version --format '{{.Server.Version}}' >/dev/null || fail "Docker is required for the WebDist phase"
docker pull --platform linux/arm64 "${WEB_IMAGE}" >/dev/null || fail "docker pull ${WEB_IMAGE} failed"
ORPH=$(web_orphans) || fail "docker ps failed"
[[ -z "${ORPH}" ]] || fail "web function container(s) already running before WebDist: ${ORPH}"
if lsof -ti "tcp:${WEB_PORT}" >/dev/null 2>&1; then
  lsof -ti "tcp:${WEB_PORT}" | xargs -r kill -9 || true
fi

echo "==> Booting: cdkl start-cloudfront ${WEB_TARGET} --port ${WEB_PORT} --no-pull"
WEB_OUT=$(mktemp)
${CDKL} start-cloudfront "${WEB_TARGET}" --port "${WEB_PORT}" --no-pull > "${WEB_OUT}" 2>&1 &
WEB_PID=$!
web_fail() {
  echo "----- WebDist server output -----" >&2
  cat "${WEB_OUT}" >&2 || true
  fail "$*"
}
WEB_BOOTED=0
for _ in $(seq 1 360); do
  if grep -q "CloudFront distribution serving on" "${WEB_OUT}"; then WEB_BOOTED=1; break; fi
  if ! kill -0 "${WEB_PID}" 2>/dev/null; then web_fail "WebDist server exited before it was ready"; fi
  sleep 0.5
done
[[ "${WEB_BOOTED}" -eq 1 ]] || web_fail "WebDist server did not print its ready banner in time"
if grep -q "custom (non-S3" "${WEB_OUT}"; then
  web_fail "a Web Function endpoint origin was warn-and-skipped as a custom origin"
fi
grep -q "Booting Lambda Web Function endpoint origin server for WebEndpoint" "${WEB_OUT}" \
  || web_fail "no Web Function origin server was booted for WebEndpoint"
grep -q "weighted routing is not emulated" "${WEB_OUT}" \
  || web_fail "the endpoint's weighted-split warning was not printed"
grep -q "AuthType AWS_IAM; it is not enforced" "${WEB_OUT}" \
  || web_fail "the endpoint's AuthType warning was not printed"

echo "==> WebDist: POST /hello?q=1 (higher-weight revision, origin request forwarded)"
WEB_HEADERS_FILE=$(mktemp)
WEB_BODY=$(curl -fsS -D "${WEB_HEADERS_FILE}" -X POST -d 'ping' \
  -H 'Origin: http://127.0.0.1:5050' "${WEB_BASE}/hello?q=1") || web_fail "POST /hello failed"
echo "${WEB_BODY}" | grep -q '"revision":"main"' || web_fail "the higher-weight revision WebRevMain was not served: ${WEB_BODY}"
echo "${WEB_BODY}" | grep -q '"greeting":"hi-main"' || web_fail "the revision's ServiceConfig env was not injected: ${WEB_BODY}"
echo "${WEB_BODY}" | grep -q '"method":"POST"' || web_fail "the method was not forwarded: ${WEB_BODY}"
echo "${WEB_BODY}" | grep -q '"path":"/hello?q=1"' || web_fail "the path + query were not forwarded: ${WEB_BODY}"
echo "${WEB_BODY}" | grep -q '"body":"ping"' || web_fail "the request body was not forwarded: ${WEB_BODY}"
echo "${WEB_BODY}" | grep -q '"forwardedFor":"127.0.0.1"' || web_fail "X-Forwarded-For was not set to the client address: ${WEB_BODY}"
WEB_HOST=$(echo "${WEB_BODY}" | sed -n 's/.*"host":"\([^"]*\)".*/\1/p')
[[ "${WEB_HOST}" =~ ^127\.0\.0\.1:[0-9]+$ && "${WEB_HOST}" != "127.0.0.1:${WEB_PORT}" ]] \
  || web_fail "the origin request's Host is not the web function server's address: ${WEB_BODY}"
grep -qi "x-cdkl-fixture: start-cloudfront" "${WEB_HEADERS_FILE}" \
  || web_fail "the viewer-response function did not run over the Web Function response"
grep -qi "access-control-allow-origin: http://127.0.0.1:5050" "${WEB_HEADERS_FILE}" \
  || web_fail "the ResponseHeadersPolicy CORS header is missing on the Web Function response"
grep -qi "set-cookie: web-session=1" "${WEB_HEADERS_FILE}" \
  || web_fail "the origin's Set-Cookie did not reach the viewer"
rm -f "${WEB_HEADERS_FILE}"

echo "==> WebDist: OPTIONS / preflight answered at the edge by the policy"
WEB_PRE=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H 'Origin: http://127.0.0.1:5050' -H 'Access-Control-Request-Method: GET' "${WEB_BASE}/") || true
[[ "${WEB_PRE}" == "204" ]] || web_fail "the CORS preflight did not return 204 (got ${WEB_PRE})"

echo "==> WebDist: GET /deploy/x (second endpoint, extract: false BucketDeployment code)"
DEPLOY_BODY=$(curl -fsS "${WEB_BASE}/deploy/x") || web_fail "GET /deploy/x failed"
echo "${DEPLOY_BODY}" | grep -q '"revision":"deploy"' || web_fail "/deploy/* did not reach WebRevDeploy: ${DEPLOY_BODY}"
echo "${DEPLOY_BODY}" | grep -q '"path":"/deploy/x"' || web_fail "/deploy/x path not forwarded: ${DEPLOY_BODY}"
[[ "$(docker ps --filter name=cdkl-webfn- --format '{{.Names}}' | wc -l | tr -d ' ')" == "2" ]] \
  || web_fail "expected exactly two web function containers (one per endpoint): $(web_orphans)"

echo "==> WebDist: SIGTERM removes every web function container"
kill -TERM "${WEB_PID}" 2>/dev/null || true
for _ in $(seq 1 80); do
  if ! kill -0 "${WEB_PID}" 2>/dev/null; then break; fi
  sleep 0.25
done
kill -0 "${WEB_PID}" 2>/dev/null && web_fail "WebDist server did not exit on SIGTERM"
WEB_PID=""
sleep 1
ORPH=$(web_orphans) || web_fail "docker ps failed"
[[ -z "${ORPH}" ]] || web_fail "leftover web function container(s) after SIGTERM: ${ORPH}"
if lsof -ti "tcp:${WEB_PORT}" >/dev/null 2>&1; then web_fail "port ${WEB_PORT} still bound after shutdown"; fi

# 8b. A signal DURING start-up (the server container is starting, not yet
#     serving) must still remove every web function container: they are not
#     --rm and hold the forwarded credentials. Not reachable on the happy path
#     above, where SIGTERM arrives after the serving handler is armed.
echo "==> WebDist: SIGTERM during start-up removes the containers booted so far"
: > "${WEB_OUT}"
${CDKL} start-cloudfront "${WEB_TARGET}" --port "${WEB_PORT}" --no-pull > "${WEB_OUT}" 2>&1 &
WEB_PID=$!
STARTING=0
for _ in $(seq 1 360); do
  if grep -q "Starting web function container" "${WEB_OUT}"; then STARTING=1; break; fi
  if ! kill -0 "${WEB_PID}" 2>/dev/null; then web_fail "WebDist server exited before starting a container"; fi
  sleep 0.1
done
[[ "${STARTING}" -eq 1 ]] || web_fail "WebDist server never started a web function container"
grep -q "CloudFront distribution serving on" "${WEB_OUT}" \
  && web_fail "the server was already serving; the start-up window was not exercised"
kill -TERM "${WEB_PID}" 2>/dev/null || true
for _ in $(seq 1 120); do
  if ! kill -0 "${WEB_PID}" 2>/dev/null; then break; fi
  sleep 0.25
done
kill -0 "${WEB_PID}" 2>/dev/null && web_fail "WebDist server did not exit on SIGTERM during start-up"
WEB_PID=""
grep -q "during start-up; removing the web function containers" "${WEB_OUT}" \
  || web_fail "the start-up signal handler did not run"
sleep 1
ORPH=$(web_orphans) || web_fail "docker ps failed"
[[ -z "${ORPH}" ]] || web_fail "leftover web function container(s) after a start-up SIGTERM: ${ORPH}"
rm -f "${WEB_OUT}"

echo "PASS: cdkl start-cloudfront served the viewer-request -> S3 origin -> viewer-response pipeline, a KeyValueStore-backed rewrite via a bare-construct-id --kvs-file key (issues #399 + #465), a Buffer-using Basic-Auth function (issue #410), the SPA fallback, ResponseHeadersPolicy CORS (preflight + actual-response), a --watch reload, the --cache-origin-without--from-cfn-stack no-op WARN, and Lambda Web Function endpoint origins (go-to-k/cdkd#5516: weighted revision, forwarded origin request, viewer-response + CORS over it, an extract: false BucketDeployment revision, containers removed on SIGTERM)."
