#!/usr/bin/env bash
# Behavioral smoke test for the gates' COMMAND RECOGNITION, driven through the
# real hooks with real payloads. Run from the repo root:
#   bash .claude/hooks/gate-command-recognition.test.sh
#
# Why this exists (go-to-k/cdk-local#542 review): the helper's own harness tests
# `gate_matches`, and a structural case asserts each gate sources the helper —
# but neither can see a gate that sources it and then asks the WRONG question.
# Two mutations proved it: pointing `check-gate` at `GATE_RE_GIT_PUSH`, and
# replacing its `gate_matches … || exit 0` with a bare `exit 0`, both left the
# suite green. These cases kill both.
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
# Both stubs log their $PWD AND THEIR ARGV. Logging only $PWD was a blind spot
# of its own: nothing asserted WHICH GATE NAME a hook verifies, so swapping
# `markgate verify verify-pr` for `markgate verify check` in verify-pr-gate --
# a LIVE BYPASS, since the PR then merges whenever `/check` alone is fresh and
# the `/verify-pr` checklist never ran -- left the whole suite green. The `gh`
# shim had had argv logging since the selector round; markgate had not.
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
# A `git` shim that logs argv. cdkd-parity-gate / create-integ-gate expose the
# directory they resolved on their FIRST `git -C "$target_dir" rev-parse
# --git-dir`, long before markgate -- so their resolution IS observable, and an
# earlier revision of this file wrongly recorded "(never asked)" and called them
# uncoverable. Delegates to the real git so the gates still function.
cat > "$SHIM/git" <<'GIT'
#!/usr/bin/env bash
[ -n "${GIT_LOG:-}" ] && printf '%s\n' "$*" >> "$GIT_LOG"
exec /usr/bin/git "$@"
GIT
# A `gh` shim that LOGS its argv. Without it the gh-calling gates fail open and
# every pair below is satisfied vacuously at 0 -- which is exactly how three live
# bypasses were certified green (see run_sel).
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
  # `tool_name` is REQUIRED, not decoration: closes-paren-form-gate reads it and
  # exits before ever looking at the command when it is absent, so a payload
  # without it reported "both exit 0" over a fully bypassed gate.
  payload=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd")
  out=$(printf '%s' "$payload" | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 \
    "$HOOKS/$hook" 2>&1); got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(exit $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s, got %s)\n  out: %s\n' "$name" "$want" "$got" "$out"
  fi
}

# The same call from a DIFFERENT cwd -- the linked-worktree half of the
# main-tree cases below, which are precisely about which TREE the resolved
# segment lands in.
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

# check-gate guards `git commit` — and ONLY that verb.
run_case "check-gate: bare commit"            2 check-gate.sh 'git commit -m x'
run_case "check-gate: add -A && commit"       2 check-gate.sh 'git add -A && git commit -m x'
run_case "check-gate: subshell commit"        2 check-gate.sh '(cd . && git commit -m x)'
run_case "check-gate: push is not its verb"   0 check-gate.sh 'git push origin HEAD'
run_case "check-gate: status passes"          0 check-gate.sh 'git status --short'
run_case "check-gate: quoted mention passes"  0 check-gate.sh 'echo \"then git commit -m x\"'

# verify-pr-gate guards `gh pr create` / `gh pr merge`, not `gh pr view`.
run_case "verify-pr-gate: pr create"          2 verify-pr-gate.sh 'gh pr create --fill'
run_case "verify-pr-gate: push && pr create"  2 verify-pr-gate.sh 'git push && gh pr create --fill'
run_case "verify-pr-gate: pr merge"           2 verify-pr-gate.sh 'gh pr merge 42 --squash'
run_case "verify-pr-gate: pr view passes"     0 verify-pr-gate.sh 'gh pr view 42'

# issue-dup-check-gate guards the two verbs that MINT an issue, and only those.
# Driven through the real hook so a gate that sources the helper and then asks
# the WRONG question is still caught (the reason this file exists).
run_case "issue-dup: issue create"            2 issue-dup-check-gate.sh 'gh issue create --title t --body-file /nope.md'
run_case "issue-dup: gh -R issue create"      2 issue-dup-check-gate.sh 'gh -R go-to-k/cdkd issue create --title t --body-file /nope.md'
run_case "issue-dup: chained issue create"    2 issue-dup-check-gate.sh 'git push && gh issue create --title t --body-file /nope.md'
run_case "issue-dup: gh api issues POST"      2 issue-dup-check-gate.sh 'gh api repos/go-to-k/cdk-local/issues -f title=t -f body=x'
run_case "issue-dup: issue comment passes"    0 issue-dup-check-gate.sh 'gh issue comment 7 --body-file /nope.md'
run_case "issue-dup: issue edit passes"       0 issue-dup-check-gate.sh 'gh issue edit 7 --body-file /nope.md'
run_case "issue-dup: pr create passes"        0 issue-dup-check-gate.sh 'gh pr create --fill'
run_case "issue-dup: quoted mention passes"   0 issue-dup-check-gate.sh 'echo \"then gh issue create -t x\"'

# branch-gate guards commit AND push, and only on a protected branch.
git -C "$repo" checkout -q -b main
run_case "branch-gate: commit on main"        2 branch-gate.sh 'git commit -m x'
run_case "branch-gate: push on main"          2 branch-gate.sh 'git push origin HEAD'
run_case "branch-gate: chained commit"        2 branch-gate.sh 'vp run check && git commit -m x'
run_case "branch-gate: status on main"        0 branch-gate.sh 'git status'
git -C "$repo" checkout -q feature
run_case "branch-gate: commit on a feature branch" 0 branch-gate.sh 'git commit -m x'

