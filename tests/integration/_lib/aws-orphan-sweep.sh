#!/usr/bin/env bash
#
# AWS orphan sweep for the integration fixtures that own real AWS
# resources (issue go-to-k/cdk-local#601).
#
# WHY THIS IS A SCRIPT AND NOT A RECIPE
#
# This sweep used to live as copy-pasteable prose in
# `.claude/skills/run-integ/SKILL.md`. In one PR that prose carried FOUR
# instances of one defect class, each found by a different reviewer and
# each introduced by the fix for the previous one:
#
#   1. It scanned a BARE fixture stack name, which can never match after
#      the lane-unique rename (issue #582) -- so the sweep the repo calls
#      mandatory reported clean unconditionally.
#   2. Scoped to a bare `/cdkl` prefix, it listed EVERY lane's parameters,
#      handing an agent a peer's LIVE resources to delete.
#   3. Scoped to the lane suffix with no guard, it degraded to
#      `contains(Name,'-')` -- every hyphenated parameter in the ACCOUNT,
#      `/prod/db-password` included -- whenever the relative `source`
#      failed.
#   4. The two stack scans had no guard at all: from the wrong cwd the
#      helper was undefined, the name empty, the error swallowed by
#      `2>/dev/null`, and the `||` branch printed "AWS clean" -- a false
#      clean on the PRIMARY resource.
#
# Every one is a FAILURE PATH of a snippet nobody executes as a unit. As a
# script those paths are executable, so `aws-orphan-sweep.test.sh` drives
# them with a stubbed `aws` and asserts the verdict instead of grepping a
# markdown file for the shape of a command.
#
# THIS SCRIPT DETECTS AND EXPLAINS. IT NEVER DELETES.
#
# Deleting requires a judgment no script can make: a name carrying THIS
# lane's suffix can also belong to a second run of the same fixture in the
# SAME worktree -- a live peer, not a leftover -- and cross-stack delete
# ORDER (consumer before producer, so an export is released before its
# exporter goes) is not derivable from the fixture. So the script prints a
# remediation PLAN, and a human runs it. That plan is generated output, so
# `aws-orphan-sweep.test.sh` pins its shape by running the script -- which
# is the point of issue #601 applied to the second half. Five of the
# eleven historical instances arrived through a FIX rather than through a
# scan, and the last one was in the REMEDIATION.
#
# USAGE
#
#   aws-orphan-sweep.sh <fixture-name>   sweep one fixture, print a verdict
#   aws-orphan-sweep.sh --list-owners    list the AWS-resource-owning fixtures
#   aws-orphan-sweep.sh --help
#
# It is safe to call for ANY fixture: a fixture that owns no real AWS
# resource makes no AWS call at all and exits 0. So `/run-integ` invokes it
# unconditionally rather than asking an agent to first decide whether the
# fixture is AWS-owning -- a decision that has silently excluded a
# resource-owning fixture twice.
#
# EXIT CODES -- the caller gates on these, it does not read the output.
#
#   0  clean            every derived name was queried and none exists
#   1  usage / internal  bad argument, unknown fixture, unresolvable lane
#                        suffix, underivable resource name. NOT a clean
#                        verdict: nothing was concluded.
#   2  orphan           at least one resource attributable to this lane
#                        exists
#   3  indeterminate    at least one query could not be performed (no
#                        credentials, `aws` missing, an unrecognized error).
#                        NOT a clean verdict: the sweep did not look.
#   4  report-only      nothing attributable found, but an UNATTRIBUTABLE
#                        resource matched -- see the froms3 bucket below.
#
# Precedence when several fire: 3 > 2 > 4 > 0. "I could not look" outranks
# "I found something", because a partial look cannot bound what it missed.
#
# THE DECISIONS CARRIED OVER FROM THE PROSE, each with its reason:
#
#   * `describe-stacks --stack-name`, never `--stack-status-filter`. A
#     status filter hid 16 of 23 statuses, `DELETE_IN_PROGRESS` -- an
#     interrupted `cdk destroy`, this sweep's own scenario -- among them.
#     `describe-stacks --stack-name` surfaces a stack in EVERY status but
#     `DELETE_COMPLETE`.
#   * exit 0 from `describe-stacks` is the ORPHAN case, not the passing
#     one. `describe-stacks` succeeds when the stack is there.
#   * no `2>/dev/null` on any query. It sends the clean case and the
#     could-not-look case into the same silence, which was instance 1's
#     mechanism. Here stderr is CAPTURED and classified instead.
#   * the lane suffix is resolved ONCE, from a `BASH_SOURCE`-derived path,
#     and an empty one aborts. The prose needed three guards that could
#     drift apart precisely because each paste re-resolved it.
#   * SSM / export filters use `contains`, not `ends_with`:
#     `local-invoke-from-cfn-stack-large-stack` creates ~105 parameters
#     shaped `/cdkl-ls-<suffix>/p000`, where the suffix is a PREFIX segment
#     rather than the tail. A peer's suffix cannot satisfy this lane's
#     filter -- both are exactly 8 hex characters, so `-<ours>` inside
#     `-<theirs>` requires equality.
#   * BOTH conditions on those filters: the `cdkl` anchor bounds the blast
#     radius to this repo's resources even if the suffix logic changes, and
#     the suffix bounds it to this lane.
#   * `aws cloudformation delete-stack` in the printed plan, NEVER `cdk
#     destroy`. `cdk destroy` needs `--app` context this cwd does not
#     provide, and -- worse -- it exits 0 SILENTLY on a name the app never
#     synthesized, which is what a fresh shell with no `INTEG_STACK_SUFFIX`
#     produces. That is this recipe's own defect class arriving through the
#     remediation.
#
# WHERE IT DELIBERATELY DIFFERS FROM THE PROSE, and why that is allowed:
#
#   The prose refused to emit a verdict at all -- "a command that claims
#   nothing cannot claim something false" -- after every attempt to emit
#   one produced a false one. That was the right call FOR PROSE, whose
#   error branches are never executed. A script may claim, because its
#   claims are testable: `aws-orphan-sweep.test.sh` drives the wrong cwd,
#   the credential failure, the empty suffix, each query failing in turn,
#   and asserts that none of them reaches exit 0. The refusal is preserved
#   as a THIRD outcome rather than dropped: anything the script cannot
#   classify is `indeterminate` (exit 3), which is not clean.
#
#   In particular the prose banned matching stderr for `does not exist`,
#   because a broken `source_profile` produces that phrase too. This script
#   requires BOTH the `(ValidationError)` API error code AND `does not
#   exist`; a credential-config failure carries no error code, so it lands
#   in `indeterminate`. If AWS ever reworded the message the match would
#   fail CLOSED, into `indeterminate` -- never into clean. That direction
#   is the whole reason the tighter match is acceptable, and it has its own
#   case in the test.
#
# Bash 3.2 clean (macOS `/bin/bash`): no `mapfile`, no `declare -A`.

