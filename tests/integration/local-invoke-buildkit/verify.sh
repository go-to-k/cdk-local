#!/usr/bin/env bash
# verify.sh — BuildKit-Dockerfile regression integ test.
#
# Exercises every BuildKit feature this PR newly forwards via cdk-local's
# docker build path, in ONE build:
#   1. `# syntax=docker/dockerfile:1`
#   2. Multi-stage with `--target final` (DockerImageCode.fromImageAsset.target)
#   3. `ARG` populated by `--build-arg` (DockerImageCode.fromImageAsset.buildArgs)
#   4. Heredocs (`RUN <<EOF`)
#   5. `RUN --mount=type=cache`
#   6. `RUN --mount=type=secret` populated by `--secret`
#      (DockerImageCode.fromImageAsset.buildSecrets — NEW capability)
#
# Pre-PR cdk-local would either silently kill the build with maxBuffer 50 MB
# on BuildKit progress, OR reject `buildSecrets` at the type layer
# because cdk-local's `DockerImageAssetSource` didn't surface the field.
# Both paths now work.
#
# Run via `/run-integ local-invoke-buildkit` (recommended) or directly:
#
#     bash tests/integration/local-invoke-buildkit/verify.sh
#
# Requires Docker with BuildKit (Docker Engine 23.0+ has it on by
# default; older daemons need DOCKER_BUILDKIT=1). Fully local — no AWS.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
BASE_IMAGE="public.ecr.aws/lambda/nodejs:20"

# Expected values baked into the image during build. The runtime function
# echoes these back so we can prove every BuildKit flag actually fired.
EXPECTED_BUILD_ARG="compiled-in-from-cdk"
# sha256 of `docker/secret.txt`. Recompute with:
#   sha256sum docker/secret.txt | cut -d' ' -f1
EXPECTED_SECRET_SHA=$(sha256sum docker/secret.txt | cut -d' ' -f1)

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${BASE_IMAGE} (one-time, ~600MB)"
docker pull "${BASE_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# --- built-image handling (issue #587) -------------------------------------
# This fixture used to `docker image rm -f` EVERY `cdkl-invoke-*` tag, twice
# (here, and again in cleanup). Parallel integ lanes share one Docker daemon
# on a dev host, so that blanket sweep deletes images other lanes are mid-run
# on -- and the `| head -1` tag pick below had the mirror-image defect, since
# it could just as easily land on a concurrent lane's tag.
#
# Everything is scoped to THIS fixture's own deterministic tag instead. cdkl
# prints that tag on its `--no-build` path BEFORE it checks the local registry,
# so a probe run reports the tag whether or not the image exists.
#
# Two honest caveats about that probe:
#   * It is NOT free. When the image is absent it exits non-zero right after
#     printing the tag (hence `|| true`), but when the image IS present cdkl
#     carries on and performs a real invoke -- a container run. That happens
#     only on a warm host, in exactly the case where the image is about to be
#     removed and rebuilt anyway, so the cost is accepted rather than hidden.
#   * The tag arrives on an INFO-level line, so an exported CDKL_LOG_LEVEL=warn
#     would suppress it and hard-fail the guard below. The level is pinned to
#     info for the probe alone, so the fixture does not depend on the caller's
#     environment.
IMAGES_BEFORE="$(docker image ls --filter 'reference=cdkl-invoke-*' \
  --format '{{.Repository}}:{{.Tag}}' | sort)"
OWN_TAG="$(CDKL_LOG_LEVEL=info ${CDKL} invoke CdkLocalInvokeBuildkitFixture/BuildkitHandler \
  --no-pull --no-build 2>&1 | grep -oE 'cdkl-invoke-[0-9a-f]+' | head -1 || true)"
if [[ -z "${OWN_TAG}" ]]; then
  echo "FAIL: could not resolve this fixture's cdkl-invoke-* tag from the --no-build probe"
  exit 1
fi
OWN_TAG="${OWN_TAG}:latest"
echo "==> This fixture's image tag: ${OWN_TAG}"

remove_own_image() {
  # Unforced first, so a container still holding the image is respected. But an
  # unforced rm also refuses an image held by a container that is merely
  # STOPPED, and a leftover container from an aborted run would then turn a
  # passing fixture into a hard FAIL at the absence check below, where `-f`
  # used to proceed. OWN_TAG is this fixture's OWN tag, so a scoped force-remove
  # is safe as a fallback: it can never reach another fixture's or another
  # lane's tag.
  docker image rm "${OWN_TAG}" >/dev/null 2>&1 \
    || docker image rm -f "${OWN_TAG}" >/dev/null 2>&1 || true
}

