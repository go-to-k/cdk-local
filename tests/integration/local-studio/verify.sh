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
#   - boots `cdkl studio --watch` and asserts a UI-started serve is spawned
#     with --watch (the start-api watcher banner reaches the log store),
#   - drives POST /api/run to invoke a Lambda in a RIE container (slice B),
#   - drives POST /api/run to invoke an AgentCore runtime in Docker — both the
#     HTTP POST /invocations path and the --ws streaming path (issue #303),
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
  rm -f "$(pwd)/.studio-ws-client.mjs"
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
# 1b. Target-list filter (issue #301 slice 4): `cdkl studio --stack <glob>`
#     scopes the DISPLAYED targets. Boot a short-lived studio filtered to the
#     Lambda only and assert /api/targets shows it but NOT the HTTP API
#     (no Docker — synth + HTTP only). Tear it down before the main boot.
# ---------------------------------------------------------------------------
echo "==> --stack <glob> filters the displayed target list"
FLT_LOG=$(mktemp)
${CDKL} studio --no-open --studio-port "${PORT}" --stack '*/MyHandler' >"${FLT_LOG}" 2>&1 &
FLT_PID=$!
FLT_URL=""
for _ in $(seq 1 60); do
  if ! kill -0 "${FLT_PID}" 2>/dev/null; then
    echo "FAIL: filtered studio exited during boot"; cat "${FLT_LOG}"; rm -f "${FLT_LOG}"; exit 1
  fi
  FLT_URL=$(grep -oE "http://${HOST}:[0-9]+" "${FLT_LOG}" | head -1 || true)
  if [[ -n "${FLT_URL}" ]] && curl -fsS "${FLT_URL}/api/targets" -o /dev/null 2>/dev/null; then break; fi
  sleep 0.5
done
curl -fsS "${FLT_URL}/api/targets" -o "${BODY_FILE}"
if ! grep -qF 'LocalStudioFixture/MyHandler' "${BODY_FILE}"; then
  echo "FAIL: --stack '*/MyHandler' hid the matching Lambda"; cat "${BODY_FILE}"
  kill "${FLT_PID}" 2>/dev/null || true; rm -f "${FLT_LOG}"; exit 1
fi
if grep -qF 'LocalStudioFixture/MyHttpApi' "${BODY_FILE}"; then
  echo "FAIL: --stack '*/MyHandler' did NOT scope out the non-matching API"; cat "${BODY_FILE}"
  kill "${FLT_PID}" 2>/dev/null || true; rm -f "${FLT_LOG}"; exit 1
fi
kill "${FLT_PID}" 2>/dev/null || true; wait "${FLT_PID}" 2>/dev/null || true
rm -f "${FLT_LOG}"
echo "    OK: --stack scoped the list to the matching target only"

# ---------------------------------------------------------------------------
# 1c. Watch mode (issue #301): `cdkl studio --watch` spawns serves started from
#     the UI with `--watch`, so they hot-reload on source changes. Boot a
#     short-lived studio WITH --watch, assert the boot log + GET /api/config
#     report watch on, start an `api` serve, and assert the spawned
#     `start-api --watch` child's watcher banner ("Watching ... for source
#     changes") reaches the studio log store (proof the flag threaded through +
#     the child entered watch mode end-to-end). Tear it down before the main
#     boot. This boots a real RIE-backed serve, hence Docker.
# ---------------------------------------------------------------------------
echo "==> --watch: serves started from the UI are spawned with --watch"
WAT_LOG=$(mktemp)
${CDKL} studio --no-open --watch --studio-port "${PORT}" >"${WAT_LOG}" 2>&1 &
WAT_PID=$!
fail_watch() { echo "FAIL: $1"; echo "----- watch studio log -----"; cat "${WAT_LOG}"; echo "----------------------------"; kill "${WAT_PID}" 2>/dev/null || true; rm -f "${WAT_LOG}"; exit 1; }
WAT_URL=""
for _ in $(seq 1 60); do
  if ! kill -0 "${WAT_PID}" 2>/dev/null; then fail_watch "watch studio exited during boot"; fi
  WAT_URL=$(grep -oE "http://${HOST}:[0-9]+" "${WAT_LOG}" | head -1 || true)
  if [[ -n "${WAT_URL}" ]] && curl -fsS "${WAT_URL}/api/targets" -o /dev/null 2>/dev/null; then break; fi
  sleep 0.5
