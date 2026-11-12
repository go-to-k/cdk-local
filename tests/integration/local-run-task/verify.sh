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
AWSCLI_IMAGE="public.ecr.aws/aws-cli/aws-cli:2.31.0"

# --- built-image cleanup (issue #587) --------------------------------------
# This used to force-remove EVERY `cdkl-override-*` tag. Parallel integ lanes
# share one Docker daemon on a dev host, so that blanket sweep deletes override
# images another lane is mid-run on. Only the tag(s) THIS run creates are
# removed: the set present now is snapshotted, and cleanup deletes just what
# appeared since. A run can produce SEVERAL override tags
# (`cdkl-override-<svc>-<hash>:local`, one per covered target), so the delta is
# a set rather than a single tag.
IMAGES_BEFORE_OVERRIDE="$(docker images --filter 'reference=cdkl-override-*' \
  --format '{{.Repository}}:{{.Tag}}' | sort)"

remove_run_override_images() {
  local new
  new="$(docker images --filter 'reference=cdkl-override-*' --format '{{.Repository}}:{{.Tag}}' \
    | sort | comm -13 <(printf '%s\n' "${IMAGES_BEFORE_OVERRIDE}") - | grep -v '^$' || true)"
  [ -n "${new}" ] || return 0
  echo "==> Removing override image(s) built by this run:"
  echo "${new}" | sed 's/^/      /'
  # Unforced: `docker image rm` refuses an image while a container still holds
  # it, so a lane whose container is UP survives. It does NOT cover a lane
  # between `docker build` and `docker run` -- the delta scoping is what keeps
  # this run away from another lane's tag in that window.
  echo "${new}" | xargs -r docker image rm >/dev/null 2>&1 || true
}

cleanup() {
  echo "==> Cleanup: stopping any leftover containers"
  docker ps --filter "name=cdkl-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
  # Issue #388 — drop the local-only override image(s) the --image-override run
  # built (tag prefix is the embed binary name: `cdkl-override-*:local`).
  remove_run_override_images
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
docker pull "${AWSCLI_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi


echo "==> [1/6] Starting task via --detach"
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

echo "==> [2/6] Curling http://127.0.0.1:18080/"
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

echo "==> [3/6] run-task --image-override rebuilds the pinned task-def image from a local Dockerfile"
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

# Issue #847 — SameStackTask's image comes from a SAME-STACK
# AWS::ECR::Repository, which has no URI without deployed state. It is still a
# pin `--image-override` replaces, here from a Dockerfile BELOW its build
# context (`--image-context`); the sentinel can only come from that context.
echo "==> Tearing down the override run"
teardown_runs

echo "==> [4/6] run-task --image-override + --image-context on a same-stack ECR repository image"
SAME_STACK_LOG=$(mktemp)
${CDKL} run-task CdkLocalRunTaskFixture/SameStackTask \
  --image-override 'CdkLocalRunTaskFixture/SameStackTask=context-app/docker/Dockerfile' \
  --image-context 'CdkLocalRunTaskFixture/SameStackTask=context-app' \
  --no-interactive-overrides --detach --no-pull --container-host 127.0.0.1 2>&1 | tee "${SAME_STACK_LOG}"
if grep -qF 'references a same-stack AWS::ECR::Repository' "${SAME_STACK_LOG}"; then
  echo "FAIL: the needs-state WARN fired although --image-override was passed"
  rm -f "${SAME_STACK_LOG}"; exit 1
fi
rm -f "${SAME_STACK_LOG}"
sleep 5
SS_BODY=$(curl -s http://127.0.0.1:18081/ || true)
if ! grep -qF 'run-task-image-context-sentinel-847' <<<"${SS_BODY}"; then
  echo "FAIL: the same-stack ECR task did not serve the --image-context build (sentinel absent)"
  echo "----- body -----"; echo "${SS_BODY}" | head -c 500; echo; echo "----------------"
  exit 1
fi
echo "    OK: same-stack ECR image rebuilt from a Dockerfile below its --image-context"
teardown_runs

echo "==> [5/6] run-task on the same-stack ECR image WITHOUT an override is refused"
set +e
NOOV_OUT=$(${CDKL} run-task CdkLocalRunTaskFixture/SameStackTask \
  --no-interactive-overrides --detach --no-pull --container-host 127.0.0.1 2>&1)
NOOV_RC=$?
set -e
if [[ "${NOOV_RC}" -eq 0 ]]; then
  echo "FAIL: the uncovered same-stack ECR task exited 0"; echo "${NOOV_OUT}"; exit 1
fi
if ! grep -qF 'references same-stack ECR repository' <<<"${NOOV_OUT}" \
  || ! grep -qF 'pass --image-override' <<<"${NOOV_OUT}"; then
  echo "FAIL: the refusal did not name the repository and the --image-override remedy"
  echo "${NOOV_OUT}"; exit 1
fi
echo "    OK: refused, remedy names --image-override"

# Issue #883 — with no credential flag, the task gets the host's default
# chain. A fake env key pair stands in for it (env is the chain's first link),
# so nothing reaches AWS: `aws configure list` resolves the container's chain
# locally and prints the key masked to its last 4 characters.
echo "==> [6/6] run-task with no credential flag hands the container the host default chain"
set +e
CREDS_OUT=$(env -u AWS_PROFILE -u AWS_SESSION_TOKEN \
  AWS_ACCESS_KEY_ID=FAKEINTEGKEY0883 AWS_SECRET_ACCESS_KEY=integ-fake-secret-883 \
  AWS_REGION=us-east-1 \
  ${CDKL} run-task CdkLocalRunTaskFixture/CredsTask --no-pull 2>&1)
CREDS_RC=$?
set -e
if [[ "${CREDS_RC}" -ne 0 ]] \
  || ! grep -qE 'access_key +\*+0883 +shared-credentials-file' <<<"${CREDS_OUT}"; then
  echo "FAIL: the container did not resolve the host default chain (rc=${CREDS_RC})"
  echo "${CREDS_OUT}"; exit 1
fi
if grep -qF 'integ-fake-secret-883' <<<"${CREDS_OUT}"; then
  echo "FAIL: the secret key reached the run output"; exit 1
fi
echo "    OK: the container resolved the default-chain key from the mounted credentials file"
teardown_runs

echo ""
echo "==> All local-run-task tests passed (run + image-override rebuild + same-stack ECR + default-chain credentials)"
