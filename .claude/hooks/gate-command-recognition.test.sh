#!/usr/bin/env bash
# Behavioral smoke test for the gates' COMMAND RECOGNITION, driven through the
# real hooks with real payloads. Run from the repo root:
#   bash .claude/hooks/gate-command-recognition.test.sh
#
# Why this exists (go-to-k/cdk-local#542 review): the helper's own harness tests
# `gate_matches`, and a structural case asserts each gate sources the helper —
# but neither can see a gate that sources it and then asks the WRONG question.
# Two mutations proved it: pointing a gate at the WRONG `GATE_RE_*` constant,
# and replacing its `gate_matches … || exit 0` with a bare `exit 0`, both left
# the suite green. These cases kill both.
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

# --- BASH INTERPRETER FENCE ---
# Every case launches its hook through `env PATH="$SHIM:/usr/bin:/bin"`, and the
# hooks' `#!/usr/bin/env bash` resolves `bash` off THAT path -- so until now the
# interpreter was whatever `/bin/bash` happens to be, which on macOS is 3.2 and
# on most Linux distros is 5.x. That is the right DEFAULT (the shipped hook has
# to survive the bash a user actually has) but it made the other tally
# untakeable: there was no way to re-run the same 149 cases under the OTHER
# major version without editing this file.
#
# So the interpreter is now an explicit symlink at the FRONT of that PATH.
# Default `/bin/bash` -- byte-identical behaviour to before -- and
# `HOOK_BASH=/opt/homebrew/bin/bash bash .claude/hooks/gate-command-recognition.test.sh`
# takes the 5.x tally. An explicitly set HOOK_BASH that is not executable is
# FATAL rather than a silent fall-back: a typo'd override that quietly ran the
# default would report the version it did not run.
if [ -n "${HOOK_BASH:-}" ]; then
  if [ ! -x "$HOOK_BASH" ]; then
    printf 'FATAL - HOOK_BASH is not an executable: %s\n' "$HOOK_BASH" >&2
    exit 1
  fi
else
  HOOK_BASH=/bin/bash
  [ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
  [ -n "$HOOK_BASH" ] && [ -x "$HOOK_BASH" ] || {
    printf 'FATAL - no usable bash found for the hooks\n' >&2
    exit 1
  }
fi

SHIM="$TMPDIR/bin"; mkdir -p "$SHIM"
ln -sf "$HOOK_BASH" "$SHIM/bash"
printf 'hook interpreter: %s (bash %s)\n' "$HOOK_BASH" \
  "$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')"
# Both stubs LOG THEIR $PWD when asked to. A gate `cd`s into the directory it
# resolved before asking markgate, so that log is a direct read of
# gate_target_dir's answer through the real hook -- which is the only way to
# fence target-dir resolution for gates whose exit code is the same either way.
# Both stubs log their $PWD AND THEIR ARGV. Logging only $PWD is a blind spot
# of its own: nothing then asserts WHICH GATE NAME a hook verifies, and swapping
# one gate name for another is a LIVE BYPASS -- the command passes whenever the
# OTHER marker is fresh and the work this gate guards never ran.
cat > "$SHIM/mise" <<'MISE'
#!/usr/bin/env bash
[ -n "${PWD_LOG:-}" ] && printf '%s\n' "$PWD" >> "$PWD_LOG"
[ -n "${MG_LOG:-}" ] && printf '%s\n' "$*" >> "$MG_LOG"
exit "${MARKGATE_RC:-1}"
MISE
cat > "$SHIM/markgate" <<'MG'
#!/usr/bin/env bash
[ -n "${PWD_LOG:-}" ] && printf '%s\n' "$PWD" >> "$PWD_LOG"
[ -n "${MG_LOG:-}" ] && printf '%s\n' "$*" >> "$MG_LOG"
exit "${MARKGATE_RC:-1}"
MG
# A `git` shim that logs argv: a gate that resolves a target directory exposes
# it on its `git -C "$target_dir" ...` call, which makes the resolution
# observable even for a gate whose exit code is the same either way. Delegates
# to the real git so the gates still function.
cat > "$SHIM/git" <<'GIT'
#!/usr/bin/env bash
[ -n "${GIT_LOG:-}" ] && printf '%s\n' "$*" >> "$GIT_LOG"
exec /usr/bin/git "$@"
GIT
# A `gh` shim that LOGS its argv. Without it the gh-calling gates fail open and
# every pair below is satisfied vacuously at 0 -- which is exactly how three live
# bypasses were certified green.
# The stub DRAINS ITS STDIN, and that is the point rather than hygiene. A gate
# calls `gh` from inside a `while IFS= read -r` loop whose stdin IS the
# `gate_segments` process substitution, so a `gh` that reads stdin eats the
# segments the walk has not judged yet -- and the real `gh` is free to. The
# `</dev/null` redirections in post-merge-orphan-push-gate exist for exactly
# that, and its own comment used to say no case could pin them. One can: this
# line plus the two-push case below.
#
# `GH_FAIL` makes the stub answer NOTHING, which is how the gate's "gh pr list
# failed or returned empty" arm is reached with a gh that exists.
cat > "$SHIM/gh" <<'GH'
#!/usr/bin/env bash
cat >/dev/null
[ -n "${GH_LOG:-}" ] && printf '%s\n' "$*" >> "$GH_LOG"
[ -n "${GH_FAIL:-}" ] && exit 0
case "$*" in
  "auth status"*) exit 0 ;;
  # post-merge-orphan-push-gate asks `gh pr list --head <branch> --state merged`.
  # Exactly ONE branch answers with a merged PR, so a case that blocks proves the
  # gate resolved THAT branch rather than merely reaching gh.
  *"pr list"*"--head feat/merged"*)
    echo '[{"number":7,"mergedAt":"2026-01-01T00:00:00Z","headRefName":"feat/merged","title":"merged lane"}]' ;;
  *"pr list"*) echo '[]' ;;
  *"pr view --json number"*) echo 999 ;;   # the CURRENT BRANCH's PR, never the target
  *"pr view"*"body"*) echo 'Closes (#12)' ;;
  *"pr view"*) echo '{"additions":50,"deletions":10,"changedFiles":2,"files":[],"headRefOid":"abc","headRefName":"f"}' ;;
  *"pr diff"*) echo 'README.md' ;;
