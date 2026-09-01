#!/usr/bin/env bash
# post-merge-orphan-push-gate.sh
#
# PreToolUse hook. Blocks `git push <remote> <branch>` (also `git push -u`,
# `git push --set-upstream`, `git -C <path> push ...`) when the target
# branch is the head ref of an already-MERGED PR on origin. This closes
# the structural gap:
#
#   1. `gh pr merge` lands the PR.
#   2. GitHub's `delete_branch_on_merge: true` deletes the source branch.
#   3. A follow-up `git push` to the same branch name SUCCEEDS — it just
#      re-creates the deleted branch as a fresh orphan ref no PR is
#      tracking. The change never reaches main and the assistant has no
#      signal anything is wrong.
#
# This hook detects step 3 and refuses the push, telling the user how to
# replay the orphan commits on a fresh branch off `main`.
#
# Scope guard — fires ONLY when ALL of the following hold:
#   - target remote is `origin` (the only GitHub remote we know how to
#     check; other remotes pass through)
#   - `gh pr list --head <branch> --state merged` returns a PR whose
#     `headRefName` matches `<branch>` exactly (defensive against
#     unexpected GitHub-side matching behavior)
#   - the PR's state is MERGED (not CLOSED-not-merged — a closed PR
#     might be reopened or its branch revived, both legitimate)
#
# When `gh` is not installed or not authenticated, we pass through with a
# stderr debug warning — failing closed would block every push on a fresh
# machine. The gate is defense-in-depth, not the load-bearing safety.

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
if ! declare -F gate_matches >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_matches is undefined (truncated file?)." >&2
  exit 2
fi


# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd. Reading via two separate jq invocations would consume stdin
# twice and the second read would see nothing.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `git push`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored.
gate_matches "$cmd" "$GATE_RE_GIT_PUSH" || exit 0

# Where the gated command will actually run: a `-C <path>` inside the MATCHED
# segment wins, else the last `cd <path>` segment before it, else the hook
# payload's cwd (see gate_target_dir in _command-match.sh).
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GIT_PUSH")

# Parse `git push [...] <remote> <branch>` out of ONE MATCHED SEGMENT. The
# arguments come from `gate_verb_args`, which strips exactly the text the verb
# ERE matched -- `git <every leading flag> push` -- off the segment that matched
# it, so the gate can no longer trigger one way and parse another.
#
# It used to read them off the WHOLE COMMAND, with
# `[[ "$cmd" =~ [[:space:]]push([[:space:]]+(.*))?$ ]]`. `=~` is POSIX
# leftmost-longest, so that finds the FIRST ` push` anywhere in the text and
# takes everything after it -- and the separator strips below then cut at the
# first `&&` / `;` / `|`. Two ordinary shapes fall out of that, both measured by
# running the parse standalone, and both are LIVE BYPASSES rather than cosmetic:
#
#   git push origin feat/merged                              -> origin feat/merged
#   echo "remember to push origin main" && git push origin feat/merged
#                                                            -> origin  main"
#   git push origin main && git push origin feat/merged      -> origin  main
#
# In the second a quoted MENTION of push steers the branch to `main"`; in the
# third the chain is judged on the FIRST push. Either way
# `gh pr list --head <wrong branch>` finds no merged PR, the gate exits 0, and
# the orphan push -- commits that silently never reach main, the entire failure
# this hook exists to prevent -- proceeds unjudged. The same defect was
# reproduced in the sibling repo's copy of this gate, which is why it is fixed
# rather than filed.
#
# EVERY matching segment is judged, not the last one: `git push origin main &&
# git push origin feat/merged` contains two real pushes, and judging either one
# alone leaves the other in exactly the hole just closed. The walk stops at the
# first segment that blocks, so the common single-push command still makes at
# most one `gh` call.
#
# LIMIT, stated rather than hidden: `target_dir` is resolved ONCE, for the whole
# command, because `gate_target_dir` reports the FIRST matching segment's tree
# and the shared helper exposes no per-segment answer. FIRST, not last: the
# helper `break`s out of its segment walk as soon as a segment matches the verb
# ERE. Measured, not assumed --
#
#   gate_target_dir 'git -C /aaa push origin && git -C /bbb push origin' \
#                   /fallback "$GATE_RE_GIT_PUSH"          -> /aaa
#
# -- and the direction matters to a reader even though the BOUND does not: it is
# the EARLIEST push's tree that is in force for every segment, so the last
# `-C` in the command is precisely the one that is NOT consulted.
#
# Reconstructing a per-segment prefix to ask again was considered and rejected,
# but NOT for the reason once given here. That reason -- that re-splitting text
# which `gate_segments` has already segmented would let a NEWLINE inside a
# quoted argument (`gh pr create --body "...<newline>cd /evil"`) surface as a
# `cd` segment -- does not reproduce: `gate_segments` flattens a quoted newline
# to a SPACE, so `gh pr create --body "line1<newline>cd /evil" && git push
# origin feat/x` splits into exactly two segments, and re-splitting either of
# them returns that same segment unchanged. Re-splitting is idempotent and no
# `cd` segment appears.
#
# The obstacle that DOES exist is the `break` above. Handed a prefix that ends
# at segment N, `gate_target_dir` still answers for the first matching segment
# inside that prefix rather than for N, so the per-segment question cannot be
# asked at all without changing the shared helper -- which is a change to every
# gate that calls it, not to this one.
#
# The exposure is narrow either way: the positional branch is read from the
# segment itself, so `target_dir` only decides the `symbolic-ref` fallback for a
# push that OMITS the branch, and only when one command pushes from two
# different trees.

