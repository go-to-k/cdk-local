#!/usr/bin/env bash
# control-char-gate.sh
#
# PreToolUse hook. Blocks `git commit` when a staged text file contains a
# NUL (\x00) or any other C0 control byte other than tab (\x09), newline
# (\x0A), or carriage return (\x0D).
#
# WHY: an editing artifact can land a raw control byte inside a source file
# (e.g. a template-literal separator that was meant to be a space ending up
# as a literal \x00). The formatter / linter does not flag it, but it breaks
# `grep` (which then treats the file as binary and silently suppresses
# matches), `diff`, and anything that assumes clean text — and it ships in
# the committed source. This gate catches it at commit time.
#
# Scans the STAGED BLOB (`git show :<file>`) of every added/modified file,
# not the diff: a NUL makes `git diff` report "Binary files differ" and hide
# the added lines, so a diff-only scan would miss exactly the case we care
# about. Files with binary/asset extensions (images, fonts, archives, etc.)
# legitimately contain control bytes and are skipped.
#
# Cwd-aware via the shared `gate_target_dir`: resolves the working tree the
# commit will actually act on from the matched segment's `git -C <path>` > the
# last preceding `cd <path>` > the hook payload's `cwd` > its own $PWD.
#
# Fails open (exit 0) when git / perl are unavailable or nothing is staged —
# a safety net must never wedge an otherwise-valid commit.

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
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GIT_COMMIT")

# Staged added/modified files (NUL-delimited, so paths with spaces / newlines
# are handled). Renames/copies/deletes are excluded — D has no content, and
# the added side of R/C shows up as its own ACM entry when content changed.
mapfile -d '' -t staged < <(
  git -C "$target_dir" diff --cached --name-only --diff-filter=ACM -z 2>/dev/null || true
)
[[ ${#staged[@]} -eq 0 ]] && exit 0

# Extensions whose blobs legitimately contain control bytes — never scanned.
binary_ext_re='\.(png|jpe?g|gif|webp|bmp|ico|icns|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|tar|jar|war|7z|rar|wasm|mp4|m4v|mov|webm|avi|mkv|mp3|wav|flac|ogg|bin|exe|dll|so|dylib|node|class|keystore|jks|p12|pfx)$'

offenders=()
for f in "${staged[@]}"; do
  [[ -z "$f" ]] && continue
  shopt -s nocasematch
  if [[ "$f" =~ $binary_ext_re ]]; then
    shopt -u nocasematch
    continue
  fi
  shopt -u nocasematch
  # Print the line numbers of any blob line containing a C0 control byte
  # other than tab / LF / CR. -0777 would slurp; we stay line-oriented so
  # the reported line numbers are useful (a NUL does not span the regex).
  lines=$(
    git -C "$target_dir" show ":$f" 2>/dev/null \
      | LC_ALL=C perl -ne 'print "$.\n" if /[\x00-\x08\x0B\x0C\x0E-\x1F]/' 2>/dev/null \
      | head -3 | paste -sd, -
  )
  if [[ -n "$lines" ]]; then
    offenders+=("$f (line(s): $lines)")
  fi
done

if [[ ${#offenders[@]} -gt 0 ]]; then
  echo "Blocked by control-char-gate: staged file(s) contain a NUL or other C0 control byte" >&2
  echo "(anything below 0x20 except tab / newline / carriage-return)." >&2
  echo "  resolved target dir: $target_dir" >&2
  for o in "${offenders[@]}"; do
    echo "  - $o" >&2
  done
  echo "These are almost always an editing artifact (e.g. a separator that landed as a raw" >&2
  echo "NUL); they break grep / diff / tooling and must not ship in committed text. Open the" >&2
  echo "file(s), remove the stray control character(s), re-stage, and commit again." >&2
  exit 2
fi

exit 0
