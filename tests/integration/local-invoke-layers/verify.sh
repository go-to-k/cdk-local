#!/usr/bin/env bash
# verify.sh — local-invoke-layers integ test (PR 6 of #224, issue #232)
#
# Exercises Lambda Layers support in `cdkl invoke`. Fully local —
# no AWS resources are deployed. The fixture stack defines one Lambda
# attached to three LayerVersions; Docker bind-mounts each layer's
# unzipped asset directory at `/opt` (read-only) so the handler can
# `require()` modules that only live in the layers.
#
# Run via `/run-integ local-invoke-layers` (recommended) or directly:
#
#     bash tests/integration/local-invoke-layers/verify.sh
#
# Requires Docker. The script pulls the Node.js base image up front so
# the run is self-sufficient.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"

# --- capture (issue #577) --------------------------------------------------
# Under `set -euo pipefail` the shape
#     VAR=$(${CLI} invoke ... 2>/dev/null | tail -1)
# aborts the WHOLE script at the ASSIGNMENT when the CLI exits non-zero:
# pipefail fails the pipeline, the command substitution fails, and `set -e`
# kills the script BEFORE the grep, before the FAIL message, and before the
# stderr re-run each FAIL branch does for diagnosis. The operator is left
# with no response, no assertion and no stderr -- and for a *-from-cfn-stack
# fixture the EXIT trap then destroys the stack, taking the evidence too.
#
# `capture` runs the command with its exit status captured EXPLICITLY, so
# `set -e` never fires. On a non-zero exit it prints the status and the tail
# of the captured stderr, then still emits the (possibly empty) last stdout
# line, so the assertion runs, FAILS, and prints its own diagnostic -- with
# the evidence in the log. On the happy path it is byte-identical to the old
# shape: the last line of stdout, stderr suppressed.
CDKL_STDERR="$(mktemp)"
capture() {
  local out rc=0
  out="$("$@" 2>"${CDKL_STDERR}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] command exited ${rc}: $*" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "${CDKL_STDERR}" >&2
  fi
  printf '%s\n' "${out}" | tail -1
}
# Registered immediately: the first capture happens before the fixture's own
# first `trap 'rm -f ...' EXIT`, which would otherwise leave this file behind
# when a run fails on the very first step. Later traps replace this handler
# and already list "${CDKL_STDERR}" themselves.
trap 'rm -f "${CDKL_STDERR}"' EXIT

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi


# Test 1 — multi-layer mounting works: handler can require() modules
# from BOTH the greetings layers AND the counters layer at the same
# /opt mount point.
echo "==> [1/3] Invoking EchoHandler (default empty event)"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${CDKL_STDERR}"' EXIT
echo '{"name":"alice","n":7}' > "${EVENT_FILE}"
RESULT_1=$(capture ${CDKL} invoke CdkLocalInvokeLayersFixture/EchoHandler --event "${EVENT_FILE}" --no-pull)
echo "    response: ${RESULT_1}"

# 1a: counters layer — distinct module name, no path overlap.
echo "${RESULT_1}" | grep -q '"counterSource":"counters"' || {
  echo "FAIL: expected counterSource=counters (counters layer not mounted), got: ${RESULT_1}"
  exit 1
}
echo "${RESULT_1}" | grep -q '"counter":"count=7"' || {
  echo "FAIL: expected counter=count=7, got: ${RESULT_1}"
  exit 1
}

# 1b: greetings layer — last-wins. Both GreetingsA and GreetingsB
# install /opt/nodejs/node_modules/util-greetings/index.js; the
# template declares Layers in order [A, B, Counters], so B's index.js
# must overwrite A's. cdk-local merges the layer asset dirs into a single
# tmpdir on the host (cpSync recursive+force, in template order) and
# bind-mounts that at /opt — Docker rejects multiple -v ...:/opt:ro
# entries, so we cannot rely on overlay layering at the runtime.
echo "${RESULT_1}" | grep -q '"greetingSource":"greetings-b"' || {
  echo "FAIL: expected greetingSource=greetings-b (last-layer-wins), got: ${RESULT_1}"
  exit 1
}
echo "${RESULT_1}" | grep -q '"greeting":"from-layer-B:hello-alice"' || {
  echo "FAIL: expected greeting=from-layer-B:hello-alice, got: ${RESULT_1}"
  exit 1
}

# Test 2 — different event payload exercises the same warm code path
# end-to-end (sanity check that nothing was cached as constants).
echo "==> [2/3] Invoking with a different event payload"
EVENT2=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${EVENT2}" "${CDKL_STDERR}"' EXIT
echo '{"name":"bob","n":42}' > "${EVENT2}"
RESULT_2=$(capture ${CDKL} invoke CdkLocalInvokeLayersFixture/EchoHandler --event "${EVENT2}" --no-pull)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"greeting":"from-layer-B:hello-bob"' || {
  echo "FAIL: expected greeting=from-layer-B:hello-bob, got: ${RESULT_2}"
  exit 1
}
echo "${RESULT_2}" | grep -q '"counter":"count=42"' || {
  echo "FAIL: expected counter=count=42, got: ${RESULT_2}"
  exit 1
}

# Test 3 — startup banner mentions the 3 layer mounts. Combines
# stdout + stderr (cdk-local's `logger.info` writes to stdout via
# `console.info`; we just want to verify the layer-count line appears
# somewhere in the cdk-local output) so users know the layer wiring fired.
echo "==> [3/3] Verifying cdk-local logs the layer count"
LOG_OUTPUT=$(${CDKL} invoke CdkLocalInvokeLayersFixture/EchoHandler --event "${EVENT_FILE}" --no-pull 2>&1)
echo "${LOG_OUTPUT}" | grep -q 'Mounting 3 Lambda layers at /opt' || {
  echo "FAIL: expected 'Mounting 3 Lambda layers' message in cdk-local output, got:"
  echo "${LOG_OUTPUT}"
  exit 1
}

echo ""
echo "==> All 3 local-invoke-layers tests passed"