# Resolved lazily and memoised: a command whose remote is not `origin` must not
# print the "gh not installed" note, which is what hoisting this above the walk
# would do.
#
# BOTH ARMS are memoised, via `gh_probed` rather than via `gh_bin`. Keying the
# memo on `gh_bin` alone memoised only SUCCESS: on a machine without `gh`,
# `gh_bin` stays empty, so every gateable segment re-ran the lookup and re-printed
# the note, and `git push origin a && git push origin b && git push origin c`
# emitted it three times. The note is a debug aid for ONE decision -- "this gate
# could not check anything on this machine" -- so it is stated once per command.
gh_bin=""
gh_probed=0
resolve_gh() {
  if [ "$gh_probed" -eq 1 ]; then
    [ -n "$gh_bin" ] && return 0
    return 1
  fi
  gh_probed=1
  # $GH_BIN, when set and executable, wins — this is the mock injection point
  # for smoke tests. Otherwise look up on PATH. When gh is missing, pass through
  # with a stderr debug note rather than failing closed.
  if [ -n "${GH_BIN:-}" ] && [ -x "${GH_BIN}" ]; then
    gh_bin="${GH_BIN}"
  elif command -v gh >/dev/null 2>&1; then
    gh_bin="$(command -v gh)"
  else
    echo "post-merge-orphan-push-gate: gh not installed; skipping check." >&2
    return 1
  fi
  return 0
}

