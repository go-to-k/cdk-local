#!/usr/bin/env bash
#
# Built-image cleanup for integration fixtures (issue #603).
#
# A fixture that builds a Docker image -- directly, or by running a cdk-local
# command that builds one -- used to leave the tag behind on every run. Eight
# fixtures did, across four tag namespaces:
#
#   cdkl-run-task-<assetHash16>        src/local/ecs-task-runner.ts
#   cdkl-override-<svc>-<hash>:local   src/local/image-override-engine.ts
#   cdkl-invoke-<hash16>               src/local/docker-image-builder.ts
#   cdkl-agentcore-code-<hash>         src/local/agentcore-code-build.ts
#
# ## Why snapshot-and-delta rather than a blanket `docker rmi`
#
# Parallel integ lanes share ONE Docker daemon on a dev host. A blanket sweep
# over a namespace deletes an image a peer lane is mid-run on -- the reasoning
# issue #587 landed in local-studio. So the set present at the start is
# recorded, and only tags that appeared SINCE are removed.
#
# ## Why this is shared rather than copied per fixture
#
# Fixtures are deliberately self-contained for their ASSERTIONS, and this
# followed that habit at first -- eight near-identical copies. Review rejected it,
# correctly: this is a DESTRUCTIVE primitive on shared host state whose
# invariants (both `comm` operands sorted, the baseline captured before any
# build, the baseline never trusted when empty-by-accident) are not obvious from
# reading a call site. Copies had live fail-opens in them; eight copies meant
# fixing each one eight times and getting it right eight times.
#
# ## The fail-open that made this a library
#
# The first version published the temp path and wrote the snapshot into it as
# two separate steps:
#
#     IMAGES_BEFORE="$(mktemp)"          # path is live from here
#     snapshot_images > "${IMAGES_BEFORE}"
#
# If that write failed or truncated -- a docker hiccup after the daemon probe,
# or `pipefail` catching a partial `docker images` -- `set -e` aborted, the EXIT
# trap fired, and the cleanup read an EMPTY baseline. An empty baseline makes
# the delta the ENTIRE namespace, so the run deletes every peer lane's tags.
# Measured with a deliberately empty baseline and two peer images present, it
# selected both. `integ_image_cleanup_init` therefore assigns the module's
# baseline variable ONLY after a successful write; until then it stays empty and
# `integ_image_cleanup_run` is a no-op.
#
# Know what that costs, because it is not "the run continues without cleanup":
# `init` is called at TOP LEVEL, and every consumer runs `set -euo pipefail`, so
# a non-zero return ABORTS THE FIXTURE right there -- measured, the line after
# `init` never runs. That is deliberate. A fixture that cannot establish a
# baseline cannot safely clean up what it is about to build, and the honest
# response to "docker just failed" is to stop rather than to build images whose
# removal is now unbounded. A caller that would rather continue must opt in
# explicitly with `integ_image_cleanup_init ... || true` and accept leaking its
# own tags.
#
# ## Usage
#
#   source "$(dirname "${BASH_SOURCE[0]}")/../_lib/image-cleanup.sh"
#   ...
#   docker version ... >/dev/null            # daemon probe first
#   integ_image_cleanup_init 'cdkl-run-task-*'
#   ...
#   cleanup() { ...; integ_image_cleanup_run; }   # LAST in the trap
#
# Call `init` AFTER the daemon probe and BEFORE anything builds into the
# namespace. A `docker pull` of a base image outside the namespace may sit
# either side of it; a pull INTO the namespace must come after.

# Space-free glob patterns passed to `docker images --filter reference=`.
# Held as a plain string rather than an array: bash 3.2 (macOS system bash,
# which `vp run test:hooks` exercises) errors on `"${arr[@]}"` for an empty
# array under `set -u`, and every consumer here is a whitespace-free glob.
INTEG_IMAGE_FILTERS=""

# Path to the baseline snapshot. Empty until a snapshot has been written
# SUCCESSFULLY -- see the fail-open note above. Never assign this directly.
INTEG_IMAGES_BEFORE=""

