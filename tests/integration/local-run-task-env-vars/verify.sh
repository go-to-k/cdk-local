#!/usr/bin/env bash
# verify.sh — local-run-task --env-vars overlay integ test
#
# Fully local: no AWS resources are deployed. A single busybox container
# prints its environment and exits. The run passes an `--env-vars` file
# that exercises all three overlay outcomes on the ECS task-container env
# path (start-service / start-alb / run-task share this code):
#   - ADD    a new key not present in the template,
#   - KEEP   a template key the overlay does not mention,
#   - CLEAR  a template key by setting it to JSON `null` (SAM-compat) — the
#            key must be GONE from the container env, never `KEY=null`.
#
# Run via `/run-integ local-run-task-env-vars` (recommended) or directly:
#
#     bash tests/integration/local-run-task-env-vars/verify.sh
#
# Requires Docker. Pulls the sidecar + busybox images up front.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

# Set once, below. Initialized empty so the EXIT trap's `rm -f` is harmless
# if the script dies before the temp files are created (set -u safe).
ENV_FILE=""
OUT_FILE=""
cleanup() {
  echo "==> Cleanup: stopping any leftover containers"
  docker ps --filter "name=cdkl-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -f "${ENV_FILE}" "${OUT_FILE}"
}
# A single EXIT trap: a second `trap ... EXIT` would REPLACE this one (bash
# keeps only the last), silently dropping the docker sweep.
trap cleanup EXIT

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# SAM-shape --env-vars file (Parameters apply to every container):
#   - ADDED_BY_FLAG : new key not in the template
#   - DROP_ME       : null -> CLEAR the template key
# (KEEP_ME is intentionally NOT mentioned so it survives from the template.)
ENV_FILE=$(mktemp)
OUT_FILE=$(mktemp)
cat > "${ENV_FILE}" <<'JSON'
{
  "Parameters": {
    "ADDED_BY_FLAG": "added-value",
    "DROP_ME": null
  }
}
JSON

echo "==> Running env-probe task with --env-vars overlay"
# Run synchronously so `cdkl run-task` waits for the essential container to
# exit; the env dump lands on stdout with the [probe] prefix.
${CDKL} run-task CdkLocalRunTaskEnvVarsFixture/EnvProbeTask \
  --env-vars "${ENV_FILE}" --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1

dump_and_fail() {
  echo "FAIL: $1"
  echo "----- run output -----"
  cat "${OUT_FILE}"
  echo "----------------------"
  exit 1
}

echo "==> Asserting the overlay ADDED a new key"
grep -q '\[probe\] ADDED_BY_FLAG=added-value' "${OUT_FILE}" \
  || dump_and_fail "expected '[probe] ADDED_BY_FLAG=added-value' (overlay add)"

echo "==> Asserting an unmentioned template key SURVIVED"
grep -q '\[probe\] KEEP_ME=kept-value' "${OUT_FILE}" \
  || dump_and_fail "expected '[probe] KEEP_ME=kept-value' (template key preserved)"

echo "==> Asserting the null'd key is GONE (the whole point)"
# The key must not appear at all — not its template value, not empty, and
# crucially NOT the literal string "null".
if grep -q '\[probe\] DROP_ME=' "${OUT_FILE}"; then
  dump_and_fail "DROP_ME should have been cleared by null, but it is still set"
fi
if grep -q 'DROP_ME=null' "${OUT_FILE}"; then
  dump_and_fail "DROP_ME was stringified to \"null\" instead of being deleted"
fi

echo ""
echo "==> local-run-task-env-vars test passed (add / keep / null-clear)"