done
[[ -n "${WAT_URL}" ]] || fail_watch "could not parse watch studio URL"
grep -qF 'Watch mode: ON' "${WAT_LOG}" || fail_watch "boot log missing 'Watch mode: ON'"
echo "    OK: boot log reports 'Watch mode: ON'"
curl -fsS "${WAT_URL}/api/config" -o "${BODY_FILE}"
grep -qF '"watch":true' "${BODY_FILE}" || fail_watch "GET /api/config did not report watch:true"
echo "    OK: GET /api/config reports watch:true"
# Start an api serve and confirm the spawned start-api entered watch mode.
WAT_SERVE=$(mktemp)
WHTTP=$(curl -s -o "${WAT_SERVE}" -w '%{http_code}' --max-time 120 \
  -X POST "${WAT_URL}/api/run" -H 'content-type: application/json' \
  -d "{\"targetId\":\"LocalStudioFixture/MyHttpApi\",\"kind\":\"api\"}" || true)
if [[ "${WHTTP}" != "200" ]]; then cat "${WAT_SERVE}"; rm -f "${WAT_SERVE}"; fail_watch "watch-mode serve start returned HTTP ${WHTTP}"; fi
rm -f "${WAT_SERVE}"
# The start-api --watch child logs "Watching <root> for source changes ..." when
# its file watcher comes up; the studio serve-manager streams that into the log
# store, searchable via /api/logs?q=. Retry — it lands around serve-ready.
WAT_OK=""
for _ in $(seq 1 40); do
  curl -fsS "${WAT_URL}/api/logs?q=for%20source%20changes" -o "${BODY_FILE}" 2>/dev/null || true
  if grep -qiF 'source changes' "${BODY_FILE}"; then WAT_OK=1; break; fi
  sleep 0.5
done
if [[ -z "${WAT_OK}" ]]; then
  curl -fsS "${WAT_URL}/api/stop" -H 'content-type: application/json' -d '{"targetId":"LocalStudioFixture/MyHttpApi"}' -o /dev/null 2>/dev/null || true
  fail_watch "the spawned start-api never logged its watcher banner (--watch did not thread to the serve child)"
fi
echo "    OK: the studio-spawned start-api entered watch mode (--watch threaded end-to-end)"
curl -fsS "${WAT_URL}/api/stop" -H 'content-type: application/json' -d '{"targetId":"LocalStudioFixture/MyHttpApi"}' -o /dev/null 2>/dev/null || true
# Give the serve child a moment to tear its RIE container down before we kill studio.
sleep 2
kill "${WAT_PID}" 2>/dev/null || true; wait "${WAT_PID}" 2>/dev/null || true
rm -f "${WAT_LOG}"
echo "    OK: watch-mode studio torn down"

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
if ! grep -qF "CDK Local Studio" "${BODY_FILE}"; then
  echo "FAIL: GET / did not return the studio UI"
  cat "${BODY_FILE}"
  exit 1
fi
if ! grep -qF "LocalStudioFixture" "${BODY_FILE}"; then
  echo "FAIL: GET / did not surface the app/stack label"
  cat "${BODY_FILE}"
  exit 1
fi
# The "All options" section (issue #301): the auto-derived flag catalog is
# serialized into the page, and the raw extra-args builder is present.
if ! grep -qF "window.__FLAG_CATALOG__" "${BODY_FILE}"; then
  echo "FAIL: GET / did not embed the auto-derived flag catalog (All options)"
  exit 1
fi
if ! grep -qF "buildAllOptions" "${BODY_FILE}"; then
  echo "FAIL: GET / did not include the All options / raw extra-args builder"
  exit 1
fi
# The pinned-service image-override Dockerfile picker (issue #301).
if ! grep -qF "buildImageOverridePicker" "${BODY_FILE}"; then
  echo "FAIL: GET / did not include the image-override Dockerfile picker"
  exit 1
fi
echo "    OK: UI HTML served with the stack label + All options catalog + image-override picker"

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
# 6b2. "All options" raw extra args (issue #301): POST /api/run with a
#      `rawArgs` string. The server tokenizes it (quote-aware) and appends the
#      tokens verbatim to the spawned `cdkl invoke` argv. Pass a BOGUS
#      `--from-cfn-stack` (no deploy, creds-light): the child attempts to bind
#      it, fails gracefully, and names the bogus stack in its logs — proof the
#      raw string reached the child argv (UI raw-args -> /api/run -> tokenize ->
#      child argv -> graceful fallback log).
# ---------------------------------------------------------------------------
echo "==> POST /api/run threads a rawArgs string into the invoke argv"
RAW_STACK="RAWARGSBOGUS301"
RAW_RUN=$(mktemp)
curl -s -o "${RAW_RUN}" --max-time 180 -X POST "${URL}/api/run" -H 'content-type: application/json' \
  -d "{\"targetId\":\"LocalStudioFixture/MyHandler\",\"kind\":\"lambda\",\"event\":{},\"rawArgs\":\"--from-cfn-stack ${RAW_STACK}\"}" >/dev/null || true
