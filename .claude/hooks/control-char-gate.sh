#!/usr/bin/env bash
# control-char-gate.sh
#
# PreToolUse hook. Blocks `git commit` when a text file the commit will contain
# has a NUL (\x00) or any other C0 control byte other than tab (\x09), newline
# (\x0A), or carriage return (\x0D).
#
# WHY: an editing artifact can land a raw control byte inside a source file
# (e.g. a template-literal separator that was meant to be a space ending up
# as a literal \x00). The formatter / linter does not flag it, but it breaks
# `grep` (which then treats the file as binary and silently suppresses
# matches), `diff`, and anything that assumes clean text -- and it ships in
# the committed source. This gate catches it at commit time.
#
# WHAT IS SCANNED, and why it is decided from the COMMAND (go-to-k/cdk-local#576).
#
# The first version scanned the STAGED BLOB (`git show :<file>`) only. A
# PreToolUse hook runs BEFORE the command it gates, so a single Bash call of the
# shape `git add -A && git commit -F msg` presented the gate with the tree as it
# was BEFORE `git add` ran: nothing was staged for the offending file, the gate
# found nothing, and the control byte shipped. It happened -- two NUL bytes
# reached `src/local/front-door-server.ts` on main that way, in a file on the
# review-gate security surface, where `grep` had been silently answering nothing
# for every audit since.
#
# So the scan target is now read off the command:
#
#   plain `git commit`          the INDEX (`git show :<file>` over
#                               `diff --cached --diff-filter=ACM`). Unchanged.
#   ... `git add <spec>` ...    the index AS WELL AS the WORKING TREE content
#                               that the add would bring in.
#   `git commit -a` / `--all`   the index as well as the working-tree content of
#                               TRACKED MODIFIED files. `-a` does NOT pick up
#                               untracked files, and this does not either.
#
# The working-tree scan is deliberately a SUPERSET of what the commit will
# contain in the ambiguous cases: a false block costs one message and a re-run,
# a false pass is the bug above. Each branch that has to guess says which way it
# errs, in a comment beside it.
#
# The index scan is still done on top of the working-tree one rather than being
# replaced by it: a file staged EARLIER and unmodified since is in the commit
# but is not "modified" relative to the index, so `git ls-files --modified`
# never lists it.
#
# Files with binary/asset extensions (images, fonts, archives, etc.)
# legitimately contain control bytes and are skipped, on both scans.
#
# Cwd-aware via the shared `gate_target_dir`: resolves the working tree the
# commit will actually act on from the matched segment's `git -C <path>` > the
# last preceding `cd <path>` > the hook payload's `cwd` > its own $PWD. The
# `git add` segment gets the same resolution against its OWN `-C` / `cd`, so
# `cd /w/t && git add -A && git commit` and `git -C /w/t add -A && git -C /w/t
# commit` both land on /w/t.
#
# Fails open (exit 0) when git / perl are unavailable, or when neither scan
# finds any candidate file (a clean tree) -- a safety net must never wedge an
# otherwise-valid commit. It does NOT fail open on a shape it cannot parse;
# those widen the scan instead.
#
# Written to bash 3.2 (no `mapfile`, no `declare -A`): the shipped hook runs
# under whatever bash the user has, and on macOS `/bin/bash` is still 3.2, where
# `mapfile -d ''` was "command not found" and the gate exited 1 having scanned
# nothing at all.

set -u

# Shared, segment-aware command matching (go-to-k/cdk-local#541). Sourcing it
# gives this gate `gate_matches`, `gate_target_dir`, `gate_verb_args`, and the
# GATE_RE_* verb regexes every gate now spells the same way.
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
# `gate_verb_args` is what reads `git add`'s pathspecs off the matched segment.
# A library predating it would leave the staging scan silently absent -- exactly
# the false pass go-to-k/cdk-local#576 is about -- so it is checked by name
# rather than left to an unbound-command exit.
if ! declare -F gate_verb_args >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_verb_args is undefined (older copy?)." >&2
  exit 2
