#!/usr/bin/env bash
#
# Real-Docker validation for `cdkl start-web-function` (issue #831): serve an
# AWS Lambda Web Function from a CDK app on a local port.
#
# The fixture app declares one CfnWebFunction, three CfnWebFunctionRevisions of
# the SAME s3assets.Asset bundle (web/index.js, a dependency-free HTTP server
# listening on AWS_LAMBDA_HTTP_ENDPOINT) that differ only in their
# ServiceConfig environment, and one CfnWebFunctionEndpoint weighting RevV1 20 /
# RevV2 80. Arms:
#
#   1. Endpoint target -> the higher-weight RevV2 is served: method / path /
#      ServiceConfig env echoed, the weighted-split warning printed once, ten
#      concurrent slow requests all answered and overlapped, then SIGTERM
#      leaves no container behind.
#   2. `--revision RevV1` overrides the weights.
#   3. `--revision RevAlt` sets AWS_LAMBDA_NODEJS_ENTRYPOINT=alt.js, so the
#      runtime starts alt.js instead of index.js.
#
# Fully local — nothing is deployed. Run via `/run-integ local-start-web-function`
# (recommended) or directly:
#
#     bash tests/integration/local-start-web-function/verify.sh
#
# Requires Docker. Uses host ports 18460-18462.

set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-web-function"
CLI="node ${REPO_ROOT}/dist/cli.js"
STACK="CdkLocalStartWebFunctionFixture"
BASE_IMAGE="public.ecr.aws/lambda/nodejs:24"
PORT=18460

# The cloud runtime is arm64-only, and the command defaults to linux/arm64. On
# an amd64 host, run the container natively instead of under emulation.
case "$(uname -m)" in
  arm64 | aarch64) PLATFORM="linux/arm64"; PLATFORM_ARGS=() ;;
  *) PLATFORM="linux/amd64"; PLATFORM_ARGS=(--platform linux/amd64) ;;
esac

CDKL_PID=""
OUT_FILE="$(mktemp)"

stop_server() {
  if [ -n "${CDKL_PID}" ] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 80); do kill -0 "${CDKL_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  CDKL_PID=""
}

cleanup() {
  rc=$?
  stop_server
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

# Boot `cdkl start-web-function` into the background and wait for its ready
# banner. Truncates OUT_FILE so each serve's lines are read fresh.
boot_serve() {
  stop_server
  : > "${OUT_FILE}"
  ${CLI} start-web-function "$@" ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} > "${OUT_FILE}" 2>&1 &
  CDKL_PID=$!
  for _ in $(seq 1 480); do
    grep -q 'Server listening on http://' "${OUT_FILE}" && return 0
    kill -0 "${CDKL_PID}" 2>/dev/null || fail "start-web-function exited before it was ready"
    sleep 0.5
  done
  fail "start-web-function did not print its ready banner in time"
}

assert_no_orphans() {
  sleep 1
  local orphans
  orphans="$(docker ps -a --filter name=cdkl-webfn- --format '{{.Names}}' || true)"
  [ -z "${orphans}" ] || fail "leftover web function container(s) after $1: ${orphans}"
}

echo "[verify] step 1: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
[ -d node_modules ] || vp install --prefer-offline

echo "[verify] step 2: Docker available + base image present (${PLATFORM})"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform "${PLATFORM}" "${BASE_IMAGE}" >/dev/null
assert_no_orphans "pre-flight"

echo "[verify] step 3: endpoint target serves the higher-weight revision (RevV2)"
boot_serve "${STACK}/Endpoint" --port "${PORT}" --no-pull
URL="http://127.0.0.1:${PORT}"
grep -q "Server listening on ${URL}" "${OUT_FILE}" || fail "ready banner does not name ${URL}"
BODY="$(curl -s -X POST "${URL}/hello/world?q=1")"
echo "${BODY}" | grep -q '"method":"POST"' || fail "method not echoed: ${BODY}"
echo "${BODY}" | grep -q '"path":"/hello/world?q=1"' || fail "path not echoed: ${BODY}"
echo "${BODY}" | grep -q '"revision":"v2"' || fail "higher-weight revision RevV2 not served: ${BODY}"
echo "${BODY}" | grep -q '"greeting":"hello-from-v2"' || fail "ServiceConfig env not injected: ${BODY}"
echo "${BODY}" | grep -q '"entry":"index"' || fail "default entry index.js not started: ${BODY}"
echo "${BODY}" | grep -q '"functionName":"cdkl-integ-web-fn"' || fail "function name not set: ${BODY}"
[ "$(grep -c 'weighted routing is not emulated' "${OUT_FILE}")" -eq 1 ] \
  || fail "the weighted-split warning was not printed exactly once"
grep -q 'every request goes to revision RevV2' "${OUT_FILE}" \
  || fail "the weighted-split warning does not name the served revision"
echo "[verify]   RevV2 served: ${BODY}"

echo "[verify] step 4: ten concurrent slow requests are all answered, overlapped"
CONC_DIR="$(mktemp -d)"
START_MS="$(node -e 'console.log(Date.now())')"
for i in $(seq 1 10); do
  curl -s "${URL}/slow" > "${CONC_DIR}/${i}.json" &
done
wait
END_MS="$(node -e 'console.log(Date.now())')"
OK_COUNT="$(grep -l '"path":"/slow"' "${CONC_DIR}"/*.json | wc -l | tr -d ' ')"
rm -rf "${CONC_DIR}"
[ "${OK_COUNT}" -eq 10 ] || fail "only ${OK_COUNT}/10 concurrent requests succeeded"
ELAPSED=$((END_MS - START_MS))
# Ten 500 ms requests served one at a time take >= 5000 ms.
[ "${ELAPSED}" -lt 4000 ] || fail "10 concurrent /slow requests took ${ELAPSED}ms (not overlapped)"
echo "[verify]   10/10 answered in ${ELAPSED}ms"

echo "[verify] step 5: SIGTERM removes the container"
stop_server
assert_no_orphans "the endpoint serve"

echo "[verify] step 6: --revision RevV1 overrides the endpoint weights"
boot_serve "${STACK}/Endpoint" --revision RevV1 --port "$((PORT + 1))" --no-pull
BODY="$(curl -s "http://127.0.0.1:$((PORT + 1))/")"
echo "${BODY}" | grep -q '"revision":"v1"' || fail "--revision RevV1 not served: ${BODY}"
echo "${BODY}" | grep -q '"greeting":"hello-from-v1"' || fail "RevV1 env not injected: ${BODY}"
stop_server
assert_no_orphans "the --revision serve"

echo "[verify] step 7: AWS_LAMBDA_NODEJS_ENTRYPOINT=alt.js starts alt.js"
boot_serve "${STACK}/WebFn" --revision RevAlt --port "$((PORT + 2))" --no-pull
BODY="$(curl -s "http://127.0.0.1:$((PORT + 2))/")"
echo "${BODY}" | grep -q '"entry":"alt"' || fail "the entrypoint env did not start alt.js: ${BODY}"
echo "${BODY}" | grep -q '"revision":"alt"' || fail "RevAlt not served: ${BODY}"
stop_server
assert_no_orphans "the entrypoint serve"

echo "[verify] PASS"
