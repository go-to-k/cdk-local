#!/usr/bin/env bash
# Smoke test for tests/integration/_lib/image-cleanup.sh (issue #603).
#
# The subject DELETES Docker images on a daemon every parallel integ lane
# shares, so the failure it can produce is another lane losing an image
# mid-run. That is why it is fenced here rather than left to the six fixtures
# that call it.
#
# What it pins, in the order the failure would hurt:
#
#   1. A snapshot that could not be written NEVER arms the cleanup. This was a
#      live fail-open in the first version: the temp path was published to the
#      baseline variable BEFORE the snapshot was written into it, so a failed
#      or truncated write left an EMPTY baseline, which makes the delta the
#      ENTIRE namespace. Section 1 drives the old shape and the new one over
#      the same input and requires them to disagree -- if they ever agree
#      again, the regression is back.
#   2. Only tags that appeared AFTER the baseline are removed; anything present
#      before it survives. That is the whole peer-lane guarantee.
#   3. Re-entrancy: fixtures trap `EXIT INT TERM`, so cleanup can fire twice.
#      The second firing must remove nothing and exit 0.
#   4. Multiple filters are honoured (local-invoke-agentcore needs two, and a
#      one-filter snapshot silently leaves the other namespace behind).
#   5. Every fixture that builds an image sources the library and calls BOTH
#      halves -- with a population floor, because the list is derived and a
#      predicate that stops matching would silently empty the suite while
#      still printing `fail: 0`.
#   6. local-invoke-agentcore COMPOSES the call into its existing progressive
#      `trap ... EXIT` chain instead of adding one. A second `trap ... EXIT`
#      REPLACES the first, so a new trap would silently drop the temp-file
#      cleanup that chain carries.
#
# `docker` is STUBBED on PATH throughout: the logic under test is set algebra
# over `docker images` output, so a real daemon would make this slower, flaky
# and unavailable in CI without buying a single additional assertion.
#
# Must stay green under macOS system bash 3.2 as well as modern bash: no
# `${var,,}`, no associative arrays, no `mapfile`.
#
# Run: bash tests/integration/_lib/image-cleanup.test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
LIB="${ROOT}/tests/integration/_lib/image-cleanup.sh"
pass=0
fail=0

ok()   { pass=$((pass+1)); echo "ok   $1"; }
bad()  { fail=$((fail+1)); echo "FAIL $1"; }
check(){ # check <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 -- got [$2] want [$3]"; fi
}

[ -f "${LIB}" ] || { echo "FAIL library not found at ${LIB}"; exit 1; }

# --- docker stub -------------------------------------------------------------
# STUB_IMAGES is a newline-separated "<filterglob> <tag>" table. `docker images
# --filter reference=<glob>` prints the tags whose glob matches. `docker image
# rm` appends to STUB_RM_LOG. Deliberately NOT sorted on output, so a caller
# that forgets to sort before `comm` fails here rather than in production.
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "${STUB_DIR}"' EXIT
cat > "${STUB_DIR}/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  images)
    glob=""
    for a in "$@"; do
      case "$a" in reference=*) glob="${a#reference=}" ;; esac
    done
    # A chosen filter can FAIL. Without this the stub always exits 0, so a
    # per-filter `docker images` failure is unreachable and the swallowed-status
    # fail-open (a `for ... done | sort` pipeline reports only its LAST
    # iteration) cannot be fenced at all.
    if [ -n "${STUB_FAIL_FILTER:-}" ] && [ "${glob}" = "${STUB_FAIL_FILTER}" ]; then
      echo "stub: simulated docker failure for ${glob}" >&2
      exit 1
    fi
    while IFS=' ' read -r g t; do
      [ -n "${g:-}" ] || continue
      [ "$g" = "$glob" ] || continue
      printf '%s\n' "$t"
    done < "${STUB_IMAGES_FILE}"
    ;;
  image)
    shift
    if [ "${1:-}" = "rm" ]; then
      shift
      for t in "$@"; do printf '%s\n' "$t" >> "${STUB_RM_LOG}"; done
    fi
    ;;
esac
exit 0
STUB
chmod +x "${STUB_DIR}/docker"
PATH="${STUB_DIR}:${PATH}"
export PATH
STUB_IMAGES_FILE="${STUB_DIR}/images.txt"
STUB_RM_LOG="${STUB_DIR}/rm.log"
STUB_FAIL_FILTER=""
export STUB_IMAGES_FILE STUB_RM_LOG STUB_FAIL_FILTER

set_images() { printf '%s\n' "$@" > "${STUB_IMAGES_FILE}"; }
removed()    { [ -f "${STUB_RM_LOG}" ] && sort "${STUB_RM_LOG}" | tr '\n' ' ' | sed 's/ $//' || true; }
reset_rm()   { : > "${STUB_RM_LOG}"; }

