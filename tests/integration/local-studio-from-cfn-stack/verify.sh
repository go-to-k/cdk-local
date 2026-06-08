#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl studio --from-cfn-stack` ECS pin
# classification (issue #354).
#
# Why this exists: `cdkl studio` computes each servable ECS service's `pinned`
# flag ONCE at boot. A service whose container image is an INTRINSIC ECR URI
# (e.g. `ContainerImage.fromEcrRepository(repo)`) is only resolvable with the
# deployed-state image-resolution context — which studio builds ONLY when
# `--from-cfn-stack` is passed at boot. Before issue #354 the classify callback
# resolved WITHOUT that context and swallowed the failure silently, so the
# service was left UNMARKED and the UI never offered the image-override picker,
# even though `cdkl start-service --from-cfn-stack` detects the same pin.
#
# This test deploys a fixture stack carrying an ECR repo + an ECS Fargate
# service pinned to that repo's intrinsic image URI, then:
#
#   1. boots `cdkl studio --from-cfn-stack <stack>` and asserts the service
#      entry in GET /api/targets has "pinned":true (the issue #354 fix), and
#   2. boots `cdkl studio` WITHOUT --from-cfn-stack as a NEGATIVE CONTROL and
#      asserts the SAME service is NOT pinned (the intrinsic URI is
#      unresolvable without the deployed-state context) AND carries
#      "pinUnresolved":true, the browser-hint flag that makes the composer
#      surface the Session-bar --from-cfn-stack remedy a browser-only user
#      would otherwise never see (the terminal WARN does not reach the browser).
#
# The service deploys with desiredCount:0 so no task ever launches and no image
# is pushed to the repo — the deploy only needs to CREATE the ECR repository so
# its physical id / URI resolves under --from-cfn-stack.
#
# Run via `/run-integ local-studio-from-cfn-stack` (recommended) or directly:
#
#     bash tests/integration/local-studio-from-cfn-stack/verify.sh
#
# Requires Docker (studio boot pre-flights it) AND AWS credentials with deploy
# permissions. Also requires the global `cdk` (aws-cdk) CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalStudioFromCfnStackFixture"
# The servable ECS service target id is the CDK display path. The L2
# FargateService nests its AWS::ECS::Service under a `Service` node, so the
# listed id is `<Stack>/AppService/Service` (confirm with `cdkl list`).
SERVICE_ID="${STACK}/AppService/Service"
HOST="127.0.0.1"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-studio-from-cfn-stack"
CDKL="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed)"

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: install fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "[verify] step 1c: verifying Docker is available (studio boot pre-flights it)"
docker version --format '{{.Server.Version}}' >/dev/null

