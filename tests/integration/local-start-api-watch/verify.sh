#!/usr/bin/env bash
# verify.sh — local-start-api-watch integ test
#
# Exercises `cdkl start-api --watch` end-to-end against Docker + the AWS
# Lambda Node.js base image (which bundles RIE). Deploys nothing.
#
# What it proves:
#   1. Editing the CDK app's Lambda SOURCE (not cdk.out) re-synths and
#      hot-reloads — the served response changes from v1 to v2 without a
#      server restart.
#   2. Loop-safety: the reload's own re-synth writes into cdk.out/ do NOT
#      re-trigger the watcher. Exactly ONE reload fires per source edit.
#   3. cdk.json `watch.exclude` is honored: touching an excluded path
#      (a *.md file) triggers no reload.
#
# Run via `/run-integ local-start-api-watch` (recommended) or directly:
#
#     bash tests/integration/local-start-api-watch/verify.sh
#
# Requires Docker.
#
# Robust cleanup: SIGTERM -> 120s grace -> SIGKILL on the server, plus a
# defense-in-depth `docker ps --filter name=cdkl-` sweep, plus restoring
# the Lambda handler source the test mutates so the git tree stays clean.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3939

HANDLER="lambda-ping/index.js"
HANDLER_BACKUP="$(mktemp)"
cp "${HANDLER}" "${HANDLER_BACKUP}"
PROBE_EXCLUDED="probe-excluded.md"

LOG_FILE="$(mktemp)"
SERVER_PID=""

term_server() {
  local pid="$1" label="$2"
  if [[ -n "${pid:-}" ]] && kill -0 "${pid}" 2>/dev/null; then
    echo "==> Sending SIGTERM to ${label} (pid ${pid})"
    kill -TERM "${pid}" 2>/dev/null || true
    for _ in $(seq 1 120); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${pid}" 2>/dev/null; then
      echo "==> ${label} did not exit within 120s; SIGKILL"
      kill -KILL "${pid}" 2>/dev/null || true
    fi
  fi
}

restore_handler() {
  # Put the committed v1 source back so the working tree is unchanged
  # whether the test passed, failed, or was interrupted mid-edit.
  if [[ -f "${HANDLER_BACKUP}" ]]; then
    cp "${HANDLER_BACKUP}" "${HANDLER}"
    rm -f "${HANDLER_BACKUP}"
  fi
  rm -f "${PROBE_EXCLUDED}"
}

cleanup() {
  term_server "${SERVER_PID:-}" "server"
  restore_handler
  ORPHANS=$(docker ps --filter "name=cdkl-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "==> Cleaning up orphan containers"
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT INT TERM

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# 127.0.0.1 (not host.docker.internal) — matches the other start-api
# integs so the test works on any docker daemon, not just Docker Desktop.
CONTAINER_HOST="127.0.0.1"

reload_count() {
  local n
  n=$(grep -c "Detected source change" "${LOG_FILE}" 2>/dev/null) || n=0
  echo "${n}"
}

echo "==> Starting cdkl start-api --watch on port ${PORT}"
${CDKL} start-api \
  --watch \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  --no-pull \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

echo "==> Waiting for the server to come up"
READY=0
for _ in $(seq 1 60); do
  count=$(grep -c "Server listening" "${LOG_FILE}" 2>/dev/null) || count=0
  if [[ "${count}" -ge 1 ]]; then
    READY=1
    break
  fi
  sleep 0.5
done
if [[ "${READY}" -eq 0 ]]; then
  echo "FAIL: server did not come up within 30s. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

echo "==> Server log preview:"
head -30 "${LOG_FILE}" | sed 's/^/    /'

# The boot line must name source-tree watching (not cdk.out watching).
if ! grep -q "for source changes" "${LOG_FILE}"; then
  echo "FAIL: startup did not announce source-tree watching. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

URL="http://127.0.0.1:${PORT}/"

# Poll a URL until the response body contains a needle, or fail. Cold
# RIE container boot is slow (~3-5s) on the first request, and after a
# reload the swapped-in container is cold again.
curl_until() {
  local label="$1" url="$2" needle="$3" tries="$4"
  local response=""
  for _ in $(seq 1 "${tries}"); do
    if response=$(curl -sf "${url}" 2>&1); then
      if echo "${response}" | grep -q "${needle}"; then
        echo "    [${label}] OK"
        return 0
      fi
    fi
    sleep 1
  done
  echo "FAIL: ${label} never matched '${needle}'. Last response: ${response}"
  cat "${LOG_FILE}"
  return 1
}

echo "==> Asserting the handler serves v1 before any edit"
curl_until "GET / (v1)" "${URL}" '"version":"v1"' 15

RELOADS_BEFORE_EDIT="$(reload_count)"
echo "==> Reload count before edit: ${RELOADS_BEFORE_EDIT} (expect 0)"
if [[ "${RELOADS_BEFORE_EDIT}" != "0" ]]; then
  echo "FAIL: a reload fired before any source edit. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

echo "==> Editing Lambda source (v1 -> v2) to trigger a hot reload"
cat >"${HANDLER}" <<'EOF'
// Ping handler for the local-start-api-watch integ fixture (mutated to v2).
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ functionUrl: true, version: 'v2' }),
  };
};
EOF

echo "==> Asserting the watcher detected the source change"
DETECTED=0
for _ in $(seq 1 60); do
  if [[ "$(reload_count)" -ge 1 ]]; then
    DETECTED=1
    break
  fi
  sleep 0.5
done
if [[ "${DETECTED}" -eq 0 ]]; then
  echo "FAIL: source edit did not trigger a reload within 30s. Log:"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [source change detected] OK"

echo "==> Asserting the handler now serves v2 (re-synth + container swap)"
curl_until "GET / (v2)" "${URL}" '"version":"v2"' 40

# Loop-safety: the reload re-synths INTO cdk.out/, which is excluded from
# the watch. Those writes must NOT re-trigger the watcher. Give any
# runaway loop a few seconds to manifest, then assert exactly one reload.
echo "==> Asserting loop-safety (re-synth writes do not re-trigger the watcher)"
sleep 4
RELOADS_AFTER_EDIT="$(reload_count)"
echo "    reload count after one edit: ${RELOADS_AFTER_EDIT} (expect 1)"
if [[ "${RELOADS_AFTER_EDIT}" != "1" ]]; then
  echo "FAIL: expected exactly 1 reload, got ${RELOADS_AFTER_EDIT} (cdk.out writes likely re-triggered the watcher). Log:"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [loop-safe: exactly 1 reload] OK"

# Excluded path: cdk.json watch.exclude lists *.md. Writing one must NOT
# trigger a reload.
echo "==> Asserting watch.exclude is honored (*.md write triggers no reload)"
echo "excluded change at $(date)" >"${PROBE_EXCLUDED}"
sleep 3
RELOADS_AFTER_EXCLUDED="$(reload_count)"
echo "    reload count after excluded write: ${RELOADS_AFTER_EXCLUDED} (expect 1)"
if [[ "${RELOADS_AFTER_EXCLUDED}" != "1" ]]; then
  echo "FAIL: an excluded (*.md) write triggered a reload. Log:"
  cat "${LOG_FILE}"
  exit 1
fi
rm -f "${PROBE_EXCLUDED}"
echo "    [watch.exclude honored] OK"

echo ""
echo "==> All local-start-api-watch smoke tests passed"
