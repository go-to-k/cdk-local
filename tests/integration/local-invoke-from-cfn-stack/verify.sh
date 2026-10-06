#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkl invoke --from-cfn-stack`
# (issue #606).
#
# Why this exists: the host's S3-state path (e.g. cdkd's `--from-state`)
# covers stacks deployed via the host CLI. Issue #606 adds a parallel
# path for CDK apps deployed via the upstream CDK CLI (cdk deploy →
# CloudFormation). The only way to exercise that round-trip is to deploy
# the fixture via `cdk deploy` and then invoke locally with
# `--from-cfn-stack`, which reads physical IDs via
# `cloudformation:DescribeStackResources` instead of host-managed state.
#
# Steps:
#   1. install + build cdk-local (root) + install fixture deps + docker pull
#   2. cdk deploy CdkLocalInvokeFromCfnStackFixture-<lane> (upstream CDK CLI)
#   3. baseline: cdkl invoke (no --from-cfn-stack) — assert
#      TABLE_NAME comes through as "unset" (env var dropped because it's
#      intrinsic-valued and the default behavior warns + drops).
#   4. issue #606: cdkl invoke --from-cfn-stack — assert TABLE_NAME
#      is the actual deployed DynamoDB table name, and STATIC_VALUE still
#      passes through unchanged.
#   5. cdk destroy --force (the fixture lives in CFn, not in a host state store)
#
# Run via `/run-integ local-invoke-from-cfn-stack` (recommended) or directly:
#
#     bash tests/integration/local-invoke-from-cfn-stack/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the
# target account. Also requires the global `cdk` (aws-cdk) CLI on $PATH —
# see step 2's note on the vp-managed environment.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
# Lane-unique stack name (issue #582): every AWS-deploying fixture used to
# hard-code ONE name, so two worktree lanes shared one CloudFormation stack.
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
STACK="$(integ_stack_name CdkLocalInvokeFromCfnStackFixture)"
IMAGE="public.ecr.aws/lambda/nodejs:20"

# issue #94: the stack's DB_HOST env var is a Ref to an
# AWS::SSM::Parameter::Value<String> CFn parameter (synthesized by
# `ssm.StringParameter.valueForStringParameter`). CloudFormation resolves
# that parameter at the START of `cdk deploy`, so the SSM parameter must
# already exist — verify.sh `put-parameter`s it before deploy and deletes
# it on exit. SSM_PARAM_NAME is kept in sync with the stack's
# SSM_DB_HOST_PARAM constant.
SSM_PARAM_NAME="$(integ_scoped_name /cdkl-integ/invoke-from-cfn-stack/db-host)"
SSM_PARAM_VALUE="db.internal.example"

# issue #99: a SECOND SSM parameter that the stack Refs via API_KEY. It is
# created as a plain String BEFORE deploy (CloudFormation rejects an
# AWS::SSM::Parameter::Value<String> template parameter pointing at a
# SecureString) and SWAPPED to a SecureString AFTER deploy. cdkl resolves
# it directly via SSM GetParameters(WithDecryption) at invoke time, so it
# sees the SecureString type and must keep the decrypted value off the
# `docker run` argv. The post-swap value differs from the placeholder to
# prove cdkl reads SSM fresh (not the deploy-time-baked value).
SSM_API_KEY_PARAM="$(integ_scoped_name /cdkl-integ/invoke-from-cfn-stack/api-key)"
SSM_API_KEY_PLACEHOLDER="placeholder-not-secret"
SSM_API_KEY_VALUE="s3cr3t-api-key-9f3a2b"

# issue #784: CloudFormation dynamic references resolved locally. The stack's
# secret holds DYNREF_SECRET_PASSWORD (kept in sync with the stack constant).
# SSM_GONE_PARAM exists only for the deploy (CloudFormation resolves the
# DynrefMissingHandler's `{{resolve:ssm:...}}` at deploy time) and is deleted
# right after it, so a LOCAL resolve of that reference must fail loudly.
DYNREF_SECRET_PASSWORD="dynref-pw-7c1e94"
SSM_GONE_PARAM="$(integ_scoped_name /cdkl-integ/invoke-from-cfn-stack/dynref-gone)"
SECRET_ARN=""

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-from-cfn-stack"
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