fi


input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `git commit`; anything else passes through.
# `gate_matches` splits the command into segments, so the verb is caught in ANY position — after a
# `git add -A &&`, after a `cd <wt>;`, inside a subshell, behind a leading
# `VAR=x` assignment — while a mention inside a quoted string or a heredoc body
# is still ignored.
gate_matches "$cmd" "$GATE_RE_GIT_COMMIT" || exit 0

# Need both git and perl to scan; without them, fail open.
command -v git >/dev/null 2>&1 || exit 0
command -v perl >/dev/null 2>&1 || exit 0

# Where the gated command will actually run: a `-C <path>` inside the MATCHED
# segment wins, else the last `cd <path>` segment before it, else the hook
# payload's cwd (see gate_target_dir in _command-match.sh).
commit_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GIT_COMMIT")

# ---------------------------------------------------------------------------
# Decide, FROM THE COMMAND, whether this call also stages -- and what.
# ---------------------------------------------------------------------------
# wt_scan        1 when a working-tree scan is needed at all
# wt_untracked   1 when it must include untracked files (`git add` does,
#                `git commit -a` does NOT)
# wt_all_paths   1 when the staging is not restricted to a pathspec
# wt_force       1 when `git add -f` may reach gitignored files
# wt_paths       the pathspecs, newline-separated (a pathspec containing a
#                newline is not expressible on a command line anyway)
wt_scan=0
wt_untracked=0
wt_all_paths=0
wt_force=0
wt_paths=""

# --- `git add` in the same call ------------------------------------------
while IFS= read -r add_args; do
  wt_scan=1
  seen_pathspec=0
  this_untracked=1   # a bare `git add <spec>` stages untracked files under it
  end_of_flags=0
  while [ -n "${add_args// /}" ] && [[ "$add_args" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; do
    tok="${BASH_REMATCH[1]}"
    add_args="${BASH_REMATCH[3]}"
    [ -n "$tok" ] || break
    if [ "$end_of_flags" -eq 0 ]; then
      case "$tok" in
        --) end_of_flags=1; continue ;;
        -A|--all|--no-ignore-removal) this_untracked=1; continue ;;
        # `-u` stages tracked modifications only. Recorded as such rather than
        # widened to untracked: `git add -u` genuinely cannot introduce an
        # untracked file, and a sibling `git add -A` in the same call sets the
        # flag for everyone anyway.
        -u|--update) this_untracked=0; continue ;;
        -f|--force) wt_force=1; continue ;;
        # Shapes whose staged set this gate cannot compute. ERRS BROAD: the
        # pathspec restriction is dropped and the whole tree is scanned.
        #   -p / -i   the human picks hunks / paths interactively
        #   --pathspec-from-file  the pathspecs are in a file, and reading it
        #                         here would be guessing at the shell's cwd
        -p|--patch|-i|--interactive|--pathspec-from-file|--pathspec-from-file=*)
          wt_all_paths=1; continue ;;
        # Every other `-…`. ERRS BROAD in the one way it can be wrong: `git
        # add`'s remaining flags are valueless, so treating an unknown one as
        # valueless is right; if a future flag does take a value, that value is
        # read as an extra pathspec, which only ever ADDS files to the scan.
        -*) continue ;;
      esac
    fi
    # A positional: a pathspec.
    tok=$(gate_unquote "$tok")
    # An UNEXPANDED path is not a path (`git add "$FILE"`). ERRS BROAD: rather
    # than scanning a literal `$FILE` that matches nothing, drop the restriction
    # and scan the whole tree.
    case "$tok" in *'$'*|*'`'*) wt_all_paths=1; seen_pathspec=1; continue ;; esac
    [ -n "$tok" ] || continue
    seen_pathspec=1
    wt_paths="$wt_paths$tok
