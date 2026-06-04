#!/usr/bin/env bash
# verify.sh — cdkl start-alb -> Lambda target groups integ test (#123, no AWS deploy)
#
# Names an Application Load Balancer whose single HTTP:80 listener forwards to
# Lambda functions (TargetType: lambda target groups):
#   - default action       -> EchoFn (asset-backed Node.js Lambda), echoes the
#                             ALB event it received.
#   - path-pattern /api/*   -> ApiFn (multi_value_headers.enabled=true).
# Asserts:
#   - The host-side ALB front-door endpoint comes up on the --lb-port host port.
#   - GET /?a=1 -> reaches the echo Lambda, which sees the ALB Lambda-target
#     event (requestContext.elb present, httpMethod=GET, path=/, query a=1).
#   - GET /api/ping?x=1&x=2 -> path-routed to ApiFn, which sees the multi-value
#     query variant (multiValueQueryStringParameters present).
#   - Each Lambda target receives its declared Environment.Variables (GREETING),
#     proving issue #380's container-env wiring (resolveLambdaContainerEnv) for
#     ALB Lambda targets — before it, the runner injected only AWS_LAMBDA_* +
#     shell creds and GREETING echoed "unset".
#   - SIGTERM tears every container + network + front-door socket down.
#
#     bash tests/integration/local-start-alb-lambda/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
LAMBDA_IMAGE="public.ecr.aws/lambda/nodejs:20"
LB_HOST_PORT=18088 # non-privileged host port the front-door binds (listener port 80 remapped)