# main-tree-branch-gate blocks feature-branch creation in the MAIN worktree, and
# the CHAINED spelling is the one that matters: the gate used to parse its
# verdict with an awk walker over the whole command, which skipped to the FIRST
# `git` token, read `sub=fetch`, and fell to a fail-open `*)` arm. Measured
# against the real hook in the real main checkout on `main`, before the fix:
# `git switch -c wt-probe origin/main` exited 2 while
# `git fetch origin && git switch -c wt-probe origin/main` exited 0, and
# `git status && git checkout -b wt-probe` exited 0 too. `/work-issues` prints
# the chained spelling, so the bypass was on the mandated path.
MT_WT="$TMPDIR/wt-lane"
git -C "$repo" worktree add -q -b wt-lane "$MT_WT" 2>/dev/null
# REMOTE-tracking refs with no local branch behind them: the shape a lane's
# branch has in a fresh checkout, and the one `git checkout <name>` DWIMs into a
# local branch + switch. The NESTED one is here because a `*` does not cross a
# `/` in for-each-ref, so a `refs/remotes/*/*` pattern silently misses it while
# git DWIMs it identically. The SYMBOLIC `refs/remotes/origin/HEAD` that every
# clone carries is here for the opposite reason: `lstrip=3` renders it as the
# bare word `HEAD`, and `git checkout HEAD` creates nothing, so a DWIM list that
# keeps it false-blocks a read-only command.
MT_SHA=$(git -C "$repo" rev-parse HEAD)
# The remotes must be CONFIGURED, not merely have refs under their prefix: git
# DWIMs `<name>` only for a remote it knows about. Measured -- with
# `refs/remotes/ghostremote/ghost` present and no `ghostremote` remote,
# `git checkout ghost` answers "pathspec 'ghost' did not match any file(s) known
# to git" and HEAD stays. A URL is enough; nothing is ever fetched here.
git -C "$repo" remote add origin https://example.invalid/origin.git
# A remote whose NAME contains a SLASH. `git remote add a/b <url>` is accepted
# (measured), and `deep-only` on it lands at `refs/remotes/a/b/deep-only`, which
# a fixed `lstrip=3` renders as `b/deep-only` while git DWIMs plain `deep-only`
# ("Switched to a new branch 'deep-only'", HEAD moved) -- a FAIL-OPEN.
git -C "$repo" remote add a/b https://example.invalid/ab.git
git -C "$repo" update-ref refs/remotes/a/b/deep-only "$MT_SHA"
# A ref under a remote that is NOT configured -- what a removed remote or a hand
# `update-ref` leaves behind. Real git does not DWIM it (see above).
git -C "$repo" update-ref refs/remotes/ghostremote/ghost "$MT_SHA"
git -C "$repo" update-ref refs/remotes/origin/remote-only "$MT_SHA"
git -C "$repo" update-ref refs/remotes/origin/topic/nested-remote-only "$MT_SHA"
git -C "$repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/remote-only
run_case "main-tree-branch: bare switch -c"        2 main-tree-branch-gate.sh 'git switch -c feat/x origin/main'
run_case "main-tree-branch: CHAINED switch -c"     2 main-tree-branch-gate.sh 'git fetch origin && git switch -c feat/x origin/main'
run_case "main-tree-branch: CHAINED checkout -b"   2 main-tree-branch-gate.sh 'git status && git checkout -b feat/x'
# EVERY matching segment is judged, not just the first: an allowed target in the
# first half must not license the second.
run_case "main-tree-branch: allowed then blocked"  2 main-tree-branch-gate.sh 'git switch main && git switch -c feat/x'
# The allowances, PER SEGMENT. Each is the false-BLOCK direction of the case
# above it, so a gate that simply blocked every chained `git` would fail here.
run_case "main-tree-branch: CHAINED switch main"   0 main-tree-branch-gate.sh 'git fetch origin && git switch main'
run_case "main-tree-branch: CHAINED checkout --"   0 main-tree-branch-gate.sh 'git status && git checkout -- README.md'
run_case "main-tree-branch: chained sha checkout"  0 main-tree-branch-gate.sh 'git fetch && git checkout 0123456789abcdef'
run_case "main-tree-branch: worktree add passes"   0 main-tree-branch-gate.sh 'git worktree add .claude/worktrees/x -b x origin/main'
# The mandated quoted-body false-positive pair. A matcher change is exactly
# where these regress, and this gate now reads its ARGUMENTS through the matcher
# too, so both halves are pinned here rather than only in the helper harness.
run_case "main-tree-branch: double-quoted mention" 0 main-tree-branch-gate.sh 'echo \"next: git switch -c feat/x\"'
run_case "main-tree-branch: single-quoted mention" 0 main-tree-branch-gate.sh "git commit -m 'then git switch -c feat/x'"
# The same chained creation inside a LINKED worktree is the sanctioned shape.
run_case_cwd "main-tree-branch: chained -c in a worktree" 0 main-tree-branch-gate.sh "$MT_WT" 'git fetch origin && git switch -c feat/x origin/main'
# ...and a `-C` back at the main tree is blocked from anywhere, so the case
# above is passing on the resolved TREE rather than on the command shape.
run_case_cwd "main-tree-branch: -C main tree from a worktree" 2 main-tree-branch-gate.sh "$MT_WT" "git fetch && git -C $repo switch -c feat/x"

# The BLOCKING arms of `verdict_for` had no case at all, which is a one-sided
# fence in the dangerous direction: every pass arm was pinned and every block
# arm was free. Measured before adding these -- deleting the plain-switch arm,
# and deleting the `show-ref` local-branch arm, each left this suite green.
run_case "main-tree-branch: plain switch to a feature branch" 2 main-tree-branch-gate.sh 'git switch feature'
run_case "main-tree-branch: checkout of an existing local branch" 2 main-tree-branch-gate.sh 'git checkout feature'
# ...and its discriminator: a name that is NOT a local branch is a pathspec/sha
# and must pass, so the case above cannot be satisfied by blocking every name.
run_case "main-tree-branch: checkout of a non-branch name passes" 0 main-tree-branch-gate.sh 'git checkout README.md'

# PER-SEGMENT TREE RESOLUTION. `main_tree_of` said "called per matched segment"
# while the tree was in fact resolved ONCE per verb candidate, outside the walk,
# so segment 1 decided every segment. Both directions were live; measured
# against the real main checkout and its real linked worktree, payload cwd = the
# main tree:
#
#   git -C <wt> switch -c a && git switch -c b       rc=0, want 2  BYPASS
#   git -C <wt> checkout -b a && git checkout -b b   rc=0, want 2  BYPASS
#   git switch main && git -C <wt> switch -c a       rc=2, want 0  FALSE BLOCK
run_case "main-tree-branch: worktree segment does not excuse a later main-tree switch" 2 \
  main-tree-branch-gate.sh "git -C $MT_WT switch -c feat/a && git switch -c feat/b"
run_case "main-tree-branch: worktree segment does not excuse a later main-tree checkout" 2 \
  main-tree-branch-gate.sh "git -C $MT_WT checkout -b feat/a && git checkout -b feat/b"
run_case "main-tree-branch: a main-tree segment does not condemn a later worktree one" 0 \
  main-tree-branch-gate.sh "git switch main && git -C $MT_WT switch -c feat/a"
# A `cd` PERSISTS into later segments while a `-C` binds only its own command --
# the two halves of the per-segment resolution, each with its false direction.
run_case "main-tree-branch: cd into a worktree carries into the next segment" 0 \
  main-tree-branch-gate.sh "cd $MT_WT && git switch -c feat/a && git switch -c feat/b"
run_case "main-tree-branch: a -C back at the main tree after that cd still blocks" 2 \
  main-tree-branch-gate.sh "cd $MT_WT && git switch -c feat/a && git -C $repo switch -c feat/b"

# The block MESSAGE names the branch, not the flag: the verdict for
# `git switch --create feat/x` was already right, and the text called the
# branch `--create` -- the name the message then tells you to replay elsewhere.
run_case_msg "main-tree-branch: --create names the branch" 2 main-tree-branch-gate.sh \
  'git switch --create feat/x' "feat/x" "'--create'"
run_case_msg "main-tree-branch: --detach is not a branch name" 2 main-tree-branch-gate.sh \
  'git switch --detach origin/main' "detaches HEAD" "feature branch '--detach'"

# --- ARGUMENT SHAPES THE TWO-TOKEN READING GOT WRONG (2026-09-01) -------------
#
# `verdict_for` read token 1 and token 2 rather than PARSING the options, so a
# leading flag was mistaken for the branch name and a trailing pathspec for a
# switch target. Every wanted verdict below was settled against real git first
# (git 2.53.0), printing HEAD and the local branch list before and after:
#
#   git checkout <branch> -- <paths>  BLOCKED, must not be. It restores FILES;
#     HEAD stayed `main`. The form WITHOUT the `--` behaves identically
#     ("Updated 1 path from ..."), which is why the rule is "two or more
#     positionals is a restore" rather than "a `--` was seen".
#   git checkout -f <branch>          ALLOWED, must not be: `-f` was read AS the
#     branch name and `refs/heads/-f` does not resolve. Measured, it switches.
#   git checkout --orphan <branch>    ALLOWED: `--orphan` read as the name.
#   git checkout - / @{-1}            ALLOWED while `git switch -` blocked.
#   git switch --help                 BLOCKED: it prints text and moves nothing.
run_case "main-tree-branch: <branch> -- <path> is a restore"        0 main-tree-branch-gate.sh 'git checkout feature -- README.md'
run_case "main-tree-branch: <branch> <path> is a restore too"       0 main-tree-branch-gate.sh 'git checkout feature README.md'
run_case "main-tree-branch: checkout -f <branch> blocked"           2 main-tree-branch-gate.sh 'git checkout -f feature'
run_case "main-tree-branch: checkout - blocked"                     2 main-tree-branch-gate.sh 'git checkout -'
run_case "main-tree-branch: checkout @{-1} blocked"                 2 main-tree-branch-gate.sh 'git checkout @{-1}'
run_case "main-tree-branch: switch --help allowed"                  0 main-tree-branch-gate.sh 'git switch --help'
run_case "main-tree-branch: checkout --help allowed"                0 main-tree-branch-gate.sh 'git checkout --help'
run_case "main-tree-branch: checkout -B <branch> blocked"           2 main-tree-branch-gate.sh 'git checkout -B feat/x'
# Under `switch` a leading flag blocks EITHER WAY -- the old reading takes `-f`
# for the branch name and blocks because it is not main/master -- so the exit
# code fences nothing here. The MESSAGE is the product of a block: it names the
# branch to replay elsewhere.
run_case_msg "main-tree-branch: switch -f names the branch, not the flag" 2 main-tree-branch-gate.sh \
  'git switch -f feature' "feature" "feature branch '-f'"