set -euo pipefail

EX_OK=0
EX_USAGE=1
EX_ORPHAN=2
EX_INDETERMINATE=3
EX_REPORT=4

# Absolute directory of THIS file. Derived from `BASH_SOURCE`, never from
# the caller's cwd: that removes the entire class of "run it from the wrong
# directory" failures that produced instances 3 and 4 above.
SWEEP_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INTEG_DIR=$(cd "${SWEEP_LIB_DIR}/.." && pwd)

# A fixture owns a real AWS resource iff it deploys a stack or creates a
# bucket out of band. ONE predicate, no hand-maintained exception list:
# carrying the bucket case as a prose footnote is the shape that let a
# `*-from-cfn-stack` glob miss three fixtures and a widened `*-from-cfn*`
# still miss `local-invoke-assume-role`.
#
# EVERY predicate and derivation below reads `fixture_code`, never the raw
# file: a COMMENTED command is not a command. `/create-integ`'s scaffold
# ships a commented-out `# cdk deploy "${STACK}" ...` block, so matching raw
# text classified every freshly scaffolded Docker-only fixture as
# AWS-owning, found no stack name in it, and died rc=1 -- which, against a
# `/run-integ` that runs this unconditionally and stops on any non-zero,
# blocked `/create-integ`'s own verification step for every new fixture.
# The `stack-name.test.sh` block this script replaced already had the
# discipline (`code=$(grep -vE '^[[:space:]]*#' ...)`); it was lost in the
# move, which is why it now has cases of its own.
OWNER_RE='(^|[^[:alnum:]_])(cdk[^;&|]*[[:space:]]deploy|aws[[:space:]]+s3api[[:space:]]+create-bucket)([[:space:]]|$)'
BUCKET_OWNER_RE='aws[[:space:]]+s3api[[:space:]]+create-bucket'

# Match the fixtures' own region resolution exactly (`REGION="${AWS_REGION:-us-east-1}"`).
# Agreement with the fixture is the property that matters: a sweep that
# resolves a different region than the deploy looks in the wrong account
# corner and reports clean.
REGION="${AWS_REGION:-us-east-1}"

# The uncommented body of a shell file. Whole-line comments only: a
# trailing comment sits on a line that really does run.
fixture_code() { # fixture_code <path>
  grep -vE '^[[:space:]]*#' "$1" 2>/dev/null || true
}