# shellcheck source=/dev/null
. "${LIB}"

echo "== 1. a snapshot that cannot be written never arms the cleanup"
# The OLD shape, transcribed, driven over the same input. It must DIFFER from
# the new one; an assertion that both "do the right thing" would pass even if
# the fix were reverted, so the disagreement itself is the assertion.
set_images 'cdkl-x-* cdkl-x-peer1:local' 'cdkl-x-* cdkl-x-peer2:local'
old_delta="$(
  OLD_BEFORE="$(mktemp)"                 # path published FIRST
  false > "${OLD_BEFORE}" || true        # ...and the write then fails
  docker images --filter 'reference=cdkl-x-*' --format '{{.Repository}}:{{.Tag}}' \
    | sort | comm -13 "${OLD_BEFORE}" - | tr '\n' ' ' | sed 's/ $//'
)"
check "old shape would delete every peer tag" \
  "${old_delta}" "cdkl-x-peer1:local cdkl-x-peer2:local"

INTEG_IMAGES_BEFORE=""
reset_rm
(
  # Force the snapshot write to fail.
  integ_image_snapshot() { return 1; }
  integ_image_cleanup_init 'cdkl-x-*'
  rc=$?
  printf '%s|%s\n' "${rc}" "${INTEG_IMAGES_BEFORE}" > "${STUB_DIR}/initres"
)
initres="$(cat "${STUB_DIR}/initres")"
check "new shape: init reports failure and arms nothing" "${initres}" "1|"

# And with nothing armed, the cleanup must be inert.
INTEG_IMAGES_BEFORE=""
reset_rm
integ_image_cleanup_run
check "new shape: unarmed cleanup removes nothing" "$(removed)" ""

echo "== 2. only tags that appeared after the baseline are removed"
INTEG_IMAGES_BEFORE=""
reset_rm
set_images 'cdkl-x-* cdkl-x-peer1:local' 'cdkl-x-* cdkl-x-peer2:local'
integ_image_cleanup_init 'cdkl-x-*'
check "init armed a baseline" "$([ -n "${INTEG_IMAGES_BEFORE}" ] && echo yes || echo no)" "yes"
set_images 'cdkl-x-* cdkl-x-peer1:local' 'cdkl-x-* cdkl-x-peer2:local' 'cdkl-x-* cdkl-x-mine:local'
integ_image_cleanup_run
check "removes only this run's tag" "$(removed)" "cdkl-x-mine:local"

echo "== 3. a second firing is a silent no-op"
reset_rm
integ_image_cleanup_run
rc=$?
check "second firing removes nothing" "$(removed)" ""
check "second firing exits 0" "${rc}" "0"

echo "== 4. every registered filter is snapshotted"
INTEG_IMAGES_BEFORE=""
reset_rm
set_images 'cdkl-a-* cdkl-a-old:latest' 'cdkl-b-* cdkl-b-old:latest'
integ_image_cleanup_init 'cdkl-a-*' 'cdkl-b-*'
set_images 'cdkl-a-* cdkl-a-old:latest' 'cdkl-a-* cdkl-a-new:latest' \
           'cdkl-b-* cdkl-b-old:latest' 'cdkl-b-* cdkl-b-new:latest'
integ_image_cleanup_run
check "both namespaces are cleaned" "$(removed)" "cdkl-a-new:latest cdkl-b-new:latest"

# A one-filter arm must NOT reach the second namespace -- this is the
# local-invoke-agentcore mistake, and it is invisible without this case.
INTEG_IMAGES_BEFORE=""
reset_rm
set_images 'cdkl-a-* cdkl-a-old:latest' 'cdkl-b-* cdkl-b-old:latest'
integ_image_cleanup_init 'cdkl-a-*'
set_images 'cdkl-a-* cdkl-a-old:latest' 'cdkl-a-* cdkl-a-new:latest' \
           'cdkl-b-* cdkl-b-old:latest' 'cdkl-b-* cdkl-b-new:latest'
integ_image_cleanup_run
check "a one-filter arm leaves the other namespace alone" "$(removed)" "cdkl-a-new:latest"

echo "== 4b. the snapshot is SORTED, which comm requires"
# Deliberately REVERSE-ordered stub data. `docker images` promises no order, and
# `comm` silently produces a wrong answer on unsorted input, so dropping the
# `| sort` must be visible here. It was not until this case existed: a mutation
# that removed the sort left the suite fully green because every other case
# happened to feed already-ordered data.
INTEG_IMAGES_BEFORE=""
reset_rm
set_images 'cdkl-s-* cdkl-s-zzz:latest' 'cdkl-s-* cdkl-s-mmm:latest' 'cdkl-s-* cdkl-s-aaa:latest'
integ_image_cleanup_init 'cdkl-s-*'
set_images 'cdkl-s-* cdkl-s-zzz:latest' 'cdkl-s-* cdkl-s-mmm:latest' \
           'cdkl-s-* cdkl-s-nnn:latest' 'cdkl-s-* cdkl-s-aaa:latest'
