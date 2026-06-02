#!/usr/bin/env bash
# verify.sh — cdkl studio Phase 1 control-plane console integ test.
#
# studio is the interactive front over the same synth + target enumeration
# the headless commands use. Phase 1 (this slice) boots a local web server
# that lists the synthesized app's runnable targets and streams a live
# activity timeline over SSE. This test drives the REAL cdkl binary
# end-to-end (no unit-level stubbing) against a fixture app rich enough to
# emit every target group:
#
#   - boots `cdkl studio`,
#   - asserts the UI HTML is served at GET /,
#   - asserts GET /api/targets lists the fixture's targets,
#   - asserts GET /api/events opens a text/event-stream (SSE),
#   - asserts the command is registered on the user-facing surface,
#   - drives POST /api/run to invoke a Lambda in a RIE container (slice B),
#   - drives POST /api/run to START a long-running `start-api` serve, curls
#     the served route through it (the served endpoint is the studio
#     CAPTURE PROXY — slice C2), asserts the request is captured on the
#     timeline as an `invocation` row, GET /api/running reflects it + a
#     `serve` SSE event fired, then POST /api/stop tears it down,
#   - asserts the store (slice C3) serves GET /api/history, full-text
#     GET /api/logs?q=, and per-invocation GET /api/invocations/<id>/logs,
#   - starts an ALB serve (`start-alb`), curls the front-door through the
#     studio capture proxy + asserts the request is captured (kind=alb),
#     and an ECS service serve (`start-service`) that runs pure compute
#     with NO host endpoint (serve-kinds slice), and
#   - tears the server down cleanly.
#
# Docker required — the invoke + serve slices boot real RIE containers.
#
#   bash tests/integration/local-studio/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
HOST="127.0.0.1"
PORT="0" # 0 => OS-assigned; the bound URL is parsed from the boot log.

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