# Force a fresh build to guarantee the test actually exercises every
# BuildKit feature this run (otherwise a stale image could satisfy the
# assertions below without `--secret` / `--target` ever being re-exercised).
# ONLY this fixture's own tag is removed -- never a tag the snapshot held.
echo "==> Force-rebuilding (clear this fixture's stale image so --secret / --target are re-exercised)"
remove_own_image
trap remove_own_image EXIT
if docker image inspect "${OWN_TAG}" >/dev/null 2>&1; then
  echo "FAIL: ${OWN_TAG} still present after removal — cannot guarantee a fresh build"
  echo "      (a container — running or stopped — may still hold it; remove it and re-run)"
  exit 1
fi
# Drop our own tag from the snapshot now that it is gone. A previous run
# (or a crash) can leave it behind, and without this the "new since the
# snapshot" assertion below would fail spuriously on the very rebuild it is
# meant to certify. Every OTHER tag stays in the snapshot, and so stays
# untouchable.
IMAGES_BEFORE="$(printf '%s\n' "${IMAGES_BEFORE}" | grep -vxF "${OWN_TAG}" || true)"
echo "    ✓ ${OWN_TAG} absent — any appearance below is a build from THIS run"


echo "==> [1/3] Building + invoking BuildkitHandler (exercises every BuildKit feature)"
# Both lines used to abort the script on failure (issue #577): a non-zero cdkl
# under `set -e`, and a `grep` that matches nothing under `pipefail`. Either
# killed the run BEFORE the FAIL branches below that `cat` the log.
CDKL_RC_1=0
${CDKL} invoke CdkLocalInvokeBuildkitFixture/BuildkitHandler --no-pull >/tmp/cdkl-buildkit-1.log 2>&1 || CDKL_RC_1=$?
if [ "${CDKL_RC_1}" -ne 0 ]; then
  echo "[verify] cdkl invoke exited ${CDKL_RC_1}; log follows:" >&2
  cat /tmp/cdkl-buildkit-1.log >&2
fi
RESULT_1=$(grep -E '"(buildArg|secretSha|fromBuildkitImage)"' /tmp/cdkl-buildkit-1.log | tail -1 || true)
echo "    response: ${RESULT_1}"

# Every BuildKit feature must show up in the response.
echo "${RESULT_1}" | grep -q "\"buildArg\":\"${EXPECTED_BUILD_ARG}\"" || {
  echo "FAIL: --build-arg did not flow through. Expected buildArg=${EXPECTED_BUILD_ARG}"
  echo "      response: ${RESULT_1}"
  cat /tmp/cdkl-buildkit-1.log
  exit 1
}
echo "${RESULT_1}" | grep -q "\"secretSha\":\"${EXPECTED_SECRET_SHA}\"" || {
  echo "FAIL: --secret did not flow through. Expected secretSha=${EXPECTED_SECRET_SHA}"
  echo "      response: ${RESULT_1}"
  cat /tmp/cdkl-buildkit-1.log
  exit 1
}
echo "${RESULT_1}" | grep -q '"multiStageTarget":"final"' || {
  echo "FAIL: multi-stage --target final did not run (app.js missing from image)"
  cat /tmp/cdkl-buildkit-1.log
  exit 1
}
echo "${RESULT_1}" | grep -q '"greeting":"hello-buildkit"' || {
  echo "FAIL: GREETING env var did not flow through"
  cat /tmp/cdkl-buildkit-1.log
  exit 1
}
echo "    ✓ build-arg=${EXPECTED_BUILD_ARG}"
echo "    ✓ secret-sha=${EXPECTED_SECRET_SHA}"
echo "    ✓ multi-stage --target=final"

# Verify the raw secret content NEVER landed in any image layer. This is
# the load-bearing security property of `RUN --mount=type=secret`: the
# secret content is mounted ONLY during the RUN step, never baked into a
# layer. Grep the local cdkl-built image's history for the secret
# content — must NOT match.
echo "==> [2/3] Verifying secret content NEVER baked into image layers (security property of --secret)"
SECRET_LITERAL=$(cat docker/secret.txt | head -1)
# The tag was proven ABSENT before the build, so its presence now is proof a
# real build ran in THIS process -- strictly stronger than the old check,
# which any stale `cdkl-invoke-*` image (from this or any other lane) passed.
CDKL_TAG="${OWN_TAG}"
if ! docker image inspect "${CDKL_TAG}" >/dev/null 2>&1; then
  echo "FAIL: ${CDKL_TAG} absent after the invoke — build did not happen this run"
  exit 1