integ_image_cleanup_run
check "unordered daemon output still yields exactly the new tag" \
  "$(removed)" "cdkl-s-nnn:latest"

echo "== 4c. a cwd file matching a filter glob must not replace it"
# `${INTEG_IMAGE_FILTERS}` is expanded unquoted to split on whitespace, which
# also pathname-expands. With a matching FILE in the cwd the loop would see that
# FILENAME instead of the glob, so the snapshot would cover one tag instead of
# the namespace -- and an incomplete baseline puts every tag it missed into this
# run's delta. Measured before the `set -f` fix: the loop saw
# `cdkl-run-task-deadbeef` in place of `cdkl-run-task-*`.
INTEG_IMAGES_BEFORE=""
reset_rm
glob_cwd="$(mktemp -d)"
touch "${glob_cwd}/cdkl-g-decoy"
set_images 'cdkl-g-* cdkl-g-old:latest'
cd "${glob_cwd}" || exit 1
integ_image_cleanup_init 'cdkl-g-*'
set_images 'cdkl-g-* cdkl-g-old:latest' 'cdkl-g-* cdkl-g-mine:latest'
integ_image_cleanup_run
cd "${ROOT}" || exit 1
# Without `set -f` the baseline is narrowed to the decoy filename, so it misses
# `cdkl-g-old` and the pre-existing tag is deleted alongside this run's.
check "a decoy file in cwd does not narrow the snapshot" "$(removed)" "cdkl-g-mine:latest"
rm -rf "${glob_cwd}"

echo "== 4d. a tag REMOVED during the run is not resurrected into the delta"
# Every other case has an after-set that is a SUPERSET of the baseline, which
# makes `comm -13` and `comm -3` indistinguishable. Here the baseline holds a tag
# that is GONE afterwards: `-13` (lines only in the after-set) still yields just
# the new tag, while `-3` would also emit the vanished one and try to delete a
# tag that no longer exists.
INTEG_IMAGES_BEFORE=""
reset_rm
set_images 'cdkl-d-* cdkl-d-old:latest' 'cdkl-d-* cdkl-d-vanishes:latest'
integ_image_cleanup_init 'cdkl-d-*'
set_images 'cdkl-d-* cdkl-d-old:latest' 'cdkl-d-* cdkl-d-mine:latest'
integ_image_cleanup_run
check "a vanished baseline tag stays out of the delta" "$(removed)" "cdkl-d-mine:latest"

echo "== 4e. an armed-but-missing baseline file is a no-op, not a crash"
# `run` guards on `[ ! -f ]`. Without it `comm` is handed a nonexistent operand:
# it errors, `|| true` swallows that, `new` is empty, and the cleanup silently
# does nothing -- which LOOKS the same from outside. Assert the guard by way of
# the exit status and the absence of any removal.
INTEG_IMAGES_BEFORE=""
reset_rm
set_images 'cdkl-e-* cdkl-e-old:latest'
integ_image_cleanup_init 'cdkl-e-*'
rm -f "${INTEG_IMAGES_BEFORE}"          # the baseline file disappears
set_images 'cdkl-e-* cdkl-e-old:latest' 'cdkl-e-* cdkl-e-new:latest'
# stderr is the discriminator. Removing the guard leaves `comm` reading a
# nonexistent operand: it errors, `|| true` swallows the status, `new` comes out
# empty and NOTHING is removed -- identical from the outside. Only the error
# message distinguishes the two, so assert on it.
err4e="$(integ_image_cleanup_run 2>&1 >/dev/null)"; rc=$?
check "a missing baseline file removes nothing" "$(removed)" ""
check "a missing baseline file still exits 0" "${rc}" "0"
check "a missing baseline file produces no error output" "${err4e}" ""

echo "== 4f. a failure on a NON-LAST filter fails the whole snapshot"
# A `for ... done | sort` pipeline reports only the LAST iteration's status, so a
# `docker images` failure on any earlier filter is swallowed: `init` returns 0
# having armed a PARTIAL baseline, and every tag under the failed filter then
# looks new and is deleted. local-invoke-agentcore is the only two-filter caller
# and it puts the shared `cdkl-invoke-*` namespace FIRST -- the swallowed slot.
INTEG_IMAGES_BEFORE=""
reset_rm
set_images 'cdkl-p-* cdkl-p-peer:latest' 'cdkl-q-* cdkl-q-peer:latest'
STUB_FAIL_FILTER='cdkl-p-*'
integ_image_cleanup_init 'cdkl-p-*' 'cdkl-q-*'
rc=$?
STUB_FAIL_FILTER=''
check "init fails when the FIRST of two filters fails" "${rc}" "1"
check "init arms nothing when a filter failed" "${INTEG_IMAGES_BEFORE}" ""
integ_image_cleanup_run
check "nothing is deleted after a failed multi-filter snapshot" "$(removed)" ""