# The uncommented body of the CDK app's TypeScript. Same reason: a
# commented-out `// new Stack(app, integStackName('Old'))` would add a name
# the fixture does not own. That direction is safer than the shell one (an
# extra name is queried and comes back absent) but it can still manufacture
# a false ORPHAN against a same-named stack, and the call-site count below
# would disagree with itself.
app_code() { # app_code <fixture dir>
  cat "$1"/bin/*.ts "$1"/lib/*.ts 2>/dev/null | grep -vE '^[[:space:]]*(//|\*|/\*)' || true
}

app_bin_code() { # app_bin_code <fixture dir>
  cat "$1"/bin/*.ts 2>/dev/null | grep -vE '^[[:space:]]*(//|\*|/\*)' || true
}

say() { printf '[sweep] %s\n' "$*"; }
err() { printf '[sweep] %s\n' "$*" >&2; }

die() { # die <message>
  err "FATAL: $*"
  err "This is NOT a clean verdict: nothing was concluded."
  exit "${EX_USAGE}"
}

usage() {
  cat <<'USAGE_EOF'
Usage:
  aws-orphan-sweep.sh <fixture-name>   sweep one fixture, print a verdict
  aws-orphan-sweep.sh --list-owners    list the AWS-resource-owning fixtures
  aws-orphan-sweep.sh --help

Exit codes: 0 clean, 1 usage/internal, 2 orphan, 3 indeterminate,
4 report-only (an unattributable resource matched).
USAGE_EOF
}

# ---------------------------------------------------------------- derivation

list_owners() {
  local out
  # rc-checked: `grep -l` with no match exits 1 with EMPTY stdout and no
  # message, which reads as "no fixture owns AWS resources" and would skip
  # every sweep in the repo at once -- a wider blast radius than any single
  # false clean.
  # Per-file, because the predicate runs over the COMMENT-STRIPPED body and
  # `grep -l` has no per-file filter. The rc check survives the rewrite: an
  # empty result still means "no fixture owns AWS resources", which would
  # skip every sweep in the repo at once.
  out=""
  for f in "${INTEG_DIR}"/*/verify.sh; do
    [ -f "${f}" ] || continue
    if fixture_code "${f}" | grep -qE "${OWNER_RE}"; then
      out="${out}$(printf '%s' "${f}" | sed "s#^${INTEG_DIR}/##; s#/verify\.sh\$##")"$'\n'
    fi
  done
  if [ -n "${out}" ]; then
    printf '%s' "${out}" | grep -v '^$' | sort
    return 0
  fi
  return 1
}

fixture_owns_aws() { # fixture_owns_aws <verify.sh path>
  fixture_code "$1" | grep -qE "${OWNER_RE}"
}

fixture_creates_bucket() { # fixture_creates_bucket <verify.sh path>
  fixture_code "$1" | grep -qE "${BUCKET_OWNER_RE}"
}

# Stack BASE names, from BOTH copies of the truth: the shell that deploys
# them and the CDK app that synthesizes them. The union is deliberate --
# "derive every name it owns so a caller cannot forget one" fails if the
# derivation reads only the half a given fixture happens to write in.
derive_stack_bases() { # derive_stack_bases <fixture dir>
  {
    fixture_code "$1/verify.sh" \
      | grep -ohE "integ_stack_name [\"']?[A-Za-z][A-Za-z0-9-]*" \
      | sed -E "s/^integ_stack_name [\"']?//"
    app_bin_code "$1" \
      | grep -ohE "integStackName\('[A-Za-z][A-Za-z0-9-]*'\)" \
      | sed -E "s/integStackName\('([^']*)'\)/\1/"
  } | sort -u | grep -v '^$' || true
}

# How many stack call sites exist, and how many of those name a LITERAL the
# derivation can resolve. The difference is the whole point: a name built
# from a shell variable (`integ_stack_name "${PRODUCER_BASE}"`) or from a
# non-literal TS expression is a stack this sweep CANNOT query, and a sweep
# that queries three of four names and prints `VERDICT: clean` is instance 1
# narrowed rather than closed.
#
# REJECTED ALTERNATIVE, and it was the shape originally specified: "count
# the call sites and die when derived < found". It dies on a CORRECT
# fixture. Naming one base twice is normal -- once to deploy, once to
# destroy -- and `sort -u` collapses the pair, so found(2) > derived(1) on a
# fixture with nothing wrong with it. Counting UNRESOLVABLE sites instead is
# duplicate-safe, because a duplicate literal is resolvable twice. The
# rejected version is kept executable as mutant MB2b in the probe, and the
# case that kills it is `naming one base twice is NOT a partial derivation`
# -- that pair, not this comment, is the durable record of the decision.
count_unresolvable_stack_sites() { # count_unresolvable_stack_sites <fixture dir>
  local sh_all sh_lit ts_all ts_lit
  sh_all=$(fixture_code "$1/verify.sh" | grep -oE "integ_stack_name" | grep -c . || true)
  sh_lit=$(fixture_code "$1/verify.sh" \
    | grep -oE "integ_stack_name [\"']?[A-Za-z][A-Za-z0-9-]*" | grep -c . || true)
  ts_all=$(app_bin_code "$1" | grep -oE "integStackName\(" | grep -c . || true)
  ts_lit=$(app_bin_code "$1" \
    | grep -oE "integStackName\('[A-Za-z][A-Za-z0-9-]*'\)" | grep -c . || true)
  printf '%s' "$(( (sh_all - sh_lit) + (ts_all - ts_lit) ))"
}

