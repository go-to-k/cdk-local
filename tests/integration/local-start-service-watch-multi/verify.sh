#!/usr/bin/env bash
# verify.sh — local-start-service-watch-multi integ test
# (Phase 2 of issue #214 — multi-replica rolling deploy)
#
# Exercises `cdkl start-service --watch` end-to-end against a 2-replica
# service with Service Connect, asserting that a continuous external
# probe observes zero connection refusals across a rolling reload.
# Deploys nothing.
#
# Probe shape:
#   - A busybox sidecar joined to the same cdkl-svc docker network
#     resolves the service via the Service Connect DNS alias `srv`
#     (Docker's embedded DNS round-robins between the live replicas
#     carrying `--network-alias srv`). Every ~50ms the sidecar wgets
#     `http://srv:8080/` and appends the response (or `FAIL`) to its
#     own stdout, which `docker logs` reads back at the end.
#
# What it proves:
#   1. Two replicas boot at gen 0; the service serves v1.
#   2. Editing `webapp/server.sh` (v1 -> v2) triggers a single reload.
#   3. The rolling primitive starts a shadow replica per logical slot
#      under a bumped generation suffix, atomically swaps Cloud Map /
#      Docker DNS pointers, then retires the old replica.
#   4. The probe captures BOTH v1 and v2 responses (proves the roll
#      reached every replica) AND zero `FAIL` lines (proves the
#      service stayed available end-to-end across the roll).
#   5. After the roll completes, only v2 responses appear (proves the
#      OLD replicas are fully retired — no stale image survived).
#   6. SIGTERM tears down every cdkl-* container + network cleanly.
#
# Run via `/run-integ local-start-service-watch-multi`. Requires Docker.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"
PROBE_CONTAINER="cdkl-integ-svc-watch-multi-probe"

SERVER_SH="webapp/server.sh"
SERVER_SH_BACKUP="$(mktemp)"
cp "${SERVER_SH}" "${SERVER_SH_BACKUP}"

LOG_FILE="$(mktemp)"
PROBE_LOG="$(mktemp)"
CDKL_PID=""

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
  if docker ps -a --filter "name=${PROBE_CONTAINER}" --format '{{.Names}}' | grep -q .; then
    docker rm -f "${PROBE_CONTAINER}" >/dev/null 2>&1 || true
  fi
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
rolling_swap_count() {
  # Match the per-replica reload completion log line. Two paths under
  # `--watch` write this line, both proving the rolling sequencer
  # touched each replica one at a time:
  #   - Phase 2/3 rebuild path: "Rolling replica r<i> (gen <g>): swap
  #     complete; old retired" (multi-replica) or
  #     "Rolling replica r<i> (gen <g>): single-replica reload complete"
  #     (single-replica degenerate path).
  #   - Phase 4 soft-reload path: "Soft-reloaded replica r<i> (gen <g>):
  #     restart + TCP-ready probe complete; registrations unchanged."
  #     Source-only edits route through this branch (no `docker build`).
  # The fixture asserts the same per-replica completion count for either
  # path so a future heuristic flip from rebuild → soft-reload (or the
  # other way around) for the `webapp/server.sh` edit doesn't false-fail.
  local n
  n=$(grep -cE \
    "Rolling replica .*(swap complete|single-replica reload complete)|Soft-reloaded replica .*restart \+ TCP-ready probe complete" \
    "${LOG_FILE}" 2>/dev/null) || n=0
  echo "${n}"
}

echo "==> Booting 2-replica service with --watch"
${CDKL} start-service CdkLocalStartServiceWatchMultiFixture:WebService \
  --watch \
  --no-pull \
  --container-host 127.0.0.1 \
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

# Discover the shared cdkl-svc network so we can attach the probe sidecar.
SHARED_NET=$(docker network ls --filter "name=cdkl-svc-" --format '{{.Name}}' | head -1)
if [[ -z "${SHARED_NET}" ]]; then
  echo "FAIL: no cdkl-svc-* network found after boot"
  docker network ls --format 'table {{.ID}}\t{{.Name}}'
  exit 1
fi
echo "==> Shared service network: ${SHARED_NET}"

# Probe sidecar: every ~50ms, wget the Service Connect alias `srv` and
# print the response (or `FAIL`) to its own stdout. `docker logs` reads
# back the full transcript at the end.
echo "==> Starting probe sidecar (busybox, wget loop against http://srv:8080/)"
docker run -d --rm --network "${SHARED_NET}" --name "${PROBE_CONTAINER}" \
  "${BUSYBOX_IMAGE}" \
  sh -c 'while true; do out=$(wget -q -O - --timeout=2 http://srv:8080/ 2>&1); if [ -z "$out" ]; then echo FAIL; else echo "$out"; fi; sleep 0.05; done' \
  >/dev/null

# Give the probe a moment to gather baseline samples.
sleep 2