# Assert the whole PHRASE for the create flags. A walk that drops the create
# flag falls through to the positional arm, which ALSO names the branch
# correctly and merely calls the creation a switch -- so a name-only assertion
# is a control, not a fence.
run_case_msg "main-tree-branch: switch --orphan names the branch" 2 main-tree-branch-gate.sh \
  'git switch --orphan feat/x' "creates new feature branch 'feat/x'" "'--orphan'"
run_case_msg "main-tree-branch: checkout --orphan names the branch" 2 main-tree-branch-gate.sh \
  'git checkout --orphan feat/x' "creates new feature branch 'feat/x'" "'--orphan'"
run_case_msg "main-tree-branch: --force-create names the branch" 2 main-tree-branch-gate.sh \
  'git switch --force-create feat/x' "creates new feature branch 'feat/x'" "'--force-create'"

# --- DWIM / --track: a branch that exists only on a REMOTE --------------------
#
# Both shapes CREATE a local branch and switch to it -- measured on a real
# clone, HEAD went `main` -> `feat` with "Switched to a new branch". A local-only
# `show-ref` was blind to the way a lane's branch usually FIRST appears in a
# checkout. The nested case pins the ref PATTERN: `refs/remotes/*/*` does not
# list `origin/topic/nested` because a `*` does not cross a `/` there, and git
# DWIMs it identically.
run_case "main-tree-branch: checkout of a remote-only branch blocked"  2 main-tree-branch-gate.sh 'git checkout remote-only'
run_case "main-tree-branch: checkout of a NESTED remote-only branch"   2 main-tree-branch-gate.sh 'git checkout topic/nested-remote-only'
run_case_msg "main-tree-branch: -t origin/<b> names the LOCAL branch" 2 main-tree-branch-gate.sh \
  'git checkout -t origin/remote-only' "creates new feature branch 'remote-only'" "origin/remote-only'"
run_case_msg "main-tree-branch: --track=direct still names the branch" 2 main-tree-branch-gate.sh \
  'git checkout --track=direct origin/remote-only' "creates new feature branch 'remote-only'" "origin/remote-only'"
# CONTROLS for the DWIM arm. A name on no remote is a pathspec / sha and passes;
# without them, "block any bare token" scores green on the cases above.
run_case "main-tree-branch: a name on no remote either still passes"   0 main-tree-branch-gate.sh 'git checkout remote-onl'
# `refs/remotes/origin/HEAD` renders as the bare word `HEAD` under `lstrip=3`,
# and `git checkout HEAD` creates nothing -- measured, "Your branch is up to
# date", HEAD stayed put. Matching it would refuse a read-only command.
run_case "main-tree-branch: checkout HEAD is not a DWIM create"        0 main-tree-branch-gate.sh 'git checkout HEAD'
run_case "main-tree-branch: checkout HEAD -- <path> allowed"           0 main-tree-branch-gate.sh 'git checkout HEAD -- README.md'

# --- GLUED FLAG SPELLINGS -----------------------------------------------------
#
# git's parse-options accepts a short flag's value GLUED to it and bundles short
# flags: `-bfeat` is `-b feat`, `-qbfeat` is `-q -b feat`. Measured -- each
# printed "Switched to a new branch" and the branch appeared. A walk knowing only
# the SPACED spelling sees one unknown flag, counts zero positionals, and reads
# the command as a bare `git checkout`: allowed.
run_case "main-tree-branch: glued -bfeat blocked"                      2 main-tree-branch-gate.sh 'git checkout -bfeat'
run_case "main-tree-branch: glued -Bfeat blocked"                      2 main-tree-branch-gate.sh 'git checkout -Bfeat'
run_case_msg "main-tree-branch: --orphan=<b> names the branch" 2 main-tree-branch-gate.sh \
  'git checkout --orphan=feat' "creates new feature branch 'feat'" "'--orphan=feat'"
run_case_msg "main-tree-branch: glued -c<b> names the branch" 2 main-tree-branch-gate.sh \
  'git switch -cfeat' "creates new feature branch 'feat'" "'-cfeat'"
run_case_msg "main-tree-branch: glued -C<b> names the branch" 2 main-tree-branch-gate.sh \
  'git switch -Cfeat' "creates new feature branch 'feat'" "'-Cfeat'"
run_case_msg "main-tree-branch: --create=<b> names the branch" 2 main-tree-branch-gate.sh \
  'git switch --create=feat' "creates new feature branch 'feat'" "'--create=feat'"
run_case_msg "main-tree-branch: --force-create=<b> names the branch" 2 main-tree-branch-gate.sh \
  'git switch --force-create=feat' "creates new feature branch 'feat'" "'--force-create=feat'"
run_case_msg "main-tree-branch: bundled -qb<b> names the branch" 2 main-tree-branch-gate.sh \
  'git checkout -qbfeat' "creates new feature branch 'feat'" "'-qbfeat'"
run_case_msg "main-tree-branch: bundled -fb <b> names the branch" 2 main-tree-branch-gate.sh \
  'git checkout -fb feat' "creates new feature branch 'feat'" "'-fb'"

# --- A POSITIONAL COUNT IS NOT A PARSE ----------------------------------------
#
# `git checkout --conflict merge <branch>` SWITCHES -- measured, "Switched to
# branch 'feat'". Counting positionals without consuming a value-taking flag's
# argument counted `merge` as one and read the switch as a restore. The flag list
# comes from `git checkout -h` / `git switch -h`, not from memory;
# `--recurse-submodules` has an OPTIONAL value, so its spaced form must NOT
# consume the branch that follows it.
run_case "main-tree-branch: --conflict <style> <branch> blocked"       2 main-tree-branch-gate.sh 'git checkout --conflict merge feature'
run_case "main-tree-branch: --conflict=<style> <branch> blocked"       2 main-tree-branch-gate.sh 'git checkout --conflict=merge feature'
# `--pathspec-from-file` is a RESTORE marker, not merely a value-taking flag, and
# this row used to pin the opposite: the pathspecs come FROM THE FILE, so the
# trailing token is the tree-ish to restore FROM. Measured with a real one-line
# pathspec file -- "Updated 1 path from <sha>", HEAD stayed on `main`, for both
# the spaced and the `=` spelling.
run_case "main-tree-branch: --pathspec-from-file <f> <branch> is a restore" 0 main-tree-branch-gate.sh 'git checkout --pathspec-from-file /dev/null feature'
run_case "main-tree-branch: --pathspec-from-file=<f> <branch> is a restore" 0 main-tree-branch-gate.sh 'git checkout --pathspec-from-file=/dev/null feature'
run_case "main-tree-branch: --recurse-submodules <branch> blocked"     2 main-tree-branch-gate.sh 'git checkout --recurse-submodules feature'
# CONTROL: consuming a flag value must not turn an ALLOWED target into a block.
run_case "main-tree-branch: --conflict <style> main still allowed"     0 main-tree-branch-gate.sh 'git checkout --conflict merge main'