# The same question for the non-stack names. This one WARNS rather than
# dies, and the asymmetry is deliberate: SSM parameters and exports are
# found by a lane-wide filter that does not depend on the derived names at
# all, so an unresolvable scoped name degrades ATTRIBUTION (a finding is
# labelled "another fixture" instead of "this fixture") and can never hide
# a finding. A stack, by contrast, is only ever queried BY NAME.
#
# DO NOT "fix" this warn into a die to match the stack guard above. The two
# look like the same check and are not: dying here would refuse to sweep a
# fixture whose findings the sweep would have reported correctly anyway,
# trading a labelling imprecision for a total refusal. The die above exists
# because an unresolvable STACK is invisible; there is no such invisibility
# here.
count_unresolvable_scoped_sites() { # count_unresolvable_scoped_sites <fixture dir>
  local sh_all sh_lit ts_all ts_lit
  sh_all=$(fixture_code "$1/verify.sh" | grep -oE "integ_scoped_name" | grep -c . || true)
  sh_lit=$(fixture_code "$1/verify.sh" \
    | grep -oE "integ_scoped_name [\"']?[/A-Za-z][A-Za-z0-9/_.-]*" | grep -c . || true)
  ts_all=$(app_code "$1" | grep -oE "integScopedName\(" | grep -c . || true)
  ts_lit=$(app_code "$1" | grep -oE "integScopedName\('[^']*'\)" | grep -c . || true)
  printf '%s' "$(( (sh_all - sh_lit) + (ts_all - ts_lit) ))"
}

# Non-stack account-global base names: SSM parameter paths and
# CloudFormation export names. A scoped name is read from verify.sh AND
# from bin/ + lib/ -- `local-invoke-from-cfn-stack-large-stack` declares
# `/cdkl-ls` only in its app, and it is the parent of ~105 parameters.
derive_scoped_bases() { # derive_scoped_bases <fixture dir>
  {
    fixture_code "$1/verify.sh" \
      | grep -ohE "integ_scoped_name [\"']?[/A-Za-z][A-Za-z0-9/_.-]*" \
      | sed -E "s/^integ_scoped_name [\"']?//"
    app_code "$1" \
      | grep -ohE "integScopedName\('[^']*'\)" \
      | sed -E "s/integScopedName\('([^']*)'\)/\1/"
  } | sort -u | grep -v '^$' || true
}

# The literal head of a bucket name the fixture builds itself. Derived, not
# hard-coded, for the same reason the stack names are: a second
# bucket-creating fixture must be swept without anyone remembering to add
# it here. Everything from the first shell expansion on is dropped, since
# only the literal prefix is stable.
derive_bucket_prefixes() { # derive_bucket_prefixes <fixture dir>
  fixture_code "$1/verify.sh" \
    | grep -ohE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*="cdkl-[^"$]*' \
    | sed -E 's/^[^"]*"//' | sort -u | grep -v '^$' || true
}

# --------------------------------------------------------------- aws driver

AWS_OUT=""
AWS_ERR=""
AWS_RC=0
AWS_ERR_FILE=""

run_aws() { # run_aws <aws args...>
  AWS_OUT=""
  AWS_ERR=""
  AWS_RC=0
  # No `2>/dev/null` on any AWS query. It sends the clean case and the
  # could-not-look case into the same silence, which was instance 1's
  # mechanism; here stderr is CAPTURED and classified instead. (Local file
  # greps below do silence stderr -- an absent `bin/` directory is not a
  # verdict, and every one of them is rc-checked by its caller.)
  AWS_OUT=$(aws "$@" 2>"${AWS_ERR_FILE}") || AWS_RC=$?
  AWS_ERR=$(cat "${AWS_ERR_FILE}")
}