# Snapshot the probe so far — it should ONLY have v1 responses (no edit yet).
BASELINE=$(docker logs "${PROBE_CONTAINER}" 2>&1 || true)
BASELINE_FAIL=$(printf '%s\n' "${BASELINE}" | grep -c '^FAIL$' || true)
BASELINE_V1=$(printf '%s\n' "${BASELINE}" | grep -c '^v1$' || true)
echo "    baseline samples: v1=${BASELINE_V1}, FAIL=${BASELINE_FAIL}"
if [[ "${BASELINE_V1}" -lt 5 ]]; then
  echo "FAIL: probe captured fewer than 5 baseline v1 responses; the Service Connect DNS alias may not be wired"
  echo "----- probe log -----"
  echo "${BASELINE}"
  echo "----- cdkl log -----"
  cat "${LOG_FILE}"
  exit 1
fi
if [[ "${BASELINE_FAIL}" -ne 0 ]]; then
  echo "FAIL: probe captured FAIL responses BEFORE any reload — Service Connect DNS or probe wiring is broken"
  echo "----- probe log -----"
  echo "${BASELINE}"
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

echo "==> Stopping probe sidecar and capturing transcript"
PROBE_OUT=$(docker logs "${PROBE_CONTAINER}" 2>&1 || true)
docker rm -f "${PROBE_CONTAINER}" >/dev/null 2>&1 || true

# Aggregate: line counts per response category. Only count NON-EMPTY
# lines (a trailing blank from `docker logs` would otherwise inflate
# the total and turn into a spurious `other` sample).
TOTAL_SAMPLES=$(printf '%s\n' "${PROBE_OUT}" | grep -cE '^.+$')
V1_SAMPLES=$(printf '%s\n' "${PROBE_OUT}" | grep -c '^v1$' || true)
V2_SAMPLES=$(printf '%s\n' "${PROBE_OUT}" | grep -c '^v2$' || true)
# Treat ANY line that names a connection / network failure as FAIL,
# not just the exact `FAIL` sentinel — wget under load occasionally
# spills its own stderr ("can't connect to remote host", "wget: bad
# address", "Network is unreachable") and those are real connection
# refusals dressed up as multi-line output, not benign noise.
FAIL_SAMPLES=$(printf '%s\n' "${PROBE_OUT}" | grep -cE '^(FAIL|wget: |.*[Cc]onnection refused|.*[Nn]etwork is unreachable|.*bad address)' || true)
# "Other" is anything that wasn't v1, v2, or a counted failure. Real
# unknown payloads (e.g. a v3 marker after a Phase-3-shaped second
# edit, or a partial-write from the asset rebuild) would land here.
OTHER_SAMPLES=$(( TOTAL_SAMPLES - V1_SAMPLES - V2_SAMPLES - FAIL_SAMPLES ))
echo "    probe transcript: total=${TOTAL_SAMPLES} v1=${V1_SAMPLES} v2=${V2_SAMPLES} FAIL=${FAIL_SAMPLES} other=${OTHER_SAMPLES}"

# Phase 2 acceptance criterion: zero connection refusals across the roll.
if [[ "${FAIL_SAMPLES}" -ne 0 ]]; then
  echo "FAIL: probe observed ${FAIL_SAMPLES} connection failure(s) during the rolling reload"
  echo "----- probe log (failures only) -----"
  printf '%s\n' "${PROBE_OUT}" | grep -E '^(FAIL|wget: |.*[Cc]onnection refused|.*[Nn]etwork is unreachable|.*bad address)' | head -20
  echo "----- cdkl log -----"
  cat "${LOG_FILE}"
  exit 1
fi
if [[ "${OTHER_SAMPLES}" -ne 0 ]]; then
  echo "FAIL: probe observed ${OTHER_SAMPLES} unexpected response(s) (not v1/v2/connection-failure)"
  printf '%s\n' "${PROBE_OUT}" \
    | grep -vE '^(v1|v2|FAIL|wget: |.*[Cc]onnection refused|.*[Nn]etwork is unreachable|.*bad address)$' \
    | grep -E '.+' \
    | head -20
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

# Post-roll: the LAST 20 samples should all be v2 (proves the OLD replicas
# are fully retired — no stale image survived after the roll).
TAIL_V1=$(printf '%s\n' "${PROBE_OUT}" | tail -20 | grep -c '^v1$' || true)
if [[ "${TAIL_V1}" -ne 0 ]]; then
  echo "FAIL: ${TAIL_V1} of the last 20 probe samples were v1; old replicas were not fully retired"
  printf '%s\n' "${PROBE_OUT}" | tail -20
  exit 1
fi
echo "    [old replicas fully retired post-roll] OK"

echo "==> Sending SIGTERM to cdk-local"
kill -TERM "${CDKL_PID}"

echo "==> Waiting for cdk-local to exit (up to 90s; 2 replicas + the retired shadow generation take longer to tear down)"
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

echo ""
echo "==> All local-start-service-watch-multi smoke tests passed"
