#!/usr/bin/env bash
# verify.sh — cdkl start-service Phase 2 integ test (no AWS deploy)
#
# Boots a 2-replica ECS Service emulator backed by busybox heartbeat
# containers. Asserts both replicas reach docker, then SIGTERMs cdk-local and
# asserts clean teardown (no leftover containers / networks / sidecars).
#
#     bash tests/integration/local-start-service/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

# Orphan sweep — always runs even if the service was already killed.
cleanup() {
  echo "==> Cleanup: stopping any leftover containers + networks"
  if [[ -n "${CDKL2_PID:-}" ]] && kill -0 "${CDKL2_PID}" 2>/dev/null; then
    kill -TERM "${CDKL2_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKL2_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${CDKL2_PID}" 2>/dev/null || true
  fi
  if [[ -n "${CDKL_PID:-}" ]] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    # Give cdk-local up to 30s to clean up gracefully.
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

# Pre-test orphan sweep — a failed previous run can leak cdkl-*
# containers / networks, and the new per-replica subnet-isolation assertion
# below counts every cdkl-* network, so a stranded network from the
# previous run would either inflate NET_COUNT or surface a duplicate-subnet
# false positive. Run cleanup() once at boot to guarantee a clean baseline;
# the function is idempotent (xargs -r over empty input, kill -0 short-circuit
# on the unset CDKL_PID) so it's safe to invoke without any state populated.
echo "==> Pre-test orphan sweep"
cleanup

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi


# Capture the service output so we can grep for the boot banner.
OUT_FILE=$(mktemp)
OUT_FILE2=$(mktemp)
trap 'rm -f "${OUT_FILE}" "${OUT_FILE2}"; cleanup' EXIT

# Issue #93 regression — simulate a shared network leaked by a previously
# interrupted `start-service` run on the preferred subnet 169.254.171.0/24.
# The network carries only its own metadata sidecar (no replica) and no owner
# labels, so the startup sweep classifies it as orphaned and reclaims it; the
# subnet assertion below (171, not the next free /24) proves the sweep ran.
echo "==> Injecting a leaked orphan shared network on 169.254.171.0/24"
ORPHAN_NET="cdkl-svc-orphanleak"
docker network create --driver bridge --subnet 169.254.171.0/24 "${ORPHAN_NET}" >/dev/null
docker run -d --rm --name "${ORPHAN_NET}-metadata" --network "${ORPHAN_NET}" \
  --ip 169.254.171.2 "${SIDECAR_IMAGE}" >/dev/null
echo "    orphan ${ORPHAN_NET} owns 169.254.171.0/24 (only its metadata sidecar attached)"

# Issue #889 — count running task containers (not the metadata sidecar, which
# holds the same chain) whose env carries the fake default-chain key this run
# booted with (no credential flag). Other lanes' containers never carry it.
# Unique per run, so a concurrent run of this fixture never matches.
FAKE_CHAIN_KEY="FAKEINTEGKEY0889X$$"
count_default_chain_containers() {
  local n=0 id
  for id in $(docker ps --filter "name=cdkl-" --filter "ancestor=${BUSYBOX_IMAGE}" --format '{{.ID}}'); do
    if docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${id}" 2>/dev/null \
      | grep -qx "AWS_ACCESS_KEY_ID=${FAKE_CHAIN_KEY}"; then
      n=$((n + 1))
    fi
  done
  echo "${n}"
}

echo "==> Booting service (DesiredCount=2) with no credential flag and a fake default chain"
env -u AWS_PROFILE -u AWS_SESSION_TOKEN AWS_ACCESS_KEY_ID="${FAKE_CHAIN_KEY}" AWS_SECRET_ACCESS_KEY=integ-fake-secret-889 \
  ${CDKL} start-service CdkLocalStartServiceFixture:WebService \
  --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1 &
CDKL_PID=$!

# Wait for the service boot banner. The CLI prints
# "Service(s) running: <Name> (N replica(s)). Press ^C to shut down."
# once every target's controller has been started — that's the
# deterministic ready marker.
echo "==> Waiting for boot banner (up to 60s)"
BOOTED=0
for i in $(seq 1 60); do
  if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  # If cdk-local exited early, fail fast.
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    echo "FAIL: cdk-local exited before reaching the boot banner"
    echo "----- service output -----"
    cat "${OUT_FILE}"
    echo "--------------------------"
    exit 1
  fi
  sleep 1
done

if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: service did not reach the boot banner within 60s"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

echo "==> Asserting issue #93 sweep reclaimed the orphan network"
# The service reached the boot banner above despite the pre-existing
# 169.254.171.0/24 network, which already proves the sweep ran. Assert the
# orphan is actually gone (not merely bypassed) for a precise failure message.
if docker network inspect "${ORPHAN_NET}" >/dev/null 2>&1; then
  echo "FAIL: orphan network ${ORPHAN_NET} survived — startup sweep did not reclaim it"
  exit 1
fi
echo "    OK: orphan reclaimed; service booted on the shared subnet"

echo "==> Asserting 2 replicas (4 containers: 2 web + 2 metadata sidecars)"
# Each replica gets its own docker network + sidecar, plus 1 web container.
# We assert at least 2 'web'-image containers running under the cdkl
# prefix; the sidecar count is incidental.
WEB_COUNT=$(docker ps --filter "ancestor=${BUSYBOX_IMAGE}" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${WEB_COUNT}" -lt 2 ]]; then
  echo "FAIL: expected at least 2 busybox 'web' containers running, found ${WEB_COUNT}"
  docker ps -a --filter "name=cdkl-" --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    OK: ${WEB_COUNT} busybox web containers running"

echo "==> Asserting both replicas got the host default chain as env (issue #889)"
CHAIN_COUNT=$(count_default_chain_containers)
if [[ "${CHAIN_COUNT}" -lt 2 ]]; then
  echo "FAIL: expected 2 replica containers with the default-chain key, found ${CHAIN_COUNT}"
  exit 1
fi
if grep -qF 'integ-fake-secret-889' "${OUT_FILE}"; then
  echo "FAIL: the secret key reached the run output"; exit 1
fi
echo "    OK: ${CHAIN_COUNT} replica containers carry the default-chain key"

echo "==> Asserting one shared docker network (design § 5 Option A, cdkd PR #522)"
# Post-#522 every replica in a single CLI invocation joins ONE shared
# `cdkl-*` network so peers can reach each other by IP / network alias
# without `docker network connect` choreography. The pre-#522
# per-replica-network shape (with the `170 + (index % 84)` subnet
# allocator + per-replica subnet isolation assertion) is gone.
NET_COUNT=$(docker network ls --filter "name=cdkl-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${NET_COUNT}" -ne 1 ]]; then
  echo "FAIL: expected exactly 1 shared cdkl-* docker network, found ${NET_COUNT}"
  docker network ls --filter "name=cdkl-"
  exit 1
fi
NET_ID=$(docker network ls --filter "name=cdkl-" --format '{{.ID}}')
SUBNET=$(docker network inspect "${NET_ID}" --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || echo "")
echo "    network ${NET_ID}: subnet=${SUBNET}"
# Subnet must be the shared-service `169.254.171.0/24` (SHARED_SVC_SUBNET_OCTET).
if [[ "${SUBNET}" != "169.254.171.0/24" ]]; then
  echo "FAIL: expected shared subnet 169.254.171.0/24 (SHARED_SVC_SUBNET_OCTET), got ${SUBNET}"
  exit 1
fi
echo "    OK: 1 shared network on 169.254.171.0/24"

# Issue #849 — a SECOND start-service started while the first is running used
# to die with "Pool overlaps with other one on this address space" because
# both created their shared network on 169.254.171.0/24. It must come up on
# another /24, its replicas' metadata URI must follow that /24, and its
# startup sweep must leave a live peer's network alone. The service runs
# 2 replicas, so neither run publishes a host port and the two can coexist.
#
# The first run already has replicas attached, which the sweep has always
# kept. A peer still building its images has NO replica yet; stand one in
# with an empty network labelled as owned by this (live) script, which only
# the owner-label check keeps.
LIVE_PEER_NET="cdkl-svc-livepeer849"
HOST_NAME=$(node -p 'require("os").hostname()')
docker network create --driver bridge \
  --label "cdk-local.owner-pid=$$" --label "cdk-local.owner-host=${HOST_NAME}" \
  "${LIVE_PEER_NET}" >/dev/null
LIVE_PEER_ID=$(docker network inspect "${LIVE_PEER_NET}" --format '{{.Id}}' | cut -c1-12)
echo "==> Booting a concurrent second start-service (issue #849)"
${CDKL} start-service CdkLocalStartServiceFixture:WebService \
  --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE2}" 2>&1 &