# --- THE CHECKOUT ERE MUST CARRY THE FLAG RUN ---------------------------------
#
# Every checkout case above puts the DECISIVE segment in a `git checkout ...`
# with no leading `git -C <path>`, so dropping `${GATE_FLAGS}` from
# `GATE_RE_GIT_CHECKOUT` was invisible: measured, that mutation left the whole
# suite green while `git -C <main> checkout -b x` run from a worktree went from
# rc=2 to rc=0. These make a `-C`-carrying checkout the ONLY matching segment,
# with the false-block control aimed at the worktree.
run_case_cwd "main-tree-branch: -C main tree checkout -b from a worktree" 2 \
  main-tree-branch-gate.sh "$MT_WT" "git -C $repo checkout -b feat/x"
run_case_cwd "main-tree-branch: -C main tree checkout <branch> from a worktree" 2 \
  main-tree-branch-gate.sh "$MT_WT" "git -C $repo checkout feature"
run_case "main-tree-branch: -C worktree checkout -b from the main tree" 0 \
  main-tree-branch-gate.sh "git -C $MT_WT checkout -b feat/x"

# --- A QUOTED BRANCH NAME, AND THE PREVIOUS-BRANCH MESSAGE --------------------
#
# The branch name used to come out of a COLLAPSED quoted span, so
# `git switch "main"` compared `"main"` (quotes included) against `main` and
# FALSE-BLOCKED, while `git checkout "feature"` failed
# `show-ref refs/heads/"feature"` and PASSED. Measured against the pre-fix hook
# in the real main checkout: rc=2 and rc=0 respectively. The option parse keeps a
# quoted span as ONE token and unquotes it, so both directions are now right --
# and dropping the unquote left this whole suite green until these landed.
run_case "main-tree-branch: quoted main allowed"                       0 main-tree-branch-gate.sh 'git switch \"main\"'
run_case "main-tree-branch: single-quoted main allowed"                0 main-tree-branch-gate.sh "git switch 'main'"
run_case "main-tree-branch: quoted local branch blocked"               2 main-tree-branch-gate.sh 'git checkout \"feature\"'
run_case_msg "main-tree-branch: -c \"<name with a space>\" kept whole" 2 main-tree-branch-gate.sh \
  'git switch -c \"wt feat new\"' "creates new feature branch 'wt feat new'"
# `git switch @{-1}` blocked before this only by falling through the catch-all,
# which names it a feature branch rather than the previous one; the exit code
# cannot tell the two apart, so the MESSAGE is the fence.
run_case_msg "main-tree-branch: switch @{-1} is the previous branch" 2 main-tree-branch-gate.sh \
  'git switch @{-1}' "previous branch"

# --- RESTORE MODES MUST NOT BE BLOCKED ----------------------------------------
#
# `-p` / `--ours` / `--theirs` restore FILES -- measured, `git checkout -p feat`
# printed a diff and left HEAD on `main`, and `--ours` / `--theirs` are refused
# outright without paths. Blocking them is the same false block as the
# `<branch> -- <paths>` one, and it is exactly what the naive fix for the `-f`
# defect ("any single positional after flags is a switch target") introduces.
# The header used to sit ~40 lines above with no cases under it at all.
#
# The PATHSPEC in the last four is a real LOCAL BRANCH NAME on purpose. With
# `README.md` the `--ours` / `--theirs` rows were vacuous -- deleting them from
# the restore list left the suite green, because `README.md` resolves to no
# branch and the command passed on the ordinary "not a branch" arm.
run_case "main-tree-branch: checkout -p <branch> is a restore"         0 main-tree-branch-gate.sh 'git checkout -p feature'
run_case "main-tree-branch: checkout --patch <branch> is a restore"    0 main-tree-branch-gate.sh 'git checkout --patch feature'
run_case "main-tree-branch: checkout --ours <branch-named path>"       0 main-tree-branch-gate.sh 'git checkout --ours feature'
run_case "main-tree-branch: checkout --theirs <branch-named path>"     0 main-tree-branch-gate.sh 'git checkout --theirs feature'
run_case "main-tree-branch: checkout -2 <branch-named path>"           0 main-tree-branch-gate.sh 'git checkout -2 feature'
run_case "main-tree-branch: checkout -3 <branch-named path>"           0 main-tree-branch-gate.sh 'git checkout -3 feature'

# --- SHELL WORDS ARE NOT ARGUMENTS --------------------------------------------
#
# `gate_tokens` splits SHELL WORDS, and a redirection, a trailing `&` and a `#`
# comment are all words the SHELL owns -- git never sees any of them. Feeding
# them to an option parse inflated the positional count and read a real switch as
# a file restore. Every command below moves HEAD for real (measured against git
# 2.53.0 with HEAD printed before and after: `main` -> `feature`, and
# `main` -> `other` for the `-` one), and the first three were scored rc=0 by the
# gate while its own `origin/main` predecessor scored them 2 -- a REGRESSION.
run_case "git checkout <branch> 2>/dev/null blocked" 2 main-tree-branch-gate.sh \
  'git checkout feature 2>/dev/null'
run_case "git checkout <branch> >/dev/null 2>&1 blocked" 2 main-tree-branch-gate.sh \
  'git checkout feature >/dev/null 2>&1'
run_case "git checkout <branch> # <comment> blocked" 2 main-tree-branch-gate.sh \
  'git checkout feature # switch lane'
run_case "git checkout -q <branch> 2>&1 blocked" 2 main-tree-branch-gate.sh \
  'git checkout -q feature 2>&1'
run_case "git checkout - 2>/dev/null blocked" 2 main-tree-branch-gate.sh \
  'git checkout - 2>/dev/null'
# The SPACED redirection target is a separate word and must be dropped WITH its
# operator; dropping only the `>` leaves `/dev/null` as a phantom pathspec.
run_case "git checkout <branch> > /dev/null (spaced target) blocked" 2 main-tree-branch-gate.sh \
  'git checkout feature > /dev/null'
run_case "git checkout <branch> 2>>log blocked" 2 main-tree-branch-gate.sh \
  'git checkout feature 2>>log'
# CONTROL, and it is what stops "drop every word after the first positional":
# a real restore beside a redirection must STILL pass.
run_case "git checkout <branch> -- <path> 2>/dev/null still allowed" 0 main-tree-branch-gate.sh \
  'git checkout feature -- README.md 2>/dev/null'
run_case "git checkout <branch> <path> # <comment> still allowed" 0 main-tree-branch-gate.sh \
  'git checkout feature README.md # restore one file'
# A QUOTED `#` is an argument, not a comment, so a branch name that starts with
# one must still be judged rather than swallowed.
run_case "git checkout '#not-a-comment' allowed (quoted # is an argument)" 0 main-tree-branch-gate.sh \
  "git checkout '#not-a-comment'"

# --- A `--` WITH NOTHING AFTER IT IS NOT A PATHSPEC ---------------------------
#
# Measured: `git checkout feature --` prints "Switched to branch
# 'feature'" and HEAD moves, while `git checkout feature -- f.txt`
# updates the file and HEAD stays. So the rule is "a pathspec OPERAND exists",
# not "a `--` was seen" -- the reading that shipped one fix earlier.
run_case "git checkout <branch> -- (nothing after) blocked" 2 main-tree-branch-gate.sh \
  'git checkout feature --'
run_case "git checkout main -- (nothing after) allowed" 0 main-tree-branch-gate.sh \
  'git checkout main --'
run_case "git checkout -- (no positional at all) allowed" 0 main-tree-branch-gate.sh \
  'git checkout --'
# `git switch` has NO pathspec form (`usage: git switch [<options>] [<branch>]`),
# so `--` there only ends the options. Measured: `git switch -- main` prints
# "Already on 'main'" and `git switch -- feature` switches. Applying
# checkout's grammar to both verbs made the first a FALSE BLOCK ("no resolvable
# target") in all three repos, including the `origin/main` predecessor.
run_case "git switch -- main allowed (switch has no pathspec form)" 0 main-tree-branch-gate.sh \
  'git switch -- main'
