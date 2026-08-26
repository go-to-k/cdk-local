#!/usr/bin/env bash
# markgate-pipe-gate.sh
#
# PreToolUse hook. Blocks a Bash call in which `markgate verify <gate>` or
# `markgate set <gate>` feeds a `|` pipeline, because there `$?` is the LAST
# STAGE's exit status and markgate's verdict is thrown away.
#
# WHY THIS IS A GATE AND NOT A NOTE (go-to-k/cdk-local#571). markgate answers
# with an exit code and prints NOTHING on the fresh path, so a healthy run looks
# like "no output, rc=0" -- and so does a STALE one once it is piped:
#
#   mise exec -- markgate verify integ 2>&1 | tail -5; echo "rc=$?"
#   # prints nothing, rc=0    -> read as "marker fresh"
#   mise exec -- markgate verify integ > /tmp/out 2>&1; rc=$?
#   # rc=1                    -> the marker was STALE
#
# A stale marker is indistinguishable from a fresh one, and the natural next
# step is to skip the verification the gate was demanding. Observed live while
# working #564 / #561 on the `integ` gate, where it would have meant opening a
# PR whose Docker path had never been exercised against the final code. A gate
# that cannot fail is worse than no gate, because it is trusted.
#
# `.claude/skills/verify-pr/SKILL.md` step 1 already warned about `$?` after a
# pipeline. It was read, and the trap was hit anyway -- on a sibling command the
# wording did not name. That is the standard case for moving an instruction out
# of documentation and into enforcement.
#
# WHAT IS DELIBERATELY NOT BLOCKED, because a merge gate that over-tightens
# blocks everyone:
#
#   markgate status <gate> | awk …   its answer is on STDOUT; piping it is the
#                                    correct use, and every gate here does it.
#   markgate verify <gate> || echo   `||` reads the exit status rather than
#                                    discarding it; that is the point of it.
#   markgate verify <gate> && …      same -- `&&` is a status test.
#   echo x | markgate verify <gate>  the LAST stage of a pipeline; `$?` there
#                                    really is markgate's own.
#   vp run <task> | tail             same pipeline trap, but `vp` PRINTS its
#                                    failure, so the output still carries the
#                                    verdict. Silence on failure is what makes
#                                    markgate un-catchable, and it is the line
#                                    this gate draws.
#
# The non-piped rewrite this gate steers to is the one cdkd's `check-gate.sh`
# uses, where `$?` IS the command's own status:
#
#   out=$(mise exec -- markgate verify <gate> 2>&1 >/dev/null); rc=$?

set -u

# Shared, segment-aware command matching (go-to-k/cdk-local#541).
# Fail CLOSED if the shared matcher is missing or does not load: a gate that
# cannot decide must not wave the command through. The `declare -F` check
# catches a partial source, where `.` succeeds but the function is missing --
# and here it also catches an OLDER copy of the library that predates
# `gate_matches_piped`, which would otherwise be an unbound-command no-op that
# exits 0 on every command.
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
if ! declare -F gate_matches_piped >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_matches_piped is undefined (older or truncated file?)." >&2
  exit 2
fi

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only a markgate VERDICT verb that FEEDS a pipe. Everything else -- including
# the same verb un-piped, `markgate status` piped, and a mention inside a quoted
# string or a heredoc body -- passes through.
gate_matches_piped "$cmd" "$GATE_RE_MARKGATE_VERDICT" || exit 0

cat >&2 <<'EOF'
Blocked by markgate-pipe-gate: `markgate verify` / `markgate set` is feeding a
pipe, so the exit status you would read is the LAST STAGE's, not markgate's.

markgate prints NOTHING when a marker is fresh, so a piped STALE marker is
byte-identical to a fresh one: no output, rc=0. The gate silently reports a
pass and the verification it was demanding gets skipped.

Rewrite with a command substitution, where `$?` IS markgate's own status:

  out=$(mise exec -- markgate verify <gate> 2>&1 >/dev/null); rc=$?
  echo "[markgate verify <gate> rc=$rc] $out"

  # rc=0 fresh | rc=1 stale or no marker | rc>=2 markgate could not evaluate
  # (e.g. an unparseable .markgate.yml, or an unresolvable `base` ref for the
  # `integ` gate -- fix with a bare `git fetch origin`).

Or redirect to a file instead of piping:

  mise exec -- markgate verify <gate> > /tmp/markgate.log 2>&1; rc=$?

These pass through and need no rewrite:

  markgate status <gate> | awk …    stdout IS the answer there
  markgate verify <gate> || echo …  `||` reads the status, it does not drop it
  echo x | markgate verify <gate>   last stage: `$?` is markgate's

If you are genuinely only reading `markgate status` text, use `status` -- this
gate does not touch it.
EOF
exit 2