CDKL2_PID=$!
BOOTED2=0
for i in $(seq 1 60); do
  if grep -q "Service(s) running:" "${OUT_FILE2}" 2>/dev/null; then
    BOOTED2=1
    break
  fi
  if ! kill -0 "${CDKL2_PID}" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "${BOOTED2}" -ne 1 ]]; then
  echo "FAIL: the concurrent second start-service did not boot"
  echo "----- second service output -----"
  cat "${OUT_FILE2}"
  echo "---------------------------------"
  exit 1
fi
if ! docker network inspect "${NET_ID}" >/dev/null 2>&1; then
  echo "FAIL: the second run's startup sweep reclaimed the first run's live network"
  exit 1
fi
if ! docker network inspect "${LIVE_PEER_NET}" >/dev/null 2>&1; then
  echo "FAIL: the second run's startup sweep reclaimed a live peer's replica-less network"
  exit 1
fi
docker network rm "${LIVE_PEER_NET}" >/dev/null
NET2_ID=$(docker network ls --filter "name=cdkl-" --format '{{.ID}}' \
  | grep -v -e "^${NET_ID}" -e "^${LIVE_PEER_ID}" || true)
if [[ $(printf '%s\n' "${NET2_ID}" | grep -c .) -ne 1 ]]; then
  echo "FAIL: expected exactly 1 more cdkl-* network for the second run, found: ${NET2_ID}"
  docker network ls --filter "name=cdkl-"
  exit 1
