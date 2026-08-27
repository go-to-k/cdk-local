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
# So each candidate file is collected with its PROVENANCE, and provenance
# decides which bytes are read:
#
#   INDEX candidate      the staged blob, `git show :<file>`, over
#                        `diff --cached --diff-filter=ACM`. Always collected.
#   WORKING-TREE cand.   the file on disk. Collected only when the command
#                        itself stages, and only for what that staging covers.
#
# An index candidate is NEVER read off disk and a working-tree candidate is
# NEVER read out of the index. That separation is what keeps a plain
# `git commit` an index-only verdict -- a dirty worktree it is not committing
# must not block it -- while `git add -A && git commit` sees the disk.
#
# Which commands stage, and what:
#
#   plain `git commit`                nothing. Index only.
#   `… git add|stage <spec> …`        what that add covers (untracked included).
#   `git commit -a` / `--all`         TRACKED MODIFICATIONS ONLY. `-a` does not
#                                     pick up untracked files, and neither does
#                                     this.
#   `git commit [-o|-i|--] <spec>`    a pathspec on `git commit` is an implicit
#                                     `--only`: it commits the WORKING-TREE
#                                     content of those paths and ignores the
#                                     index for them. Missing this was a
#                                     straight fail-open -- `git commit -m x
#                                     f.ts` shipped a NUL with the index clean.
#
# The index scan is still done ALONGSIDE the working-tree one rather than being
# replaced by it: a file staged EARLIER and unmodified since is in the commit
# but is not "modified" relative to the index, so `git ls-files --modified`
# never lists it. The one exception is a path that is ALREADY GONE from disk
# while the staging covers it: `git add -A` will stage that deletion, so the
# staged blob is on its way out of the tree. That is a fact about the TREE, not
# a reading of the command -- see "what this gate does NOT try to know" below.
#
# The working-tree scan is deliberately a SUPERSET of what the commit will
# contain in the ambiguous cases: a false block costs one message and a re-run,
# a false pass is the bug above. Each branch that has to guess says which way it
# errs, in a comment beside it.
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
# UNRESTRICTED STAGING IS SCANNED FROM THE REPO ROOT, not from that directory.
# `git ls-files` lists only what is under the CWD, while `git add -A` and
# `git commit -a` have been WHOLE-TREE since git 2.0 -- so running the scan in a
# subdirectory used to miss a control byte anywhere else in the repository, a
# fail-open of exactly the same class as the one above. A pathspec-RESTRICTED
# scan still runs in the command's own directory, because that is what its
# pathspecs are relative to.
#
# WHAT THIS GATE DOES NOT TRY TO KNOW: the ORDER of the segments, or that some
# other command in the same call will delete the file before the commit runs.
# A `rm bad.ts && git add -A && git commit` is therefore BLOCKED even though the
# resulting commit would not contain bad.ts, and the message says how to proceed
# (stage the deletion in its own call). An earlier revision parsed `rm` / `git
# rm` to avoid that one false block. It cost a FAIL-OPEN (`git add -A && git
# commit && rm x` passed, because order was not modelled), an abbreviation
# bypass (`git rm --ca`), and a 90-second hang. The trade is not close: this
# gate exists because a false PASS shipped a control byte to main, while a false
# BLOCK costs one message and a second call -- the same asymmetry every "ERRS
# BROAD" note below already argues for. So the parser is gone and the remedy
# lives in the error message instead.
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

# gate_cc_take_next -- drop the next token from the named argument string.
# Used where a flag's value is a SEPARATE token, so the value is never mistaken
# for a pathspec (`git commit -m x f.ts`: `x` is the message, `f.ts` is not).
gate_cc_take_next() {
  local _v="$1" _s
  # `${!_v}` to READ and `printf -v` to WRITE: neither ever hands the argument
  # text to `eval`, so a message body containing quotes, backticks or a `$(...)`
  # is data here and stays data.
  _s="${!_v}"
  if [[ "$_s" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; then
    printf -v "$_v" '%s' "${BASH_REMATCH[3]}"
  fi
}

# --- `git add` / `git stage` in the same call ----------------------------
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
        -p|--patch|-i|--interactive) wt_all_paths=1; continue ;;
        --pathspec-from-file) wt_all_paths=1; gate_cc_take_next add_args; continue ;;
        --pathspec-from-file=*) wt_all_paths=1; continue ;;
        # The flags `git add` accepts that take NO value. Enumerated rather than
        # inferred, so that the default below can be the safe one.
        -n|--dry-run|--no-dry-run|-v|--verbose|--no-verbose|-e|--edit|-N \
        |--intent-to-add|--sparse|--renormalize|--ignore-errors|--ignore-missing \
        |--refresh|--ignore-removal|--no-all|--no-warn-embedded-repo|--chmod=*)
          continue ;;
        # Any `--flag=value` carries its value inside the token.
        --*=*) continue ;;
        # An UNKNOWN flag. ERRS BROAD: it may take a separate value, and the
        # earlier "treat it as valueless" reading was a FAIL-OPEN, not a widen --
        # the value became a pathspec, which also set `seen_pathspec` and so
        # SUPPRESSED the whole-tree fallback. Measured: `git add --future-flag
        # somevalue && git commit -m x` returned 0 with an untracked NUL present.
        -*) wt_all_paths=1; continue ;;
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

