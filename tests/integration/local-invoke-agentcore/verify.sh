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
# we can assert the SSE response is streamed to stdout incrementally.
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
BASE_IMAGE="public.ecr.aws/docker/library/node:20-slim"

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${BASE_IMAGE} (one-time)"
docker pull --platform linux/arm64 "${BASE_IMAGE}" >/dev/null

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# Test 1 — default empty event: env injection + auto session id.
echo "==> [1/8] Invoking EchoAgent with default empty event"
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
echo "==> [2/8] Invoking EchoAgent with --event payload"
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
echo "==> [3/8] Invoking EchoAgent with --env-vars override"
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
echo "==> [4/8] Invoking EchoAgent with explicit --session-id"
SESSION="cdkl-integ-session-1234567890abcdef"
RESULT_4=$(${CDKL} invoke-agentcore "${TARGET}" --session-id "${SESSION}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -q "\"sessionId\":\"${SESSION}\"" || {
  echo "FAIL: expected sessionId=${SESSION} in response, got: ${RESULT_4}"
  exit 1
}

# Test 5 — a JWT-protected runtime invoked WITHOUT a token is rejected
# BEFORE any container starts (AgentCore returns 401 in the cloud).
echo "==> [5/8] ProtectedAgent without --bearer-token must be rejected pre-container"
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
echo "==> [6/8] ProtectedAgent with --no-verify-auth proceeds (auth skipped)"
RESULT_6=$(${CDKL} invoke-agentcore "${PROTECTED}" --no-verify-auth 2>/dev/null | tail -1)
echo "    response: ${RESULT_6}"
echo "${RESULT_6}" | grep -q '"greeting":"hello-from-agent"' || {
  echo "FAIL: expected the agent to respond under --no-verify-auth, got: ${RESULT_6}"
  exit 1
}

# Test 7 — a --bearer-token (discovery URL unreachable -> pass-through accept)
# is verified and forwarded to /invocations as the Authorization header.
echo "==> [7/8] ProtectedAgent with --bearer-token forwards the Authorization header"
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
echo "==> [8/8] EchoAgent streams a text/event-stream response to stdout"
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

echo ""
echo "==> All 8 local-invoke-agentcore tests passed"
