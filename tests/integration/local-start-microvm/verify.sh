#!/usr/bin/env bash
#
# Real-Docker validation for `cdkl start-microvm` (issue #835): run AWS Lambda
# MicroVMs from a CDK app's AWS::Lambda::MicrovmImage locally.
#
# The fixture app declares two CfnMicrovmImages of the SAME s3assets.Asset
# directory (app/Dockerfile + app/app.js, a dependency-free server: hooks on
# 9001, echo endpoints on 8080 and 9000). `Image` enables every hook and its
# /ready answers 503 twice before 200; `NeverReadyImage` answers 503 forever
# with a 3-second ReadyTimeoutInSeconds. Arms:
#
#   1. `Image`: /ready retried until 200, then /validate and /run; the run
#      payload, the generated microvmId and EnvironmentVariables reach the app;
#      8080 by default, 9000 by X-aws-proxy-port; X-aws-proxy-* headers never
#      reach the app; invalid -> 400, unpublished -> 403, published but not
#      listening -> 502.
#   2. Control endpoint: suspend -> 503 while suspended -> resume -> served,
#      with the /suspend and /resume hooks observed.
#   3. SIGTERM -> /terminate observed for the MicroVM, no container left.
#   4. `--count 2`: two URLs answering with different microvmIds; SIGTERM
#      terminates both.
#   5. `NeverReadyImage`: boot fails non-zero with the /ready timeout message
#      and leaves no container.
#
# Fully local — nothing is deployed. Run via `/run-integ local-start-microvm`
# (recommended) or directly:
#
#     bash tests/integration/local-start-microvm/verify.sh
#
# Requires Docker. Uses host ports 18470-18473.

set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-microvm"
CLI="node ${REPO_ROOT}/dist/cli.js"
STACK="CdkLocalStartMicrovmFixture"
BASE_IMAGE="public.ecr.aws/docker/library/node:24-slim"
PORT=18470
PAYLOAD="tenant-a"

# The image declares ARM_64. On an amd64 host, build and run natively instead
# of under emulation (the app is plain JavaScript on a multi-arch base).
case "$(uname -m)" in
  arm64 | aarch64) PLATFORM="linux/arm64" ;;
  *) PLATFORM="linux/amd64" ;;
esac

CDKL_PID=""
OUT_FILE="$(mktemp)"

# Containers are named `cdkl-microvm-<cdkl pid>-<index>-<rand>`, so a filter on
# this run's pid never matches a peer session's MicroVMs.
containers_of() {
  docker ps -a --filter "name=cdkl-microvm-$1-" --format '{{.Names}}' || true
}

stop_server() {
  if [ -n "${CDKL_PID}" ] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do kill -0 "${CDKL_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
}

