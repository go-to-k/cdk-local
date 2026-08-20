#!/usr/bin/env bash
# Behavioral smoke test for the gates' COMMAND RECOGNITION, driven through the
# real hooks with real payloads. Run from the repo root:
#   bash .claude/hooks/gate-command-recognition.test.sh
#
# Why this exists (go-to-k/cdk-local#542 review): the helper's own harness tests
# `gate_matches`, and a structural case asserts each gate sources the helper —
# but neither can see a gate that sources it and then asks the WRONG question.
# Two mutations proved it: pointing `check-gate` at `GATE_RE_GIT_PUSH`, and
# replacing its `gate_matches … || exit 0` with a bare `exit 0`, both left the
# suite green. These cases kill both.
#
# markgate is stubbed so marker state is controlled; the gates' own verdict logic
# is out of scope here — what is under test is WHICH commands reach it.

set -u

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

repo="$TMPDIR/repo"
git init -q -b feature "$repo"
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
: > "$repo/.markgate.yml"   # opt in to the markgate convention

SHIM="$TMPDIR/bin"; mkdir -p "$SHIM"
cat > "$SHIM/mise" <<'MISE'
#!/usr/bin/env bash
exit "${MARKGATE_RC:-1}"
MISE
cat > "$SHIM/markgate" <<'MG'
#!/usr/bin/env bash
exit "${MARKGATE_RC:-1}"
MG
chmod +x "$SHIM/mise" "$SHIM/markgate"

pass=0; fail=0
# run_case <name> <expect_exit> <hook> <command>
run_case() {
  local name="$1" want="$2" hook="$3" cmd="$4" got out payload
  payload=$(printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd")
  out=$(printf '%s' "$payload" | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 \
    "$HOOKS/$hook" 2>&1); got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(exit $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s, got %s)\n  out: %s\n' "$name" "$want" "$got" "$out"
  fi
}

# check-gate guards `git commit` — and ONLY that verb.
run_case "check-gate: bare commit"            2 check-gate.sh 'git commit -m x'
run_case "check-gate: add -A && commit"       2 check-gate.sh 'git add -A && git commit -m x'
run_case "check-gate: subshell commit"        2 check-gate.sh '(cd . && git commit -m x)'
run_case "check-gate: push is not its verb"   0 check-gate.sh 'git push origin HEAD'
run_case "check-gate: status passes"          0 check-gate.sh 'git status --short'
run_case "check-gate: quoted mention passes"  0 check-gate.sh 'echo \"then git commit -m x\"'

# verify-pr-gate guards `gh pr create` / `gh pr merge`, not `gh pr view`.
run_case "verify-pr-gate: pr create"          2 verify-pr-gate.sh 'gh pr create --fill'
run_case "verify-pr-gate: push && pr create"  2 verify-pr-gate.sh 'git push && gh pr create --fill'
run_case "verify-pr-gate: pr merge"           2 verify-pr-gate.sh 'gh pr merge 42 --squash'
run_case "verify-pr-gate: pr view passes"     0 verify-pr-gate.sh 'gh pr view 42'

# branch-gate guards commit AND push, and only on a protected branch.
git -C "$repo" checkout -q -b main
run_case "branch-gate: commit on main"        2 branch-gate.sh 'git commit -m x'
run_case "branch-gate: push on main"          2 branch-gate.sh 'git push origin HEAD'
run_case "branch-gate: chained commit"        2 branch-gate.sh 'vp run check && git commit -m x'
run_case "branch-gate: status on main"        0 branch-gate.sh 'git status'
git -C "$repo" checkout -q feature
run_case "branch-gate: commit on a feature branch" 0 branch-gate.sh 'git commit -m x'

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
