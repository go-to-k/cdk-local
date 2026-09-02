#!/usr/bin/env bash
# Smoke test for stop-unmerged-lane-warn.sh.
#
# Run from BESIDE the hook (`bash .claude/hooks/stop-unmerged-lane-warn.test.sh`):
# the path below is `${BASH_SOURCE[0]}`-relative, so a copy run from a scratch
# directory resolves a hook that is not there and every case fails with 127.
#
# Both polarities are exercised. A Stop hook that only ever proves it FIRES
# cannot notice itself starting to fire on every turn, and a warning that cries
# wolf on a clean tree is one people learn to scroll past -- which is the same
# outcome as not having it.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stop-unmerged-lane-warn.sh"

pass=0
fail=0
fail_log=""

check() {
  local name="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want '$want', got '$got'\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# The hook now READS the Stop event's JSON from stdin, so every invocation has
# to feed it one. Left unfed, `cat` inherits this script's stdin and a case can
# hang instead of failing -- and a Stop hook that hangs never lets a turn end.
# Every call starts from a CLEAN nudge record unless a case opts out with
# `run_hook_keep`. Since go-to-k/cdkd#2391 the hook nudges the model at most
# once per subject per session and downgrades a repeat to the user channel, so
# without this reset the cases below would each depend on how many earlier ones
# happened to share their branch -- and the cases that assert `ctx` would pass
# or fail on their POSITION in the file rather than on the hook's behaviour.
# Measured on the port: with the reset removed, six of them flip to `sys`.
clear_nudge_records() {
  find "$SANDBOX" -name 'stop-nudge-lane' -type f -delete 2>/dev/null || true
}

run_hook() {
  clear_nudge_records
  run_hook_keep "$@"
}

# The same call with `CLAUDE_CODE_SESSION_ID` set, for the payloads that carry
# NO `session_id` -- the only shape that reaches the env fallback. Every other
# case here sends an explicit id, which is exactly why that line had no
# coverage.
run_hook_sid() {
  local envsid="$1" dir="$2" hook="$3" stdin="$4"
  printf '%s' "$stdin" | (cd "$dir" && CLAUDE_CODE_SESSION_ID="$envsid" bash "$hook")
  printf '%s' "$?" > "$RC_FILE"
}

# The same call capturing STDERR alone. Every other helper here discards it, so
# a hook that prints a traceback on every turn reads as perfectly healthy: the
# verdict on stdout is what they assert and the verdict can be right while the
# hook is spewing.
run_hook_stderr() {
  local dir="$1" hook="$2" stdin="$3"
  clear_nudge_records
  printf '%s' "$stdin" | (cd "$dir" && bash "$hook" 2>&1 >/dev/null)
}

# The same call WITHOUT the reset -- for the cadence cases, which are precisely
# about what a second invocation does.
run_hook_keep() {
  local dir="$1" hook="$2" stdin="${3-}"
  [ "$#" -ge 3 ] || stdin='{}'
  printf '%s' "$stdin" | (cd "$dir" && bash "$hook")
  # The exit STATUS, parked in a file because every call site is a `$(...)`
  # subshell. Silence is not the same as success here: on `Stop` a non-zero exit
  # is a hook ERROR, and the five cases below that assert empty output would all
  # pass against a hook that crashed before printing. Measured: turning the
  # three silent `exit 0`s into `exit 1` left the suite green.
  printf '%s' "$?" > "$RC_FILE"
}

# `rc_of` -> the status of the most recent run_hook call.
rc_of() { cat "$RC_FILE"; }

# `lanes_in <output>` -> how many branch lines the payload named, whichever
# channel carried it. Deliberately channel-AGNOSTIC: the cases below split into
# two groups, and only one of them is about the channel. Every count assertion
# is about which BRANCHES got enumerated, and folding the channel into it would
# make each of those fail for two unrelated reasons at once.
lanes_in() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print(0); raise SystemExit
d = json.loads(raw)
msg = d.get("hookSpecificOutput", {}).get("additionalContext") or d.get("systemMessage") or ""
print(sum(1 for line in msg.splitlines() if line.startswith("  ")))
'
}

# `msg_of <output>` -> the message text, whichever channel carried it. Used by
# the cases that compare the two channels' WORDING; `channel_of` answers where
# the payload went, and this answers what it said.
msg_of() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    raise SystemExit
d = json.loads(raw)
print(d.get("hookSpecificOutput", {}).get("additionalContext") or d.get("systemMessage") or "")
'
}

# `channel_of <output>` -> ctx | sys | none | BOTH.
#
# On the Stop event the channel IS the behaviour, not a formatting detail:
# `additionalContext` is delivered to the model and CONTINUES the turn, while
# `systemMessage` is shown to the user and lets it end. `BOTH` is reported
# rather than silently preferring one, because a payload carrying both fields
# would continue the turn AND print to the user -- neither of the two designs
# below, and something a test that reads only its own key cannot see.
channel_of() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print("none"); raise SystemExit
d = json.loads(raw)
ctx = bool(d.get("hookSpecificOutput", {}).get("additionalContext"))
sysm = bool(d.get("systemMessage"))
print("BOTH" if ctx and sysm else "ctx" if ctx else "sys" if sysm else "none")
'
}

