#!/usr/bin/env bash
# verify.sh — cdkl start-alb WebSocket Upgrade proxy integ test (#176, no AWS deploy)
#
# Names an Application Load Balancer with two listeners on the same synthetic
# ALB:
#   - Listener 80 -> ECS forward TG (DesiredCount=2 Python websockets echo).
#   - Listener 81 -> Lambda forward TG (plain HTTP handler).
# Asserts:
#   - The host-side ALB front-door comes up on both --lb-port host ports.
#   - Test 1: a WebSocket upgrade against the ECS listener completes the
#     handshake (HTTP/1.1 101) and a sent frame is echoed back verbatim.
#   - Test 2: a WebSocket upgrade against the Lambda listener is refused with
#     HTTP/1.1 502 (mirrors ALB itself — Lambda TGs do not support WebSocket).
#   - SIGTERM tears every container + network + front-door socket down.
#
#     bash tests/integration/local-start-alb-websocket/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
PYTHON_IMAGE="public.ecr.aws/docker/library/python:3.12-alpine"
LAMBDA_IMAGE="public.ecr.aws/lambda/nodejs:20"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
LB_ECS_PORT=18176   # non-privileged host port for ALB listener 80 (ECS)
LB_LAMBDA_PORT=18177 # non-privileged host port for ALB listener 81 (Lambda)

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

echo "==> Pulling fixture images"
docker pull "${PYTHON_IMAGE}"
docker pull "${LAMBDA_IMAGE}"
docker pull "${SIDECAR_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

OUT_FILE=$(mktemp)
CLIENT_SCRIPT="$(pwd)/.ws-client.mjs"
trap 'rm -f "${OUT_FILE}" "${CLIENT_SCRIPT}"; cleanup' EXIT

# The WebSocket client lives inside the fixture directory so `import 'ws'`
# resolves against the fixture's pnpm-installed node_modules. The script has
# two modes:
#   echo   -- open a ws:// connection, send a message, assert the echo, exit 0.
#   refuse -- open a ws:// connection, assert the server returned a non-101
#             response with the expected status code, exit 0.
cat > "${CLIENT_SCRIPT}" <<'NODE'
import { WebSocket } from 'ws';

const [, , mode, url, payloadOrStatus] = process.argv;
if (!mode || !url) {
  console.error('Usage: .ws-client.mjs <echo|refuse> <ws-url> <payload|expected-status>');
  process.exit(2);
}