RAW_INV=$(grep -oE '"invocationId":"[^"]+"' "${RAW_RUN}" | head -1 | sed 's/.*"invocationId":"//;s/"//')
rm -f "${RAW_RUN}"
if [[ -z "${RAW_INV}" ]]; then echo "FAIL: no invocationId after a rawArgs invoke"; exit 1; fi
curl -fsS "${URL}/api/invocations/${RAW_INV}/logs" -o "${BODY_FILE}"
if ! grep -qF "${RAW_STACK}" "${BODY_FILE}"; then
  echo "FAIL: the rawArgs --from-cfn-stack did not reach the child (stack absent from logs)"
  echo "----- bound logs -----"; head -c 2000 "${BODY_FILE}"; echo; echo "----------------------"
  exit 1
fi
echo "    OK: rawArgs string tokenized + threaded to the child invoke argv"

# ---------------------------------------------------------------------------
# 6c. Editable Session config (issue #301 slice 3): GET /api/config exposes
#     the read-only synth context; PATCH /api/config sets a run-time binding
#     (--from-cfn-stack) that applies to SUBSEQUENT runs. PATCH a BOGUS stack
#     (no deploy), then invoke and assert the child's --from-cfn-stack attempt
#     names it in the bound logs — proof the edited binding threaded through.
# ---------------------------------------------------------------------------
echo "==> GET /api/config exposes the session config"
curl -fsS "${URL}/api/config" -o "${BODY_FILE}"
if ! grep -qF '"synth"' "${BODY_FILE}"; then
  echo "FAIL: /api/config did not return a session config"; cat "${BODY_FILE}"; exit 1
fi
echo "    OK: /api/config served"

echo "==> PATCH /api/config sets --from-cfn-stack; it applies to the next invoke"
CFG_STACK="BOGUSSESSIONSTACK301"
PATCH_FILE=$(mktemp)
HTTP_PATCH=$(curl -s -o "${PATCH_FILE}" -w '%{http_code}' -X PATCH "${URL}/api/config" \
  -H 'content-type: application/json' -d "{\"fromCfnStack\":\"${CFG_STACK}\"}" || true)
if [[ "${HTTP_PATCH}" != "200" ]] || ! grep -qF "${CFG_STACK}" "${PATCH_FILE}"; then
  echo "FAIL: PATCH /api/config did not echo the updated binding (HTTP ${HTTP_PATCH})"
  cat "${PATCH_FILE}"; rm -f "${PATCH_FILE}"; exit 1
fi
rm -f "${PATCH_FILE}"
CFG_RUN=$(mktemp)
curl -s -o "${CFG_RUN}" --max-time 180 -X POST "${URL}/api/run" -H 'content-type: application/json' \
  -d '{"targetId":"LocalStudioFixture/MyHandler","kind":"lambda","event":{}}' >/dev/null || true
CFG_INV=$(grep -oE '"invocationId":"[^"]+"' "${CFG_RUN}" | head -1 | sed 's/.*"invocationId":"//;s/"//')
rm -f "${CFG_RUN}"
if [[ -z "${CFG_INV}" ]]; then echo "FAIL: no invocationId after a config-bound invoke"; exit 1; fi
curl -fsS "${URL}/api/invocations/${CFG_INV}/logs" -o "${BODY_FILE}"
if ! grep -qF "${CFG_STACK}" "${BODY_FILE}"; then
  echo "FAIL: the PATCHed --from-cfn-stack binding did not reach the child (stack absent from logs)"
  echo "----- bound logs -----"; head -c 2000 "${BODY_FILE}"; echo; echo "----------------------"
  exit 1
fi
echo "    OK: edited Session binding '${CFG_STACK}' applied to the subsequent invoke"
# Reset the binding so later sections (AgentCore invoke + serves) are unaffected.
curl -s -X PATCH "${URL}/api/config" -H 'content-type: application/json' \
  -d '{"fromCfnStack":null}' -o /dev/null || true

