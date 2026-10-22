#!/usr/bin/env bash
# verify.sh — local-invoke-stage integ test (go-to-k/cdk-local#746)
#
# Fully local: nothing is deployed to AWS. The app is a top-level stack plus a
# NESTED cdk.Stage:
#
#   CdklLocalInvokeStageTop                  marker "top"
#   CdklLocalInvokeStage/Inner/Api           marker "api"
#   CdklLocalInvokeStage/Inner/ApiV2         marker "apiv2"
#
# Every stack carries the SAME logical ids (one shared construct), and the
# Stage stacks reach their asset — staged ONCE into the app's outdir — as
# `../../asset.<hash>`. Before #746 cdk-local enumerated only the top-level
# stack, so no command could reach a Stage target at all. The arms:
#
#   1-3. `cdkl invoke` each stack's handler by its display path; the response
#        marker proves the stack the target resolved to (`Api` vs `ApiV2`
#        shares a prefix, `CdklLocalInvokeStage` is a Stage id, not a stack).
#   3b.  `cdkl invoke` a CONTAINER Lambda in the Stage stack: its image asset
#        is found through the stack's own asset manifest, named after the
#        artifact id rather than the physical name.
#   4.   A bare target is refused as multi-stack: a Stage stack counts.
#   5.   `cdkl start-api <Stage target>` with NO --stack infers the Stage stack
#        from the target, serves exactly one API, and routes to `api`.
#   5b.  A subset spanning a Stage stack AND the top-level stack synthesizes
#        every stack, the unserved `ApiV2` clone included, yet boots: only the
#        SERVED stacks are checked for colliding logical ids.
#   6.   `cdkl start-api --all-stacks` is REFUSED: the clones share logical ids,
#        which start-api cannot serve side by side (never first-match).
#
# Run via `/run-integ local-invoke-stage` (recommended) or directly:
#
#     bash tests/integration/local-invoke-stage/verify.sh
#
# Requires Docker.

set -euo pipefail

cd "$(dirname "$0")"

CLI="node $(git rev-parse --show-toplevel)/dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3746

# --- capture (issue #577) --------------------------------------------------
# Runs the command with its exit status captured EXPLICITLY, so `set -e` never
# fires at an assignment. On a non-zero exit it prints the status, the last
# stdout line and the tail of the captured stderr, and emits NOTHING on stdout,
# so the assertion still runs and FAILS with its own text. Every copy of this
# function is byte-identical; the fence is
# tests/unit/integ-verify-capture-shape.test.ts.
CDKL_STDERR="$(mktemp)"
capture() {
  local out rc=0
  out="$("$@" 2>"${CDKL_STDERR}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] command exited ${rc}: $*" >&2
    echo "[verify] last stdout line: $(printf '%s\n' "${out}" | tail -1)" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "${CDKL_STDERR}" >&2
    return 0
  fi
  printf '%s\n' "${out}" | tail -1
}

LOG_FILE="$(mktemp)"
REFUSAL_LOG="$(mktemp)"
SERVER_PID=""

fail() {
  echo "FAIL: $*" >&2
  if [[ -s "${LOG_FILE}" ]]; then
    echo "--- start-api log ---" >&2
    cat "${LOG_FILE}" >&2
  fi
  exit 1
}

term_server() {
  local pid="$1"
  if [[ -n "${pid:-}" ]] && kill -0 "${pid}" 2>/dev/null; then
    echo "==> Sending SIGTERM to start-api (pid ${pid})"
    kill -TERM "${pid}" 2>/dev/null || true
    for _ in $(seq 1 120); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${pid}" 2>/dev/null; then
      echo "==> start-api did not exit within 120s; SIGKILL"
      kill -KILL "${pid}" 2>/dev/null || true
    fi
  fi
}

