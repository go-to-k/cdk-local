#!/usr/bin/env bash
#
# A `CDK_DOCKER` shim for this fixture's verify.sh: appends the argv of each
# `docker run` to "${CDKL_ARGV_LOG}" (one element per line, then a `----`
# separator) and runs the real docker with the same arguments. verify.sh
# greps that file to prove what reached the command line. The file is a temp
# file verify.sh deletes; it is never printed.
set -euo pipefail
if [ "${1:-}" = "run" ] && [ -n "${CDKL_ARGV_LOG:-}" ]; then
  printf '%s\n' "$@" >>"${CDKL_ARGV_LOG}"
  printf -- '----\n' >>"${CDKL_ARGV_LOG}"
fi
exec docker "$@"