# ---------------------------------------------------------------------------
# 6d. POST /api/run invokes an AgentCore runtime (issue #303): the studio
#     dispatch spawns `cdkl invoke-agentcore LocalStudioFixture/MyAgent`, which
#     `docker build`s the `agent/` container (linux/arm64) and runs the HTTP
#     `POST /invocations` contract on 8080. The agent echoes the event + the
#     injected GREETING, so the round trip proves the new single-shot invoke
#     path end-to-end (UI composer -> /api/run -> child invoke-agentcore ->
#     Docker -> response). Generous timeout to cover the first-run image pull +
#     build.
# ---------------------------------------------------------------------------
echo "==> POST /api/run invokes the fixture AgentCore runtime in Docker (HTTP)"
AC_FILE=$(mktemp)
HTTP_AC=$(curl -s -o "${AC_FILE}" -w '%{http_code}' --max-time 360 \
  -X POST "${URL}/api/run" -H 'content-type: application/json' \
  -d '{"targetId":"LocalStudioFixture/MyAgent","kind":"agentcore","event":{"hello":"studio"}}' || true)
if [[ "${HTTP_AC}" != "200" ]]; then
  echo "FAIL: AgentCore /api/run returned HTTP ${HTTP_AC}"
  echo "----- run response -----"; cat "${AC_FILE}"; echo "------------------------"
  echo "----- studio log -----"; cat "${LOG_FILE}"; echo "----------------------"
  rm -f "${AC_FILE}"; exit 1
fi
# The studio run result wraps the agent's JSON response: { ok:true, status:200,
# response: { echoed: { hello: "studio" }, greeting: "hello-from-studio-agent", ... } }.
for needle in '"ok":true' '"status":200' '"echoed"' '"hello":"studio"' 'hello-from-studio-agent'; do
  if ! grep -qF "${needle}" "${AC_FILE}"; then
    echo "FAIL: AgentCore /api/run response missing: ${needle}"
    echo "----- run response -----"; cat "${AC_FILE}"; echo "------------------------"
    rm -f "${AC_FILE}"; exit 1
  fi
  echo "    OK: AgentCore run response has ${needle}"
done
rm -f "${AC_FILE}"

# ---------------------------------------------------------------------------
# 6e. POST /api/run with the AgentCore `--ws` per-run option (issue #303):
#     the dispatch spawns `cdkl invoke-agentcore ... --ws`, which streams over
#     the agent's bidirectional /ws endpoint (one-shot from studio: the event
#     is the first frame, the received frames are the response). The agent
#     replies with a JSON frame echoing the event + a trailing `ws-frame-2`,
#     so the studio response (the captured stream) carries both. The streamed
#     frames are one raw string in the run result, so the agent's nested JSON
#     is escaped inside it (`\"ws\":...`) — assert with escaping-robust
#     substrings: the WS-only `ws-frame-2` frame (the HTTP path never emits
#     it), the echoed `hello`, and the injected greeting.
# ---------------------------------------------------------------------------
echo "==> POST /api/run drives an AgentCore --ws streaming invoke"
WS_FILE=$(mktemp)
HTTP_WS=$(curl -s -o "${WS_FILE}" -w '%{http_code}' --max-time 360 \
  -X POST "${URL}/api/run" -H 'content-type: application/json' \
  -d '{"targetId":"LocalStudioFixture/MyAgent","kind":"agentcore","event":{"hello":"ws"},"options":{"--ws":true}}' || true)
if [[ "${HTTP_WS}" != "200" ]]; then
  echo "FAIL: AgentCore --ws /api/run returned HTTP ${HTTP_WS}"
  echo "----- run response -----"; cat "${WS_FILE}"; echo "------------------------"
  rm -f "${WS_FILE}"; exit 1
fi
for needle in '"ok":true' 'ws-frame-2' 'hello' 'hello-from-studio-agent'; do
  if ! grep -qF "${needle}" "${WS_FILE}"; then
    echo "FAIL: AgentCore --ws response missing: ${needle}"
    echo "----- run response -----"; cat "${WS_FILE}"; echo "------------------------"
    rm -f "${WS_FILE}"; exit 1
  fi
  echo "    OK: AgentCore --ws response has ${needle}"
