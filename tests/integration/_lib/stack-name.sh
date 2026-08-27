#!/usr/bin/env bash
#
# Lane-unique naming for integration fixtures that create real AWS
# resources (issue #582).
#
# `.claude/CLAUDE.md` mandates parallel work in git worktrees under
# `.claude/worktrees/<branch>/`, and markgate markers are per-worktree so
# lanes verify concurrently. Every AWS-deploying fixture used to hard-code
# ONE CloudFormation stack name, so two lanes deployed, read and destroyed
# THE SAME stack in THE SAME account. All three failure modes were silent:
# the pre-flight orphan scan mistook a peer's live stack for a leftover,
# the cleanup trap could `cdk destroy` a peer's stack, and a colliding run
# could report GREEN having asserted against a peer's resources.
#
# The fix is a per-worktree suffix appended to every account-global name a
# fixture owns. It is derived from the worktree ROOT PATH rather than the
# branch name: a branch name may contain `/` and other characters that are
# not legal in a CloudFormation stack name, while the root path is stable
# for the life of the worktree and unique across worktrees of the same
# repo.
#
# Usage from a fixture's `verify.sh` (before the first name is built):
#
#     source "$(dirname "${BASH_SOURCE[0]}")/../_lib/stack-name.sh"
#     STACK="$(integ_stack_name CdkLocalInvokeAssumeRoleFixture)"
#
# The suffix is EXPORTED as `INTEG_STACK_SUFFIX` so the fixture's CDK
# app (`bin/app.ts`) builds the same names: the app appends it to the stack
# construct id, so `cdk deploy "${STACK}"`, `cdkl ... "${STACK}/Handler"`
# and the deployed stack name all agree. An app run WITHOUT the variable
# set (a bare `cdk synth` by hand) keeps the historical un-suffixed name.
#
# The variable name deliberately does NOT start with `CDK`. The aws-cdk CLI
# is yargs-based with `.env('CDK')`, so it maps EVERY environment variable
# whose name begins with `CDK` onto a CLI option: an earlier spelling,
# `CDKL_INTEG_STACK_SUFFIX`, made every `cdk deploy` / `cdk destroy` in
# every fixture print `Unknown option(s): --lIntegStackSuffix. These will be
# ignored.` Verified directly -- `CDKL_PROVE_IT=1 cdk doctor` prints
# `Unknown option(s): --lProveIt`. Here it was only noise, because no real
# option has that name; a variable whose camelCased tail COLLIDES with a
# real cdk option would instead change deploy behaviour silently. Keep the
# `CDK` prefix off any variable a fixture exports into a `cdk` invocation.
#
# Pre-setting `INTEG_STACK_SUFFIX` in the environment overrides the
# derivation — useful for CI, where every job has its own account or its
# own checkout path, and for this library's own test.

# Absolute directory of THIS file (BASH_SOURCE[0] inside a function is the
# file the function was DEFINED in, not the caller), resolved once.
_integ_lib_dir() {
  ( cd "$(dirname "${BASH_SOURCE[0]}")" && pwd )
}

# The lane's identity: the git worktree root containing this library.
# Falls back to the repo root two levels above `tests/integration/_lib`
# when git is unavailable, which keeps the derivation total.
_integ_lane_root() {
  local lib_dir root
  lib_dir="$(_integ_lib_dir)"
  if root="$(git -C "${lib_dir}" rev-parse --show-toplevel 2>/dev/null)" && [ -n "${root}" ]; then
    printf '%s' "${root}"
    return 0
  fi
  ( cd "${lib_dir}/../../.." && pwd )
}

# 8 lowercase hex characters of the SHA-256 of the lane root. Short on
# purpose: it is appended to names that have their own length ceilings
# (a CloudFormation stack name is capped at 128 characters).
_integ_lane_hash() {
  local input="$1" digest=""
  if command -v shasum >/dev/null 2>&1; then
    digest="$(printf '%s' "${input}" | shasum -a 256 | cut -d' ' -f1)"
  elif command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "${input}" | sha256sum | cut -d' ' -f1)"
  elif command -v cksum >/dev/null 2>&1; then
    # Last resort: not a cryptographic hash, but it only has to separate a
    # handful of worktree paths on one machine.
    digest="$(printf '%s' "${input}" | cksum | awk '{printf "%08x", $1}')"
  else
    echo "[integ-lib] FATAL: no shasum / sha256sum / cksum on PATH to derive a lane suffix" >&2
    return 1
  fi
  printf '%s' "${digest}" | cut -c1-8
}

if [ -z "${INTEG_STACK_SUFFIX:-}" ]; then
  INTEG_STACK_SUFFIX="$(_integ_lane_hash "$(_integ_lane_root)")"
fi
export INTEG_STACK_SUFFIX

# integ_stack_name <base>
#
# Appends the lane suffix to a fixture's base stack name. The result stays
# within CloudFormation's `[A-Za-z][A-Za-z0-9-]*`, max 128 characters: the
# base already satisfies it and the suffix adds 9 hyphen-plus-hex
# characters, none of which is the leading character.
integ_stack_name() {
  printf '%s-%s' "$1" "${INTEG_STACK_SUFFIX}"
}

# integ_scoped_name <base>
#
# The same suffixing for a non-stack name that is also account-global and
# therefore also collides between lanes: an SSM parameter path, a
# CloudFormation export name. Kept separate from `integ_stack_name` so the
# call site says which kind of name it is building.
integ_scoped_name() {
  printf '%s-%s' "$1" "${INTEG_STACK_SUFFIX}"
}
