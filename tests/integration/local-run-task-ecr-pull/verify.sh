#!/usr/bin/env bash
#
# Real-AWS validation for `cdkl run-task` pulling a PRIVATE ECR image through
# each registry host form AWS serves (issue #760).
#
# Before the fix cdk-local recognized only the plain `<acct>.dkr.ecr.<region>.
# amazonaws.com` host: a FIPS or dual-stack host was classified as a PUBLIC
# image and pulled anonymously (`no basic auth credentials`), and even once
# classified, `docker login` targeted the plain host `GetAuthorizationToken`
# reports while the pull targeted another -- docker keys its credential store on
# the hostname verbatim, so the pull still sent no credentials.
#
# Steps:
#   1. install + build cdk-local + fixture deps; pull the public images
#   2. pre-flight orphan scan, then cdk deploy (upstream CDK CLI) -- the ECR
#      repository alone (the task definitions are local-synth-only)
#   3. push a tiny nginx image to the repository through the plain host
#   4. for each host form -- plain, FIPS (only where AWS serves it), dual-stack:
#      `cdkl run-task --from-cfn-stack` WITHOUT --no-pull, so cdk-local itself
#      runs `docker login` + `docker pull`, against a FRESH docker config; assert
#      the login stored its token for the PULL host, and the task serves HTTP 200
#   5. cdk destroy --force (emptyOnDelete empties the repository)
#
# Every docker call runs against a scratch DOCKER_CONFIG. Each arm's config
# holds no credentials but the ones cdk-local's own login writes, which is what
# makes the arm discriminate: with the operator's real config a stored entry for
# the pull host would authenticate the pull regardless. The seed is NOT `{}`:
# for a config with no auths at all docker falls back to a detected platform
# store (the macOS keychain), which would put the token outside this run. One
# placeholder entry under an unresolvable `.invalid` name keeps it in the file,
# which cleanup deletes.
#
# Run via `/run-integ local-run-task-ecr-pull`. Requires Docker, AWS credentials
# with deploy + ECR push/pull permissions, and the global `cdk` CLI on $PATH.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
STACK="$(integ_stack_name CdkLocalRunTaskEcrPullFixture)"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-run-task-ecr-pull"
CLI="node ${REPO_ROOT}/dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
NGINX_IMAGE="public.ecr.aws/nginx/nginx:alpine"

# Pin the daemon endpoint BEFORE switching configs: a docker context lives in
# the config directory, so a scratch DOCKER_CONFIG would otherwise lose a
# non-default context and talk to a socket that may not exist.
if [ -z "${DOCKER_HOST:-}" ]; then
  DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
  export DOCKER_HOST
fi

WE_CREATED_STACK=0
REPO_NAME=""
ACCOUNT_ID=""
PULLED_REFS=""
OUT_FILE="$(mktemp)"
BASE_DOCKER_CONFIG="$(mktemp -d)"
ARM_DOCKER_CONFIG=""
seed_docker_config() { # seed_docker_config <dir>
  printf '{"auths":{"cdkl-verify.invalid":{}}}\n' >"$1/config.json"
}
seed_docker_config "${BASE_DOCKER_CONFIG}"
export DOCKER_CONFIG="${BASE_DOCKER_CONFIG}"

teardown_task() {
  docker ps -a --filter "name=cdkl-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkl-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
}

cleanup() {
  rc=$?
  set +e
  teardown_task
  # Only the registry tags this run created; the nginx image itself is shared.
  for ref in ${PULLED_REFS}; do docker image rm "${ref}" >/dev/null 2>&1; done
  rm -rf "${BASE_DOCKER_CONFIG}" "${ARM_DOCKER_CONFIG}"
  rm -f "${OUT_FILE}"
  if [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] teardown: cdk destroy ${STACK}"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "----- cdkl output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

echo "[verify] region=${REGION} stack=${STACK}"

echo "[verify] step 1: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
echo "[verify] step 1b: install fixture deps + pull the public images"
[ -d node_modules ] || vp install --prefer-offline
docker pull "${SIDECAR_IMAGE}"
docker pull "${NGINX_IMAGE}"

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation -- clean up first:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 2b: cdk deploy (upstream CDK CLI) -- the repository only"
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"

REPO_NAME="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='RepoName'].OutputValue" --output text)"
[ -n "${REPO_NAME}" ] && [ "${REPO_NAME}" != "None" ] || fail "could not resolve the deployed repository name"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
# The region's partition suffix (the rows of `PARTITION_TABLE` in
# src/local/intrinsic-image.ts), and whether it serves dual-stack under on.aws.
DUAL_STACK=1
case "${REGION}" in
  cn-*) SUFFIX="amazonaws.com.cn"; DUAL_STACK=0 ;;
  us-gov-*) SUFFIX="amazonaws.com" ;;
  us-isob-*) SUFFIX="sc2s.sgov.gov"; DUAL_STACK=0 ;;
  us-isof-*) SUFFIX="csp.hci.ic.gov"; DUAL_STACK=0 ;;
  us-iso-*) SUFFIX="c2s.ic.gov"; DUAL_STACK=0 ;;
  eu-isoe-*) SUFFIX="cloud.adc-e.uk"; DUAL_STACK=0 ;;
  eusc-*) SUFFIX="amazonaws.eu"; DUAL_STACK=0 ;;
  *) SUFFIX="amazonaws.com" ;;
