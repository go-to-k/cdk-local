#!/usr/bin/env bash
#
# Real-Docker validation for `cdkl start-agentcore` — the long-running serve
# that boots a Bedrock AgentCore Runtime container ONCE, keeps it warm, and
# serves its native contract until SIGTERM (issue #454). All four protocols are
# served; this fixture covers the three distinct wire shapes:
#
#   - HTTP  (EchoAgent) — POST /invocations + GET /ping on 8080, plus the /ws
#     WebSocket bridge so a header-less client (the browser path) can hold an
#     interactive multi-frame session.
#   - MCP   (McpAgent)  — POST /mcp on 8000 (JSON-RPC, no /ws).
#   - A2A   (A2aAgent)  — POST / on 9000 (JSON-RPC, no /ws).
#
# Plus the slice-4a inbound-auth surface (issue #454):
#   - JwtAgent (HTTP + customJwtAuthorizer) — the warm serve verifies the
#     caller's token PER REQUEST against a LOCAL JWKS sidecar: 401 (missing) /
#     403 (wrong audience) / 200 (valid), and GET /ping stays unauthenticated.
#   - EchoAgent --sigv4 — each forwarded request is AWS4-HMAC-SHA256 signed
#     (service bedrock-agentcore) so the container sees the cloud's header set.
#
# Fully local — no AWS resources are deployed. Each Runtime is built from a
# local Dockerfile. For each protocol the serve is booted, hit TWICE against
# the SAME warm container, then torn down. The HTTP /ws probe connects with the
# Node global WebSocket (no custom headers, exactly like a browser) and asserts
# the bridge injects a session-id and a frame round-trips. After every serve we
# assert no `cdkl-agentcore-*` container leaks.
#
# Run via `/run-integ local-start-agentcore` (recommended) or directly:
#
#     bash tests/integration/local-start-agentcore/verify.sh
#
# Requires Docker.

set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-agentcore"
CLI="node ${REPO_ROOT}/dist/cli.js"
STACK="CdkLocalStartAgentCoreFixture"
TARGET="${STACK}/EchoAgent"
MCP_TARGET="${STACK}/McpAgent"
A2A_TARGET="${STACK}/A2aAgent"
BASE_IMAGE="public.ecr.aws/docker/library/node:20-slim"

JWT_TARGET="${STACK}/JwtAgent"
# Must match JWKS_SIDECAR_PORT / JWT_AUDIENCE in lib/local-start-agentcore-stack.ts.
SIDECAR_PORT=19010
SIDECAR_ISSUER="http://127.0.0.1:${SIDECAR_PORT}"
JWT_AUD="cdkl-agentcore-aud"

CDKL_PID=""
SIDECAR_PID=""
OUT_FILE="$(mktemp)"
# Set by the --watch step (step 11): the agent source it edits + its backup, so
# cleanup always restores the committed fixture even if the test aborts.
AGENT_SRC=""
AGENT_SRC_BACKUP=""

stop_server() {
  if [ -n "${CDKL_PID}" ] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 80); do kill -0 "${CDKL_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  CDKL_PID=""
}

stop_sidecar() {
  if [ -n "${SIDECAR_PID}" ] && kill -0 "${SIDECAR_PID}" 2>/dev/null; then
    kill -TERM "${SIDECAR_PID}" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "${SIDECAR_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${SIDECAR_PID}" 2>/dev/null || true
  fi
  SIDECAR_PID=""
}

restore_source() {
  if [ -n "${AGENT_SRC_BACKUP}" ] && [ -f "${AGENT_SRC_BACKUP}" ]; then
    cp "${AGENT_SRC_BACKUP}" "${AGENT_SRC}" 2>/dev/null || true
    rm -f "${AGENT_SRC_BACKUP}"
  fi
  AGENT_SRC_BACKUP=""
}