fi
if ! docker image ls --filter 'reference=cdkl-invoke-*' --format '{{.Repository}}:{{.Tag}}' \
     | sort | comm -13 <(printf '%s\n' "${IMAGES_BEFORE}") - | grep -qxF "${CDKL_TAG}"; then
  echo "FAIL: ${CDKL_TAG} is not a NEW tag since the pre-run snapshot — build did not happen this run"
  exit 1
fi
echo "    ✓ ${CDKL_TAG} is new since the pre-run snapshot (a real build ran)"
# Walk every layer's filesystem and grep for the secret literal. If
# `--mount=type=secret` worked correctly, the secret was only on the
# build container's RUN-step tmpfs, never on a layer.
TMP_DUMP=$(mktemp)
trap 'rm -rf "${TMP_DUMP}"; remove_own_image' EXIT
docker save "${CDKL_TAG}" | tar -t 2>/dev/null > "${TMP_DUMP}"
if docker save "${CDKL_TAG}" 2>/dev/null | grep -aq "${SECRET_LITERAL}"; then
  echo "FAIL: secret literal '${SECRET_LITERAL}' found in image layers — --mount=type=secret is leaking!"
  exit 1
fi
echo "    ✓ secret content absent from all image layers"

# Re-invoke under --no-build to confirm tag stability (the deterministic
# tag computed from the source must match across builds).
echo "==> [3/3] Re-invoking under --no-build to confirm tag stability"
# Both lines used to abort the script on failure (issue #577): a non-zero cdkl
# under `set -e`, and a `grep` that matches nothing under `pipefail`. Either
# killed the run BEFORE the FAIL branches below that `cat` the log.
CDKL_RC_3=0
${CDKL} invoke CdkLocalInvokeBuildkitFixture/BuildkitHandler --no-pull --no-build >/tmp/cdkl-buildkit-3.log 2>&1 || CDKL_RC_3=$?
if [ "${CDKL_RC_3}" -ne 0 ]; then
  echo "[verify] cdkl invoke exited ${CDKL_RC_3}; log follows:" >&2
  cat /tmp/cdkl-buildkit-3.log >&2
fi
RESULT_3=$(grep -E '"buildArg"' /tmp/cdkl-buildkit-3.log | tail -1 || true)
echo "${RESULT_3}" | grep -q "\"buildArg\":\"${EXPECTED_BUILD_ARG}\"" || {
  echo "FAIL: --no-build re-invocation did not pick up the same baked image"
  cat /tmp/cdkl-buildkit-3.log
  exit 1
}
echo "    ✓ --no-build reused the cached tag"

rm -f /tmp/cdkl-buildkit-1.log /tmp/cdkl-buildkit-3.log

# Cleanup: remove the image THIS run built, so CI hosts don't accumulate one
# per iteration. Scoped to this fixture's own tag -- the fixture does NOT own
# the whole `cdkl-invoke-*` namespace, which is shared with every other
# container fixture and with concurrently running lanes. The run-time docker
# containers are already removed by `docker run --rm` + cdk-local's
# removeContainer().
#
# The `docker image prune --filter label=cdkl-invoke` that used to follow is
# gone: cdk-local never passes `--label`, so it matched nothing and had never
# pruned the multi-stage builder layers its comment claimed. An UNFILTERED
# prune is exactly the cross-lane hazard this change removes.
echo "==> Cleanup: removing the image built by this run (${OWN_TAG})"
remove_own_image

echo ""
echo "==> All 3 BuildKit-Dockerfile checks passed"
echo "    Every BuildKit feature this PR forwards is end-to-end verified:"
echo "    - # syntax=docker/dockerfile:1"
echo "    - multi-stage --target final"
echo "    - --build-arg GREETING_BUILD_ARG=${EXPECTED_BUILD_ARG}"
echo "    - heredocs (RUN <<EOF)"
echo "    - RUN --mount=type=cache"
echo "    - RUN --mount=type=secret id=mysecret (sha256=${EXPECTED_SECRET_SHA})"