# A missing stack, distinguished from every other failure by the API ERROR
# CODE rather than by the human phrase alone. `does not exist` on its own
# also matches a broken `source_profile`, which is why the prose banned the
# match outright; requiring the `(ValidationError)` code too makes a
# credential-config failure fall through to `indeterminate`.
is_no_such_stack() { # is_no_such_stack <stderr text>
  case "$1" in
    *"(ValidationError)"*"does not exist"*) return 0 ;;
  esac
  return 1
}

# ------------------------------------------------------------------- verdict

verdict=0            # highest severity seen, in EX_* terms
orphan_stacks=""     # newline-separated, for the remediation plan
orphan_other=""      # SSM / export findings, for the remediation plan
report_only=""       # unattributable findings

raise() { # raise <exit code>
  # Precedence 3 > 2 > 4 > 0: "could not look" outranks "found something",
  # because a partial look cannot bound what it missed.
  local rank_new rank_cur
  case "$1" in
    "${EX_INDETERMINATE}") rank_new=3 ;;
    "${EX_ORPHAN}")        rank_new=2 ;;
    "${EX_REPORT}")        rank_new=1 ;;
    *)                     rank_new=0 ;;
  esac
  case "${verdict}" in
    "${EX_INDETERMINATE}") rank_cur=3 ;;
    "${EX_ORPHAN}")        rank_cur=2 ;;
    "${EX_REPORT}")        rank_cur=1 ;;
    *)                     rank_cur=0 ;;
  esac
  if [ "${rank_new}" -gt "${rank_cur}" ]; then verdict="$1"; fi
}

# ---------------------------------------------------------------- the sweeps

sweep_stacks() { # sweep_stacks <name>...
  local stack status
  for stack in "$@"; do
    [ -n "${stack}" ] || continue
    run_aws cloudformation describe-stacks --stack-name "${stack}" \
      --region "${REGION}" --output json
    if [ "${AWS_RC}" -eq 0 ]; then
      # exit 0 IS the orphan case: describe-stacks succeeds when the stack
      # is there. No status filter, so a stack in DELETE_IN_PROGRESS -- an
      # interrupted `cdk destroy`, this sweep's own scenario -- is reported
      # like any other.
      status=$(printf '%s' "${AWS_OUT}" \
        | grep -oE '"StackStatus"[[:space:]]*:[[:space:]]*"[A-Z_]+"' \
        | head -1 | sed -E 's/.*"([A-Z_]+)"$/\1/') || status=""
      say "ORPHAN stack: ${stack} (status=${status:-unknown})"
      orphan_stacks="${orphan_stacks}${stack}"$'\n'
      raise "${EX_ORPHAN}"
    elif is_no_such_stack "${AWS_ERR}"; then
      say "clean: stack ${stack} does not exist"
    else
      err "INDETERMINATE: could not query stack ${stack} (aws rc=${AWS_RC})"
      err "  ${AWS_ERR}"
      raise "${EX_INDETERMINATE}"
    fi
  done
}

