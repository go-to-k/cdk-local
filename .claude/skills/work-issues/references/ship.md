<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 9. Ship: merge → pull → cleanup (all via `/merge-pr`)

With subagent lanes, this stage is the PARENT's serialization point: grant one
merge-ready lane at a time its turn — resume that lane agent (SendMessage) to
run its named integ fixture(s) and `/merge-pr` while it holds the turn, or run
`/run-integ` and `/merge-pr` yourself FROM THAT LANE'S WORKTREE. The worktree
matters mechanically, not stylistically: markgate markers are per-worktree
(`.claude/rules/hooks.md` — `markgate set` runs in the worktree whose gated
command it clears), so the `integ` marker a `/run-integ` sets is visible only
to a merge judged from the same tree — cdkd measured the wrong-tree shape live
on 2026-08-28 (go-to-k/cdkd#2363). Within the turn, run the fixture(s) first
and refresh whatever markers the run staled (§8's ordering rule), then
`/merge-pr`. The Docker daemon is shared host state (container / network
names, host ports, image tags, the post-run orphan sweep), so never two lanes'
integ runs — nor two merges — concurrently; everything after the merge in this
section (pull → worktree/branch audit) stays with the parent.

**A `SendMessage` that answers "queued" has NOT been delivered — read the reply
every time.** The tool returns one of two things: `Resuming agent ...`, meaning
the agent was stopped and has been RESTARTED to receive it, or `Message queued
for delivery at its next tool round`, which delivers only if something ELSE
resumes the agent. A lane that ended its turn on "merge-ready" is stopped by
definition, so the turn-grant it is waiting for lands in a queue nothing will
drain — and both sides then look identical to a party waiting on the other.
Measured 2026-09-02 (go-to-k/cdkd#2417): a lane sat idle about five minutes
mid-pipeline that way, surfaced only by the maintainer asking why nothing was
running, and an immediate re-send answered `Resuming agent` and unstuck it. So
after any send: if the answer was "queued", either confirm the agent actually
runs (its next completion notification) or re-send at once. A queued message is
never a granted turn.

Merge every verified PR with the `/merge-pr` skill — NOT a hand-run
`gh pr merge --squash --delete-branch`:

```
/merge-pr <n>
```

**An IN-PLACE run (§3's launch-mode probe) stops `/merge-pr` once the merge is
CONFIRMED** — its step 4, the `state=MERGED` read. Everything up to there
(resolve paths, set the `merge-pr` marker, `gh pr merge --squash`, confirm the
merge) runs unchanged. **The LOCAL-CLEANUP step must not run at all**: that is
the one doing `git worktree remove "$WT" --force` plus `git branch -D "$BR"`,
numbered 5 today — name it by what it DOES rather than by its number, which is
the one part of this that drifts: `/merge-pr`'s own step 1 called the removal
"step 4" until go-to-k/cdk-local#653 corrected it, and a reader following a
stale number skips the wrong step. Skip it entirely, do the remote-branch confirmation (step 6) from this
tree, and say in the report that the local TREE is still there ON PURPOSE.
Cleanup of a workspace this run did not create belongs to whoever did — the
outer tool, or the operator. The local BRANCHES are a different matter: this run
made them, so it owes them — the IN-PLACE cleanup block below deletes them and
puts `LAUNCH_BRANCH` back, once, as the LAST step of the run rather than here.

`/merge-pr`'s step 1 names one adjacent case (`WT` == `MAIN` — main worktree,
nothing to detach). There are TWO it does not, and they are different from each
other:

- **A linked worktree under `.claude/worktrees/`** — the ordinary IN-PLACE case
  above. The gate fires, `/merge-pr` is mandatory, and only the cleanup step is
  dropped.
- **A linked worktree that is NOT under `.claude/worktrees/`** — an Orca/ADE
  workspace, which is neither the main checkout nor a path the gate recognises.
  `gh-pr-merge-worktree-gate.sh` matches `*/.claude/worktrees/*` only, so from
  there it FAILS OPEN: a hand-run `gh pr merge` is not blocked, and nothing
  forces the merge through `/merge-pr` at all. Step 1's sanity check DOES name
  this shape — a `WT` outside `.claude/worktrees/` is always an IN-PLACE caller,
  and it sends you to step 5's stop rule — but that test is ONE-WAY, so the
  bullet above stays invisible to it. Use
  `/merge-pr` anyway — its marker is harmless when the gate never consults it —
  and drop the local-cleanup step exactly as above. Treat a gate that stays
  silent here as a gate that did not run, never as a verdict that the merge was
  checked.

`/merge-pr` squash-merges from inside the feature worktree WITHOUT
`--delete-branch` (so gh runs no local cleanup and never trips the `'main' is
already used by worktree` fatal a hand-run merge hits from a side worktree), then
cleans the worktree + local branch + remote branch in one pass. A hand-run worktree
merge is blocked by `gh-pr-merge-worktree-gate.sh` unless `/merge-pr` set the
`merge-pr` marker. If a later PR is behind, GitHub still merges it when the files
are disjoint — which is also why a clean merge says nothing about whether a
collision happened (§7), in either shape: content-vs-content, or a peer's
repo-wide check judging your content (run the peer's new check over your diff
after the rebase, per §7).

**When one lane fixes a full-suite flake, merge THAT lane first** — every other
lane's `/check` and `/verify-pr` runs the same suite, so until the fix is on
`main` each of them rolls the same dice, and only a rebase delivers the fix (a
lane branched before the merge keeps flaking on its stale base). Measured
2026-08-19: the go-to-k/cdk-local#509 lane hit the go-to-k/cdk-local#515 timeout
2/2 while the fix sat unmerged; merging it (go-to-k/cdk-local#522) and rebasing
made the next run green. Corollary for a PR's CI: it runs on the MERGE ref
(branch + current `main`), so a red check can be caused by a PEER's just-merged
content your local green never saw — the fix is fetch + rebase + re-run, not
distrusting the check (go-to-k/cdk-local#524 failed on a line
go-to-k/cdk-local#520 merged in parallel).

MAIN-CHECKOUT — run THIS block, and not the next one:

```bash
git checkout main && git pull origin main    # bring the merges local
```

IN-PLACE — run THIS block INSTEAD, never both: `main` is checked out in the main
tree, so a `checkout main` HERE dies with `'main' is already used by worktree at
...`. Never leave your own tree; pull the main checkout through `-C`, using the
path the launch-mode probe already recorded rather than re-deriving it from a
`git worktree list` row (the old spelling depended on the main checkout being
row 1, which is true today and is not a documented guarantee):

```bash
# <MAIN_CHECKOUT> is the ABSOLUTE path the launch-mode probe printed
# (references/launch-mode.md) -- substituted here, never carried as a shell
# variable, because each fenced block is its own Bash call and an empty `-C`
# does not fail, it re-targets the cwd.
git -C "<MAIN_CHECKOUT>" pull origin main
```

(There is no post-release rebuild step to relocate: this repo's flow ends at the
pull, and users invoke `node dist/cli.js` from their own checkout rather than a
globally linked binary built in the main tree. The sibling cdkd has that step
and has to run it in `$MAIN`; do not import it here.)

When your PR landed into a file another PR touched in the same window, grep the
merged `main` for a marker string from EACH side before believing both survived —
one side silently overwriting the other looks exactly like a clean merge. The
mechanics, each learned from a false alarm or a vacuous pass:

- **Grep the MERGED text, not a working copy**:
  `git show origin/main:<file> | grep -cF "<marker>"`. From a lane worktree, a
  grep of `<file>` reads YOUR branch and passes while main is missing the very
  lines being checked (cdkd's copy was vacuous in exactly that shape,
  go-to-k/cdkd#2009).
- **`-F` is load-bearing** — prose markers are full of regex metacharacters
  (`.`, `[`, `*`); without it a marker silently fails to match, producing the
  false lost-content alarm this check exists to prevent (double quotes, not
  `-F`, handle apostrophes).
- **`grep -c` exits 1 on zero matches** — the very case being hunted — so never
  chain the two greps with `&&`.
- **Pick a phrase that sits on ONE LINE of the merged file**: this prose is
  hard-wrapped and grep is line-based, so a marker spanning the wrap returns a
  false 0 (measured against go-to-k/cdk-local#530's own merged text).
- **Source each marker from MERGED text, never a title or an earlier draft** —
  take THEIRS from their merge commit
  (`git show "$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid):<file>"`).
  A title-sourced marker (go-to-k/cdk-local#518) and a draft-sourced one
  (go-to-k/cdkd#2000, reworded before merge) both scored 0 while the real text
  was present — false lost-merge alarms (2026-08-19).
- **Read the two counts asymmetrically**: whichever lane merged LAST has its
  marker read back out of what is now the tip, so that arm is tautological — two
  `1`s are one real confirmation plus one tautology, never two independent ones.
- **Settle a 0** from your lane worktree with
  `diff <(git show origin/main:<file>) <file>` — the lines your commit removed
  should be exactly the ones you meant to replace.

`/merge-pr` already removes the worktree it merged AND deletes the local branch —
its step 5 runs `git branch -D`, and `-D` is load-bearing because this repo
squash-merges: a merged tip is never an ancestor of `main`, so `-d` refuses it as
"not fully merged". Read that refusal as the expected squash artifact, not as
unmerged work — but only after confirming the PR is MERGED.

MAIN-CHECKOUT (§3's launch-mode probe) — run THIS block, and not the next one.
The closing check is that **every worktree AND every local branch THIS run added
is gone** — never that only the main checkout remains. `git worktree remove` on
its own never deletes a branch, so a crashed or interrupted `/merge-pr` leaves
the local ref behind (cdkd's section 9 claimed otherwise and accumulated a dozen
stale merged branches before go-to-k/cdkd#2015 corrected it):

```bash
git worktree list      # yours gone; one you did NOT add may be a LIVE peer lane
git worktree prune     # drops entries whose directory a peer already removed
git branch --list      # local branches THIS run created are gone too
```

IN-PLACE — run THIS block INSTEAD, never both, and **run it LAST, not per-lane,
in the PARENT**: §10-d takes its retro branch in this same tree, so restoring
here and branching again there would only undo itself. Do the merge in §9 and
come back for the block below once the retro PR has merged. The parent owns it
even though §10-d is where it fires, because §10 may be dispatched to a subagent
and two agents must not both be switching one tree.

**The run ADDED no worktree, so it removes none**: `/merge-pr`'s local-cleanup
step never ran (above), and removing the tree it is standing in would delete its
own cwd. Cleanup of the TREE belongs to whoever created it — the outer tool or
the operator — so the wrap SAYS that instead of doing it, and the run ends with
the tree still there. What it DOES owe is the BRANCH: put back the one it found,
delete every one it made. `<LAUNCH_BRANCH>` and `<every branch THIS run created>`
are SUBSTITUTION PLACEHOLDERS taken from the opening report, not shell variables
(`references/launch-mode.md` — a fresh Bash call is a fresh shell, and an empty
`git switch ""` is not the failure you want):

```bash
git show-ref --verify --quiet refs/heads/<LAUNCH_BRANCH> || echo 'gone -> use the fallback'
       # FIRST, because this is the gate that CHOOSES between this block and the
       # fallback below. `--quiet` plus the explicit `|| echo` makes it
       # self-describing: it PRINTS the arm it selects, instead of leaving that
       # to be read off a `fatal:` line on stderr.
[ -z "$(git status --porcelain)" ] \
  && git switch --no-guess <LAUNCH_BRANCH> \
  && git branch -D <every branch THIS run created> \
  || echo 'STOPPED: dirty tree (commit or stash first), or the switch failed -- read above'
       # The `|| echo` hangs off the WHOLE CHAIN, not off the test, and that is
       # a correctness point rather than a style one: `A || B && C` parses as
       # `(A || B) && C`, so `[ -z ... ] || echo '...' && git switch ...` runs
       # the SWITCH on a dirty tree -- the echo succeeds and satisfies the
       # `&&`. Verified in bash 2026-09-02. Hung off the chain it fires for any
       # failed link, which is why it names both causes instead of guessing.
       # ONE chain, and the dirty-tree test is its FIRST LINK. Testing AFTER the
       # switch is too late: `git switch` carries uncommitted changes ACROSS, so
       # the check then reports a tree that only LOOKS clean -- the dirt moved
       # with you, onto the outer tool's branch -- and the `-D` deletes the
       # branches that were holding this run's commits. Nor can the test be a
       # bare `git status --porcelain`: that exits 0 dirty OR clean, so there is
       # no verdict for `&&` to act on. And it is CHAINED rather than left
       # standing alone with an `exit`, because a reader copies a LINE, not its
       # intent -- the same rule this block's fence applies to everything else
       # in it.
       # CHAINED onward for the rest of the same reason: an unchained `-D` after
       # a FAILED switch still deletes the branches that are not checked out,
       # leaving the tree on the lane branch with its siblings gone. `-D`, not
       # `-d` (squash) -- see above; §10-d's retro branch is one of them.
       # `--no-guess` is load-bearing, and its absence fails in the worst
       # direction: with the branch gone LOCALLY but still on `origin`, a plain
       # `git switch` DWIMs and CREATES it from the remote -- exit 0, tracking
       # set, "Switched to a new branch" -- re-making the outer tool's branch at
       # ORIGIN's tip. That is an ADJUST, on precisely the path that was meant
       # to fall through to the fallback below. `--no-guess` makes it an error.
       # git prints its own advice on that switch, suggesting a `pull` to
       # update the local branch. Do not: that is the fast-forward the AS-IS
       # rule withdraws. (Spelled without the verb because the fence below
       # bans every branch-moving command inside this block, comments and all.)
git branch --show-current                 # must print <LAUNCH_BRANCH>
git rev-list --count origin/main..<LAUNCH_BRANCH>
       # 0 for a freshly created workspace, which is what silences the Stop hook.
       # Non-zero means the outer tool left commits on its own branch: correct,
       # not yours to merge and not yours to fast-forward away.
```

Fallback, and ONLY when `LAUNCH_BRANCH` was empty at probe time (the run was
launched detached) or the `show-ref` gate above printed `gone` — never as the
default. CHAINED for the same reason as the primary block: a failed `fetch`
followed by an unchained `switch` detaches at a stale `origin/main`, and a failed
`switch` followed by an unchained `-D` deletes the branches that are not checked
out. It needs no `--no-guess`: `--detach` takes a commit-ish, so there is no
branch NAME left for git to guess at:

```bash
git fetch origin \
  && git switch --detach origin/main \
  && git branch -D <every branch THIS run created>
```

**Three end states, and only one of them is quiet.** Staying on the lane branch
leaves a squash-merged tip that the unmerged-lane Stop hook warns about on EVERY
turn (the appendix has its wording; its tip is never an ancestor of `main` — the
same squash artifact that forces `-D` above). Detaching silences that, and was
this step's recommendation until 2026-09-02 — but it is VISIBLE-SURPRISING in the
outer tool's UI, which created the workspace ON a branch and displays the
detached state prominently; the maintainer flagged it live.
`LAUNCH_BRANCH` restored is both: it sits at whatever tip the outer tool left —
0 commits ahead of `origin/main` for a freshly created workspace, which is the
ordinary case — so the Stop hook stays silent AND the workspace looks untouched.
If the tool DID leave commits on it the hook keeps naming it, and that is
correct: those commits are not this run's to merge, and fast-forwarding them
away is exactly the edit the next paragraph withdraws.

**AS-IS is the whole rule: RESTORE, never ADJUST.** The first draft of this step
fast-forwarded `LAUNCH_BRANCH` to `origin/main` on the way back, so it would not
be left "stale"; that clause is WITHDRAWN. The tree and the branch are the outer
tool's artifacts and this run's job is to leave them exactly as it found them —
a fast-forward is an edit to somebody else's branch, made for the convenience of
a run that is on its way out, and "it was only a fast-forward" is precisely the
reasoning that produced the detached HEAD this rule replaces. If the branch is
behind, that is the tool's business. Concretely, one prohibition per line so no
re-wrap can separate a "never" from the command it governs:
never `git pull` into `<LAUNCH_BRANCH>`,
never `git merge --ff-only origin/main` onto `<LAUNCH_BRANCH>`,
never `git rebase <LAUNCH_BRANCH>`,
and never `git branch -D <LAUNCH_BRANCH>` -- the delete takes the branches THIS
run created, and that one is the outer tool's.

The REMOTE branches still go on merge — by the repo's own
`delete_branch_on_merge`, not by `/merge-pr`, which deliberately omits
`--delete-branch` — which is fine and independent of any of this. So the
IN-PLACE closing check is "added no worktree, so removed none; the tree is on
`LAUNCH_BRANCH` as it was found (or detached, if that arm fired), and every
branch this run created is deleted".

`git worktree list` cannot tell you whose a worktree is: a finished lane and a
session working right now look identical, an already-on-`main` branch tip
included — a peer lane merges its own PR and keeps working. Before removing one
you did not add, confirm it is finished (`git log --oneline -1 <branch>`, then
`gh pr list --state all --head <branch>` for an OPEN PR), and when in doubt
leave it and say so in the wrap. Read every such probe — the §4 claim comment,
§2's dirty-tree check, the log, the PR state — as evidence of LIFE only; none
can establish absence. An absent claim comment is NO signal, never "unowned"
(the §4 comment is this repo's only ownership record, written once at claim
time — so its timestamp is CLAIM time, not last activity, and an old stamp is
equally what a long-running live session looks like), and a MERGED PR is not
proof of death — its owner may still be inside §9 or §10. Run the probes to
find a reason to LEAVE a worktree, never as a licence to remove one — on
2026-08-19 (go-to-k/cdk-real-drift#1775) a run read a peer's worktree as
residue while that lane was merging go-to-k/cdk-real-drift#1773.

Finally, comment the outcome on each issue if it was not auto-closed.
**RELEASE the claim on every issue that did NOT auto-close.** `--delete-branch`
has just deleted the branch your claim names, so what is left on the issue is a
lock pointing at nothing: the next session reads "Working on this in branch
<gone>" and either skips a free issue or has to prove you are finished. Derive
the population mechanically rather than from memory -- it is every issue this
run CLAIMED, minus the ones now CLOSED:

```bash
for n in <the issues you claimed>; do
  printf '#%s: ' "$n"; gh issue view "$n" --json state -q .state
done
```

Every `OPEN` in that list needs a release comment. **They are exactly the
partially-closed ones** -- a `Closes #N` PR auto-closes its issue and needs
nothing, while a lane that shipped part of an umbrella said `Refs` on purpose,
which auto-closes nothing. So the issues that keep a stale claim are the same
ones a future session is most likely to pick up, which is what makes this worth
a mechanical step rather than a habit.

Say three things in the comment, because a bare "released" makes the next
session re-derive what you already know: that the issue is now UNCLAIMED, what
the merged PR actually closed, and what remains WITH the reason it was left --
an unsettled trade-off and a missing design decision read very differently to
someone deciding whether to start. Carry forward anything expensive the lane
measured (a live arm it built, a population it derived, a family of bugs it
found), so the next lane inherits the evidence rather than the diagnosis.

A claim on an issue that DID auto-close needs nothing: a closed issue is not a
lock, and commenting on it only adds noise.

Do NOT stop
here: what the run taught you is still only in this session's context, so go on to
§10 — which also decides WHERE each lesson belongs (memory is the weakest of the
options there, not the default one).