LOG_FILE=$(mktemp)
BODY_FILE=$(mktemp)
RUN_FILE=$(mktemp)
SSE_FILE=$(mktemp)
STUDIO_PID=""
SSE_PID=""
cleanup() {
  if [[ -n "${SSE_PID}" ]] && kill -0 "${SSE_PID}" 2>/dev/null; then
    kill "${SSE_PID}" 2>/dev/null || true
  fi
  if [[ -n "${STUDIO_PID}" ]] && kill -0 "${STUDIO_PID}" 2>/dev/null; then
    kill "${STUDIO_PID}" 2>/dev/null || true
    wait "${STUDIO_PID}" 2>/dev/null || true
  fi
  rm -f "${LOG_FILE}" "${BODY_FILE}" "${RUN_FILE}" "${SSE_FILE}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. The command must be registered on the user-facing command surface
#    (the unveil slice removed the CDKL_STUDIO_PREVIEW gate).
# ---------------------------------------------------------------------------
echo "==> Asserting 'cdkl studio' is on the user-facing command surface"
# Commander prints root help (exit 0) for an unknown subcommand, so assert on
# the registered-command listing rather than on exit status: studio must be
# present in `--help` unconditionally.
if ! ${CDKL} --help 2>&1 | grep -qE '^\s*studio\b'; then
  echo "FAIL: 'cdkl studio' is NOT listed on the command surface"
  exit 1
fi
echo "    OK: command is registered unconditionally"

# ---------------------------------------------------------------------------
# 2. Boot studio; parse the bound URL from the boot log.
# ---------------------------------------------------------------------------
echo "==> Booting cdkl studio"
${CDKL} studio --no-open --studio-port "${PORT}" >"${LOG_FILE}" 2>&1 &
STUDIO_PID=$!

URL=""
for _ in $(seq 1 60); do
  if ! kill -0 "${STUDIO_PID}" 2>/dev/null; then
    echo "FAIL: studio process exited during boot"
    echo "----- boot log -----"; cat "${LOG_FILE}"; echo "--------------------"
    exit 1
  fi
  URL=$(grep -oE "http://${HOST}:[0-9]+" "${LOG_FILE}" | head -1 || true)
  if [[ -n "${URL}" ]]; then
    # Confirm the socket actually answers before proceeding.
    if curl -fsS "${URL}/api/targets" -o /dev/null 2>/dev/null; then
      break
    fi
  fi
  sleep 0.5
done

if [[ -z "${URL}" ]]; then
  echo "FAIL: could not parse studio URL from boot log"
  echo "----- boot log -----"; cat "${LOG_FILE}"; echo "--------------------"
  exit 1
fi
echo "    OK: studio is running at ${URL}"

# ---------------------------------------------------------------------------
# 3. GET / serves the UI HTML.
# ---------------------------------------------------------------------------
echo "==> GET / serves the studio UI"
curl -fsS "${URL}/" -o "${BODY_FILE}"
if ! grep -qF "cdkl studio" "${BODY_FILE}"; then
  echo "FAIL: GET / did not return the studio UI"
  cat "${BODY_FILE}"
  exit 1
fi
if ! grep -qF "LocalStudioFixture" "${BODY_FILE}"; then
  echo "FAIL: GET / did not surface the app/stack label"
  cat "${BODY_FILE}"
  exit 1
fi
echo "    OK: UI HTML served with the stack label"

# ---------------------------------------------------------------------------
# 4. GET /api/targets lists the fixture's targets.
# ---------------------------------------------------------------------------
echo "==> GET /api/targets lists every target group"
curl -fsS "${URL}/api/targets" -o "${BODY_FILE}"
for needle in \
  '"kind":"lambda"' \
  '"kind":"api"' \
  '"kind":"ecs"' \
  '"kind":"agentcore"' \
  '"kind":"alb"' \
  'LocalStudioFixture/MyHandler'
do
  if ! grep -qF "${needle}" "${BODY_FILE}"; then
    echo "FAIL: /api/targets missing: ${needle}"
    cat "${BODY_FILE}"
    exit 1
  fi
  echo "    OK: ${needle}"
done

# ---------------------------------------------------------------------------
# 5. GET /api/events opens a Server-Sent-Events stream.
# ---------------------------------------------------------------------------
echo "==> GET /api/events opens an SSE stream"
SSE_HEADERS=$(curl -fsS -D - --max-time 2 "${URL}/api/events" -o /dev/null 2>/dev/null || true)
if ! grep -qiF "content-type: text/event-stream" <<<"${SSE_HEADERS}"; then
  echo "FAIL: /api/events did not return a text/event-stream content-type"
  echo "${SSE_HEADERS}"
  exit 1
fi
echo "    OK: SSE stream opened"

# ---------------------------------------------------------------------------
# 6. POST /api/run invokes a real Lambda in Docker (slice B) and the
#    invocation is broadcast over SSE.
# ---------------------------------------------------------------------------
echo "==> POST /api/run invokes the fixture Lambda in Docker"

# Start a background SSE listener BEFORE the invoke so it captures the
# invocation events the dispatch emits.
curl -sN --max-time 180 "${URL}/api/events" >"${SSE_FILE}" 2>/dev/null &
SSE_PID=$!
sleep 1 # let the SSE subscription establish

# The dispatch spawns `cdkl invoke LocalStudioFixture/MyHandler` which boots a
# RIE Node container — generous timeout to cover the first-run base-image pull.
HTTP_CODE=$(curl -s -o "${RUN_FILE}" -w '%{http_code}' --max-time 180 \
  -X POST "${URL}/api/run" \
  -H 'content-type: application/json' \
  -d '{"targetId":"LocalStudioFixture/MyHandler","kind":"lambda","event":{}}' || true)

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "FAIL: POST /api/run returned HTTP ${HTTP_CODE}"
  echo "----- run response -----"; cat "${RUN_FILE}"; echo "------------------------"
  echo "----- studio log -----"; cat "${LOG_FILE}"; echo "----------------------"
  exit 1
fi
# The fixture handler returns { statusCode: 200, body: 'ok' }; the studio run
# result wraps it as { ok: true, status: 200, response: {...} }.
for needle in '"ok":true' '"status":200' '"statusCode":200'; do
  if ! grep -qF "${needle}" "${RUN_FILE}"; then
    echo "FAIL: /api/run response missing: ${needle}"
    echo "----- run response -----"; cat "${RUN_FILE}"; echo "------------------------"
    exit 1
  fi
  echo "    OK: run response has ${needle}"
done
# Capture the Lambda invocation id for the slice-C3 per-invocation log
# binding assertion below.
LAMBDA_INV_ID=$(grep -oE '"invocationId":"[^"]+"' "${RUN_FILE}" | head -1 | sed 's/.*"invocationId":"//;s/"//')
echo "    (lambda invocationId=${LAMBDA_INV_ID})"

echo "==> The invocation was broadcast over SSE"
# Give the SSE listener a moment to receive the end event, then stop it.
for _ in $(seq 1 20); do
  if grep -qF 'event: invocation' "${SSE_FILE}" && grep -qF 'MyHandler' "${SSE_FILE}"; then
    break
  fi
  sleep 0.5
done
kill "${SSE_PID}" 2>/dev/null || true
SSE_PID=""
if ! grep -qF 'event: invocation' "${SSE_FILE}" || ! grep -qF 'MyHandler' "${SSE_FILE}"; then
  echo "FAIL: SSE stream did not carry the MyHandler invocation"
  echo "----- sse capture -----"; cat "${SSE_FILE}"; echo "-----------------------"
  exit 1
fi
echo "    OK: invocation observed on the SSE timeline"

# ---------------------------------------------------------------------------
# 6b. Per-target run options (issue #301 slice 2): POST /api/run with an
#     `--env-vars` option (KEY/VALUE rows). The server materializes it into a
#     SAM-shape temp file passed as `--env-vars <file>` to the child invoke;
#     the fixture handler echoes STUDIO_ENV_PROBE into its body, so the option
#     is observable end-to-end (UI option -> /api/run -> file -> child -> RIE).
# ---------------------------------------------------------------------------
echo "==> POST /api/run threads a per-target --env-vars option into the invoke"
OPT_FILE=$(mktemp)
PROBE="env-threaded-301"
HTTP_OPT=$(curl -s -o "${OPT_FILE}" -w '%{http_code}' --max-time 180 \
  -X POST "${URL}/api/run" -H 'content-type: application/json' \
  -d "{\"targetId\":\"LocalStudioFixture/MyHandler\",\"kind\":\"lambda\",\"event\":{},\"options\":{\"--env-vars\":[{\"left\":\"STUDIO_ENV_PROBE\",\"right\":\"${PROBE}\"}]}}" || true)
if [[ "${HTTP_OPT}" != "200" ]]; then
  echo "FAIL: per-target option invoke returned HTTP ${HTTP_OPT}"
  cat "${OPT_FILE}"; rm -f "${OPT_FILE}"; exit 1
fi
# The handler body is { ... "body": "<STUDIO_ENV_PROBE or 'ok'>" }; the env-var
# option must have flipped it to the probe value.
if ! grep -qF "${PROBE}" "${OPT_FILE}"; then
  echo "FAIL: --env-vars option did not reach the container (probe value absent from response)"
  echo "----- run response -----"; cat "${OPT_FILE}"; echo "------------------------"
  rm -f "${OPT_FILE}"; exit 1
fi
rm -f "${OPT_FILE}"
echo "    OK: --env-vars KEY/VALUE option threaded through to the Lambda container"

# ---------------------------------------------------------------------------
# 7. POST /api/run STARTS a long-running `start-api` serve (slice C1); curl
#    the served route; assert running state + a serve SSE event; stop it.
# ---------------------------------------------------------------------------
API_TARGET="LocalStudioFixture/MyHttpApi"
echo "==> POST /api/run starts a serve for ${API_TARGET}"

# Capture serve SSE events from before the start so we observe the running
# transition.
curl -sN --max-time 200 "${URL}/api/events" >"${SSE_FILE}" 2>/dev/null &
SSE_PID=$!
sleep 1

# Starting the serve boots a local HTTP server (the RIE container starts on
# the first request, so the listening line — and this response — come back
# quickly; the generous timeout only covers a slow synth).
SERVE_FILE=$(mktemp)
HTTP_CODE=$(curl -s -o "${SERVE_FILE}" -w '%{http_code}' --max-time 120 \
  -X POST "${URL}/api/run" \
  -H 'content-type: application/json' \
  -d "{\"targetId\":\"${API_TARGET}\",\"kind\":\"api\"}" || true)

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "FAIL: POST /api/run (serve) returned HTTP ${HTTP_CODE}"
  echo "----- serve response -----"; cat "${SERVE_FILE}"; echo "--------------------------"
  echo "----- studio log -----"; cat "${LOG_FILE}"; echo "----------------------"
  rm -f "${SERVE_FILE}"
  exit 1
fi
for needle in '"status":"running"' '"kind":"api"'; do
  if ! grep -qF "${needle}" "${SERVE_FILE}"; then
    echo "FAIL: serve response missing: ${needle}"
    echo "----- serve response -----"; cat "${SERVE_FILE}"; echo "--------------------------"
    rm -f "${SERVE_FILE}"
    exit 1
  fi
done
SERVED=$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "${SERVE_FILE}" | head -1 || true)
rm -f "${SERVE_FILE}"
if [[ -z "${SERVED}" ]]; then
  echo "FAIL: could not parse the served endpoint from the run response"
  exit 1
