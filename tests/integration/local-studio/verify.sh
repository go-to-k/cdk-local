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
#   - boots `cdkl studio` behind the CDKL_STUDIO_PREVIEW gate,
#   - asserts the UI HTML is served at GET /,
#   - asserts GET /api/targets lists the fixture's targets,
#   - asserts GET /api/events opens a text/event-stream (SSE),
#   - asserts the command is HIDDEN without the preview env gate, and
#   - tears the server down cleanly.
#
# No Docker required — Phase 1 is a pure synth + HTTP read. (The invoke /
# serve slices add Docker-backed timeline coverage.)
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
STUDIO_PID=""
cleanup() {
  if [[ -n "${STUDIO_PID}" ]] && kill -0 "${STUDIO_PID}" 2>/dev/null; then
    kill "${STUDIO_PID}" 2>/dev/null || true
    wait "${STUDIO_PID}" 2>/dev/null || true
  fi
  rm -f "${LOG_FILE}" "${BODY_FILE}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. The command must be HIDDEN without the preview gate (no half-finished
#    command shipping enabled).
# ---------------------------------------------------------------------------
echo "==> Asserting 'cdkl studio' is hidden without CDKL_STUDIO_PREVIEW"
# Commander prints root help (exit 0) for an unknown subcommand, so assert on
# the registered-command listing rather than on exit status: studio must be
# absent from `--help` without the gate and present with it.
if ${CDKL} --help 2>&1 | grep -qE '^\s*studio\b'; then
  echo "FAIL: 'cdkl studio' is listed without CDKL_STUDIO_PREVIEW=1"
  exit 1
fi
if ! CDKL_STUDIO_PREVIEW=1 ${CDKL} --help 2>&1 | grep -qE '^\s*studio\b'; then
  echo "FAIL: 'cdkl studio' is NOT listed even with CDKL_STUDIO_PREVIEW=1"
  exit 1
fi
echo "    OK: command is gated off by default, on under the preview flag"

# ---------------------------------------------------------------------------
# 2. Boot studio behind the gate; parse the bound URL from the boot log.
# ---------------------------------------------------------------------------
echo "==> Booting cdkl studio (preview gate on)"
CDKL_STUDIO_PREVIEW=1 ${CDKL} studio --no-open --studio-port "${PORT}" >"${LOG_FILE}" 2>&1 &
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
# 6. Clean shutdown on SIGTERM.
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

echo ""
echo "==> local-studio test passed (gate + boot + UI + targets + SSE + shutdown)"