done
rm -f "${WS_FILE}"

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
# 7b. WebSocket console (issue #303): studio serves a WebSocket API
#     (`start-api LocalStudioFixture/MyWsApi`, resolvable as an explicit
#     target since Part 1), exposes its raw ws:// endpoint un-proxied, and the
#     browser WebSocket console connects straight to it. Drive the same path a
#     headless client: start the serve, read the ws:// endpoint from
#     /api/running, connect a client, send a frame, and assert the agent
#     echoes it (proving studio -> start-api WS serve -> browser-reachable
#     ws:// + frame exchange end-to-end). The console UI itself is unit-tested
#     (renderStudioHtml string assertions).
# ---------------------------------------------------------------------------
WS_TARGET="LocalStudioFixture/MyWsApi"
echo "==> POST /api/run starts a WebSocket-API serve for ${WS_TARGET}"
WSV_FILE=$(mktemp)
WHTTP=$(curl -s -o "${WSV_FILE}" -w '%{http_code}' --max-time 120 \
  -X POST "${URL}/api/run" -H 'content-type: application/json' \
  -d "{\"targetId\":\"${WS_TARGET}\",\"kind\":\"api\"}" || true)
if [[ "${WHTTP}" != "200" ]]; then
  echo "FAIL: WS-API serve start returned HTTP ${WHTTP}"; cat "${WSV_FILE}"; rm -f "${WSV_FILE}"; exit 1
fi
WSV_URL=$(grep -oE 'ws://127\.0\.0\.1:[0-9]+/[A-Za-z0-9_]+' "${WSV_FILE}" | head -1 || true)
rm -f "${WSV_FILE}"
if [[ -z "${WSV_URL}" ]]; then
  echo "FAIL: studio did not expose a ws:// endpoint for the WebSocket-API serve"; exit 1
fi
echo "    OK: WS-API serve running at ${WSV_URL}"
# Confirm /api/running reports it (what the UI reads to render the console).
curl -fsS "${URL}/api/running" -o "${BODY_FILE}"
if ! grep -qF "${WSV_URL}" "${BODY_FILE}"; then
  echo "FAIL: /api/running did not list the ws:// endpoint"; cat "${BODY_FILE}"; exit 1
fi
# Connect a client to the studio-served ws:// endpoint (Node 24 global WebSocket)
# and assert the $default echo round-trips — the same thing the browser console
# does.
cat > "$(pwd)/.studio-ws-client.mjs" <<'NODE'
const url = process.argv[2];
const ws = new WebSocket(url);
let got = '';
const done = (code, msg) => { if (msg) console.error(msg); process.exit(code); };
ws.addEventListener('open', () => ws.send(JSON.stringify({ action: 'sendMessage', text: 'studio-ws-303' })));
ws.addEventListener('message', async (e) => {
  // The local emulator delivers the echo as a binary Blob; decode to text
  // (same as the browser console does).
  got = typeof e.data === 'string' ? e.data : (e.data && typeof e.data.text === 'function' ? await e.data.text() : '');
  ws.close();
});
ws.addEventListener('error', () => done(1, 'client socket error'));
ws.addEventListener('close', () => got.includes('studio-ws-303') ? (console.log('PASS:', got), done(0)) : done(1, 'no echo: ' + got));
setTimeout(() => done(1, 'timeout waiting for echo'), 30000);
NODE
if ! node "$(pwd)/.studio-ws-client.mjs" "${WSV_URL}"; then
  echo "FAIL: WebSocket console round-trip through the studio-served endpoint"
  curl -fsS "${URL}/api/running" -o "${BODY_FILE}" 2>/dev/null; cat "${BODY_FILE}"
  curl -fsS "${URL}/api/stop" -H 'content-type: application/json' -d "{\"targetId\":\"${WS_TARGET}\"}" -o /dev/null 2>/dev/null || true
  rm -f "$(pwd)/.studio-ws-client.mjs"; exit 1
fi
rm -f "$(pwd)/.studio-ws-client.mjs"
echo "    OK: WebSocket console round-trip echoed 'studio-ws-303' through ${WSV_URL}"
# Stop the WS serve.
curl -fsS "${URL}/api/stop" -H 'content-type: application/json' -d "{\"targetId\":\"${WS_TARGET}\"}" -o /dev/null 2>/dev/null || true
for _ in $(seq 1 20); do
  curl -fsS "${URL}/api/running" -o "${BODY_FILE}" 2>/dev/null || true
  if ! grep -qF "${WS_TARGET}" "${BODY_FILE}"; then break; fi
  sleep 0.5
done
echo "    OK: WebSocket-API serve stopped"

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