# Gate the cleanup trap on a "we created the stack" sentinel. Without
# this guard, the EXIT trap would fire on the pre-flight orphan scan's
# `exit 1` (when a same-named stack pre-exists in the user's account)
# and run `cdk destroy` on a stack we did NOT create, silently deleting
# user resources. The sentinel is set only after `cdk deploy` succeeds.
WE_CREATED_STACK=0
WE_CREATED_PARAM=0
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  # The SSM parameter is created OUTSIDE the stack (CloudFormation must see
  # it BEFORE deploy), so delete it on EVERY exit — success or failure —
  # gated only on "we created it". Best-effort.
  if [ "${WE_CREATED_PARAM}" -eq 1 ]; then
    aws ssm delete-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
    aws ssm delete-parameter --name "${SSM_API_KEY_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
    aws ssm delete-parameter --name "${SSM_GONE_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # issue #784: a stack-deleted secret may linger in its recovery window;
  # purge it so no secret outlives the run. Best-effort, idempotent.
  if [ -n "${SECRET_ARN}" ]; then
    aws secretsmanager delete-secret --secret-id "${SECRET_ARN}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
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

echo "[verify] step 2b: put the SSM parameter the stack's DB_HOST resolves to"
# Must exist BEFORE cdk deploy: CloudFormation resolves the stack's
# AWS::SSM::Parameter::Value<String> parameter at deploy start. `--overwrite`
# keeps the put idempotent across reruns; cleanup() deletes it on exit.
WE_CREATED_PARAM=1
aws ssm put-parameter \
  --name "${SSM_PARAM_NAME}" \
  --value "${SSM_PARAM_VALUE}" \
  --type String \
  --overwrite \
  --region "${REGION}" >/dev/null
echo "[verify]   put ${SSM_PARAM_NAME}=${SSM_PARAM_VALUE}"
# issue #99: put the api-key param as a plain String for now — deploy must
# succeed (CloudFormation rejects an AWS::SSM::Parameter::Value<String> that
# points at a SecureString). It is swapped to a SecureString after deploy.
aws ssm put-parameter \
  --name "${SSM_API_KEY_PARAM}" \
  --value "${SSM_API_KEY_PLACEHOLDER}" \
  --type String \
  --overwrite \
  --region "${REGION}" >/dev/null
echo "[verify]   put ${SSM_API_KEY_PARAM}=${SSM_API_KEY_PLACEHOLDER} (String, pre-deploy)"
# issue #784: exists only for the deploy; deleted right after it (step 3c).
aws ssm put-parameter \
  --name "${SSM_GONE_PARAM}" \
  --value "deploy-time-only" \
  --type String \
  --overwrite \
  --region "${REGION}" >/dev/null
echo "[verify]   put ${SSM_GONE_PARAM} (deploy-time only)"

echo "[verify] step 3: cdk deploy (upstream CDK CLI)"
# The fixture deliberately uses upstream `cdk deploy` so the resulting
# stack is owned by CloudFormation, not by any host state store. The cdk CLI is supplied by
# vp's globally-managed environment (same pattern as
# import-nested-stack); no per-fixture install round-trip needed since
# Node's parent-dir resolution finds aws-cdk-lib from the repo root.
# Set the sentinel BEFORE `cdk deploy` rather than after — pre-flight
# has already verified the namespace is clean, so once we issue the
# deploy command we OWN the namespace (cdk destroy is a no-op on
# stacks that never reached AWS, so this is safe even on early-failure
# paths). Mirrors the matching fix in
# `tests/integration/local-invoke-from-cfn-stack-multi-stack/verify.sh`.
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

echo "[verify] step 3b: swap the api-key SSM parameter to a SecureString (issue #99)"
# SSM rejects an in-place type change on --overwrite, so delete + recreate.
# cdkl reads this value fresh via GetParameters(WithDecryption) at invoke
# time; the deploy-time-baked placeholder in the deployed Lambda env is
# irrelevant because cdkl's SSM resolution succeeds (no deployed-env
# fallback). The new value differs from the placeholder to prove freshness.
aws ssm delete-parameter --name "${SSM_API_KEY_PARAM}" --region "${REGION}" >/dev/null
aws ssm put-parameter \
  --name "${SSM_API_KEY_PARAM}" \
  --value "${SSM_API_KEY_VALUE}" \
  --type SecureString \
  --region "${REGION}" >/dev/null
echo "[verify]   swapped ${SSM_API_KEY_PARAM} -> SecureString"