# parse_push_args <segment-args>
# Sets `remote` / `branch`. Returns 1 when this segment is not a gateable push.
#
# Only known flags are modelled — enough to land on the (remote, branch) pair
# for the common shapes; ambiguous / exotic forms fall through to the safe
# "pass through" branch.
parse_push_args() {
  local args="$1" tok next i
  # Trailing shell REDIRECTION (`>x`, `2>&1`) is the only chain noise that can
  # still be here. The `|`, `;` and `&&` strips this used to carry are gone:
  # `gate_segments` ends a segment AT those separators, so anything they could
  # have cut is no longer in `args` to begin with — and a `push` after one of
  # them is now its own segment with its own turn in the walk, which is the
  # whole point.
  # Pinned by "orphan-push: -u, redirected, on the merged branch": without this
  # strip `git push -u origin >/tmp/log` parses `>/tmp/log` as the positional
  # BRANCH, gh answers an empty list for it, and the gate exits 0 on a push to a
  # merged branch. (`git push origin feat/merged >/tmp/log` does NOT
  # discriminate -- the branch is already filled by then and the stray token is
  # dropped -- which is why the case omits the branch.)
  args="${args%%>*}"

  # Tokenise. Single-quoted args stay together by best effort; an exotic case
  # like `git push origin "feature/x y"` (literal space in a branch name) is
  # rare enough that we accept missing it — the gate degrades to pass-through
  # rather than mis-fire.
  # shellcheck disable=SC2206
  local tokens=($args)

  remote=""
  branch=""
  i=0
  while [ "$i" -lt "${#tokens[@]}" ]; do
    tok="${tokens[$i]}"
    case "$tok" in
      # Flags that take NO value — skip just this token.
      -u|--set-upstream|-f|--force|--force-with-lease|--force-if-includes|\
      -n|--dry-run|-v|--verbose|-q|--quiet|--all|--tags|--follow-tags|\
      --mirror|--prune|--delete|--atomic|--no-verify|--verify|--progress|\
      --no-progress|--ipv4|--ipv6|-4|-6|--thin|--no-thin|--signed|\
      --no-signed|--porcelain|--no-recurse-submodules)
        ;;
      # Flags that DO take a value — skip this token AND the next.
      # `--foo=bar` (single token, captured by *=*) — no extra skip.
      # `--foo bar` (two tokens) — skip the next token too.
      # `--recurse-submodules` has BOTH a flag-only form and a
      # `--recurse-submodules <mode>` form; we peek at the next token
      # before deciding to consume it.
      --repo|-o|--push-option|--receive-pack|--exec|--repo=*|\
      --push-option=*|-o=*|--receive-pack=*|--exec=*|--recurse-submodules|\
      --recurse-submodules=*)
        case "$tok" in
          *=*) ;;
          --recurse-submodules)
            next="${tokens[$((i + 1))]:-}"
            case "$next" in
              check|on-demand|only|no)
                i=$((i + 1))
                ;;
            esac
            ;;
          *)
            i=$((i + 1))
            ;;
        esac
        ;;
      # Any other --flag we don't know about — skip just this token, on
      # the assumption it's flag-only. False negatives (missing the gate
      # because of a flag we didn't model) are cheaper than blocking
      # legitimate pushes.
      -*) ;;
      # First positional → remote. Second positional → branch (refspec).
      *)
        if [ -z "$remote" ]; then
          remote="$tok"
        elif [ -z "$branch" ]; then
          branch="$tok"
        fi
        ;;
    esac
    i=$((i + 1))
  done

  # Default remote when omitted (e.g. `git push`).
  [ -n "$remote" ] || remote="origin"

  # The rule applies only to the GitHub origin remote — other remotes pass
  # through.
  [ "$remote" = "origin" ] || return 1

  # `git push origin :branch` is an explicit deletion request, not a content
  # push — let it through. Likewise `git push origin <sha>:<branch>`
  # (force-push from a specific sha) — we cannot safely reason about whether the
  # destination ref is the merged PR's old head without parsing refspecs, so we
  # pass through.
  #
  # `git push origin --delete branch` is NOT covered here and does NOT pass
  # through, contrary to what this comment used to claim: `--delete` sits in the
  # valueless-flag list above, so it is skipped and `branch` lands in `$branch`
  # as an ordinary positional, which then blocks like any content push. Left as
  # is deliberately. Deleting the merged branch again is a no-op on GitHub (the
  # merge already deleted it), so the false block costs nothing real, whereas
  # teaching the flag list to swallow its argument would hand every `--delete`
  # spelling a pass-through the `:branch` arm grants only after reading a
  # refspec. If it ever needs to pass, the fix is a `--delete`-specific arm
  # here, not a change to the flag list.
  case "$branch" in
    :*|*:*) return 1 ;;
  esac

  # When the branch was not specified positionally (e.g. `git push origin`
  # alone, or `git push -u origin` with no branch), derive the current branch
  # from the resolved target dir.
  if [ -z "$branch" ]; then
    # `</dev/null`: this runs inside a `while IFS= read -r` loop whose stdin IS
    # the `gate_segments` process substitution, so a callee that reads stdin
    # would consume segments the walk has not judged yet. `symbolic-ref` does
    # not read stdin today; the fence is here so that stays a property of the
    # CALL SITE rather than of the callee. No case can pin it -- the failure it
    # forecloses does not exist yet -- which is why it is stated here.
    branch=$(git -C "$target_dir" symbolic-ref --short HEAD </dev/null 2>/dev/null || echo "")
  fi

  # Still no branch (detached HEAD, non-git dir) — nothing to gate.
  [ -n "$branch" ] || return 1

  # Detached-HEAD-style refspecs like `HEAD` are not a static branch name the
  # user mistakenly re-pushed, so pass through.
  case "$branch" in
    HEAD|refs/*) return 1 ;;
  esac

  return 0
}

# judge_push
# 0 when the push must be BLOCKED (with `pr_number` / `pr_merged_at` /
# `pr_title` set for the message), 1 when it is allowed.
judge_push() {
  local pr_json
  resolve_gh || return 1

  # Query GitHub for any MERGED PR with this head ref. `--limit 1` because
  # branch names are unique per repo (a branch can only have ever been the head
  # ref of one PR at a time; if multiple PRs ever shared the name, the
  # most-recently-merged one is the relevant one — that is the default ordering
  # anyway).
  #
  # `gh pr list` exits non-zero on auth failure / network error. We treat that
  # as "couldn't check" and pass through with a debug note — same fail-open
  # posture as the missing-gh branch.
  # `</dev/null` for the same reason as the `symbolic-ref` call above: the walk
  # that reaches here is reading `gate_segments` on stdin.
  pr_json=$("${gh_bin}" pr list --head "$branch" --state merged --limit 1 \
              --json number,mergedAt,headRefName,title </dev/null 2>/dev/null || true)

  if [ -z "$pr_json" ] || [ "$pr_json" = "null" ]; then
    echo "post-merge-orphan-push-gate: gh pr list failed or returned empty; skipping check." >&2
    return 1
  fi

  # jq across an empty array returns "null" for `.[0]` — safe to query scalar
  # fields directly with `// empty` as a defensive default.
  pr_number=$(printf '%s' "$pr_json" | jq -r '.[0].number // empty' 2>/dev/null || echo "")
  pr_head=$(printf '%s' "$pr_json" | jq -r '.[0].headRefName // empty' 2>/dev/null || echo "")
  pr_merged_at=$(printf '%s' "$pr_json" | jq -r '.[0].mergedAt // empty' 2>/dev/null || echo "")
  pr_title=$(printf '%s' "$pr_json" | jq -r '.[0].title // empty' 2>/dev/null || echo "")

  # No PR matching this branch → nothing to gate.
  [ -n "$pr_number" ] || return 1

  # Defensive: the API returned a PR but its head ref does not match the branch
  # we asked about. Could happen if `--head` matches loosely on a future
  # GitHub-side change. Pass through rather than mis-fire.
  [ "$pr_head" = "$branch" ] || return 1

  return 0
}

remote=""
branch=""
pr_number=""
pr_head=""
pr_merged_at=""
pr_title=""
blocked=0
while IFS= read -r seg_args; do
  parse_push_args "$seg_args" || continue
  if judge_push; then
    blocked=1
    break
  fi
done < <(gate_verb_args "$cmd" "$GATE_RE_GIT_PUSH")

[ "$blocked" -eq 1 ] || exit 0

# Block the push.
cat >&2 <<EOF
Blocked by post-merge-orphan-push-gate: branch '$branch' is the head ref
of MERGED PR #$pr_number (merged $pr_merged_at).

  PR title: $pr_title

GitHub's \`delete_branch_on_merge: true\` cleared the upstream branch
after merge; pushing now creates a fresh orphan ref no PR is tracking,
so the commits never reach main.

If the change should land on main:
  1. git switch main && git pull
  2. git switch -c <new-branch-off-main>
  3. cherry-pick or replay the commits from '$branch'
  4. push the new branch + open a new PR

If you genuinely want to re-create the deleted branch as an orphan ref
(rare — \`--no-verify\` is for git commit, not git push), push under a
different branch name and open a new PR for it, or temporarily disable
this hook in .claude/settings.json.
EOF
exit 2
