#!/usr/bin/env bash
# verify.sh — cdkl list target-enumeration integ test (pure synth, no Docker).
#
# `cdkl list` reads the synthesized cloud assembly and prints every runnable
# target grouped by the command that consumes it. The interactive
# target-picker (`cdkl invoke` / `start-api` / etc. without a target in a TTY)
# shares the same target-lister underneath — so a regression in list semantics
# would silently break the picker too. Lock in the surface here.
#
# Asserts against a single fixture stack rich enough to emit every group:
#   - Lambda Functions   ->  cdkl invoke <target>            (MyHandler)
#   - APIs               ->  cdkl start-api [target...]      (MyHttpApi HTTP API v2 + MyHandler Function URL)
#   - ECS Services       ->  cdkl start-service <target...>  (MyService)
#   - ECS Task Definitions -> cdkl run-task <target>         (MyTask)
#   - AgentCore Runtimes ->  cdkl invoke-agentcore <target>  (MyAgent)
#   - Application Load Balancers -> cdkl start-alb <target...> (MyAlb)
#   - CloudFront Distributions -> cdkl start-cloudfront <target> (MyDistribution)
#
# Also locks down:
#   - `cdkl ls` (alias) produces the same output as `cdkl list`.
#   - `cdkl list --help` exits 0 and surfaces the documented description.
#
# No Docker required — pure synth-time read.
#
#   bash tests/integration/local-list/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKL="node ../../../dist/cli.js"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

OUT_FILE=$(mktemp)
ALIAS_OUT_FILE=$(mktemp)
HELP_FILE=$(mktemp)
cleanup() { rm -f "${OUT_FILE}" "${ALIAS_OUT_FILE}" "${HELP_FILE}"; }
trap cleanup EXIT

echo "==> cdkl list against the fixture (capturing stdout)"
${CDKL} list > "${OUT_FILE}" 2>/dev/null

echo "==> Asserting every expected group header is emitted"
for header in \
  'Lambda Functions  ->  cdkl invoke <target>' \
  'APIs  ->  cdkl start-api [target...]' \
  'ECS Services  ->  cdkl start-service <target...>' \
  'ECS Task Definitions  ->  cdkl run-task <target>' \
  'AgentCore Runtimes  ->  cdkl invoke-agentcore <target>' \
  'Application Load Balancers  ->  cdkl start-alb <target...>' \
  'CloudFront Distributions  ->  cdkl start-cloudfront <target>'
do
  if ! grep -qF "${header}" "${OUT_FILE}"; then
    echo "FAIL: missing group header: ${header}"
    echo "----- list output -----"; cat "${OUT_FILE}"; echo "-----------------------"
    exit 1
  fi
  echo "    OK: ${header}"
done

echo "==> Asserting every expected target appears under its group"
# CDK display path (no /Resource suffix) is what `cdkl list` prints when the
# resource carries `aws:cdk:path` metadata — which every L1/L2 in this fixture
# does. The Function URL line carries the `(Function URL)` kind suffix and is
# keyed by the BACKING LAMBDA's logical ID, mirroring the start-api dispatcher.
for line in \
  '  LocalListFixture/MyHandler' \
  '  LocalListFixture/MyHttpApi  (HTTP API v2)' \
  '  LocalListFixture/MyHandler  (Function URL)' \
  '  LocalListFixture/MyService' \
  '  LocalListFixture/MyTask' \
  '  LocalListFixture/MyAgent' \
  '  LocalListFixture/MyAlb' \
  '  LocalListFixture/MyDistribution'
do
  if ! grep -qF "${line}" "${OUT_FILE}"; then
    echo "FAIL: missing target line: '${line}'"
    echo "----- list output -----"; cat "${OUT_FILE}"; echo "-----------------------"
    exit 1
  fi
  echo "    OK: ${line}"
done

echo "==> cdkl ls (alias) — asserting identical stdout"
${CDKL} ls > "${ALIAS_OUT_FILE}" 2>/dev/null
if ! diff -u "${OUT_FILE}" "${ALIAS_OUT_FILE}"; then
  echo "FAIL: cdkl ls produced different output from cdkl list"
  exit 1
fi
echo "    OK: alias produces identical output"

echo "==> cdkl list -l (--long) — asserting stack-qualified IDs are emitted"
LONG_OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}" "${ALIAS_OUT_FILE}" "${HELP_FILE}" "${LONG_OUT_FILE}"' EXIT
${CDKL} list -l > "${LONG_OUT_FILE}" 2>/dev/null
# In long mode each entry with a display path gets a second indented line
# containing the stack-qualified logical ID. Assert one such line per
# distinct resource group (CDK auto-suffixes logical IDs, so anchor on the
# `LocalListFixture:My...` prefix rather than the full ID).
for qid_prefix in \
  '      LocalListFixture:MyHandler' \
  '      LocalListFixture:MyHttpApi' \
  '      LocalListFixture:MyService' \
  '      LocalListFixture:MyTask' \
  '      LocalListFixture:MyAgent' \
  '      LocalListFixture:MyAlb'
do
  if ! grep -q "^${qid_prefix}" "${LONG_OUT_FILE}"; then
    echo "FAIL: --long mode missing qualified-ID line for prefix: '${qid_prefix}'"
    echo "----- list -l output -----"; cat "${LONG_OUT_FILE}"; echo "--------------------------"
    exit 1
  fi
  echo "    OK: --long emitted ${qid_prefix}*"
done

echo "==> cdkl list --help — asserting help surface is intact"
${CDKL} list --help > "${HELP_FILE}"
if ! grep -q "List the runnable targets" "${HELP_FILE}"; then
  echo "FAIL: --help output missing canonical description"
  cat "${HELP_FILE}"
  exit 1
fi
if ! grep -q -- "-l, --long" "${HELP_FILE}"; then
  echo "FAIL: --help output missing -l/--long option"
  cat "${HELP_FILE}"
  exit 1
fi
echo "    OK: --help surface intact"

echo ""
echo "==> local-list test passed (every target group + alias + --long + --help)"