esac
PLAIN_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.${SUFFIX}"
echo "[verify]   repo=${REPO_NAME} account=${ACCOUNT_ID}"

echo "[verify] step 3: push ${NGINX_IMAGE} to ${PLAIN_HOST}/${REPO_NAME}:latest"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${PLAIN_HOST}" >/dev/null
PULLED_REFS="${PULLED_REFS} ${PLAIN_HOST}/${REPO_NAME}:latest"
docker tag "${NGINX_IMAGE}" "${PLAIN_HOST}/${REPO_NAME}:latest"
docker push "${PLAIN_HOST}/${REPO_NAME}:latest"
docker logout "${PLAIN_HOST}" >/dev/null

# run_pull_arm <task id> <host port> <pull host> <label>
run_pull_arm() {
  local task_id="$1" host_port="$2" pull_host="$3" label="$4"
  local ref="${pull_host}/${REPO_NAME}:latest"

  rm -rf "${ARM_DOCKER_CONFIG}"
  ARM_DOCKER_CONFIG="$(mktemp -d)"
  seed_docker_config "${ARM_DOCKER_CONFIG}"
  # The pull must reach the registry, not a tag an earlier step left locally.
  docker image rm "${ref}" >/dev/null 2>&1 || true
  PULLED_REFS="${PULLED_REFS} ${ref}"

  echo "[verify] step 4 (${label}): cdkl run-task ${STACK}/${task_id} pulls ${ref}"
  local rc=0
  DOCKER_CONFIG="${ARM_DOCKER_CONFIG}" ${CLI} run-task "${STACK}/${task_id}" \
    -c withTasks=true --from-cfn-stack --region "${REGION}" \
    --detach --container-host 127.0.0.1 >"${OUT_FILE}" 2>&1 || rc=$?
  cat "${OUT_FILE}"
  [ "${rc}" -eq 0 ] || fail "${label}: run-task exited ${rc} pulling through ${pull_host}"
  grep -qF "Pulling ${ref}" "${OUT_FILE}" \
    || fail "${label}: cdk-local did not run its own ECR pull of ${ref} (classified as public?)"

  # The login must have targeted the PULL host and stored its token in THIS
  # arm's file: an exact key (with or without `https://`), a non-empty `auth`,
  # no `credsStore` diverting it -- and, for a non-plain arm, nothing stored for
  # the PLAIN host, which would mean the login went there instead.
  node -e '
    const [file, pullHost, plainHost] = process.argv.slice(1);
    const j = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    const auths = j.auths || {};
    const entry = (h) => auths[h] || auths["https://" + h];
    const problems = [];
    if ("credsStore" in j) problems.push("credsStore=" + j.credsStore);
    if (!(entry(pullHost) && entry(pullHost).auth)) problems.push("no stored token for " + pullHost);
    if (pullHost !== plainHost && entry(plainHost)) problems.push("an entry for the PLAIN host " + plainHost);
    if (problems.length) {
      console.log(problems.join("; ") + " -- keys: " + JSON.stringify(Object.keys(auths)));
      process.exit(1);
    }
  ' "${ARM_DOCKER_CONFIG}/config.json" "${pull_host}" "${PLAIN_HOST}" \
    || fail "${label}: the docker login did not store its token for ${pull_host} in the arm's config"

  sleep 5
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${host_port}/" || true)"
  echo "[verify]   HTTP ${code}"
  [ "${code}" = "200" ] || fail "${label}: expected HTTP 200 from the pulled image, got ${code}"

  teardown_task
  rm -rf "${ARM_DOCKER_CONFIG}"
  ARM_DOCKER_CONFIG=""
  echo "[verify]   ${label}: OK"
}

run_pull_arm PlainTask 18760 "${PLAIN_HOST}" "plain"
# `on.aws` is the dual-stack DNS of the commercial and GovCloud partitions.
if [ "${DUAL_STACK}" -eq 1 ]; then
  run_pull_arm DualStackTask 18762 "${ACCOUNT_ID}.dkr-ecr.${REGION}.on.aws" "dual-stack"
else
  echo "[verify] step 4 (dual-stack): SKIPPED -- ${REGION} does not serve dual-stack under on.aws"
fi
# AWS serves the FIPS registry endpoint in these six regions only.
case "${REGION}" in
  us-east-1 | us-east-2 | us-west-1 | us-west-2 | us-gov-east-1 | us-gov-west-1)
    run_pull_arm FipsTask 18761 "${ACCOUNT_ID}.dkr.ecr-fips.${REGION}.amazonaws.com" "FIPS"
    ;;
  *)
    echo "[verify] step 4 (FIPS): SKIPPED -- ${REGION} has no FIPS ECR endpoint"
    ;;
esac

echo "[verify] PASS: run-task authenticated and pulled the private ECR image through the plain, dual-stack and (where served) FIPS registry hosts, each login stored against the host it pulled from."
