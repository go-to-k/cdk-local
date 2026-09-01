#!/usr/bin/env bash
# main-tree-branch-gate.sh
#
# PreToolUse hook. Blocks branch-switching commands in the MAIN
# worktree (= the repo top-level dir) so multiple agents working in
# parallel don't race / clobber each other on the shared main tree.
# The main worktree must stay on `main` / `master`; feature branches
# go to `.claude/worktrees/<branch>/`.
#
# WHY this gate: the main worktree is a SHARED RESOURCE across
# parallel agents. When agent A is mid-flight on a feature branch and
# agent B does `git switch <some-other-feature>`, A's uncommitted work
# either gets clobbered (if no stash) or gets silently stashed by B
# (if B was being defensive). The gate forces every feature-branch
# operation into its own `.claude/worktrees/<x>/` subtree where the
# contention doesn't exist.
#
# Resolution order for "where is the git command running":
#   1. `git -C <path>` in the matched segment — last `-C` wins.
#   2. The last `cd <path>` segment BEFORE the matched one.
#   3. The hook's `cwd` field.
#   4. $PWD.
#
# Gate scope:
#   - Block: `git switch <not-main>`, `git switch -c <branch>`,
#     `git checkout -b <branch>`, `git checkout <not-main>` (when
#     `<not-main>` is a local branch name).
#   - Pass: `git switch main`, `git switch master`, `git checkout
#     main`, `git checkout master`, every `git checkout <pathspec>`
#     (file restore), `git checkout <sha>` (detached HEAD), `git
#     worktree add ...` (the sanctioned path).
#
# Bypass: agents that legitimately need to operate in the main tree
# (e.g. release tooling, history surgery) can `cd <subdir>` first
# or explicitly `git -C <main-tree>` and override with the
# documented escape. The hook only fires when the target dir IS
# the main repo top-level.

set -u

# Shared, segment-aware command matching (go-to-k/cdk-local#541). Sourcing it
# gives this gate `gate_matches`, `gate_target_dir`, and the GATE_RE_* verb
# regexes every gate now spells the same way.
# Fail CLOSED if the shared matcher is missing or does not load: a gate that
# cannot decide must not wave the command through. `[ -r … ] || exit 0` was the
# first shape here, and it silently disabled the gate whenever the library was
# unreadable or truncated — with the sibling gates' own comments claiming the
# opposite (go-to-k/cdkd#2130 review). The `declare -F` check catches a partial
# source, where `.` succeeds but the function is missing.
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
if ! declare -F gate_matches >/dev/null 2>&1 \
  || ! declare -F gate_verb_args_dir >/dev/null 2>&1; then
  # `gate_verb_args_dir` is named too, not only `gate_matches`: it feeds the
  # segment loop through a process substitution, so a library that predates it
  # yields NO lines, the loop body never runs, and the gate exits 0 -- a silent
  # bypass with no error anywhere. That is precisely what this fail-closed
  # check exists to stop.
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_matches / gate_verb_args_dir is undefined (truncated or stale file?)." >&2
  exit 2
fi


input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `git switch` / `git checkout`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY
# position — after a `git fetch origin &&`, after a `cd <wt>;`, inside a
# subshell, behind a leading `VAR=x` assignment — while a mention inside a
# quoted string or a heredoc body is still ignored.
#
# The SEGMENT model has to carry the VERDICT too, not only the trigger. This
# gate used to parse the operation with an awk walker over the WHOLE command,
# which skipped to the FIRST `git` token and read the subcommand there. In a
# chained form that first `git` is a DIFFERENT command, so the walker read
# `sub=fetch`, fell to the `*)` "fail open to avoid false positives" arm, and
# exited 0 — a LIVE BYPASS of the very contention this gate exists to prevent,
# in the exact spelling this repo's `/work-issues` skill prints. Measured in the
# main checkout, on `main`:
#
#   git switch -c wt-probe origin/main                     -> rc=2  BLOCKED
#   git fetch origin && git switch -c wt-probe origin/main -> rc=0  PASS
#   git status && git checkout -b wt-probe                 -> rc=0  PASS
#
# The arguments now come from `gate_verb_args`, which strips exactly the text
# the verb ERE matched off the SEGMENT that matched it. That is the same
# constant which armed the gate, so it can no longer trigger one way and parse
# another — the property `gate_pr_selector` exists to give the `gh` gates.
# EVERY matching segment is judged rather than one: `git switch main && git
# switch -c feat` must block on its second half.