# --- `git commit` itself: `-a`, and its PATHSPECS ------------------------
# `-a` stages TRACKED MODIFICATIONS ONLY. It never picks up an untracked file,
# so that branch leaves wt_untracked alone; getting it wrong in either direction
# is a real defect, not a rounding error.
#
# A POSITIONAL on `git commit` is an implicit `--only`: `git commit -m x f.ts`
# commits the WORKING-TREE content of f.ts and ignores the index for it. So the
# arguments have to be walked properly rather than skimmed for flags -- which
# means knowing which flags take a SEPARATE value, or `-m`'s message text would
# read as a pathspec and `f.ts` would never be seen.
while IFS= read -r commit_args; do
  end_of_flags=0
  seen_pathspec=0
  takes_paths=0
  while [ -n "${commit_args// /}" ] && [[ "$commit_args" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN(.*)$ ]]; do
    tok="${BASH_REMATCH[1]}"
    commit_args="${BASH_REMATCH[3]}"
    [ -n "$tok" ] || break
    if [ "$end_of_flags" -eq 0 ]; then
      case "$tok" in
        --) end_of_flags=1; continue ;;
        # EXACT match only. `--amend`, `--allow-empty` and `--author` all start
        # with `--a` and none of them stages anything.
        --all) wt_scan=1; wt_all_paths=1; continue ;;
        # These say "this commit takes pathspecs" without being one.
        --only|--include) takes_paths=1; continue ;;
        # ERRS BROAD, same reasoning as the add loop: the content is chosen
        # interactively / listed in a file, so it cannot be computed here.
        --patch|--interactive) wt_scan=1; wt_all_paths=1; continue ;;
        --pathspec-from-file) wt_scan=1; wt_all_paths=1; gate_cc_take_next commit_args; continue ;;
        --pathspec-from-file=*) wt_scan=1; wt_all_paths=1; continue ;;
        # Long flags whose value is a SEPARATE token. Skipping the value is what
        # stops `--author "A <a@b>"` from being read as a pathspec.
        --message|--file|--reuse-message|--reedit-message|--fixup|--squash \
        |--author|--date|--template|--cleanup|--trailer)
          gate_cc_take_next commit_args; continue ;;
        # `--flag=value` carries its value; every other long flag is valueless.
        --*) continue ;;
        -[A-Za-z]*)
          # A short-flag CLUSTER: `-am "msg"` is `-a -m msg`. Walk it left to
          # right, because a value-taking short flag ENDS the cluster -- what
          # follows is its value. `-Fa` is `-F a`, a message FILE named `a`, and
          # reading its `a` as `--all` would be a false widen.
          rest="${tok#-}"
          while [ -n "$rest" ]; do
            ch="${rest%"${rest#?}"}"
            rest="${rest#?}"
            case "$ch" in
              a) wt_scan=1; wt_all_paths=1 ;;
              o|i) takes_paths=1 ;;
              p) wt_scan=1; wt_all_paths=1 ;;
              # Value is the rest of the cluster, or -- if the cluster ends
              # here -- the NEXT TOKEN. Consuming it is what makes
              # `git commit -m x f.ts` see `f.ts` and not `x`.
              m|C|c|F|t)
                [ -z "$rest" ] && gate_cc_take_next commit_args
                rest="" ;;
              # `-S` / `-u` take an OPTIONAL value that git only accepts GLUED
              # (`-uall`, `-Skeyid`), never as a separate token. Ending the
              # cluster here stops `-uall`'s `a` from reading as `--all`.
              u|S) rest="" ;;
              *) ;;
            esac
          done
          continue ;;
        -*) continue ;;
      esac
    fi
    # A positional on `git commit`: an implicit `--only` pathspec, whose content
    # comes from the WORKING TREE.
    tok=$(gate_unquote "$tok")
    case "$tok" in *'$'*|*'`'*) wt_scan=1; wt_all_paths=1; seen_pathspec=1; continue ;; esac
    [ -n "$tok" ] || continue
    wt_scan=1
    seen_pathspec=1
    wt_paths="$wt_paths$tok