"
  done
  [ "$this_untracked" -eq 1 ] && wt_untracked=1
  # `git add -A` / `git add -u` with no pathspec is the whole tree.
  [ "$seen_pathspec" -eq 0 ] && wt_all_paths=1
done < <(gate_verb_args "$cmd" "$GATE_RE_GIT_ADD")

# --- `git commit -a` / `--all` -------------------------------------------
# `-a` stages TRACKED MODIFICATIONS ONLY. It never picks up an untracked file,
# so this branch leaves wt_untracked alone; getting that wrong in either
# direction is a real defect, not a rounding error.
while IFS= read -r commit_args; do
  end_of_flags=0
  while [ -n "${commit_args// /}" ] && [[ "$commit_args" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; do
    tok="${BASH_REMATCH[1]}"
    commit_args="${BASH_REMATCH[3]}"
    [ -n "$tok" ] || break
    [ "$end_of_flags" -eq 1 ] && continue
    case "$tok" in
      --) end_of_flags=1 ;;
      # EXACT match only. `--amend`, `--allow-empty` and `--author` all start
      # with `--a` and none of them stages anything.
      --all) wt_scan=1; wt_all_paths=1 ;;
      --*) ;;
      -[A-Za-z]*)
        # A short-flag CLUSTER: `-am "msg"` is `-a -m msg`. Walk it left to
        # right and STOP at the first value-taking short flag, because what
        # follows is that flag's value, not more flags -- `-Fa` is `-F a`, a
        # message FILE named `a`, and reading its `a` as `--all` would be a
        # false widen.
        rest="${tok#-}"
        while [ -n "$rest" ]; do
          ch="${rest%"${rest#?}"}"
          rest="${rest#?}"
          case "$ch" in
            a) wt_scan=1; wt_all_paths=1; break ;;
            m|C|c|F|S|u|t) break ;;
            *) ;;
          esac
        done
        ;;
      *) ;;
    esac
  done
done < <(gate_verb_args "$cmd" "$GATE_RE_GIT_COMMIT")

# ---------------------------------------------------------------------------
# Collect the files to scan.
# ---------------------------------------------------------------------------
# Two parallel arrays rather than one array of "dir:path" strings: a path may
# contain a colon.
scan_dir=()
scan_path=()

