#!/usr/bin/env bash
# verify.sh — local-invoke-agentcore integ test (issue #87 v1)
#
# Fully local — no AWS resources are deployed. We synthesize a CDK app
# whose only resource is an AWS::BedrockAgentCore::Runtime backed by a
# local Dockerfile asset, and exercise the local-build path of
# `cdkl invoke-agentcore` end-to-end: build the agent container, run it on
# 8080, wait for GET /ping, POST the event to /invocations, print the
# response.
#
# The fixture agent echoes the request body, the received session-id
# header, and the injected GREETING env var, so we can assert the full
# request/response contract + env injection + session-id binding. When the
# event carries {"stream": true} it responds with a text/event-stream body, so
# we can assert the SSE response is streamed to stdout incrementally. A second
# MCP-protocol runtime (McpAgent, POST /mcp on 8000) exercises the MCP session
# handshake + tools/list / tools/call. A third runtime (CodeAgent) is a
# CodeConfiguration / managed-runtime artifact authored as plain Python source
# (fromCodeAsset) that cdkl builds from source and runs. The final scenario
# exercises `--ws`: the EchoAgent's bidirectional /ws WebSocket endpoint (same
# 8080 container), sending the event as the first frame and streaming the
# received frames to stdout.
#
# Run via `/run-integ local-invoke-agentcore` (recommended) or directly:
#
#     bash tests/integration/local-invoke-agentcore/verify.sh
#
# Requires Docker. The build pulls a small node base image the first time.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
TARGET="CdkLocalInvokeAgentCoreFixture/EchoAgent"
PROTECTED="CdkLocalInvokeAgentCoreFixture/ProtectedAgent"
MCP="CdkLocalInvokeAgentCoreFixture/McpAgent"
CODE="CdkLocalInvokeAgentCoreFixture/CodeAgent"
BASE_IMAGE="public.ecr.aws/docker/library/node:20-slim"
CODE_BASE_IMAGE="public.ecr.aws/docker/library/python:3.12-slim"

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling base images (one-time)"
docker pull --platform linux/arm64 "${BASE_IMAGE}" >/dev/null
docker pull --platform linux/arm64 "${CODE_BASE_IMAGE}" >/dev/null

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# Test 1 — default empty event: env injection + auto session id.
echo "==> [1/14] Invoking EchoAgent with default empty event"
RESULT_1=$(${CDKL} invoke-agentcore "${TARGET}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting":"hello-from-agent"' || {
  echo "FAIL: expected greeting=hello-from-agent in response, got: ${RESULT_1}"
  exit 1
}
# Auto-generated session id reached the container (not null).
echo "${RESULT_1}" | grep -Eq '"sessionId":"[0-9a-fA-F-]{8,}' || {
  echo "FAIL: expected a non-null auto session id in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event echoes through /invocations.
echo "==> [2/14] Invoking EchoAgent with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}"' EXIT
echo '{"prompt":"hello agent","n":7}' > "${EVENT_FILE}"
RESULT_2=$(${CDKL} invoke-agentcore "${TARGET}" --event "${EVENT_FILE}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"prompt":"hello agent"' || {
  echo "FAIL: expected echoed prompt in response, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override wins over the template env.
echo "==> [3/14] Invoking EchoAgent with --env-vars override"
ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}"' EXIT
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(${CDKL} invoke-agentcore "${TARGET}" --env-vars "${ENV_FILE}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -q '"greeting":"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — explicit --session-id reaches the container's session header.
echo "==> [4/14] Invoking EchoAgent with explicit --session-id"
SESSION="cdkl-integ-session-1234567890abcdef"
RESULT_4=$(${CDKL} invoke-agentcore "${TARGET}" --session-id "${SESSION}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -q "\"sessionId\":\"${SESSION}\"" || {
  echo "FAIL: expected sessionId=${SESSION} in response, got: ${RESULT_4}"
  exit 1
}

# Test 5 — a JWT-protected runtime invoked WITHOUT a token is rejected
# BEFORE any container starts (AgentCore returns 401 in the cloud).
echo "==> [5/14] ProtectedAgent without --bearer-token must be rejected pre-container"
set +e
OUT_5=$(${CDKL} invoke-agentcore "${PROTECTED}" 2>&1)
RC_5=$?
set -e
echo "    exit=${RC_5}"
[[ ${RC_5} -ne 0 ]] || {
  echo "FAIL: expected a non-zero exit for the protected runtime with no token, got 0. Output: ${OUT_5}"
  exit 1
}
echo "${OUT_5}" | grep -q "requires an inbound JWT" || {
  echo "FAIL: expected an 'requires an inbound JWT' error, got: ${OUT_5}"
  exit 1
}
RUNNING=$(docker ps -a --filter name=cdkl-agentcore- -q | wc -l | tr -d ' ')
[[ "${RUNNING}" == "0" ]] || {
  echo "FAIL: a container was created despite the pre-container auth rejection (${RUNNING} found)"
  exit 1
}

# Test 6 — --no-verify-auth skips verification and proceeds.
echo "==> [6/14] ProtectedAgent with --no-verify-auth proceeds (auth skipped)"
RESULT_6=$(${CDKL} invoke-agentcore "${PROTECTED}" --no-verify-auth 2>/dev/null | tail -1)
echo "    response: ${RESULT_6}"
echo "${RESULT_6}" | grep -q '"greeting":"hello-from-agent"' || {
  echo "FAIL: expected the agent to respond under --no-verify-auth, got: ${RESULT_6}"
  exit 1
}

# Test 7 — a --bearer-token (discovery URL unreachable -> pass-through accept)
# is verified and forwarded to /invocations as the Authorization header.
echo "==> [7/14] ProtectedAgent with --bearer-token forwards the Authorization header"
TOKEN="header.payload.sig"
RESULT_7=$(${CDKL} invoke-agentcore "${PROTECTED}" --bearer-token "${TOKEN}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_7}"
echo "${RESULT_7}" | grep -q "\"authorization\":\"Bearer ${TOKEN}\"" || {
  echo "FAIL: expected the bearer token forwarded as Authorization: Bearer ${TOKEN}, got: ${RESULT_7}"
  exit 1
}

# Test 8 — a text/event-stream response is streamed to stdout incrementally.
# The agent emits SSE frames when the event carries {"stream": true}; we assert
# every streamed frame reached stdout (the full body, not a single buffered
# line — so we capture all output, not just tail -1).
echo "==> [8/14] EchoAgent streams a text/event-stream response to stdout"
STREAM_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}"' EXIT
echo '{"stream":true}' > "${STREAM_EVENT}"
RESULT_8=$(${CDKL} invoke-agentcore "${TARGET}" --event "${STREAM_EVENT}" 2>/dev/null)
echo "    response: ${RESULT_8}"
for tok in hello from sse; do
  echo "${RESULT_8}" | grep -q "\"token\":\"${tok}\"" || {
    echo "FAIL: expected streamed SSE frame token=${tok}, got: ${RESULT_8}"
    exit 1
  }
done
echo "${RESULT_8}" | grep -q '\[DONE\]' || {
  echo "FAIL: expected the streamed [DONE] sentinel, got: ${RESULT_8}"
  exit 1
}

# Test 9 — an MCP-protocol runtime, no --event: the session handshake runs and
# the default tools/list request returns the server's tools. The container
# serves POST /mcp on 8000 (no /ping); readiness is a successful initialize.
echo "==> [9/14] McpAgent (no --event) runs the handshake + tools/list"
RESULT_9=$(${CDKL} invoke-agentcore "${MCP}" 2>/dev/null)
echo "    response: ${RESULT_9}"
echo "${RESULT_9}" | grep -q '"name": "add_numbers"' || {
  echo "FAIL: expected tools/list to return the add_numbers tool, got: ${RESULT_9}"
  exit 1
}

# Test 10 — an MCP tools/call via --event returns the tool result.
echo "==> [10/14] McpAgent with --event runs tools/call"
CALL_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}"' EXIT
echo '{"method":"tools/call","params":{"name":"add_numbers","arguments":{"a":2,"b":3}}}' > "${CALL_EVENT}"
RESULT_10=$(${CDKL} invoke-agentcore "${MCP}" --event "${CALL_EVENT}" 2>/dev/null)
echo "    response: ${RESULT_10}"
echo "${RESULT_10}" | grep -q '"text": "5"' || {
  echo "FAIL: expected tools/call add_numbers(2,3) to return text \"5\", got: ${RESULT_10}"
  exit 1
}

# Test 11 — a CodeConfiguration (managed-runtime) runtime authored as plain
# source (no Dockerfile): cdkl builds it from source (pip install + run the
# entrypoint) and the entrypoint self-serves the 8080 HTTP contract.
echo "==> [11/14] CodeAgent (fromCodeAsset) builds from source + responds"
RESULT_11=$(${CDKL} invoke-agentcore "${CODE}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_11}"
echo "${RESULT_11}" | grep -q '"runtime":"python-code"' || {
  echo "FAIL: expected the from-source python agent to respond, got: ${RESULT_11}"
  exit 1
}
echo "${RESULT_11}" | grep -q '"greeting":"hello-from-code"' || {
  echo "FAIL: expected greeting=hello-from-code (env injected), got: ${RESULT_11}"
  exit 1
}

# Test 12 — a --event payload echoes through the from-source agent.
echo "==> [12/14] CodeAgent with --event echoes the payload"
CODE_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}" "${CODE_EVENT}"' EXIT
echo '{"prompt":"hello code"}' > "${CODE_EVENT}"
RESULT_12=$(${CDKL} invoke-agentcore "${CODE}" --event "${CODE_EVENT}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_12}"
echo "${RESULT_12}" | grep -q '"prompt":"hello code"' || {
  echo "FAIL: expected echoed prompt from the from-source agent, got: ${RESULT_12}"
  exit 1
}

# Test 13 — the bidirectional /ws WebSocket transport: --ws sends the event as
# the first frame and streams every received frame to stdout until the agent
# closes. The fixture agent replies with one JSON frame (echo + session id +
# Authorization + GREETING) then a second text frame, then closes.
echo "==> [13/14] EchoAgent over the /ws WebSocket (--ws)"
WS_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}" "${CODE_EVENT}" "${WS_EVENT}"' EXIT
echo '{"prompt":"hello ws"}' > "${WS_EVENT}"
RESULT_13=$(${CDKL} invoke-agentcore "${TARGET}" --ws --event "${WS_EVENT}" 2>/dev/null)
echo "    response: ${RESULT_13}"
echo "${RESULT_13}" | grep -q '"ws":true' || {
  echo "FAIL: expected the /ws frame marker \"ws\":true, got: ${RESULT_13}"
  exit 1
}
echo "${RESULT_13}" | grep -q '"prompt":"hello ws"' || {
  echo "FAIL: expected the echoed event over /ws, got: ${RESULT_13}"
  exit 1
}
echo "${RESULT_13}" | grep -q '"greeting":"hello-from-agent"' || {
  echo "FAIL: expected GREETING injected over /ws, got: ${RESULT_13}"
  exit 1
}
echo "${RESULT_13}" | grep -q 'ws-frame-2' || {
  echo "FAIL: expected the second streamed /ws frame, got: ${RESULT_13}"
  exit 1
}

# Test 14 — --ws is HTTP-only: against an MCP runtime it warns and is ignored,
# falling through to the normal MCP path (tools/list still returns).
echo "==> [14/14] McpAgent with --ws warns + still runs the MCP path"
set +e
OUT_14=$(${CDKL} invoke-agentcore "${MCP}" --ws 2>/tmp/cdkl-ws-mcp-stderr; cat /tmp/cdkl-ws-mcp-stderr >&2)
RC_14=$?
ERR_14=$(cat /tmp/cdkl-ws-mcp-stderr)
rm -f /tmp/cdkl-ws-mcp-stderr
set -e
echo "    response: ${OUT_14}"
[[ ${RC_14} -eq 0 ]] || {
  echo "FAIL: expected MCP --ws to still succeed (exit 0), got ${RC_14}. Output: ${OUT_14}"
  exit 1
}
echo "${OUT_14}" | grep -q '"name": "add_numbers"' || {
  echo "FAIL: expected MCP --ws to fall through to tools/list, got: ${OUT_14}"
  exit 1
}
echo "${ERR_14}" | grep -q -- '--ws applies only to the HTTP protocol' || {
  echo "FAIL: expected an MCP --ws ignored warning on stderr, got: ${ERR_14}"
  exit 1
}

echo ""
echo "==> All 14 local-invoke-agentcore tests passed"
