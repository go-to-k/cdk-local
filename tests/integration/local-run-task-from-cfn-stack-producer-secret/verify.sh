#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkl run-task --from-cfn-stack` keeps
# a PRODUCER stack's exported secret off the `docker run` argv
# (go-to-k/cdkd#6339).
#
# The producer exports an AppSync API key, a plain value, and a nested
# stack's Secrets Manager ARN (re-exported the CDK way, through
# `Fn::GetAtt <Nested>.Outputs.<Path>DbSecret<hash>Ref`). The consumer reads
# them through `Fn::ImportValue`.
#
# Steps:
#   1. install + build cdk-local, install fixture deps, pull images
#   2. pre-flight: refuse when either stack already exists
#   3. cdk deploy producer + consumer
#   4. read the API key from ListExports (held in a variable, never printed)
#   5. RefusedTask (the key inside a Command element): run-task refuses it
#      before docker runs anything, naming the producer secret, quoting no key
#   6. ProbeTask, through a CDK_DOCKER shim that records each `docker run`
#      argv: the plain export is an argv element; the key is `-e API_KEY`
#      with no value and appears nowhere on the argv, yet the container got
#      it; the nested secret ARN resolved as a Secrets ValueFrom
#   7. cdk destroy (consumer first), then gone-probes for both stacks
#
# Run via `/run-integ local-run-task-from-cfn-stack-producer-secret`.
# Requires Docker, the global `cdk` CLI and AWS credentials that can deploy
# AppSync, Secrets Manager, ECS task definitions and nested stacks.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
PRODUCER_STACK="$(integ_stack_name CdkLocalRunTaskProducerSecretProducer)"
CONSUMER_STACK="$(integ_stack_name CdkLocalRunTaskProducerSecretConsumer)"
API_KEY_EXPORT="$(integ_scoped_name cdkl-producer-secret-api-key)"
PLAIN_VALUE="plain-export-value-v1"
DB_SECRET_VALUE="integ-db-secret-value-v1"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-run-task-from-cfn-stack-producer-secret"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} producer=${PRODUCER_STACK} consumer=${CONSUMER_STACK}"

OUT_FILE=""
ARGV_LOG=""
WE_CREATED_STACKS=0
destroy_stacks() {
  # Consumer FIRST: its Fn::ImportValue must release the exports before the
  # producer can be deleted.
  (cd "${TEST_DIR}" && cdk destroy "${CONSUMER_STACK}" "${PRODUCER_STACK}" --force \
    --region "${REGION}" --no-version-reporting --no-asset-metadata --no-path-metadata)
}
cleanup() {
  rc=$?
  docker ps -a --filter "name=cdkl-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
  if [ "${WE_CREATED_STACKS}" -eq 1 ]; then
    echo "[verify] cleanup: cdk destroy (exit ${rc})"
    destroy_stacks || true
  fi
  # The argv log may hold a value if the check regressed: delete, never print.
  rm -f "${OUT_FILE}" "${ARGV_LOG}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $1" >&2
  if [ -n "${OUT_FILE}" ] && [ -f "${OUT_FILE}" ]; then
    echo "----- run-task output -----" >&2
    # The key is masked in the dump, so a regression's evidence is safe to print.
    if [ -n "${API_KEY_VALUE:-}" ]; then
      sed "s/${API_KEY_VALUE}/<api-key>/g" "${OUT_FILE}" >&2
    else
      cat "${OUT_FILE}" >&2
    fi
    echo "---------------------------" >&2
  fi
  exit 1
}

sha256_of() { # sha256_of <text>: the hex digest, on either GNU or BSD tools
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -c1-64
  else
    printf '%s' "$1" | shasum -a 256 | cut -c1-64
  fi
}

echo "[verify] step 1a: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
echo "[verify] step 1b: fixture deps + images"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi
docker version --format '{{.Server.Version}}' >/dev/null
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

echo "[verify] step 2: pre-flight — refuse to deploy over an existing stack"
for stack in "${PRODUCER_STACK}" "${CONSUMER_STACK}"; do
  if aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] FAIL: ${stack} already exists — clean up first:"
    echo "          aws cloudformation delete-stack --stack-name ${stack} --region ${REGION}"
    exit 1
  fi
done

echo "[verify] step 3: cdk deploy producer + consumer"
# Set before the deploy: pre-flight proved the names free, so a partial
# deploy is ours to destroy.
WE_CREATED_STACKS=1
cdk deploy "${PRODUCER_STACK}" "${CONSUMER_STACK}" \
  --require-approval never --no-version-reporting --no-asset-metadata --no-path-metadata \
  --region "${REGION}"