run_case "git switch -- <feature> blocked (it really switches)" 2 main-tree-branch-gate.sh \
  'git switch -- feature'

# --- GIT ACCEPTS UNAMBIGUOUS PREFIXES OF A LONG NAME --------------------------
#
# `git checkout -h` does not show it, but git's parse-options resolves any
# unambiguous prefix. Measured: `--orph newb` and `--or newb` both print
# "Switched to a new branch 'newb'"; `--trac origin/remote-only` creates local
# `remote-only`; `git switch --creat newb` creates `newb`. All four scored rc=0
# against the gate before the option table carried the whole grammar.
run_case_msg "git checkout --orph <b> blocked (prefix of --orphan)" 2 main-tree-branch-gate.sh \
  'git checkout --orph newb' "creates new feature branch 'newb'"
run_case_msg "git checkout --or <b> blocked (shortest unambiguous prefix)" 2 main-tree-branch-gate.sh \
  'git checkout --or newb' "creates new feature branch 'newb'"
run_case_msg "git checkout --trac <remote-ref> blocked (prefix of --track)" 2 main-tree-branch-gate.sh \
  'git checkout --trac origin/remote-only' "creates new feature branch 'remote-only'"
run_case_msg "git switch --creat <b> blocked (prefix of --create)" 2 main-tree-branch-gate.sh \
  'git switch --creat newb' "creates new feature branch 'newb'"
# The prefix table has to work in the ALLOW direction too, or it is only a
# fail-closed accident: both of these resolve to a restore / a no-DWIM read and
# must pass. Without prefix resolution they would be unknown options and block.
run_case "git checkout --pathspec-from-f <f> <branch> allowed (prefix, restore)" 0 main-tree-branch-gate.sh \
  'git checkout --pathspec-from-f /dev/null feature'
run_case "git checkout --no-gu <remote-only> allowed (prefix of --no-guess)" 0 main-tree-branch-gate.sh \
  'git checkout --no-gu remote-only'

# --- AN OPTION THE GRAMMAR CANNOT RESOLVE MAY NOT ALLOW -----------------------
#
# The general form of the two defects a positional COUNT produced: an unmodelled
# flag moves every positional after it, so the walk does not know where the
# switch target is. Every ALLOWING arm depends on that knowledge and the blocking
# arms do not, so an unresolved option blocks. Today it fires only on commands
# git itself refuses -- measured, `--creat` under checkout is "error: unknown
# option `creat'" and `--pat` is "error: ambiguous option: pat" -- so it costs
# nothing now; it is what keeps a FUTURE git option from re-opening the hole.
run_case_msg "git checkout --frobnicate main blocked (unknown long option)" 2 main-tree-branch-gate.sh \
  'git checkout --frobnicate main' "cannot resolve"
run_case_msg "git checkout --pat main blocked (AMBIGUOUS prefix)" 2 main-tree-branch-gate.sh \
  'git checkout --pat main' "cannot resolve"
run_case_msg "git checkout -Z main blocked (unknown short letter)" 2 main-tree-branch-gate.sh \
  'git checkout -Z main' "cannot resolve"
run_case_msg "git checkout --creat main blocked (switch-only name under checkout)" 2 main-tree-branch-gate.sh \
  'git checkout --creat main' "cannot resolve"
# CONTROLS: a KNOWN option beside `main` must still pass, in the long, the
# negated and the short spelling. Without these, "block whenever any flag is
# present" scores green on the four cases above.
run_case "git checkout --quiet main allowed" 0 main-tree-branch-gate.sh \
  'git checkout --quiet main'
run_case "git checkout --no-overwrite-ignore main allowed (negated form)" 0 main-tree-branch-gate.sh \
  'git checkout --no-overwrite-ignore main'
run_case "git checkout -q main allowed" 0 main-tree-branch-gate.sh \
  'git checkout -q main'
run_case "git switch --discard-changes main allowed (switch-only name)" 0 main-tree-branch-gate.sh \
  'git switch --discard-changes main'

# --- EVERY VALUE-TAKING FLAG, NOT A SAMPLE OF THE ARM -------------------------
#
# `--conflict` and `--pathspec-from-file` had cases while `--unified` and
# `--inter-hunk-context` -- the other two members of the same arity class under
# `checkout` -- had none, and `-U` had none either. A value-taking flag with no
# case is an untested member of a class that has produced three defects. Each
# command below really switches (the flag's value is consumed by git, so the
# trailing name is the branch); if the table gives the flag arity 0 instead, the
# value becomes a phantom positional and the command reads as a restore.
run_case "git checkout --unified 3 <branch> blocked (value consumed)" 2 main-tree-branch-gate.sh \
  'git checkout --unified 3 feature'
run_case "git checkout --unified=3 <branch> blocked (glued value)" 2 main-tree-branch-gate.sh \
  'git checkout --unified=3 feature'
run_case "git checkout --inter-hunk-context 2 <branch> blocked (value consumed)" 2 main-tree-branch-gate.sh \
  'git checkout --inter-hunk-context 2 feature'
run_case "git checkout -U 3 <branch> blocked (short value consumed)" 2 main-tree-branch-gate.sh \
  'git checkout -U 3 feature'
run_case "git checkout -U3 <branch> blocked (short glued value)" 2 main-tree-branch-gate.sh \
  'git checkout -U3 feature'
run_case "git switch --conflict merge <branch> blocked (value consumed)" 2 main-tree-branch-gate.sh \
  'git switch --conflict merge feature'
# ...and the CONTROL for the whole arity class: an ALLOWED command must not be
# turned into a block by the consumption. `git checkout --unified 3 main` really
# stays on main.
run_case "git checkout --unified 3 main allowed" 0 main-tree-branch-gate.sh \
  'git checkout --unified 3 main'

# --- OPTIONAL-VALUE FLAGS CONSUME NOTHING -------------------------------------
#
# `-t` / `--track` / `--recurse-submodules` take an OPTIONAL value, so the SPACED
# form does NOT eat the next token -- measured, `git checkout -t
# origin/remote-only` creates local `remote-only`, i.e. the ref is a start-point
# POSITIONAL. The glued and `=` spellings were fenced; the SPACED `--track` was
# not.
run_case_msg "git checkout --track <remote-ref> (spaced) blocked" 2 main-tree-branch-gate.sh \
  'git checkout --track origin/remote-only' "creates new feature branch 'remote-only'"
run_case_msg "git switch --track <remote-ref> (spaced) blocked" 2 main-tree-branch-gate.sh \
  'git switch --track origin/remote-only' "creates new feature branch 'remote-only'"

# --- THE DWIM LIST IS THE CONFIGURED REMOTES, STRIPPED PER REMOTE -------------
#
# A remote NAME may contain a slash, so a fixed `lstrip=3` is wrong: `deep-only`
# on remote `a/b` lstrips to `b/deep-only` while git DWIMs plain `deep-only`
# (measured: "Switched to a new branch 'deep-only'", HEAD moved) -- a FAIL-OPEN.
# And a ref under a remote that is not CONFIGURED is not DWIMmed at all
# (measured: "pathspec 'ghost' did not match any file(s) known to git", HEAD
# stays) -- a FALSE BLOCK for a `refs/remotes/` scan.
run_case "git checkout <branch on a SLASH-named remote> blocked" 2 main-tree-branch-gate.sh \
  'git checkout deep-only'
run_case "git checkout <ref under an UNCONFIGURED remote> allowed" 0 main-tree-branch-gate.sh \
  'git checkout ghost'
# `--no-guess` turns the DWIM off, so git answers "pathspec did not match" and
# HEAD stays -- measured against the SAME name that moves HEAD without the flag.
# It does not disable the LOCAL branch lookup: `--no-guess feature` switches.
run_case "git checkout --no-guess <remote-only> allowed" 0 main-tree-branch-gate.sh \
  'git checkout --no-guess remote-only'
