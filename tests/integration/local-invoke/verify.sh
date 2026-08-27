#!/usr/bin/env bash
# verify.sh — local-invoke integ test
#
# Unlike most integ tests this one is fully local: no AWS resources are
# deployed. The test exercises `cdkl invoke` end-to-end against
# Docker + the AWS Lambda Node.js base image, which bundles the Runtime
# Interface Emulator (RIE).
#
# Run via `/run-integ local-invoke` (recommended) or directly:
#
#     bash tests/integration/local-invoke/verify.sh
#
# Requires Docker. The script pulls the base image up front so the run
# is self-sufficient (no special-case skill change needed).

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

# Build the ZIP-FILE asset for ZipAssetHandler from the same handler source.
# `Code.fromAsset('zip-lambda.zip')` keeps it zipped, so synth emits
# `asset.<hash>.zip` and `aws:asset:path` points at the zip FILE — the case
# `cdkl invoke` must extract before bind-mounting. Built here (gitignored, not
# committed) so it stays a generated artifact.
echo "==> Building zip-lambda.zip (ZIP-FILE asset for ZipAssetHandler)"
rm -f zip-lambda.zip
( cd lambda && zip -q ../zip-lambda.zip index.js )


# Test 1 — asset-backed Lambda echoes event + env var
echo "==> [1/6] Invoking EchoHandler with default empty event"
RESULT_1=$(capture ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --no-pull)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/6] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${CDKL_STDERR}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(capture ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --event "${EVENT_FILE}" --no-pull)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"key":"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override (Parameters)
echo "==> [3/6] Invoking EchoHandler with --env-vars Parameters block"
ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${CDKL_STDERR}"' EXIT
# Use a wildcard `Parameters` block so the test doesn't break if the
# L1 logical ID changes.
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(capture ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --env-vars "${ENV_FILE}" --no-pull)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -q '"greeting":"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — --env-vars function-specific key by display path (issue #27)
echo "==> [4/6] Invoking EchoHandler with --env-vars display-path key"
DP_ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${DP_ENV_FILE}" "${CDKL_STDERR}"' EXIT
# The display-path key matches `Metadata['aws:cdk:path']` — i.e. the
# same form `cdkl invoke <target>` already accepts.
echo '{"CdkLocalInvokeFixture/EchoHandler":{"GREETING":"path-key-overridden"}}' > "${DP_ENV_FILE}"
RESULT_4=$(capture ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --env-vars "${DP_ENV_FILE}" --no-pull)
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -q '"greeting":"path-key-overridden"' || {
  echo "FAIL: expected greeting=path-key-overridden, got: ${RESULT_4}"
  exit 1
}

# Test 5 — inline (Code.ZipFile) Lambda
echo "==> [5/6] Invoking InlineHandler (Code.ZipFile)"
INLINE_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${DP_ENV_FILE}" "${INLINE_EVENT}" "${CDKL_STDERR}"' EXIT
echo '{"hi":"there"}' > "${INLINE_EVENT}"
RESULT_5=$(capture ${CDKL} invoke CdkLocalInvokeFixture/InlineHandler --event "${INLINE_EVENT}" --no-pull)
echo "    response: ${RESULT_5}"
echo "${RESULT_5}" | grep -q '"inlineEcho":{"hi":"there"}' || {
  echo "FAIL: expected inlineEcho={hi:there}, got: ${RESULT_5}"
  exit 1
}

# Test 6 — ZIP-FILE asset Lambda (Code.fromAsset of a .zip). `aws:asset:path`
# points at `asset.<hash>.zip`, so cdkl must extract it before bind-mounting.
# A successful echo with the zip-only env var proves the extracted code ran.
echo "==> [6/6] Invoking ZipAssetHandler (Code.fromAsset of a .zip file)"
ZIP_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${DP_ENV_FILE}" "${INLINE_EVENT}" "${ZIP_EVENT}" "${CDKL_STDERR}"' EXIT
echo '{"zip":"asset"}' > "${ZIP_EVENT}"
RESULT_6=$(capture ${CDKL} invoke CdkLocalInvokeFixture/ZipAssetHandler --event "${ZIP_EVENT}" --no-pull)
echo "    response: ${RESULT_6}"
echo "${RESULT_6}" | grep -q '"echoed":{"zip":"asset"}' || {
  echo "FAIL: expected echoed={zip:asset} from extracted zip asset, got: ${RESULT_6}"
  exit 1
}
echo "${RESULT_6}" | grep -q '"greeting":"from-zip-asset"' || {
  echo "FAIL: expected greeting=from-zip-asset from extracted zip asset, got: ${RESULT_6}"
  exit 1
}

echo ""
echo "==> All 6 local-invoke tests passed"