echo "[verify] step 3c: delete the deploy-time-only parameter; record the secret ARN (issue #784)"
aws ssm delete-parameter --name "${SSM_GONE_PARAM}" --region "${REGION}" >/dev/null
SECRET_ARN=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query 'StackResources[?ResourceType==`AWS::SecretsManager::Secret`].PhysicalResourceId | [0]' \
  --output text)
if [ -z "${SECRET_ARN}" ] || [ "${SECRET_ARN}" = "None" ]; then
  echo "[verify] FAIL: could not read the deployed secret ARN from CloudFormation"
  SECRET_ARN=""
  exit 1
fi
echo "[verify]   secret: ${SECRET_ARN}"

echo "[verify] step 4: read the deployed DynamoDB table name from CloudFormation"
DEPLOYED_TABLE=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query 'StackResources[?ResourceType==`AWS::DynamoDB::Table`].PhysicalResourceId | [0]' \
  --output text)
echo "[verify]   deployed table: ${DEPLOYED_TABLE}"
if [ -z "${DEPLOYED_TABLE}" ] || [ "${DEPLOYED_TABLE}" = "None" ]; then
  echo "[verify] FAIL: could not read deployed table name from CloudFormation"
  exit 1
fi

echo "[verify] step 4b: read the deployed sibling Lambda ARN (for the GetAtt fallback assertion)"
# SIBLING_ARN is a Fn::GetAtt .Arn env var that ListStackResources cannot
# resolve; the deployed-env fallback recovers it from the echo function's
# own deployed Environment.Variables. The sibling's physical id is its
# function NAME, so resolve the full ARN via lambda:GetFunction.
SIBLING_NAME=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function' && contains(LogicalResourceId, 'SiblingHandler')].PhysicalResourceId | [0]" \
  --output text)
if [ -z "${SIBLING_NAME}" ] || [ "${SIBLING_NAME}" = "None" ]; then
  echo "[verify] FAIL: could not read deployed sibling function name from CloudFormation"
  exit 1
fi
DEPLOYED_SIBLING_ARN=$(aws lambda get-function \
  --function-name "${SIBLING_NAME}" \
  --region "${REGION}" \
  --query 'Configuration.FunctionArn' \
  --output text)
echo "[verify]   deployed sibling ARN: ${DEPLOYED_SIBLING_ARN}"
if [ -z "${DEPLOYED_SIBLING_ARN}" ] || [ "${DEPLOYED_SIBLING_ARN}" = "None" ]; then
  echo "[verify] FAIL: could not read deployed sibling ARN from Lambda"
  exit 1
fi

# Local invoke is flaky on cold dockers: the rie-client's TCP probe can
# succeed before RIE has fully wired up its HTTP listener, producing a
# `TypeError: fetch failed`. Retry up to 3 times so a hot-cache run (the
# common case) is fast and a cold-cache run is still reliable.
invoke_with_retry() {
  local args=("$@")
  local attempts=3
  local i=1
  local err
  err="$(mktemp)"
  while [ $i -le $attempts ]; do
    if out=$(${CLI} invoke "${args[@]}" 2>"${err}" | tail -1) && \
       echo "${out}" | grep -q '"tableName":'; then
      rm -f "${err}"
      printf '%s' "${out}"
      return 0
    fi
    if [ $i -lt $attempts ]; then
      echo "[verify]   invoke attempt ${i} failed (last stdout line: ${out}); stderr tail:" >&2
      tail -5 "${err}" >&2
      echo "[verify]   retrying..." >&2
      sleep 2
    fi
    i=$((i+1))
  done
  echo "[verify]   all ${attempts} invoke attempts failed (last stdout line: ${out}); last attempt's stderr below:" >&2
  tail -20 "${err}" >&2
  rm -f "${err}"
  return 1
}