cleanup() {
  rc=$?
  stop_server
  stop_sidecar
  restore_source
  rm -f "${OUT_FILE}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "----- cdkl output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

# Boot `cdkl start-agentcore <target>` into the background, replacing any prior
# server. Truncates OUT_FILE so each serve's ready lines are read fresh.
boot_serve() {
  stop_server
  : > "${OUT_FILE}"
  # shellcheck disable=SC2086
  ${CLI} start-agentcore "$1" --host 127.0.0.1 --port 0 > "${OUT_FILE}" 2>&1 &
  CDKL_PID=$!
}

# Poll OUT_FILE for a `grep -Eo` pattern (the ready line), echoing the match.
# Fails if the server exits or the line never appears within the window.
wait_for_ready() {
  local pattern="$1" found=""
  for _ in $(seq 1 480); do
    found="$(grep -Eo "${pattern}" "${OUT_FILE}" | head -1 || true)"
    [ -n "${found}" ] && { echo "${found}"; return 0; }
    kill -0 "${CDKL_PID}" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

assert_no_orphans() {
  sleep 1
  local orphans
  orphans="$(docker ps -a --filter name=cdkl-agentcore- --format '{{.Names}}' || true)"
  [ -z "${orphans}" ] || fail "leftover agent container(s) after $1: ${orphans}"
}

echo "[verify] step 1: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
[ -d node_modules ] || vp install --prefer-offline

echo "[verify] step 2: Docker available + base image present"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform linux/arm64 "${BASE_IMAGE}" >/dev/null

echo "[verify] step 3: boot \`cdkl start-agentcore ${TARGET}\`"
: > "${OUT_FILE}"
${CLI} start-agentcore "${TARGET}" --host 127.0.0.1 --port 0 > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!

WS_URL=""
for _ in $(seq 1 480); do
  # Ready line: "Server listening on ws://127.0.0.1:<port>/ws  (EchoAgent (AgentCore WebSocket))"
  line="$(grep -Eo 'Server listening on ws://[^ ]+/ws' "${OUT_FILE}" | head -1 || true)"
  if [ -n "${line}" ]; then WS_URL="${line#Server listening on }"; break; fi
  kill -0 "${CDKL_PID}" 2>/dev/null || fail "start-agentcore exited before it was ready"
  sleep 0.5
done
[ -n "${WS_URL}" ] || fail "start-agentcore did not print its ws:// ready banner in time"
echo "[verify]   ready: ${WS_URL}"

echo "[verify] step 4: header-less WebSocket probe (browser path) round-trips through the bridge"
if ! node ws-probe.mjs "${WS_URL}"; then
  fail "WebSocket probe did not succeed"
fi

echo "[verify] step 5: HTTP contract serve (POST /invocations + GET /ping) on the same warm container (#454)"
# Ready line: "HTTP contract served on http://127.0.0.1:<port> - POST .../invocations, GET .../ping"
HTTP_URL="$(grep -Eo 'HTTP contract served on http://[^ ]+' "${OUT_FILE}" | head -1 | sed 's/HTTP contract served on //')"
[ -n "${HTTP_URL}" ] || fail "start-agentcore did not print its HTTP serve URL"
echo "[verify]   http: ${HTTP_URL}"
# Two sequential POSTs hit the SAME warm container booted at step 3 — no
# re-boot per request (the warm-serve guarantee). The serve injects a
# per-request session-id (the header-less curl never sent one).
R1="$(curl -s -X POST "${HTTP_URL}/invocations" -d '{"hello":"http-1"}')"
echo "${R1}" | grep -q 'http-1' || fail "first /invocations did not echo the body: ${R1}"
echo "${R1}" | grep -q '"sessionId":null' && fail "serve did not inject a session-id: ${R1}"
echo "${R1}" | grep -q '"sessionId":"' || fail "serve did not inject a session-id: ${R1}"
R2="$(curl -s -X POST "${HTTP_URL}/invocations" -d '{"hello":"http-2"}')"
echo "${R2}" | grep -q 'http-2' || fail "second /invocations (warm reuse) did not echo the body: ${R2}"
# An SSE response streams through the proxy pipe untouched.
SSE="$(curl -s -X POST "${HTTP_URL}/invocations" -d '{"stream":true}')"
echo "${SSE}" | grep -q '\[DONE\]' || fail "SSE /invocations did not stream through the serve: ${SSE}"
# GET /ping proxies to the container.
PING="$(curl -s "${HTTP_URL}/ping")"
echo "${PING}" | grep -q 'Healthy' || fail "/ping did not proxy through the serve: ${PING}"
echo "[verify]   HTTP serve OK: 2x /invocations + SSE + /ping handled by the one warm container"

echo "[verify] step 6: SIGTERM tears the HTTP container down (no orphan)"
stop_server
assert_no_orphans "HTTP serve shutdown"

echo "[verify] step 7: boot \`cdkl start-agentcore ${MCP_TARGET}\` (MCP warm serve, POST /mcp, no /ws)"
boot_serve "${MCP_TARGET}"
# Ready line: "MCP contract served on http://127.0.0.1:<port>/mcp — POST ..."
MCP_URL="$(wait_for_ready 'MCP contract served on http://[^ ]+' || true)"
MCP_URL="${MCP_URL#MCP contract served on }"
[ -n "${MCP_URL}" ] || fail "start-agentcore did not print its MCP contract URL"
echo "[verify]   mcp: ${MCP_URL}"
# An MCP runtime has no /ws — the ws:// line must NOT be printed.
grep -q 'Server listening on ws://' "${OUT_FILE}" && fail "MCP serve unexpectedly advertised a /ws endpoint"
# Two JSON-RPC tools/list POSTs hit the SAME warm container booted once above.
# The fixture embeds a per-process `_warmCount`; it goes 1 -> 2 ONLY if the
# same warm process served both (a boot-per-request would reset it to 1 each
# time), so this proves the warm-reuse guarantee, not just "served twice".
MCP_JSONRPC='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
M1="$(curl -s -X POST "${MCP_URL}" -H 'content-type: application/json' -d "${MCP_JSONRPC}")"
echo "${M1}" | grep -q 'add_numbers' || fail "first POST /mcp tools/list did not return the tool list: ${M1}"
echo "${M1}" | grep -q '"_warmCount":1' || fail "first POST /mcp did not report warm count 1: ${M1}"
M2="$(curl -s -X POST "${MCP_URL}" -H 'content-type: application/json' -d "${MCP_JSONRPC}")"
echo "${M2}" | grep -q 'add_numbers' || fail "second POST /mcp (warm reuse) did not return the tool list: ${M2}"
echo "${M2}" | grep -q '"_warmCount":2' || fail "second POST /mcp did not hit the SAME warm process (expected warm count 2): ${M2}"
echo "[verify]   MCP serve OK: 2x POST /mcp tools/list, warm count 1 -> 2 on the one warm container"
stop_server
assert_no_orphans "MCP serve shutdown"

echo "[verify] step 8: boot \`cdkl start-agentcore ${A2A_TARGET}\` (A2A warm serve, POST /, no /ws)"
boot_serve "${A2A_TARGET}"
# Ready line: "A2A contract served on http://127.0.0.1:<port>/ — POST ..."
A2A_URL="$(wait_for_ready 'A2A contract served on http://[^ ]+' || true)"
A2A_URL="${A2A_URL#A2A contract served on }"
[ -n "${A2A_URL}" ] || fail "start-agentcore did not print its A2A contract URL"
echo "[verify]   a2a: ${A2A_URL}"
grep -q 'Server listening on ws://' "${OUT_FILE}" && fail "A2A serve unexpectedly advertised a /ws endpoint"
# Two JSON-RPC POSTs (getCard then tasks/send) against the SAME warm container.
# The embedded `_warmCount` goes 1 -> 2 only if one warm process served both.
A1="$(curl -s -X POST "${A2A_URL}" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"agent/getCard"}')"
echo "${A1}" | grep -q 'fixture-a2a-agent' || fail "first POST / agent/getCard did not return the agent card: ${A1}"
echo "${A1}" | grep -q '"_warmCount":1' || fail "first POST / did not report warm count 1: ${A1}"
A2="$(curl -s -X POST "${A2A_URL}" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tasks/send","params":{"id":"t1","message":"hi"}}')"
echo "${A2}" | grep -q '"completed"' || fail "second POST / tasks/send (warm reuse) did not complete: ${A2}"
echo "${A2}" | grep -q '"_warmCount":2' || fail "second POST / did not hit the SAME warm process (expected warm count 2): ${A2}"
echo "[verify]   A2A serve OK: getCard + tasks/send, warm count 1 -> 2 on the one warm container"
stop_server
assert_no_orphans "A2A serve shutdown"

echo "[verify] step 9: JWT-protected warm serve — per-request inbound JWT gate (401/403/200) (#454)"
# Boot the local JWKS sidecar the JwtAgent's customJwtAuthorizer discovery URL
# points at. The HOST-side verifier (in cdkl) fetches the discovery + JWKS from
# it to verify each caller's token per request.
SIDECAR_LOG="$(mktemp)"
node jwks-sidecar.mjs "${SIDECAR_PORT}" > "${SIDECAR_LOG}" 2>&1 &
SIDECAR_PID=$!
for _ in $(seq 1 40); do
  curl -fsS --max-time 2 "${SIDECAR_ISSUER}/.well-known/jwks.json" >/dev/null 2>&1 && break
  kill -0 "${SIDECAR_PID}" 2>/dev/null || { echo "----- sidecar output -----"; cat "${SIDECAR_LOG}"; rm -f "${SIDECAR_LOG}"; fail "JWKS sidecar exited before becoming reachable"; }
  sleep 0.25
done
curl -fsS --max-time 2 "${SIDECAR_ISSUER}/.well-known/jwks.json" >/dev/null 2>&1 \
  || { rm -f "${SIDECAR_LOG}"; fail "JWKS sidecar never reachable at ${SIDECAR_ISSUER}"; }
rm -f "${SIDECAR_LOG}"
echo "[verify]   JWKS sidecar reachable at ${SIDECAR_ISSUER}"

# Boot the JWT serve with NO --bearer-token: the per-request inbound gate is the
# surface (the cloud verifies the CALLER's token, not a boot default).
boot_serve "${JWT_TARGET}"
JWT_HTTP_URL="$(wait_for_ready 'HTTP contract served on http://[^ ]+' || true)"
JWT_HTTP_URL="${JWT_HTTP_URL#HTTP contract served on }"
[ -n "${JWT_HTTP_URL}" ] || fail "JWT serve did not print its HTTP contract URL"
echo "[verify]   jwt http: ${JWT_HTTP_URL}"

# 401 — no Authorization on a customJwtAuthorizer runtime.
S401="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${JWT_HTTP_URL}/invocations" -d '{"q":"no-token"}')"
[ "${S401}" = "401" ] || fail "expected 401 for a missing token, got ${S401}"
# 403 — valid signature + issuer + expiry, but the wrong audience.
BAD_JWT="$(node sign-jwt.mjs --iss "${SIDECAR_ISSUER}" --aud wrong-aud --exp-offset 300)"
S403="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${JWT_HTTP_URL}/invocations" \
  -H "authorization: Bearer ${BAD_JWT}" -d '{"q":"bad-aud"}')"