echo "[verify] step 4: read the API key from ListExports (not printed)"
API_KEY_VALUE=$(aws cloudformation list-exports --region "${REGION}" \
  --query "Exports[?Name==\`${API_KEY_EXPORT}\`].Value | [0]" --output text)
if [ -z "${API_KEY_VALUE}" ] || [ "${API_KEY_VALUE}" = "None" ]; then
  fail "could not read export ${API_KEY_EXPORT}"
fi
echo "[verify]   API key read (${#API_KEY_VALUE} characters)"

OUT_FILE=$(mktemp)
ARGV_LOG=$(mktemp)
export CDKL_ARGV_LOG="${ARGV_LOG}"

echo "[verify] step 5: RefusedTask — the key in a Command element is refused"
rc=0
CDK_DOCKER="${TEST_DIR}/docker-argv-log.sh" ${CLI} run-task "${CONSUMER_STACK}/RefusedTask" \
  --from-cfn-stack --no-pull --container-host 127.0.0.1 >"${OUT_FILE}" 2>&1 || rc=$?
[ "${rc}" -ne 0 ] || fail "run-task RefusedTask exited 0; the Command element must be refused"
grep -q 'resolved a cross-stack value holding a secret of the producer stack' "${OUT_FILE}" \
  || fail "the refusal does not name the producer secret"
grep -qF -- "${API_KEY_VALUE}" "${OUT_FILE}" && fail "run-task output quotes the API key"
grep -qF -- "${API_KEY_VALUE}" "${ARGV_LOG}" && fail "a docker run argv carries the API key"
echo "[verify]   ok: refused, no key on the output or any argv"

echo "[verify] step 6: ProbeTask — plain on argv, key value-less, secret ARN resolved"
: >"${ARGV_LOG}"
rc=0
CDK_DOCKER="${TEST_DIR}/docker-argv-log.sh" ${CLI} run-task "${CONSUMER_STACK}/ProbeTask" \
  --from-cfn-stack --no-pull --container-host 127.0.0.1 >"${OUT_FILE}" 2>&1 || rc=$?
[ "${rc}" -eq 0 ] || fail "run-task ProbeTask exited ${rc}"
grep -q 'Secret DB_SECRET dropped' "${OUT_FILE}" && fail "the nested secret ARN ValueFrom was dropped"
grep -q "\[probe\] arg=${PLAIN_VALUE}\$" "${OUT_FILE}" \
  || fail "the container did not get the plain export as its argument"
grep -q "\[probe\] key_sha=$(sha256_of "${API_KEY_VALUE}")" "${OUT_FILE}" \
  || fail "the container did not get the API key in API_KEY"
grep -q "\[probe\] secret_sha=$(sha256_of "${DB_SECRET_VALUE}")" "${OUT_FILE}" \
  || fail "the container did not get the secret through the Secrets ValueFrom"
grep -qx -- "${PLAIN_VALUE}" "${ARGV_LOG}" || fail "the plain export is not a docker run argv element"
grep -qx -- 'API_KEY' "${ARGV_LOG}" || fail "API_KEY is not passed value-less (-e API_KEY)"
grep -q '^API_KEY=' "${ARGV_LOG}" && fail "API_KEY is passed inline on the argv"
grep -qF -- "${API_KEY_VALUE}" "${ARGV_LOG}" && fail "a docker run argv carries the API key"
grep -qF -- "${DB_SECRET_VALUE}" "${ARGV_LOG}" && fail "a docker run argv carries the secret value"
grep -qF -- "${API_KEY_VALUE}" "${OUT_FILE}" && fail "run-task output quotes the API key"
echo "[verify]   ok"

echo "[verify] step 7: cdk destroy (consumer first) + gone-probes"
destroy_stacks
WE_CREATED_STACKS=0
for stack in "${CONSUMER_STACK}" "${PRODUCER_STACK}"; do
  # Gone means CloudFormation SAYS so: any other failure (credentials, a
  # throttle) proves nothing.
  probe_rc=0
  probe_out=$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" 2>&1) \
    || probe_rc=$?
  if [ "${probe_rc}" -eq 0 ]; then
    fail "${stack} still exists after cdk destroy"
  fi
  printf '%s' "${probe_out}" | grep -q 'does not exist' \
    || fail "could not confirm ${stack} is gone: ${probe_out}"
done

echo ""
echo "[verify] All checks passed: the producer's API key stayed off the docker run argv."