echo "[verify] step 5: cdkl invoke (no --from-cfn-stack) — expect TABLE_NAME=unset"
RESULT_BASELINE=$(invoke_with_retry "${STACK}/EchoTableHandler" --no-pull)
echo "[verify]   response: ${RESULT_BASELINE}"
echo "${RESULT_BASELINE}" | grep -q '"tableName":"unset"' || {
  echo "[verify] FAIL: expected TABLE_NAME to be dropped (default warn-and-drop), got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"siblingArn":"unset"' || {
  echo "[verify] FAIL: expected SIBLING_ARN to be dropped (GetAtt warn-and-drop), got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"dbHost":"unset"' || {
  echo "[verify] FAIL: expected DB_HOST to be dropped (SSM-param Ref warn-and-drop without --from-cfn-stack), got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"apiKey":"unset"' || {
  echo "[verify] FAIL: expected API_KEY to be dropped (SecureString SSM-param Ref warn-and-drop without --from-cfn-stack), got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: expected STATIC_VALUE=always-the-same in baseline response, got: ${RESULT_BASELINE}"
  exit 1
}
# issue #784: a LITERAL dynamic reference resolves without a state flag; the
# same-stack secret reference is a Fn::Join over a Ref, so it is dropped here.
echo "${RESULT_BASELINE}" | grep -q "\"dynrefSsm\":\"${SSM_PARAM_VALUE}\"" || {
  echo "[verify] FAIL: expected DYNREF_SSM={{resolve:ssm:...}} resolved to ${SSM_PARAM_VALUE} without a state flag (issue #784), got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"dynrefSecret":"unset"' || {
  echo "[verify] FAIL: expected DYNREF_SECRET (Fn::Join over a Ref) dropped without a state flag, got: ${RESULT_BASELINE}"
  exit 1
}

echo "[verify] step 6: cdkl invoke --from-cfn-stack — expect TABLE_NAME=${DEPLOYED_TABLE}"
# Bare --from-cfn-stack uses the host stack name verbatim as the CFn
# stack name — which matches here because the CDK app exports the same
# name to both.
RESULT_FROM_CFN=$(invoke_with_retry "${STACK}/EchoTableHandler" --from-cfn-stack --no-pull)
echo "[verify]   response: ${RESULT_FROM_CFN}"
echo "${RESULT_FROM_CFN}" | grep -q "\"tableName\":\"${DEPLOYED_TABLE}\"" || {
  echo "[verify] FAIL: expected TABLE_NAME=${DEPLOYED_TABLE}, got: ${RESULT_FROM_CFN}"
  exit 1
}
echo "${RESULT_FROM_CFN}" | grep -q "\"siblingArn\":\"${DEPLOYED_SIBLING_ARN}\"" || {
  echo "[verify] FAIL: expected SIBLING_ARN=${DEPLOYED_SIBLING_ARN} (deployed-env GetAtt fallback), got: ${RESULT_FROM_CFN}"
  exit 1
}
echo "${RESULT_FROM_CFN}" | grep -q "\"dbHost\":\"${SSM_PARAM_VALUE}\"" || {
  echo "[verify] FAIL: expected DB_HOST=${SSM_PARAM_VALUE} (AWS::SSM::Parameter::Value resolved from SSM, issue #94), got: ${RESULT_FROM_CFN}"
  exit 1
}
echo "${RESULT_FROM_CFN}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: STATIC_VALUE regressed under --from-cfn-stack, got: ${RESULT_FROM_CFN}"
  exit 1
}
# issue #99: the decrypted SecureString value must reach the container (its
# fresh post-swap value, NOT the deploy-time placeholder).
echo "${RESULT_FROM_CFN}" | grep -q "\"apiKey\":\"${SSM_API_KEY_VALUE}\"" || {
  echo "[verify] FAIL: expected API_KEY=${SSM_API_KEY_VALUE} (decrypted SecureString resolved from SSM), got: ${RESULT_FROM_CFN}"
  exit 1
}
# issue #772: the same SecureString under the docker-client name DOCKER_CONFIG
# is dropped, so the container never sees it.
echo "${RESULT_FROM_CFN}" | grep -q '"dockerConfig":"unset"' || {
  echo "[verify] FAIL: expected DOCKER_CONFIG to be dropped (docker-client name, issue #772), got: ${RESULT_FROM_CFN}"
  exit 1
}
# issue #784: same-stack secretsmanager references (json-key, and json-key +
# version-stage) and a literal ssm reference reach the container RESOLVED.
for field in dynrefSecret dynrefSecretStage; do
  echo "${RESULT_FROM_CFN}" | grep -q "\"${field}\":\"${DYNREF_SECRET_PASSWORD}\"" || {
    echo "[verify] FAIL: expected ${field} resolved to the secret's password (issue #784), got: ${RESULT_FROM_CFN}"
    exit 1
  }