function timeout(ms, label) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms waiting for ${label}`)), ms)
  );
}

async function echoMode() {
  const payload = payloadOrStatus ?? 'hello-ws';
  const ws = new WebSocket(url);
  const echoed = await Promise.race([
    new Promise((resolve, reject) => {
      let greetingSeen = false;
      ws.on('open', () => {
        // Wait one frame for the server's "ready <host>" greeting,
        // then send our payload and resolve on the echo.
      });
      ws.on('message', (data) => {
        const text = data.toString('utf-8');
        if (!greetingSeen) {
          greetingSeen = true;
          if (!text.startsWith('ready ')) {
            reject(new Error(`expected greeting prefix 'ready ', got: ${text}`));
            return;
          }
          ws.send(payload);
          return;
        }
        resolve(text);
        ws.close();
      });
      ws.on('error', reject);
    }),
    timeout(30_000, 'WS echo'),
  ]);
  if (echoed !== payload) {
    console.error(`FAIL: echoed payload mismatch. sent=${payload} got=${echoed}`);
    process.exit(1);
  }
  console.log(`echo OK: ${echoed}`);
}

async function refuseMode() {
  const expectedStatus = Number.parseInt(payloadOrStatus ?? '502', 10);
  const ws = new WebSocket(url);
  const status = await Promise.race([
    new Promise((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('expected the front-door to REFUSE the upgrade, but it completed (101)'));
      });
      ws.on('error', (err) => {
        // Swallowed: `unexpected-response` resolves first; if we get here
        // without that path, surface the error.
        setTimeout(() => reject(err), 100);
      });
    }),
    timeout(30_000, 'WS refuse'),
  ]);
  if (status !== expectedStatus) {
    console.error(`FAIL: expected HTTP ${expectedStatus}, got HTTP ${status}`);
    process.exit(1);
  }
  console.log(`refuse OK: HTTP ${status}`);
}

if (mode === 'echo') {
  await echoMode();
} else if (mode === 'refuse') {
  await refuseMode();
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
NODE

echo "==> start-alb: naming the ALB (2 listeners; ECS + Lambda), front-door on host ports ${LB_ECS_PORT}/${LB_LAMBDA_PORT}"
# Remap both privileged listener ports to non-privileged host ports so the
# front-door binds without root (the macOS Docker Desktop privileged-port path).
${CDKL} start-alb CdkLocalStartAlbWebSocketFixture:WsLB \
  --container-host 127.0.0.1 \
  --lb-port "80=${LB_ECS_PORT}" \
  --lb-port "81=${LB_LAMBDA_PORT}" \
  > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner (up to 180s — websockets wheel install on cold container)"
BOOTED=0
for _ in $(seq 1 180); do
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
  echo "FAIL: front-door did not reach the boot banner within 180s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi

echo "==> Asserting both front-door banners were logged"
if ! grep -q "ALB front-door: http://127.0.0.1:${LB_ECS_PORT}" "${OUT_FILE}"; then
  echo "FAIL: ECS-listener front-door banner for host port ${LB_ECS_PORT} not found"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
if ! grep -q "ALB front-door: http://127.0.0.1:${LB_LAMBDA_PORT}" "${OUT_FILE}"; then
  echo "FAIL: Lambda-listener front-door banner for host port ${LB_LAMBDA_PORT} not found"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: both front-door banners present"

echo "==> Waiting for the WebSocket echo server to accept connections (replicas pip-install + start)"
# Probe via a real WS handshake — the upstream `websockets` server does NOT
# answer plain HTTP GET cleanly (it drops the TCP connection on a malformed
# upgrade), so an HTTP probe is unreliable. The probe script exits 0 as soon
# as the upgrade completes (the server even sends a `ready <host>` greeting
# frame, which is enough to confirm bridging).
PROBE_SCRIPT="$(pwd)/.ws-probe.mjs"
trap 'rm -f "${OUT_FILE}" "${CLIENT_SCRIPT}" "${PROBE_SCRIPT}"; cleanup' EXIT
cat > "${PROBE_SCRIPT}" <<'NODE'
import { WebSocket } from 'ws';
const url = process.argv[2];
const ws = new WebSocket(url);
ws.on('open', () => { ws.close(); process.exit(0); });
ws.on('message', () => { ws.close(); process.exit(0); });
ws.on('error', () => process.exit(1));
ws.on('unexpected-response', () => process.exit(1));
setTimeout(() => process.exit(2), 3000);
NODE

READY=0
for _ in $(seq 1 180); do
  if node "${PROBE_SCRIPT}" "ws://127.0.0.1:${LB_ECS_PORT}/" 2>/dev/null; then
    READY=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited while waiting for the upstream WS server to come up"
    echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${READY}" -ne 1 ]]; then
  echo "FAIL: upstream WS server never reached a serving state within 180s"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: upstream WS handshake completes (front-door bridges to a live replica)"

echo "==> Test 1 — WebSocket upgrade to the ECS listener echoes a frame"
if ! node "${CLIENT_SCRIPT}" echo "ws://127.0.0.1:${LB_ECS_PORT}/" "alb-ws-payload"; then
  echo "FAIL: ECS WS echo round-trip did not complete"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: ECS forward target bridged the WS upgrade and echoed the frame"

echo "==> Test 2 — WebSocket upgrade to the Lambda listener is refused with HTTP 502"
if ! node "${CLIENT_SCRIPT}" refuse "ws://127.0.0.1:${LB_LAMBDA_PORT}/" 502; then
  echo "FAIL: Lambda listener did not refuse the WS upgrade with 502"
  echo "----- service output -----"; cat "${OUT_FILE}"; echo "--------------------------"
  exit 1
fi
echo "    OK: Lambda target group refused the upgrade with 502 over the raw socket"

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

echo "==> Asserting the front-door sockets are closed"
if curl -fsS --max-time 2 "http://127.0.0.1:${LB_ECS_PORT}/" >/dev/null 2>&1; then
  echo "FAIL: ECS-listener front-door on host port ${LB_ECS_PORT} still accepting connections after SIGTERM"
  exit 1
fi
if curl -fsS --max-time 2 "http://127.0.0.1:${LB_LAMBDA_PORT}/" >/dev/null 2>&1; then
  echo "FAIL: Lambda-listener front-door on host port ${LB_LAMBDA_PORT} still accepting connections after SIGTERM"
  exit 1
fi

echo ""
echo "==> local-start-alb-websocket test passed (ECS upgrade echoes; Lambda upgrade -> 502; clean teardown)"
