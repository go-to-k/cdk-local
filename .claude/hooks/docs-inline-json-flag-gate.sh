#!/usr/bin/env bash
# docs-inline-json-flag-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` / `gh pr edit` / `gh pr merge`
# when a Markdown file in the PR diff hands an INLINE JSON literal to a
# cdk-local CLI flag that actually takes a FILE PATH (`--env-vars` /
# `--event`). Both flags are read with `readFileSync` in
# `src/cli/commands/local-invoke.ts`, so a documented example like
# `--env-vars '{"Parameters":{"DEBUG":"1"}}'` does NOT work — the CLI
# treats the JSON string as a filename and fails with ENOENT. The
# correct form is `--env-vars ./env.json`.
#
# WHY: this exact bug shipped in two committed docs (cli-reference.md +
# local-emulation.md) and was only caught by hand. The mistake is easy
# to make (every other CLI / `sam local` reader expects inline JSON) and
# easy to copy-paste forward across files, so it warrants mechanical
# enforcement rather than relying on a reviewer to spot it.
#
# Why PR-level (not per-commit): mirrors non-english-text-gate.sh — doc
# examples are low-churn, the violation is 1-2 files, and blocking
# `gh pr merge` covers every code path that lands a commit on main. A
# PR-level scan runs once instead of N times across a multi-commit PR.
#
# Scope:
#   - Triggers on `gh pr create` / `gh pr edit` / `gh pr merge` (and
#     their `gh -C <path>` / `cd <path> && ...` forms). Everything else
#     passes through.
#   - Scans ONLY `*.md` files in the diff. The flag-with-inline-JSON
#     anti-pattern lives in documentation code blocks; restricting to
#     Markdown also means this hook's own `.sh` source (which has to
#     spell the pattern out) is never scanned.
#   - Resolves the PR via `gh pr view`, falling back to the local
#     `origin/<base>..HEAD` diff when no PR exists yet (fresh
#     `gh pr create`). Same cwd-resolution shape as
#     non-english-text-gate.sh / branch-gate.sh.
#
# Detection (POSIX ERE, `grep -nE`):
#   --(env-vars|event) <ws-or-=> ["']? { <ws>* ["']
# i.e. the flag, then an optional opening quote, then `{`, then a JSON
# key quote. Requiring the `{ "` shape (brace immediately followed by a
# quote) keeps the match tight to REAL inline JSON objects and lets
# prose that describes the anti-pattern with a `{...}` placeholder (as
# this repo's hooks.md does) pass through unflagged.
#
# Fails open when `gh` is missing or the PR cannot be resolved (matches
# non-english-text-gate.sh's contract so a fresh machine still works).
#
# No bypass marker — the fix is trivial (move the JSON into a file and
# pass its path).

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate gh pr create / edit / merge — anything else passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+(create|edit|merge)\b'; then
  exit 0
fi

target_dir="${hook_cwd:-$PWD}"

