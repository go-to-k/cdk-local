#!/usr/bin/env bash
# verify.sh — local-start-alb-watch integ test
# (Phase 3 of issue #214 — ALB-fronted multi-replica rolling deploy
# + front-door pool swap)
#
# Exercises `cdkl start-alb --watch` end-to-end against an ALB whose
# default listener forwards to a 2-replica ECS service, asserting that
# a continuous HOST-SIDE curl loop against the listener port observes
# zero connection refusals across a rolling reload AND a v1 -> v2
# transition AND only v2 after the roll completes.
#
# Probe shape:
#   - A host-side bash loop calls `curl -sf http://127.0.0.1:<lb-port>/`
#     every ~50ms (using `--max-time 2`) and appends the response (or
#     `FAIL`) to a log file. The ALB front-door's reverse proxy
#     round-robins each request across the live replica pool; during a
#     roll, the pool transitions (old r0, old r1) -> (old r0, old r1,
#     shadow r0) -> (old r1, shadow r0) -> ... -> (shadow r0, shadow r1)
#     via single-assignment Map mutations in `FrontDoorEndpointPool`
#     (see `src/local/front-door-pool.ts`). A continuous curl probe must
#     see zero `FAIL` entries.
#
# What it proves:
#   1. Two replicas boot at gen 0, the ALB front-door binds the listener
#      port, and the service serves v1.
#   2. Editing `webapp/server.sh` (v1 -> v2) triggers a single reload.
#   3. The rolling primitive starts a shadow per replica under a bumped
#      generation suffix, swaps the front-door pool entry atomically,
#      then retires the old replica.
#   4. The probe captures BOTH v1 and v2 responses (proves the roll
#      reached every replica) AND zero `FAIL` lines (proves the
#      front-door pool was never empty across the swap).
#   5. After the roll completes, only v2 responses appear (proves the
#      OLD replicas are fully retired — no stale image survived).
#   6. SIGTERM tears every cdkl-* container + network + the front-door
#      server socket down cleanly.
#
# Run via `/run-integ local-start-alb-watch`. Requires Docker.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
LB_HOST_PORT=18087 # non-privileged host port the front-door binds (listener port 80 remapped)

SERVER_SH="webapp/server.sh"
SERVER_SH_BACKUP="$(mktemp)"
cp "${SERVER_SH}" "${SERVER_SH_BACKUP}"

LOG_FILE="$(mktemp)"
PROBE_LOG="$(mktemp)"
CDKL_PID=""
PROBE_PID=""