run_case "git checkout --no-guess <local branch> still blocked" 2 main-tree-branch-gate.sh \
  'git checkout --no-guess feature'
run_case "git checkout --guess <remote-only> blocked (the default)" 2 main-tree-branch-gate.sh \
  'git checkout --guess remote-only'
run_case "git checkout --no-guess --guess <remote-only> blocked (last wins)" 2 main-tree-branch-gate.sh \
  'git checkout --no-guess --guess remote-only'

# --- A BLOCK MUST NOT NAME AN OPERATION GIT WILL NOT PERFORM ------------------
#
# `git checkout -d <branch>` / `--detach <branch>` DETACHES (measured: HEAD went
# to a raw sha, not to the branch), and the block announced it as "switches to
# feature branch '<b>'". The VERDICT was right and is unchanged; the wording was
# describing something git does not do.
run_case_msg "git checkout -d <local branch> is reported as a detach" 2 main-tree-branch-gate.sh \
  'git checkout -d feature' "detaches HEAD" "switches to feature branch"
run_case_msg "git checkout --detach <local branch> is reported as a detach" 2 main-tree-branch-gate.sh \
  'git checkout --detach feature' "detaches HEAD" "switches to feature branch"
run_case_msg "git checkout --detach <remote-only> is reported as a detach" 2 main-tree-branch-gate.sh \
  'git checkout --detach remote-only' "detaches HEAD" "switches to it"
# The `d` cluster letter under SWITCH had no case either, only the long spelling.
run_case_msg "git switch -d blocked and reported as a detach" 2 main-tree-branch-gate.sh \
  'git switch -d' "detaches HEAD"
# The documented ASYMMETRY, kept deliberately: the sha form under checkout passes.
run_case "git checkout --detach <sha> allowed (documented asymmetry)" 0 main-tree-branch-gate.sh \
  "git checkout --detach $MT_SHA"

# --- A BARE `git switch` ------------------------------------------------------
#
# A git error, but blocked conservatively rather than reasoned about. It had no
# case, so deleting the arm was invisible.
run_case_msg "bare git switch blocked conservatively" 2 main-tree-branch-gate.sh \
  'git switch' "no resolvable target"

# --- AN UNSPLITTABLE ARGUMENT LIST IS REFUSED, NOT TRUNCATED ------------------
#
# An UNBALANCED quote cannot be split into shell words at all, and the splitter
# used to return the prefix it managed silently: `-b agent's-branch` yielded the
# single token `-b`, which read as a bare `git checkout` and PASSED -- a
# FAIL-OPEN on a command that creates a branch (measured: `git checkout -b
# agent\'s-br` prints "Switched to a new branch 'agent's-br'"). Refusing is the
# deliberate choice: the text is a shell syntax error in the first place
# (measured: "unexpected EOF while looking for matching `''").
run_case_msg "git checkout -b <unbalanced quote> blocked, not truncated" 2 main-tree-branch-gate.sh \
  "git checkout -b agent's-branch" "unbalanced quote"
run_case_msg "git checkout <branch>'s blocked (fails CLOSED)" 2 main-tree-branch-gate.sh \
  "git checkout feature's" "unbalanced quote"
# CONTROL: a BALANCED quote around a name with an apostrophe in it is ordinary
# and must reach the normal arms, not the refusal.
run_case "git checkout \"main\" (balanced quotes) still allowed" 0 main-tree-branch-gate.sh \
  'git checkout \"main\"'

