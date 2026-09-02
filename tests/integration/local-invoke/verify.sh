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
echo "==> [1/9] Invoking EchoHandler with default empty event"
RESULT_1=$(capture ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --no-pull)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/9] Invoking EchoHandler with --event payload"
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
echo "==> [3/9] Invoking EchoHandler with --env-vars Parameters block"
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
echo "==> [4/9] Invoking EchoHandler with --env-vars display-path key"
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
echo "==> [5/9] Invoking InlineHandler (Code.ZipFile)"
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
echo "==> [6/9] Invoking ZipAssetHandler (Code.fromAsset of a .zip file)"
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

# Test 7 — HTTPS_PROXY is honored for AWS SDK calls (issue #634). A tiny
# recording proxy (OS-assigned port; proxy-recorder.mjs) captures CONNECT
# request lines and answers 502. With HTTPS_PROXY pointing at it, the
# `--assume-role` STS AssumeRole call must be tunneled THROUGH the proxy —
# proving the built CLI reads the proxy environment end-to-end. The 502 makes
# AssumeRole fail; `cdkl invoke` warns and falls back to the shell
# credentials (dummy env creds here, resolved locally — no network), so the
# invoke itself still completes and proves the fallback stays graceful.
echo "==> [7/9] HTTPS_PROXY routes the STS AssumeRole call through the proxy"
PROXY_LOG=$(mktemp)
PROXY_PORT_FILE=$(mktemp)
node proxy-recorder.mjs "${PROXY_LOG}" > "${PROXY_PORT_FILE}" &
PROXY_PID=$!
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${DP_ENV_FILE}" "${INLINE_EVENT}" "${ZIP_EVENT}" "${CDKL_STDERR}" "${PROXY_LOG}" "${PROXY_PORT_FILE}"; kill "${PROXY_PID}" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  [ -s "${PROXY_PORT_FILE}" ] && break
  sleep 0.1
done
PROXY_PORT=$(cat "${PROXY_PORT_FILE}")
[ -n "${PROXY_PORT}" ] || {
  echo "FAIL: proxy recorder did not report a port"
  exit 1
}
RESULT_7=$(capture env \
  HTTPS_PROXY="http://127.0.0.1:${PROXY_PORT}" \
  AWS_ACCESS_KEY_ID=cdkl-integ-dummy AWS_SECRET_ACCESS_KEY=cdkl-integ-dummy AWS_REGION=us-east-1 \
  ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler \
  --assume-role arn:aws:iam::123456789012:role/cdkl-proxy-integ --no-pull)
echo "    response: ${RESULT_7}"
grep -q '^CONNECT sts\.us-east-1\.amazonaws\.com:443 ' "${PROXY_LOG}" || {
  echo "FAIL: expected a recorded CONNECT to sts.us-east-1.amazonaws.com:443; proxy log:"
  cat "${PROXY_LOG}"
  exit 1
}
echo "${RESULT_7}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected the invoke to complete via the graceful shell-creds fallback, got: ${RESULT_7}"
  exit 1
}

# Test 8 — NO_PROXY exempts the call: same command, same proxy env, but a
# bare `*` disables proxying entirely, so NO CONNECT may be recorded. The
# AssumeRole then goes DIRECT to real AWS with the dummy creds (a fast
# unauthenticated failure — needs outbound network, which this suite already
# requires for the docker pull), warns, and falls back the same way.
echo "==> [8/9] NO_PROXY='*' keeps the same call OFF the proxy"
: > "${PROXY_LOG}"
RESULT_8=$(capture env \
  HTTPS_PROXY="http://127.0.0.1:${PROXY_PORT}" NO_PROXY='*' \
  AWS_ACCESS_KEY_ID=cdkl-integ-dummy AWS_SECRET_ACCESS_KEY=cdkl-integ-dummy AWS_REGION=us-east-1 \
  ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler \
  --assume-role arn:aws:iam::123456789012:role/cdkl-proxy-integ --no-pull)
echo "    response: ${RESULT_8}"
if [ -s "${PROXY_LOG}" ]; then
  echo "FAIL: NO_PROXY='*' was set but the proxy still recorded a CONNECT:"
  cat "${PROXY_LOG}"
  exit 1
fi
echo "${RESULT_8}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected the invoke to complete via the graceful shell-creds fallback, got: ${RESULT_8}"
  exit 1
}

# Test 9 -- a proxy scheme these agents cannot SPEAK (issue
# go-to-k/cdk-local#663). `ALL_PROXY=socks5://...` is an ordinary spelling
# `proxy-from-env` honours, and until this fix `EnvRoutingProxyAgent.connect`
# handed that URL to `HttpsProxyAgent`, which speaks HTTP CONNECT -- so a
# SOCKS URL aimed at the SAME recorder above produced a real
# `CONNECT sts.us-east-1.amazonaws.com:443` sent at a SOCKS port, three times,
# which the SDK then surfaced as `Unknown` (measured on origin/main through
# the shipped dist). It now falls back to a DIRECT connection and says so
# once.
#
# BOTH halves are asserted. An empty recorder log alone would also pass if the
# CLI never made the call at all -- so the warn is what proves the request
# happened and chose direct DELIBERATELY, and its count is what proves the
# per-request decision does not print a line per AWS call.
echo "==> [9/9] a SOCKS ALL_PROXY connects DIRECT and warns once"
: > "${PROXY_LOG}"
RESULT_9=$(capture env \
  ALL_PROXY="socks5://127.0.0.1:${PROXY_PORT}" \
  AWS_ACCESS_KEY_ID=cdkl-integ-dummy AWS_SECRET_ACCESS_KEY=cdkl-integ-dummy AWS_REGION=us-east-1 \
  ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler \
  --assume-role arn:aws:iam::123456789012:role/cdkl-proxy-integ --no-pull)
echo "    response: ${RESULT_9}"
if [ -s "${PROXY_LOG}" ]; then
  echo "FAIL: a SOCKS ALL_PROXY must never be spoken HTTP at, but the recorder logged:"
  cat "${PROXY_LOG}"
  exit 1
fi
# Read off STDERR because the compact logger sends warn there. A run under
# `CDKL_LOG_STREAM=stdout` (what `cdkl studio` sets for its serve children)
# would unify the streams and this grep would stop matching -- and NOT simply
# by moving to RESULT_9, which is only the LAST stdout line; such a run would
# need the command's stdout captured whole.
grep -q 'Unsupported proxy scheme "socks5"' "${CDKL_STDERR}" || {
  echo "FAIL: expected the unsupported-scheme warn on stderr; captured stderr:"
  cat "${CDKL_STDERR}"
  exit 1
}
WARN_COUNT_9=$(grep -c 'Unsupported proxy scheme' "${CDKL_STDERR}" || true)
[ "${WARN_COUNT_9}" = "1" ] || {
  echo "FAIL: the unsupported-scheme warn must be emitted ONCE per run, got ${WARN_COUNT_9}:"
  grep -n 'Unsupported proxy scheme' "${CDKL_STDERR}" || true
  exit 1
}
echo "${RESULT_9}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected the invoke to complete via the graceful shell-creds fallback, got: ${RESULT_9}"
  exit 1
}

echo ""
echo "==> All 9 local-invoke tests passed"
