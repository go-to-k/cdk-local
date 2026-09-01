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
# Gate scope. The arguments are read by a TOKEN WALK, so a leading FLAG is never
# mistaken for the branch name and a trailing pathspec is never mistaken for a
# switch -- see verdict_for's header for the five shapes the earlier
# "token 1 and token 2" reading got wrong, each settled against real git.
#   - Block: `git switch <not-main>`, `git switch -c|-C|--create|--force-create
#     <branch>`, `git switch --orphan <branch>`, `git switch -`,
#     `git switch --detach`, `git checkout -b|-B|--orphan <branch>`,
#     `git checkout -t|--track <remote-ref>`, `git checkout -`, and
#     `git checkout <not-main>` when `<not-main>` is the ONLY positional AND
#     names either a LOCAL branch or a branch on some REMOTE (git DWIMs the
#     second into a create + switch).
#   - Pass: `git switch main` / `master`, `git checkout main` / `master`,
#     `git checkout [<tree-ish>] -- <pathspec>` and `git checkout <tree-ish>
#     <pathspec>` (file restores -- measured, HEAD stays put),
#     `git checkout <sha>` (detached HEAD), `git checkout HEAD`, `--help`,
#     `git worktree add ...` (the sanctioned path), and everything in a LINKED
#     worktree, which is where the convention wants feature branches.
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
  || ! declare -F gate_verb_args_dir >/dev/null 2>&1 \
  || ! declare -F gate_unquote >/dev/null 2>&1 \
  || ! declare -F gate_tokens >/dev/null 2>&1 \
  || [ -z "${GATE_EMBEDDING_TOKEN:-}" ]; then
  # `gate_verb_args_dir` is named too, not only `gate_matches`: it feeds the
  # segment loop through a process substitution, so a library that predates it
  # yields NO lines, the loop body never runs, and the gate exits 0 -- a silent
  # bypass with no error anywhere. That is precisely what this fail-closed
  # check exists to stop.
  #
  # `GATE_EMBEDDING_TOKEN` is a CONSTANT, not a function, and it is named here
  # because the shared `gate_tokens` interpolates it into the `[[ =~ ]]` that splits
  # the argument text. A library predating it leaves the pattern EMPTY, the match
  # then succeeds on any input with `${BASH_REMATCH[1]}` empty, and the token
  # walk yields nothing -- so every command would look like a bare
  # `git checkout` and pass. `declare -F` cannot see that; only this can.
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_matches / gate_verb_args_dir / gate_unquote / gate_tokens / GATE_EMBEDDING_TOKEN is undefined (truncated or stale file?)." >&2
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
# 0 = this segment must be BLOCKED (with `target_branch` / `block_reason` set),
# 1 = allowed. <args> is everything after the matched verb, flags included,
# because the verb ERE already consumed the leading `git -C … ` flag run.
#
#   `git switch <main|master>`             -> allow
#   `git checkout <main|master>`           -> allow
#   `git switch -c|-C|--create|--force-create <branch>` -> block
#   `git switch|checkout --orphan <branch>`             -> block
#   `git switch <other-branch>`            -> block
#   `git switch|checkout -` / `@{-1}`      -> block (previous branch, unknowable)
#   `git switch --detach`                  -> block
#   `git checkout -b|-B <branch>`          -> block
#   `git switch|checkout -t|--track <remote-ref>` -> block (DWIM create + switch)
#   `git checkout <other-branch>`          -> block when it is the ONLY
#                                            positional AND names a LOCAL branch
#                                            or a branch on some REMOTE
#   `git checkout [<tree-ish>] -- <paths>` -> allow (file restore)
#   `git checkout <tree-ish> <paths>`      -> allow (file restore, no `--`)
#   `git checkout -p|--ours|--theirs …`    -> allow (restore modes)
#   `git checkout <sha>` / `HEAD`          -> allow (detached HEAD / a rev)
#   `git switch|checkout --help`           -> allow
#
# A REAL OPTION PARSE, not "read token 1 and token 2", and not a token walk that
# only knows the SPACED spelling of a flag. The option grammar comes from
# `git checkout -h` / `git switch -h` (git 2.53.0) rather than from memory:
#
#   value-taking, BOTH verbs   --conflict <style>
#   value-taking, checkout     -b -B <branch>, -U/--unified <n>,
#                              --inter-hunk-context <n>,
#                              --pathspec-from-file <file>
#   value-taking, switch       -c -C / --create --force-create <branch>
#   value-taking, both         --orphan <new-branch>
#   OPTIONAL value             -t/--track[=(direct|inherit)],
#                              --recurse-submodules[=<checkout>]
#                              -- the SPACED form does NOT consume the next token
#   restore modes, checkout    -p/--patch, -2/--ours, -3/--theirs
#
# Every wanted verdict below was settled against real git first, printing HEAD
# and the local branch list before and after the command. The defects this
# replaces, in the order they were found:
#
#   git checkout <branch> -- <paths>   was BLOCKED, and must not be: it restores
#     FILES and leaves HEAD alone. Measured -- HEAD stayed `main`, f.txt took the
#     other branch's content. `git checkout <branch> <paths>` without the `--`
#     behaves identically ("Updated 1 path from …"), which is why the rule is
#     "two or more positionals is a restore" rather than "a `--` was seen".
#     go-to-k/cdk-real-drift MANDATES the `--` spelling for its integration step,
#     so the old reading refused a sibling repo's own documented flow.
#
#   git checkout -f <branch>           was ALLOWED, and must not be: `-f` was
#     read AS the branch name, `refs/heads/-f` does not resolve, and the gate
#     passed. Measured -- "Switched to branch 'feat'". ANY flag before the branch
#     did this.
#
#   git checkout --orphan <branch>     was ALLOWED: `--orphan` was read as the
#     branch name. Measured -- "Switched to a new branch 'wt-new'".
#
#   git checkout <name> / -t origin/<name>
#     were ALLOWED. With no LOCAL `<name>` but a remote carrying it, both CREATE
#     the local branch and switch -- measured on a real clone, HEAD went
#     `main` -> `feat`, git printing "Switched to a new branch". That is how a
#     lane's branch usually FIRST appears in a checkout, so a local-only
#     `show-ref` was blind to the commonest spelling of what this gate guards.
#
#   git checkout -  /  git checkout @{-1}   were ALLOWED while `git switch -`
#     blocked. Measured -- both print "Switched to branch 'other'" and move HEAD.
#     `@{-1}` was allowed under `checkout` only; `switch` blocked it by falling
#     through its catch-all, i.e. by accident rather than by rule.
#
#   GLUED flag spellings were ALL invisible: `-bfeat`, `-Bfeat`, `-cfeat`,
#     `-Cfeat`, `--create=feat`, `--force-create=feat`, `--orphan=feat`. Each was
#     measured creating the branch and switching to it. A short flag is now
#     parsed as a CLUSTER (`-qbfeat` = `-q -b feat`), so the glued and spaced
#     spellings cannot diverge again, and a long flag is split on its first `=`.
#
#   git checkout --conflict merge <branch>   was ALLOWED: a positional COUNT is
#     not a parse. `merge` inflated the count to 2 and the command was read as a
#     restore. Measured -- it switches. Value-taking flags now CONSUME their
#     argument, from the list above, so the count is a count of true positionals.
#
#   git checkout HEAD                  is a FALSE BLOCK waiting to happen, and it
#     is closed here rather than shipped: the DWIM list comes from `refs/remotes/`
#     and every clone carries the SYMBOLIC `refs/remotes/origin/HEAD`, which
#     `lstrip=3` renders as the bare word `HEAD`. Measured -- `git checkout HEAD`
#     prints "Your branch is up to date" and creates nothing.
#
#   git checkout -p <branch> / --ours / --theirs   would be FALSE BLOCKS for the
#     same reason as the `<branch> -- <paths>` restore. Measured -- `-p` prints a
#     diff and leaves HEAD on `main`; `--ours` / `--theirs` print "Updated 0
#     paths from the index".
#
# `--detach` stays asymmetric between the verbs: `git switch --detach` blocks
# while `git checkout <sha>` / `git checkout --detach <sha>` passes. That is the
# behaviour this gate shipped with, kept rather than silently changed here --
# but the rationale it shipped with, "the sha form is read-only inspection", is
# FALSE and is not repeated. `git checkout <sha>` REWRITES the shared working
# tree and leaves a detached HEAD, and the detached HEAD then disarms the
# sibling gate: `branch-gate.sh` reads
# `git -C <dir> symbolic-ref --short HEAD`, which is EMPTY while detached, and
# falls through to its `exit 0`. Measured in a throwaway repo carrying a
# `.markgate.yml`, driving branch-gate with `git commit -m x`: rc=2 on `main`,
# rc=0 once detached. So allowing the sha form leaves a two-step path to an
# ungated commit in the main checkout. Changing the verdict is a behaviour
# change with its own blast radius (it would refuse a legitimate inspection
# spelling in three repos) and belongs in its own PR, not smuggled into a parse
# fix -- recorded here and in .claude/rules/hooks.md so the next reader inherits
# the measurement rather than the old claim.
verdict_for() {
  local verb="$1" rest="$2" dir="$3"
  local tok pending="" create_val="" create_flag="" detach_flag=""
  local saw_help=0 saw_ddash=0 track_flag=0 restore_flag=0
  local npos=0 first_pos="" lname lval lhas letters ch
  target_branch=""
  block_reason=""
  while IFS= read -r tok; do
    tok=$(gate_unquote "$tok")
    if [ -n "$pending" ]; then
      # `value` is a branch name; `skip` is some other flag's argument, consumed
      # only so it cannot be miscounted as a positional.
      [ "$pending" = value ] && create_val="$tok"
      pending=""
      continue
    fi
    case "$tok" in
      # Everything after `--` is a pathspec, never a branch. Under `checkout`
      # the token BEFORE it is then a tree-ish to restore FROM, not a switch
      # target. Remembered rather than just broken out of, because the leading
      # positional has already been counted by the time we get here.
      --) saw_ddash=1; break ;;
      --*)
        # A long flag. Split on the FIRST `=`, so the glued and spaced spellings
        # of a value-taking flag reach the same arm. `--no-<x>` negations fall to
        # the catch-all and are valueless, which is what git does with them.
        case "$tok" in
          --*=*) lname="${tok%%=*}"; lval="${tok#*=}"; lhas=1 ;;
          *)     lname="$tok";       lval="";          lhas=0 ;;
        esac
        case "$lname" in
          --help) saw_help=1 ;;
          --create|--force-create)
            # `switch`'s create pair. `checkout` has no long create flag.
            if [ "$verb" = switch ]; then
              create_flag="$lname"
              if [ "$lhas" = 1 ]; then create_val="$lval"; else pending=value; fi
            fi
            ;;
          --orphan)
            create_flag="$lname"
            if [ "$lhas" = 1 ]; then create_val="$lval"; else pending=value; fi
            ;;
          --track)
            # OPTIONAL value (`--track=direct`), so the SPACED form must not
            # consume the next token -- that token is the remote start-point,
            # and the branch git creates is its last segment.
            track_flag=1
            ;;
          --detach)
            [ "$verb" = switch ] && detach_flag="$lname"
            ;;
          --patch|--ours|--theirs)
            [ "$verb" = checkout ] && restore_flag=1
            ;;
          --conflict|--pathspec-from-file|--unified|--inter-hunk-context)
            # Value-taking. Consume the argument when it is not glued, so it is
            # not counted as a positional and read as a restore's pathspec.
            [ "$lhas" = 0 ] && pending=skip
            ;;
          *) : ;;
        esac
        ;;
      -)
        # `git switch -` / `git checkout -` = the previous branch, which cannot
        # be known without running git. Counted as a positional and judged below.
        npos=$((npos + 1))
        [ "$npos" -eq 1 ] && first_pos="-"
        ;;
      -?*)
        # A SHORT flag CLUSTER: git's parse-options accepts `-qbfeat` as
        # `-q -b feat`, so the letters are walked one at a time and a
        # value-taking letter takes the REST of the token as its value, or the
        # next token when nothing is left. Parsing only the whole token missed
        # every glued spelling -- `-bfeat`, `-Bfeat`, `-cfeat`, `-Cfeat` -- each
        # measured creating the branch and switching to it.
        letters="${tok#-}"
        while [ -n "$letters" ]; do
          ch="${letters%"${letters#?}"}"
          letters="${letters#?}"
          case "$ch" in
            h) saw_help=1 ;;
            b|B)
              if [ "$verb" = checkout ]; then
                create_flag="-$ch"
                if [ -n "$letters" ]; then create_val="$letters"; letters=""
                else pending=value; fi
              else
                letters=""
              fi
              ;;
            c|C)
              if [ "$verb" = switch ]; then
                create_flag="-$ch"
                if [ -n "$letters" ]; then create_val="$letters"; letters=""
                else pending=value; fi
              else
                # `-c` after `checkout` is not an option at all; the leading
                # `git -c <k>=<v>` run was consumed by the verb ERE.
                letters=""
              fi
              ;;
            t) track_flag=1 ;;
            d) [ "$verb" = switch ] && detach_flag="-d" ;;
            p|2|3) [ "$verb" = checkout ] && restore_flag=1 ;;
            U)
              if [ "$verb" = checkout ]; then
                if [ -n "$letters" ]; then letters=""; else pending=skip; fi
              fi
              ;;
            q|l|m|f) : ;;
            *)
              # An unrecognised letter. Stop reading the cluster rather than
              # guess: a wrong guess about a VALUE is what the `--conflict merge`
              # defect was.
              letters=""
              ;;
          esac
        done
        ;;
      *)
        npos=$((npos + 1))
        [ "$npos" -eq 1 ] && first_pos="$tok"
        ;;
    esac
  done < <(gate_tokens "$rest")

  [ "$saw_help" -eq 1 ] && return 1
  if [ -n "$create_flag" ]; then
    target_branch="$create_val"
    block_reason="creates new feature branch '$target_branch'"
    return 0
  fi
  if [ "$track_flag" = 1 ]; then
    # `git checkout -t origin/feat` / `git switch --track origin/feat` CREATE a
    # local `feat` and switch to it -- measured, and the local branch appeared.
    # The name is the start-point's LAST segment, so `origin/topic/x` yields `x`.
    target_branch="${first_pos##*/}"
    block_reason="creates new feature branch '$target_branch'"
    return 0
  fi
  if [ -n "$detach_flag" ]; then
    # Detaching HEAD moves the SHARED tree off `main` exactly as a branch switch
    # does, so the verdict is unchanged; only the wording is, since there is no
    # branch to name.
    target_branch=""
    block_reason="detaches HEAD in the main tree (\`git switch $detach_flag\`)"
    return 0
  fi

  case "$verb" in
    switch)
      case "$first_pos" in
        main|master) return 1 ;;
        -|@{-*)
          # The pattern is the PREFIX `@{-`, without the closing brace, and that
          # is measured rather than sloppy: `gate_segments` TRUNCATES a segment
          # at a `}`, so the shared walk hands this gate `git checkout @{-1`
          # (brace gone) for an input of `git checkout @{-1}`. A pattern
          # requiring the `}` matched nothing and the shape stayed fail-open.
          target_branch="$first_pos"
          block_reason="switches to the previous branch (\`git switch $first_pos\`); resolved branch unknown -- block conservatively"
          return 0
          ;;
        "")
          # A bare `git switch` with no branch and no create flag. It is a git
          # error, but block conservatively rather than reason about a shape
          # nothing legitimate produces.
          target_branch=""
          block_reason="runs \`git switch\` in the main tree with no resolvable target -- block conservatively"
          return 0
          ;;
        *)
          target_branch="$first_pos"
          block_reason="switches to feature branch '$first_pos'"
          return 0
          ;;
      esac
      ;;
    checkout)
      # `-p` / `--ours` / `--theirs` are RESTORE modes: measured, `-p <branch>`
      # prints a diff and leaves HEAD on `main`, and `--ours` / `--theirs` print
      # "Updated 0 paths from the index". Blocking them would be a false block of
      # the same family as the `<branch> -- <paths>` one.
      [ "$restore_flag" = 1 ] && return 1
      # A `--` makes everything after it a pathspec and the leading positional a
      # tree-ish to restore FROM: a file restore, whatever it names.
      [ "$saw_ddash" -eq 1 ] && return 1
      # No positional: a bare `git checkout` is a NOP or a restore depending on
      # the git version. TWO OR MORE: `<tree-ish> <paths...>`, the same restore
      # without the `--`. The count is of TRUE positionals -- every value-taking
      # flag above consumed its own argument first.
      [ "$npos" -ne 1 ] && return 1
      case "$first_pos" in
        main|master) return 1 ;;
        -|@{-*)
          # Measured: both print "Switched to branch 'other'" and move HEAD. They
          # were ALLOWED here while the identical `git switch -` blocked.
          target_branch="$first_pos"
          block_reason="switches to the previous branch (\`git checkout $first_pos\`); resolved branch unknown -- block conservatively"
          return 0
          ;;
        *)
          # A branch name or a sha. A name resolving to a LOCAL branch is a
          # branch switch; so is one that resolves only on a REMOTE (the DWIM
          # arm below). A sha or a pathspec passes. Both questions are asked of
          # the SEGMENT's own tree, since that is where the command would run.
          if git -C "$dir" show-ref --verify --quiet "refs/heads/$first_pos" 2>/dev/null; then
            target_branch="$first_pos"
            block_reason="switches to feature branch '$first_pos'"
            return 0
          fi
          # DWIM. With no LOCAL `<name>` but a remote carrying it,
          # `git checkout <name>` CREATES the local branch and switches to it.
          #
          # The pattern is the PREFIX `refs/remotes/`, NOT `refs/remotes/*/*`. A
          # `*` does not cross a `/` in for-each-ref, so the two-star form lists
          # `origin/feat` and MISSES `origin/topic/nested` -- measured on a real
          # clone, where `--format='%(refname:lstrip=3)' 'refs/remotes/*/*'`
          # printed `HEAD feat main` while the prefix form printed
          # `HEAD feat main topic/nested`, and git DWIMs the nested name just the
          # same ("Switched to a new branch 'topic/nested'"). Slashed names are
          # most of them in this flow, so the two-star form is fail-open here.
          #
          # `HEAD` is EXCLUDED, and that is measured rather than defensive: the
          # list comes from `refs/remotes/`, which holds the SYMBOLIC
          # `refs/remotes/origin/HEAD` in essentially every clone -- `lstrip=3`
          # renders it as the bare word `HEAD`, and both cdkd and cdk-local carry
          # it. But `git checkout HEAD` resolves HEAD as a rev and creates
          # nothing -- measured, "Your branch is up to date", HEAD stayed `main`
          # -- so matching it would refuse a read-only command in the main tree.
          # A branch cannot be NAMED `HEAD` (`git branch HEAD` is fatal), so
          # nothing real is lost. `grep -qxF` is an exact whole-LINE match, so a
          # name that is merely a SUBSTRING of a remote branch does not
          # false-block either.
          if [ "$first_pos" != HEAD ] \
            && git -C "$dir" for-each-ref --format='%(refname:lstrip=3)' 'refs/remotes/' 2>/dev/null \
              | grep -qxF -- "$first_pos"; then
            target_branch="$first_pos"
            block_reason="creates a local branch tracking remote '$first_pos' and switches to it"
            return 0
          fi
          return 1
          ;;
      esac
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
