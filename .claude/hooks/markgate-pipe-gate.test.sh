#!/usr/bin/env bash
# Behavioral test for markgate-pipe-gate.sh, driven through the REAL hook with
# real PreToolUse payloads. Run from the repo root:
#   bash .claude/hooks/markgate-pipe-gate.test.sh
#
# The gate is a false-ACCEPT fix (go-to-k/cdk-local#571), so the REFUSE cases
# are what prove it works. They are not enough on their own: a refuse-only
# fence cannot see an over-tightening, and over-tightening this gate would
# block every legitimate `markgate status | awk` and `markgate set … || echo`
# in the repo. Both directions are therefore driven, and the ACCEPT block below
# is as long as the REFUSE block on purpose.
#
# HERMETICITY. Each axis is either pinned or measured-and-recorded:
#   git history  not read -- the gate never shells out to git. Measured: the
#                payload cwd below is a bare mktemp dir with no repo at all,
#                and every case still produces its expected verdict.
#   cwd          pinned to that same throwaway dir via the payload's `cwd`.
#   env          pinned with `env -i`; only PATH and the payload reach the hook.
#   PATH         pinned to /usr/bin:/bin (the hook needs `jq` and `bash` only).
#                No stub is needed because the gate NEVER RUNS markgate -- it
#                is a static read of the command text. That is also why there
#                is no MARKGATE_RC here, unlike gate-command-recognition.test.sh.
#   $HOME        pinned to the throwaway dir, so no user dotfile is sourced.
#   clock        not read -- no TTL, no timestamp, no marker store.
#
# `jq` must exist on PATH for the hook to parse the payload. If it does not,
# the hook reads an EMPTY command and every case would pass VACUOUSLY, so the
# harness refuses to run rather than reporting a green suite over nothing.

set -u

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HOOKS/markgate-pipe-gate.sh"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

if ! PATH=/usr/bin:/bin command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is not on the pinned PATH, so every case would pass vacuously." >&2
  exit 1
fi

# `python3` is used by the second `fail_closed` case. Its absence fails LOUDLY
# rather than vacuously, but it is a dependency of this file either way, so it
# is declared here next to `jq` instead of being an undocumented assumption.
if ! command -v python3 >/dev/null 2>&1; then
  echo "FATAL: python3 is required by the fail_closed cases below." >&2
  exit 1
fi

pass=0; fail=0

# run_case <name> <expect_exit> <command>
# 2 = refused, 0 = allowed through.
run_case() {
  local name="$1" want="$2" cmd="$3" got out payload
  payload=$(jq -nc --arg c "$cmd" --arg d "$SANDBOX" \
    '{tool_name:"Bash", cwd:$d, tool_input:{command:$c}}')
  out=$(printf '%s' "$payload" | env -i PATH=/usr/bin:/bin HOME="$SANDBOX" \
    bash "$GATE" 2>&1); got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-58s %s\n' "$name" "(exit $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s, got %s)\n  cmd: %s\n  out: %s\n' \
      "$name" "$want" "$got" "$cmd" "$out"
  fi
}