"
  done
  # `-o` / `-i` with no pathspec of its own. ERRS BROAD rather than guessing at
  # what it scopes to.
  if [ "$takes_paths" -eq 1 ] && [ "$seen_pathspec" -eq 0 ]; then
    wt_scan=1; wt_all_paths=1
  fi
done < <(gate_verb_args "$cmd" "$GATE_RE_GIT_COMMIT")

# A staging scan with nothing to scope it is a whole-tree scan; without this the
# `--`-less `-o` shapes would reach `ls-files --` with an empty pathspec list.
if [ "$wt_scan" -eq 1 ] && [ "$wt_all_paths" -eq 0 ] && [ -z "$wt_paths" ]; then
  wt_all_paths=1
fi

# ---------------------------------------------------------------------------
# Collect the candidate files, each with its provenance.
# ---------------------------------------------------------------------------
# Three parallel arrays rather than one array of joined strings: a path may
# contain any separator character one might pick.
scan_kind=()   # I = staged blob, W = working-tree file
scan_root=()   # repo root, so every path below is root-relative
scan_path=()
# The root-relative keys the WORKING-TREE scan covers, newline-delimited. Used
# to spot a path the staging is DELETING.
wt_keys="
"

# How many entries a `git add -f <pathspec>` listing may reach before the gate
# gives up on scanning gitignored content. See the --exclude-standard comment.
GATE_CC_FORCE_MAX=200

