#!/usr/bin/env bash
# Smoke test for pr-review-gate.sh, focused on the down-bias bucket.
#
# The gate re-implements /review-pr's tier heuristic in Bash, and the
# part that is easiest to get wrong is which paths count as "inert
# documentation". Issue #501: agent-instruction files (CLAUDE.md,
# .claude/**, .markgate.yml) used to be in that bucket, so a PR that
# rewrites how the agent behaves was reviewed one tier LOWER than a
# same-sized code PR.
#
# Method: stub `gh` on PATH so the hook reads a fixture PR, run the hook
# in a throwaway git repo (no markgate marker there), and read the exit
# code. Sizes are chosen so the BASE tier is `1-reviewer`, where the two
# outcomes are distinguishable: down-bias -> `inline` -> exit 0 (pass),
# no down-bias -> `1-reviewer` -> marker verify fails -> exit 2 (block).
set -u

HOOK_DIR=$(cd "$(dirname "$0")" && pwd)
HOOK="$HOOK_DIR/pr-review-gate.sh"
pass=0
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

# Throwaway repo: markgate has no marker here, so any gated tier blocks.
REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@example.com
git -C "$REPO" config user.name t

# `gh` stub: emits the fixture JSON in $GH_FIXTURE for `pr view`.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  pr) shift ;;
  *) exit 1 ;;
esac
case "${1:-}" in
  view) cat "$GH_FIXTURE" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/gh"

# Build a fixture: $1 = loc, $2 = file paths (space separated).
fixture() {
  local loc="$1"; shift
  local paths=("$@")
  local files="" p
  for p in "${paths[@]}"; do
    files="$files{\"path\":\"$p\"},"
  done
  files="${files%,}"
  cat > "$TMP/fixture.json" <<EOF
{"additions":$loc,"deletions":0,"changedFiles":${#paths[@]},
 "files":[$files],"headRefOid":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
 "headRefName":"feat/x","number":42}
EOF
  printf '%s' "$TMP/fixture.json"
}

# run_case <name> <expected-exit> <loc> <path>...
run_case() {
  local name="$1" want="$2" loc="$3"; shift 3
  GH_FIXTURE=$(fixture "$loc" "$@")
  export GH_FIXTURE
  local payload
  payload=$(printf '{"tool_input":{"command":"gh pr merge 42 --squash"},"cwd":"%s"}' "$REPO")
  local got
  ( cd "$REPO" && export PATH="$TMP/bin:$PATH" \
    && printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1 )
  got=$?
  if [ "$got" -eq "$want" ]; then
    printf 'ok   %s (exit %s)\n' "$name" "$got"; pass=$((pass + 1))
  else
    printf 'FAIL %s: want exit %s, got %s\n' "$name" "$want" "$got"; fail=$((fail + 1))
  fi
}

SIX_SKILLS=(.claude/skills/a/SKILL.md .claude/skills/b/SKILL.md .claude/skills/c/SKILL.md
            .claude/skills/d/SKILL.md .claude/skills/e/SKILL.md .claude/skills/f/SKILL.md)
SIX_DOCS=(README.md docs/a.md docs/b.md docs/c.md docs/d.md docs/e.md)
SIX_INTEG_READMES=(tests/integration/a/README.md tests/integration/b/README.md
                   tests/integration/c/README.md tests/integration/d/README.md
                   tests/integration/e/README.md tests/integration/f/README.md)
SIX_HOOKS=(.claude/hooks/a.sh .claude/hooks/b.sh .claude/hooks/c.sh
           .claude/hooks/d.sh .claude/hooks/e.sh .claude/hooks/f.sh)

# Issue #501: agent-instruction paths must NOT down-bias.
run_case "skills-only keeps its tier (blocked)"        2 500 "${SIX_SKILLS[@]}"
run_case "hooks-only keeps its tier (blocked)"         2 500 "${SIX_HOOKS[@]}"
run_case "CLAUDE.md + .markgate.yml keep their tier"   2 500 CLAUDE.md .claude/CLAUDE.md .markgate.yml \
                                                              .claude/rules/a.md .claude/agents/b.md .claude/settings.json
run_case "mixed skills + docs keeps its tier"          2 500 .claude/skills/a/SKILL.md docs/a.md docs/b.md \
                                                              docs/c.md docs/d.md docs/e.md

# Inert documentation still down-biases.
run_case "docs-only down-biases to inline (pass)"      0 500 "${SIX_DOCS[@]}"
run_case "integ READMEs down-bias to inline (pass)"    0 500 "${SIX_INTEG_READMES[@]}"

# Size floor still applies: a small skills-only diff is inline anyway.
run_case "small skills-only diff is inline (pass)"     0 100 .claude/skills/a/SKILL.md

# Non-merge commands pass through untouched.
non_merge_payload='{"tool_input":{"command":"gh pr create --title x"},"cwd":"'"$REPO"'"}'
if printf '%s' "$non_merge_payload" | bash "$HOOK" >/dev/null 2>&1; then
  printf 'ok   gh pr create passes through (exit 0)\n'; pass=$((pass + 1))
else
  printf 'FAIL gh pr create should pass through\n'; fail=$((fail + 1))
fi

printf '\npass: %d  fail: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