echo "== REFUSE: markgate's verdict feeds a pipe =================================="
# The literal command from the issue, `2>&1` included. That redirection is not
# decoration: the segmenter used to split on the `&` inside `2>&1`, which put
# the pipe mark on the trailing `1` and let THIS EXACT COMMAND through.
run_case "issue repro: verify integ 2>&1 | tail -5"   2 'mise exec -- markgate verify integ 2>&1 | tail -5'
run_case "verify piped to tee"                        2 'mise exec -- markgate verify integ 2>&1 | tee /tmp/o'
run_case "verify piped to grep"                       2 'mise exec -- markgate verify check | grep state'
run_case "bare markgate (no mise) piped"              2 'markgate verify check | head -3'
run_case "set piped"                                  2 'mise exec -- markgate set integ | tee /tmp/l'
run_case "|& (stderr pipe)"                           2 'mise exec -- markgate set integ |& tee /tmp/l'
run_case "after a cd &&"                              2 'cd /w/t && mise exec -- markgate verify integ | tail -1'
run_case "after a semicolon"                          2 'cd /w/t; mise exec -- markgate verify integ | tail -1'
run_case "inside a subshell"                          2 '(cd /w/t && mise exec -- markgate verify integ | tail -1)'
run_case "inside bash -c"                             2 'bash -c "mise exec -- markgate verify integ | tail"'
# The pipe OUTSIDE `bash -c`: the recursion used to drop the outer mark, so
# `gate_piped_segments` emitted nothing and the gate passed.
run_case "bash -c body with the pipe OUTSIDE"         2 'bash -c "mise exec -- markgate verify integ" | tail -5'
# Launcher flags that take a value must still reach the verb.
run_case "mise exec -C <dir> -- markgate"             2 'mise exec -C /w/t -- markgate verify integ | tail -5'
run_case "mise exec --cd <dir> -- markgate"           2 'mise exec --cd /w/t -- markgate set integ | tee /tmp/l'
run_case "boolean flag then -- markgate"              2 'mise exec --raw -- markgate verify integ | tail -5'
# The value is REALLY quoted here (this suite builds its payload with `jq
# --arg`, so a literal `"` needs no escaping). A backslash-escaped `\"` would be
# a literal quote character to the segmenter and would test the wrong thing.
run_case "quoted launcher flag value"                2 'mise exec --cd "/w t" -- markgate verify integ | tail -5'
run_case "inside a command substitution"              2 'echo "$(mise exec -- markgate verify integ | tail -1)"'
run_case "mise x spelling"                            2 'mise x -- markgate verify integ | cat'
run_case "mise exec with a tool pin"                  2 'mise exec markgate@0.4 -- markgate verify integ | cat'
run_case "absolute markgate path"                     2 '/opt/homebrew/bin/markgate verify integ | cat'
run_case "second stage of a longer pipeline"          2 'mise exec -- markgate verify integ | grep -v x | wc -l'
run_case "leading env assignment"                     2 'FOO=1 mise exec -- markgate verify integ | cat'
run_case "not the first segment of the list"          2 'vp run check && markgate verify check | tail -1'
# MULTI-LINE. Every other case here is single-line, and that was a real hole:
# mutating the segmenter to see only the FIRST line left this suite 38/38 and
# gate-command-recognition 121/121 green while both spellings below ACCEPTed.
# Multi-line bash is what agents write most.
run_case "multi-line: pipe on the second line"        2 'cd /w/t
mise exec -- markgate verify integ | tail -5
echo done'
run_case "backslash continuation before the pipe"     2 'mise exec -- markgate verify integ \
  | tail -5'
run_case "multi-line: pipe on the third line"         2 'set -u
echo starting
mise exec -- markgate set integ 2>&1 | tee /tmp/l'
# `markgate run` is `verify || (cmd && set)` sugar, so it has the identical
# property: the answer is an exit code and the fresh path is silent.
run_case "run piped (verify||set sugar, same defect)" 2 'mise exec -- markgate run check -- vp run check | tail -5'
# `&>` is the sibling of the `2>&1` repro at the top of this block. Deleting its
# guard in the segmenter used to leave this whole suite green.
run_case "&> before the pipe"                         2 'mise exec -- markgate verify integ &> /dev/null | tail -5'
# `set -o pipefail` DOES propagate the rc, so this refusal is a deliberate
# conservative call rather than an oversight -- pinned so the decision is
# visible if anyone revisits it. The gate reads one command text and cannot
# know whether pipefail is still in effect when the pipeline runs, and the
# non-piped rewrite is free.
run_case "pipefail still refused (by design)"         2 'set -o pipefail; mise exec -- markgate verify check | tail -5'