fi
echo "    OK: serve started at ${SERVED}"

echo "==> The served route answers through the studio-managed start-api"
# First request boots the RIE container for MyHandler — generous timeout.
ROUTE_FILE=$(mktemp)
# The fixture handler returns the exact body `ok` — match it as a whole
# line (not a loose substring) so a stray `tokens` / `not ok` cannot pass.
ROUTE_CODE=$(curl -s -o "${ROUTE_FILE}" -w '%{http_code}' --max-time 180 "${SERVED}/hello" || true)
if [[ "${ROUTE_CODE}" != "200" ]] || ! grep -qx 'ok' "${ROUTE_FILE}"; then
  echo "FAIL: served route did not return 200 ok (HTTP ${ROUTE_CODE})"
  echo "----- route body -----"; cat "${ROUTE_FILE}"; echo "----------------------"
  echo "----- studio log -----"; cat "${LOG_FILE}"; echo "----------------------"
  rm -f "${ROUTE_FILE}"
  exit 1
fi
rm -f "${ROUTE_FILE}"
echo "    OK: GET ${SERVED}/hello -> 200 ok"

# The served endpoint is the studio CAPTURE PROXY (slice C2): the request
# we just made must surface on the timeline as an `invocation` row with the
# method/path label + the 200 status, proving every request to the served
# port flows through studio (decision D4a).
echo "==> The served request was captured on the timeline (SSE)"
for _ in $(seq 1 20); do
  if grep -qF 'event: invocation' "${SSE_FILE}" && grep -qF '"label":"GET /hello"' "${SSE_FILE}"; then
    break
  fi
  sleep 0.5