collect_worktree() {
  local dir="$1" root f run_in n
  root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
  # Not a repo (or git refused): nothing to add. The index scan handles the same
  # case the same way, and this is the pre-existing fail-open shape.
  [ -n "$root" ] || return 0

  # `--full-name` so paths come back relative to the repo ROOT and can be read
  # without depending on which subdirectory the command ran in.
  local base=(ls-files -z --full-name --modified)
  [ "$wt_untracked" -eq 1 ] && base=("${base[@]}" --others)

  # WHERE the listing runs is the difference between whole-tree and
  # subtree-only, because `git ls-files` lists what is under its CWD:
  #   unrestricted -> the repo ROOT, because `git add -A` / `git commit -a` are
  #                   whole-tree regardless of where they were typed.
  #   restricted   -> the command's OWN directory, because that is what its
  #                   pathspecs are relative to.
  local paths=()
  run_in="$root"
  if [ "$wt_all_paths" -eq 0 ] && [ -n "$wt_paths" ]; then
    run_in="$dir"
    paths=(--)
    while IFS= read -r f; do
      [ -n "$f" ] && paths=("${paths[@]}" "$f")
    done <<< "$wt_paths"
  fi

  # `--exclude-standard` keeps gitignored files out of the listing, and it is
  # kept unless dropping it is provably CHEAP.
  #
  # `git add -f` really can stage an ignored file, so the ignored content is in
  # scope in principle. In practice a pathspec like `.` or a directory drags in
  # the whole ignored tree: measured in this repo, `git add -f .` produced 4,001
  # candidates and the gate took 25 s (44,563 and >90 s in the reviewer's
  # worktree). A gate that wedges every commit is worse than the bug it
  # prevents. So the listing is PROBED first -- cheap, since `ls-files` walks
  # directories without reading file contents, and the probe stops as soon as it
  # passes the cap -- and the exclusion is only dropped when the result is small.
  #
  # ERRS NARROW, knowingly and boundedly: a `git add -f` whose pathspec covers
  # more than GATE_CC_FORCE_MAX entries has its IGNORED files unscanned. Its
  # tracked and untracked-but-unignored files are still scanned, because those
  # come from the listing that keeps --exclude-standard.
  local excl=(--exclude-standard)
  if [ "$wt_force" -eq 1 ] && [ "$wt_all_paths" -eq 0 ]; then
    n=0
    while IFS= read -r -d '' f; do
      n=$((n + 1))
      [ "$n" -gt "$GATE_CC_FORCE_MAX" ] && break
    done < <(git -C "$run_in" "${base[@]}" ${paths[@]+"${paths[@]}"} 2>/dev/null || true)
    [ "$n" -le "$GATE_CC_FORCE_MAX" ] && excl=()
  fi

  while IFS= read -r -d '' f; do
    [ -n "$f" ] || continue
    scan_kind[${#scan_kind[@]}]="W"
    scan_root[${#scan_root[@]}]="$root"
    scan_path[${#scan_path[@]}]="$f"
    wt_keys="$wt_keys$root/$f
"
  done < <(git -C "$run_in" "${base[@]}" ${excl[@]+"${excl[@]}"} ${paths[@]+"${paths[@]}"} 2>/dev/null || true)
}

collect_index() {
  local dir="$1" root f
  root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
  [ -n "$root" ] || return 0
  # Run from the ROOT so the names are root-relative and `git show :<path>` can
  # be read back from the same place. `git diff --cached` is not CWD-scoped, so
  # this changes the NAMES, never the SET.
  while IFS= read -r -d '' f; do
    [ -n "$f" ] || continue
    scan_kind[${#scan_kind[@]}]="I"
    scan_root[${#scan_root[@]}]="$root"
    scan_path[${#scan_path[@]}]="$f"
  done < <(
    git -C "$root" diff --cached --name-only --diff-filter=ACM -z 2>/dev/null || true
  )
}

# Worktree first, so `wt_keys` is complete before the index entries are filtered
# against it.
if [ "$wt_scan" -eq 1 ]; then
  # The `git add` may carry its OWN `-C` / follow its own `cd`, so it is
  # resolved against its own verb regex. Both directories are scanned when they
  # differ -- ERRS BROAD, and it is what covers `git -C /a add -A && git -C /b
  # commit` as well as the ordinary same-directory call.
  add_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GIT_ADD")
  collect_worktree "$commit_dir"
  [ -n "$add_dir" ] && [ "$add_dir" != "$commit_dir" ] && collect_worktree "$add_dir"
fi
collect_index "$commit_dir"

[ ${#scan_path[@]} -eq 0 ] && exit 0

# Extensions whose blobs legitimately contain control bytes — never scanned.
binary_ext_re='\.(png|jpe?g|gif|webp|bmp|ico|icns|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|tar|jar|war|7z|rar|wasm|mp4|m4v|mov|webm|avi|mkv|mp3|wav|flac|ogg|bin|exe|dll|so|dylib|node|class|keystore|jks|p12|pfx)$'

# The C0 scan itself.
#
# ONE perl process for ALL working-tree candidates, not one per file. The
# per-file fork was the other half of the `git add -f` slowness above: forks
# dominate when the candidate list is long, and the list is only bounded by the
# repository. Line-oriented (not `-0777`) so the reported line numbers stay
# useful; a control byte never spans a line, and each file stops after 3 hits.
#
# Reads NUL-delimited names on stdin and runs with the repo root as its cwd, so
# the names it prints back are the same root-relative ones used as keys here.
# `$/` is localised for the name list: leaving it as NUL would make the inner
# read see whole files as one "line" and every reported line number would be 1.
C0_BATCH_PL='
my @f;
{ local $/ = "\0"; while (my $x = <STDIN>) { chomp $x; push @f, $x if length $x; } }
for my $n (@f) {
  open(my $fh, "<", $n) or next;
  my $ln = 0; my @hit;
  while (my $l = <$fh>) {
    $ln++;
    if ($l =~ /[\x00-\x08\x0B\x0C\x0E-\x1F]/) { push @hit, $ln; last if @hit >= 3; }
  }
  close $fh;
  print $n, "\t", join(",", @hit), "\n" if @hit;
}
'
# The single-file form, for staged blobs (which arrive on stdin as content).
C0_RE='print "$.\n" if /[\x00-\x08\x0B\x0C\x0E-\x1F]/'

# Pass 1: filter and split the candidates by provenance. No file is read here.
w_root=(); w_rel=()
i_root=(); i_rel=()
seen_scan="
"
i=0
while [ "$i" -lt ${#scan_path[@]} ]; do
  kind="${scan_kind[$i]}"
  root="${scan_root[$i]}"
  f="${scan_path[$i]}"
  i=$((i + 1))
  [ -n "$f" ] || continue
  shopt -s nocasematch
  if [[ "$f" =~ $binary_ext_re ]]; then
    shopt -u nocasematch
    continue
  fi
  shopt -u nocasematch
  key="$root/$f"
  # Dedupe per (provenance, path), so a file that is BOTH a staged blob and a
  # working copy is read on both sides rather than only the first.
  #
  # HONESTLY: with the working-tree pass collected first, a path-only key is
  # behaviourally equivalent on every shape the suite could construct -- a
  # mutation to a path-only key stays green, and that is recorded rather than
  # papered over with an invented case. It is kept as (provenance, path) because
  # the equivalence rests entirely on that collection ORDER, which nothing else
  # here depends on; the pair key is free and does not.
  case "$seen_scan" in
    *"
$kind $key
"*) continue ;;
  esac
  seen_scan="$seen_scan$kind $key
"
  if [ "$kind" = "W" ]; then
    # WORKING-TREE content: the half a plain `git show :<f>` could not see
    # before the `git add` had run. A path listed here but MISSING from disk is
    # a DELETION being staged -- there is no content to scan, and nothing to
    # report. Symlinks are skipped too: git stages the link TARGET PATH as the
    # blob, not the pointee's bytes, so following the link would scan a file the
    # commit does not contain.
    if [ -f "$key" ] && [ ! -L "$key" ]; then
      w_root[${#w_root[@]}]="$root"
      w_rel[${#w_rel[@]}]="$f"
    fi
  else
    # STAGED blob, read ONLY out of the index -- never off disk, so a dirty
    # working copy cannot block a `git commit` that is not committing it.
    #
    # ...unless the path is already GONE from disk while the staging covers it
    # (it is a working-tree candidate): `git add -A` will stage that deletion,
    # so the blob is on its way out of the tree and blocking on it would refuse
    # a commit for a file that no longer exists. This is a fact about the tree,
    # not a reading of the command -- the gate does not model `rm` (see header).
    skip_removed=0
    case "$wt_keys" in
      *"
$key
"*) [ -e "$key" ] || skip_removed=1 ;;
    esac
    if [ "$skip_removed" -eq 0 ]; then
      i_root[${#i_root[@]}]="$root"
      i_rel[${#i_rel[@]}]="$f"
    fi
  fi
done

# Pass 2: read the bytes. Offenders are keyed by "<root>/<rel>" so one file is
# reported once however many provenances flagged it.
offenders=()
seen_offender="
"
record() {
  local root="$1" rel="$2" lines="$3" key="$1/$2"
  [ -n "$lines" ] || return 0
  case "$seen_offender" in
    *"
$key
"*) return 0 ;;
  esac
  seen_offender="$seen_offender$key
"
  offenders[${#offenders[@]}]="$rel (line(s): $lines)"
}

# Working-tree candidates: one perl per distinct root (at most two -- the
# commit's and the add's).
j=0
roots_done="
"
while [ "$j" -lt ${#w_rel[@]} ]; do
  root="${w_root[$j]}"
  j=$((j + 1))
  case "$roots_done" in
    *"
$root
"*) continue ;;
  esac
  roots_done="$roots_done$root
"
  while IFS=$'\t' read -r rel lines; do
    [ -n "$rel" ] && record "$root" "$rel" "$lines"
  done < <(
    {
      k=0
      while [ "$k" -lt ${#w_rel[@]} ]; do
        [ "${w_root[$k]}" = "$root" ] && printf '%s\0' "${w_rel[$k]}"
        k=$((k + 1))
      done
    } | ( cd "$root" 2>/dev/null && LC_ALL=C perl -e "$C0_BATCH_PL" 2>/dev/null )
  )
done

# Staged blobs: content comes from `git show`, so this stays one call per file.
# Bounded by what the user actually staged, unlike the working-tree listing.
j=0
while [ "$j" -lt ${#i_rel[@]} ]; do
  root="${i_root[$j]}"
  f="${i_rel[$j]}"
  j=$((j + 1))
  lines=$(git -C "$root" show ":$f" 2>/dev/null | LC_ALL=C perl -ne "$C0_RE" 2>/dev/null | head -3 | paste -sd, -)
  record "$root" "$f" "$lines"
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
  echo "If you are DELETING the file rather than fixing it, stage the deletion in its own" >&2
  echo "call first ('git rm <path>', or 'rm <path>' then 'git add -A'), then commit: this" >&2
  echo "gate reads the tree as it is BEFORE your command runs, so a deletion later in the" >&2
  echo "same command line has not happened yet and the file still looks present to it." >&2
  exit 2
fi

exit 0