fi
SUBNET2=$(docker network inspect "${NET2_ID}" --format '{{(index .IPAM.Config 0).Subnet}}')
echo "    second network ${NET2_ID}: subnet=${SUBNET2}"
if [[ ! "${SUBNET2}" =~ ^169\.254\.([0-9]+)\.0/24$ ]] || [[ "${SUBNET2}" == "169.254.171.0/24" ]]; then
  echo "FAIL: expected the second run on a link-local /24 other than 169.254.171.0/24, got ${SUBNET2}"
  exit 1
fi
OCTET2="${BASH_REMATCH[1]}"
NET2_NAME=$(docker network inspect "${NET2_ID}" --format '{{.Name}}')
REPLICA2=$(docker network inspect "${NET2_ID}" --format '{{range .Containers}}{{.Name}} {{end}}' \
  | tr ' ' '\n' | grep -v -e '^$' -e "^${NET2_NAME}-metadata\$" | head -1 || true)
if [[ -z "${REPLICA2}" ]]; then
  echo "FAIL: no replica container attached to the second run's network ${NET2_NAME}"
  exit 1
fi
SIDECAR2_IP=$(docker inspect "${NET2_NAME}-metadata" \
  --format "{{(index .NetworkSettings.Networks \"${NET2_NAME}\").IPAddress}}" || true)
META_URI2=$(docker inspect "${REPLICA2}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep '^ECS_CONTAINER_METADATA_URI_V4=' || true)
if [[ "${SIDECAR2_IP}" != "169.254.${OCTET2}.2" ]] \
  || [[ "${META_URI2}" != "ECS_CONTAINER_METADATA_URI_V4=http://169.254.${OCTET2}.2/v4/"* ]]; then
  echo "FAIL: second run's sidecar / metadata URI do not follow ${SUBNET2}:"
  echo "      sidecar ip=${SIDECAR2_IP} replica ${REPLICA2}: ${META_URI2}"
  exit 1
fi
echo "    OK: second run on ${SUBNET2}, sidecar ${SIDECAR2_IP}, ${META_URI2}"
kill -TERM "${CDKL2_PID}" || {
  echo "FAIL: the second start-service had already exited"
  cat "${OUT_FILE2}"
  exit 1
}
for i in $(seq 1 60); do
  if ! kill -0 "${CDKL2_PID}" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "${CDKL2_PID}" 2>/dev/null; then
  echo "FAIL: the second start-service did not exit within 60s after SIGTERM"
  exit 1
fi
wait "${CDKL2_PID}" 2>/dev/null || true
CDKL2_PID=""
if docker network inspect "${NET2_ID}" >/dev/null 2>&1; then
  echo "FAIL: the second run left its network ${NET2_NAME} behind"
  exit 1
fi
if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
  echo "FAIL: the first start-service died while the second ran"
  exit 1
fi
echo "    OK: second run torn down; first run still serving"

echo "==> Sending SIGTERM to cdk-local ($(echo $CDKL_PID))"
kill -TERM "${CDKL_PID}"

# Wait for cdk-local to exit cleanly.
echo "==> Waiting for cdk-local to exit (up to 60s)"
EXITED=0
for i in $(seq 1 60); do
  if ! kill -0 "${CDKL_PID}" 2>/dev/null; then
    EXITED=1
    break
  fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdk-local did not exit within 60s after SIGTERM"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  kill -KILL "${CDKL_PID}" 2>/dev/null || true
  exit 1
fi
# Reap the exit status so wait/kill -0 doesn't keep firing during the
# cleanup trap.
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
echo "==> local-start-service test passed (2 replicas booted, both cleaned up on SIGTERM)"