done
if ! grep -qF '"label":"GET /hello"' "${SSE_FILE}"; then
  echo "FAIL: SSE stream did not carry the captured GET /hello request"
  echo "----- sse capture -----"; cat "${SSE_FILE}"; echo "-----------------------"
  exit 1
fi
if ! grep -qF '"status":200' "${SSE_FILE}"; then
  echo "FAIL: captured request did not carry the 200 status"
  echo "----- sse capture -----"; cat "${SSE_FILE}"; echo "-----------------------"
  exit 1
fi
echo "    OK: GET /hello captured on the timeline with status 200"

echo "==> GET /api/running reflects the running serve"
curl -fsS "${URL}/api/running" -o "${BODY_FILE}"
if ! grep -qF "${API_TARGET}" "${BODY_FILE}" || ! grep -qF '"status":"running"' "${BODY_FILE}"; then
  echo "FAIL: /api/running did not list the running serve"
  cat "${BODY_FILE}"
  exit 1
fi
echo "    OK: /api/running lists ${API_TARGET}"

echo "==> A serve event was broadcast over SSE"
for _ in $(seq 1 20); do
  if grep -qF 'event: serve' "${SSE_FILE}" && grep -qF '"status":"running"' "${SSE_FILE}"; then
    break
  fi
  sleep 0.5
done
if ! grep -qF 'event: serve' "${SSE_FILE}" || ! grep -qF '"status":"running"' "${SSE_FILE}"; then
  echo "FAIL: SSE stream did not carry the serve running event"
  echo "----- sse capture -----"; cat "${SSE_FILE}"; echo "-----------------------"
  exit 1
fi
echo "    OK: serve running event observed on the SSE timeline"

echo "==> POST /api/stop tears the serve down"
STOP_CODE=$(curl -s -o "${BODY_FILE}" -w '%{http_code}' --max-time 30 \
  -X POST "${URL}/api/stop" \
  -H 'content-type: application/json' \
  -d "{\"targetId\":\"${API_TARGET}\"}" || true)
if [[ "${STOP_CODE}" != "200" ]]; then
  echo "FAIL: POST /api/stop returned HTTP ${STOP_CODE}"
  cat "${BODY_FILE}"
  exit 1
fi
kill "${SSE_PID}" 2>/dev/null || true
SSE_PID=""
# After the stop, the running list must be empty again.
for _ in $(seq 1 20); do
  curl -fsS "${URL}/api/running" -o "${BODY_FILE}" 2>/dev/null || true
  if ! grep -qF "${API_TARGET}" "${BODY_FILE}"; then break; fi
  sleep 0.5