# Leading `cd <path> && ...` shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# Last `gh -C <path>` wins.
if [[ "$cmd" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  if [[ "$c_target" != /* ]]; then
    c_target="$target_dir/$c_target"
  fi
  target_dir="$c_target"
fi

# If the resolved target dir is not a git repo, silently pass.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# gh missing or unauthenticated — fail open.
if ! command -v "${GH_BIN:-gh}" >/dev/null 2>&1; then
  exit 0
fi
GH="${GH_BIN:-gh}"
# `gh` has no `-C` flag (unlike git), so every gh call below runs from a
# subshell `cd "$target_dir"`; gh resolves the repo from its cwd. `auth
# status` is global and needs no repo context.
if ! "$GH" auth status >/dev/null 2>&1; then
  exit 0
fi

# Resolve target PR number.
#
#   `gh pr merge <N>` / `gh pr edit <N>` — N is the explicit arg.
#   `gh pr create` / `gh pr merge` (no arg) — current branch's PR.
pr_number=""
if [[ "$cmd" =~ gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+(merge|edit)[[:space:]]+([0-9]+) ]]; then
  pr_number="${BASH_REMATCH[3]}"
fi

if [[ -z "$pr_number" ]]; then
  pr_number=$( (cd "$target_dir" && "$GH" pr view --json number -q .number) 2>/dev/null || true)
fi

# No PR yet (typical `gh pr create` on a fresh branch) — fall back to
# scanning the local diff against the default base branch.
use_local_diff=0
if [[ -z "$pr_number" ]]; then
  use_local_diff=1
fi

# File-list resolution.
if [[ "$use_local_diff" -eq 1 ]]; then
  base_ref=$(git -C "$target_dir" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||')
  base_ref="${base_ref:-main}"
  merge_base=$(git -C "$target_dir" merge-base "origin/$base_ref" HEAD 2>/dev/null || true)
  if [[ -z "$merge_base" ]]; then
    # Can't establish a base — silently pass (CI / detached HEAD).
    exit 0
  fi
  changed_files=$(git -C "$target_dir" diff "$merge_base..HEAD" --name-only --diff-filter=AM 2>/dev/null || true)
else
  changed_files=$( (cd "$target_dir" && "$GH" pr diff "$pr_number" --name-only) 2>/dev/null || true)
fi

if [[ -z "$changed_files" ]]; then
  exit 0
fi

# Only Markdown files carry CLI-usage examples; restricting here also
# excludes this hook's own `.sh` source from the scan.
should_scan() {
  case "$1" in
    *.md|*.markdown) return 0 ;;
  esac
  return 1
}

# Brace-then-quote shape keeps the match to real inline JSON objects.
INLINE_JSON_RE="--(env-vars|event)[[:space:]=]+[\"']?\{[[:space:]]*[\"']"

declare -a OFFENDERS=()
MAX_REPORT=20

pr_head_sha=""
if [[ "$use_local_diff" -eq 0 ]]; then
  pr_head_sha=$( (cd "$target_dir" && "$GH" pr view "$pr_number" --json headRefOid -q .headRefOid) 2>/dev/null || true)
fi

read_file_content() {
  local f="$1"
  if [[ "$use_local_diff" -eq 1 ]]; then
    git -C "$target_dir" show "HEAD:$f" 2>/dev/null
  else
    if [[ -n "$pr_head_sha" ]]; then
      git -C "$target_dir" show "$pr_head_sha:$f" 2>/dev/null && return 0
    fi
    ( cd "$target_dir" && "$GH" api "repos/{owner}/{repo}/contents/$f?ref=${pr_head_sha:-HEAD}" -q .content ) 2>/dev/null | base64 -d 2>/dev/null
  fi
}

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if ! should_scan "$f"; then
    continue
  fi

  while IFS=: read -r ln content; do
    [[ -z "$ln" ]] && continue
    OFFENDERS+=("$f:$ln:$content")
    if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
      break 2
    fi
  done < <(read_file_content "$f" | grep -nE -e "$INLINE_JSON_RE" 2>/dev/null || true)
done <<< "$changed_files"

if [[ "${#OFFENDERS[@]}" -eq 0 ]]; then
  exit 0
fi

if [[ -t 2 ]]; then
  RED_BOLD=$'\033[1;31m'
  RESET=$'\033[0m'
else
  RED_BOLD=""
  RESET=""
fi

scope_label="PR #$pr_number"
[[ "$use_local_diff" -eq 1 ]] && scope_label="local diff (origin/$base_ref..HEAD)"

{
  echo "${RED_BOLD}Blocked by docs-inline-json-flag-gate:${RESET}"
  echo
  echo "$scope_label documents a cdk-local CLI flag that takes a FILE"
  echo "PATH (--env-vars / --event) but is handed an INLINE JSON literal."
  echo "Both flags are read with readFileSync, so the inline form is"
  echo "treated as a filename and fails at runtime with ENOENT."
  echo
  echo "Found:"
  for entry in "${OFFENDERS[@]}"; do
    file="${entry%%:*}"
    rest="${entry#*:}"
    ln="${rest%%:*}"
    content="${rest#*:}"
    echo "  $file:$ln: $content"
  done
  echo
  echo "Fix:"
  echo "  - Move the JSON into a file and pass its path, e.g."
  echo "      --env-vars ./env.json"
  echo "    (show the file contents in a preceding comment if helpful)."
  echo "  - Push a follow-up commit on the same branch; this hook"
  echo "    re-runs against the new HEAD."
} >&2

exit 2