cleanup() {
  local rc=$?
  term_server "${SERVER_PID:-}"
  ORPHANS=$(docker ps -a --filter "name=cdkl-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "==> Cleaning up orphan containers"
    echo "${ORPHANS}" | xargs docker rm -f >/dev/null 2>&1 || true
  fi
  rm -f "${CDKL_STDERR}" "${LOG_FILE}" "${REFUSAL_LOG}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# expect_marker <label> <target> <marker>
expect_marker() {
  local label="$1" target="$2" marker="$3" result
  echo "==> ${label}: cdkl invoke ${target}"
  result=$(capture ${CLI} invoke "${target}" --no-pull)
  echo "    response: ${result}"
  echo "${result}" | grep -q "\"marker\":\"${marker}\"" \
    || fail "${label}: expected marker '${marker}' from ${target}, got: ${result}"
}

expect_marker "[1/6] nested Stage stack" "CdklLocalInvokeStage/Inner/Api/Handler" "api"
expect_marker "[2/6] prefix-sharing sibling" "CdklLocalInvokeStage/Inner/ApiV2/Handler" "apiv2"
expect_marker "[3/6] top-level stack" "CdklLocalInvokeStageTop/Handler" "top"
expect_marker "[3b/6] container Lambda in a Stage stack" "CdklLocalInvokeStage/Inner/Api/ImageHandler" "api-image"

echo "==> [4/6] a bare target is refused as multi-stack (a Stage stack counts)"
BARE=$(capture ${CLI} invoke Handler --no-pull)
[[ -z "${BARE}" ]] || fail "bare target unexpectedly succeeded: ${BARE}"
grep -q "Multiple stacks in app" "${CDKL_STDERR}" \
  || fail "bare target: expected the multi-stack refusal, stderr: $(tail -5 "${CDKL_STDERR}")"
grep -q "CdklLocalInvokeStage/Inner/Api" "${CDKL_STDERR}" \
  || fail "bare target: the refusal does not name the Stage stack: $(tail -5 "${CDKL_STDERR}")"
echo "    ok: refused, naming the Stage stacks"

echo "==> [5/6] cdkl start-api on a Stage target, with no --stack"
${CLI} start-api CdklLocalInvokeStage/Inner/Api/HttpApi \
  --port "${PORT}" \
  --container-host 127.0.0.1 \
  --no-pull \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

READY=0
for _ in $(seq 1 120); do
  if grep -q "Server listening" "${LOG_FILE}" 2>/dev/null; then
    READY=1
    break
  fi
  kill -0 "${SERVER_PID}" 2>/dev/null || fail "start-api exited before it was ready"
  sleep 0.5
done
[[ "${READY}" -eq 1 ]] || fail "start-api was not ready within 60s"

RESPONSE=""
for _ in $(seq 1 10); do
  if RESPONSE=$(curl -sf --max-time 30 "http://127.0.0.1:${PORT}/marker" 2>&1) \
    && echo "${RESPONSE}" | grep -q '"marker":"api"'; then
    break
  fi
  RESPONSE="${RESPONSE:-<no response>}"
  sleep 1
done
echo "${RESPONSE}" | grep -q '"marker":"api"' \
  || fail "start-api: GET /marker did not reach the Stage stack's handler, got: ${RESPONSE}"
echo "    ok: GET /marker -> ${RESPONSE}"

SERVERS=$(grep -c "Server listening" "${LOG_FILE}") || SERVERS=0
[[ "${SERVERS}" -eq 1 ]] || fail "start-api: expected exactly 1 server for one Stage API, got ${SERVERS}"
echo "    ok: exactly one server"

term_server "${SERVER_PID}"
SERVER_PID=""

echo "==> [5b/6] a subset spanning stacks ignores the unserved Stage clone"
: >"${LOG_FILE}"
${CLI} start-api CdklLocalInvokeStage/Inner/Api/HttpApi CdklLocalInvokeStageTop/HttpApi \
  --port "${PORT}" \
  --container-host 127.0.0.1 \
  --no-pull \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!
READY=0
for _ in $(seq 1 120); do
  SERVERS=$(grep -c "Server listening" "${LOG_FILE}" 2>/dev/null) || SERVERS=0
  if [[ "${SERVERS}" -ge 2 ]]; then
    READY=1
    break
  fi
  kill -0 "${SERVER_PID}" 2>/dev/null || fail "start-api (subset) exited before it was ready"
  sleep 0.5
done
[[ "${READY}" -eq 1 ]] || fail "start-api (subset) did not bring up 2 servers within 60s"
grep -q "declared by" "${LOG_FILE}" && fail "start-api (subset) reported a logical-id collision"
SERVERS=$(grep -c "Server listening" "${LOG_FILE}") || SERVERS=0
[[ "${SERVERS}" -eq 2 ]] || fail "start-api (subset): expected exactly 2 servers, got ${SERVERS}"
echo "    ok: 2 servers, no collision refusal"
# Each served stack answers with its OWN handler (one port per API).
MARKERS=""
for p in "${PORT}" "$((PORT + 1))"; do
  R=""
  for _ in $(seq 1 10); do
    R=$(curl -sf --max-time 30 "http://127.0.0.1:${p}/marker" 2>/dev/null) && break
    sleep 1
  done
  MARKERS="${MARKERS} $(echo "${R}" | sed -n 's/.*"marker":"\([a-z-]*\)".*/\1/p')"
done
SORTED=$(echo ${MARKERS} | tr ' ' '\n' | sort | tr '\n' ' ')
[[ "${SORTED}" == "api top " ]] || fail "start-api (subset): expected markers 'api top', got '${SORTED}'"
echo "    ok: the two ports answer api + top"
term_server "${SERVER_PID}"
SERVER_PID=""
: >"${LOG_FILE}"

echo "==> [6/6] start-api --all-stacks is refused: the Stage clones share logical ids"
# Backgrounded and BOUNDED: were the refusal to regress, the server would
# serve forever instead of exiting.
${CLI} start-api --all-stacks --port "${PORT}" --no-pull >"${REFUSAL_LOG}" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 120); do
  kill -0 "${SERVER_PID}" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "${SERVER_PID}" 2>/dev/null; then
  fail "--all-stacks was still running after 60s instead of refusing: $(tail -5 "${REFUSAL_LOG}")"
fi
REFUSED_RC=0
wait "${SERVER_PID}" || REFUSED_RC=$?
SERVER_PID=""
[[ "${REFUSED_RC}" -ne 0 ]] || fail "--all-stacks unexpectedly exited 0: $(tail -5 "${REFUSAL_LOG}")"
grep -q "is declared by 3 of the served stacks" "${REFUSAL_LOG}" \
  || fail "--all-stacks: expected the logical-id collision refusal, got: $(tail -5 "${REFUSAL_LOG}")"
echo "    ok: refused (exit ${REFUSED_RC}), naming the colliding stacks"

echo "==> All local-invoke-stage tests passed"