term_server() {
  if [[ -n "${CDKL_PID:-}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "==> Sending SIGTERM to cdk-local (pid ${CDKL_PID})"
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 180); do
      kill -0 "${CDKL_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${CDKL_PID}" 2>/dev/null; then
      echo "==> cdk-local did not exit within 180s; SIGKILL"
      kill -KILL "${CDKL_PID}" 2>/dev/null || true
    fi
  fi
}

stop_probe() {
  if [[ -n "${PROBE_PID:-}" ]] && kill -0 "${PROBE_PID}" 2>/dev/null; then
    kill -TERM "${PROBE_PID}" 2>/dev/null || true
    wait "${PROBE_PID}" 2>/dev/null || true
  fi
  PROBE_PID=""
}

restore_source() {
  if [[ -f "${SERVER_SH_BACKUP}" ]]; then
    cp "${SERVER_SH_BACKUP}" "${SERVER_SH}"
    rm -f "${SERVER_SH_BACKUP}"
  fi
}

cleanup() {
  stop_probe
  term_server
  restore_source
  docker ps -a --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -f "${LOG_FILE}" "${PROBE_LOG}"
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
rolling_swap_count() {
  # Match the per-replica reload completion log line. Two paths under
  # `--watch` write this line, both proving the rolling sequencer
  # touched each replica one at a time:
  #   - Phase 2/3 rebuild path: "Rolling replica r<i> (gen <g>): swap
  #     complete; old retired" / "...single-replica reload complete".
  #   - Phase 4 soft-reload path: "Soft-reloaded replica r<i> (gen <g>):
  #     restart + TCP-ready probe complete; registrations unchanged."
  # The fixture asserts the same per-replica completion count for either
  # path so a future heuristic flip doesn't false-fail.
  local n
  n=$(grep -cE \
    "Rolling replica .*(swap complete|single-replica reload complete)|Soft-reloaded replica .*restart \+ TCP-ready probe complete" \
    "${LOG_FILE}" 2>/dev/null) || n=0
  echo "${n}"
}

echo "==> Booting ALB-fronted 2-replica service with --watch (listener 80 -> host :${LB_HOST_PORT})"
${CDKL} start-alb CdkLocalStartAlbWatchFixture:WebLB \
  --watch \
  --no-pull \
  --container-host 127.0.0.1 \
  --lb-port "80=${LB_HOST_PORT}" \
  >"${LOG_FILE}" 2>&1 &
CDKL_PID=$!

echo "==> Waiting for boot banner (up to 240s; 2 replicas + asset build take longer)"
BOOTED=0
for _ in $(seq 1 240); do
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
  echo "FAIL: service did not reach the boot banner within 240s"
  cat "${LOG_FILE}"
  exit 1
fi

# Confirm both replicas booted at generation 0.
if ! grep -q "Booting replica 0" "${LOG_FILE}"; then
  echo "FAIL: expected to see 'Booting replica 0' in the boot log"
  cat "${LOG_FILE}"
  exit 1
fi
if ! grep -q "Booting replica 1" "${LOG_FILE}"; then
  echo "FAIL: expected to see 'Booting replica 1' in the boot log"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [2 replicas booted] OK"

# Confirm the ALB front-door listener is bound on the remapped host port.
if ! grep -qE "ALB front-door:.*://127\\.0\\.0\\.1:${LB_HOST_PORT} " "${LOG_FILE}"; then
  echo "FAIL: expected ALB front-door listener bound on 127.0.0.1:${LB_HOST_PORT}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [ALB front-door bound on 127.0.0.1:${LB_HOST_PORT}] OK"

# Host-side probe: every ~50ms, curl the ALB listener port and write
# the response (or `FAIL`) to PROBE_LOG. `--max-time 2` upper-bounds the
# wait so a misbehaving front-door does not stall the probe forever.
echo "==> Starting host-side probe (curl loop against the ALB listener port)"
(
  while true; do
    out=$(curl -sf --max-time 2 "http://127.0.0.1:${LB_HOST_PORT}/" 2>/dev/null) || out="FAIL"
    if [ -z "${out}" ]; then
      printf 'FAIL\n' >>"${PROBE_LOG}"
    else
      printf '%s\n' "${out}" >>"${PROBE_LOG}"
    fi
    sleep 0.05
  done
) &
PROBE_PID=$!

# Give the probe a moment to gather baseline samples.
sleep 2

# Snapshot the probe so far — only v1 (no edit yet), no FAIL.
BASELINE_V1=$(grep -c '^v1$' "${PROBE_LOG}" 2>/dev/null) || BASELINE_V1=0
BASELINE_FAIL=$(grep -c '^FAIL$' "${PROBE_LOG}" 2>/dev/null) || BASELINE_FAIL=0
echo "    baseline samples: v1=${BASELINE_V1}, FAIL=${BASELINE_FAIL}"
if [[ "${BASELINE_V1}" -lt 5 ]]; then
  echo "FAIL: probe captured fewer than 5 baseline v1 responses; the front-door may not have bound"
  echo "----- probe log -----"
  cat "${PROBE_LOG}"
  echo "----- cdkl log -----"
  cat "${LOG_FILE}"
  exit 1
fi
if [[ "${BASELINE_FAIL}" -ne 0 ]]; then
  echo "FAIL: probe captured FAIL responses BEFORE any reload — front-door wiring is broken"
  echo "----- probe log -----"
  cat "${PROBE_LOG}"
  exit 1
fi
echo "    [baseline: all v1, zero FAIL] OK"

echo "==> Editing webapp/server.sh (v1 -> v2) to trigger a rolling deploy"
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

echo "==> Waiting for the reload-complete marker (asset rebuild + 2 rolling swaps)"
COMPLETED=0
for _ in $(seq 1 360); do
  if [[ "$(reload_complete_count)" -ge 1 ]]; then
    COMPLETED=1
    break
  fi
  sleep 1
done
if [[ "${COMPLETED}" -eq 0 ]]; then
  echo "FAIL: reload did not complete within 360s"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [reload complete] OK"

# After the rolling reload, the runner logs `swap complete` per replica
# it rolled. We expect EXACTLY 2 swaps for a 2-replica service.
SWAPS=$(rolling_swap_count)
echo "==> Rolling swaps observed: ${SWAPS} (expect 2)"
if [[ "${SWAPS}" -ne 2 ]]; then
  echo "FAIL: expected 2 'swap complete' log lines, got ${SWAPS}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [2 swaps observed] OK"

# Give the probe a final moment to capture post-roll v2 responses.
sleep 2

echo "==> Stopping host-side probe"
stop_probe

# Aggregate: line counts per response category. Only count NON-EMPTY
# lines so a stray trailing newline does not turn into a phantom sample.
TOTAL_SAMPLES=$(grep -cE '^.+$' "${PROBE_LOG}" 2>/dev/null) || TOTAL_SAMPLES=0
V1_SAMPLES=$(grep -c '^v1$' "${PROBE_LOG}" 2>/dev/null) || V1_SAMPLES=0
V2_SAMPLES=$(grep -c '^v2$' "${PROBE_LOG}" 2>/dev/null) || V2_SAMPLES=0
FAIL_SAMPLES=$(grep -c '^FAIL$' "${PROBE_LOG}" 2>/dev/null) || FAIL_SAMPLES=0
OTHER_SAMPLES=$(( TOTAL_SAMPLES - V1_SAMPLES - V2_SAMPLES - FAIL_SAMPLES ))
echo "    probe transcript: total=${TOTAL_SAMPLES} v1=${V1_SAMPLES} v2=${V2_SAMPLES} FAIL=${FAIL_SAMPLES} other=${OTHER_SAMPLES}"

# Phase 3 acceptance criterion: zero connection refusals across the roll.
if [[ "${FAIL_SAMPLES}" -ne 0 ]]; then
  echo "FAIL: probe observed ${FAIL_SAMPLES} connection failure(s) during the rolling reload"
  echo "----- probe log (failures) -----"
  grep -nE '^FAIL$' "${PROBE_LOG}" | head -20
  echo "----- cdkl log -----"
  cat "${LOG_FILE}"
  exit 1
fi
if [[ "${OTHER_SAMPLES}" -ne 0 ]]; then
  echo "FAIL: probe observed ${OTHER_SAMPLES} unexpected response(s) (not v1/v2/FAIL)"
  grep -vE '^(v1|v2|FAIL)$' "${PROBE_LOG}" | grep -E '.+' | head -20
  exit 1
fi
echo "    [zero connection refusals across the roll] OK"

# Both v1 and v2 must appear: v1 from the baseline + early-roll window,
# v2 after each replica's swap lands.
if [[ "${V1_SAMPLES}" -lt 5 ]]; then
  echo "FAIL: expected at least 5 v1 responses in the transcript, got ${V1_SAMPLES}"
  exit 1
fi
if [[ "${V2_SAMPLES}" -lt 5 ]]; then
  echo "FAIL: expected at least 5 v2 responses in the transcript, got ${V2_SAMPLES}"
  exit 1
fi
echo "    [v1 -> v2 transition observed] OK"

# Post-roll: the LAST 20 samples must all be v2 (proves the OLD replicas
# are fully retired — no stale image survived after the roll).
TAIL_V1=$(tail -20 "${PROBE_LOG}" | grep -c '^v1$' 2>/dev/null) || TAIL_V1=0
if [[ "${TAIL_V1}" -ne 0 ]]; then
  echo "FAIL: ${TAIL_V1} of the last 20 probe samples were v1; old replicas were not fully retired"
  tail -20 "${PROBE_LOG}"
  exit 1
fi
echo "    [old replicas fully retired post-roll] OK"

echo "==> Sending SIGTERM to cdk-local"
kill -TERM "${CDKL_PID}"

echo "==> Waiting for cdk-local to exit (up to 90s)"
EXITED=0
for _ in $(seq 1 90); do
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    EXITED=1
    break
  fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdk-local did not exit within 90s after SIGTERM"
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

echo "==> Asserting clean teardown — listener port released"
if lsof -nP -iTCP:"${LB_HOST_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FAIL: host port ${LB_HOST_PORT} still bound after SIGTERM"
  lsof -nP -iTCP:"${LB_HOST_PORT}" -sTCP:LISTEN
  exit 1
fi

echo ""
echo "==> All local-start-alb-watch smoke tests passed"