# Canonicalize a path before comparing. macOS resolves `/tmp` → `/private/tmp`
# and `/var` → `/private/var` via symlinks; `git worktree list --porcelain`
# always emits the real path, while the user's cwd may still carry the symlink.
# `cd <dir> && pwd -P` is the portable canonicalizer (BSD readlink lacks `-f`
# until 12+).
canonicalize() {
  local p="$1"
  if [[ -d "$p" ]]; then
    (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "${p%/}"
  else
    printf '%s' "${p%/}"
  fi
}

# main_tree_of <dir>
# Prints the MAIN worktree's path when <dir> IS that worktree and the repo opts
# in to the worktree convention; prints nothing and returns 1 otherwise. Called
# per matched segment, since `-C` / a preceding `cd` can put two segments of one
# command in two different trees.
#
# LIMIT, stated rather than hidden. `gate_segments` FLATTENS a subshell, so a
# `cd` inside one leaks past the closing paren and steers every later segment:
#
#   (cd <worktree> && git switch -c a) && git switch -c b
#
# resolves segment 3 to the worktree and PASSES. Measured from the real main
# checkout, rc=0 where 2 is wanted -- and measured the same against the hook
# BEFORE the per-segment change, so this is a pre-existing bound rather than one
# that change introduced. Closing it means teaching the shared segmenter to
# report subshell depth, which is a change to every gate that calls it, not to
# this one. The exposure is narrow in the other direction too: the false-BLOCK
# twin cannot happen, since a leaked `cd` can only ever make the gate quieter.
main_tree_of() {
  local dir="$1" main_tree
  # `git rev-parse --show-toplevel` returns the CURRENT worktree's top, which
  # differs between the main tree and any `.claude/worktrees/<x>/`. Cheaper
  # heuristic: the main worktree is whatever `git worktree list` lists first.
  # `substr($0, 10)` rather than `$2`: awk splits on whitespace, so a worktree
  # path containing a SPACE was truncated at it and the compare below then
  # never matched -- the gate stood down over a main tree it had mis-read. The
  # sibling repo's copy already read the whole field.
  main_tree=$(git -C "$dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')
  # Not in a git repo / cannot resolve — pass through (we do not gate what we
  # cannot see).
  [ -n "$main_tree" ] || return 1
  # Repo opt-in scope (cdkd#1259): only repos following the worktree + markgate
  # convention get main-tree branch protection. Unrelated repos (a personal
  # blog, a scratch clone) have no parallel-agent contention on their main tree.
  # Opt-in signal: a `.markgate.yml` at the main worktree root.
  [ -f "$main_tree/.markgate.yml" ] || return 1
  # Target is a linked worktree (`.claude/worktrees/<x>/` or similar) —
  # branch-switching there is exactly what the convention asks for.
  [ "$(canonicalize "$dir")" = "$(canonicalize "$main_tree")" ] || return 1
  printf '%s' "$main_tree"
}

# verdict_for <verb> <args> <dir>
# 0 = the segment must be BLOCKED (with `target_branch` / `block_reason` set),
# 1 = allowed. <args> is everything after the matched verb, flags included,
# because the verb ERE already consumed the leading `git -C … ` flag run.
#
#   `git switch <main|master>`         → allow
#   `git checkout <main|master>`       → allow
#   `git switch -c <branch>`           → block
#   `git switch <other-branch>`        → block
#   `git checkout -b <branch>`         → block
#   `git checkout <other-branch>`      → block (only when <other-branch> is a
#                                        local branch — file-path / sha
#                                        checkouts pass through)
#   `git checkout -- <pathspec>`       → allow (file restore)
#   `git checkout <sha>`               → allow (detached HEAD, rare in agent
#                                        workflows but legitimate)
verdict_for() {
  local verb="$1" rest="$2" dir="$3" first_token second_token
  first_token=$(printf '%s' "$rest" | awk '{print $1}')
  second_token=$(printf '%s' "$rest" | awk '{print $2}')
  target_branch=""
  block_reason=""
  case "$verb" in
    switch)
      # `git switch <name>` / `git switch -c <name>` / `git switch -C <name>`
      # (force-create), and the LONG forms of both. Reading only `-c` / `-C` got
      # the verdict right and the TEXT wrong: `git switch --create feat/x`
      # blocked while naming the branch `--create`, which is the name the
      # message then tells you to replay in a worktree.
      if [[ "$first_token" == "-c" || "$first_token" == "-C" \
         || "$first_token" == "--create" || "$first_token" == "--force-create" ]]; then
        target_branch="$second_token"
        block_reason="creates new feature branch '$target_branch'"
        return 0
      fi
      # `--detach` moves the SHARED tree off `main` exactly as a branch switch
      # does, so the verdict is unchanged; only the wording is, since there is
      # no branch to name.
      if [[ "$first_token" == "--detach" || "$first_token" == "-d" ]]; then
        target_branch=""
        block_reason="detaches HEAD in the main tree (\`git switch $first_token\`)"
        return 0
      fi
      target_branch="$first_token"
      if [[ "$target_branch" == "main" || "$target_branch" == "master" ]]; then
        return 1
      fi
      # `git switch -` (switch back to previous branch) — cannot be known
      # without running git. Conservatively block; agents should not be using
      # `git switch -` in the main tree anyway.
      if [[ "$target_branch" == "-" ]]; then
        block_reason="switches to previous branch (\`git switch -\`); resolved branch unknown — block conservatively"
      else
        block_reason="switches to feature branch '$target_branch'"
      fi
      return 0
      ;;
    checkout)
      # `git checkout <name>` / `git checkout -b <name>` / `git checkout --
      # <pathspec>` / `git checkout <sha>`.
      if [[ "$first_token" == "-b" || "$first_token" == "-B" ]]; then
        target_branch="$second_token"
        block_reason="creates new feature branch '$target_branch'"
        return 0
      fi
      # File restore — pass through.
      [[ "$first_token" == "--" ]] && return 1
      [[ "$first_token" == "main" || "$first_token" == "master" ]] && return 1
      # `git checkout` with no args — defaults to file restore in some versions,
      # a NOP in others. Pass through.
      [[ -z "$first_token" ]] && return 1
      # Could be a branch name or a sha. If it resolves to a local branch via
      # `git show-ref refs/heads/<name>`, treat as a branch switch (block).
      # Otherwise treat as sha / pathspec (pass).
      if git -C "$dir" show-ref --verify --quiet "refs/heads/$first_token" 2>/dev/null; then
        target_branch="$first_token"
        block_reason="switches to feature branch '$first_token'"
        return 0
      fi
      return 1
      ;;
  esac
  return 1
}