# `pwd -P` is load-bearing, not tidiness. On macOS `mktemp -d` hands back a
# path under `/var/folders/...` whose real location is `/private/var/...`, and
# the hook derives its own root with `cd ... && pwd`, which canonicalises. Git,
# meanwhile, records a worktree under whatever path it was CREATED with. So an
# uncanonicalised sandbox makes the hook's root and git's listing two spellings
# of one directory that never compare equal -- and any case whose subject is an
# equality between those two paths passes no matter what the hook does. That is
# how the self-lane case below was measured VACUOUS on its first attempt: the
# defect it was written for (a skip keyed on the hook's own checkout) could be
# reintroduced and the suite stayed 10/0.
SANDBOX="$(cd "$(mktemp -d)" && pwd -P)"
# bash 3.2 is NOT exercised on the HOOK by running THIS FILE under /bin/bash.
# The hook's shebang is `#!/usr/bin/env bash`, which resolves through PATH and
# finds whatever bash is first there -- Homebrew 5.x on a dev Mac -- so
# `/bin/bash <suite>` measured the SUITE under 3.2 and the SUBJECT under 5.x.
# `HOOK_BASH` puts a `bash` shim first on PATH so the shebang, the explicit
# `bash "$HOOK"` calls, and any `bash` the hook itself spawns all follow the
# harness. Proved load-bearing rather than assumed: injecting a `;;&` (a bash
# 4+ case terminator) into the hook reddens cases only WITH the shim in place.
# DEFAULTED to `/bin/bash` (3.2 on macOS) rather than left opt-in, matching
# `gate-command-recognition.test.sh` in this repo: nothing sets `HOOK_BASH` in
# `vp run test:hooks`, so an opt-in fence measures 5.x in CI forever and the 3.2
# tally is only ever taken by hand. Override with
# `HOOK_BASH=/opt/homebrew/bin/bash bash <this file>` to take the 5.x one.
HOOK_BASH="${HOOK_BASH:-/bin/bash}"
[ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
if [ -n "${HOOK_BASH:-}" ]; then
  # Resolved to an ABSOLUTE path first: `HOOK_BASH=bash` would otherwise make
  # `ln -sf bash <shim>/bash` a symlink pointing at ITSELF, and every hook
  # invocation would die on ELOOP -- a suite-wide red with a cause nowhere near
  # the hook.
  HOOK_BASH_BIN="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")"
  case "$HOOK_BASH_BIN" in /*) ;; *) HOOK_BASH_BIN="$PWD/$HOOK_BASH_BIN" ;; esac
  HOOK_BASH_SHIM="$SANDBOX/bash32-shim"
  mkdir -p "$HOOK_BASH_SHIM"
  ln -sf "$HOOK_BASH_BIN" "$HOOK_BASH_SHIM/bash"
  PATH="$HOOK_BASH_SHIM:$PATH"
  export PATH
fi
# PRINTED, not merely honoured: a suite that does not say which interpreter it
# measured cannot be read as evidence about either one.
printf 'hook interpreter: %s (bash %s)\n' \
  "$(command -v bash)" "$(bash -c 'echo "$BASH_VERSION"')"

trap 'rm -rf "$SANDBOX"' EXIT

RC_FILE="$SANDBOX/rc"

REPO="$SANDBOX/repo"
mkdir -p "$REPO/.claude/hooks"
cp "$HOOK" "$REPO/.claude/hooks/"
RUN="$REPO/.claude/hooks/$(basename "$HOOK")"

git -C "$REPO" init -q .
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$REPO" update-ref refs/remotes/origin/main HEAD

# --- SILENT: nothing unmerged. The expensive half to get right, because a
# false alarm every turn is indistinguishable from noise. ---
out=$(run_hook "$REPO" "$RUN")
check "silent when no worktree exists" "" "$out"
check "...and silent means exit 0, not a crash" "0" "$(rc_of)"

# --- SILENT: a worktree that is level with origin/main is not a lane. ---
git -C "$REPO" worktree add -q "$REPO/wt-level" -b feat/level HEAD
out=$(run_hook "$REPO" "$RUN")
check "silent for a worktree with no commits of its own" "" "$out"

# --- SILENT: a DETACHED worktree has no branch to report. It is committed
# AHEAD on purpose: added at HEAD and left alone, the ahead-count check already
# excludes it and the `[ -n "$br" ]` guard this case is named for is never what
# makes it pass -- measured, deleting that guard left the suite green. Ahead and
# branchless, the guard is the only thing standing between this and a lane line
# with an empty branch name. Same trap the `main`/`master` case below documents.
git -C "$REPO" worktree add -q "$REPO/wt-detached" --detach HEAD
git -C "$REPO/wt-detached" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'detached work'
out=$(run_hook "$REPO" "$RUN")
check "silent for a detached worktree that is ahead" "" "$out"

# --- FIRES: one lane with a commit of its own. ---
git -C "$REPO/wt-level" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "names the one lane that is ahead" "1" "$(lanes_in "$out")"

# --- FIRES: counts each lane separately, and still ignores the detached one. ---
git -C "$REPO" worktree add -q "$REPO/wt-two" -b feat/two HEAD
git -C "$REPO/wt-two" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "names both lanes, not the detached worktree" "2" "$(lanes_in "$out")"

# --- FIRES: run from INSIDE a lane worktree, that lane must still be named. ---
# The case the hook exists for, and the one every case above misses: they all
# `cd "$REPO"` (the main tree), so a skip keyed on the hook's OWN checkout was
# invisible to all seven of them. An earlier revision derived the skip from
# `BASH_SOURCE` and went silent for exactly this run. The main tree is excluded
# by BRANCH, so removing that skip costs nothing here -- which this case pins
# from the other side, by asserting the count is 2 rather than 3.
mkdir -p "$REPO/wt-two/.claude/hooks"
cp "$HOOK" "$REPO/wt-two/.claude/hooks/"
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")")
check "names its OWN lane when run from inside it" "2" "$(lanes_in "$out")"
# Bind to the SELF line, not to the enumeration. The payload lists every lane,
# so `grep feat/two` is satisfied by the listing no matter which branch the
# message calls the session's own -- measured, forcing that line to name
# `feat/level` instead left the suite green. `-F` plus the trailing comma so
# `feat/two-x` cannot satisfy it either.
if printf '%s' "$out" | grep -qF "This session's worktree is on 'feat/two',"; then
  pass=$((pass + 1)); printf 'OK   the self-lane is the one the message names\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the message names the wrong self-lane\n"; printf 'FAIL the self-lane is the one the message names\n'
fi

# --- SILENT: the main tree ON `main`, ahead of origin/main, is NOT a lane.
# Without this the `main`/`master` filter is unfenced: everywhere else in this
# sandbox the main tree is LEVEL with origin/main, so the ahead-count check
# already excludes it and deleting the branch filter changes nothing. Measured:
# with this case absent, dropping `case "$br" in main|master) continue` left the
# suite at 10/0. Direct commits on `main` are a different problem with its own
# gate; this hook reports unmerged LANES.
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'on main'
out=$(run_hook "$REPO" "$RUN")
check "the main tree on main is not a lane even when ahead" "2" "$(lanes_in "$out")"

# --- The BRANCH filter, not the path, is what excludes the main tree. Put the
# main tree on a feature branch that is ahead and it must be named like any
# other lane; otherwise the two filters mask each other and neither is fenced.
git -C "$REPO" checkout -q -b feat/main-tree-lane
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "the main tree on a feature branch is a lane too" "3" "$(lanes_in "$out")"
git -C "$REPO" checkout -q -
git -C "$REPO" branch -q -D feat/main-tree-lane

# --- The payload has to be valid JSON, or the harness swallows it silently. ---
if printf '%s' "$out" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; then
  pass=$((pass + 1)); printf 'OK   payload is valid JSON\n'
else
  fail=$((fail + 1)); fail_log+="FAIL payload is not valid JSON\n"; printf 'FAIL payload is valid JSON\n'
fi

# --- SILENT, and exit 0, when `python3` is not installed. Everything past the
# lane check is built by `python3`, so without the guard the script ends on a
# `command not found` and returns 127 -- an ERROR reported on every single turn,
# from a hook whose entire job is advisory. A PATH holding only the other
# binaries it uses is what makes this measurable; with python3 present the guard
# can be deleted and the suite stays green. ---
# The list is every external the hook reaches for BEFORE the guard, `bash` and
# `env` included -- `PATH=... bash` resolves `bash` through the replaced PATH
# too, and the shebang is `env bash`. Each of them was added because its absence
# produced a DIFFERENT failure than the one under test, which is the trap here:
# a stub PATH that is too small makes the case pass for the wrong reason.
STUBBIN="$SANDBOX/no-python"
mkdir -p "$STUBBIN"
for c in bash env dirname git awk sed cat; do
  ln -sf "$(command -v "$c")" "$STUBBIN/$c"
done
out=$( (cd "$REPO" && printf '%s' '{}' | PATH="$STUBBIN" bash "$RUN"); printf '%s' "$?" > "$RC_FILE")
check "silent when python3 is unavailable" "" "$out"
check "...and exits 0 rather than 127" "0" "$(rc_of)"

# --- SILENT: no `origin/main` at all (a fresh clone before the first fetch)
# must not error or spam. ---
BARE="$SANDBOX/norem"
mkdir -p "$BARE/.claude/hooks"
cp "$HOOK" "$BARE/.claude/hooks/"
git -C "$BARE" init -q .
git -C "$BARE" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
out=$(run_hook "$BARE" "$BARE/.claude/hooks/$(basename "$HOOK")")
check "silent when origin/main is unresolvable" "" "$out"
check "...and that too is exit 0" "0" "$(rc_of)"

# Re-run against the two-lane sandbox: the case above left `$out` empty (it ran
# in the no-remote repo), and an assertion about the payload's SHAPE cannot be
# made against no payload.
out=$(run_hook "$REPO" "$RUN")
check "still names both lanes on re-run" "2" "$(lanes_in "$out")"

# --- CHANNEL: the session's OWN lane reaches the MODEL. `additionalContext` is
# the only field that does, and it continues the turn so the model can act --
# which is the failure this hook was written for, an agent ending the turn with
# its own branch committed and no PR. For months this was `systemMessage`, which
# the installed Claude Code describes as "Display a message to the user (all
# hooks)": a message written at the AGENT reached only the party who cannot act
# on it (go-to-k/cdkd#2389). ---
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")")
check "own lane goes to the model" "ctx" "$(channel_of "$out")"
check "own lane payload still enumerates every lane" "2" "$(lanes_in "$out")"
if printf '%s' "$out" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
sys.exit(0 if d["hookSpecificOutput"]["hookEventName"] == "Stop" else 1)
'; then
  pass=$((pass + 1)); printf 'OK   the hookEventName is Stop\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the hookEventName is not Stop\n"; printf 'FAIL the hookEventName is Stop\n'
fi

# --- CHANNEL: lanes that belong to SOMEONE ELSE go to the user instead. The
# model cannot act on another session's worktree, so continuing the turn buys
# one extra reply that can only say "not mine" -- measured four times in one
# session while fixing #2389, over a single lane owned by another session. This repo
# SQUASH-merges, so a merged branch reads as ahead forever and one un-removed
# worktree would have made that permanent. ---
out=$(run_hook "$REPO" "$RUN")
check "other sessions' lanes go to the user" "sys" "$(channel_of "$out")"
check "the user-facing payload still enumerates them" "2" "$(lanes_in "$out")"

# --- The OWNERSHIP test reads `cwd` out of the event payload, not just the path
# the hook was launched from. Run from the main tree while `cwd` names the lane:
# without reading `cwd` this answers `sys`, so the two cases above cannot see
# the difference on their own -- each of them has the launch path and `cwd`
# agreeing, which is exactly the pair that makes either signal look sufficient.
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-two\"}")
check "cwd naming a lane makes it the session's own" "ctx" "$(channel_of "$out")"

# --- ...and the same field pointing at a NON-lane worktree must NOT. Otherwise
# "cwd is set" rather than "cwd is a lane" would be what flips the channel, and
# the case above would pass under a hook that simply believes any cwd. ---
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-detached\"}")
check "cwd naming a non-lane worktree stays user-facing" "sys" "$(channel_of "$out")"

# --- The session reached through a SYMLINKED spelling of its lane is still the
# owner of that lane. No `cwd` in the payload, so the BASH_SOURCE fallback is
# what has to answer -- and that path is built with `cd ... && pwd`, which keeps
# the spelling it was reached BY, while git reports the real one. Without the
# canonicalisation this compares a symlink to a real path, never matches, and
# quietly hands the agent its own lane on the user-only channel.
#
# Every other case here is blind to that: git canonicalises both of ITS answers
# (measured -- a worktree ADDED as `/var/...` is still listed as
# `/private/var/...`), so the two sides agree no matter what, and dropping the
# canonicalisation leaves the suite green. ---
ln -s "$REPO/wt-two" "$SANDBOX/wt-two-link"
out=$(run_hook "$SANDBOX/wt-two-link" "$SANDBOX/wt-two-link/.claude/hooks/$(basename "$HOOK")")
check "a symlinked lane path is still the session's own lane" "ctx" "$(channel_of "$out")"

# --- NO ARM on the continuation pass. `additionalContext` CONTINUES the turn,
# so a hook that keeps emitting it turns one nudge into a spin: the model is
# pushed back to work, reaches Stop again with the same unmerged lane, and is
# pushed again. The harness marks that second pass with `stop_hook_active`, and
# standing down on it is what bounds this hook to a single forced continuation.
# Without this case the loop is unfenced -- every case above passes `{}`, where
# the flag is absent, so the branch could be deleted and the suite stay green.
#
# This case used to assert total SILENCE, and that was wrong: a lane can be
# COMMITTED during the continuation, in which case this pass is the FIRST time
# the condition holds at all and the user would never hear about it. Only the
# ARM is suppressed now -- a bare `systemMessage` does not continue a turn, so
# it cannot spin. ---
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")" '{"stop_hook_active": true}')
check "a continuation does not re-arm the model channel" "sys" "$(channel_of "$out")"
check "...but the user is still told, in case the lane appeared mid-turn" "2" "$(lanes_in "$out")"
check "...and standing down is exit 0, not a crash" "0" "$(rc_of)"

# --- ...and NOT silent when the flag is present but false, which is the shape
# every ordinary turn actually sends. A truthiness check that reads the KEY
# rather than its VALUE would go permanently silent here, and the case above
# cannot see that -- it only ever sends `true`. ---
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")" '{"stop_hook_active": false}')
check "fires when the continuation flag is present but false" "2" "$(lanes_in "$out")"
check "...and still reaches the model, not just the user" "ctx" "$(channel_of "$out")"

# --- A worktree path containing a SPACE is still a lane. `git worktree list
# --porcelain` prints `worktree <path>` with the path unquoted and unescaped, so
# reading it with `$2` truncates at the first space; `git -C <truncated>` then
# fails and the lane is dropped from BOTH the enumeration and the ownership
# comparison -- the hook goes silent about a lane that exists, which is the one
# failure direction it must never have. Documented as a fixed class in three
# sibling hooks here; this one was never converted. ---
git -C "$REPO" worktree add -q "$REPO/wt with space" -b feat/spaced HEAD
git -C "$REPO/wt with space" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "a worktree path with a space is still enumerated" "3" "$(lanes_in "$out")"
if printf '%s' "$out" | grep -q 'feat/spaced'; then
  pass=$((pass + 1)); printf 'OK   the spaced lane is named\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the spaced lane is not named\n"; printf 'FAIL the spaced lane is named\n'
fi

# --- ...and it can be the session's OWN lane. Enumeration and ownership read
# the same path through two different paths in the script, so a truncation that
# still enumerates could break only the comparison. ---
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt with space\"}")
check "a spaced path can be the session's own lane" "ctx" "$(channel_of "$out")"
git -C "$REPO" worktree remove --force "$REPO/wt with space"
git -C "$REPO" branch -q -D feat/spaced

# --- A worktree path containing a BACKSLASH or a TAB is still matched. Both
# are legal in a path and neither is legal in a git refname, which is why the
# row is `branch<TAB>path` and split at the FIRST tab -- the branch side cannot
# contain one, so whatever follows is the whole path however it is spelled.
# These fence the two awk spellings that were tried and rejected: `-v root=...`
# expands backslash escapes in the value (the backslash case), and `-F'\t'`
# puts a tabbed path in the wrong field (the tab case). Neither was visible to
# any other case -- both mismatch quietly and fall through to the not-mine
# branch, which is the safe direction and therefore the silent one. ---
#
# The payload is built with `json.dumps`, not `printf`: a literal backslash or
# tab inside a JSON string is not valid JSON, so hand-formatting one makes the
# hook fall back to BASH_SOURCE and the case then passes or fails for a reason
# that has nothing to do with the path. Measured -- both cases failed that way
# on their first attempt. A real harness escapes these; the fixture must too.
odd_n=0
for odd in 'bs\path' "$(printf 'tab\tpath')"; do
  odd_n=$((odd_n + 1))
  git -C "$REPO" worktree add -q "$REPO/$odd" -b "feat/odd-$odd_n" HEAD
  git -C "$REPO/$odd" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
  payload=$(CWD="$REPO/$odd" python3 -c 'import json, os; print(json.dumps({"cwd": os.environ["CWD"]}))')
  out=$(run_hook "$REPO" "$RUN" "$payload")
  check "a path with a backslash or tab is the session's own lane [$odd_n]" "ctx" "$(channel_of "$out")"
  git -C "$REPO" worktree remove --force "$REPO/$odd"
  git -C "$REPO" branch -q -D "feat/odd-$odd_n"
done

# --- `stop_hook_active` as the STRING "false" must not silence the hook. Python
# treats any non-empty string as truthy, so the naive read makes this the same
# as `true` -- and the boolean cases above cannot see it.
#
# Read from a LANE, not from the main tree. The flag now suppresses the ARM
# rather than the whole payload, so its effect is a channel change -- and the
# main tree already answers `sys` for the unrelated reason that none of the
# lanes are its own. Running these there would compare `sys` against `sys` and
# pass whatever the flag did. ---
WT2="$REPO/wt-two/.claude/hooks/$(basename "$HOOK")"
out=$(run_hook "$REPO/wt-two" "$WT2" '{"stop_hook_active": "false"}')
check "the string \"false\" does not count as a continuation" "ctx" "$(channel_of "$out")"
out=$(run_hook "$REPO/wt-two" "$WT2" '{"stop_hook_active": "true"}')
check "the string \"true\" does count as one" "sys" "$(channel_of "$out")"
check "...and even then the lane is named for the user" "yes" \
  "$(printf '%s' "$out" | grep -qF 'feat/two' && echo yes || echo no)"

# --- Malformed / absent stdin must not take the warning down with it. The hook
# reads stdin only to find one flag; a harness that sends nothing parseable is
# not a reason to go quiet about an unmerged lane. ---
# The channel is asserted alongside the count, not just the count: an
# unparseable payload yields no `cwd`, and a hook that fell back to claiming the
# FIRST lane as the session's own would still enumerate two and pass on the
# count alone -- measured, that mutation left the suite green.
out=$(run_hook "$REPO" "$RUN" 'not json at all')
check "fires when the event JSON is unparseable" "2" "$(lanes_in "$out")"
check "...and does not claim a lane it cannot attribute" "sys" "$(channel_of "$out")"
out=$(run_hook "$REPO" "$RUN" '')
check "fires when stdin is empty" "2" "$(lanes_in "$out")"
check "...and likewise claims nothing" "sys" "$(channel_of "$out")"

# --- The realistic `cwd`: a session sits SOMEWHERE INSIDE its worktree, rarely
# at the root. Resolution is via `rev-parse --show-toplevel`, so a subdirectory
# must attribute the same as the root; a naive string compare would not. ---
mkdir -p "$REPO/wt-two/src/deep"
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-two/src/deep\"}")
check "a subdirectory of a lane attributes to that lane" "ctx" "$(channel_of "$out")"

# --- `cwd` in no git repository at all, and `cwd` in the MAIN tree: both are
# "not a lane of mine", and neither may error out. ---
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$SANDBOX\"}")
check "cwd outside any repo stays user-facing" "sys" "$(channel_of "$out")"
check "...and still exits 0" "0" "$(rc_of)"
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO\"}")
check "cwd in the main tree stays user-facing" "sys" "$(channel_of "$out")"

# --- CADENCE (go-to-k/cdkd#2391, ported here). `stop_hook_active` stops a nudge
# spinning INSIDE one turn; nothing stopped it firing again at every later
# turn-end for as long as the lane existed. That is not merely slow: a Stop
# `additionalContext` spends the same `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` budget
# as a `decision: "block"`, 8 consecutive by default, so an every-turn nudge
# burns the cap on a lane that needs nothing. Every case here fails against the
# pre-port hook, which had no record to consult and answered `ctx`
# unconditionally.
#
# These build their OWN lanes rather than reusing the ones above. Borrowing one
# risks a worktree an earlier case has removed -- so the case would measure the
# not-my-lane branch and pass or fail on where it sits in the file, exactly the
# order-dependence `clear_nudge_records` exists to remove. They are also the
# only cases that must NOT reset the record, so they call `run_hook_keep`.
git -C "$REPO" worktree add -q "$REPO/wt-cad-a" -b feat/cad-a HEAD
git -C "$REPO/wt-cad-a" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
git -C "$REPO" worktree add -q "$REPO/wt-cad-b" -b feat/cad-b HEAD
git -C "$REPO/wt-cad-b" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work

A1="{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-one\"}"
A2="{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-two\"}"
B1="{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-one\"}"

clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "first sight of a lane nudges the model" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "the same lane again does NOT force a second turn" "sys" "$(channel_of "$out")"
# The downgrade must not be a MUTE. Choosing `systemMessage` over silence is the
# whole point -- the human keeps seeing the lane -- and a hook that simply
# exited would also read as "not ctx" and pass the line above.
if printf '%s' "$out" | grep -q 'feat/cad-a'; then
  pass=$((pass + 1)); printf 'OK   ...but the user is still told which lane\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the downgraded warning still names the lane\n"; printf 'FAIL the downgraded warning still names the lane\n'
fi

# A different LANE is a different subject, so it re-arms. Without this the first
# lane of a session would silence every later one -- strictly worse than the
# bounded cost being paid here. The two lanes keep SEPARATE records, since each
# lives in its own worktree git dir, so this cannot be satisfied by a single
# shared slot.
out=$(run_hook_keep "$REPO" "$RUN" "$B1")
check "a different lane in the same session nudges again" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and the first lane stays quiet, records being per-worktree" "sys" "$(channel_of "$out")"

# A different SESSION gets its own one nudge. It also overwrites the record --
# one file per worktree, not one per session, so nothing accumulates in the git
# dir with no one to clean it up. The cost is that the earlier session re-arms
# once, which is an EXTRA nudge rather than a missed one; that direction is the
# reason the trade is acceptable, so it is pinned rather than left to be
# rediscovered as a bug.
out=$(run_hook_keep "$REPO" "$RUN" "$A2")
check "a DIFFERENT session gets its own one nudge" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and a concurrent session's write costs an extra nudge, not a lost one" "ctx" "$(channel_of "$out")"

# --- PUSH STATE. It is in the SUBJECT (so unpushed -> pushed re-arms exactly
# once) and in the TEXT (so the message names which half of the work is left) --
# but NOT in the channel decision. go-to-k/cdkd#2391 proposed making it the
# discriminator; that would go quiet on a branch pushed with NO PR, which is a
# real failure and one of the two this hook exists to catch.
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "an unpushed lane says so in the text" "yes" "$(printf '%s' "$out" | grep -qF 'no upstream yet' && echo yes || echo no)"

# `remote.origin.fetch` is load-bearing, not boilerplate: without the refspec
# git refuses `@{u}` with "upstream branch ... not stored as a remote-tracking
# branch", the hook reads that as unpushed, and the two cases below pass or fail
# for a reason that has nothing to do with the cadence.
git -C "$REPO" config remote.origin.url "$REPO"
git -C "$REPO" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C "$REPO" update-ref "refs/remotes/origin/feat/cad-a" "$(git -C "$REPO" rev-parse feat/cad-a)"
git -C "$REPO" config "branch.feat/cad-a.remote" origin
git -C "$REPO" config "branch.feat/cad-a.merge" refs/heads/feat/cad-a
check "the fixture really did give the lane an upstream" "0" "$(git -C "$REPO/wt-cad-a" rev-list --count '@{u}..' 2>/dev/null || echo MISSING)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "pushing the lane re-arms the nudge once" "ctx" "$(channel_of "$out")"
check "...and the text switches to the pushed-but-maybe-no-PR wording" "yes" "$(printf '%s' "$out" | grep -qF 'pushed branch with NO PR' && echo yes || echo no)"
# The substring above is carried by the PRE-2026-09-03 wording too, so on its own
# it only proves the pushed arm differs from the two unpushed ones. What the
# rewrite actually added is the reading that "pushed, no PR" is ALSO the state
# verify-pr-gate mandates while /verify-pr runs -- the longest window in a lane,
# during which the old text called a legitimate wait a failure. Both reviewers of
# go-to-k/cdk-local#675 measured that reverting either string left all 104 cases
# green, so the intent gets its own case per ARM: the model text must name the
# gate, and the user text (asserted after the sys run below) must name the
# mandate. Blanking either one now reds here instead of shipping.
check "...and the model text names the gate that MANDATES that state" "yes" \
  "$(printf '%s' "$out" | grep -qF 'verify-pr-gate' && echo yes || echo no)"
check "...and tells the model a running verification is WAITING, not stopped" "yes" \
  "$(printf '%s' "$out" | grep -qF 'you are WAITING' && echo yes || echo no)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and a pushed lane stops nagging again after that one" "sys" "$(channel_of "$out")"
# The USER arm of the same rewrite. It is a SEPARATE string from the model one
# (push_line_user vs push_line), so it needs its own assertion -- measured on
# go-to-k/cdk-local#675: blanking push_line_user outright left the suite at
# 104/0 while the downgrade paths emitted a dangling blank line.
#
# Anchor on SUBJECT + VERB, never on a connective. The first spelling of this
# case grepped `mandates for as long as`, which a reviewer defeated with
# `push_line_user="Nothing mandates for as long as you like."` -- intent fully
# inverted, 107/0 green. `verify-pr-gate mandates` cannot be satisfied by a
# string that has stopped naming the gate.
check "...and the user text names the mandate in its own shorter wording" "yes" \
  "$(printf '%s' "$out" | grep -qF 'verify-pr-gate mandates' && echo yes || echo no)"

# --- The predicate is DIRECTED. `pushed -> unpushed` is what an ordinary COMMIT
# looks like, so an undirected `prev != current` re-armed on every commit AND on
# every push: measured on one lane as `commit ctx, repeat sys, push ctx, repeat
# sys, commit ctx, push ctx, ...`, two forced continuations per cycle, forever.
# `feat/cad-a` is pushed and quiet at this point, so committing to it is exactly
# that transition. ---
git -C "$REPO/wt-cad-a" -c user.email=t@t -c user.name=t commit -q --allow-empty -m more
check "the fixture really did make the lane unpushed again" "1" "$(git -C "$REPO/wt-cad-a" rev-list --count '@{u}..' 2>/dev/null || echo MISSING)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "an ordinary COMMIT (pushed -> unpushed) does NOT re-arm" "sys" "$(channel_of "$out")"
# ...and the MIDDLE push arm: an upstream exists, N commits are unpushed. The
# fixture above only ever produced the two ENDS (no upstream at all, and fully
# pushed), so the branch naming the count had no case of its own.
check "...and the text names the unpushed COUNT, not the no-upstream wording" "yes" \
  "$(printf '%s' "$out" | grep -qF '1 commit(s) not yet pushed' && echo yes || echo no)"
# Pushing it again is the ONE transition that re-arms, and exactly once.
git -C "$REPO" update-ref "refs/remotes/origin/feat/cad-a" "$(git -C "$REPO" rev-parse feat/cad-a)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "unpushed -> pushed re-arms" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...exactly once" "sys" "$(channel_of "$out")"

# --- A MALFORMED record falls to ARM, which is the safe direction: an extra
# nudge, never a missed one -- the same direction the concurrent-clobber trade
# above already accepts. Without the shape check the record is trusted verbatim,
# so one junk write in the git dir silences the lane for the rest of the
# session. Every spelling below carries the RIGHT session and the RIGHT branch,
# so nothing but the shape check can reject it.
#
# An EMPTY subject is not among them because it is not representable: bash's
# `read` with `IFS=<tab>` treats tab as IFS WHITESPACE, so a run of tabs
# delimits as one and `sid\t\tts` arrives as the TWO-field record below rather
# than as three fields with an empty middle. Measured, not assumed -- the first
# draft asserted an empty subject and was passing through the field-count guard
# under a name that described a path it never took.
CAD_A_REC="$(git -C "$REPO/wt-cad-a" rev-parse --absolute-git-dir)/stop-nudge-lane"
printf 'sess-one\tfeat/cad-a:pushed\n' > "$CAD_A_REC"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "a TRUNCATED two-field record arms" "ctx" "$(channel_of "$out")"
printf 'sess-one\tfeat/cad-a:pushed\t%s\textra\n' "$(date +%s)" > "$CAD_A_REC"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "a record with a FOURTH field arms" "ctx" "$(channel_of "$out")"
printf 'sess-one\tfeat/cad-a:pushed\tnot-a-number\n' > "$CAD_A_REC"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "a record with a NON-NUMERIC timestamp arms" "ctx" "$(channel_of "$out")"
# The control: the well-formed record the hook itself just wrote is trusted, so
# the three above are not passing merely because every record arms.
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...while the WELL-FORMED record it wrote is still trusted" "sys" "$(channel_of "$out")"

# --- A nudge that cannot be RECORDED cannot be BOUNDED, and an unbounded nudge
# is what the cadence exists to remove -- so an unwritable git dir costs the
# MODEL channel, not the warning. Asserted in both halves, because a hook that
# simply exited would also read as "not ctx". ---
CAD_A_GITDIR="$(git -C "$REPO/wt-cad-a" rev-parse --absolute-git-dir)"
clear_nudge_records
chmod a-w "$CAD_A_GITDIR"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
chmod u+w "$CAD_A_GITDIR"
check "an unwritable git dir downgrades to the user channel" "sys" "$(channel_of "$out")"
check "...but still WARNS about the lane" "yes" \
  "$(printf '%s' "$out" | grep -qF 'feat/cad-a' && echo yes || echo no)"

# The continuation flag outranks the cadence: the harness has already resumed
# once inside this turn, so even a freshly-armed subject must not force a second
# continuation. It used to go fully SILENT, and that lost the case where the
# lane is COMMITTED during the continuation -- that pass is then the first time
# the condition holds at all, and the user heard nothing. Only the ARM is
# suppressed now; a bare `systemMessage` does not continue a turn.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-three\", \"stop_hook_active\": true}")
check "a resumed turn does not arm, even with a fresh subject" "sys" "$(channel_of "$out")"
check "...and the user is told about it on that pass" "yes" \
  "$(printf '%s' "$out" | grep -qF 'feat/cad-b' && echo yes || echo no)"
# ...and it writes NO record. A resumed pass never arms, so recording its
# subject as SEEN would spend the model's one nudge on a turn the model was
# never told about -- the next ordinary turn would find the subject already
# used and downgrade its own first nudge.
CAD_B_REC="$(git -C "$REPO/wt-cad-b" rev-parse --absolute-git-dir)/stop-nudge-lane"
check "a resumed pass writes no record" "no" "$([ -e "$CAD_B_REC" ] && echo yes || echo no)"
out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-three\"}")
check "...so the next ordinary turn still gets its one nudge" "ctx" "$(channel_of "$out")"

# The same property with an EXISTING record, which is the shape that actually
# loses a nudge: the subject CHANGES during the continuation (the lane is
# committed inside it), so a write there records a subject as seen that the
# model was never told about. Asserting the record is UNCHANGED, not merely
# absent -- a hook that stopped recording altogether would satisfy "absent".
printf 'sess-four\tfeat/other:unpushed\t%s\n' "$(date +%s)" > "$CAD_B_REC"
out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-four\", \"stop_hook_active\": true}")
check "a resumed pass with a NEW subject stays off the model channel" "sys" "$(channel_of "$out")"
check "...and leaves the existing record untouched" "feat/other:unpushed" \
  "$(cut -f2 <"$CAD_B_REC")"
out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-four\"}")
check "...so the unconsumed nudge survives to the next ordinary turn" "ctx" "$(channel_of "$out")"

# --- The SESSION ID's env fallback. Every case above sends an explicit
# `session_id`, so the `CLAUDE_CODE_SESSION_ID` path had zero coverage -- and it
# used to sit in SHELL, after the normalisation that folds tabs and newlines out
# of the payload's copy. A tab in the id adds a FIELD to the record and a
# newline ends its line early; either way the read-back shifts, `prev_sid` never
# matches the value the hook itself just wrote, and the cadence stops bounding:
# `additionalContext` every turn, against `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
#
# Each probe asserts the SECOND turn downgrades, not merely that the first
# fires. A case that only checked turn 1 passes against the broken hook, since
# the failure is that it never STOPS firing.
SID_PAYLOAD="{\"cwd\": \"$REPO/wt-cad-b\"}"
sid_cadence() {
  local envsid="$1" first second
  clear_nudge_records
  first=$(run_hook_sid "$envsid" "$REPO" "$RUN" "$SID_PAYLOAD")
  second=$(run_hook_sid "$envsid" "$REPO" "$RUN" "$SID_PAYLOAD")
  printf '%s,%s' "$(channel_of "$first")" "$(channel_of "$second")"
}
check "a plain env session id bounds the cadence" "ctx,sys" "$(sid_cadence 's1')"
check "a LEADING TAB in the env session id still bounds it" "ctx,sys" "$(sid_cadence "$(printf '\tabc')")"
check "an EMBEDDED TAB in the env session id still bounds it" "ctx,sys" "$(sid_cadence "$(printf 'a\tb')")"
check "an EMBEDDED NEWLINE in the env session id still bounds it" "ctx,sys" "$(sid_cadence "$(printf 'a\nb')")"
check "an UNSET env session id still bounds it" "ctx,sys" "$(sid_cadence '')"

# `session_id` arrives as JSON, so nothing stops the harness sending a number or
# a list where a string is expected. `.replace` on one RAISES, and the block
# died before printing its third line -- the shell fell back to `shared`, so the
# VERDICT stayed right while a Python traceback went to this hook stderr on
# every single turn. Asserted on stderr, because no case that reads stdout can
# see it: the two below both pass against the unguarded hook.
NONSTR_SID="{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": 12345}"
check "a NON-STRING session id prints nothing on stderr" "" \
  "$(run_hook_stderr "$REPO" "$RUN" "$NONSTR_SID")"
# ...and the control that keeps it honest: a hook that exited before doing
# anything would also print nothing, so the same payload must still warn.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$NONSTR_SID")
check "...and still warns about the lane" "ctx" "$(channel_of "$out")"

# --- The record path is a DIRECTORY. `mv -f <file> <dir>` returns SUCCESS -- it
# moves the tmp INSIDE the directory -- so the write was certified, the readback
# next turn found nothing, and EVERY turn re-armed `additionalContext` against
# `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` while the git dir grew one orphan tmp per
# turn. That is the unbounded cadence this mechanism exists to remove, arriving
# through the success check -- the one failure `mv`'s own exit code cannot
# report, which is why the unwritable-git-dir case above does not cover it.
# Measured with `mv` alone: `ctx ctx ctx`.
CAD_A_REC="$(git -C "$REPO/wt-cad-a" rev-parse --absolute-git-dir)/stop-nudge-lane"
clear_nudge_records
rm -f "$CAD_A_REC"
mkdir -p "$CAD_A_REC"
dir_channels=""
for _ in 1 2 3; do
  out=$(run_hook_keep "$REPO" "$RUN" "$A1")
  dir_channels="${dir_channels}$(channel_of "$out") "
done
dir_orphans=$(find "$CAD_A_REC" -type f 2>/dev/null | wc -l | tr -d ' ')
rm -f "$CAD_A_REC"/* 2>/dev/null || true
rmdir "$CAD_A_REC" 2>/dev/null || true
check "a record path that is a DIRECTORY never arms the model channel" "sys sys sys " "$dir_channels"
check "...and leaves no orphan tmp behind in the git dir" "0" "$dir_orphans"

# --- A failed record write must say nothing on the hook's REAL stderr. The
# redirect is `2>/dev/null >"$tmp"`, in that order, and the order is the point:
# redirections apply left to right, and the open that FAILS is the fd-1 open of
# `$tmp`. Written `>"$tmp" 2>/dev/null` that open happens while fd 2 is still
# the real stderr, so "Permission denied" is printed there from an ADVISORY
# hook, on every turn. `run_hook_stderr` exists here for the non-string-sid case
# and was never pointed at this one.
clear_nudge_records
chmod a-w "$CAD_A_GITDIR"
stderr_on_ro=$(run_hook_stderr "$REPO" "$RUN" "$A1")
chmod u+w "$CAD_A_GITDIR"
check "an unwritable git dir prints nothing on the hook's real stderr" "" "$stderr_on_ro"

# --- The env fallback's SOURCE, keyed on the record rather than on the reset.
# `sid_cadence` clears the record before each value, so it fences the tab /
# newline FOLD and not the `CLAUDE_CODE_SESSION_ID` line it names: with that
# source removed every run reads `shared`, and a cleared record makes each
# value's FIRST run arm regardless. Driving A, B, A through ONE record is what
# separates them -- three distinct sessions each get their own nudge, while a
# hook that cannot tell them apart swallows the second and the third.
clear_nudge_records
env_src=""
for esid in 'src-a' 'src-b' 'src-a'; do
  out=$(run_hook_sid "$esid" "$REPO" "$RUN" "$SID_PAYLOAD")
  env_src="${env_src}$(channel_of "$out") "
done
check "each env-supplied session gets its own nudge" "ctx ctx ctx " "$env_src"

# --- The user text's CLOSING CLAUSE is per downgrade path. "The agent has
# already been told" is true on exactly ONE of the three: on the RESUMED path
# this pass may be the first time the condition holds at all, and on the
# UNPERSISTABLE-RECORD path `arm` is forced 0 every turn, so the agent is never
# told and the user was assured otherwise forever. One string across all three
# re-committed, in the user's own voice, the defect the channel split exists to
# fix. The sibling `stop-cleanup-warn.sh` in the other repo omits the claim
# entirely; this one states the truth per path instead.
TOLD='already been told'
# 1. repeat subject -- the one path where the claim is TRUE.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "the repeat-subject downgrade DOES say the agent was told" "yes" \
  "$(printf '%s' "$out" | grep -qF "$TOLD" && echo yes || echo no)"
# 2. resumed pass -- the agent was not interrupted on this pass.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-voice-res\", \"stop_hook_active\": true}")
check "the RESUMED downgrade does not claim the agent was told" "no" \
  "$(printf '%s' "$out" | grep -qF "$TOLD" && echo yes || echo no)"
check "...and says why it is on this channel instead" "yes" \
  "$(printf '%s' "$out" | grep -qF 'continued once' && echo yes || echo no)"
# 3. unpersistable record -- the agent is NEVER told on this path.
clear_nudge_records
chmod a-w "$CAD_A_GITDIR"
out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-voice-nop\"}")
chmod u+w "$CAD_A_GITDIR"
check "the UNPERSISTABLE downgrade does not claim the agent was told" "no" \
  "$(printf '%s' "$out" | grep -qF "$TOLD" && echo yes || echo no)"
check "...and says the nudge could not be recorded" "yes" \
  "$(printf '%s' "$out" | grep -qF 'could not record' && echo yes || echo no)"


# --- The cadence record must not OUTLIVE the condition. When no worktree is
# ahead of `origin/main` any more, the stored subject is stale, and returning
# to the same branch in the same push state reproduces it exactly -- so the
# next genuine first-sighting is DOWNGRADED. That is a MISSED nudge, the unsafe
# direction. Reachable through the very remedy this hook prints: nudge, repeat,
# `git switch --detach origin/main`, re-attach, commit. Its sibling
# `stop-warn.sh` has always dropped its record on the clean-tree exit.
#
# A SEPARATE sandbox repo, because the property is repo-GLOBAL ("no lane
# anywhere is ahead") and the fixtures above leave other lanes standing.
CLR_REPO="$SANDBOX/clear-repo"
mkdir -p "$CLR_REPO/.claude/hooks"
cp "$HOOK" "$CLR_REPO/.claude/hooks/"
CLR_RUN="$CLR_REPO/.claude/hooks/$(basename "$HOOK")"
git -C "$CLR_REPO" init -q .
git -C "$CLR_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$CLR_REPO" update-ref refs/remotes/origin/main HEAD
git -C "$CLR_REPO" worktree add -q "$CLR_REPO/wt-clr" -b feat/clr HEAD
git -C "$CLR_REPO/wt-clr" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
CLR_PAYLOAD="{\"cwd\": \"$CLR_REPO/wt-clr\", \"session_id\": \"sess-clr\"}"
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "the clearing fixture arms once" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "...and the repeat is downgraded" "sys" "$(channel_of "$out")"
# The condition CLEARS: the lane is no longer ahead of origin/main.
git -C "$CLR_REPO/wt-clr" reset -q --hard origin/main
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "...the hook is silent once nothing is ahead" "" "$out"
check "...and the stale record is gone" "absent" \
  "$([ -e "$(git -C "$CLR_REPO/wt-clr" rev-parse --absolute-git-dir)/stop-nudge-lane" ] && echo present || echo absent)"
# ...and the same subject is a FIRST sighting again.
git -C "$CLR_REPO/wt-clr" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'work again'
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "...so the SAME subject nudges the model again" "ctx" "$(channel_of "$out")"
git -C "$CLR_REPO" worktree remove --force "$CLR_REPO/wt-clr"


# --- The two channels carry DIFFERENT TEXT. A downgrade changes the READER
# from the agent to a person, so sending the model's wording ("you are not done:
# rebase, run the gates, open the PR") down `systemMessage` addresses a human as
# the agent -- which is go-to-k/cdkd#2389's defect, the one this hook's channel
# split exists to fix, reappearing on the three downgrade paths. Asserted as a
# difference AND on the specific phrase, so collapsing the two back into one
# string fails here rather than in a review. ---
clear_nudge_records
ctx_out=$(run_hook_keep "$REPO" "$RUN" "$B1")
sys_out=$(run_hook_keep "$REPO" "$RUN" "$B1")
check "the two channels really are ctx then sys" "ctx,sys" "$(channel_of "$ctx_out"),$(channel_of "$sys_out")"
check "...and they do NOT carry the same text" "different" \
  "$([ "$(msg_of "$ctx_out")" = "$(msg_of "$sys_out")" ] && echo same || echo different)"
check "...the model text tells the AGENT what to do" "yes" \
  "$(printf '%s' "$(msg_of "$ctx_out")" | grep -qF 'rebase, run the gates, open the PR' && echo yes || echo no)"
check "...and the user text does not" "no" \
  "$(printf '%s' "$(msg_of "$sys_out")" | grep -qF 'rebase, run the gates, open the PR' && echo yes || echo no)"
check "...while still naming the lane for the user" "yes" \
  "$(printf '%s' "$(msg_of "$sys_out")" | grep -qF 'feat/cad-b' && echo yes || echo no)"

# The escape wording for a tree an outer tool owns and this session must not
# remove (the other half of the go-to-k/cdkd#2391 port). TWO remedies, in order:
# switch BACK to the branch the tool handed the tree over on -- which is not
# ahead of origin/main, so it is not a lane -- and, only when that branch is
# unknown or gone, detach. go-to-k/cdk-local#651 demoted detach from THE remedy
# to the fallback, and the ORDER is the part that matters: this hook's text is
# what an agent reads at Stop time, so a message naming only the fallback sends
# every IN-PLACE run to the visible-surprising end state the skill just stopped
# prescribing. Both are pinned, and the restore is pinned to come FIRST.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$B1")
check "the own-lane message names the detach escape" "yes" "$(printf '%s' "$out" | grep -qF 'git switch --detach origin/main' && echo yes || echo no)"
check "...and names the restore that now precedes it" "yes" \
  "$(printf '%s' "$out" | grep -qF 'switch BACK to the' && echo yes || echo no)"
# By CHARACTER offset, not line number: the hook answers with JSON, so the whole
# message can arrive on one line and a line-numbered compare reports equal. The
# input is accumulated in the main block rather than slurped with `RS="\0"` --
# on macOS BWK awk an empty-ish RS is PARAGRAPH mode, not read-everything, so
# that spelling would silently split a future multi-paragraph message.
check "...with the restore BEFORE the detach fallback" "yes" \
  "$(printf '%s' "$out" | awk '
            { buf = buf $0 "\n" }
      END   { r = index(buf, "switch BACK to the"); d = index(buf, "git switch --detach origin/main")
              print (r > 0 && d > 0 && r < d) ? "yes" : "no" }')"

git -C "$REPO" worktree remove --force "$REPO/wt-cad-a"
git -C "$REPO" worktree remove --force "$REPO/wt-cad-b"
clear_nudge_records


# A FLOOR on the case total. Every `for` loop above expands a LIST, and emptying
# one -- or deleting a case -- removes assertions SILENTLY while the tally still
# reads `fail: 0`. No suite in this repo had one, so the only thing standing
# between a gutted loop and a green run was somebody noticing the number move.
# Raise it when cases are added; never lower it to make a red run green.
CASE_FLOOR=102
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  fail_log+="FAIL case floor: only $((pass + fail)) cases ran, expected at least 102\n"
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
printf '\nPass: %d  Fail: %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '%b' "$fail_log" >&2
  exit 1
fi