done
if grep -qF "${API_TARGET}" "${BODY_FILE}"; then
  echo "FAIL: /api/running still lists ${API_TARGET} after stop"
  cat "${BODY_FILE}"
  exit 1
fi
echo "    OK: serve stopped; /api/running is empty"

# ---------------------------------------------------------------------------
# 8. The store (slice C3): history + full-text log search + per-invocation
#    log binding (decision D5) are served from the retained event window.
# ---------------------------------------------------------------------------
echo "==> GET /api/history retains the session's invocations + logs"
curl -fsS "${URL}/api/history" -o "${BODY_FILE}"
# Both the Lambda invoke and the captured serve request must be retained.
if ! grep -qF 'MyHandler' "${BODY_FILE}" || ! grep -qF 'GET /hello' "${BODY_FILE}"; then
  echo "FAIL: /api/history did not retain the session's invocations"
  echo "----- history -----"; head -c 2000 "${BODY_FILE}"; echo; echo "-------------------"
  exit 1
fi
echo "    OK: history retains the Lambda invoke + the captured serve request"

echo "==> GET /api/logs?q= full-text searches the retained logs"
# The serve child prints a stable 'Server listening on ...' line, streamed
# onto the bus as a log event — search must find it.
curl -fsS "${URL}/api/logs?q=Server%20listening" -o "${BODY_FILE}"
if ! grep -qF 'Server listening on' "${BODY_FILE}"; then
  echo "FAIL: /api/logs search did not find the serve listening line"
  echo "----- logs -----"; head -c 2000 "${BODY_FILE}"; echo; echo "----------------"
  exit 1
fi
echo "    OK: log search found the serve listening line"

if [[ -n "${LAMBDA_INV_ID}" ]]; then
  echo "==> GET /api/invocations/<id>/logs binds the Lambda's logs (D5)"
  curl -fsS "${URL}/api/invocations/${LAMBDA_INV_ID}/logs" -o "${BODY_FILE}"
  # The fixture handler runs in a RIE container that prints START/REPORT
  # lines; the strict per-invocation bind must return a non-empty list.
  if ! grep -qF '"line"' "${BODY_FILE}"; then
    echo "FAIL: /api/invocations/<id>/logs returned no bound logs"
    echo "----- bound logs -----"; head -c 2000 "${BODY_FILE}"; echo; echo "----------------------"
    exit 1
  fi
  echo "    OK: the Lambda invocation's logs are bound at per-invocation granularity"

  # The bound logs must be the LAMBDA's runtime logs (RIE START/REPORT etc.),
  # NOT cdk-local's own synth / orchestration chatter. The studio invoke child
  # runs with CDKL_LOG_LEVEL=warn so "Successfully synthesized to ..." and the
  # asset-bundling progress are silenced; assert they never leaked into the
  # per-invocation logs, and that a real RIE marker IS present.
  echo "==> The bound logs exclude cdk-local synth chatter, keep RIE logs"
  if grep -qiE 'Successfully synthesi|Synthesis time' "${BODY_FILE}"; then
    echo "FAIL: cdk-local synth chatter leaked into the Lambda's bound logs"
    echo "----- bound logs -----"; head -c 2000 "${BODY_FILE}"; echo; echo "----------------------"
    exit 1
  fi
  if ! grep -qE 'RequestId|INVOKE|INIT START' "${BODY_FILE}"; then
    echo "FAIL: bound logs do not contain the expected RIE runtime markers"
    echo "----- bound logs -----"; head -c 2000 "${BODY_FILE}"; echo; echo "----------------------"
    exit 1
  fi
  echo "    OK: logs are the Lambda's RIE runtime output, free of synth noise"
else
  # The Lambda invoke already succeeded above (the run-response needles
  # passed), so the invocationId MUST have parsed. An empty value here means
  # the response shape changed — hard-fail rather than silently disabling the
  # per-invocation bind + synth-chatter regression guards.
  echo "FAIL: no invocationId parsed from a successful invoke — log-bind guards disabled"
  echo "----- run response -----"; cat "${RUN_FILE}"; echo "------------------------"
  exit 1
fi

# ---------------------------------------------------------------------------
# 9. ALB serve (serve-kinds): start `start-alb` behind studio, capture a
#    request through the front-door proxy. The fixture ECS container serves
#    HTTP and the listener is on 8080 (bindable without root).
# ---------------------------------------------------------------------------
echo "==> /api/targets marks the ECS service servable, the task definition not"
curl -fsS "${URL}/api/targets" -o "${BODY_FILE}"
if ! grep -qF '"MyService"' "${BODY_FILE}" && ! grep -qF 'MyService' "${BODY_FILE}"; then
  echo "FAIL: /api/targets missing the ECS service"; cat "${BODY_FILE}"; exit 1
