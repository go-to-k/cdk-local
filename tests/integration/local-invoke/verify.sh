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
RESULT_1=$(${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/6] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --event "${EVENT_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"key":"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override (Parameters)
echo "==> [3/6] Invoking EchoHandler with --env-vars Parameters block"
ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}"' EXIT
# Use a wildcard `Parameters` block so the test doesn't break if the
# L1 logical ID changes.
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --env-vars "${ENV_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -q '"greeting":"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — --env-vars function-specific key by display path (issue #27)
echo "==> [4/6] Invoking EchoHandler with --env-vars display-path key"
DP_ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${DP_ENV_FILE}"' EXIT
# The display-path key matches `Metadata['aws:cdk:path']` — i.e. the
# same form `cdkl invoke <target>` already accepts.
echo '{"CdkLocalInvokeFixture/EchoHandler":{"GREETING":"path-key-overridden"}}' > "${DP_ENV_FILE}"
RESULT_4=$(${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --env-vars "${DP_ENV_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -q '"greeting":"path-key-overridden"' || {
  echo "FAIL: expected greeting=path-key-overridden, got: ${RESULT_4}"
  exit 1
}

# Test 5 — inline (Code.ZipFile) Lambda
echo "==> [5/6] Invoking InlineHandler (Code.ZipFile)"
INLINE_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${DP_ENV_FILE}" "${INLINE_EVENT}"' EXIT
echo '{"hi":"there"}' > "${INLINE_EVENT}"
RESULT_5=$(${CDKL} invoke CdkLocalInvokeFixture/InlineHandler --event "${INLINE_EVENT}" --no-pull 2>/dev/null | tail -1)
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
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${DP_ENV_FILE}" "${INLINE_EVENT}" "${ZIP_EVENT}"' EXIT
echo '{"zip":"asset"}' > "${ZIP_EVENT}"
RESULT_6=$(${CDKL} invoke CdkLocalInvokeFixture/ZipAssetHandler --event "${ZIP_EVENT}" --no-pull 2>/dev/null | tail -1)
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