# Attribution against the fixture's own derived names. A match that is not
# attributable is still an orphan OF THIS LANE (the filter carries the lane
# suffix), just not of this fixture -- most often a sibling fixture's
# leftover in the same worktree. Saying which is the difference between a
# safe delete and a peer's live resource.
attributed_to_fixture() { # attributed_to_fixture <name> <derived names>
  local name="$1" d
  while IFS= read -r d; do
    [ -n "${d}" ] || continue
    case "${name}" in
      "${d}"|"${d}"/*) return 0 ;;
    esac
  done <<<"$2"
  return 1
}

sweep_ssm() { # sweep_ssm <derived scoped names>
  local derived="$1" name owner
  run_aws ssm describe-parameters --region "${REGION}" \
    --query "Parameters[?starts_with(Name,'/cdkl') && contains(Name,'-${INTEG_STACK_SUFFIX}')].Name" \
    --output text
  if [ "${AWS_RC}" -ne 0 ]; then
    # rc-checked for the same reason as everything else here: on a
    # credential failure this exits non-zero with EMPTY stdout, which reads
    # as "0 parameters" rather than "I could not look".
    err "INDETERMINATE: could not query SSM parameters (aws rc=${AWS_RC})"
    err "  ${AWS_ERR}"
    raise "${EX_INDETERMINATE}"
    return 0
  fi
  if [ -z "${AWS_OUT}" ] || [ "${AWS_OUT}" = "None" ]; then
    say "clean: no SSM parameter carries this lane's suffix"
    return 0
  fi
  for name in ${AWS_OUT}; do
    if attributed_to_fixture "${name}" "${derived}"; then
      owner="this fixture"
    else
      owner="this lane, another fixture"
    fi
    say "ORPHAN ssm-parameter: ${name} (${owner})"
    orphan_other="${orphan_other}ssm-parameter ${name}"$'\n'
    raise "${EX_ORPHAN}"
  done
}

sweep_exports() { # sweep_exports <derived scoped names>
  local derived="$1" name owner line
  run_aws cloudformation list-exports --region "${REGION}" \
    --query "Exports[?starts_with(Name,'cdkl') && contains(Name,'-${INTEG_STACK_SUFFIX}')].[Name,ExportingStackId]" \
    --output text
  if [ "${AWS_RC}" -ne 0 ]; then
    err "INDETERMINATE: could not query CloudFormation exports (aws rc=${AWS_RC})"
    err "  ${AWS_ERR}"
    raise "${EX_INDETERMINATE}"
    return 0
  fi
  if [ -z "${AWS_OUT}" ] || [ "${AWS_OUT}" = "None" ]; then
    say "clean: no CloudFormation export carries this lane's suffix"
    return 0
  fi
  while IFS= read -r line; do
    [ -n "${line}" ] || continue
    name=$(printf '%s' "${line}" | awk '{print $1}')
    if attributed_to_fixture "${name}" "${derived}"; then
      owner="this fixture"
    else
      owner="this lane, another fixture"
    fi
    # An export cannot be deleted on its own -- only by destroying the
    # stack that exports it -- so the exporting stack id is the actionable
    # half, and it may still be in use.
    say "ORPHAN cfn-export: ${line} (${owner})"
    orphan_other="${orphan_other}cfn-export ${line}"$'\n'
    raise "${EX_ORPHAN}"
  done <<<"${AWS_OUT}"
}

# The one resource that carries NO lane hash. `local-invoke-agentcore-froms3`
# builds its bucket name from the account, the region and a timestamp, so a
# match cannot be attributed to this lane, let alone to this run: it may be
# a concurrently running peer's LIVE bucket. It is therefore REPORTED and
# never called an orphan -- a separate exit code (4) so a caller can tell
# "stop and check by hand" from "delete this".
sweep_buckets() { # sweep_buckets <literal prefixes>
  local prefixes="$1" p hits line
  run_aws s3 ls
  if [ "${AWS_RC}" -ne 0 ]; then
    # Checked SEPARATELY from the grep below. Piping straight into grep
    # makes a credential / permission / region failure produce no match,
    # which then reads as "no orphan" -- the same falsely-clean shape.
    err "INDETERMINATE: could not list S3 buckets (aws rc=${AWS_RC})"
    err "  ${AWS_ERR}"
    raise "${EX_INDETERMINATE}"
    return 0
  fi
  while IFS= read -r p; do
    [ -n "${p}" ] || continue
    hits=$(printf '%s\n' "${AWS_OUT}" | grep -F "${p}" || true)
    if [ -z "${hits}" ]; then
      say "clean: no bucket matching '${p}'"
      continue
    fi
    while IFS= read -r line; do
      [ -n "${line}" ] || continue
      say "REPORT (UNATTRIBUTABLE) bucket: ${line}"
      report_only="${report_only}bucket ${line}"$'\n'
    done <<<"${hits}"
    say "  ^ this name carries NO lane suffix, so it cannot be attributed to"
    say "    this lane or this run. It may be a concurrently running peer's"
    say "    LIVE bucket. Confirm no verify.sh is running before deleting."
    raise "${EX_REPORT}"
  done <<<"${prefixes}"
}

# ------------------------------------------------------------- remediation

print_remediation() {
  local line
  [ -n "${orphan_stacks}${orphan_other}${report_only}" ] || return 0
  printf '\n'
  say "REMEDIATION PLAN -- read the two caveats first, then run it by hand."
  say ""
  say "  1. CONFIRM IT IS NOT A LIVE PEER. A name under this lane's suffix"
  say "     can also belong to a second run of the same fixture in the SAME"
  say "     worktree. Check for a running verify.sh before deleting anything."
  say "  2. These are the SUFFIXED names this sweep actually queried. Do not"
  say "     retype the base names: they match nothing and report success."
  if [ -n "${orphan_stacks}" ]; then
    say ""
    say "  Stacks -- in DEPENDENCY order (consumer before producer), so an"
    say "  export is released before its exporter goes. This script cannot"
    say "  derive that order from the fixture, so order these yourself; a"
    say "  wrong order fails the delete rather than silently half-working."
    say ""
    say "  NOT 'cdk destroy': it needs --app context this cwd does not"
    say "  provide, and it exits 0 SILENTLY on a name the app never"
    say "  synthesized -- which is what a fresh shell with no"
    say "  INTEG_STACK_SUFFIX produces."
    while IFS= read -r line; do
      [ -n "${line}" ] || continue
      say ""
      # Emitted WITHOUT the `[sweep] ` prefix, unlike every other line here:
      # the skill says "run what it printed", and a prefixed line is not
      # pasteable. The prose around them keeps the prefix, so the runnable
      # lines are exactly the unprefixed ones.
      printf '    aws cloudformation delete-stack --stack-name %s --region %s\n' "${line}" "${REGION}"
      printf '    aws cloudformation wait stack-delete-complete --stack-name %s --region %s\n' "${line}" "${REGION}"
    done <<<"${orphan_stacks}"
  fi
  if [ -n "${orphan_other}" ]; then
    say ""
    say "  Non-stack names found (an export goes only by destroying its"
    say "  exporting stack; an SSM parameter created by a stack goes with"
    say "  that stack):"
    while IFS= read -r line; do
      [ -n "${line}" ] || continue
      say "    ${line}"
    done <<<"${orphan_other}"
  fi
  if [ -n "${report_only}" ]; then
    say ""
    say "  Unattributable, reported only -- do NOT delete without checking:"
    while IFS= read -r line; do
      [ -n "${line}" ] || continue
      say "    ${line}"
    done <<<"${report_only}"
  fi
  say ""
  say "  3. RE-RUN THIS SWEEP afterwards. No delete command reports 'I"
  say "     matched nothing', so the only evidence the orphan is gone is"
  say "     this script exiting 0."
}

# -------------------------------------------------------------------- main

main() {
  case "${1:-}" in
    -h|--help)
      usage
      return "${EX_OK}"
      ;;
    '')
      # An error, so it goes to stderr like every other error here. It used
      # to print to stdout while `-*` printed to stderr, which makes a
      # caller redirecting one stream see half the failures.
      usage >&2
      err "FATAL: no fixture name given"
      return "${EX_USAGE}"
      ;;
    --list-owners)
      list_owners || die "could not derive the AWS-owning fixture set under ${INTEG_DIR}"
      return "${EX_OK}"
      ;;
    -*)
      usage >&2
      die "unknown option '$1'"
      ;;
  esac

  local fixture="$1" dir verify bases scoped scoped_full prefixes stacks base
  local unresolvable unresolvable_scoped

  case "${fixture}" in
    */*|'') die "fixture name must be a single directory name under ${INTEG_DIR}, got '${fixture}'" ;;
  esac

  dir="${INTEG_DIR}/${fixture}"
  verify="${dir}/verify.sh"
  [ -d "${dir}" ] || die "no such fixture: ${dir}"
  [ -f "${verify}" ] || die "fixture has no verify.sh: ${verify}"

  if ! fixture_owns_aws "${verify}"; then
    say "${fixture} owns no real AWS resource (no stack deploy, no out-of-band bucket)."
    say "VERDICT: clean (nothing to sweep, no AWS call made)"
    return "${EX_OK}"
  fi

  # The lane suffix, resolved ONCE. `stack-name.sh` is sourced by a path
  # derived from THIS file's own location, so the cwd of the caller is
  # irrelevant -- the failure that produced instances 3 and 4 cannot occur.
  # shellcheck source=./stack-name.sh
  source "${SWEEP_LIB_DIR}/stack-name.sh" \
    || die "could not source ${SWEEP_LIB_DIR}/stack-name.sh (no hasher on PATH?)"
  # One guard, not three. An empty suffix turns the filters below into
  # `contains(Name,'-')` -- every hyphenated parameter in the ACCOUNT.
  if [ -z "${INTEG_STACK_SUFFIX:-}" ]; then
    die "the lane suffix is empty; refusing to sweep with an account-wide filter (issue #582)"
  fi
  # `stack-name.sh` documents pre-setting this for CI, so the value is not
  # necessarily the 8-hex the local derivation produces -- but it is
  # interpolated into a JMESPath string literal and into stack names, so it
  # must be a plain token. A value carrying a quote would rewrite the filter
  # expression; a one- or two-character value would make `contains` match
  # most of the account. Both are the account-wide degradation arriving
  # through the pin instead of through an empty variable.
  case "${INTEG_STACK_SUFFIX}" in
    *[!A-Za-z0-9-]*|-*|'')
      die "INTEG_STACK_SUFFIX='${INTEG_STACK_SUFFIX}' is not a plain token ([A-Za-z0-9-], not leading '-'); refusing to interpolate it into a name filter" ;;
  esac
  if [ "${#INTEG_STACK_SUFFIX}" -lt 4 ]; then
    die "INTEG_STACK_SUFFIX='${INTEG_STACK_SUFFIX}' is too short (< 4 characters); a contains() filter on it would select most of the account"
  fi

  say "fixture=${fixture} lane-suffix=${INTEG_STACK_SUFFIX} region=${REGION}"

  bases=$(derive_stack_bases "${dir}")
  scoped=$(derive_scoped_bases "${dir}")

  # A stack is only ever queried BY NAME, so a call site whose argument is
  # not a literal is a stack this sweep cannot look at. Concluding "clean"
  # while holding a name that could not be resolved is instance 1 -- a
  # sweep reporting clean over something it never looked at -- narrowed to
  # one stack of several rather than closed. Measured before this guard
  # existed: a fixture with `integ_stack_name "${PRODUCER_BASE}"` beside a
  # literal sibling queried ONE of its two stacks and printed
  # `VERDICT: clean`, rc=0.
  unresolvable=$(count_unresolvable_stack_sites "${dir}")
  if [ "${unresolvable}" -gt 0 ]; then
    die "${fixture}: ${unresolvable} stack name(s) are built from a variable or expression this sweep cannot resolve, so they could not be queried. Refusing to report on the $(printf '%s\n' "${bases}" | grep -c . || true) name(s) it CAN resolve while ${unresolvable} stay unlooked-at. Spell the base as a literal (integ_stack_name MyFixtureStack) in ${verify} or ${dir}/bin/*.ts."
  fi

  # The same question for scoped names WARNS instead: SSM parameters and
  # exports are found by a lane-wide filter that does not consult the
  # derived names, so an unresolvable one degrades only the "this fixture"
  # / "this lane, another fixture" label and can never hide a finding.
  unresolvable_scoped=$(count_unresolvable_scoped_sites "${dir}")
  if [ "${unresolvable_scoped}" -gt 0 ]; then
    err "WARN: ${unresolvable_scoped} scoped-name call site(s) in ${fixture} are not literals; findings they own will be labelled 'this lane, another fixture'. The lane-wide filter still finds them."
  fi
  prefixes=""
  if fixture_creates_bucket "${verify}"; then
    prefixes=$(derive_bucket_prefixes "${dir}")
    [ -n "${prefixes}" ] || die "${fixture} creates a bucket out of band but no literal bucket-name prefix could be derived from ${verify}; refusing to report a sweep that never looked"
  fi

  # A fixture that DEPLOYS but names no stack is a derivation failure, not
  # an empty sweep. Reporting clean here is instance 1 exactly.
  if [ -z "${bases}" ] && [ -z "${prefixes}" ]; then
    die "${fixture} owns AWS resources but no stack base name could be derived from ${verify} or ${dir}/bin/*.ts"
  fi

  command -v aws >/dev/null 2>&1 || {
    err "INDETERMINATE: 'aws' is not on PATH; nothing was queried"
    say "VERDICT: indeterminate"
    return "${EX_INDETERMINATE}"
  }

  AWS_ERR_FILE=$(mktemp)
  trap 'rm -f "${AWS_ERR_FILE}"' EXIT INT TERM

  # Probe credentials ONCE, up front. Without it, every query below fails
  # with the same unrecognized error and the output is N copies of one
  # cause; with it, "no credentials" is one clear line and the sweep stops
  # before making claims it cannot support.
  # `--region` on the probe too: a region that rejects the caller must fail
  # HERE, as one clear line, rather than N identical unrecognized errors.
  run_aws sts get-caller-identity --region "${REGION}" --output text
  if [ "${AWS_RC}" -ne 0 ]; then
    err "INDETERMINATE: no usable AWS credentials (aws sts get-caller-identity rc=${AWS_RC})"
    err "  ${AWS_ERR}"
    say "VERDICT: indeterminate"
    return "${EX_INDETERMINATE}"
  fi

  # Suffix every derived base through the SAME helper the fixture uses, so
  # the sweep and the deploy cannot disagree about the name.
  stacks=""
  while IFS= read -r base; do
    [ -n "${base}" ] || continue
    stacks="${stacks}$(integ_stack_name "${base}")"$'\n'
  done <<<"${bases}"

  scoped_full=""
  while IFS= read -r base; do
    [ -n "${base}" ] || continue
    scoped_full="${scoped_full}$(integ_scoped_name "${base}")"$'\n'
  done <<<"${scoped}"

  if [ -n "${stacks}" ]; then
    # shellcheck disable=SC2086  # the name list must word-split
    sweep_stacks ${stacks}
  fi
  sweep_ssm "${scoped_full}"
  sweep_exports "${scoped_full}"
  if [ -n "${prefixes}" ]; then
    sweep_buckets "${prefixes}"
  fi

  print_remediation

  case "${verdict}" in
    "${EX_ORPHAN}")        say "VERDICT: orphan" ;;
    "${EX_INDETERMINATE}") say "VERDICT: indeterminate" ;;
    "${EX_REPORT}")        say "VERDICT: report-only" ;;
    *)                     say "VERDICT: clean" ;;
  esac
  return "${verdict}"
}

main "$@"