[ "${S403}" = "403" ] || fail "expected 403 for a wrong-audience token, got ${S403}"
# 200 — a token signed by the sidecar key with the right iss + aud.
GOOD_JWT="$(node sign-jwt.mjs --iss "${SIDECAR_ISSUER}" --aud "${JWT_AUD}" --exp-offset 300)"
GOOD_RESP="$(curl -s -w $'\n%{http_code}' -X POST "${JWT_HTTP_URL}/invocations" \
  -H "authorization: Bearer ${GOOD_JWT}" -d '{"q":"valid"}')"
GOOD_CODE="$(printf '%s' "${GOOD_RESP}" | tail -1)"
GOOD_BODY="$(printf '%s' "${GOOD_RESP}" | sed '$d')"
[ "${GOOD_CODE}" = "200" ] || fail "expected 200 for a valid token, got ${GOOD_CODE}: ${GOOD_BODY}"
printf '%s' "${GOOD_BODY}" | grep -q 'valid' || fail "valid-token /invocations did not echo the body: ${GOOD_BODY}"
# GET /ping is an unauthenticated health check even on a JWT-protected serve.
PING_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${JWT_HTTP_URL}/ping")"
[ "${PING_CODE}" = "200" ] || fail "GET /ping should be unauthenticated, got ${PING_CODE}"
echo "[verify]   JWT gate OK: 401 (missing) / 403 (wrong aud) / 200 (valid) + unauthenticated /ping"
stop_server
assert_no_orphans "JWT serve shutdown"
stop_sidecar

