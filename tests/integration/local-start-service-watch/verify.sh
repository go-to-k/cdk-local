#!/usr/bin/env bash
# verify.sh — local-start-service-watch integ test
# (Phase 1 of issue #214 — single-replica rebuild-on-change)
#
# Exercises `cdkl start-service --watch` end-to-end against real Docker.
# Deploys nothing.
#
# What it proves:
#   1. Editing the CDK app's asset SOURCE (webapp/server.sh) re-synths,
#      rebuilds the asset image, and replaces the single replica — the
#      served response changes from v1 to v2 without a `^C` / re-launch.
#   2. Loop-safety: the reload's own re-synth writes into cdk.out/ do
#      NOT re-trigger the watcher. Exactly ONE reload fires per source
#      edit.
#   3. cdk.json `watch.exclude` is honored: touching an excluded path
#      (a *.md file) triggers no reload.
#   4. Clean teardown on SIGTERM: no leftover cdkl-* containers /
#      networks after the emulator exits.
#
# Run via `/run-integ local-start-service-watch` (recommended) or
# directly:
#
#     bash tests/integration/local-start-service-watch/verify.sh
#
# Requires Docker.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"
HOST_PORT=8086

SERVER_SH="webapp/server.sh"
SERVER_SH_BACKUP="$(mktemp)"
cp "${SERVER_SH}" "${SERVER_SH_BACKUP}"
PROBE_EXCLUDED="probe-excluded.md"

LOG_FILE="$(mktemp)"
CDKL_PID=""

