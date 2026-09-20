<!-- Part of the /work-issues skill (§9). A bare §N points into the stage file holding that section; the map is SKILL.md's "Stages" table. READ THIS FILE IN FULL when your run enters this stage. -->

## 9. Ship: merge → pull → cleanup (all via `/merge-pr`)

### Serialization (parent-owned)

Grant one merge-ready lane at a time its turn — resume that lane agent
(SendMessage) to run its named integ fixture(s) and `/merge-pr` while it holds
the turn, or run both yourself FROM THAT LANE'S WORKTREE: the `integ` marker is
per-worktree, so it is visible only to a merge judged from the same tree.
Fixture(s) FIRST, then `/merge-pr`. The Docker daemon is shared host state
(container / network names, host ports, image tags, the orphan sweep), so never
two lanes' integ runs — nor two merges — at once. Everything after the merge
stays with the parent.

**A `SendMessage` that answers "queued" has NOT been delivered — read the reply
every time.** Only `Resuming agent ...` restarts the agent; a queued message
needs something ELSE to resume it, and a lane that ended on "merge-ready" is
stopped by definition, so the grant lands in a queue nothing drains
(go-to-k/cdkd#2417). Confirm it runs, or re-send at once.

### The merge

Merge every verified PR with `/merge-pr <n>`, never a hand-run
`gh pr merge --squash --delete-branch`: it squash-merges from inside the
feature worktree WITHOUT `--delete-branch` (so gh runs no local cleanup and
never trips the `'main' is already used by worktree` fatal a side-worktree
merge hits), then cleans worktree + local + remote branch in one pass. GitHub
merges a behind PR when the files are disjoint — which is why a clean merge
says nothing about whether a collision happened (§7).

**IN-PLACE (the launch-mode probe) stops `/merge-pr` at the `state=MERGED`
read: its LOCAL-CLEANUP step must not run at all** — the
`git worktree remove "$WT" --force` + `git branch -D "$BR"` one, named by what
it DOES because step numbers drift — since removing the tree it stands in
deletes its own cwd. Confirm the remote branch from here and report that the
local TREE is there ON PURPOSE.

**When one lane fixes a full-suite flake, merge THAT lane first** — every other
lane rolls the same dice until the fix is on `main`, and only a rebase delivers
it. And a PR's CI runs on the MERGE ref, so a red check can come from a PEER's
just-merged content your local green never saw: fetch + rebase + re-run, do not
distrust the check (go-to-k/cdk-local#524).

### Pull

MAIN-CHECKOUT — run THIS block, and not the next one:

```bash
git checkout main && git pull origin main
```

IN-PLACE — run THIS block INSTEAD, never both. `main` is checked out in the
main tree, so `checkout main` HERE dies with `'main' is already used by
worktree at ...`; never leave your own tree:

```bash
# <MAIN_CHECKOUT> is the ABSOLUTE path the launch-mode probe printed --
# SUBSTITUTED, never a shell variable: each fenced block is its own Bash call,
# and an empty `-C` does not fail, it re-targets the cwd.
git -C "<MAIN_CHECKOUT>" pull origin main
```

The flow ends at the pull — no rebuild step. Releases are BATCHED via
release-please: an ordinary merge only updates the standing `chore(release)`
PR, so do not poll for a version bump, and never merge the release PR unless
the user asked for a release.

**Confirming a same-window merge (§7).** One side overwriting the other looks
exactly like a clean merge. Grep the MERGED text — a working-copy grep reads
YOUR branch and passes — for a marker from EACH side:
`git show origin/main:<file> | grep -cF "<marker>"`, with `-F` (prose holds
regex metacharacters), a ONE-LINE marker, and no `&&` between the greps
(`grep -c` exits 1 on zero matches, the case being hunted). The lane that
merged LAST reads its own marker out of the tip, so that arm proves nothing.

### Cleanup

MAIN-CHECKOUT — run THIS block, and not the next one. The closing check is
**every worktree AND every local branch THIS run added is gone**, never that
only the main checkout remains: `git worktree remove` deletes no branch, so an
interrupted `/merge-pr` leaves the ref behind.

```bash
git worktree list      # yours gone; one you did NOT add may be a LIVE peer lane
git worktree prune     # drops entries whose directory a peer already removed
git branch --list      # local branches THIS run created are gone too
```

IN-PLACE — run THIS block INSTEAD, never both, and **run it LAST, in the
PARENT, not per-lane**: §10-d branches in this same tree, so restoring before
the retro PR merges would only undo itself, and §10 may be a subagent — two
agents must not both switch one tree. The run added no worktree and removes
none; what it owes is the BRANCH: put back the one it found, delete every one
it made. `<LAUNCH_BRANCH>` and `<every branch THIS run created>` are
SUBSTITUTION PLACEHOLDERS from the opening report, not shell variables (a fresh
Bash call is a fresh shell, and `git switch ""` is not the failure you want):

```bash
# The show-ref gate CHOOSES between this block and the fallback; the `|| echo`
# makes it PRINT the arm it selects.
git show-ref --verify --quiet refs/heads/<LAUNCH_BRANCH> || echo 'gone -> use the fallback'
[ -z "$(git status --porcelain)" ] \
  && git switch --no-guess <LAUNCH_BRANCH> \
  && git branch -D <every branch THIS run created> \
  || echo 'STOPPED: dirty tree (commit first), or the switch failed -- read above'
git branch --show-current                 # must print <LAUNCH_BRANCH>
git rev-list --count origin/main..<LAUNCH_BRANCH>
       # 0 for a fresh workspace; non-zero = the outer tool's own commits, not
       # yours to merge or fast-forward.
```

Do not restructure that chain. **Dirty test FIRST, `|| echo` off the WHOLE
chain**: `A || B && C` parses as `(A || B) && C`, so a `||` on the test alone
switches on a dirty tree — and `git switch` carries uncommitted changes ACROSS,
so a test after it sees a tree that only LOOKS clean while `-D` deletes the
branches holding this run's commits. **`-D`, not `-d`**: squash-merged tips are
never ancestors of `main`. **`--no-guess`**: with the branch gone LOCALLY but
still on `origin`, plain `git switch` RE-CREATES the outer tool's branch at
ORIGIN's tip instead of reaching the fallback; git then advises a `pull` — do
not, that is the fast-forward AS-IS withdraws.

Fallback, ONLY when `LAUNCH_BRANCH` was empty at probe time (launched detached)
or the `show-ref` gate printed `gone`. Chained for the same reason; no
`--no-guess` needed, since `--detach` takes a commit-ish. Detaching is
visible-surprising in the outer tool's UI — hence fallback, not default:

```bash
git fetch origin \
  && git switch --detach origin/main \
  && git branch -D <every branch THIS run created>
```

**AS-IS is the whole rule: RESTORE, never ADJUST.** A fast-forward is an edit
to somebody else's branch; if it is behind, that is the tool's business. One
prohibition per line, so no re-wrap splits a "never" from its command:
never `git pull` into `<LAUNCH_BRANCH>`,
never `git merge --ff-only origin/main` onto `<LAUNCH_BRANCH>`,
never `git rebase <LAUNCH_BRANCH>`,
and never `git branch -D <LAUNCH_BRANCH>` -- the delete takes the branches THIS
run created, and that one is the outer tool's.

REMOTE branches go on merge regardless (`delete_branch_on_merge`).

`git worktree list` cannot tell you whose a worktree is: a finished lane and a
live session look identical. Before removing one you did not add, confirm it is
finished (`git log --oneline -1 <branch>`, then `gh pr list --state all --head
<branch>`); in doubt, leave it and say so. Such probes are evidence of LIFE
only, never of absence — an absent claim is NO signal (a claim is written once,
timestamping CLAIM time, not activity) and a MERGED PR is not proof of death,
its owner may still be inside §9 or §10 (go-to-k/cdk-real-drift#1775).

### Release the claims

Comment the outcome on each issue that was not auto-closed, and **RELEASE its
claim** — the merge deleted the branch the claim names, leaving a lock pointing
at nothing. Derive the population mechanically: issues CLAIMED, minus those now
CLOSED.

```bash
for n in <the issues you claimed>; do
  printf '#%s: ' "$n"; gh issue view "$n" --json state -q .state
done
```

Every `OPEN` needs one — the partially-closed ones (a `Closes #N` PR
auto-closes its issue; an umbrella-slice lane said `Refs` on purpose), which is
what a future session is most likely to pick up. Say three things: the issue is
now UNCLAIMED, what the merged PR closed, and what remains WITH the reason.
Carry forward anything expensive the lane measured, so the next lane inherits
the evidence rather than the diagnosis. A claim on an issue that DID auto-close
needs nothing: a closed issue is no lock.

Do NOT stop here: go on to §10, which decides WHERE each lesson belongs.