target_dir=""
main_tree=""
target_branch=""
block_reason=""
blocked=0
for gate_candidate in "$GATE_RE_GIT_SWITCH" "$GATE_RE_GIT_CHECKOUT"; do
  gate_matches "$cmd" "$gate_candidate" || continue
  if [ "$gate_candidate" = "$GATE_RE_GIT_SWITCH" ]; then
    verb="switch"
  else
    verb="checkout"
  fi
  # Where each matching SEGMENT runs, resolved by the SAME walk that yields its
  # arguments: a `-C <path>` inside THAT segment wins, else the `cd <path>`
  # segments before it, else the hook payload's cwd.
  #
  # Resolving it once per COMMAND -- `gate_target_dir`, whose walk stops at the
  # first matching segment -- made segment 1's tree decide every segment, and
  # got BOTH directions wrong. Measured against the real main checkout and the
  # real linked worktree, payload cwd = the main tree:
  #
  #   git -C <wt> switch -c a && git switch -c b       rc=0, want 2  BYPASS
  #   git -C <wt> checkout -b a && git checkout -b b   rc=0, want 2  BYPASS
  #   git switch main && git -C <wt> switch -c a       rc=2, want 0  FALSE BLOCK
  #
  # The first two are the `git fetch && git switch -c` bypass this branch closed
  # one commit earlier, one operator further along; the third refuses a branch
  # creation IN a linked worktree, which is what the convention mandates.
  # `main_tree_of` already said "called per matched segment" here -- it was not.
  while IFS= read -r seg_line; do
    # Split on the FIRST tab only. `IFS=$'\t' read -r dir args` would fold a TAB
    # RUN inside the args -- tab is IFS whitespace -- and drop one.
    seg_dir="${seg_line%%$'\t'*}"
    seg_args="${seg_line#*$'\t'}"
    seg_main=$(main_tree_of "$seg_dir") || continue
    if verdict_for "$verb" "$seg_args" "$seg_dir"; then
      target_dir="$seg_dir"
      main_tree="$seg_main"
      blocked=1
      break
    fi
  done < <(gate_verb_args_dir "$cmd" "${hook_cwd:-$PWD}" "$gate_candidate")
  [ "$blocked" -eq 1 ] && break
done

[ "$blocked" -eq 1 ] || exit 0

# Compose the block message.
branch_slug=$(printf '%s' "${target_branch:-feature-branch}" | tr -c 'a-zA-Z0-9._/-' '-')
cat >&2 <<EOF
Blocked by main-tree-branch-gate: target git working tree IS the main worktree, and the command $block_reason.

  resolved target dir: $target_dir
  command: $cmd

The main worktree at $main_tree is a SHARED RESOURCE across parallel agents. Feature branches must live in their own worktree so concurrent agents don't clobber each other's uncommitted work.

Correct invocation:

  git worktree add .claude/worktrees/${branch_slug} -b ${target_branch:-<branch>} origin/main
  cd .claude/worktrees/${branch_slug}
  # ... your work here ...

The main tree must stay on \`main\` (or \`master\`). When done with the feature worktree:

  git worktree remove .claude/worktrees/${branch_slug}

If you genuinely need to operate on a feature branch IN the main tree (release surgery, history rewrite, etc.), the escape is to confirm with the user explicitly first — there is no flag to bypass this hook silently.
EOF

exit 2