echo
echo "== ACCEPT: the exit status is still markgate's =============================="
run_case "redirect to a file, then \$?"               0 'mise exec -- markgate verify integ > /tmp/o 2>&1; rc=$?'
run_case "command substitution, then \$?"             0 'out=$(mise exec -- markgate verify integ 2>&1 >/dev/null); rc=$?'
run_case "discarded output, then \$?"                 0 'mise exec -- markgate verify integ >/dev/null 2>&1; rc=$?'
run_case "|| reads the status"                        0 'mise exec -- markgate set integ || echo "MARKER NOT RECORDED"'
run_case "&& reads the status"                        0 'mise exec -- markgate verify check && gh pr merge 1 --squash'
run_case "|| and && together"                         0 'markgate verify check && echo fresh || echo stale'
run_case "bare verify, nothing after it"              0 'mise exec -- markgate verify integ'
run_case "bare set, nothing after it"                 0 'mise exec -- markgate set check'
run_case "status piped to awk (the hooks' own idiom)" 0 'mise exec -- markgate status integ | awk "/^state:/"'
run_case "status piped to grep"                       0 'markgate status check | grep state'
run_case "last stage of a pipeline"                   0 'echo x | markgate verify check'
run_case "quoted mention of the piped form"           0 'echo "mise exec -- markgate verify integ | tail"'
run_case "single-quoted mention"                      0 "echo 'markgate verify integ | tail'"
run_case "heredoc body mentioning the piped form"     0 'cat <<EOF
mise exec -- markgate verify integ | tail -5
EOF'
run_case "a comment mentioning the piped form"        0 'echo hi   # markgate verify integ | tail'
run_case "an unrelated pipe"                          0 'git status --short | head'
run_case "an unrelated pipe naming markgate as data"  0 'grep -rn markgate .claude/hooks | head'
run_case "markgate install is not a verdict verb"     0 'mise exec -- markgate install | tail'
run_case "empty command"                              0 ''
# The false block the launcher prefix used to cause: auditing THIS gate is the
# most likely reason anyone types `markgate verify` as grep input.
run_case "grepping for the piped form"                0 'mise exec -- rg markgate verify .claude | head'
run_case "grepping with the form quoted"              0 'mise exec -- grep -rn "markgate verify" .claude | head'
run_case "grepping through a -C launcher flag"        0 'mise exec -C /w/t -- rg markgate verify . | head'
run_case "grepping behind a boolean launcher flag"    0 'mise exec --raw rg markgate verify . | head'
run_case "grepping behind a short boolean flag"      0 'mise exec -q rg markgate verify . | head'
run_case "bash -c body, nothing piped"                0 'bash -c "mise exec -- markgate verify integ"'
# Multi-line ACCEPT, so the multi-line REFUSE cases above cannot be satisfied by
# a mutation that simply refuses everything spanning a newline.
run_case "multi-line, un-piped verdict"               0 'cd /w/t
mise exec -- markgate verify integ >/dev/null 2>&1; rc=$?
echo "[rc=$rc]"'

echo
echo "== the harness itself ======================================================="
# The gate must FAIL CLOSED when the shared library is unusable, rather than
# waving every command through. Two shapes: absent, and present-but-older (a
# copy that predates `gate_matches_piped`, where the call would be an unbound
# command and `|| exit 0` would exit 0 on EVERYTHING).
# fail_closed <name> <expected message fragment> <mutation>
#
# The fragment is load-bearing, not decoration. Deleting the library trips BOTH
# guards -- the readability test AND the `declare -F` test after the failed
# source -- so asserting only "exit 2 mentioning _command-match.sh" is satisfied
# twice over, and a mutation probe confirmed it: removing the readability guard
# entirely left this case GREEN. Naming which guard must speak makes each case
# fence its own guard.
fail_closed() {
  local name="$1" want="$2" mutate="$3" tmp out rc
  tmp="$SANDBOX/lib-$RANDOM"; mkdir -p "$tmp"
  cp "$HOOKS/markgate-pipe-gate.sh" "$tmp/"
  cp "$HOOKS/_command-match.sh" "$tmp/"
  eval "$mutate"
  out=$(jq -nc --arg d "$SANDBOX" '{tool_name:"Bash",cwd:$d,tool_input:{command:"markgate verify check | tail"}}' \
    | env -i PATH=/usr/bin:/bin HOME="$SANDBOX" bash "$tmp/markgate-pipe-gate.sh" 2>&1); rc=$?
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF "$want"; then
    pass=$((pass + 1)); printf 'OK   %-58s %s\n' "$name" "(exit $rc)"
  else
    fail=$((fail + 1)); printf 'FAIL %s must exit 2 saying "%s" (got %s)\n  out: %s\n' "$name" "$want" "$rc" "$out"
  fi
}
fail_closed "library absent" "is missing or unreadable" 'rm -f "$tmp/_command-match.sh"'
fail_closed "library predates gate_matches_piped" "gate_matches_piped is undefined" \
  'python3 - "$tmp/_command-match.sh" <<STRIP
import io,sys
p=sys.argv[1]; s=io.open(p,encoding="utf-8").read()
a=s.index("gate_matches_piped() {")
b=s.index("\nreturn 1\n}", a) if False else s.index("\n}\n", a)+3
io.open(p,"w",encoding="utf-8").write(s[:a]+s[b:])
STRIP'

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
