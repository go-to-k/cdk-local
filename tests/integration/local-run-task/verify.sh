#!/usr/bin/env bash
# verify.sh — local-run-task integ test
#
# Fully local: no AWS resources are deployed. Exercises `cdkl run-task` end-to-end against Docker + the AWS-published
# `amazon-ecs-local-container-endpoints` sidecar + a single nginx
# container exposing port 80 → 18080 on the host.
#
# Run via `/run-integ local-run-task` (recommended) or directly:
#
#     bash tests/integration/local-run-task/verify.sh
#
# Requires Docker. The script pulls the sidecar + nginx images up front
# so the run is self-sufficient.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
NGINX_IMAGE="public.ecr.aws/nginx/nginx:alpine"

cleanup() {
  echo "==> Cleanup: stopping any leftover containers"
  docker ps --filter "name=cdkl-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
  # Issue #388 — drop the local-only override image(s) the --image-override run
  # built (tag prefix is the embed binary name: `cdkl-override-*:local`).
  docker images --filter 'reference=cdkl-override-*' -q | xargs -r docker rmi -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Tear down every cdkl run-task container + network between phases so the
# fixed host port 18080 is free for the next detached run.
teardown_runs() {
  docker ps --filter "name=cdkl-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
}

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${NGINX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi


echo "==> [1/3] Starting task via --detach"
# Capture the run output: the fixture's image is a public-registry pin, so a
# run WITHOUT --image-override must WARN that local source edits will not take
# effect (issue #388 — this locks the command-level pinned-uncovered WARN
# binding end-to-end, not just the helper).
PINNED_RUN_LOG=$(mktemp)
${CDKL} run-task CdkLocalRunTaskFixture/NginxTask --detach --no-pull --container-host 127.0.0.1 2>&1 | tee "${PINNED_RUN_LOG}"
if ! grep -qiF 'pinned to a deployed registry' "${PINNED_RUN_LOG}"; then
  echo "FAIL: run-task did not WARN that the pinned task-def image will not pick up local edits"
  rm -f "${PINNED_RUN_LOG}"; exit 1
fi
rm -f "${PINNED_RUN_LOG}"
echo "    OK: pinned-image WARN surfaced (suggests --image-override)"

echo "==> [2/3] Curling http://127.0.0.1:18080/"
# Give nginx ~5s to listen.
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/ || true)
echo "    HTTP code: ${HTTP_CODE}"
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "FAIL: expected 200, got ${HTTP_CODE}"
  exit 1
fi
# The pinned image serves the stock nginx welcome page (NOT the override sentinel).
PINNED_BODY=$(curl -s http://127.0.0.1:18080/ || true)
if grep -qF 'run-task-image-override-sentinel-388' <<<"${PINNED_BODY}"; then
  echo "FAIL: the pinned run already served the override sentinel (test is not discriminating)"
  exit 1
fi

# Issue #388 — `cdkl run-task --image-override <target>=<dockerfile>` rebuilds
# the pinned (public-registry) task-def image from a local Dockerfile. The
# explicit <target>=<dockerfile> form is used (no TTY in CI -> the bare picker
# form would be skipped). The override image writes a sentinel into the served
# page, so asserting the sentinel proves the LOCAL build ran in place of the
# pinned image.
echo "==> Tearing down the pinned run to free host port 18080"
teardown_runs

echo "==> [3/3] run-task --image-override rebuilds the pinned task-def image from a local Dockerfile"
${CDKL} run-task CdkLocalRunTaskFixture/NginxTask \
  --image-override 'CdkLocalRunTaskFixture/NginxTask=Dockerfile.override' \
  --no-interactive-overrides --detach --no-pull --container-host 127.0.0.1
sleep 5
OV_BODY=$(curl -s http://127.0.0.1:18080/ || true)
if ! grep -qF 'run-task-image-override-sentinel-388' <<<"${OV_BODY}"; then
  echo "FAIL: --image-override did not serve the local Dockerfile build (sentinel absent)"
  echo "----- body -----"; echo "${OV_BODY}" | head -c 500; echo; echo "----------------"
  exit 1
fi
echo "    OK: the pinned task-def image was rebuilt from the local Dockerfile (sentinel served)"

echo ""
echo "==> All local-run-task tests passed (run + image-override rebuild)"
