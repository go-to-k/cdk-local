#!/usr/bin/env bash
# Smoke test for pr-review-gate.sh: the down-bias bucket, and the up-bias
# security-surface path list.
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
# Markdown outside docs/** and tests/**: the only shape that pins the
# `.*\.md` entry itself. An all-under-tests/ list would down-bias through the
# tests bucket even if that entry were deleted, so it proves nothing about it.
SIX_LOOSE_MD=(CONTRIBUTING.md docs/a.md tests/integration/a/README.md
              CHANGELOG.md docs/b.md tests/integration/b/README.md)
SIX_HOOKS=(.claude/hooks/a.sh .claude/hooks/b.sh .claude/hooks/c.sh
           .claude/hooks/d.sh .claude/hooks/e.sh .claude/hooks/f.sh)

# Issue #501: agent-instruction paths must NOT down-bias.
run_case "skills-only keeps its tier (blocked)"        2 500 "${SIX_SKILLS[@]}"
run_case "hooks-only keeps its tier (blocked)"         2 500 "${SIX_HOOKS[@]}"
# The markdown-shaped agent paths are the ones that need AGENT_INSTRUCTION_REGEX:
# they all match the docs bucket's `.*\.md`, so only the exclusion keeps them out.
run_case "markdown agent-instruction files keep tier"  2 500 CLAUDE.md .claude/CLAUDE.md \
                                                              .claude/rules/a.md .claude/rules/b.md \
                                                              .claude/agents/c.md .claude/skills/d/SKILL.md
# Non-markdown agent paths are held out by the trimmed docs list alone; kept as a
# separate case so a later widening of that list cannot silently un-gate them.
run_case "non-markdown agent files keep their tier"    2 500 .markgate.yml .claude/settings.json \
                                                              .claude/settings.local.json .claude/hooks/a.sh \
                                                              .claude/hooks/b.sh .claude/hooks/c.sh
run_case "mixed skills + docs keeps its tier"          2 500 .claude/skills/a/SKILL.md docs/a.md docs/b.md \
                                                              docs/c.md docs/d.md docs/e.md

# Inert documentation still down-biases.
run_case "docs-only down-biases to inline (pass)"      0 500 "${SIX_DOCS[@]}"
run_case "loose markdown down-biases to inline (pass)" 0 500 "${SIX_LOOSE_MD[@]}"

# Size floor still applies: a small skills-only diff is inline anyway.
run_case "small skills-only diff is inline (pass)"     0 100 .claude/skills/a/SKILL.md

# Non-merge commands pass through untouched.
non_merge_payload='{"tool_input":{"command":"gh pr create --title x"},"cwd":"'"$REPO"'"}'
GH_FIXTURE=$(fixture 500 .claude/skills/a/SKILL.md)
export GH_FIXTURE
if ( cd "$REPO" && export PATH="$TMP/bin:$PATH" \
     && printf '%s' "$non_merge_payload" | bash "$HOOK" >/dev/null 2>&1 ); then
  printf 'ok   gh pr create passes through (exit 0)\n'; pass=$((pass + 1))
else
  printf 'FAIL gh pr create should pass through\n'; fail=$((fail + 1))
fi


# ---------------------------------------------------------------------------
# Compound command shapes (issue #541).
#
# The gate used to decide whether it applied with a LINE-START-anchored regex,
# so `gh pr merge` in any position but the first ran UNGATED. These cases pin
# the segment matcher: the verb blocks wherever it sits in the command list,
# and a mention inside a quoted string still does not.
# ---------------------------------------------------------------------------

# run_cmd_case <name> <expected-exit> <command>
# Uses the 500-loc, six-file skills-only diff -- the same shape as the
# `skills-only keeps its tier` case above, i.e. a diff that MUST block once the
# gate recognises the command. Anything that fails to recognise it exits 0, so
# a `want 2` case can only pass by way of the matcher.
run_cmd_case() {
  local name="$1" want="$2" command="$3" got payload
  GH_FIXTURE=$(fixture 500 "${SIX_SKILLS[@]}")
  export GH_FIXTURE
  payload=$(jq -nc --arg c "$command" --arg d "$REPO" \
    '{tool_input:{command:$c},cwd:$d}')
  ( cd "$REPO" && export PATH="$TMP/bin:$PATH" \
    && printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1 )
  got=$?
  if [ "$got" -eq "$want" ]; then
    printf 'ok   %s (exit %s)\n' "$name" "$got"; pass=$((pass + 1))
  else
    printf 'FAIL %s: want exit %s, got %s\n' "$name" "$want" "$got"; fail=$((fail + 1))
  fi
}

run_cmd_case "git add -A && gh pr merge blocks"   2 'git add -A && gh pr merge 42 --squash'
run_cmd_case "echo x && gh pr merge blocks"       2 'echo x && gh pr merge 42 --squash'
run_cmd_case "semicolon-separated merge blocks"   2 'echo x; gh pr merge 42 --squash'
run_cmd_case "quoted mention passes through"      0 'echo "next: gh pr merge 42 --squash"'
run_cmd_case "heredoc body mention passes through" 0 'cat <<EOF
gh pr merge 42 --squash
EOF'

# ---------------------------------------------------------------------------
# Up-bias security surface (issue #506).
#
# The list of security-sensitive paths is written out FOUR times: `UP_PATHS` in
# the hook plus three prose copies. #506 found it drifted in BOTH directions --
# the reviewer-agent copy had silently dropped `src/utils/role-arn.ts`, and
# seven live authn / credential / code-exec modules were missing from all four.
# Prose ("re-check when editing this list") is exactly what had failed, so the
# invariant is asserted here instead: the four copies agree, and every entry
# resolves to a real file.
# ---------------------------------------------------------------------------

