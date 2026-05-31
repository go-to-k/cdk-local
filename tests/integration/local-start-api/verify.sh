#!/usr/bin/env bash
# verify.sh — local-start-api integ test
#
# Like local-invoke, this integ deploys nothing — it exercises
# `cdkl start-api` end-to-end against Docker + the AWS Lambda
# Node.js base image (which bundles RIE).
#
# Run via `/run-integ local-start-api` (recommended) or directly:
#
#     bash tests/integration/local-start-api/verify.sh
#
# Requires Docker.
#
# Robust cleanup: SIGTERM -> 120s grace -> SIGKILL on the server, plus a
# defense-in-depth `docker ps --filter name=cdkl-` sweep so a
# crashed test never leaves orphan containers behind.

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
# the explicit `--add-host` plumbing — out of scope for v1, so we use
# 127.0.0.1 here. This matches what the local-invoke integ does.
CONTAINER_HOST="127.0.0.1"

LOG_FILE="$(mktemp)"
SERVER_PID=""
# A second server is started later with --strict-sigv4 to exercise the
# fail-closed opt-in end-to-end; tracked separately so cleanup tears down
# both.
STRICT_LOG_FILE="$(mktemp)"
STRICT_SERVER_PID=""
# A third server is started last to exercise the variadic subset form
# (`cdkl start-api <id1> <id2> <bogus-typo>` — serve exactly those APIs,
# each on its own port, ignore the typo with a one-shot warn). Tracked
# separately so cleanup tears down all three.
SUBSET_LOG_FILE="$(mktemp)"
SUBSET_SERVER_PID=""
# A fourth server is started under `env -i` with no AWS credentials
# reachable — proves the standalone path (README L34-37: "no AWS account
# or credentials needed") actually serves L35 (API Gateway routing) +
# L36 (Lambda authorizers in real containers) + L37 (pure handler logic).
OFFLINE_LOG_FILE="$(mktemp)"
OFFLINE_SERVER_PID=""

term_server() {
  # $1 = pid, $2 = human label
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
  term_server "${STRICT_SERVER_PID:-}" "strict server"
  term_server "${SUBSET_SERVER_PID:-}" "subset server"
  term_server "${OFFLINE_SERVER_PID:-}" "offline server"
  # Defense-in-depth: kill every cdkl-* container regardless of
  # how the server cleaned up. This catches the case where the server
  # crashed before its dispose() ran.
  ORPHANS=$(docker ps --filter "name=cdkl-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "==> Cleaning up orphan containers"
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}" "${STRICT_LOG_FILE}" "${SUBSET_LOG_FILE}" "${OFFLINE_LOG_FILE}"
}
trap cleanup EXIT INT TERM

echo "==> Starting cdkl start-api on port ${PORT}"
${CDKL} start-api \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  --no-pull \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

# Wait for ALL "Server listening" lines — PR #341 / issue #260 launches
# one HTTP server per API, each on its own port (--port N → N, N+1, ...).
# Surfaces: HTTP API v2 (1) + REST API v1 (1) + Function URLs (5: plain,
# stream, stream-set-content-type, OAC AWS_IAM, plain AWS_IAM) = 7. Waiting
# for the full count ensures every port is bound before the port-extraction
# step below — a partial wait would race past readiness.
echo "==> Waiting for all servers (7 expected) to come up"
EXPECTED_SERVERS=7
READY=0
for i in $(seq 1 60); do
  # `grep -c` outputs "0" AND exits non-zero on zero matches, so a
  # naive `|| echo 0` concatenates both into "0\n0" and trips up
  # the `[[ ... -ge ... ]]` arithmetic. Capture stdout, then default
  # to 0 only when grep actually failed (file missing etc.).
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
head -60 "${LOG_FILE}" | sed 's/^/    /'

