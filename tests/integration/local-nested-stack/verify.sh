#!/usr/bin/env bash
#
# verify.sh — local-nested-stack integ test (go-to-k/cdk-local#986)
#
# Fully local: no AWS resources are deployed. A CDK `NestedStack` (and a
# NestedStack inside it) holds a Lambda, a REST API and a Fargate task; every
# `local` command must address them by construct path (`Stack/Inner/Fn`) or
# `Stack:LogicalId`, and a single-top-level-stack app must auto-pick the nested
# API under `start-api` with no `--stack`.
#
# Run via `/run-integ local-nested-stack` (recommended) or directly:
#
#     bash tests/integration/local-nested-stack/verify.sh
#
# Requires Docker.

set -euo pipefail

STACK="CdklIntegNestedStack"
LAMBDA_IMAGE="public.ecr.aws/lambda/nodejs:20"
TASK_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-nested-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

LOG_FILE="$(mktemp)"
CDKL_STDERR="$(mktemp)"
SERVER_PID=""

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      kill -KILL "${SERVER_PID}" 2>/dev/null || true
    fi
  fi
  SERVER_PID=""
}

cleanup() {
  rc=$?
  stop_server
  ORPHANS=$(docker ps -a --filter "name=cdkl-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "[verify] cleaning up orphan containers"
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  docker network ls --filter "name=cdkl-task-" --format '{{.ID}}' 2>/dev/null \
    | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -f "${LOG_FILE}" "${CDKL_STDERR}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "[verify] --- captured stderr ---" >&2
  cat "${CDKL_STDERR}" >&2 || true
  echo "[verify] --- server log ---" >&2
  cat "${LOG_FILE}" >&2 || true
  exit 1
}

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

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${LAMBDA_IMAGE} and ${TASK_IMAGE}"
docker pull "${LAMBDA_IMAGE}"
docker pull "${TASK_IMAGE}"

echo "[verify] step 2: synthesize and read the logical ids from the nested templates"
rm -rf "${TEST_DIR}/cdk.out"
(cd "${TEST_DIR}" && CDK_OUTDIR=cdk.out node bin/app.ts >/dev/null)
# The nested template files are named after the nested stack's construct path.
nested_logical_id() {
  # $1 = construct-path suffix of the Lambda (e.g. Inner/Deeper/DeepFn)
  node -e '
    const fs = require("fs");
    const dir = "cdk.out";
    const want = process.argv[1];
    const found = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json") && n.includes("nested"))) {
      let t; try { t = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")); } catch { continue; }
      for (const [id, r] of Object.entries(t.Resources || {})) {
        if (r.Type === "AWS::Lambda::Function" && (r.Properties?.Environment?.Variables?.WHO === want)) found.push(id);
      }
    }
    process.stdout.write(found[0] || "");
  ' "$1"
}
DEEP_LOGICAL_ID="$(nested_logical_id deep)"
INNER_LOGICAL_ID="$(nested_logical_id inner)"
[ -n "${DEEP_LOGICAL_ID}" ] || fail "could not find DeepFn's logical id in the synthesized nested templates"
[ -n "${INNER_LOGICAL_ID}" ] || fail "could not find InnerFn's logical id in the synthesized nested templates"
echo "[verify]   InnerFn=${INNER_LOGICAL_ID} DeepFn=${DEEP_LOGICAL_ID}"

assert_who() {
  # $1 = description, $2 = expected who, rest = command
  local desc="$1" want="$2"
  shift 2
  local out
  out="$(capture "$@")"
  echo "[verify]   ${desc}: ${out}"
  echo "${out}" | grep -q "\"who\":\"${want}\"" || fail "${desc}: expected who=${want}, got: ${out}"
}

echo "[verify] step 3: invoke by construct path"
assert_who "invoke ${STACK}/Inner/InnerFn" inner ${CLI} invoke "${STACK}/Inner/InnerFn" --no-pull
assert_who "invoke ${STACK}/Inner/Deeper/DeepFn" deep ${CLI} invoke "${STACK}/Inner/Deeper/DeepFn" --no-pull
assert_who "invoke ${STACK}/OuterFn" outer ${CLI} invoke "${STACK}/OuterFn" --no-pull

echo "[verify] step 4: invoke by Stack:LogicalId (logical id inside the nested template)"
assert_who "invoke ${STACK}:${DEEP_LOGICAL_ID}" deep ${CLI} invoke "${STACK}:${DEEP_LOGICAL_ID}" --no-pull

echo "[verify] step 5: invoke by bare logical id (single top-level stack)"
assert_who "invoke ${INNER_LOGICAL_ID}" inner ${CLI} invoke "${INNER_LOGICAL_ID}" --no-pull

echo "[verify] step 6: baseline — an unknown nested target exits non-zero and lists the nested functions"
set +e
${CLI} invoke "${STACK}/Inner/Nope" --no-pull >/dev/null 2>"${CDKL_STDERR}"
NOPE_RC=$?
set -e
[ "${NOPE_RC}" -ne 0 ] || fail "invoke of a nonexistent nested target exited 0"
grep -qF "${STACK}/Inner/Deeper/DeepFn" "${CDKL_STDERR}" \
  || fail "the unknown-target error did not list ${STACK}/Inner/Deeper/DeepFn"
echo "[verify]   OK: rc=${NOPE_RC}, stderr lists the nested functions"

echo "[verify] step 7: start-api with no --stack serves the NESTED API"
: >"${LOG_FILE}"
${CLI} start-api --no-pull >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!
READY=0
for _ in $(seq 1 120); do
  if grep -q "Server listening" "${LOG_FILE}" 2>/dev/null; then
    READY=1
    break
  fi
  kill -0 "${SERVER_PID}" 2>/dev/null || break
  sleep 0.5
done
if [[ "${READY}" -eq 0 ]]; then
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    fail "start-api did not become ready within 60s"
  fi
  fail "start-api exited before it was ready"
fi
PORT="$(grep -E 'Server listening on http://' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)"
[ -n "${PORT}" ] || fail "could not parse the start-api port"
BODY=""
for _ in 1 2 3 4 5; do
  BODY="$(curl -s "http://127.0.0.1:${PORT}/" || true)"
  echo "${BODY}" | grep -q '"who"' && break
  sleep 2
done
echo "[verify]   GET / on :${PORT}: ${BODY}"
echo "${BODY}" | grep -q '"who":"inner"' || fail "GET / expected who=inner, got: ${BODY}"
stop_server

echo "[verify] step 8: run-task on the nested Fargate task definition"
TASK_OUT="$(${CLI} run-task "${STACK}/Inner/Task" --no-pull 2>"${CDKL_STDERR}")" \
  || { echo "${TASK_OUT}" >&2; fail "run-task exited non-zero"; }
echo "${TASK_OUT}" | grep -qF "NESTED_TASK_OK WHO=task" \
  || { echo "${TASK_OUT}" >&2; fail "run-task stdout lacks 'NESTED_TASK_OK WHO=task'"; }
echo "[verify]   OK: run-task printed NESTED_TASK_OK WHO=task"

echo ""
echo "[verify] All local-nested-stack checks passed."