echo "== 5. init refuses with no filters"
INTEG_IMAGES_BEFORE=""
err="$(integ_image_cleanup_init 2>&1 >/dev/null)"; rc=$?
check "no-filter init exits non-zero" "$([ "${rc}" -ne 0 ] && echo yes || echo no)" "yes"
check "no-filter init explains itself" \
  "$(printf '%s' "${err}" | grep -c 'reference glob is required')" "1"
check "no-filter init arms nothing" "${INTEG_IMAGES_BEFORE}" ""

echo "== 6. every image-building fixture wires BOTH halves"
# Derived, not hand-listed. The floor below is what stops a predicate that
# stopped matching from silently emptying this section.
builders=""
for v in "${ROOT}"/tests/integration/*/verify.sh; do
  grep -q '_lib/image-cleanup.sh' "$v" || continue
  builders="${builders} $(basename "$(dirname "$v")")"
done
n=0
for b in ${builders}; do n=$((n+1)); done
check "population floor: at least 8 fixtures source the library" \
  "$([ "${n}" -ge 8 ] && echo yes || echo no)" "yes"
for b in ${builders}; do
  v="${ROOT}/tests/integration/${b}/verify.sh"
  check "${b}: calls integ_image_cleanup_init" \
    "$(grep -c 'integ_image_cleanup_init' "$v")" "1"
  check "${b}: calls integ_image_cleanup_run" \
    "$([ "$(grep -c 'integ_image_cleanup_run' "$v")" -ge 1 ] && echo yes || echo no)" "yes"
  # The `source` must come BEFORE the fixture's `cd "$(dirname "$0")"`.
  # `${BASH_SOURCE[0]}` holds the path the script was INVOKED with, so once the
  # cwd changes it no longer resolves and the source dies with "No such file or
  # directory" before a single assertion runs. Costs a whole integ round to find
  # by running, and nothing else in the repo would notice.
  src_ln="$(grep -n 'source .*_lib/image-cleanup.sh' "$v" | head -1 | cut -d: -f1)"
  cd_ln="$(grep -n '^cd "\$(dirname' "$v" | head -1 | cut -d: -f1)"
  check "${b}: sources the library before the cd" \
    "$([ -n "${cd_ln}" ] && [ "${src_ln}" -lt "${cd_ln}" ] && echo yes || echo no)" "yes"

  # The init must come BEFORE the first thing that could build into the
  # namespace; the daemon probe is the agreed anchor.
  init_ln="$(grep -n 'integ_image_cleanup_init' "$v" | head -1 | cut -d: -f1)"
  dv_ln="$(grep -n 'docker version' "$v" | head -1 | cut -d: -f1)"
  check "${b}: init runs after the docker daemon probe" \
    "$([ -n "${dv_ln}" ] && [ "${init_ln}" -gt "${dv_ln}" ] && echo yes || echo no)" "yes"
done

echo "== 7. local-invoke-agentcore composes into its trap chain, never adds one"
AC="${ROOT}/tests/integration/local-invoke-agentcore/verify.sh"
traps="$(grep -c '^trap ' "$AC")"
composed="$(grep -c "; integ_image_cleanup_run' EXIT" "$AC")"
check "every EXIT trap carries the cleanup" "${composed}" "${traps}"
check "the chain still has its 8 progressive handlers" "${traps}" "8"
# The last handler must still list every temp file the chain accumulated: a
# replacement trap would have dropped them. Count the `${VAR}` references rather
# than matching the call -- the previous spelling ORed in a bare
# `integ_image_cleanup_run` alternative, so it matched any line containing the
# call and stayed green when the final handler was reduced to one temp file.
last_trap="$(grep '^trap ' "$AC" | tail -1)"
first_trap="$(grep '^trap ' "$AC" | head -1)"
nlast="$(printf '%s' "${last_trap}" | grep -o '\${[A-Z0-9_]*}' | sort -u | wc -l | tr -d ' ')"
nfirst="$(printf '%s' "${first_trap}" | grep -o '\${[A-Z0-9_]*}' | sort -u | wc -l | tr -d ' ')"
check "the final trap lists the full accumulated temp-file set (8)" "${nlast}" "8"
check "the chain GREW: the first handler lists fewer files than the last" \
  "$([ "${nfirst}" -lt "${nlast}" ] && echo yes || echo no)" "yes"

echo
echo "pass: ${pass}  fail: ${fail}"
[ "${fail}" -eq 0 ]