# Extract per-API ports from "Server listening on http://host:PORT (Kind)"
# lines. PR #341 launches one server per API, so each route family has
# its own port — using a single $PORT for every curl would only hit
# the HTTP API v2 server.
#
# Sed regex tightening: anchor the port on the `http://host:` segment
# (the `[^:]+` host class refuses to cross another `:`) so a future
# DisplayName containing `:NNN` (e.g. user-defined logical IDs or
# qualifiers like "v2:edge") can't shadow the real port.
PORT_HTTP=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(.*HTTP API v2\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
PORT_REST=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(.*REST API v1\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
# Two Function URL servers: the buffered one (UrlHandler) and the
# streaming one (StreamUrlHandler — added in #467). CDK appends an
# 8-hex-char hash to each logical id; the leading `(` anchor + the
# regex `UrlHandler[A-F0-9]{8}` boundary ensures `UrlHandler` does NOT
# match `StreamUrlHandler` (the latter has `Stream` before `UrlHandler`,
# so the `(` boundary excludes it).
PORT_FNURL=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(UrlHandler[A-F0-9]{8}\s+\(Function URL\)\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
PORT_FNURL_STREAM=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(StreamUrlHandler[A-F0-9]{8}\s+\(Function URL\)\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
# cdkd#664: a second streaming Function URL whose handler uses the
# setContentType-only shortcut (no explicit `HttpResponseStream.from(...)`).
# `StreamUrlSetContentTypeHandler[A-F0-9]{8}` is distinct from
# `StreamUrlHandler[A-F0-9]{8}` (the `Set` infix breaks the latter regex).
PORT_FNURL_STREAM_SCT=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(StreamUrlSetContentTypeHandler[A-F0-9]{8}\s+\(Function URL\)\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
# OAC-fronted AWS_IAM Function URL (OacUrlHandler). The `(` anchor keeps
# `OacUrlHandler` distinct from the plain `UrlHandler` server above.
PORT_FNURL_OAC=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(OacUrlHandler[A-F0-9]{8}\s+\(Function URL\)\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
# Plain (non-OAC) AWS_IAM Function URL (IamUrlHandler). The `(` anchor keeps
# `IamUrlHandler` distinct from the plain `UrlHandler` and `OacUrlHandler`
# servers (their handler names have no `Iam` prefix).
PORT_FNURL_IAM=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(IamUrlHandler[A-F0-9]{8}\s+\(Function URL\)\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
if [[ -z "${PORT_HTTP}" || -z "${PORT_REST}" || -z "${PORT_FNURL}" || -z "${PORT_FNURL_STREAM}" || -z "${PORT_FNURL_STREAM_SCT}" || -z "${PORT_FNURL_OAC}" || -z "${PORT_FNURL_IAM}" ]]; then
  echo "FAIL: could not extract per-API port mappings. Log:"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    HTTP API v2:                  ${PORT_HTTP}"
echo "    REST API v1:                  ${PORT_REST}"
echo "    Function URL:                 ${PORT_FNURL}"
echo "    Function URL (stream):        ${PORT_FNURL_STREAM}"
echo "    Function URL (stream/SCT):    ${PORT_FNURL_STREAM_SCT}"
echo "    Function URL (OAC AWS_IAM):   ${PORT_FNURL_OAC}"
echo "    Function URL (AWS_IAM):       ${PORT_FNURL_IAM}"

# Verify the route table contains every route. Method-column width
# varies per server (REST v1 with OPTIONS preflight rows has a wider
# method column than HTTP API v2), so match on `<METHOD>\s+<path>`
# regex instead of fixed-width prefixes. `{`, `}`, `+` in path
# patterns need regex escaping.
echo "==> Asserting discovered routes"
EXPECTED_ROUTES=(
  "GET     /items"
  "POST    /items"
  "GET     /items/\\{id\\}"
  "GET     /protected"
  "POST    /sqs"
  "POST    /events"
  "POST    /unknown-subtype"
  "POST    /protected-sqs"
  "ANY     /v1/\\{proxy\\+\\}"
  "GET     /v1/unsupported"
  "GET     /v1/cross-stack-auth"
  "OPTIONS /v1/\\{proxy\\+\\}"
  "ANY     /\\{proxy\\+\\}"
)
for line in "${EXPECTED_ROUTES[@]}"; do
  # Replace runs of spaces in the spec with `\s+` so the assertion
  # is tolerant of the per-server method-column width.
  pattern=$(echo "${line}" | sed -E 's/[[:space:]]+/[[:space:]]+/g')
  if ! grep -E "${pattern}" "${LOG_FILE}" >/dev/null; then
    echo "FAIL: missing route in route table: ${line} (pattern: ${pattern})"
    cat "${LOG_FILE}"
    exit 1
  fi
done

# The deferred-error route table label and the per-route startup warn.
# The defaultCorsPreflightOptions OPTIONS Method should appear with the
# [MOCK CORS preflight] label; the HTTP_PROXY GET on /v1/unsupported
# should appear with the [501 Not Implemented] label.
echo "==> Asserting deferred-route table labels"
if ! grep -F "[MOCK CORS preflight]" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: route table did not include [MOCK CORS preflight] label."
  cat "${LOG_FILE}"
  exit 1
fi
if ! grep -F "[501 Not Implemented]" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: route table did not include [501 Not Implemented] label."
  cat "${LOG_FILE}"
  exit 1
fi
# Startup warn summary: one [warn] line up front for every unsupported
# route. The HTTP_PROXY route's reason names the integration type.
if ! grep -i "HTTP 501 Not Implemented when hit" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: missing startup warn summary for unsupported routes."
  cat "${LOG_FILE}"
  exit 1
fi
# OAC-fronted AWS_IAM Function URL: the startup notice must call out the
# auto-relaxed route separately (warn-and-pass without the flag).
if ! grep -i "fronted by a CloudFront" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: missing OAC-fronted Function URL startup notice."
  cat "${LOG_FILE}"
  exit 1
fi

# Smoke-test the routes via curl. The Items handler returns a small JSON
# body; greedy proxy returns a constant; FunctionURL returns a constant.
# Each curl is wrapped in a retry loop because RIE container boot from
# cold can be slow (~3-5s) on the first request.
curl_assert() {
  local label="$1"
  local url="$2"
  local needle="$3"
  shift 3
  local response=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if response=$(curl -sf "$@" "${url}" 2>&1); then
      if echo "${response}" | grep -q "${needle}"; then
        echo "    [${label}] OK"
        return 0
      fi
    fi
    sleep 1
  done
  echo "FAIL: ${label} did not match ${needle}. Last response: ${response}"
  cat "${LOG_FILE}"
  return 1
}

echo "==> Smoke-testing routes via curl"
curl_assert "GET /items/42" "http://127.0.0.1:${PORT_HTTP}/items/42" '"id":"42"'
curl_assert "POST /items" "http://127.0.0.1:${PORT_HTTP}/items" '"body"' \
  -X POST -H 'Content-Type: application/json' -d '{"x":1}'
# PR 8c: REST v1 stage variables — the prod Stage carries
# Variables: { STAGE: 'prod', LOG_LEVEL: 'info' }. Note this lives on
# the dedicated REST v1 server (own port, per PR #341).
curl_assert "ANY /v1/anything (stage variables)" \
  "http://127.0.0.1:${PORT_REST}/v1/anything" '"STAGE":"prod"'
# Function URL is a separate server on its own port. The Function URL
# greedy proxy answers any path on its server.
curl_assert "Function URL fallback" "http://127.0.0.1:${PORT_FNURL}/url-only/ping" '"functionUrl":true'

# OAC-fronted AWS_IAM Function URL. The route declares AuthType: AWS_IAM
# but is fronted by a CloudFront OAC, so cdkl start-api warn-and-passes
# SigV4 for it. OAC routes always warn-and-pass, even under --strict-sigv4
# (the server was started without --strict-sigv4 here anyway).
echo "==> Asserting OAC-fronted AWS_IAM Function URL"
# 1. No Authorization header -> still 403 (the relax is signature-presence
#    gated; missing-identity is denied before the relax logic runs).
OAC_NOAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT_FNURL_OAC}/ping")
if [[ "${OAC_NOAUTH_STATUS}" != "403" ]]; then
  echo "FAIL: OAC Function URL without Authorization expected 403, got ${OAC_NOAUTH_STATUS}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [OAC Function URL no-auth -> 403] OK"
# 2. A SigV4 header signed with a FOREIGN (empty) access-key-id -> passes
#    through to the handler (echo body) instead of 403, because the route
#    is OAC-fronted. Mirrors the CloudFront-OAC + empty-cred-signer pattern.
OAC_AMZDATE="$(date -u +%Y%m%dT%H%M%SZ)"
OAC_DATESTAMP="$(date -u +%Y%m%d)"
OAC_AUTH="AWS4-HMAC-SHA256 Credential=/${OAC_DATESTAMP}/us-east-1/lambda/aws4_request, SignedHeaders=host;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000"
curl_assert "OAC Function URL foreign-sig pass-through" \
  "http://127.0.0.1:${PORT_FNURL_OAC}/ping" \
  '"functionUrl":true' \
  -H "x-amz-date: ${OAC_AMZDATE}" \
  -H "Authorization: ${OAC_AUTH}"

# Plain (non-OAC) AWS_IAM Function URL: with the warn-and-pass default (no
# --strict-sigv4), a SigV4 header signed with a FOREIGN access-key-id that
# cdk-local cannot verify locally passes through to the handler instead of
# being denied. This is the headline of the default flip — a non-OAC AWS_IAM
# route is exercisable locally without any flag. (No Authorization header
# still 403s; that missing-identity path is covered by the OAC case above.)
echo "==> Asserting plain AWS_IAM Function URL warn-and-passes by default"
IAM_AMZDATE="$(date -u +%Y%m%dT%H%M%SZ)"
IAM_DATESTAMP="$(date -u +%Y%m%d)"
IAM_AUTH="AWS4-HMAC-SHA256 Credential=AKIAFOREIGNEXAMPLE/${IAM_DATESTAMP}/us-east-1/lambda/aws4_request, SignedHeaders=host;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000"
curl_assert "AWS_IAM Function URL foreign-sig warn-and-pass (default)" \
  "http://127.0.0.1:${PORT_FNURL_IAM}/ping" \
  '"functionUrl":true' \
  -H "x-amz-date: ${IAM_AMZDATE}" \
  -H "Authorization: ${IAM_AUTH}"

# #467: streaming Function URL (`invokeMode: RESPONSE_STREAM`). The
# handler emits 5 chunks of "hello-N\n" with 200ms delays between
# chunks. cdk-local MUST:
#   1. Return HTTP 200 + `Transfer-Encoding: chunked` headers (not
#      buffered-then-flushed in one shot).
#   2. Deliver chunks incrementally — the wall-clock duration of
#      `curl --no-buffer` should reflect the handler's inter-chunk
#      sleeps (>= ~600ms across 5 chunks of 200ms).
#   3. Echo the prelude's X-Stream-Test header.
#
# Caveat: the AWS Lambda Runtime Interface Emulator (RIE) baked into
# `public.ecr.aws/lambda/nodejs:20` does NOT stream the response — it
# buffers every `responseStream.write(...)` call into one response that
# arrives at the HTTP client as a single block. This is a RIE limitation
# (verified empirically against the v1.0 RIE shipped in the base image
# on 2026-05-22); cdk-local's `invokeRieStreaming` correctly parses the
# streaming protocol and pipes the body bytes with `Transfer-Encoding:
# chunked`, but real incremental delivery only manifests against the
# deployed Lambda runtime. The integ asserts the protocol shape, not
# inter-chunk timing.
echo "==> Asserting streaming Function URL (#467)"
STREAM_URL="http://127.0.0.1:${PORT_FNURL_STREAM}/anything"
# First-request retry loop (cold container ~3-5s on first invoke).
STREAM_RESPONSE=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if STREAM_RESPONSE=$(curl -sf -i --no-buffer "${STREAM_URL}" 2>&1); then
    if echo "${STREAM_RESPONSE}" | grep -q 'hello-0'; then break; fi
  fi
  sleep 1
done
if ! echo "${STREAM_RESPONSE}" | grep -qi '^HTTP/1.1 200'; then
  echo "FAIL: streaming Function URL did not return 200. Response:"
  echo "${STREAM_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${STREAM_RESPONSE}" | grep -qi '^transfer-encoding: chunked'; then
  echo "FAIL: streaming response missing Transfer-Encoding: chunked. Response:"
  echo "${STREAM_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${STREAM_RESPONSE}" | grep -qi '^x-stream-test: on'; then
  echo "FAIL: streaming response missing X-Stream-Test header from the prelude. Response:"
  echo "${STREAM_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
# All 5 chunks present in the body (order-preserved). RIE buffers the
# writes, so we get all 5 in one shot — that's expected.
for i in 0 1 2 3 4; do
  if ! echo "${STREAM_RESPONSE}" | grep -q "hello-${i}"; then
    echo "FAIL: streaming response missing chunk 'hello-${i}'. Response:"
    echo "${STREAM_RESPONSE}"
    cat "${LOG_FILE}"
    exit 1
  fi
done
# Protocol-shape audit: the response body must NOT contain the literal
# bytes of the 8-NULL separator — that would mean cdk-local's prelude parser
# leaked separator bytes into the body. We grep `chunk-` instead of a
# binary NULL match because curl's `-i` output is rendered for
# terminals and may mask NULs; the indirect signal is that the body
# starts with `hello-0` (the handler's first write after the
# `HttpResponseStream.from` wrapper installed the prelude).
if echo "${STREAM_RESPONSE}" | grep -q '"statusCode":200,"headers"'; then
  echo "FAIL: streaming response body leaked the JSON prelude (parser bug). Response:"
  echo "${STREAM_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [streaming Function URL] OK"

# cdkd#664: streaming Function URL whose handler uses the documented
# `responseStream.setContentType(...)` + `responseStream.write(...)`
# shortcut WITHOUT explicitly calling
# `awslambda.HttpResponseStream.from(stream, metadata)`. Production AWS
# Lambda + Function URL handles this — the runtime auto-completes the
# prelude — but RIE emits only the raw body bytes the handler wrote
# (verified empirically 2026-05-27 against `public.ecr.aws/lambda/nodejs:22`).
# Pre-fix cdk-local rejected the invocation with "RIE streaming response
# ended before the prelude/body separator". Post-fix cdk-local synthesizes
# a default 200 / application/octet-stream prelude and surfaces the body
# bytes verbatim so the handler runs locally as it does in production.
echo "==> Asserting streaming Function URL (cdkd#664 — setContentType-only handler)"
STREAM_URL_SCT="http://127.0.0.1:${PORT_FNURL_STREAM_SCT}/anything"
STREAM_SCT_RESPONSE=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if STREAM_SCT_RESPONSE=$(curl -sf -i --no-buffer "${STREAM_URL_SCT}" 2>&1); then
    if echo "${STREAM_SCT_RESPONSE}" | grep -q '"hello":"world"'; then break; fi
  fi
  sleep 1
done
if ! echo "${STREAM_SCT_RESPONSE}" | grep -qi '^HTTP/1.1 200'; then
  echo "FAIL: setContentType-only streaming Function URL did not return 200. Response:"
  echo "${STREAM_SCT_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${STREAM_SCT_RESPONSE}" | grep -q '"hello":"world"'; then
  echo "FAIL: setContentType-only streaming response missing first chunk body. Response:"
  echo "${STREAM_SCT_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${STREAM_SCT_RESPONSE}" | grep -q '"count":2'; then
  echo "FAIL: setContentType-only streaming response missing second chunk body. Response:"
  echo "${STREAM_SCT_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [streaming Function URL — setContentType-only (cdkd#664)] OK"

# PR 8c: CORS preflight interception. The HTTP API has CorsConfiguration
# with `*` origins; verify.sh asserts the canonical preflight response.
echo "==> Asserting CORS preflight (OPTIONS /items)"
PREFLIGHT_HEADERS=$(curl -s -i -o - -X OPTIONS \
  -H 'Origin: https://example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Content-Type' \
  "http://127.0.0.1:${PORT_HTTP}/items" 2>&1)
if ! echo "${PREFLIGHT_HEADERS}" | grep -qi '^HTTP/1.1 204'; then
  echo "FAIL: CORS preflight did not return 204. Response:"
  echo "${PREFLIGHT_HEADERS}"
  exit 1
fi
if ! echo "${PREFLIGHT_HEADERS}" | grep -qi '^access-control-allow-origin: \*'; then
  echo "FAIL: CORS preflight missing access-control-allow-origin header. Response:"
  echo "${PREFLIGHT_HEADERS}"
  exit 1
fi
if ! echo "${PREFLIGHT_HEADERS}" | grep -qi '^access-control-allow-methods: POST'; then
  echo "FAIL: CORS preflight missing access-control-allow-methods header. Response:"
  echo "${PREFLIGHT_HEADERS}"
  exit 1
fi
# PR 8c review fix-back: every successful preflight now emits
# `Vary: Origin` so downstream caches don't share responses across
# origins. Pre-fix the header was missing on the wildcard / literal-
# origin / AllowCredentials echo paths.
if ! echo "${PREFLIGHT_HEADERS}" | grep -qi '^vary: Origin'; then
  echo "FAIL: CORS preflight missing 'Vary: Origin' header. Response:"
  echo "${PREFLIGHT_HEADERS}"
  exit 1
fi
echo "    [CORS preflight] OK"

# PR 8b: authorizer-protected route. Without the Bearer token the
# authorizer Deny's; with the Bearer token the route handler runs and
# echoes the authorizer's context map.
echo "==> Authorizer pass: GET /protected without token -> 401 (HTTP v2 deny)"
auth_status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT_HTTP}/protected")
if [[ "${auth_status}" != "401" ]]; then
  echo "FAIL: expected 401 from authorizer deny, got ${auth_status}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [GET /protected (deny)] OK (status=401)"

curl_assert "GET /protected (allow)" \
  "http://127.0.0.1:${PORT_HTTP}/protected" \
  '"protected":true' \
  -H 'Authorization: Bearer let-me-in'

# REST v1 MOCK CORS preflight: the `defaultCorsPreflightOptions` on
# MyRestApi synthesizes an OPTIONS Method with a MOCK integration on
# every resource. cdk-local's discovery layer captures the literal
# `method.response.header.Access-Control-Allow-*` values from
# `IntegrationResponses[0].ResponseParameters`; the HTTP server returns
# them directly on OPTIONS (no Lambda invocation, no VTL evaluation).
echo "==> Asserting REST v1 MOCK CORS preflight (OPTIONS /v1/anything)"
REST_PREFLIGHT_HEADERS=$(curl -s -i -o - -X OPTIONS \
  -H 'Origin: https://example.com' \
  -H 'Access-Control-Request-Method: GET' \
  "http://127.0.0.1:${PORT_REST}/v1/anything" 2>&1)
if ! echo "${REST_PREFLIGHT_HEADERS}" | grep -qiE '^HTTP/1.1 (200|204)'; then
  echo "FAIL: REST v1 MOCK CORS preflight did not return a 2xx. Response:"
  echo "${REST_PREFLIGHT_HEADERS}"
  exit 1
fi
if ! echo "${REST_PREFLIGHT_HEADERS}" | grep -qi '^access-control-allow-origin: \*'; then
  echo "FAIL: REST v1 MOCK CORS preflight missing access-control-allow-origin header. Response:"
  echo "${REST_PREFLIGHT_HEADERS}"
  exit 1
fi
echo "    [REST v1 MOCK CORS preflight] OK"

# Deferred-error class: GET /v1/unsupported has an HTTP_PROXY integration
# cdk-local cannot emulate. The server returns 501 + `reason` in the body, no
# Lambda invocation. Pre-PR boot would have hard-errored on this route
# and prevented every other route from being reachable.
echo "==> Asserting GET /v1/unsupported -> 501 Not Implemented"
UNSUPPORTED_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' "http://127.0.0.1:${PORT_REST}/v1/unsupported")
UNSUPPORTED_STATUS=$(echo "${UNSUPPORTED_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
UNSUPPORTED_BODY=$(echo "${UNSUPPORTED_RESPONSE}" | sed '$ d')
if [[ "${UNSUPPORTED_STATUS}" != "501" ]]; then
  echo "FAIL: expected 501 from unsupported route, got ${UNSUPPORTED_STATUS}. Body: ${UNSUPPORTED_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${UNSUPPORTED_BODY}" | grep -q '"message":"Not Implemented"'; then
  echo "FAIL: expected 501 body to include {\"message\":\"Not Implemented\"}. Body: ${UNSUPPORTED_BODY}"
  exit 1
fi
if ! echo "${UNSUPPORTED_BODY}" | grep -q '"reason"'; then
  echo "FAIL: expected 501 body to include a 'reason' field. Body: ${UNSUPPORTED_BODY}"
  exit 1
fi
echo "    [GET /v1/unsupported (501)] OK"

# Issue #431: authorizer Lambda Arn unresolvable. The route's
# AuthorizerUri was overridden in the fixture to a cross-stack-shape
# Fn::Sub the resolver cannot pin down. cdk-local's authorizer-resolver
# flips the route to deferred-error unsupported at boot; the HTTP
# server returns 501 + reason at request time. The authorizer Lambda
# is never invoked.
echo "==> Asserting GET /v1/cross-stack-auth -> 501 Not Implemented (authorizer Arn unresolvable)"
AUTH_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' \
  -H 'Authorization: Bearer any-token' \
  "http://127.0.0.1:${PORT_REST}/v1/cross-stack-auth")
AUTH_STATUS=$(echo "${AUTH_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
AUTH_BODY=$(echo "${AUTH_RESPONSE}" | sed '$ d')
if [[ "${AUTH_STATUS}" != "501" ]]; then
  echo "FAIL: expected 501 from cross-stack authorizer route, got ${AUTH_STATUS}. Body: ${AUTH_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${AUTH_BODY}" | grep -q '"message":"Not Implemented"'; then
  echo "FAIL: expected 501 body to include {\"message\":\"Not Implemented\"}. Body: ${AUTH_BODY}"
  exit 1
fi
if ! echo "${AUTH_BODY}" | grep -q 'authorizer Lambda Arn unresolvable'; then
  echo "FAIL: expected 501 reason to mention 'authorizer Lambda Arn unresolvable'. Body: ${AUTH_BODY}"
  exit 1
fi
echo "    [GET /v1/cross-stack-auth (501)] OK"

# #458: HTTP API v2 service integrations. The fixture wires POST /sqs to
# `SQS-SendMessage`, POST /events to `EventBridge-PutEvents`, and POST
# /unknown-subtype to a deliberately-typo'd subtype that must fall back
# to the deferred-501 path. We DO NOT deploy real SQS/EventBridge — the
# integ is local-only — so the SDK calls land against the dev's AWS
# creds and either reject with a 4xx (proves dispatch fired) or return
# AccessDenied / NoSuchQueue. Pre-#458 these routes 501'd at boot.
echo "==> Asserting service-integration route table labels (#458)"
if ! grep -F "[SQS-SendMessage]" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: route table did not include [SQS-SendMessage] label."
  cat "${LOG_FILE}"
  exit 1
fi
if ! grep -F "[EventBridge-PutEvents]" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: route table did not include [EventBridge-PutEvents] label."
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [route labels] OK"

echo "==> Asserting POST /sqs goes through the dispatcher (not 501)"
SQS_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello"}' \
  "http://127.0.0.1:${PORT_HTTP}/sqs?url=https://sqs.invalid.example/q")
SQS_STATUS=$(echo "${SQS_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
SQS_BODY=$(echo "${SQS_RESPONSE}" | sed '$ d')
# Acceptance: anything OTHER than 501 (= dispatched to AWS SDK). Most
# environments will surface a 4xx (NonExistentQueue / AccessDenied /
# InvalidParameter / SignatureDoesNotMatch). The body must NOT include
# the "Not Implemented" marker.
if [[ "${SQS_STATUS}" == "501" ]]; then
  echo "FAIL: POST /sqs returned 501 — service-integration dispatch did not fire. Body: ${SQS_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if echo "${SQS_BODY}" | grep -q '"message":"Not Implemented"'; then
  echo "FAIL: POST /sqs body looks like the deferred-501 envelope. Body: ${SQS_BODY}"
  exit 1
fi
echo "    [POST /sqs dispatched] OK (status=${SQS_STATUS})"

echo "==> Asserting POST /events goes through the dispatcher (not 501)"
EVENTS_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"k":"v"}' \
  "http://127.0.0.1:${PORT_HTTP}/events?type=order.created")
EVENTS_STATUS=$(echo "${EVENTS_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
EVENTS_BODY=$(echo "${EVENTS_RESPONSE}" | sed '$ d')
if [[ "${EVENTS_STATUS}" == "501" ]]; then
  echo "FAIL: POST /events returned 501 — dispatch did not fire. Body: ${EVENTS_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if echo "${EVENTS_BODY}" | grep -q '"message":"Not Implemented"'; then
  echo "FAIL: POST /events body looks like the deferred-501 envelope. Body: ${EVENTS_BODY}"
  exit 1
fi
echo "    [POST /events dispatched] OK (status=${EVENTS_STATUS})"

echo "==> Asserting POST /unknown-subtype -> 501 (classifier rejected typo)"
UNK_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  "http://127.0.0.1:${PORT_HTTP}/unknown-subtype")
UNK_STATUS=$(echo "${UNK_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
UNK_BODY=$(echo "${UNK_RESPONSE}" | sed '$ d')
if [[ "${UNK_STATUS}" != "501" ]]; then
  echo "FAIL: POST /unknown-subtype should 501 (unrecognized subtype). Got ${UNK_STATUS}. Body: ${UNK_BODY}"
  exit 1
fi
if ! echo "${UNK_BODY}" | grep -q 'BogusService-NotASubtype'; then
  echo "FAIL: 501 reason should name the offending subtype. Body: ${UNK_BODY}"
  exit 1
fi
echo "    [POST /unknown-subtype (501)] OK"

# Issue #502: Lambda-authorizer-protected service-integration route.
# Pre-PR the SDK dispatcher ran BEFORE the authorizer pass, letting
# unauthenticated requests reach the SDK call. Post-PR the authorizer
# pass runs FIRST — missing Bearer → 401, valid Bearer → SDK dispatches.
echo "==> Asserting POST /protected-sqs without token -> 401 (auth pass runs BEFORE SDK)"
PROTECTED_SQS_NOAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello"}' \
  "http://127.0.0.1:${PORT_HTTP}/protected-sqs?url=https://sqs.invalid.example/q")
if [[ "${PROTECTED_SQS_NOAUTH_STATUS}" != "401" ]]; then
  echo "FAIL: expected 401 from auth-deny on /protected-sqs, got ${PROTECTED_SQS_NOAUTH_STATUS}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [POST /protected-sqs (deny)] OK (status=401)"

echo "==> Asserting POST /protected-sqs with valid Bearer -> SDK dispatches (NOT 401)"
PROTECTED_SQS_AUTH_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer let-me-in' \
  -d '{"message":"hello"}' \
  "http://127.0.0.1:${PORT_HTTP}/protected-sqs?url=https://sqs.invalid.example/q")
PROTECTED_SQS_AUTH_STATUS=$(echo "${PROTECTED_SQS_AUTH_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
PROTECTED_SQS_AUTH_BODY=$(echo "${PROTECTED_SQS_AUTH_RESPONSE}" | sed '$ d')
# Acceptance: anything other than 401 (= the auth pass let it through;
# the SDK call fired and AWS returned 4xx from the missing queue / bogus
# credentials / etc.). 501 would also be a failure (means dispatch
# didn't fire). Most environments will surface 4xx from the SDK adapter.
if [[ "${PROTECTED_SQS_AUTH_STATUS}" == "401" ]]; then
  echo "FAIL: POST /protected-sqs with valid Bearer returned 401 — authorizer rejected valid token. Body: ${PROTECTED_SQS_AUTH_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if [[ "${PROTECTED_SQS_AUTH_STATUS}" == "501" ]]; then
  echo "FAIL: POST /protected-sqs returned 501 — SDK dispatch did not fire. Body: ${PROTECTED_SQS_AUTH_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [POST /protected-sqs (allow + SDK)] OK (status=${PROTECTED_SQS_AUTH_STATUS})"

# --strict-sigv4 opt-in (the fail-closed path) exercised end-to-end via a
# SECOND server started WITH the flag, so the CLI-flag -> sigV4Strict ->
# verifySigV4 wiring is covered by automated integ (not just unit tests).
# Under --strict-sigv4 a non-OAC AWS_IAM route DENIES an unverifiable
# foreign-signed request (403), while the OAC-fronted route still
# warn-and-passes (it ignores --strict-sigv4). Runs on a separate port base
# (PORT+100) so it does not collide with the default server still running.
STRICT_PORT=$((PORT + 100))
echo "==> Starting a second cdkl start-api with --strict-sigv4 on port ${STRICT_PORT}"
${CDKL} start-api \
  --port "${STRICT_PORT}" \
  --container-host "${CONTAINER_HOST}" \
  --no-pull \
  --strict-sigv4 \
  >"${STRICT_LOG_FILE}" 2>&1 &
STRICT_SERVER_PID=$!
STRICT_READY=0
for i in $(seq 1 60); do
  scount=$(grep -c "Server listening" "${STRICT_LOG_FILE}" 2>/dev/null) || scount=0
  if [[ "${scount}" -ge "${EXPECTED_SERVERS}" ]]; then STRICT_READY=1; break; fi
  sleep 0.5
done
if [[ "${STRICT_READY}" -eq 0 ]]; then
  echo "FAIL: --strict-sigv4 server: only ${scount}/${EXPECTED_SERVERS} servers came up. Log:"
  cat "${STRICT_LOG_FILE}"
  exit 1
fi
STRICT_PORT_IAM=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(IamUrlHandler[A-F0-9]{8}\s+\(Function URL\)\)' "${STRICT_LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
STRICT_PORT_OAC=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(OacUrlHandler[A-F0-9]{8}\s+\(Function URL\)\)' "${STRICT_LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
if [[ -z "${STRICT_PORT_IAM}" || -z "${STRICT_PORT_OAC}" ]]; then
  echo "FAIL: --strict-sigv4 server: could not extract Function URL ports. Log:"
  cat "${STRICT_LOG_FILE}"
  exit 1
fi
STRICT_AMZDATE="$(date -u +%Y%m%dT%H%M%SZ)"
STRICT_DATESTAMP="$(date -u +%Y%m%d)"
STRICT_AUTH="AWS4-HMAC-SHA256 Credential=AKIAFOREIGNEXAMPLE/${STRICT_DATESTAMP}/us-east-1/lambda/aws4_request, SignedHeaders=host;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000"
echo "==> Asserting --strict-sigv4 denies a non-OAC AWS_IAM foreign-sig (403)"
STRICT_IAM_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
  -H "x-amz-date: ${STRICT_AMZDATE}" -H "Authorization: ${STRICT_AUTH}" \
  "http://127.0.0.1:${STRICT_PORT_IAM}/ping")
if [[ "${STRICT_IAM_STATUS}" != "403" ]]; then
  echo "FAIL: --strict-sigv4 non-OAC AWS_IAM foreign-sig expected 403, got ${STRICT_IAM_STATUS}"
  cat "${STRICT_LOG_FILE}"
  exit 1
fi
echo "    [--strict-sigv4 non-OAC AWS_IAM foreign-sig -> 403] OK"
echo "==> Asserting OAC AWS_IAM still warn-and-passes under --strict-sigv4"
STRICT_OAC_BODY=$(curl -s --max-time 30 \
  -H "x-amz-date: ${STRICT_AMZDATE}" -H "Authorization: ${STRICT_AUTH}" \
  "http://127.0.0.1:${STRICT_PORT_OAC}/ping")
if [[ "${STRICT_OAC_BODY}" != *'"functionUrl":true'* ]]; then
  echo "FAIL: --strict-sigv4 OAC foreign-sig should still pass through; body: ${STRICT_OAC_BODY}"
  cat "${STRICT_LOG_FILE}"
  exit 1
fi
echo "    [--strict-sigv4 OAC AWS_IAM foreign-sig -> pass-through] OK"

# Variadic subset form (issue #55): `cdkl start-api <id1> <id2> <bogus>`
# serves EXACTLY the named APIs (each on its own port) instead of all 7,
# and a single typo'd identifier is IGNORED with a one-shot warn rather
# than aborting the run. We tear down the two prior servers first so their
# ports + containers are released before the subset server boots on a
# fresh port base (PORT+200). The two real identifiers are derived from
# the fixture's construct ids (single-stack app `CdkLocalStartApiFixture`,
# so the `<StackName>/<construct>` Construct-path form matches `cdkl list`
# output exactly): the HTTP API v2 (`MyHttpApi`) and the REST API v1
# (`MyRestApi`). The third is an obviously-bogus identifier that matches
# nothing.
echo "==> Tearing down the default + strict servers before the subset run"
term_server "${SERVER_PID:-}" "server"
SERVER_PID=""
term_server "${STRICT_SERVER_PID:-}" "strict server"
STRICT_SERVER_PID=""

SUBSET_PORT=$((PORT + 200))
SUBSET_HTTP_ID="CdkLocalStartApiFixture/MyHttpApi"
SUBSET_REST_ID="CdkLocalStartApiFixture/MyRestApi"
SUBSET_BOGUS_ID="CdkLocalStartApiFixture/NoSuchApi"
echo "==> Starting cdkl start-api SUBSET (${SUBSET_HTTP_ID}, ${SUBSET_REST_ID}, ${SUBSET_BOGUS_ID}) on port ${SUBSET_PORT}"
${CDKL} start-api \
  "${SUBSET_HTTP_ID}" \
  "${SUBSET_REST_ID}" \
  "${SUBSET_BOGUS_ID}" \
  --port "${SUBSET_PORT}" \
  --container-host "${CONTAINER_HOST}" \
  --no-pull \
  >"${SUBSET_LOG_FILE}" 2>&1 &
SUBSET_SERVER_PID=$!

# Exactly 2 servers should bind (the HTTP API + the REST API). We wait
# for >= 2, then assert the count is EXACTLY 2 (the bogus id contributes
# none). A short settle pass after the 2nd line catches a regression where
# the union accidentally served a third surface.
echo "==> Waiting for the subset servers (2 expected) to come up"
SUBSET_READY=0
for i in $(seq 1 60); do
  subcount=$(grep -c "Server listening" "${SUBSET_LOG_FILE}" 2>/dev/null) || subcount=0
  if [[ "${subcount}" -ge 2 ]]; then SUBSET_READY=1; break; fi
  sleep 0.5
done
if [[ "${SUBSET_READY}" -eq 0 ]]; then
  echo "FAIL: subset server: only ${subcount}/2 servers came up. Log:"
  cat "${SUBSET_LOG_FILE}"
  exit 1
fi
# Settle: give any erroneous extra server a moment to also bind, then
# assert the count is EXACTLY 2 (subset served, typo ignored, no extras).
sleep 1
SUBSET_COUNT=$(grep -c "Server listening" "${SUBSET_LOG_FILE}" 2>/dev/null) || SUBSET_COUNT=0
if [[ "${SUBSET_COUNT}" -ne 2 ]]; then
  echo "FAIL: subset run expected EXACTLY 2 servers, got ${SUBSET_COUNT}. Log:"
  cat "${SUBSET_LOG_FILE}"
  exit 1
fi
echo "    [subset: exactly 2 servers bound] OK"

# The bogus identifier must surface the one-shot "did not match ... ignored"
# warn (the run continues serving the two real siblings).
echo "==> Asserting the bogus identifier is ignored with a warn"
if ! grep -F "did not match any discovered API; it is ignored" "${SUBSET_LOG_FILE}" >/dev/null; then
  echo "FAIL: subset run missing the 'did not match ... ignored' warn for the bogus id. Log:"
  cat "${SUBSET_LOG_FILE}"
  exit 1
fi
if ! grep -F "${SUBSET_BOGUS_ID}" "${SUBSET_LOG_FILE}" >/dev/null; then
  echo "FAIL: subset run warn did not name the bogus id '${SUBSET_BOGUS_ID}'. Log:"
  cat "${SUBSET_LOG_FILE}"
  exit 1
fi
echo "    [subset: bogus id ignored with warn] OK"

term_server "${SUBSET_SERVER_PID:-}" "subset server"
SUBSET_SERVER_PID=""

# Standalone / offline mode: prove README L34-37 ("no AWS account or
# credentials needed") is actually enforced by the start-api code path.
# The whole previous test run inherits the developer's shell env, which
# typically has AWS_PROFILE + ~/.aws/credentials reachable — so it would
# silently pass even if start-api regressed into calling AWS for region
# detection, an SDK client instantiation, or a stray STS call. Here we
# strip the env with `env -i` and re-enter the SDK credential provider
# chain with everything pointing at /dev/null:
#   - AWS_PROFILE      = a bogus profile name nothing matches
#   - AWS_*_FILE       = /dev/null so no creds / config can be read
#   - AWS_EC2_METADATA_DISABLED = true so IMDS cannot be queried
# Only PATH + HOME + DOCKER_HOST are passed through (node + docker
# need them). If start-api ever silently adds an AWS dependency to the
# default path, this section breaks before the README claim ships.
OFFLINE_PORT=$((PORT + 300))
echo "==> Starting cdkl start-api in OFFLINE mode (no AWS creds reachable) on port ${OFFLINE_PORT}"
env -i \
  PATH="${PATH}" \
  HOME="${HOME}" \
  ${DOCKER_HOST:+DOCKER_HOST="${DOCKER_HOST}"} \
  AWS_PROFILE=__cdkl_offline_integ_bogus__ \
  AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  AWS_CONFIG_FILE=/dev/null \
  AWS_EC2_METADATA_DISABLED=true \
  ${CDKL} start-api \
    --port "${OFFLINE_PORT}" \
    --container-host "${CONTAINER_HOST}" \
    --no-pull \
    >"${OFFLINE_LOG_FILE}" 2>&1 &
OFFLINE_SERVER_PID=$!

echo "==> Waiting for all offline servers (${EXPECTED_SERVERS} expected) to come up"
OFFLINE_READY=0
for i in $(seq 1 60); do
  count=$(grep -c "Server listening" "${OFFLINE_LOG_FILE}" 2>/dev/null) || count=0
  if [[ "${count}" -ge "${EXPECTED_SERVERS}" ]]; then
    OFFLINE_READY=1
    break
  fi
  sleep 0.5
done
if [[ "${OFFLINE_READY}" -eq 0 ]]; then
  echo "FAIL: offline server: only ${count}/${EXPECTED_SERVERS} servers came up. Log:"
  cat "${OFFLINE_LOG_FILE}"
  exit 1
fi

# Extract the HTTP v2 + REST v1 ports from the offline server's banner.
# The port assignment order is fixed by route-discovery.ts but mirroring
# the same extraction the primary server uses keeps this resilient.
OFFLINE_PORT_HTTP=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(.*HTTP API v2\)' "${OFFLINE_LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
OFFLINE_PORT_REST=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(.*REST API v1\)' "${OFFLINE_LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
if [[ -z "${OFFLINE_PORT_HTTP}" || -z "${OFFLINE_PORT_REST}" ]]; then
  echo "FAIL: offline server: could not resolve HTTP v2 (${OFFLINE_PORT_HTTP}) / REST v1 (${OFFLINE_PORT_REST}) ports. Log:"
  cat "${OFFLINE_LOG_FILE}"
  exit 1
fi

# L35 + L37: HTTP v2 routing dispatches to the items handler, which
# echoes the captured `{id}`.
echo "==> [offline] Asserting GET /items/42 (L35 routing + L37 handler logic)"
OFFLINE_BODY=$(curl -s --max-time 30 "http://127.0.0.1:${OFFLINE_PORT_HTTP}/items/42")
if [[ "${OFFLINE_BODY}" != *'"id":"42"'* ]]; then
  echo "FAIL: offline GET /items/42 body did not contain '\"id\":\"42\"'; got: ${OFFLINE_BODY}"
  cat "${OFFLINE_LOG_FILE}"
  exit 1
fi
echo "    [offline GET /items/42] OK"

# L37: POST body echo proves the handler container ran the request body
# transform path with no AWS dependency.
echo "==> [offline] Asserting POST /items echoes the body (L37 handler logic)"
OFFLINE_POST_BODY=$(curl -s --max-time 30 -X POST -H 'content-type: application/json' \
  --data '{"hello":"offline"}' \
  "http://127.0.0.1:${OFFLINE_PORT_HTTP}/items")
if [[ "${OFFLINE_POST_BODY}" != *'"hello\":\"offline\"'* ]]; then
  echo "FAIL: offline POST /items did not echo the body; got: ${OFFLINE_POST_BODY}"
  cat "${OFFLINE_LOG_FILE}"
  exit 1
fi
echo "    [offline POST /items echo] OK"

# L36: deny path — Lambda authorizer container fires, returns Deny, the
# http-server translates to 401. No bearer token => unauthorized.
echo "==> [offline] Asserting GET /protected without bearer -> 401 (L36 authorizer deny)"
OFFLINE_DENY=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
  "http://127.0.0.1:${OFFLINE_PORT_HTTP}/protected")
if [[ "${OFFLINE_DENY}" != "401" ]]; then
  echo "FAIL: offline GET /protected (no auth) expected 401, got ${OFFLINE_DENY}"
  cat "${OFFLINE_LOG_FILE}"
  exit 1
fi
echo "    [offline GET /protected (deny)] OK (status=401)"

# L36: allow path — authorizer container returns Allow, request reaches
# the protected handler container.
echo "==> [offline] Asserting GET /protected with valid bearer -> 200 (L36 authorizer allow + handler container)"
OFFLINE_ALLOW=$(curl -s --max-time 30 \
  -H 'Authorization: Bearer let-me-in' \
  "http://127.0.0.1:${OFFLINE_PORT_HTTP}/protected")
if [[ "${OFFLINE_ALLOW}" != *'"protected":true'* ]]; then
  echo "FAIL: offline GET /protected (allow) body did not contain '\"protected\":true'; got: ${OFFLINE_ALLOW}"
  cat "${OFFLINE_LOG_FILE}"
  exit 1
fi
echo "    [offline GET /protected (allow)] OK"

# L35: REST v1 routing is a distinct dispatcher from HTTP v2; probe it
# too so the standalone claim covers both API kinds.
echo "==> [offline] Asserting REST v1 GET /v1/anything (L35 routing)"
OFFLINE_REST_BODY=$(curl -s --max-time 30 "http://127.0.0.1:${OFFLINE_PORT_REST}/v1/anything")
if [[ "${OFFLINE_REST_BODY}" != *'"routedVia":"rest-v1"'* ]]; then
  echo "FAIL: offline REST v1 GET /v1/anything body did not contain '\"routedVia\":\"rest-v1\"'; got: ${OFFLINE_REST_BODY}"
  cat "${OFFLINE_LOG_FILE}"
  exit 1
fi
echo "    [offline REST v1 GET /v1/anything] OK"

term_server "${OFFLINE_SERVER_PID:-}" "offline server"
OFFLINE_SERVER_PID=""

echo ""
echo "==> All local-start-api smoke tests passed"