done
echo "${RESULT_FROM_CFN}" | grep -q "\"dynrefSsm\":\"${SSM_PARAM_VALUE}\"" || {
  echo "[verify] FAIL: expected DYNREF_SSM resolved to ${SSM_PARAM_VALUE} under --from-cfn-stack (issue #784), got: ${RESULT_FROM_CFN}"
  exit 1
}
if echo "${RESULT_FROM_CFN}" | grep -q '{{resolve:'; then
  echo "[verify] FAIL: a {{resolve:...}} token reached the container (issue #784): ${RESULT_FROM_CFN}"
  exit 1
fi

echo "[verify] step 6b: assert the decrypted SecureString is kept OFF the docker argv (issue #99)"
# Re-invoke with --verbose so the docker-runner logs the full `docker run`
# command at debug. The SecureString-backed key must appear as a value-less
# `-e API_KEY` (value supplied via the spawned process env), and its
# decrypted value must NOT appear on the docker command line (the inline
# `-e API_KEY=<value>` form is what issue #99 fixes). DB_HOST (a plain
# String SSM param) stays inline as `-e DB_HOST=<value>` — the control.
DEBUG_OUT=$(${CLI} invoke "${STACK}/EchoTableHandler" --from-cfn-stack --no-pull --verbose 2>&1 || true)
# Isolate the `docker run` command line (it carries the `-e` flags). The
# Lambda's JSON response (which DOES echo apiKey) is a different line, so
# grepping the docker-run line avoids a false positive on the value.
DOCKER_RUN_LINE=$(echo "${DEBUG_OUT}" | grep -E '(^| )run .* -e ' | grep -- '-e API_KEY' | head -1)
if [ -z "${DOCKER_RUN_LINE}" ]; then
  echo "[verify] FAIL: could not find the 'docker run' debug line carrying -e API_KEY in --verbose output"
  echo "${DEBUG_OUT}" | tail -20
  exit 1
fi
echo "${DOCKER_RUN_LINE}" | grep -qE -- '-e API_KEY( |$)' || {
  echo "[verify] FAIL: API_KEY not in the value-less '-e API_KEY' form on the docker argv: ${DOCKER_RUN_LINE}"
  exit 1
}
if echo "${DOCKER_RUN_LINE}" | grep -q "API_KEY=${SSM_API_KEY_VALUE}"; then
  echo "[verify] FAIL: decrypted SecureString value LEAKED onto the docker run argv (issue #99 regression): ${DOCKER_RUN_LINE}"
  exit 1
fi
if echo "${DOCKER_RUN_LINE}" | grep -q "${SSM_API_KEY_VALUE}"; then
  echo "[verify] FAIL: SecureString value present anywhere on the docker run argv (issue #99 regression): ${DOCKER_RUN_LINE}"
  exit 1
fi
# Control: a plain String SSM param keeps the inline form (not over-routed).
echo "${DOCKER_RUN_LINE}" | grep -q "DB_HOST=${SSM_PARAM_VALUE}" || {
  echo "[verify] FAIL: expected the plain String DB_HOST to stay inline as -e DB_HOST=<value> (control), got: ${DOCKER_RUN_LINE}"
  exit 1
}
echo "[verify]   SecureString API_KEY routed off the argv; String DB_HOST stayed inline (control)."

echo "[verify] step 6c: assert a SecureString named DOCKER_CONFIG is refused by name (issue #772)"
if echo "${DOCKER_RUN_LINE}" | grep -q -- '-e DOCKER_CONFIG'; then
  echo "[verify] FAIL: DOCKER_CONFIG must get no -e flag at all (issue #772): ${DOCKER_RUN_LINE}"
  exit 1
fi
REFUSAL_LINE=$(echo "${DEBUG_OUT}" | grep 'share a name with a variable the container client reads' | head -1)
echo "${REFUSAL_LINE}" | grep -q 'DOCKER_CONFIG' || {
  echo "[verify] FAIL: expected a warning naming DOCKER_CONFIG as a refused docker-client name (issue #772)"
  echo "${DEBUG_OUT}" | tail -20
  exit 1
}
if echo "${REFUSAL_LINE}" | grep -q "${SSM_API_KEY_VALUE}"; then
  echo "[verify] FAIL: the refusal warning carries the SecureString VALUE (issue #772): ${REFUSAL_LINE}"
  exit 1
