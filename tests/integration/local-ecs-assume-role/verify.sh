#!/usr/bin/env bash
#
# End-to-end real-AWS validation for task-role credentials on the ECS
# commands: `cdkl run-task --assume-role <arn>` (issue #853) and
# `cdkl start-service --assume-role <arn>` (issue #854), plus the host-wide
# 169.254.170.0/24 rules that follow from them (issues #850 / #854).
#
# The fixture deploys ONE CloudFormation stack holding an IAM role the
# deploying account may assume. A second, never-deployed stack holds a
# bridge-mode task definition (an AWS CLI container that sleeps) and a
# one-replica service over it. Each phase `docker exec`s
# `aws sts get-caller-identity` inside the running container -- a real SDK
# reading `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` from 169.254.170.2 -- and
# asserts it runs as `assumed-role/<RoleName>/...`.
#
# Phases:
#   1. run-task --assume-role <arn> --detach: the container runs as the role.
#   2. While (1) holds 169.254.170.0/24:
#      a. run-task WITHOUT a role still starts, on another /24, and its
#         container gets no task-role credentials (issue #850);
#      b. a second run-task WITH a role fails, naming (1)'s network.
#   3. start-service --assume-role <arn>: the replica runs as the role, and
#      the shared network is on 169.254.170.0/24 (issue #854).
#   4. While (3) runs, run-task --assume-role fails, naming (3)'s network.
#   5. SIGTERM (3): its network and sidecar are gone.
#
# 169.254.170.0/24 is HOST-global: a peer lane holding it (any run-task, or
# a start-service / start-alb with --assume-role) fails this fixture at the
# pre-flight below, by design.
#
# Run via `/run-integ local-ecs-assume-role`. Requires Docker + AWS
# credentials with deploy permissions, plus the upstream `cdk` CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
# Lane-unique stack names (issue #582).
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
STACK="$(integ_stack_name CdkLocalEcsAssumeRoleFixture)"
TASKS_STACK="$(integ_stack_name CdkLocalEcsAssumeRoleTasks)"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
CLI_IMAGE="public.ecr.aws/aws-cli/aws-cli:2.31.0"
TASK_ROLE_CIDR="169.254.170.0/24"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-ecs-assume-role"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} stack=${STACK} tasks=${TASKS_STACK}"

cd "${TEST_DIR}"

WE_CREATED_STACK=0
SVC_PID=""
# Docker networks THIS run created; cleanup removes only these (and the
# containers attached to them), never a peer lane's.
OWN_NETWORKS=()
SCRATCH="$(mktemp -d)"

remove_network_and_containers() { # remove_network_and_containers <network>
  local net="$1"
  docker ps -aq --filter "network=${net}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "${net}" >/dev/null 2>&1 || true
}

cleanup() {
  rc=$?
  if [ -n "${SVC_PID}" ] && kill -0 "${SVC_PID}" 2>/dev/null; then
    kill -TERM "${SVC_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      kill -0 "${SVC_PID}" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "${SVC_PID}" 2>/dev/null || true
  fi
  for net in "${OWN_NETWORKS[@]+"${OWN_NETWORKS[@]}"}"; do
    remove_network_and_containers "${net}"
  done
  rm -rf "${SCRATCH}"
  if [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] teardown: cdk destroy ${STACK}"
    cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata || true
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  exit 1
}

# The docker network a cdkl run created, read from its own log line.
network_from_log() { # network_from_log <log file>
  sed -n 's/^Created docker network \([^ ]*\) (subnet .*/\1/p' "$1" | head -1
}

subnet_of() { # subnet_of <network>
  docker network inspect "$1" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
}

# The one user container on a network (the sidecar is `<network>-metadata`).
user_container_on() { # user_container_on <network>
  docker ps --filter "network=$1" --format '{{.Names}}' | grep -v -- '-metadata$' | head -1
}

# Run `aws sts get-caller-identity` inside a container; prints the ARN, or
# the CLI's error text, and never fails the script itself.
caller_arn_in() { # caller_arn_in <container>
  docker exec "$1" aws sts get-caller-identity --query Arn --output text 2>&1 || true
}

# Start a detached run-task; records its network on success. Prints the
# log path. The exit status is the CLI's.
run_task_detached() { # run_task_detached <log> <extra args...>
  local log="$1"
  shift
  local rc=0
  ${CLI} run-task "${TASKS_STACK}/IdentityTask" --detach --no-pull "$@" >"${log}" 2>&1 || rc=$?
  local net
  net="$(network_from_log "${log}")"
  if [ -n "${net}" ]; then OWN_NETWORKS+=("${net}"); fi
  return "${rc}"
}