echo "[verify] step 10: --sigv4 signs each forwarded request (EchoAgent, no authorizer) (#454)"
# cdkl signs host-side with shell credentials; the warm container receives the
# AWS4-HMAC-SHA256 Authorization + X-Amz-* headers and echoes the Authorization.
: > "${OUT_FILE}"
# shellcheck disable=SC2086
AWS_ACCESS_KEY_ID=AKIDINTEGTESTSIGV4 \
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYINTEGEXAMPLEKEY \
AWS_REGION=us-east-1 \
  ${CLI} start-agentcore "${TARGET}" --host 127.0.0.1 --port 0 --sigv4 > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!
SIG_HTTP_URL="$(wait_for_ready 'HTTP contract served on http://[^ ]+' || true)"
SIG_HTTP_URL="${SIG_HTTP_URL#HTTP contract served on }"
[ -n "${SIG_HTTP_URL}" ] || fail "--sigv4 serve did not print its HTTP contract URL"
echo "[verify]   sigv4 http: ${SIG_HTTP_URL}"
SIGR="$(curl -s -X POST "${SIG_HTTP_URL}/invocations" -d '{"q":"sigv4"}')"
echo "${SIGR}" | grep -q 'AWS4-HMAC-SHA256' \
  || fail "--sigv4 did not inject a signed Authorization into the forwarded request: ${SIGR}"