esac
exit 0
GH
chmod +x "$SHIM/mise" "$SHIM/markgate" "$SHIM/gh" "$SHIM/git"

pass=0; fail=0
# run_case <name> <expect_exit> <hook> <command>
run_case() {
  local name="$1" want="$2" hook="$3" cmd="$4" got out payload
  # `tool_name` is REQUIRED, not decoration: a gate that reads it exits before
  # ever looking at the command when it is absent, so a payload without it
  # reports "both exit 0" over a fully bypassed gate.
  payload=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd")
  out=$(printf '%s' "$payload" | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 \
    "$HOOKS/$hook" 2>&1); got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(exit $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s, got %s)\n  out: %s\n' "$name" "$want" "$got" "$out"
  fi
}

# The same call from a DIFFERENT cwd, for the cases that are about which TREE
# the resolved segment lands in.
run_case_cwd() {
  local name="$1" want="$2" hook="$3" cwd="$4" cmd="$5" got out payload
  payload=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$cwd" "$cmd")
  out=$(printf '%s' "$payload" | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 \
    "$HOOKS/$hook" 2>&1); got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(exit $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s, got %s)\n  out: %s\n' "$name" "$want" "$got" "$out"
  fi
}

# The exit code alone cannot say WHICH segment a block is about, and the message
# is the whole product of a block -- it names the branch the user must replay
# somewhere else. `run_case` compares exit codes only, so a gate that blocks for
# the right reason and then NAMES THE WRONG BRANCH is green there. Assert the
# text: `have` must appear, `nothave` (when given) must not.
#
# run_case_msg <name> <expect_exit> <hook> <cmd> <have> [<nothave>]
run_case_msg() {
  local name="$1" want="$2" hook="$3" cmd="$4" have="$5" nothave="${6:-}" got out payload why=""
  payload=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd")
  out=$(printf '%s' "$payload" | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 \
    "$HOOKS/$hook" 2>&1); got=$?
  [ "$got" = "$want" ] || why="exit $got, want $want"
  printf '%s' "$out" | grep -qF -- "$have" || why="${why:+$why; }message lacks [$have]"
  if [ -n "$nothave" ] && printf '%s' "$out" | grep -qF -- "$nothave"; then
    why="${why:+$why; }message wrongly contains [$nothave]"
  fi
  if [ -z "$why" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(exit $got, names [$have])"
  else
    fail=$((fail + 1)); printf 'FAIL %s (%s)\n  out: %s\n' "$name" "$why" "$out"
  fi
}

# How many times a hook emits one line of stderr for ONE command. A note that
# describes a per-COMMAND decision ("this machine has no gh, so nothing was
# checked") must be stated once however many segments the walk judges.
# PATH is a hermetic symlink farm rather than a subtraction from the real PATH:
# `gh` lives in /usr/bin on some distros and in /opt/homebrew/bin here, so
# "PATH minus the shim dir" is gh-free only by luck of the host.
#
# run_note_count <name> <hook> <cmd> <substring> <expected count>
run_note_count() {
  local name="$1" hook="$2" cmd="$3" needle="$4" want="$5" got out
  out=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd" \
    | env PATH="$NOGH" "$HOOKS/$hook" 2>&1)
  got=$(printf '%s\n' "$out" | grep -cF -- "$needle" | tr -d ' ')
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(said it $got time(s))"
  else
    fail=$((fail + 1)); printf 'FAIL %s (said it %s time(s), expected %s)\n  out: %s\n' \
      "$name" "$got" "$want" "$out"
  fi
}
# The same count, over the SHIM farm (gh PRESENT) and with the stub answering
# nothing, so the gate's OTHER note -- "gh pr list failed or returned empty" --
# is the one measured. That note describes a per-COMMAND condition and was
# printed once per gateable SEGMENT.
#
# run_note_count_shim <name> <hook> <cmd> <substring> <expected count>
run_note_count_shim() {
  local name="$1" hook="$2" cmd="$3" needle="$4" want="$5" got out
  out=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd" \
    | env PATH="$SHIM:/usr/bin:/bin" GH_FAIL=1 "$HOOKS/$hook" 2>&1)
  got=$(printf '%s\n' "$out" | grep -cF -- "$needle" | tr -d ' ')
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(said it $got time(s))"
  else
    fail=$((fail + 1)); printf 'FAIL %s (said it %s time(s), expected %s)\n  out: %s\n' \
      "$name" "$got" "$want" "$out"
  fi
}

# The farm itself: everything the gate and the shared matcher shell out to, and
# NOTHING else -- no `gh` exists anywhere on this PATH, on any host.
NOGH="$TMPDIR/nogh"; mkdir -p "$NOGH"
ln -sf "$HOOK_BASH" "$NOGH/bash"
for _t in git jq cat dirname sed grep awk tr head; do
  _p="$(command -v "$_t" 2>/dev/null || true)"
  [ -n "$_p" ] && ln -sf "$_p" "$NOGH/$_t"
done
unset _t _p
if [ -x "$NOGH/gh" ] || env PATH="$NOGH" command -v gh >/dev/null 2>&1; then
  printf 'FATAL - the gh-free farm resolved a gh; run_note_count would be vacuous\n' >&2
  exit 1
fi

# post-merge-orphan-push-gate blocks a push to a branch whose PR already merged.
# The defect this pins: it used to read the remote/branch off the WHOLE COMMAND with a leftmost-longest `=~ [[:space:]]push
# (.*)$`, then cut at the first `&&` / `;` / `|`. Run standalone, that parse gave:
#
#   git push origin feat/x                            -> args [origin feat/x]
#   echo "remember to push origin main" && git push origin feat/x
#                                                     -> args [origin main"...]
#   git push origin main && git push origin feat/x    -> args [origin main...]
#
# so a quoted MENTION steers the branch to `main"` and a chain is judged on the
# FIRST push. Either way `gh pr list --head <wrong branch>` finds nothing, the
# gate exits 0, and the orphan push proceeds unjudged. The gh stub answers a
# merged PR for `feat/merged` and an empty list for everything else, so a case
# that blocks proves WHICH branch the gate resolved.
run_case "orphan-push: bare push to a merged branch"  2 post-merge-orphan-push-gate.sh 'git push origin feat/merged'
run_case "orphan-push: quoted push MENTION first"     2 post-merge-orphan-push-gate.sh 'echo \"remember to push origin main\" && git push origin feat/merged'
run_case "orphan-push: chained, merged one is LAST"   2 post-merge-orphan-push-gate.sh 'git push origin main && git push origin feat/merged'
# EVERY matching segment is judged, not the last: with the merged push FIRST, a
# gate that only looked at the final segment would let it through.
run_case "orphan-push: chained, merged one is FIRST"  2 post-merge-orphan-push-gate.sh 'git push origin feat/merged && git push origin main'
run_case "orphan-push: cd prefix with a semicolon"    2 post-merge-orphan-push-gate.sh 'cd /tmp; git push origin feat/merged'
run_case "orphan-push: flags around the positionals"  2 post-merge-orphan-push-gate.sh 'git push --force-with-lease origin feat/merged'
# The allowances, unchanged. Each is the false-BLOCK direction of a case above.
run_case "orphan-push: unmerged branch passes"        0 post-merge-orphan-push-gate.sh 'git push origin feat/live'
run_case "orphan-push: deletion refspec passes"       0 post-merge-orphan-push-gate.sh 'git push origin :feat/merged'
run_case "orphan-push: sha:branch refspec passes"     0 post-merge-orphan-push-gate.sh 'git push origin abc123:feat/merged'
run_case "orphan-push: non-origin remote passes"      0 post-merge-orphan-push-gate.sh 'git push upstream feat/merged'
# The mandated quoted-body false-positive pair. Both carry a WORD after the
# branch so that dropping the verb ERE's start anchor yields a parsable
# `origin feat/merged ...` -- without it the mention parses to a branch with a
# stray quote, gh answers nothing, and the case would pass against the broken
# gate for the wrong reason.
run_case "orphan-push: double-quoted mention"         0 post-merge-orphan-push-gate.sh 'echo \"next: git push origin feat/merged then open a PR\"'
run_case "orphan-push: single-quoted mention"         0 post-merge-orphan-push-gate.sh "git commit -m 'then git push origin feat/merged later'"
# `-u` with no branch derives it from the resolved tree via `symbolic-ref`, so
# both polarities are pinned: the sandbox repo is on `feature` (not merged), and
# a worktree checked out on `feat/merged` must block.
run_case "orphan-push: -u with no branch, on feature" 0 post-merge-orphan-push-gate.sh 'git push -u origin'
MERGED_WT="$TMPDIR/wt-merged"
git -C "$repo" worktree add -q -b feat/merged "$MERGED_WT" 2>/dev/null
run_case_cwd "orphan-push: -u with no branch, on the merged branch" 2 post-merge-orphan-push-gate.sh "$MERGED_WT" 'git push -u origin'
# ...and the same shape with a trailing REDIRECTION, which is what pins the
# `args="${args%%>*}"` strip in parse_push_args. Deleting that strip leaves all
# the cases above green, because every one of them fills `branch` from a real
# positional before the `>` token is ever reached. Only a push that OMITS the
# branch lets `>/tmp/log` BE the first free positional -- gh then answers an
# empty list for a branch named `>/tmp/log` and the gate exits 0 on a push to a
# merged branch. Measured: with the strip removed this case returns 0.
run_case_cwd "orphan-push: -u, redirected, on the merged branch" 2 post-merge-orphan-push-gate.sh "$MERGED_WT" 'git push -u origin >/tmp/log'

# A NON-GATEABLE push BEFORE the merged one. The two chain cases above both put
# a push that IS judged (and passes) first, so they only pin the
# judged-and-allowed arm of the walk; `parse_push_args … || continue` -- the arm
# for a segment that is not gateable AT ALL -- had no case. Mutating that
# `continue` to `break` leaves all 149 of them green while these two return 0:
# the walk gives up at the first un-judgeable segment and never reaches the
# merged push behind it. Both non-gateable shapes get a case, because they
# return 1 from different places in the parse (the remote check and the refspec
# check).
run_case "orphan-push: non-origin push FIRST, merged one after" 2 post-merge-orphan-push-gate.sh 'git push upstream feat/x && git push origin feat/merged'
run_case "orphan-push: deletion refspec FIRST, merged one after" 2 post-merge-orphan-push-gate.sh 'git push origin :feat/x && git push origin feat/merged'

# The block MESSAGE names the segment that blocked, not the last one walked.
# `blocked=1; break` is what makes that true, and deleting the `break` also
# leaves 149 green -- the walk runs on, `branch` is overwritten by the trailing
# `main`, and the refusal tells the user to replay a branch that is not the
# problem. Exit codes cannot see that, so assert the text both ways.
run_case_msg "orphan-push: refusal names the blocking segment" 2 post-merge-orphan-push-gate.sh \
  'git push origin feat/merged && git push origin main' \
  "branch 'feat/merged'" "branch 'main'"

# The "gh not installed" note describes a per-COMMAND fact, so a chain of three
# gateable pushes must state it ONCE. Memoising only the SUCCESS arm of
# resolve_gh (`[ -n "$gh_bin" ] && return 0`, with nothing recording a failed
# probe) prints it three times; no exit code moves, since the gate fails open
# either way.
run_note_count "orphan-push: the no-gh note is stated once" post-merge-orphan-push-gate.sh \
  'git push origin a && git push origin b && git push origin c' \
  'gh not installed' 1

# The gh call's `</dev/null`, which the gate's own comment called unpinnable.
# The stub above drains stdin, and the walk's stdin IS the segment stream: a
# `gh` invoked without `</dev/null` eats every segment after the one that called
# it, so the SECOND push -- the one to the merged branch -- is never judged and
# the gate exits 0. The order matters: the live branch must come FIRST, so the
# gate really does call gh and carry on.
run_case "orphan-push: a gh call does not eat the segments after it" 2 \
  post-merge-orphan-push-gate.sh 'git push origin feat/live && git push origin feat/merged'
# The false-BLOCK control: two LIVE branches must still pass, so the case above
# is not satisfied by a gate that blocks any two-push command.
run_case "orphan-push: two live pushes still pass" 0 \
  post-merge-orphan-push-gate.sh 'git push origin feat/live && git push origin feat/other'

# The gh-FAILURE note is a per-COMMAND decision, like the missing-gh note above.
run_note_count_shim "orphan-push: the gh-failure note is stated once" post-merge-orphan-push-gate.sh \
  'git push origin a && git push origin b && git push origin c' \
  'gh pr list failed or returned empty' 1


# --- a repo/dir FLAG must not change any gate's verdict ----------------------
# `gh -R <owner/repo> pr merge 1 --squash` matches NOTHING if GATE_GH_C absorbs
# `-C <path>` only, so it MERGES PAST integ-gate while the identical command
# without the flag is refused (integ-gate 2 -> 0).
#
# The regex-level cases in `_command-match.test.sh` pin the absorber, but they
# can only fail once someone already suspects the flag. THIS is the assertion
# that would have caught it cold: drive the gate with the plain and the flagged
# spelling of the same command and demand the SAME exit code. It needs no
# knowledge of which flags exist — only that adding one must not change a
# verdict.
#
# run_pair <name> <hook> <plain-cmd> <flagged-cmd> [<expected-plain-rc>]
#
# The 5th argument is a GUARD ON THE GUARD. Several gates shell out to `gh` and
# fail OPEN when it errors, so under this harness they answer 0 to both
# spellings and the equality holds VACUOUSLY. Passing the expected plain rc
# forces the pair to be discriminating: if the gate stops refusing the plain
# command, the case fails instead of quietly proving nothing.
run_pair() {
  local name="$1" hook="$2" plain="$3" flagged="$4" want_plain="${5:-}"
  local a b pa pb
  pa=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$plain")
  pb=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$flagged")
  printf '%s' "$pa" | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 "$HOOKS/$hook" >/dev/null 2>&1; a=$?
  printf '%s' "$pb" | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 "$HOOKS/$hook" >/dev/null 2>&1; b=$?
  if [ -n "$want_plain" ] && [ "$a" != "$want_plain" ]; then
    fail=$((fail + 1))
    printf 'FAIL %s (plain rc %s, expected %s -- the pair no longer discriminates)\n' "$name" "$a" "$want_plain"
    return
  fi
  if [ "$a" = "$b" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(both exit $a)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (plain %s, flagged %s -- the flag bypasses the gate)\n' "$name" "$a" "$b"
  fi
}

R=go-to-k/cdk-local
# integ-gate is the one gh-calling gate whose rc discriminates under this
# harness (MARKGATE_RC=1 makes it refuse), so every pair is pinned to the
# refusing rc and cannot go vacuous.
run_pair "integ-gate: -R pr merge"        integ-gate.sh "gh pr merge 1 --squash" "gh -R $R pr merge 1 --squash" 2
run_pair "integ-gate: --repo pr merge"    integ-gate.sh "gh pr merge 1 --squash" "gh --repo $R pr merge 1 --squash" 2
run_pair "integ-gate: -C then -R"         integ-gate.sh "gh pr merge 1 --squash" "gh -C $repo -R $R pr merge 1 --squash" 2
# ...and the REVERSED order, which is the one that broke: a `-C` scan requiring
# `-C` immediately after `gh` resolves `gh -R o/r -C <dir> ...` to the payload
# cwd instead of <dir>, so the merge is judged against a different worktree's
# marker.
run_pair "integ-gate: -R then -C"         integ-gate.sh "gh pr merge 1 --squash" "gh -R $R -C $repo pr merge 1 --squash" 2
run_pair "integ-gate: --repo= then -C"    integ-gate.sh "gh pr merge 1 --squash" "gh --repo=$R -C $repo pr merge 1 --squash" 2
run_pair "integ-gate: -R then -C="        integ-gate.sh "gh pr merge 1 --squash" "gh -R $R -C=$repo pr merge 1 --squash" 2
# ALL THREE separators `gh` accepts. `--repo=<o/r>`, `-R=<o/r>` and the GLUED
# `-R<o/r>` all work against a real repo; the glued form is the one a
# hand-written flag alternation misses, since it has no separator at all.
run_pair "integ-gate: --repo=<repo>"      integ-gate.sh "gh pr merge 1 --squash" "gh --repo=$R pr merge 1 --squash" 2
run_pair "integ-gate: -R=<repo>"          integ-gate.sh "gh pr merge 1 --squash" "gh -R=$R pr merge 1 --squash" 2
run_pair "integ-gate: -R<repo> glued"     integ-gate.sh "gh pr merge 1 --squash" "gh -R$R pr merge 1 --squash" 2
run_pair "integ-gate: -C=<path>"          integ-gate.sh "gh pr merge 1 --squash" "gh -C=$repo pr merge 1 --squash" 2
# --- the DIRECTORY a gate consults, for the gates whose rc cannot show it ----
# `markgate` is asked from inside the resolved target dir, so logging its $PWD
# is a direct read of gate_target_dir's answer through the real hook, and it is
# the assertion that catches a `-C` ORDER bug: the wrong directory means the
# merge is judged against a different worktree's marker at the same exit code.
run_dir() {
  local name="$1" hook="$2" cmd="$3" want="$4" got
  : > "$TMPDIR/pwd.log"
  printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd" \
    | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 PWD_LOG="$TMPDIR/pwd.log" \
      "$HOOKS/$hook" >/dev/null 2>&1
  got=$(head -1 "$TMPDIR/pwd.log")
  [ -z "$got" ] && got="(never asked)"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(consulted $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (consulted %s, expected %s)\n' "$name" "$got" "$want"
  fi
}

other="$TMPDIR/other"; mkdir -p "$other"; git -C "$other" init -q 2>/dev/null; : > "$other/.markgate.yml"
verb="pr merge 1 --squash"
run_dir "integ-gate: no -C uses the payload cwd"   integ-gate.sh "gh $verb"                     "$repo"
run_dir "integ-gate: -C only"                      integ-gate.sh "gh -C $other $verb"           "$other"
run_dir "integ-gate: -C then -R"                   integ-gate.sh "gh -C $other -R $R $verb"     "$other"
run_dir "integ-gate: -R then -C"                   integ-gate.sh "gh -R $R -C $other $verb"     "$other"
run_dir "integ-gate: --repo= then -C"              integ-gate.sh "gh --repo=$R -C $other $verb" "$other"
run_dir "integ-gate: -R then -C="                  integ-gate.sh "gh -R $R -C=$other $verb"     "$other"
run_dir "integ-gate: -C after the verb is ignored" integ-gate.sh "gh $verb -C $other"           "$repo"

# --- WHICH MARKER a gate verifies -------------------------------------------
# The same lens as `run_dir`, turned on markgate instead of $PWD. Swapping a gate's
# marker name for another gate's is a LIVE BYPASS -- the merge then passes
# whenever the OTHER marker is fresh -- and the exit codes cannot see it.
#
# run_marker <name> <hook> <cmd> <expected gate name>
run_marker() {
  local name="$1" hook="$2" cmd="$3" want="$4" got
  : > "$TMPDIR/mg.log"
  printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd" \
    | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 MG_LOG="$TMPDIR/mg.log" \
      "$HOOKS/$hook" >/dev/null 2>&1
  got=$(grep -oE '(^|[[:space:]])verify [A-Za-z0-9-]+' "$TMPDIR/mg.log" | head -1 | awk '{print $NF}')
  [ -z "$got" ] && got="(never asked)"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(asked: verify $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (asked: verify %s, expected verify %s)\n' "$name" "$got" "$want"
  fi
}

run_marker "integ-gate verifies integ"         integ-gate.sh     "gh pr merge 1 --squash"   integ

CASE_FLOOR=40
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