echo "[verify] step 1: pre-flight"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull "${SIDECAR_IMAGE}" >/dev/null
docker pull "${CLI_IMAGE}" >/dev/null
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi
for net in $(docker network ls --format '{{.Name}}'); do
  if [ "$(subnet_of "${net}")" = "${TASK_ROLE_CIDR}" ]; then
    fail "docker network ${net} already holds ${TASK_ROLE_CIDR} (another run-task, or a task-role start-service / start-alb). This fixture needs that subnet; wait for that run to finish."
  fi
done
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  fail "${STACK} already exists in CloudFormation; clean up first via: aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
fi

echo "[verify] step 2: cdk deploy ${STACK} (the task role only)"
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"

ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query 'Stacks[0].Outputs[?OutputKey==`TaskRoleArn`].OutputValue | [0]' \
  --output text)
if [ -z "${ROLE_ARN}" ] || [ "${ROLE_ARN}" = "None" ]; then
  fail "could not read the TaskRoleArn output of ${STACK}"
fi
ACCOUNT=$(aws sts get-caller-identity --query 'Account' --output text)
ROLE_NAME="${ROLE_ARN##*/}"
ASSUMED_PREFIX="arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE_NAME}/"
echo "[verify]   role: ${ROLE_ARN}"

# IAM trust propagation is eventually consistent.
PROPAGATED=0
for _ in $(seq 1 15); do
  if aws sts assume-role --role-arn "${ROLE_ARN}" --role-session-name cdkl-integ-probe \
       --duration-seconds 900 >/dev/null 2>&1; then
    PROPAGATED=1
    break
  fi
  sleep 2
done
[ "${PROPAGATED}" -eq 1 ] || fail "sts:AssumeRole into ${ROLE_ARN} did not succeed within 30s"

echo "[verify] step 3: run-task --assume-role <arn> (issue #853)"
RT_LOG="${SCRATCH}/run-task-role.log"
run_task_detached "${RT_LOG}" --assume-role "${ROLE_ARN}" \
  || { cat "${RT_LOG}" >&2; fail "run-task --assume-role exited non-zero"; }
RT_NET="$(network_from_log "${RT_LOG}")"
[ -n "${RT_NET}" ] || { cat "${RT_LOG}" >&2; fail "run-task log names no created network"; }
[ "$(subnet_of "${RT_NET}")" = "${TASK_ROLE_CIDR}" ] \
  || fail "run-task with a task role is on $(subnet_of "${RT_NET}"), not ${TASK_ROLE_CIDR}"
RT_CONTAINER="$(user_container_on "${RT_NET}")"
[ -n "${RT_CONTAINER}" ] || fail "no user container on ${RT_NET}"
RT_URI="$(docker exec "${RT_CONTAINER}" printenv AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || true)"
[ "${RT_URI}" = "/creds" ] || fail "run-task container has AWS_CONTAINER_CREDENTIALS_RELATIVE_URI='${RT_URI}', want /creds"
RT_ARN="$(caller_arn_in "${RT_CONTAINER}")"
echo "[verify]   in-container identity: ${RT_ARN}"
[[ "${RT_ARN}" == "${ASSUMED_PREFIX}"* ]] \
  || fail "run-task container did not run as the task role (want ${ASSUMED_PREFIX}*, got: ${RT_ARN})"
echo "[verify]   ok: run-task container runs as the task role"

echo "[verify] step 4a: run-task WITHOUT a role beside it moves to another /24 (issue #850)"
NR_LOG="${SCRATCH}/run-task-norole.log"
run_task_detached "${NR_LOG}" \
  || { cat "${NR_LOG}" >&2; fail "run-task without a role failed while a task-role run held ${TASK_ROLE_CIDR}"; }
NR_NET="$(network_from_log "${NR_LOG}")"
[ -n "${NR_NET}" ] || { cat "${NR_LOG}" >&2; fail "no-role run-task log names no created network"; }
NR_SUBNET="$(subnet_of "${NR_NET}")"
[ "${NR_SUBNET}" != "${TASK_ROLE_CIDR}" ] || fail "no-role run-task also got ${TASK_ROLE_CIDR}"
NR_CONTAINER="$(user_container_on "${NR_NET}")"
[ -n "${NR_CONTAINER}" ] || fail "no user container on ${NR_NET}"
NR_URI="$(docker exec "${NR_CONTAINER}" printenv AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || true)"
[ -z "${NR_URI}" ] || fail "no-role run-task container got AWS_CONTAINER_CREDENTIALS_RELATIVE_URI='${NR_URI}'"
NR_META="$(docker exec "${NR_CONTAINER}" printenv ECS_CONTAINER_METADATA_URI_V4 || true)"
[[ "${NR_META}" == "http://${NR_SUBNET%.0/24}.2/"* ]] \
  || fail "no-role run-task metadata URI '${NR_META}' does not follow its sidecar on ${NR_SUBNET}"
