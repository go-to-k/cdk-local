#!/usr/bin/env bash
# verify.sh — local-invoke Ruby integ test (issue #248)
#
# Unlike most integ tests this one is fully local: no AWS resources are
# deployed. The test exercises `cdkl invoke` end-to-end against
# Docker + the AWS Lambda Ruby base image, which bundles the Runtime
# Interface Emulator (RIE).
#
# Run via `/run-integ local-invoke-ruby` (recommended) or directly:
#
#     bash tests/integration/local-invoke-ruby/verify.sh
#
# Requires Docker. The script pulls the base image up front so the run
# is self-sufficient (no special-case skill change needed).

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/ruby:3.3"

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
# the evidence in the log. On the happy path it emits the last NON-BLANK line of
# stdout with stderr suppressed. That differs from the old shape only when stdout
# ends in blank lines: the old shape yielded an empty string there, this yields
# the last non-blank line.
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


# Test 1 — asset-backed Ruby Lambda echoes event + env var
echo "==> [1/4] Invoking EchoHandler with default empty event"
RESULT_1=$(capture ${CDKL} invoke CdkLocalInvokeRubyFixture/EchoHandler --no-pull)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -Eq '"greeting": *"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/4] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${CDKL_STDERR}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(capture ${CDKL} invoke CdkLocalInvokeRubyFixture/EchoHandler --event "${EVENT_FILE}" --no-pull)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -Eq '"key": *"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override
echo "==> [3/4] Invoking EchoHandler with --env-vars override"
ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${CDKL_STDERR}"' EXIT
# Use a wildcard Parameters block so the test doesn't break if the L1
# logical ID changes (mirrors the Python integ).
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(capture ${CDKL} invoke CdkLocalInvokeRubyFixture/EchoHandler --env-vars "${ENV_FILE}" --no-pull)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -Eq '"greeting": *"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — inline (Code.fromInline) Ruby Lambda
echo "==> [4/4] Invoking InlineHandler (Code.ZipFile)"
INLINE_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${INLINE_EVENT}" "${CDKL_STDERR}"' EXIT
echo '{"hi":"there"}' > "${INLINE_EVENT}"
RESULT_4=$(capture ${CDKL} invoke CdkLocalInvokeRubyFixture/InlineHandler --event "${INLINE_EVENT}" --no-pull)
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -Eq '"hi": *"there"' || {
  echo "FAIL: expected inlineEcho with hi=there, got: ${RESULT_4}"
  exit 1
}

echo ""
echo "==> All 4 local-invoke Ruby tests passed"