echo "${SIGR}" | grep -q 'bedrock-agentcore' \
  || fail "--sigv4 signature was not scoped to the bedrock-agentcore service: ${SIGR}"
echo "[verify]   --sigv4 OK: forwarded request carried an AWS4-HMAC-SHA256 Authorization (bedrock-agentcore)"
stop_server
assert_no_orphans "sigv4 serve shutdown"

echo "[verify] step 11: --watch reloads the warm container in place on a source edit (#454 slice 4b)"
AGENT_SRC="${TEST_DIR}/agent/server.js"
AGENT_SRC_BACKUP="$(mktemp)"
cp "${AGENT_SRC}" "${AGENT_SRC_BACKUP}"

# Boot the HTTP serve with --watch (watches the fixture cwd for source edits).
: > "${OUT_FILE}"
${CLI} start-agentcore "${TARGET}" --host 127.0.0.1 --port 0 --watch > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!
WATCH_HTTP_URL="$(wait_for_ready 'HTTP contract served on http://[^ ]+' || true)"
WATCH_HTTP_URL="${WATCH_HTTP_URL#HTTP contract served on }"
[ -n "${WATCH_HTTP_URL}" ] || fail "--watch serve did not print its HTTP contract URL"
echo "[verify]   watch http: ${WATCH_HTTP_URL}"
# Confirm the watcher started.
grep -q 'Watching .* for source changes' "${OUT_FILE}" || fail "--watch did not start the file watcher"

# Pre-edit: the response does NOT carry the watch marker.
R_PRE="$(curl -s -X POST "${WATCH_HTTP_URL}/invocations" -d '{"q":"pre-reload"}')"
echo "${R_PRE}" | grep -q 'WATCH-V2' && fail "watchVersion present before the edit: ${R_PRE}"

# Edit the agent source (interpreted-language handler, no Dockerfile change) so
# the classifier picks soft-reload: inject a watchVersion field into the
# /invocations response.
node -e "const f='${AGENT_SRC}';const fs=require('fs');let s=fs.readFileSync(f,'utf8');s=s.replace(/greeting: process.env.GREETING \?\? 'unset',/g, \"greeting: process.env.GREETING ?? 'unset', watchVersion: 'WATCH-V2',\");fs.writeFileSync(f,s);"

# Wait for the reload to complete (re-synth + classify + soft-reload + ready).
RELOADED=0
for _ in $(seq 1 240); do
  if grep -q 'Reload complete.' "${OUT_FILE}"; then RELOADED=1; break; fi
  kill -0 "${CDKL_PID}" 2>/dev/null || fail "--watch serve exited during reload"
  sleep 0.5
done
[ "${RELOADED}" = "1" ] || fail "--watch did not complete a reload within 120s"
grep -q 'verdict=soft-reload' "${OUT_FILE}" || fail "expected verdict=soft-reload for a source-only edit"
echo "[verify]   reload OK: verdict=soft-reload + Reload complete."

# Post-edit: the SAME warm serve now serves the new code.
R_POST="$(curl -s -X POST "${WATCH_HTTP_URL}/invocations" -d '{"q":"post-reload"}')"
echo "${R_POST}" | grep -q 'WATCH-V2' || fail "reloaded serve did not serve the new code: ${R_POST}"
echo "[verify]   --watch OK: source edit -> soft-reload -> new code served on the SAME serve port"

stop_server
restore_source
assert_no_orphans "--watch serve shutdown"

echo "[verify] PASS: start-agentcore served HTTP (POST /invocations + SSE + GET /ping + /ws bridge), MCP (POST /mcp), A2A (POST /), the per-request JWT gate (401/403/200), --sigv4 signing, and --watch reload (soft-reload in place) — each against one warm container — and cleaned up"