# State the studio process(es) + temp files clean up on every exit. The stack
# teardown is gated on a "we created it" sentinel so the pre-flight orphan
# scan's `exit 1` (a same-named stack pre-exists) never destroys user
# resources.
WE_CREATED_STACK=0
STUDIO_PID=""
LOG_FILE=$(mktemp)
BODY_FILE=$(mktemp)
cleanup() {
  rc=$?
  if [[ -n "${STUDIO_PID}" ]] && kill -0 "${STUDIO_PID}" 2>/dev/null; then
    kill "${STUDIO_PID}" 2>/dev/null || true
    wait "${STUDIO_PID}" 2>/dev/null || true
  fi
  if [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] tearing down: cdk destroy ${STACK}"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  rm -f "${LOG_FILE}" "${BODY_FILE}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first via:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 3: cdk deploy (upstream CDK CLI; desiredCount:0 => no task wait)"
# Set the sentinel BEFORE deploy: pre-flight verified the namespace is clean,
# so once we issue the deploy we OWN the namespace (cdk destroy is a no-op on
# a stack that never reached AWS, so this is safe on early-failure paths).
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

# Boot a short-lived studio, wait for /api/targets to answer, dump it to
# BODY_FILE, and tear the studio down. Args after the function name are passed
# verbatim to `cdkl studio`. Port 0 => OS-assigned; the bound URL is parsed
# from the boot log. Generous retries for a cold boot.
boot_studio_and_fetch_targets() {
  : >"${LOG_FILE}"
  ${CDKL} studio --no-open --studio-port 0 "$@" >"${LOG_FILE}" 2>&1 &
  STUDIO_PID=$!
  local url=""
  for _ in $(seq 1 120); do
    if ! kill -0 "${STUDIO_PID}" 2>/dev/null; then
      echo "[verify] FAIL: studio exited during boot (args: $*)"; cat "${LOG_FILE}"; return 1
    fi
    url=$(grep -oE "http://${HOST}:[0-9]+" "${LOG_FILE}" | head -1 || true)
    if [[ -n "${url}" ]] && curl -fsS "${url}/api/targets" -o "${BODY_FILE}" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  if [[ -z "${url}" ]]; then
    echo "[verify] FAIL: studio never printed a bound URL (args: $*)"; cat "${LOG_FILE}"; return 1
  fi
  # Final authoritative fetch.
  curl -fsS "${url}/api/targets" -o "${BODY_FILE}"
  kill "${STUDIO_PID}" 2>/dev/null || true
  wait "${STUDIO_PID}" 2>/dev/null || true
  STUDIO_PID=""
}

# Assert (or refute) that the service entry in BODY_FILE carries "pinned":true.
# The /api/targets payload is `{ "groups": [ { "entries": [ { "id", "pinned",
# ... } ] } ] }`. We recurse the whole parsed object to find the entry by id
# and check the pinned flag. python3 keeps the parse robust against key-order /
# whitespace.
service_is_pinned() {
  python3 - "$1" "${SERVICE_ID}" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
target_id = sys.argv[2]
def walk(obj):
    found = []
    if isinstance(obj, dict):
        if obj.get("id") == target_id:
            found.append(obj)
        for v in obj.values():
            found += walk(v)
    elif isinstance(obj, list):
        for v in obj:
            found += walk(v)
    return found
matches = walk(data)
if not matches:
    print("MISSING")
    sys.exit(0)
entry = matches[0]
print("PINNED" if entry.get("pinned") is True else "NOT_PINNED")
PY
}

# Report whether the service entry carries "pinUnresolved":true — the
# browser-hint flag the composer renders the Session-bar --from-cfn-stack
# remedy from. Set when the intrinsic-ECR image cannot be classified AND
# --from-cfn-stack is unbound; absent once the service resolves + pins.
service_pin_unresolved() {
  python3 - "$1" "${SERVICE_ID}" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
target_id = sys.argv[2]
def walk(obj):
    found = []
    if isinstance(obj, dict):
        if obj.get("id") == target_id:
            found.append(obj)
        for v in obj.values():
            found += walk(v)
    elif isinstance(obj, list):
        for v in obj:
            found += walk(v)
    return found
matches = walk(data)
if not matches:
    print("MISSING")
    sys.exit(0)
entry = matches[0]
print("UNRESOLVED" if entry.get("pinUnresolved") is True else "NOT_UNRESOLVED")
PY
}

echo "[verify] step 4: studio --from-cfn-stack — expect the service is pinned:true (issue #354 fix)"
boot_studio_and_fetch_targets --from-cfn-stack "${STACK}"
STATUS_CFN=$(service_is_pinned "${BODY_FILE}")
echo "[verify]   ${SERVICE_ID} under --from-cfn-stack: ${STATUS_CFN}"
if [ "${STATUS_CFN}" != "PINNED" ]; then
  echo "[verify] FAIL: expected ${SERVICE_ID} to be pinned:true under --from-cfn-stack, got ${STATUS_CFN}"
  echo "[verify]   /api/targets payload:"; cat "${BODY_FILE}"
  exit 1
fi
# A resolved + pinned service offers the Dockerfile picker, NOT the unresolved
# hint, so pinUnresolved must be absent here.
UNRES_CFN=$(service_pin_unresolved "${BODY_FILE}")
echo "[verify]   ${SERVICE_ID} under --from-cfn-stack pinUnresolved: ${UNRES_CFN}"
if [ "${UNRES_CFN}" = "UNRESOLVED" ]; then
  echo "[verify] FAIL: ${SERVICE_ID} should NOT be pinUnresolved under --from-cfn-stack (it is pinned)"
  echo "[verify]   /api/targets payload:"; cat "${BODY_FILE}"
  exit 1
fi

echo "[verify] step 5: studio WITHOUT --from-cfn-stack (negative control) — expect NOT pinned"
boot_studio_and_fetch_targets
STATUS_NO_CFN=$(service_is_pinned "${BODY_FILE}")
echo "[verify]   ${SERVICE_ID} without --from-cfn-stack: ${STATUS_NO_CFN}"
# Without the deployed-state context the intrinsic ECR URI is unresolvable, so
# the classifier leaves the service unmarked. Accept NOT_PINNED (the expected
# control outcome); MISSING would mean the service is not even listed (a synth
# regression), which is also a failure.
if [ "${STATUS_NO_CFN}" = "PINNED" ]; then
  echo "[verify] FAIL: ${SERVICE_ID} should NOT be pinned without --from-cfn-stack (negative control), got ${STATUS_NO_CFN}"
  echo "[verify]   /api/targets payload:"; cat "${BODY_FILE}"
  exit 1
fi
if [ "${STATUS_NO_CFN}" = "MISSING" ]; then
  echo "[verify] FAIL: ${SERVICE_ID} not listed at all without --from-cfn-stack (synth/list regression)"
  echo "[verify]   /api/targets payload:"; cat "${BODY_FILE}"
  exit 1
fi
# The new browser-hint flag: an unresolvable intrinsic-ECR service WITHOUT
# --from-cfn-stack must be marked pinUnresolved:true so the composer can render
# the Session-bar remedy a browser-only user would otherwise never see (the
# terminal WARN does not reach the browser).
UNRES_NO_CFN=$(service_pin_unresolved "${BODY_FILE}")
echo "[verify]   ${SERVICE_ID} without --from-cfn-stack pinUnresolved: ${UNRES_NO_CFN}"
if [ "${UNRES_NO_CFN}" != "UNRESOLVED" ]; then
  echo "[verify] FAIL: expected ${SERVICE_ID} to be pinUnresolved:true without --from-cfn-stack, got ${UNRES_NO_CFN}"
  echo "[verify]   /api/targets payload:"; cat "${BODY_FILE}"
  exit 1
fi

echo "[verify] step 6: cdk destroy --force (handled by the cleanup trap on exit)"

echo ""
echo "[verify] All checks passed:"
echo "[verify]   - issue #354: studio --from-cfn-stack marks the intrinsic-ECR-image ECS service pinned:true,"
echo "[verify]     so the UI offers the image-override Dockerfile picker."
echo "[verify]   - negative control: WITHOUT --from-cfn-stack the same service is left unmarked (unresolvable intrinsic image)"
echo "[verify]     AND carries pinUnresolved:true so the browser composer hints at the Session-bar --from-cfn-stack remedy."