NR_ARN="$(caller_arn_in "${NR_CONTAINER}")"
if [[ "${NR_ARN}" == *":assumed-role/"* ]]; then
  fail "no-role run-task container unexpectedly has an assumed-role identity: ${NR_ARN}"
fi
echo "[verify]   ok: no-role run-task on ${NR_SUBNET}, metadata follows it, no task-role credentials"

echo "[verify] step 4b: a second run-task WITH a role fails and names the holder"
CF_LOG="${SCRATCH}/run-task-conflict.log"
if run_task_detached "${CF_LOG}" --assume-role "${ROLE_ARN}"; then
  fail "a second task-role run-task started while ${RT_NET} held ${TASK_ROLE_CIDR}"
fi
grep -qF "docker network ${RT_NET} already holds ${TASK_ROLE_CIDR}" "${CF_LOG}" \
  || { cat "${CF_LOG}" >&2; fail "the conflict error does not name ${RT_NET}"; }
echo "[verify]   ok: refused, naming ${RT_NET}"

echo "[verify] tearing down the run-task networks"
remove_network_and_containers "${RT_NET}"
remove_network_and_containers "${NR_NET}"

echo "[verify] step 5: start-service --assume-role <arn> (issue #854)"
SVC_LOG="${SCRATCH}/start-service.log"
${CLI} start-service "${TASKS_STACK}/IdentityService" --assume-role "${ROLE_ARN}" --no-pull \
  >"${SVC_LOG}" 2>&1 &
SVC_PID=$!
READY=0
for _ in $(seq 1 120); do
  if grep -qF 'Press ^C to shut down' "${SVC_LOG}"; then READY=1; break; fi
  kill -0 "${SVC_PID}" 2>/dev/null || break
  sleep 1
done
SVC_NET="$(network_from_log "${SVC_LOG}")"
if [ -n "${SVC_NET}" ]; then OWN_NETWORKS+=("${SVC_NET}"); fi
if [ "${READY}" -ne 1 ]; then
  cat "${SVC_LOG}" >&2
  if kill -0 "${SVC_PID}" 2>/dev/null; then fail "start-service was not ready within 120s"; fi
  fail "start-service exited before it was ready"
fi
[ -n "${SVC_NET}" ] || fail "start-service log names no created network"
[ "$(subnet_of "${SVC_NET}")" = "${TASK_ROLE_CIDR}" ] \
  || fail "start-service with a task role is on $(subnet_of "${SVC_NET}"), not ${TASK_ROLE_CIDR}"
SVC_CONTAINER="$(user_container_on "${SVC_NET}")"
[ -n "${SVC_CONTAINER}" ] || fail "no replica container on ${SVC_NET}"
SVC_ARN="$(caller_arn_in "${SVC_CONTAINER}")"
echo "[verify]   in-replica identity: ${SVC_ARN}"
[[ "${SVC_ARN}" == "${ASSUMED_PREFIX}"* ]] \
  || fail "start-service replica did not run as the task role (want ${ASSUMED_PREFIX}*, got: ${SVC_ARN})"
echo "[verify]   ok: start-service replica runs as the task role"

echo "[verify] step 6: run-task --assume-role beside the service fails and names it"
CF2_LOG="${SCRATCH}/run-task-conflict-svc.log"
if run_task_detached "${CF2_LOG}" --assume-role "${ROLE_ARN}"; then
  fail "a task-role run-task started while ${SVC_NET} held ${TASK_ROLE_CIDR}"
fi
grep -qF "docker network ${SVC_NET} already holds ${TASK_ROLE_CIDR}" "${CF2_LOG}" \
  || { cat "${CF2_LOG}" >&2; fail "the conflict error does not name ${SVC_NET}"; }
echo "[verify]   ok: refused, naming ${SVC_NET}"

echo "[verify] step 7: SIGTERM start-service; its network and sidecar are removed"
kill -TERM "${SVC_PID}"
for _ in $(seq 1 60); do
  kill -0 "${SVC_PID}" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "${SVC_PID}" 2>/dev/null; then fail "start-service did not exit within 30s of SIGTERM"; fi
SVC_PID=""
if docker network inspect "${SVC_NET}" >/dev/null 2>&1; then
  fail "start-service left its network ${SVC_NET} behind"
fi
if docker ps -a --format '{{.Names}}' | grep -qxF "${SVC_NET}-metadata"; then
  fail "start-service left its sidecar ${SVC_NET}-metadata behind"
fi
echo "[verify]   ok: clean teardown"

echo "[verify] step 8: cdk destroy ${STACK}"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata
WE_CREATED_STACK=0

echo ""
echo "[verify] All local-ecs-assume-role checks passed (run-task + start-service task-role credentials, 169.254.170.0/24 conflicts)"