# Print the current tag set for every registered filter, sorted.
# Sorting is not cosmetic: `comm` requires both operands sorted, and
# `docker images` does not promise an order.
integ_image_snapshot() {
  # `${INTEG_IMAGE_FILTERS}` is UNQUOTED on purpose, to split on whitespace --
  # but an unquoted expansion also PATHNAME-EXPANDS, and these values are globs.
  # Measured: with a file named `cdkl-run-task-deadbeef` in the cwd, the loop
  # sees `cdkl-run-task-deadbeef` instead of `cdkl-run-task-*`, so the snapshot
  # covers one tag instead of the namespace. An incomplete BASELINE is the same
  # fail-open as an empty one: every pre-existing tag it missed lands in this
  # run's delta and gets deleted. `set -f` splits without globbing.
  local f had_f=0 rc=0 acc
  case "$-" in *f*) had_f=1 ;; esac
  set -f

  # Each filter is checked INDIVIDUALLY, and the results accumulate in a file
  # that is sorted at the end. The obvious spelling -- `for ...; done | sort` --
  # is a fail-open: a `for` loop's exit status is its LAST iteration's, so a
  # `docker images` failure on any filter but the last is lost inside the loop
  # before `pipefail` can see it. `init` would then return 0 having armed a
  # PARTIAL baseline, and everything under the failed filter looks new and gets
  # deleted. Measured: with a stub failing only the first of two filters, the
  # pipeline form returned 0. `local-invoke-agentcore` is the only two-filter
  # caller and it puts the shared `cdkl-invoke-*` namespace first, i.e. exactly
  # in the swallowed position.
  acc="$(mktemp)" || { [ "${had_f}" -eq 1 ] || set +f; return 1; }
  for f in ${INTEG_IMAGE_FILTERS}; do
    if ! docker images --filter "reference=${f}" --format '{{.Repository}}:{{.Tag}}' >> "${acc}"; then
      rc=1
      break
    fi
  done
  [ "${had_f}" -eq 1 ] || set +f
  if [ "${rc}" -ne 0 ]; then
    rm -f "${acc}"
    return 1
  fi
  sort "${acc}"
  rc=$?
  rm -f "${acc}"
  return "${rc}"
}

# integ_image_cleanup_init <glob> [<glob>...]
# Record the baseline. Returns non-zero without arming anything if the
# snapshot cannot be written.
integ_image_cleanup_init() {
  if [ "$#" -eq 0 ]; then
    echo "integ_image_cleanup_init: at least one reference glob is required" >&2
    return 1
  fi
  INTEG_IMAGE_FILTERS="$*"
  local snap
  snap="$(mktemp)" || return 1
  # Write FIRST, publish SECOND. A failed or partial write leaves
  # INTEG_IMAGES_BEFORE empty, so the cleanup declines to delete anything
  # rather than treating an empty baseline as "the namespace was empty".
  if ! integ_image_snapshot > "${snap}"; then
    rm -f "${snap}"
    return 1
  fi
  INTEG_IMAGES_BEFORE="${snap}"
}

# Remove only the tags that appeared since `init`. Safe to call more than
# once: fixtures trap `EXIT INT TERM`, so cleanup can fire twice.
integ_image_cleanup_run() {
  if [ -z "${INTEG_IMAGES_BEFORE:-}" ] || [ ! -f "${INTEG_IMAGES_BEFORE}" ]; then
    return 0
  fi
  local new
  new="$(integ_image_snapshot | comm -13 "${INTEG_IMAGES_BEFORE}" - || true)"
  if [ -n "${new}" ]; then
    echo "==> Removing image(s) built by this run:"
    echo "${new}" | sed 's/^/      /'
    # Unforced ON PURPOSE, but do NOT read it as peer protection: a fixture's
    # own cleanup typically force-removes every `cdkl-*` container first, so by
    # the time this runs nothing is holding the image and the unforced remove
    # succeeds anyway. What actually bounds the blast radius is the delta.
    echo "${new}" | xargs -r docker image rm >/dev/null 2>&1 || true
  fi
  rm -f "${INTEG_IMAGES_BEFORE}"
  INTEG_IMAGES_BEFORE=""
}

# KNOWN RESIDUAL WINDOW, stated rather than papered over: a peer lane that
# builds into the namespace AFTER this run's snapshot lands in this run's delta
# and is removed. Two same-fixture lanes produce the SAME asset hash, hence the
# same tag, so this is reachable rather than theoretical. Do NOT reach for the
# comforting version of this -- "the peer's own container already holds the
# image, so the unforced remove fails harmlessly" is FALSE for a peer sitting
# between `docker build` and `docker run`, which is precisely the window a
# `--watch` rebuild roll spends most of its time in. Closing it properly needs
# per-lane tag names (the `cdkl-*` prefix is not lane-scoped) and is tracked
# separately from this cleanup.