cleanup() {
  rc=$?
  local pid="${CDKL_PID}"
  stop_server
  if [ -n "${pid}" ]; then
    for name in $(containers_of "${pid}"); do docker rm -f "${name}" >/dev/null 2>&1 || true; done
  fi
  rm -f "${OUT_FILE}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "----- cdkl output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

# Boot `cdkl start-microvm` into the background and wait for its ready banner.
# Truncates OUT_FILE so each run's lines are read fresh.
boot_run() {
  : > "${OUT_FILE}"
  ${CLI} start-microvm "$@" --platform "${PLATFORM}" > "${OUT_FILE}" 2>&1 &
  CDKL_PID=$!
  for _ in $(seq 1 480); do
    grep -q 'Press ^C to terminate the MicroVM(s).' "${OUT_FILE}" && return 0
    kill -0 "${CDKL_PID}" 2>/dev/null || fail "start-microvm exited before it was ready"
    sleep 0.5
  done
  fail "start-microvm did not print its ready banner in time"
}

# SIGTERM the run, wait for THAT pid to exit 0, and require its containers gone.
terminate_run() {
  local pid="${CDKL_PID}"
  kill -TERM "${pid}"
  set +e
  wait "${pid}"
  local rc=$?
  set -e
  CDKL_PID=""
  [ "${rc}" -eq 0 ] || fail "start-microvm exited ${rc} on SIGTERM (want 0)"
  local left
  left="$(containers_of "${pid}")"
  [ -z "${left}" ] || fail "leftover MicroVM container(s) after SIGTERM: ${left}"
}

status_of() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

echo "[verify] step 1: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
[ -d node_modules ] || vp install --prefer-offline

echo "[verify] step 2: Docker available + base image present (${PLATFORM})"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform "${PLATFORM}" "${BASE_IMAGE}" >/dev/null

echo "[verify] step 3: hooks driven in order, payload + microvmId + env reach the app"
boot_run "${STACK}/Image" --port "${PORT}" --run-hook-payload "${PAYLOAD}" --proxy-port 9100
URL="http://127.0.0.1:${PORT}"
grep -q "listening on ${URL}" "${OUT_FILE}" || fail "ready banner does not name ${URL}"
grep -q 'HOOK ready -> 503 (attempt 2)' "${OUT_FILE}" || fail "/ready was not retried after 503"
grep -Eq '/ready hook answered 200 after [3-9][0-9]* attempt' "${OUT_FILE}" \
  || fail "/ready did not reach 200 after the 503 retries"
grep -q '/validate hook answered 200' "${OUT_FILE}" || fail "/validate was not called"
grep -q '/run hook answered 200' "${OUT_FILE}" || fail "/run was not called"
MVM_ID="$(grep -oE 'MicroVM mvm-[0-9a-f-]+ listening' "${OUT_FILE}" | head -1 | awk '{print $2}')"
[ -n "${MVM_ID}" ] || fail "no microvmId in the ready banner"
BODY="$(curl -s "${URL}/hello")"
echo "${BODY}" | grep -q '"port":8080' || fail "default request not routed to 8080: ${BODY}"
echo "${BODY}" | grep -q "\"microvmId\":\"${MVM_ID}\"" || fail "/run microvmId not seen by the app: ${BODY}"
echo "${BODY}" | grep -q "\"runHookPayload\":\"${PAYLOAD}\"" || fail "run payload not seen by the app: ${BODY}"
echo "${BODY}" | grep -q '"greeting":"hello-from-microvm"' || fail "EnvironmentVariables not injected: ${BODY}"
echo "${BODY}" | grep -q '"hooks":\["ready","validate","run"\]' || fail "hook order wrong: ${BODY}"
echo "[verify]   ${MVM_ID}: ${BODY}"

echo "[verify] step 4: port routing and header stripping"
BODY="$(curl -s "${URL}/alt" -H 'X-aws-proxy-port: 9000' -H 'X-aws-proxy-auth: token' -H 'X-aws-proxy-extra: 1')"
echo "${BODY}" | grep -q '"port":9000' || fail "X-aws-proxy-port: 9000 not routed to 9000: ${BODY}"
echo "${BODY}" | grep -q '"proxyHeaders":\[\]' || fail "X-aws-proxy-* headers reached the app: ${BODY}"
[ "$(status_of "${URL}/" -H 'X-aws-proxy-port: abc')" = "400" ] || fail "invalid X-aws-proxy-port not 400"
[ "$(status_of "${URL}/" -H 'X-aws-proxy-port: 9200')" = "403" ] || fail "unpublished port not 403"
[ "$(status_of "${URL}/" -H 'X-aws-proxy-port: 9100')" = "502" ] \
  || fail "published port with no listener (--proxy-port 9100) not 502"

echo "[verify] step 5: suspend -> 503 -> resume -> served"
curl -s -X POST "${URL}/_cdkl/microvm/suspend" | grep -q '"state":"suspended"' || fail "suspend did not report suspended"
grep -q 'HOOK suspend -> 200' "${OUT_FILE}" || fail "/suspend hook not observed"
[ "$(status_of "${URL}/while-suspended")" = "503" ] || fail "a request to a suspended MicroVM was not 503"
curl -s -X POST "${URL}/_cdkl/microvm/resume" | grep -q '"state":"running"' || fail "resume did not report running"
BODY="$(curl -s "${URL}/after-resume")"
echo "${BODY}" | grep -q '"hooks":\["ready","validate","run","suspend","resume"\]' \
  || fail "/resume hook not observed by the app: ${BODY}"

echo "[verify] step 6: SIGTERM calls /terminate and removes the container"
terminate_run
grep -q "MicroVM ${MVM_ID}: /terminate hook answered 200" "${OUT_FILE}" || fail "/terminate not called on SIGTERM"
grep -q 'HOOK terminate -> 200' "${OUT_FILE}" || fail "the app did not log its /terminate hook"

echo "[verify] step 7: --count 2 runs two independent MicroVMs"
boot_run "${STACK}/Image" --port "$((PORT + 2))" --count 2
A="$(curl -s "http://127.0.0.1:$((PORT + 2))/")"
B="$(curl -s "http://127.0.0.1:$((PORT + 3))/")"
ID_A="$(echo "${A}" | grep -oE 'mvm-[0-9a-f-]+' | head -1)"
ID_B="$(echo "${B}" | grep -oE 'mvm-[0-9a-f-]+' | head -1)"
[ -n "${ID_A}" ] && [ -n "${ID_B}" ] || fail "a --count 2 URL did not answer with a microvmId: ${A} / ${B}"
[ "${ID_A}" != "${ID_B}" ] || fail "the two MicroVMs share microvmId ${ID_A}"
terminate_run
[ "$(grep -c '/terminate hook answered 200' "${OUT_FILE}")" -eq 2 ] \
  || fail "SIGTERM did not terminate both MicroVMs"

echo "[verify] step 8: a /ready that never answers 200 fails with the timeout"
: > "${OUT_FILE}"
set +e
${CLI} start-microvm "${STACK}/NeverReadyImage" --platform "${PLATFORM}" > "${OUT_FILE}" 2>&1 &
NR_PID=$!
wait "${NR_PID}"
NR_RC=$?
set -e
[ "${NR_RC}" -ne 0 ] || fail "start-microvm exited 0 for an image that is never ready"
grep -q 'The /ready hook did not answer 200 within 3000ms' "${OUT_FILE}" \
  || fail "the never-ready failure does not name the /ready timeout"
LEFT="$(containers_of "${NR_PID}")"
[ -z "${LEFT}" ] || fail "leftover container after the never-ready failure: ${LEFT}"

echo "[verify] PASS"