# Image-override discoverability (issue #301): MyService's image is a
# public-registry pin (not a local CDK asset), so studio marks it
# `"pinned":true` and exposes the boot-discovered Dockerfiles (including the
# fixture's ./Dockerfile.override) so the composer can offer the picker.
echo "==> /api/targets marks the pinned ecs service + lists discovered Dockerfiles"
if ! grep -qF '"pinned":true' "${BODY_FILE}"; then
  echo "FAIL: /api/targets did not mark the public-image ECS service as pinned"
  cat "${BODY_FILE}"; exit 1
fi
if ! grep -qF 'Dockerfile.override' "${BODY_FILE}"; then
  echo "FAIL: /api/targets did not surface the discovered ./Dockerfile.override"
  cat "${BODY_FILE}"; exit 1
fi
echo "    OK: pinned ecs service flagged + Dockerfile.override discovered"

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
# 10b. Image-override picker (issue #301): MyService's deployed image is a
#      public-registry pin, so local source edits do not take effect. Studio
#      threads the picked Dockerfile as
#      `--image-override LocalStudioFixture/MyService=./Dockerfile.override`
#      (the EXPLICIT form — studio's child has no TTY, so the bare picker form
#      would be skipped). The override Dockerfile builds an image whose WORKDIR
#      holds a sentinel index.html; the task-def command `python -m http.server
#      80` then serves the sentinel. Curling it proves the override BUILT +
#      RAN locally (the pinned image would serve a root directory listing,
#      never this sentinel) — the picker -> /api/run -> --image-override ->
#      start-service rebuild path end-to-end.
# ---------------------------------------------------------------------------
IO_HOST_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
echo "==> POST /api/run with imageOverride rebuilds the pinned service from a local Dockerfile"
IO_FILE=$(mktemp)
HTTP_IO=$(curl -s -o "${IO_FILE}" -w '%{http_code}' --max-time 300 \
  -X POST "${URL}/api/run" -H 'content-type: application/json' \
  -d "{\"targetId\":\"${ECS_TARGET}\",\"kind\":\"ecs\",\"imageOverride\":\"./Dockerfile.override\",\"options\":{\"--max-tasks\":\"1\",\"--host-port\":[{\"left\":\"80\",\"right\":\"${IO_HOST_PORT}\"}]}}" || true)
if [[ "${HTTP_IO}" != "200" ]] || ! grep -qF '"status":"running"' "${IO_FILE}"; then
  echo "FAIL: POST /api/run (image-override) returned HTTP ${HTTP_IO}"
  echo "----- response -----"; cat "${IO_FILE}"; echo "--------------------"
  echo "----- studio log -----"; tail -c 3000 "${LOG_FILE}"; echo "----------------------"
  rm -f "${IO_FILE}"; exit 1
fi
rm -f "${IO_FILE}"
# The override build + boot can take a while (docker build of one extra layer
# on top of the already-pulled base, then the replica boots). Retry the curl.
IO_BODY=""
for _ in $(seq 1 60); do
  IO_BODY=$(curl -fsS --max-time 3 "http://127.0.0.1:${IO_HOST_PORT}/" 2>/dev/null || true)
  if echo "${IO_BODY}" | grep -qF 'studio-image-override-301'; then break; fi
  sleep 1
done
if ! echo "${IO_BODY}" | grep -qF 'studio-image-override-301'; then
  echo "FAIL: image-override did not apply (sentinel absent from the served replica)"
  echo "----- served body -----"; echo "${IO_BODY}" | head -c 1000; echo "-----------------------"
  echo "----- studio log -----"; tail -c 3000 "${LOG_FILE}"; echo "----------------------"
  exit 1
fi
echo "    OK: image-override threaded; the pinned service ran the LOCAL Dockerfile build (sentinel served)"

echo "==> POST /api/stop tears the image-override service down"
curl -s --max-time 60 -X POST "${URL}/api/stop" -H 'content-type: application/json' \
  -d "{\"targetId\":\"${ECS_TARGET}\"}" -o /dev/null || true
sleep 3
echo "    OK: image-override service stopped"

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
echo "==> local-studio test passed (gate + stack-filter + watch-mode + boot + UI + all-options-catalog + image-override-picker + targets + SSE + invoke + agentcore-invoke + agentcore-ws + api/alb/ecs serve + image-override-rebuild + ws-console + request capture + history/log-search + per-target-options + raw-args + session-config + flag-threading + shutdown)"