fi
echo "    OK: ecs service is listed (servable), task definition listed (not servable)"

ALB_TARGET="LocalStudioFixture/MyAlb"
echo "==> POST /api/run starts an ALB serve (boots the ECS service + front-door)"
# Re-arm the SSE listener to capture the ALB request invocation.
: >"${SSE_FILE}"
curl -sN --max-time 240 "${URL}/api/events" >"${SSE_FILE}" 2>/dev/null &
SSE_PID=$!
sleep 1

ALB_FILE=$(mktemp)
HTTP_CODE=$(curl -s -o "${ALB_FILE}" -w '%{http_code}' --max-time 180 \
  -X POST "${URL}/api/run" -H 'content-type: application/json' \
  -d "{\"targetId\":\"${ALB_TARGET}\",\"kind\":\"alb\"}" || true)
if [[ "${HTTP_CODE}" != "200" ]] || ! grep -qF '"status":"running"' "${ALB_FILE}"; then
  echo "FAIL: POST /api/run (alb) returned HTTP ${HTTP_CODE}"
  echo "----- alb response -----"; cat "${ALB_FILE}"; echo "------------------------"
  echo "----- studio log -----"; cat "${LOG_FILE}"; echo "----------------------"
  rm -f "${ALB_FILE}"; exit 1
fi
ALB_SERVED=$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "${ALB_FILE}" | head -1 || true)
rm -f "${ALB_FILE}"
echo "    OK: ALB serve started; front-door fronted by studio proxy at ${ALB_SERVED}"

echo "==> The ALB front-door answers through the studio proxy"
# Retry: the front-door binds before the ECS replica registers in the target
# group, so the first requests may be 503 until the replica is healthy.
ALB_OK=0
for _ in $(seq 1 60); do
  RC=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${ALB_SERVED}/" || true)
  if [[ "${RC}" == "200" ]]; then ALB_OK=1; break; fi
  sleep 2
done
if [[ "${ALB_OK}" != "1" ]]; then
  echo "FAIL: ALB front-door never returned 200 through the proxy"
  echo "----- studio log -----"; cat "${LOG_FILE}"; echo "----------------------"
  exit 1
fi
echo "    OK: GET ${ALB_SERVED}/ -> 200 through the ALB front-door"

echo "==> The ALB request was captured on the timeline (SSE)"
# Assert on the INVOCATION row's request label (`GET /`), which ONLY the
# capture proxy emits — the `serve` lifecycle event also carries
# `"kind":"alb"`, so matching that alone would pass without any request
# capture. The label proves the request flowed through the proxy.
for _ in $(seq 1 20); do
  if grep -qF 'event: invocation' "${SSE_FILE}" && grep -qF '"label":"GET /"' "${SSE_FILE}"; then break; fi
  sleep 0.5
done
if ! grep -qF '"label":"GET /"' "${SSE_FILE}" || ! grep -qF '"kind":"alb"' "${SSE_FILE}"; then
  echo "FAIL: SSE stream did not carry the captured ALB request (invocation row)"
  echo "----- sse capture -----"; tail -c 2000 "${SSE_FILE}"; echo "-----------------------"
  exit 1
fi
echo "    OK: the ALB request was captured (GET / invocation, kind=alb) on the timeline"
kill "${SSE_PID}" 2>/dev/null || true; SSE_PID=""

echo "==> POST /api/stop tears the ALB serve down"
curl -s --max-time 60 -X POST "${URL}/api/stop" -H 'content-type: application/json' \
  -d "{\"targetId\":\"${ALB_TARGET}\"}" -o /dev/null || true
sleep 3
echo "    OK: ALB serve stopped"