cleanup() {
  echo "==> Cleanup: stopping any leftover containers + networks"
  if [[ -n "${CDKL_PID:-}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKL_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Pre-test orphan sweep"
cleanup

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture Lambda base image"
docker pull "${LAMBDA_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT

echo "==> start-alb: naming the ALB (Lambda targets), front-door on host port ${LB_HOST_PORT}"
# Remap the privileged listener port 80 to a non-privileged host port so the
# front-door binds without root (the macOS Docker Desktop privileged-port path).
${CDKL} start-alb CdkLocalStartAlbLambdaFixture:AlbLB \
  --container-host 127.0.0.1 --lb-port "80=${LB_HOST_PORT}" \
  > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner (up to 120s)"
BOOTED=0
for _ in $(seq 1 120); do
  if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited before reaching the boot banner"
    echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: front-door did not reach the boot banner within 120s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi

echo "==> Asserting the front-door banner + the Lambda targets were logged"
if ! grep -q "ALB front-door: http://127.0.0.1:${LB_HOST_PORT}" "${OUT_FILE}"; then
  echo "FAIL: front-door banner for host port ${LB_HOST_PORT} not found"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
if ! grep -q "Lambda EchoFn" "${OUT_FILE}"; then
  echo "FAIL: EchoFn Lambda target not logged in the front-door routing table"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
if ! grep -q "path /api/\*" "${OUT_FILE}"; then
  echo "FAIL: path rule '/api/*' not logged in the front-door routing table"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: front-door banner + Lambda targets present"

echo "==> curl-ing /?a=1 until the front-door serves 200 (Lambda container takes a moment)"
READY=0
ROOT_RESP=""
for _ in $(seq 1 90); do
  ROOT_RESP=$(curl -fsS "http://127.0.0.1:${LB_HOST_PORT}/?a=1" 2>/dev/null || true)
  if [[ -n "${ROOT_RESP}" ]]; then
    READY=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited while waiting for the front-door to serve"
    echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${READY}" -ne 1 ]]; then
  echo "FAIL: front-door never served a 200 on /?a=1 within 90s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    / response: ${ROOT_RESP}"

echo "==> Asserting GET / reached the echo Lambda with the ALB Lambda-target event shape"
# The echo handler returns JSON with role/hasElbContext/httpMethod/path/query.
if ! echo "${ROOT_RESP}" | grep -q '"role":"lambda"'; then
  echo "FAIL: GET / did not reach the echo Lambda (no role:lambda in body)"
  exit 1
fi
if ! echo "${ROOT_RESP}" | grep -q '"hasElbContext":true'; then
  echo "FAIL: the Lambda did not receive requestContext.elb (ALB event shape)"
  exit 1
fi
if ! echo "${ROOT_RESP}" | grep -q '"httpMethod":"GET"'; then
  echo "FAIL: the Lambda event httpMethod was not GET"
  exit 1
fi
if ! echo "${ROOT_RESP}" | grep -q '"path":"/"'; then
  echo "FAIL: the Lambda event path was not '/'"
  exit 1
fi
if ! echo "${ROOT_RESP}" | grep -q '"a":"1"'; then
  echo "FAIL: the Lambda event did not carry queryStringParameters {a:1}"
  exit 1
fi
# Issue #380 — the ALB Lambda target's declared Environment.Variables now reach
# the container (via the shared resolveLambdaContainerEnv). Before this wiring
# the front-door runner injected only AWS_LAMBDA_* + shell creds, so GREETING
# would echo "unset"; assert the declared value flows through.
if ! echo "${ROOT_RESP}" | grep -q '"greeting":"hello"'; then
  echo "FAIL: EchoFn did not receive its declared env var GREETING=hello (got: ${ROOT_RESP})"
  exit 1
fi
echo "    OK: echo Lambda saw the ALB Lambda-target event (elb context + method + path + query + declared env)"

echo "==> Asserting the response headers were translated back to HTTP"
HEADERS=$(curl -fsS -D - -o /dev/null "http://127.0.0.1:${LB_HOST_PORT}/?a=1" 2>/dev/null || true)
if ! echo "${HEADERS}" | grep -qi 'x-handler: alb-lambda-fixture'; then
  echo "FAIL: the Lambda response header X-Handler was not relayed to the client"
  echo "${HEADERS}"
  exit 1
fi
echo "    OK: response headers relayed (X-Handler present)"

echo "==> Asserting GET /api/ping?x=1&x=2 is path-routed to ApiFn (multi-value query variant)"
API_RESP=""
for _ in $(seq 1 60); do
  API_RESP=$(curl -fsS "http://127.0.0.1:${LB_HOST_PORT}/api/ping?x=1&x=2" 2>/dev/null || true)
  if [[ -n "${API_RESP}" ]]; then break; fi
  sleep 1
done
echo "    /api/ping response: ${API_RESP}"
if ! echo "${API_RESP}" | grep -q '"path":"/api/ping"'; then
  echo "FAIL: /api/ping was not path-routed to a Lambda target (wrong path echoed)"
  exit 1
fi
# multi_value_headers.enabled=true -> the event uses multiValueQueryStringParameters.
if ! echo "${API_RESP}" | grep -q '"multiValueQueryStringParameters":{"x":\["1","2"\]}'; then
  echo "FAIL: ApiFn did not receive the multi-value query variant for the multi-value-headers TG"
  exit 1
fi
# Issue #380 — ApiFn's distinct declared env var reaches its container too (a
# per-target env, not a shared one), proving the resolve-per-Lambda wiring.
if ! echo "${API_RESP}" | grep -q '"greeting":"api-hello"'; then
  echo "FAIL: ApiFn did not receive its declared env var GREETING=api-hello (got: ${API_RESP})"
  exit 1
fi
echo "    OK: /api/ping path-routed to ApiFn with the multi-value query event variant + declared env"

echo "==> Sending SIGTERM to cdk-local (${CDKL_PID})"
kill -TERM "${CDKL_PID}"

echo "==> Waiting for cdk-local to exit (up to 60s)"
EXITED=0
for _ in $(seq 1 60); do
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then EXITED=1; break; fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdk-local did not exit within 60s after SIGTERM"
  kill -KILL "${CDKL_PID}" 2>/dev/null || true
  exit 1
fi
wait "${CDKL_PID}" 2>/dev/null || true
CDKL_PID=""

echo "==> Asserting clean teardown — no leftover containers"
LEFTOVER_CONTAINERS=$(docker ps -a --filter "name=cdkl-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_CONTAINERS} containers still present after SIGTERM"
  docker ps -a --filter "name=cdkl-" --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
  exit 1
fi

echo "==> Asserting clean teardown — no leftover networks"
LEFTOVER_NETS=$(docker network ls --filter "name=cdkl-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_NETS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_NETS} docker networks still present after SIGTERM"
  docker network ls --filter "name=cdkl-"
  exit 1
fi

echo "==> Asserting the front-door socket is closed"
if curl -fsS --max-time 2 "http://127.0.0.1:${LB_HOST_PORT}/" >/dev/null 2>&1; then
  echo "FAIL: front-door on host port ${LB_HOST_PORT} still accepting connections after SIGTERM"
  exit 1
fi

echo ""
echo "==> local-start-alb-lambda test passed (default -> EchoFn, /api/* -> ApiFn multi-value, declared env injected, clean teardown)"