fi
if echo "${REFUSAL_LINE}" | grep -q 'API_KEY'; then
  echo "[verify] FAIL: the refusal warning names the ordinary API_KEY too (issue #772): ${REFUSAL_LINE}"
  exit 1
fi
echo "[verify]   DOCKER_CONFIG refused by name; its value is on neither the argv nor the warning."

echo "[verify] step 6d: a resolved dynamic reference is kept OFF the docker argv and out of every log line (issue #784)"
echo "${DOCKER_RUN_LINE}" | grep -qE -- '-e DYNREF_SECRET( |$)' || {
  echo "[verify] FAIL: DYNREF_SECRET not in the value-less '-e DYNREF_SECRET' form on the docker argv: ${DOCKER_RUN_LINE}"
  exit 1
}
if echo "${DOCKER_RUN_LINE}" | grep -qE "${DYNREF_SECRET_PASSWORD}|\{\{resolve:"; then
  echo "[verify] FAIL: a resolved secret or a {{resolve:...}} token is on the docker run argv: ${DOCKER_RUN_LINE}"
  exit 1
fi
# Every --verbose line EXCEPT the handler's own JSON response (which echoes
# the env by design) must be free of the plaintext.
if echo "${DEBUG_OUT}" | grep -v '"dynrefSecret"' | grep -q "${DYNREF_SECRET_PASSWORD}"; then
  echo "[verify] FAIL: the resolved secret appears in cdkl's own --verbose output (issue #784):"
  echo "${DEBUG_OUT}" | grep -v '"dynrefSecret"' | grep "${DYNREF_SECRET_PASSWORD}" | head -5
  exit 1
fi
echo "${DEBUG_OUT}" | grep -q 'Resolved secretsmanager dynamic reference' || {
  echo "[verify] FAIL: expected the debug line recording the secretsmanager resolution (positive control for the negative above)"
  exit 1
}
echo "[verify]   DYNREF_SECRET routed off the argv; the plaintext is in no log line."

echo "[verify] step 6e: a reference to a missing parameter FAILS the invoke, never hands over the token (issue #784)"
for flags in "" "--from-cfn-stack"; do
  set +e
  # shellcheck disable=SC2086
  GONE_OUT=$(${CLI} invoke "${STACK}/DynrefMissingHandler" ${flags} --no-pull 2>&1)
  GONE_RC=$?
  set -e
  if [ "${GONE_RC}" -eq 0 ]; then
    echo "[verify] FAIL: invoke with a missing referenced parameter succeeded (flags='${flags}'): ${GONE_OUT}"
    exit 1
  fi
  for needle in "{{resolve:ssm:${SSM_GONE_PARAM}}}" 'ssm:GetParameter' 'does not exist'; do
    echo "${GONE_OUT}" | grep -qF "${needle}" || {
      echo "[verify] FAIL: the failure (flags='${flags}') does not name '${needle}':"
      echo "${GONE_OUT}" | tail -10
      exit 1
    }
  done
done
echo "[verify]   the missing-parameter reference failed loudly, naming the reference and the permission."

echo "[verify] step 7: cdk destroy --force"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata
# issue #784: purge the secret if the stack delete left it in a recovery window.
aws secretsmanager delete-secret --secret-id "${SECRET_ARN}" \
  --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true

echo ""
echo "[verify] All checks passed:"
echo "[verify]   - existing behavior intact: TABLE_NAME (Ref) substituted, STATIC_VALUE (literal) passed through, baseline drops the intrinsics."
echo "[verify]   - GetAtt fallback: SIBLING_ARN (Fn::GetAtt .Arn) recovered from the deployed function's resolved env."
echo "[verify]   - issue #94: DB_HOST (Ref to AWS::SSM::Parameter::Value<String>) resolved from SSM under --from-cfn-stack, dropped without it."
echo "[verify]   - issue #99: API_KEY (SecureString SSM param) decrypted + injected under --from-cfn-stack, and kept OFF the docker run argv (value-less -e API_KEY); String DB_HOST stayed inline as the control."
echo "[verify]   - issue #772: the same SecureString under the docker-client name DOCKER_CONFIG was dropped with a by-name warning."
echo "[verify]   - issue #784: {{resolve:secretsmanager:...}} (json-key, version-stage) and {{resolve:ssm:...}} resolved locally, off the argv, out of the logs; a missing parameter failed loudly."