REPO_ROOT=$(cd "$HOOK_DIR/../.." && pwd)

check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" -eq 0 ]; then
    printf 'ok   %s\n' "$name"; pass=$((pass + 1))
  else
    printf 'FAIL %s%s\n' "$name" "${detail:+: $detail}"; fail=$((fail + 1))
  fi
}

# Extract the `src/...` paths a file declares, restricted to the region that
# holds the list. Each region is delimited by anchors asserted to exist below,
# so a heading rewrite fails loudly instead of yielding an empty set that would
# trivially "agree" with nothing. `\%...%` addresses, not `/.../`: one anchor
# contains a literal `/` ("security / process-launch surface").
# extract_paths <file> <start-re> [<end-re>]   -- omit end-re for a one-liner.
extract_paths() {
  local file="$1" start_re="$2" end_re="${3:-}" range
  if [ -n "$end_re" ]; then
    range="\%$start_re%,\%$end_re%p"
  else
    range="\%$start_re%p"
  fi
  # Document order, duplicates preserved -- deliberately NOT `sort -u`. A copy
  # that drops an entry from its list but names it again in the surrounding
  # prose would still contain the string, so a set comparison would call it
  # present; that is the exact #506 defect, and it masked itself on the first
  # draft of this test. Order + multiplicity catch both the drop (position
  # moves) and the stray mention (extra entry), and they also keep the four
  # copies in one canonical order that a human can diff by eye.
  sed -n "$range" "$REPO_ROOT/$file" \
    | grep -oE 'src/[A-Za-z0-9_./-]+\.ts'
}

HOOK_PATHS=$(extract_paths .claude/hooks/pr-review-gate.sh '^UP_PATHS=[(]' '^[)]')
SKILL_PATHS=$(extract_paths .claude/skills/review-pr/SKILL.md \
  'Any path matches [*][*]security . process-launch surface[*][*]' \
  '^   - Branch has')
RULES_PATHS=$(extract_paths .claude/rules/hooks.md \
  'The surface is `UP_PATHS` in the hook' \
  'written out FOUR times')
AGENT_PATHS=$(extract_paths .claude/agents/pr-code-reviewer.md \
  'Pay extra attention to the security surface')

# Every quoted entry in the array must be one the extractor actually sees.
# `grep -oE 'src/[A-Za-z0-9_./-]+\.ts'` drops an entry containing anything
# outside that class, and a dropped entry is invisible to EVERY assertion below
# -- not existence-checked, not behaviour-tested, free to differ across the
# copies. Counting the quoted lines independently is what notices.
n_hook=$(printf '%s\n' "$HOOK_PATHS" | grep -c . || true)
n_decl=$(sed -n '\%^UP_PATHS=[(]%,\%^[)]%p' "$REPO_ROOT/.claude/hooks/pr-review-gate.sh" \
  | grep -c "^  '" || true)
if [ "$n_hook" -eq "$n_decl" ] && [ "$n_hook" -ge 7 ]; then
  check "every UP_PATHS entry is extractable ($n_hook)" 0
else
  check "every UP_PATHS entry is extractable" 1 "extracted $n_hook of $n_decl declared"
fi

# Duplicates in the hook's own region would make every copy comparison ambiguous.
dupes=$(printf '%s\n' "$HOOK_PATHS" | sort | uniq -d | tr '\n' ' ')
if [ -z "${dupes// /}" ]; then
  check "UP_PATHS has no duplicate entries" 0
else
  check "UP_PATHS has no duplicate entries" 1 "$dupes"
fi

# Every listed path must resolve to a real file: a rename that leaves the list
# behind removes the up-bias without removing the appearance of one.
missing=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  [ -f "$REPO_ROOT/$p" ] || missing="$missing $p"
done <<<"$HOOK_PATHS"
if [ -z "$missing" ]; then
  check "every UP_PATHS entry resolves to a real file" 0
else
  check "every UP_PATHS entry resolves to a real file" 1 "missing:$missing"
fi

# The three prose copies must carry exactly the hook's set.
# Same paths, same order, no extras. See extract_paths on why order matters.
compare_copy() {
  local name="$1" got="$2" diff_out
  diff_out=$(diff <(printf '%s\n' "$HOOK_PATHS") <(printf '%s\n' "$got") || true)
  if [ -z "$diff_out" ]; then
    check "$name matches UP_PATHS" 0
  else
    check "$name matches UP_PATHS" 1 "$(printf '%s' "$diff_out" | tr '\n' ' ')"
  fi
}
compare_copy ".claude/skills/review-pr/SKILL.md"    "$SKILL_PATHS"
compare_copy ".claude/rules/hooks.md"               "$RULES_PATHS"
compare_copy ".claude/agents/pr-code-reviewer.md"   "$AGENT_PATHS"

# Behavior, not just bookkeeping: each listed path must actually bump the tier.
# loc=100 / fc=1 is `inline` (pass-through) on size alone, so a block proves the
# up-bias fired. The control below pins that the size floor is what it is.
while IFS= read -r p; do
  [ -n "$p" ] || continue
  run_case "up-bias: $p blocks at inline size" 2 100 "$p"
done <<<"$HOOK_PATHS"
run_case "control: unlisted src file stays inline (pass)" 0 100 src/local/route-discovery.ts

printf '\npass: %d  fail: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