# --- FAIL-CLOSED on a library that predates GATE_EMBEDDING_TOKEN --------------
#
# The option parse interpolates that CONSTANT into its `[[ =~ ]]`. A library
# without it leaves the pattern EMPTY, the match then succeeds on any input with
# `${BASH_REMATCH[1]}` empty, and the walk yields NO tokens -- so every command
# looks like a bare `git checkout` and PASSES. `declare -F` cannot see a missing
# constant, which is why the gate's guard names it separately.
mtbg_const_guard() {
  local tmp out rc
  tmp=$(mktemp -d)
  cp "$HOOKS"/*.sh "$tmp/" 2>/dev/null
  grep -v '^GATE_EMBEDDING_TOKEN=' "$HOOKS/_command-match.sh" > "$tmp/_command-match.sh"
  out=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"git switch -c feat/x"}}' "$repo" \
    | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 "$tmp/main-tree-branch-gate.sh" 2>&1); rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF 'GATE_EMBEDDING_TOKEN'; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "main-tree-branch: no GATE_EMBEDDING_TOKEN fails closed" "(exit $rc)"
  else
    fail=$((fail + 1)); printf 'FAIL main-tree-branch: must exit 2 naming GATE_EMBEDDING_TOKEN (got %s)\n  out: %s\n' "$rc" "$out"
  fi
}
mtbg_const_guard


# post-merge-orphan-push-gate blocks a push to a branch whose PR already merged.
# Same defect as main-tree-branch-gate above and fixed the same way: it read the
# remote/branch off the WHOLE COMMAND with a leftmost-longest `=~ [[:space:]]push
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


# markgate-pipe-gate guards the two markgate VERDICT verbs, and only when their
# exit status feeds a pipe (go-to-k/cdk-local#571). Driven through the real hook
# here, in addition to markgate-pipe-gate.test.sh, for the cross-gate property
# this file exists for: a gate that sources the matcher and then asks the WRONG
# question. Note this gate NEVER runs markgate -- MARKGATE_RC is irrelevant to
# it, which is itself the reason a piped verdict is un-catchable at runtime and
# has to be caught statically.
run_case "markgate-pipe: verify piped to tail"  2 markgate-pipe-gate.sh 'mise exec -- markgate verify integ 2>&1 | tail -5'
run_case "markgate-pipe: set piped to tee"      2 markgate-pipe-gate.sh 'mise exec -- markgate set integ | tee /tmp/l'
run_case "markgate-pipe: un-piped verify"       0 markgate-pipe-gate.sh 'mise exec -- markgate verify integ >/dev/null 2>&1; rc=$?'
run_case "markgate-pipe: || is not a pipe"      0 markgate-pipe-gate.sh 'mise exec -- markgate set integ || echo NOPE'
run_case "markgate-pipe: status may be piped"   0 markgate-pipe-gate.sh 'mise exec -- markgate status integ | awk /state/'
run_case "markgate-pipe: unrelated pipe"        0 markgate-pipe-gate.sh 'git status --short | head'
run_case "markgate-pipe: quoted mention"        0 markgate-pipe-gate.sh 'echo \"markgate verify integ | tail\"'
run_case "markgate-pipe: run is a verdict verb"  2 markgate-pipe-gate.sh 'mise exec -- markgate run check -- vp run check | tail -5'
run_case "markgate-pipe: grepping for the form" 0 markgate-pipe-gate.sh 'mise exec -- rg markgate verify .claude | head'
# ...and the other direction: a piped markgate is not any OTHER gate's business.
# Without this, moving the check into (say) check-gate would look identical.
run_case "check-gate: piped markgate is not its verb"  0 check-gate.sh 'mise exec -- markgate verify integ | tail -5'
run_case "verify-pr-gate: piped markgate is not its verb" 0 verify-pr-gate.sh 'mise exec -- markgate verify integ | tail -5'

# --- a repo/dir FLAG must not change any gate's verdict ----------------------
# `gh -R <owner/repo> pr merge 1 --squash` matched NOTHING until 2026-08-25,
# because GATE_GH_C absorbed `-C <path>` only, so it MERGED PAST verify-pr-gate
# and integ-gate while the identical command without the flag was refused
# (verify-pr-gate 2 -> 0 on both `pr merge` and `pr create`; integ-gate 2 -> 0).
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
# The three pairs that actually discriminate under this harness, each pinned to
# the refusing rc so they cannot go vacuous.
run_pair "verify-pr-gate: -R pr merge"  verify-pr-gate.sh "gh pr merge 1 --squash" "gh -R $R pr merge 1 --squash" 2
run_pair "verify-pr-gate: -R pr create" verify-pr-gate.sh "gh pr create --fill"    "gh -R $R pr create --fill"    2
run_pair "integ-gate: -R pr merge"      integ-gate.sh     "gh pr merge 1 --squash" "gh -R $R pr merge 1 --squash" 2
run_pair "issue-dup-gate: -R issue create" issue-dup-check-gate.sh \
  "gh issue create -t x --body-file /nope.md" "gh -R $R issue create -t x --body-file /nope.md" 2
run_pair "verify-pr-gate: --repo pr merge" verify-pr-gate.sh "gh pr merge 1 --squash" "gh --repo $R pr merge 1 --squash" 2
run_pair "verify-pr-gate: -C then -R"      verify-pr-gate.sh "gh pr merge 1 --squash" "gh -C $repo -R $R pr merge 1 --squash" 2
# ...and the REVERSED order, which is the one that broke: the `-C` scan required
# `-C` immediately after `gh`, so `gh -R o/r -C <dir> …` resolved to the payload
# cwd instead of <dir>. With a STALE marker in the -C target that returned rc=0
# -- the merge judged against a different worktree's marker. Only the working
# order was tested here before.
run_pair "verify-pr-gate: -R then -C"      verify-pr-gate.sh "gh pr merge 1 --squash" "gh -R $R -C $repo pr merge 1 --squash" 2
run_pair "verify-pr-gate: --repo= then -C" verify-pr-gate.sh "gh pr merge 1 --squash" "gh --repo=$R -C $repo pr merge 1 --squash" 2
run_pair "verify-pr-gate: -R then -C="     verify-pr-gate.sh "gh pr merge 1 --squash" "gh -R $R -C=$repo pr merge 1 --squash" 2
run_pair "integ-gate: -R then -C"          integ-gate.sh     "gh pr merge 1 --squash" "gh -R $R -C $repo pr merge 1 --squash" 2
# ALL THREE separators `gh` accepts. The `=` and GLUED forms are not exotic:
# `gh pr list --repo=<o/r>`, `-R=<o/r>` and `-R<o/r>` all work against a real
# repo. An explicit flag alternation absorbed only the space form, so these were
# still merging past verify-pr-gate one keystroke after the space form was
# fixed -- and the glued form is the one a hand-written alternation misses,
# since it has no separator at all.
run_pair "verify-pr-gate: --repo=<repo>"   verify-pr-gate.sh "gh pr merge 1 --squash" "gh --repo=$R pr merge 1 --squash" 2
run_pair "verify-pr-gate: -R=<repo>"       verify-pr-gate.sh "gh pr merge 1 --squash" "gh -R=$R pr merge 1 --squash" 2
run_pair "verify-pr-gate: -R<repo> glued"  verify-pr-gate.sh "gh pr merge 1 --squash" "gh -R$R pr merge 1 --squash" 2
run_pair "verify-pr-gate: -C=<path>"       verify-pr-gate.sh "gh pr merge 1 --squash" "gh -C=$repo pr merge 1 --squash" 2
run_pair "integ-gate: -R<repo> glued"      integ-gate.sh     "gh pr merge 1 --squash" "gh -R$R pr merge 1 --squash" 2
run_pair "integ-gate: --repo=<repo>"       integ-gate.sh     "gh pr merge 1 --squash" "gh --repo=$R pr merge 1 --squash" 2
run_pair "issue-dup-gate: -R<repo> glued"  issue-dup-check-gate.sh \
  "gh issue create -t x --body-file /nope.md" "gh -R$R issue create -t x --body-file /nope.md" 2
run_pair "issue-dup-gate: --repo=<repo>"   issue-dup-check-gate.sh \
  "gh issue create -t x --body-file /nope.md" "gh --repo=$R issue create -t x --body-file /nope.md" 2
# The remaining gh gates fail open under the stubbed `gh`, so these pairs are
# equal at 0 and are kept as REGRESSION cases only -- deliberately WITHOUT a
# discriminating rc, because there is none to assert here. They still catch a
# widening that makes one spelling throw where the other does not.
run_pair "pr-review-gate: -R pr merge"     pr-review-gate.sh     "gh pr merge 1 --squash" "gh -R $R pr merge 1 --squash"
run_pair "closes-paren-gate: -R pr merge"  closes-paren-form-gate.sh "gh pr merge 1 --squash" "gh -R $R pr merge 1 --squash"
# CONTROLS, not fences -- say so rather than let the count imply coverage. Both
# gates answer 0 to either spelling under the stubbed `gh`, so the equality is
# satisfied trivially and proves only that the flag introduces no new error.
# Unlike verify-pr-gate / integ-gate they have no rc that discriminates here, so
# they get no expected-plain-rc argument; what DOES fence their target-dir
# resolution is run_dir below, which asserts the directory they consult.
run_pair "cdkd-parity-gate: -R pr create (control)"  cdkd-parity-gate.sh   "gh pr create --fill" "gh -R $R pr create --fill"
run_pair "create-integ-gate: -R pr create (control)" create-integ-gate.sh  "gh pr create --fill" "gh -R $R pr create --fill"

# --- the DIRECTORY a gate consults, for the gates whose rc cannot show it ----
# `markgate` is asked from inside the resolved target dir, so logging its $PWD
# is a direct read of gate_target_dir's answer through the real hook. This is
# what covers cdkd-parity-gate / create-integ-gate, whose exit codes are equal
# either way, and it is the assertion that would have caught the `-C` order bug
# for them.
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
run_dir "verify-pr-gate: no -C uses the payload cwd" verify-pr-gate.sh "gh $verb"                     "$repo"
run_dir "verify-pr-gate: -C only"                    verify-pr-gate.sh "gh -C $other $verb"           "$other"
run_dir "verify-pr-gate: -C then -R"                 verify-pr-gate.sh "gh -C $other -R $R $verb"     "$other"
run_dir "verify-pr-gate: -R then -C"                 verify-pr-gate.sh "gh -R $R -C $other $verb"     "$other"
run_dir "verify-pr-gate: --repo= then -C"            verify-pr-gate.sh "gh --repo=$R -C $other $verb" "$other"
run_dir "verify-pr-gate: -R then -C="                verify-pr-gate.sh "gh -R $R -C=$other $verb"     "$other"
run_dir "verify-pr-gate: -C after the verb is ignored" verify-pr-gate.sh "gh $verb -C $other"         "$repo"

# cdkd-parity-gate / create-integ-gate DO expose the directory they resolved --
# on their first `git -C "$target_dir" rev-parse --git-dir`, long before
# markgate. An earlier revision of this file recorded "(never asked)" for them
# and called the coverage impossible; that was wrong, and the comment saying so
# is exactly what would have stopped the next person from adding this. Read the
# `git -C` argument instead.
#
# run_git_dir <name> <hook> <cmd> <expected -C argument>
run_git_dir() {
  local name="$1" hook="$2" cmd="$3" want="$4" got
  : > "$TMPDIR/git.log"
  printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd" \
    | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 GIT_LOG="$TMPDIR/git.log" \
      "$HOOKS/$hook" >/dev/null 2>&1
  got=$(grep -oE '^-C [^ ]+' "$TMPDIR/git.log" | head -1 | awk '{print $2}')
  [ -z "$got" ] && got="(never asked)"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(git -C $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (git -C %s, expected %s)\n' "$name" "$got" "$want"
  fi
}

for g in cdkd-parity-gate.sh create-integ-gate.sh; do
  run_git_dir "$g: no -C uses the payload cwd" "$g" "gh pr create --fill"                     "$repo"
  run_git_dir "$g: -C only"                    "$g" "gh -C $other pr create --fill"           "$other"
  run_git_dir "$g: -C then -R"                 "$g" "gh -C $other -R $R pr create --fill"     "$other"
  run_git_dir "$g: -R then -C"                 "$g" "gh -R $R -C $other pr create --fill"     "$other"
  run_git_dir "$g: --repo= then -C"            "$g" "gh --repo=$R -C $other pr create --fill" "$other"
  run_git_dir "$g: -R then -C="                "$g" "gh -R $R -C=$other pr create --fill"     "$other"
done

# --- WHICH MARKER a gate verifies -------------------------------------------
# The same lens as run_sel, turned on markgate instead of gh. Swapping
# verify-pr-gate's `verify verify-pr` for `verify check` is a LIVE BYPASS -- the
# PR merges whenever `/check` alone is fresh -- and it left the suite green.
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

run_marker "verify-pr-gate verifies verify-pr" verify-pr-gate.sh "gh pr merge 1 --squash"   verify-pr
run_marker "verify-pr-gate on pr create"       verify-pr-gate.sh "gh pr create --fill"      verify-pr
run_marker "integ-gate verifies integ"         integ-gate.sh     "gh pr merge 1 --squash"   integ
run_marker "check-gate verifies check"         check-gate.sh     "git commit -m x"          check

# --- the RESOLVED SELECTOR, not just the exit code --------------------------
# Equal exit codes cannot tell "resolved the same PR" from "both failed
# differently", and that gap is where three live bypasses lived: widening
# GATE_GH_C made the flagged commands REACH these gates, but each then extracted
# its PR number with the same `-C`-only shape the absorber had outgrown.
# Measured before the fix, against `gh -R go-to-k/cdk-local pr merge 552`:
#
#   closes-paren-form-gate   gh never called at all (plain form: `pr view 552`)
#   non-english-text-gate    `pr diff 999` -- the CURRENT BRANCH's PR
#   docs-inline-json-flag    `pr diff 999` -- likewise
#   pr-review-gate           `pr view 30` from `sleep 30 && gh -R … merge 552`
#
# So assert what the gate ASKED GITHUB ABOUT. The shim answers 999 to
# `pr view --json number`, so a fall-through to current-branch resolution shows
# up as a wrong number rather than as silence.
#
# run_sel <name> <hook> <cmd> <expected-pr-number>
run_sel() {
  local name="$1" hook="$2" cmd="$3" want="$4" log got
  log="$TMPDIR/gh.log"; : > "$log"
  printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd" \
    | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 GH_LOG="$log" "$HOOKS/$hook" >/dev/null 2>&1
  got=$(grep -oE 'pr (view|diff) [0-9]+' "$log" | head -1 | grep -oE '[0-9]+$')
  [ -z "$got" ] && got="none"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(resolved PR $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (resolved PR %s, expected %s)\n' "$name" "$got" "$want"
  fi
}

# Every spelling must resolve the SAME PR the plain form does. The plain arm of
# each group is the control: if it stops resolving 552 the group is broken
# rather than passing vacuously.
for gate in closes-paren-form-gate.sh non-english-text-gate.sh \
            docs-inline-json-flag-gate.sh pr-review-gate.sh; do
  run_sel "$gate: plain"        "$gate" "gh pr merge 552 --squash"          552
  run_sel "$gate: -R <repo>"    "$gate" "gh -R $R pr merge 552 --squash"    552
  run_sel "$gate: --repo=<repo>" "$gate" "gh --repo=$R pr merge 552 --squash" 552
  run_sel "$gate: -R<repo> glued" "$gate" "gh -R$R pr merge 552 --squash"   552
  # A leading numeric token must not be read as the selector.
  run_sel "$gate: numeric token before the verb" "$gate" \
    "sleep 30 && gh -R $R pr merge 552 --squash" 552
  # Flag VALUES must not be read as the selector either.
  run_sel "$gate: -d before the number" "$gate" "gh -R $R pr merge -d 552" 552
done

# --- WHICH REPO the gate asks about -----------------------------------------
# The fourth blind spot, and the one no existing helper could see: `run_sel`
# greps the NUMBER out of the gh log and ignores `-R`, so
# `gh -R go-to-k/OTHER pr merge 552` looked identical to the correct case in
# both exit code and selector while every gate asked the LOCAL repo about ITS
# PR 552. Right number, wrong repo. Assert the repo the gate names.
#
# run_repo <name> <hook> <cmd> <expected --repo value, or "(local)">
run_repo() {
  local name="$1" hook="$2" cmd="$3" want="$4" log got
  log="$TMPDIR/gh.log"; : > "$log"
  printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$cmd" \
    | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 GH_LOG="$log" "$HOOKS/$hook" >/dev/null 2>&1
  got=$(grep -oE '\-\-repo [^ ]+' "$log" | head -1 | awk '{print $2}')
  [ -z "$got" ] && got="(local)"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$name" "(asked $got)"
  else
    fail=$((fail + 1)); printf 'FAIL %s (asked %s, expected %s)\n' "$name" "$got" "$want"
  fi
}

for gate in closes-paren-form-gate.sh non-english-text-gate.sh \
            docs-inline-json-flag-gate.sh pr-review-gate.sh; do
  run_repo "$gate: no -R asks the local repo" "$gate" "gh pr merge 552 --squash"            "(local)"
  run_repo "$gate: -R is passed through"      "$gate" "gh -R go-to-k/OTHER pr merge 552"    "go-to-k/OTHER"
  run_repo "$gate: --repo= is passed through" "$gate" "gh --repo=go-to-k/OTHER pr merge 552" "go-to-k/OTHER"
  run_repo "$gate: -R after the verb"         "$gate" "gh pr merge -R go-to-k/OTHER 552"    "go-to-k/OTHER"
done

# --- the `gate_pr_selector` fail-closed arms --------------------------------
# Four gates refuse when the shared library predates the shared PR-selector
# extractor, because an undefined function returns an EMPTY selector and the
# gate would silently judge the wrong PR (or none) instead of declining. That
# guard had zero cases: flipping all four to `exit 0` was green, so the commit
# asserted it rather than measuring it.
#
# The library here defines `gate_matches` and the GATE_RE_* constants but NOT
# `gate_pr_selector`, which is exactly the "older library" shape.
selector_guard() {
  local hook="$1" tmp out rc
  tmp=$(mktemp -d)
  cp "$HOOKS"/*.sh "$tmp/" 2>/dev/null
  # strip the helper, keeping everything else loadable
  python3 - "$tmp/_command-match.sh" <<'STRIP'
import io,sys,re
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
a=s.index('gate_pr_selector() {')
b=s.index('\n}\n', a)+3
io.open(p,'w',encoding='utf-8').write(s[:a]+s[b:])
STRIP
  out=$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"gh pr merge 1 --squash"}}' "$repo" \
    | env PATH="$SHIM:/usr/bin:/bin" MARKGATE_RC=1 "$tmp/$hook" 2>&1); rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF "gate_pr_selector"; then
    pass=$((pass + 1)); printf 'OK   %-46s %s\n' "$hook: fails closed without gate_pr_selector" "(exit $rc)"
  else
    fail=$((fail + 1)); printf 'FAIL %s must exit 2 naming gate_pr_selector (got %s)\n' "$hook" "$rc"
  fi
}
for g in closes-paren-form-gate.sh non-english-text-gate.sh \
         docs-inline-json-flag-gate.sh pr-review-gate.sh; do
  selector_guard "$g"
done


# A FLOOR on the case total. Every `for` loop above expands a LIST, and emptying
# one -- or deleting a case -- removes assertions SILENTLY while the tally still
# reads `fail: 0`. No suite in this repo had one, so the only thing standing
# between a gutted loop and a green run was somebody noticing the number move.
# Raise it when cases are added; never lower it to make a red run green.
CASE_FLOOR=269
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
