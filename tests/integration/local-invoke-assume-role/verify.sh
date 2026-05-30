#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl invoke --assume-role` in both
# the EXPLICIT (`--assume-role <arn>`) and BARE (`--assume-role` +
# `--from-cfn-stack`) forms.
#
# The fixture deploys a CFn stack with one Lambda whose execution role
# trusts both `lambda.amazonaws.com` AND the deploying account's root,
# so a developer can `sts:AssumeRole` into it locally. The Lambda's
# handler calls `sts:GetCallerIdentity` and returns the result; verify.sh
# greps for the `assumed-role/<RoleName>` pattern that proves cdkl wrote
# the assumed-role STS credentials into the container's AWS_* env vars.
#
# Two test cases:
#   1. Baseline: `cdkl invoke --from-cfn-stack <stack>` (no --assume-role)
#      -> By design, cdkl does NOT inject the developer's shell credentials
#         into the container; the in-container STS call fails with
#         CredentialsProviderError. The assertion is just that no implicit
#         assumed-role identity leaks in.
#   2. Explicit: `cdkl invoke --from-cfn-stack <stack> --assume-role <arn>`
#      -> Lambda sees `arn:aws:sts::<account>:assumed-role/<RoleName>/<...>`.
#
# The bare form (`--assume-role` with no value) is NOT covered here. With
# the current CFn state provider it auto-resolves to `undefined` for any
# Lambda whose execution role is a sibling resource in the same stack —
# `attributes.Arn` is never populated from `ListStackResources` (which
# returns PhysicalResourceId, the role NAME, not the ARN). Tracked as
# issue #181 so this fixture covers what does work today.
#
# Run via `/run-integ local-invoke-assume-role` (recommended) or directly:
#
#     bash tests/integration/local-invoke-assume-role/verify.sh
#
# Requires Docker + AWS credentials with deploy permissions in the target
# account, plus the upstream `cdk` CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkLocalInvokeAssumeRoleFixture"
IMAGE="public.ecr.aws/lambda/nodejs:20"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-assume-role"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed)"

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

# Sentinel gates the cleanup trap: only run `cdk destroy` on a stack
# THIS run created, never on a pre-existing one with the same name.
WE_CREATED_STACK=0
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first via:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 3: cdk deploy (upstream CDK CLI)"
# Set the sentinel BEFORE `cdk deploy` so an early-failure path still
# triggers the destroy attempt — pre-flight has already verified the
# namespace is clean, so we own it from this point on. Mirrors the
# pattern in local-invoke-from-cfn-stack.
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

echo "[verify] step 4: read deployed role ARN from CFn outputs + account id"
ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query 'Stacks[0].Outputs[?OutputKey==`ExecRoleArn`].OutputValue | [0]' \
  --output text)
if [ -z "${ROLE_ARN}" ] || [ "${ROLE_ARN}" = "None" ]; then
  echo "[verify] FAIL: could not read ExecRoleArn output from ${STACK}"
  exit 1
fi
ACCOUNT=$(aws sts get-caller-identity --query 'Account' --output text)
ROLE_NAME="${ROLE_ARN##*/}"
echo "[verify]   role: ${ROLE_ARN}"
echo "[verify]   account: ${ACCOUNT}"

# IAM role propagation is eventually consistent — sts:AssumeRole can
# fail with "no identity-based policy allows the action" for ~5-10s
# after the role is created. Retry up to 30s before failing.
echo "[verify] step 4b: wait for sts:AssumeRole to succeed (IAM propagation)"
PROPAGATED=0
for _ in $(seq 1 15); do
  if aws sts assume-role --role-arn "${ROLE_ARN}" --role-session-name cdkl-integ-probe \
       --duration-seconds 900 >/dev/null 2>&1; then
    PROPAGATED=1
    break
  fi
  sleep 2
done
if [ "${PROPAGATED}" -ne 1 ]; then
  echo "[verify] FAIL: sts:AssumeRole into ${ROLE_ARN} did not succeed within 30s"
  aws sts assume-role --role-arn "${ROLE_ARN}" --role-session-name cdkl-integ-probe \
    --duration-seconds 900 2>&1 | head -5
  exit 1
fi
echo "[verify]   IAM trust propagated"

invoke_capture() {
  # Run cdkl invoke and return the last JSON-looking line on stdout.
  # `--no-pull` skips docker pull (image already cached by step 1c) so the
  # repeat invocations are fast. Stderr is dropped; if assertion fails we
  # re-run without the drop for diagnostics in the FAIL branch.
  ${CLI} invoke "$@" --no-pull 2>/dev/null | tail -1
}

echo "[verify] step 5: baseline — cdkl invoke --from-cfn-stack (no --assume-role)"
# By design, cdkl does NOT inject the developer's shell credentials into
# the container; it injects credentials ONLY when --assume-role is on.
# So the Lambda sees no AWS_ACCESS_KEY_ID / etc. at all and the in-container
# STS call fails with CredentialsProviderError. The negative assertion that
# matters: no assumed-role marker appears (cdkl did NOT secretly assume
# anything on the user's behalf).
RESULT_BASELINE=$(invoke_capture "${STACK}/EchoIdentityHandler" --from-cfn-stack)
echo "[verify]   response: ${RESULT_BASELINE}"
echo "${RESULT_BASELINE}" | grep -q 'CredentialsProviderError' || {
  echo "[verify] FAIL: baseline expected CredentialsProviderError (no creds in container by default), got: ${RESULT_BASELINE}"
  echo "[verify]   stderr re-run:"
  ${CLI} invoke "${STACK}/EchoIdentityHandler" --from-cfn-stack --no-pull 2>&1 | tail -10
  exit 1
}
if echo "${RESULT_BASELINE}" | grep -q ':assumed-role/'; then
  echo "[verify] FAIL: baseline unexpectedly saw an assumed-role ARN: ${RESULT_BASELINE}"
  exit 1
fi
echo "[verify]   ok: baseline container has no AWS creds (no implicit credential injection)"

echo "[verify] step 6: explicit ARN — cdkl invoke --assume-role <arn>"
echo "[verify]   expect assumed-role/${ROLE_NAME} marker in the Lambda's STS identity"
RESULT_EXPLICIT=$(invoke_capture "${STACK}/EchoIdentityHandler" --from-cfn-stack --assume-role "${ROLE_ARN}")
echo "[verify]   response: ${RESULT_EXPLICIT}"
ASSUMED_RE="arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE_NAME}/"
echo "${RESULT_EXPLICIT}" | grep -q "${ASSUMED_RE}" || {
  echo "[verify] FAIL: expected assumed-role pattern ${ASSUMED_RE}*, got: ${RESULT_EXPLICIT}"
  echo "[verify]   stderr re-run:"
  ${CLI} invoke "${STACK}/EchoIdentityHandler" --from-cfn-stack --assume-role "${ROLE_ARN}" --no-pull 2>&1 | tail -10
  exit 1
}
echo "[verify]   ok: explicit --assume-role <arn> assumed the role; Lambda saw assumed-role identity"

echo "[verify] step 7: cdk destroy --force"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata
WE_CREATED_STACK=0

echo ""
echo "[verify] All checks passed:"
echo "[verify]   - baseline (no --assume-role): container has no AWS creds (cdkl does not auto-inject the shell credentials); STS fails with CredentialsProviderError."
echo "[verify]   - explicit --assume-role <arn>: Lambda sees arn:aws:sts::<acct>:assumed-role/<RoleName>/<session>."
