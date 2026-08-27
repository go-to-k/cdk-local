#!/usr/bin/env bash
# verify.sh — local-invoke container-Lambda integ test (PR 5 of #224)
#
# Like `tests/integration/local-invoke/verify.sh` this is fully local —
# no AWS resources are deployed. We synthesize a CDK app whose only
# Lambda is a `lambda.DockerImageFunction` (Code.ImageUri) and exercise
# the local-build path of `cdkl invoke` end-to-end.
#
# Run via `/run-integ local-invoke-container` (recommended) or directly:
#
#     bash tests/integration/local-invoke-container/verify.sh
#
# Requires Docker. The build pulls the AWS Lambda Node.js base image
# (~600MB) the first time.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
BASE_IMAGE="public.ecr.aws/lambda/nodejs:20"

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

# --- built-image cleanup (issue #587) --------------------------------------
# This fixture's DockerImageFunction makes cdkl `docker build` a
# `cdkl-invoke-<hash>:latest` image of ~421 MB. Nothing removed it, so every
# run leaked one -- and because the tag is a fingerprint of the asset (the
# platform included), a change to the Dockerfile, the handler or the
# architecture mints a NEW tag that no later run will ever reuse or reclaim.
#
# Only the tag(s) THIS run creates are removed: the set of `cdkl-invoke-*`
# tags present now is snapshotted, and cleanup deletes only what appeared
# since. A blanket `docker rmi` of every `cdkl-invoke-*` tag is deliberately
# NOT used -- parallel integ lanes share one Docker daemon on a dev host, so
# a blanket sweep deletes images other lanes are mid-run on, and it would
# also destroy the local cache other container fixtures rely on.
IMAGES_BEFORE="$(mktemp)"
docker images --filter 'reference=cdkl-invoke-*' --format '{{.Repository}}:{{.Tag}}' \
  | sort > "${IMAGES_BEFORE}"

remove_run_images() {
  [ -f "${IMAGES_BEFORE:-}" ] || return 0
  local new
  new="$(docker images --filter 'reference=cdkl-invoke-*' --format '{{.Repository}}:{{.Tag}}' \
    | sort | comm -13 "${IMAGES_BEFORE}" -)"
  if [ -n "${new}" ]; then
    echo "==> Removing image(s) built by this run:"
    echo "${new}" | sed 's/^/      /'
    # Unforced: `docker image rm` refuses an image while a container still holds
    # it, so a lane whose container is UP survives. It does NOT cover a lane
    # between `docker build` and `docker run` -- the delta scoping is what keeps
    # this run away from another lane's tag in that window.
    echo "${new}" | xargs -r docker image rm >/dev/null 2>&1 || true
  fi
  rm -f "${IMAGES_BEFORE}"
}
# Installed BEFORE test 1, because test 1 is what triggers the `docker build`.
# The later `trap 'rm -f ...' EXIT` lines REPLACE this handler rather than
# adding to it, so each of them re-appends `remove_run_images`; without this
# first registration a failure during test 1 would still leak the image.
trap 'rm -f "${CDKL_STDERR}"; remove_run_images' EXIT

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${BASE_IMAGE} (one-time, ~600MB)"
docker pull "${BASE_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi


# Test 1 — container-Lambda default empty event
# Uses --no-pull so docker build's --pull flag is not set (this is the
# default; --no-pull on the container-Lambda local-build path is
# documented as a no-op in CLI help — it still skips the public-base
# image's `docker pull` from the ZIP path which we did up front).
echo "==> [1/4] Invoking EchoHandler (container) with default empty event"
RESULT_1=$(capture ${CDKL} invoke CdkLocalInvokeContainerFixture/EchoHandler --no-pull)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}
echo "${RESULT_1}" | grep -q '"fromContainer":true' || {
  echo "FAIL: expected fromContainer=true in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/4] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${CDKL_STDERR}"; remove_run_images' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(capture ${CDKL} invoke CdkLocalInvokeContainerFixture/EchoHandler --event "${EVENT_FILE}" --no-pull)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"key":"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override
echo "==> [3/4] Invoking EchoHandler with --env-vars override"
ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${CDKL_STDERR}"; remove_run_images' EXIT
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(capture ${CDKL} invoke CdkLocalInvokeContainerFixture/EchoHandler --env-vars "${ENV_FILE}" --no-pull)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -q '"greeting":"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — --no-build (closes #233): the previous tests already built the
# image under the deterministic local tag, so a 4th invocation with
# --no-build should skip the rebuild and reuse the cached tag. cdk-local
# logger output goes to stdout (not stderr), so we capture combined
# stdout+stderr to inspect the build-vs-skip log lines, and rely on
# the JSON response always being on the LAST stdout line for the
# greeting check.
echo "==> [4/4] Invoking EchoHandler with --no-build (image must already be cached from steps 1-3)"
COMBINED_4=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${COMBINED_4}" "${CDKL_STDERR}"; remove_run_images' EXIT
# A non-zero exit here used to abort the script (issue #577) BEFORE any of the
# three FAIL branches below that `cat "${COMBINED_4}"` -- so the one test whose
# whole point is inspecting the log lost the log. Capture the status instead.
CDKL_RC_4=0
${CDKL} invoke CdkLocalInvokeContainerFixture/EchoHandler --no-pull --no-build >"${COMBINED_4}" 2>&1 || CDKL_RC_4=$?
if [ "${CDKL_RC_4}" -ne 0 ]; then
  echo "[verify] cdkl invoke exited ${CDKL_RC_4}; combined output follows:" >&2
  cat "${COMBINED_4}" >&2
fi
RESULT_4=$(tail -1 "${COMBINED_4}")
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected greeting=hello (--no-build response), got: ${RESULT_4}"
  cat "${COMBINED_4}"
  exit 1
}
grep -q "Skipping docker build" "${COMBINED_4}" || {
  echo "FAIL: --no-build did not log 'Skipping docker build' marker. Combined output was:"
  cat "${COMBINED_4}"
  exit 1
}
if grep -q "Building container image" "${COMBINED_4}"; then
  echo "FAIL: --no-build still logged 'Building container image' (rebuild happened despite --no-build). Combined output was:"
  cat "${COMBINED_4}"
  exit 1
fi

remove_run_images

echo ""
echo "==> All 4 local-invoke container-Lambda tests passed"