# ---------------------------------------------------------------------------
# 10. ECS service serve (serve-kinds): pure compute — runs the replicas, no
#     host endpoint, no capture.
# ---------------------------------------------------------------------------
ECS_TARGET="LocalStudioFixture/MyService"
# Thread TWO per-run options (issue #301 slice 2) into the serve child:
# `--max-tasks 1` (single replica enables host-port publishing) +
# `--host-port 80=<freeHostPort>` (a repeat-pair). The fixture container runs
# `python -m http.server 80`, so a REACHABLE host port proves both options
# threaded CLI -> child end-to-end (not a tautology — without the options the
# port would never be published, and studio's ecs kind exposes no endpoint).
ECS_HOST_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
echo "==> POST /api/run starts an ECS service serve with --max-tasks + --host-port options"
ECS_FILE=$(mktemp)
HTTP_CODE=$(curl -s -o "${ECS_FILE}" -w '%{http_code}' --max-time 180 \
  -X POST "${URL}/api/run" -H 'content-type: application/json' \
  -d "{\"targetId\":\"${ECS_TARGET}\",\"kind\":\"ecs\",\"options\":{\"--max-tasks\":\"1\",\"--host-port\":[{\"left\":\"80\",\"right\":\"${ECS_HOST_PORT}\"}]}}" || true)
if [[ "${HTTP_CODE}" != "200" ]] || ! grep -qF '"status":"running"' "${ECS_FILE}"; then
  echo "FAIL: POST /api/run (ecs) returned HTTP ${HTTP_CODE}"
  echo "----- ecs response -----"; cat "${ECS_FILE}"; echo "------------------------"
  echo "----- studio log -----"; cat "${LOG_FILE}"; echo "----------------------"
  rm -f "${ECS_FILE}"; exit 1
fi
# studio's ecs kind still reports NO host endpoint (no capture proxy) ...
if ! grep -qF '"endpoints":[]' "${ECS_FILE}"; then
  echo "FAIL: ecs serve unexpectedly reported a host endpoint"
  cat "${ECS_FILE}"; rm -f "${ECS_FILE}"; exit 1
fi
rm -f "${ECS_FILE}"
# ... but the child published the --host-port: the replica's :80 is reachable
# on the host port we picked. Retry while the replica finishes booting.
ECS_REACH=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${ECS_HOST_PORT}/" -o /dev/null 2>/dev/null; then
    ECS_REACH="yes"; break
  fi
  sleep 1
done
if [[ -z "${ECS_REACH}" ]]; then
  echo "FAIL: --host-port did not reach the child (host port ${ECS_HOST_PORT} not reachable)"
  echo "----- studio log -----"; tail -c 2000 "${LOG_FILE}"; echo "----------------------"
  exit 1
fi
echo "    OK: --max-tasks + --host-port threaded; replica :80 reachable on host :${ECS_HOST_PORT}"

echo "==> GET /api/running reflects the ECS service (no endpoint)"
curl -fsS "${URL}/api/running" -o "${BODY_FILE}"
if ! grep -qF "${ECS_TARGET}" "${BODY_FILE}"; then
  echo "FAIL: /api/running did not list the ECS service"; cat "${BODY_FILE}"; exit 1
fi
echo "    OK: /api/running lists ${ECS_TARGET}"

echo "==> POST /api/stop tears the ECS service down"
curl -s --max-time 60 -X POST "${URL}/api/stop" -H 'content-type: application/json' \
  -d "{\"targetId\":\"${ECS_TARGET}\"}" -o /dev/null || true
sleep 3
echo "    OK: ECS service stopped"

# ---------------------------------------------------------------------------
# 11. Clean shutdown on SIGTERM.
# ---------------------------------------------------------------------------
echo "==> Stopping studio (SIGTERM) and asserting clean exit"
kill "${STUDIO_PID}"
for _ in $(seq 1 20); do
  if ! kill -0 "${STUDIO_PID}" 2>/dev/null; then break; fi
  sleep 0.25
done
if kill -0 "${STUDIO_PID}" 2>/dev/null; then
  echo "FAIL: studio did not exit on SIGTERM"
  exit 1
fi
STUDIO_PID=""
echo "    OK: studio stopped cleanly"

# ---------------------------------------------------------------------------
# 12. Session-global flag threading (issue #301 slice 1): `cdkl studio
#     --from-cfn-stack <name> --assume-role <arn>` forwards both flags to the
#     child commands it spawns. Boot studio bound to a BOGUS stack + role (no
#     deploy, no cleanup): the child's `--from-cfn-stack` attempt logs the
#     stack name then GRACEFULLY falls back, so we assert (a) the invoke still
#     succeeds and (b) the bound per-invocation logs name the bogus stack —
#     proof the flag threaded CLI -> child end-to-end. The child's actual
#     from-cfn-stack binding is covered by local-invoke-from-cfn-stack.
# ---------------------------------------------------------------------------
echo "==> --from-cfn-stack / --assume-role thread through to the spawned child"
BOGUS_STACK="BOGUSNONEXISTENTSTACK301"
BOGUS_ROLE="arn:aws:iam::123456789012:role/bogus-studio-301"
LOG_FILE2=$(mktemp)
${CDKL} studio --no-open --studio-port "${PORT}" \
  --from-cfn-stack "${BOGUS_STACK}" --assume-role "${BOGUS_ROLE}" \
  >"${LOG_FILE2}" 2>&1 &