collect_index() {
  local dir="$1" f
  while IFS= read -r -d '' f; do
    [ -n "$f" ] || continue
    scan_dir[${#scan_dir[@]}]="$dir"
    scan_path[${#scan_path[@]}]="$f"
  done < <(
    git -C "$dir" diff --cached --name-only --diff-filter=ACM -z 2>/dev/null || true
  )
}

collect_worktree() {
  local dir="$1" root f
  root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
  # Not a repo (or git refused): nothing to add. The index scan handles the same
  # case the same way, and this is the pre-existing fail-open shape.
  [ -n "$root" ] || return 0
  # `--full-name` so the paths are relative to the repo root and can be read
  # back without depending on which subdirectory the add would have run in.
  local args=(ls-files -z --full-name --modified)
  [ "$wt_untracked" -eq 1 ] && args=("${args[@]}" --others)
  # `--exclude-standard` keeps gitignored files out. It is dropped ONLY when a
  # `git add -f` is bounded by a pathspec: `-f` really can stage an ignored
  # file, but an UNBOUNDED scan of every ignored path (node_modules, dist, the
  # build cache) would make the gate itself the slowest thing in the commit.
  # ERRS NARROW, knowingly, and only for `git add -f` with no pathspec.
  if [ "$wt_force" -eq 0 ] || [ "$wt_all_paths" -eq 1 ]; then
    args=("${args[@]}" --exclude-standard)
  fi
  if [ "$wt_all_paths" -eq 0 ] && [ -n "$wt_paths" ]; then
    args=("${args[@]}" --)
    while IFS= read -r f; do
      [ -n "$f" ] && args=("${args[@]}" "$f")
    done <<< "$wt_paths"
  fi
  while IFS= read -r -d '' f; do
    [ -n "$f" ] || continue
    scan_dir[${#scan_dir[@]}]="$root"
    scan_path[${#scan_path[@]}]="$f"
  done < <(git -C "$dir" "${args[@]}" 2>/dev/null || true)
}

collect_index "$commit_dir"

if [ "$wt_scan" -eq 1 ]; then
  # The `git add` may carry its OWN `-C` / follow its own `cd`, so it is
  # resolved against its own verb regex. Both directories are scanned when they
  # differ -- ERRS BROAD, and it is what covers `git -C /a add -A && git -C /b
  # commit` as well as the ordinary same-directory call.
  add_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GIT_ADD")
  collect_worktree "$commit_dir"
  [ -n "$add_dir" ] && [ "$add_dir" != "$commit_dir" ] && collect_worktree "$add_dir"
fi

[ ${#scan_path[@]} -eq 0 ] && exit 0

# Extensions whose blobs legitimately contain control bytes — never scanned.
binary_ext_re='\.(png|jpe?g|gif|webp|bmp|ico|icns|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|tar|jar|war|7z|rar|wasm|mp4|m4v|mov|webm|avi|mkv|mp3|wav|flac|ogg|bin|exe|dll|so|dylib|node|class|keystore|jks|p12|pfx)$'

# The C0 scan itself. Line-oriented (not `-0777`) so the reported line numbers
# are useful; a control byte never spans a line.
c0_lines() {
  LC_ALL=C perl -ne 'print "$.\n" if /[\x00-\x08\x0B\x0C\x0E-\x1F]/' 2>/dev/null \
    | head -3 | paste -sd, -
}

offenders=()
seen="
"
i=0
while [ "$i" -lt ${#scan_path[@]} ]; do
  d="${scan_dir[$i]}"
  f="${scan_path[$i]}"
  i=$((i + 1))
  [ -n "$f" ] || continue
  shopt -s nocasematch
  if [[ "$f" =~ $binary_ext_re ]]; then
    shopt -u nocasematch
    continue
  fi
  shopt -u nocasematch
  # Both scans can name the same file (staged AND modified since); report once.
  key="$d/$f"
  case "$seen" in
    *"
$key
"*) continue ;;
  esac
  seen="$seen$key
"
  lines=""
  if [ -f "$d/$f" ] && [ ! -L "$d/$f" ]; then
    # The WORKING-TREE content: this is the half that plain `git show :<f>`
    # could not see before a `git add` had run. Symlinks are skipped -- git
    # stages the link TARGET PATH as the blob, not the pointee's bytes, so
    # following the link would scan a file the commit does not contain.
    lines=$(LC_ALL=C perl -ne 'print "$.\n" if /[\x00-\x08\x0B\x0C\x0E-\x1F]/' "$d/$f" 2>/dev/null | head -3 | paste -sd, -)
  fi
  if [ -z "$lines" ]; then
    # The STAGED blob. Scanned even when the worktree copy was clean: the two
    # can differ, and it is the staged side that gets committed.
    lines=$(git -C "$d" show ":$f" 2>/dev/null | c0_lines)
  fi
  if [ -n "$lines" ]; then
    offenders[${#offenders[@]}]="$f (line(s): $lines)"
  fi
done

if [ ${#offenders[@]} -gt 0 ]; then
  echo "Blocked by control-char-gate: file(s) this commit would contain have a NUL or other C0 control byte" >&2
  echo "(anything below 0x20 except tab / newline / carriage-return)." >&2
  echo "  resolved target dir: $commit_dir" >&2
  for o in "${offenders[@]}"; do
    echo "  - $o" >&2
  done
  echo "These are almost always an editing artifact (e.g. a separator that landed as a raw" >&2
  echo "NUL); they break grep / diff / tooling and must not ship in committed text. Open the" >&2
  echo "file(s) and remove the stray control character(s) before committing." >&2
  exit 2
fi

exit 0