term_server() {
  if [[ -n "${CDKL_PID:-}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "==> Sending SIGTERM to cdk-local (pid ${CDKL_PID})"
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do
      kill -0 "${CDKL_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${CDKL_PID}" 2>/dev/null; then
      echo "==> cdk-local did not exit within 120s; SIGKILL"
      kill -KILL "${CDKL_PID}" 2>/dev/null || true
    fi
  fi
}

restore_source() {
  # Put the committed v1 source back so the working tree is unchanged
  # whether the test passed, failed, or was interrupted mid-edit.
  if [[ -f "${SERVER_SH_BACKUP}" ]]; then
    cp "${SERVER_SH_BACKUP}" "${SERVER_SH}"
    rm -f "${SERVER_SH_BACKUP}"
  fi
  rm -f "${PROBE_EXCLUDED}"
}

cleanup() {
  term_server
  restore_source
  docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT INT TERM

# Pre-test orphan sweep — a failed previous run can leak cdkl-* state.
echo "==> Pre-test orphan sweep"
docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
  | xargs -r docker rm -f >/dev/null 2>&1 || true
docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
  | xargs -r docker network rm >/dev/null 2>&1 || true

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

reload_count() {
  local n
  n=$(grep -c "Detected source change" "${LOG_FILE}" 2>/dev/null) || n=0
  echo "${n}"
}

reload_complete_count() {
  local n
  n=$(grep -c "Reload complete" "${LOG_FILE}" 2>/dev/null) || n=0
  echo "${n}"
}

echo "==> Booting service (DesiredCount=1) with --watch on host port ${HOST_PORT}"
${CDKL} start-service CdkLocalStartServiceWatchFixture:WebService \
  --watch \
  --no-pull \
  --host-port "8080=${HOST_PORT}" \
  --container-host 127.0.0.1 \
  >"${LOG_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner (up to 180s; first boot builds the asset image)"
BOOTED=0
for _ in $(seq 1 180); do
  if grep -q "Service(s) running:" "${LOG_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited before reaching the boot banner"
    echo "----- service output -----"
    cat "${LOG_FILE}"
    echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: service did not reach the boot banner within 180s"
  echo "----- service output -----"
  cat "${LOG_FILE}"
  echo "--------------------------"
  exit 1
fi

# The boot line must name source-tree watching (not cdk.out watching).
if ! grep -q "for source changes" "${LOG_FILE}"; then
  echo "FAIL: startup did not announce source-tree watching"
  cat "${LOG_FILE}"
  exit 1
fi

URL="http://127.0.0.1:${HOST_PORT}/"

# Poll a URL until the response body contains a needle, or fail. busybox
# httpd is fork-per-request but the first request after replica boot
# races docker's port mapping — retry generously.
curl_until() {
  local label="$1" url="$2" needle="$3" tries="$4"
  local response=""
  for _ in $(seq 1 "${tries}"); do
    if response=$(curl -sf --max-time 3 "${url}" 2>&1); then
      if echo "${response}" | grep -q "${needle}"; then
        echo "    [${label}] OK (response: ${response})"
        return 0
      fi
    fi
    sleep 1
  done
  echo "FAIL: ${label} never matched '${needle}'. Last response: '${response}'"
  echo "----- service output -----"
  cat "${LOG_FILE}"
  echo "--------------------------"
  return 1
}

echo "==> Asserting the service serves v1 before any edit"
curl_until "GET / (v1)" "${URL}" '^v1$' 60

RELOADS_BEFORE_EDIT="$(reload_count)"
echo "==> Reload count before edit: ${RELOADS_BEFORE_EDIT} (expect 0)"
if [[ "${RELOADS_BEFORE_EDIT}" != "0" ]]; then
  echo "FAIL: a reload fired before any source edit"
  cat "${LOG_FILE}"
  exit 1
fi

echo "==> Editing webapp/server.sh (v1 -> v2) to trigger a hot reload"
cat >"${SERVER_SH}" <<'EOF'
#!/bin/sh
# server.sh — mutated to v2 by verify.sh
set -eu
VERSION=v2
mkdir -p /www
printf '%s' "${VERSION}" > /www/index.html
exec httpd -f -p 8080 -h /www
EOF
chmod +x "${SERVER_SH}"

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
  echo "FAIL: source edit did not trigger a reload within 30s"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [source change detected] OK"

echo "==> Waiting for the reload-complete marker"
COMPLETED=0
for _ in $(seq 1 180); do
  if [[ "$(reload_complete_count)" -ge 1 ]]; then
    COMPLETED=1
    break
  fi
  sleep 1
done
if [[ "${COMPLETED}" -eq 0 ]]; then
  echo "FAIL: reload did not complete within 180s"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [reload complete] OK"

echo "==> Asserting the service now serves v2 (re-synth + asset rebuild + replica swap)"
curl_until "GET / (v2)" "${URL}" '^v2$' 60

# Loop-safety: the reload re-synths INTO cdk.out/, which is excluded from
# the watch. Those writes must NOT re-trigger the watcher. Give any
# runaway loop a few seconds to manifest, then assert exactly one reload.
echo "==> Asserting loop-safety (re-synth writes do not re-trigger the watcher)"
sleep 4
RELOADS_AFTER_EDIT="$(reload_count)"
echo "    reload count after one edit: ${RELOADS_AFTER_EDIT} (expect 1)"
if [[ "${RELOADS_AFTER_EDIT}" != "1" ]]; then
  echo "FAIL: expected exactly 1 reload, got ${RELOADS_AFTER_EDIT} (cdk.out writes likely re-triggered the watcher)"
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
  echo "FAIL: an excluded (*.md) write triggered a reload"
  cat "${LOG_FILE}"
  exit 1
fi
rm -f "${PROBE_EXCLUDED}"
echo "    [watch.exclude honored] OK"

echo "==> Sending SIGTERM to cdk-local"
kill -TERM "${CDKL_PID}"

echo "==> Waiting for cdk-local to exit (up to 60s)"
EXITED=0
for _ in $(seq 1 60); do
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    EXITED=1
    break
  fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdk-local did not exit within 60s after SIGTERM"
  cat "${LOG_FILE}"
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

echo ""
echo "==> All local-start-service-watch smoke tests passed"