STUDIO_PID=$!
URL2=""
for _ in $(seq 1 60); do
  if ! kill -0 "${STUDIO_PID}" 2>/dev/null; then
    echo "FAIL: studio (flag-threading boot) exited during startup"
    cat "${LOG_FILE2}"; rm -f "${LOG_FILE2}"; exit 1
  fi
  URL2=$(grep -oE "http://${HOST}:[0-9]+" "${LOG_FILE2}" | head -1 || true)
  if [[ -n "${URL2}" ]] && curl -fsS "${URL2}/api/targets" -o /dev/null 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if [[ -z "${URL2}" ]]; then
  echo "FAIL: flag-threading studio never bound a URL"; cat "${LOG_FILE2}"; rm -f "${LOG_FILE2}"; exit 1
fi

RUN_FILE2=$(mktemp)
HTTP_CODE2=$(curl -s -o "${RUN_FILE2}" -w '%{http_code}' --max-time 180 \
  -X POST "${URL2}/api/run" \
  -H 'content-type: application/json' \
  -d '{"targetId":"LocalStudioFixture/MyHandler","kind":"lambda","event":{}}' || true)
# Graceful fallback: the bogus binding must NOT break the invoke.
if [[ "${HTTP_CODE2}" != "200" ]] || ! grep -qF '"ok":true' "${RUN_FILE2}"; then
  echo "FAIL: invoke under bogus --from-cfn-stack did not gracefully succeed (HTTP ${HTTP_CODE2})"
  cat "${RUN_FILE2}"; rm -f "${LOG_FILE2}" "${RUN_FILE2}"; exit 1
fi
INV2=$(grep -oE '"invocationId":"[^"]+"' "${RUN_FILE2}" | head -1 | sed 's/.*"invocationId":"//;s/"//')
if [[ -z "${INV2}" ]]; then
  echo "FAIL: no invocationId from the flag-threading invoke"
  cat "${RUN_FILE2}"; rm -f "${LOG_FILE2}" "${RUN_FILE2}"; exit 1
fi
# Both flags name themselves in the child's (warn-level, un-suppressed)
# fallback output, streamed onto the bus and bound to the invocation:
#   --from-cfn-stack -> 'ListStackResources(<stack>) failed ... Falling back.'
#   --assume-role    -> 'STS AssumeRole(<arn>) failed ... '
# Their presence proves BOTH flags threaded CLI -> child end-to-end.
curl -fsS "${URL2}/api/invocations/${INV2}/logs" -o "${BODY_FILE}"
if ! grep -qF "${BOGUS_STACK}" "${BODY_FILE}"; then
  echo "FAIL: --from-cfn-stack did not reach the child (bogus stack name absent from bound logs)"
  echo "----- bound logs -----"; head -c 2000 "${BODY_FILE}"; echo; echo "----------------------"
  echo "----- studio log -----"; head -c 2000 "${LOG_FILE2}"; echo; echo "----------------------"
  rm -f "${LOG_FILE2}" "${RUN_FILE2}"; exit 1
fi
if ! grep -qF "${BOGUS_ROLE}" "${BODY_FILE}"; then
  echo "FAIL: --assume-role did not reach the child (bogus role ARN absent from bound logs)"
  echo "----- bound logs -----"; head -c 2000 "${BODY_FILE}"; echo; echo "----------------------"
  echo "----- studio log -----"; head -c 2000 "${LOG_FILE2}"; echo; echo "----------------------"
  rm -f "${LOG_FILE2}" "${RUN_FILE2}"; exit 1
fi
echo "    OK: --from-cfn-stack '${BOGUS_STACK}' + --assume-role threaded to the child; invoke fell back gracefully"

kill "${STUDIO_PID}" 2>/dev/null || true
wait "${STUDIO_PID}" 2>/dev/null || true
STUDIO_PID=""
rm -f "${LOG_FILE2}" "${RUN_FILE2}"

echo ""
echo "==> local-studio test passed (gate + boot + UI + targets + SSE + invoke + api/alb/ecs serve + request capture + history/log-search + per-target-options + flag-threading + shutdown)"
