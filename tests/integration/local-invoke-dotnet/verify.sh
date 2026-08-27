#!/usr/bin/env bash
# verify.sh — local-invoke .NET integ test (issue #248)
#
# Unlike most integ tests this one is fully local: no AWS resources are
# deployed. The test exercises `cdkl invoke` end-to-end against
# Docker + the AWS Lambda .NET base image (which bundles the Runtime
# Interface Emulator) AND validates that inline `Code.ZipFile` is
# rejected with a clear "use Code.fromAsset" message.
#
# Run via `/run-integ local-invoke-dotnet` (recommended) or directly:
#
#     bash tests/integration/local-invoke-dotnet/verify.sh
#
# Requires Docker. The host does NOT need the .NET SDK — Function.cs is
# compiled via `dotnet publish` inside an `mcr.microsoft.com/dotnet/sdk:8.0`
# container (~1.2GB, one-time pull). The Lambda .NET base image (~600MB)
# is pulled separately.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
LAMBDA_IMAGE="public.ecr.aws/lambda/dotnet:8"
SDK_IMAGE="mcr.microsoft.com/dotnet/sdk:8.0"

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

echo "==> Pulling .NET SDK image for compilation (~1.2GB, one-time)"
docker pull "${SDK_IMAGE}"

echo "==> Pulling ${LAMBDA_IMAGE} (~600MB, one-time)"
docker pull "${LAMBDA_IMAGE}"

echo "==> Building Lambda assembly via dotnet publish (inside Docker)"
rm -rf lambda/publish lambda/bin lambda/obj
docker run --rm \
  -v "$(pwd)/lambda:/work" \
  -w /work \
  "${SDK_IMAGE}" \
  dotnet publish -c Release -o publish --nologo
test -f lambda/publish/Function.dll || {
  echo "FAIL: dotnet publish did not produce Function.dll"
  exit 1
}

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi


# Test 1 — asset-backed .NET Lambda echoes event + env var.
# .NET cold-start in the local container is slow — the function's
# Timeout: 30 + cdk-local's `invokeTimeoutMs = max(30s, 2 * fn.timeout)`
# = 60s provides headroom.
# The "~5-10s on Apple Silicon" figure this comment used to quote was
# measured while the fixture declared no architecture and therefore ran
# under x86_64 emulation. Since issue #569 it declares the host
# architecture and runs natively, so that number no longer describes it
# and has been dropped rather than guessed at; the headroom is unchanged.
echo "==> [1/3] Invoking EchoHandler with default empty event"
RESULT_1=$(capture ${CDKL} invoke CdkLocalInvokeDotnetFixture/EchoHandler --no-pull)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -Eq '"greeting": *"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/3] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${CDKL_STDERR}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(capture ${CDKL} invoke CdkLocalInvokeDotnetFixture/EchoHandler --event "${EVENT_FILE}" --no-pull)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -Eq '"key": *"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — inline Code.ZipFile rejection. cdk-local MUST refuse to invoke
# this Lambda with the routing message pointing at lambda.Code.fromAsset,
# and exit non-zero BEFORE pulling any image / starting any container.
echo "==> [3/3] Invoking InlineHandler — expecting Inline Code.ZipFile rejection"
RESULT_3=""
if RESULT_3=$(${CDKL} invoke CdkLocalInvokeDotnetFixture/InlineHandler --no-pull 2>&1); then
  echo "FAIL: expected non-zero exit on inline .NET, got success: ${RESULT_3}"
  exit 1
fi
echo "${RESULT_3}" | grep -q "Inline 'Code.ZipFile' is not supported" || {
  echo "FAIL: expected 'Inline Code.ZipFile is not supported' message, got:"
  echo "${RESULT_3}"
  exit 1
}
echo "${RESULT_3}" | grep -q "Code.fromAsset" || {
  echo "FAIL: expected 'Code.fromAsset' routing in message, got:"
  echo "${RESULT_3}"
  exit 1
}
echo "    rejection ✓"

echo ""
echo "==> All 3 local-invoke .NET tests passed"
