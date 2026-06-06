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

CDKL_PID=""
OUT_FILE="$(mktemp)"

stop_server() {
  if [ -n "${CDKL_PID}" ] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 80); do kill -0 "${CDKL_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  CDKL_PID=""
}

cleanup() {
  rc=$?
  stop_server
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

echo "[verify] PASS: start-agentcore served HTTP (POST /invocations + SSE + GET /ping + /ws bridge), MCP (POST /mcp), and A2A (POST /) — each against one warm container — and cleaned up"
