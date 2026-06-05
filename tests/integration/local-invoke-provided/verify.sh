#!/usr/bin/env bash
# verify.sh — local-invoke provided.* + go1.x integ test (issue #248, final sub-PR)
#
# Unlike most integ tests this one is fully local: no AWS resources are
# deployed. The test exercises `cdkl invoke` end-to-end against
# Docker + the AWS Lambda `provided.al2023` base image (which bundles
# the Runtime Interface Emulator), AND validates two rejection paths:
# (a) inline `Code.ZipFile` on `provided.*` and (b) the deprecated
# `go1.x` runtime.
#
# Run via `/run-integ local-invoke-provided` (recommended) or directly:
#
#     bash tests/integration/local-invoke-provided/verify.sh
#
# Requires Docker. The host does NOT need a Go toolchain — main.go is
# compiled inside `golang:1.21-alpine` (~360MB, one-time pull). The
# Lambda provided.al2023 base image (~50MB — much smaller than the
# language-specific images, since it's the OS-only runtime) is pulled
# separately.

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"
LAMBDA_IMAGE="public.ecr.aws/lambda/provided:al2023"
GO_IMAGE="golang:1.21-alpine"

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling Go toolchain image for compilation (~360MB, one-time)"
docker pull "${GO_IMAGE}"

echo "==> Pulling ${LAMBDA_IMAGE} (~50MB, one-time)"
docker pull "${LAMBDA_IMAGE}"

echo "==> Cross-compiling bootstrap binary (linux/amd64) via Docker Go toolchain"
rm -rf lambda/build
mkdir -p lambda/build
# `go mod tidy` resolves aws-lambda-go from the public proxy on first
# run (needs network). go.sum is gitignored — regenerated each invocation.
docker run --rm \
  -v "$(pwd)/lambda:/work" \
  -w /work \
  -e GOOS=linux \
  -e GOARCH=amd64 \
  -e CGO_ENABLED=0 \
  "${GO_IMAGE}" \
  sh -c "go mod tidy && go build -trimpath -ldflags='-s -w' -o build/bootstrap main.go"
test -f lambda/build/bootstrap || {
  echo "FAIL: go build did not produce lambda/build/bootstrap"
  exit 1
}
test -x lambda/build/bootstrap || {
  echo "FAIL: lambda/build/bootstrap is not executable"
  exit 1
}

# Build a ZIP-FILE asset for BootstrapZipHandler with `bootstrap` as a SYMLINK
# to the real binary — exactly how Swift and many other `provided.*` runtimes
# ship it (`bootstrap -> MyHandler`). `zip -y` stores the symlink AS a symlink
# (unix mode S_IFLNK). cdkl must (a) recreate the symlink instead of writing the
# link-target path as a text file, and (b) preserve the real binary's exec bit,
# or RIE fork/exec's a non-executable and fails with `exec format error`. Built
# here (gitignored). The staging dir keeps the directory-asset BootstrapHandler
# (Test 1/2) using a plain `bootstrap`.
echo "==> Building lambda/bootstrap.zip (symlinked bootstrap ZIP-FILE asset)"
rm -f lambda/bootstrap.zip
ZIPSTAGE="lambda/.ziptmp"
rm -rf "${ZIPSTAGE}"
mkdir -p "${ZIPSTAGE}"
cp lambda/build/bootstrap "${ZIPSTAGE}/SwiftMathAlgorithm"
( cd "${ZIPSTAGE}" && ln -sf SwiftMathAlgorithm bootstrap && zip -q -y -X ../bootstrap.zip bootstrap SwiftMathAlgorithm )
rm -rf "${ZIPSTAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi


# Test 1 — asset-backed provided.al2023 with the compiled bootstrap.
# On Apple Silicon hosts, `Architecture: x86_64` triggers Docker's
# linux/amd64 emulation. The first invocation pays a one-time emulator
# warm-up tax (~5s); the function's 30s timeout absorbs it comfortably.
echo "==> [1/5] Invoking BootstrapHandler with default empty event"
RESULT_1=$(${CDKL} invoke CdkLocalInvokeProvidedFixture/BootstrapHandler --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -Eq '"Greeting": *"hello"|"greeting": *"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — asset-backed bootstrap with --event payload round-trip
echo "==> [2/5] Invoking BootstrapHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(${CDKL} invoke CdkLocalInvokeProvidedFixture/BootstrapHandler --event "${EVENT_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -Eq '"key": *"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — ZIP-FILE asset provided.al2023 bootstrap (regression: the extracted
# bootstrap must keep its executable bit, else RIE -> Runtime.InvalidEntrypoint).
echo "==> [3/5] Invoking BootstrapZipHandler (Code.fromAsset of a .zip with an executable bootstrap)"
ZIP_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ZIP_EVENT}"' EXIT
echo '{"from":"zip"}' > "${ZIP_EVENT}"
RESULT_ZIP=$(${CDKL} invoke CdkLocalInvokeProvidedFixture/BootstrapZipHandler --event "${ZIP_EVENT}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_ZIP}"
echo "${RESULT_ZIP}" | grep -Eq '"Greeting": *"hello-from-zip"|"greeting": *"hello-from-zip"' || {
  echo "FAIL: expected greeting=hello-from-zip from the extracted zip bootstrap, got: ${RESULT_ZIP}"
  exit 1
}
echo "${RESULT_ZIP}" | grep -Eq '"from": *"zip"' || {
  echo "FAIL: expected echoed from=zip, got: ${RESULT_ZIP}"
  exit 1
}
echo "    zip bootstrap executed ✓"

# Test 4 — inline Code.ZipFile rejection for provided.al2023.
echo "==> [4/5] Invoking ProvidedAl2023InlineHandler — expecting inline Code.ZipFile rejection"
RESULT_3=""
if RESULT_3=$(${CDKL} invoke CdkLocalInvokeProvidedFixture/ProvidedAl2023InlineHandler --no-pull 2>&1); then
  echo "FAIL: expected non-zero exit on inline provided.al2023, got success: ${RESULT_3}"
  exit 1
fi
echo "${RESULT_3}" | grep -q "Inline 'Code.ZipFile' is not supported" || {
  echo "FAIL: expected 'Inline Code.ZipFile is not supported' message, got:"
  echo "${RESULT_3}"
  exit 1
}
echo "${RESULT_3}" | grep -q "Code.fromAsset" || {
  echo "FAIL: expected 'Code.fromAsset' routing in message, got:"
  echo "${RESULT_3}"
  exit 1
}
echo "    rejection ✓"

# Test 5 — go1.x deprecation rejection.
echo "==> [5/5] Invoking Go1xHandler — expecting go1.x deprecation message"
RESULT_4=""
if RESULT_4=$(${CDKL} invoke CdkLocalInvokeProvidedFixture/Go1xHandler --no-pull 2>&1); then
  echo "FAIL: expected non-zero exit on go1.x, got success: ${RESULT_4}"
  exit 1
fi
echo "${RESULT_4}" | grep -q "go1.x" || {
  echo "FAIL: expected message naming go1.x, got:"
  echo "${RESULT_4}"
  exit 1
}
echo "${RESULT_4}" | grep -q "PROVIDED_AL2023" || {
  echo "FAIL: expected migration pointer to PROVIDED_AL2023, got:"
  echo "${RESULT_4}"
  exit 1
}
echo "    deprecation ✓"

echo ""
echo "==> All 5 local-invoke provided.* + go1.x tests passed"
