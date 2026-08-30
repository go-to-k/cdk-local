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
numbered 5 today — name it by what it DOES, because `/merge-pr`'s own step 1
still calls the removal "step 4" and the number is the one part of this that
drifts. Skip it entirely, do the remote-branch confirmation (step 6) from this
tree, and say in the report that the local tree and branch are still there ON
PURPOSE. Cleanup of a workspace this run did not create belongs to whoever did
— the outer tool, or the operator.

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
  forces the merge through `/merge-pr` at all. Step 1's sanity check ("`WT`
  should be under `.claude/worktrees/`") has no arm for it either. Use
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
...`. Never leave your own tree; pull the main checkout through `-C`. `MAIN` is
derived HERE rather than borrowed from a neighbouring block — each fenced block
is its own Bash call and its own shell, so a variable assigned in another one is
empty here:

```bash
# The main checkout is always the FIRST row of `git worktree list`.
MAIN=$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')
git -C "$MAIN" pull origin main
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
unmerged work — but only after confirming the PR is MERGED. The closing check is
that **every worktree AND every local branch THIS run added is gone** — never that
only the main checkout remains. **An IN-PLACE run ADDED none, so it removes
none**: its closing check is that it left the launch tree and its branch exactly
as it found them, and the wrap SAYS whose cleanup that is instead of doing it.
`git worktree remove` on its own never deletes a branch, so a crashed or
interrupted `/merge-pr` leaves the local ref behind
(cdkd's section 9 claimed otherwise and accumulated a dozen stale merged
branches before go-to-k/cdkd#2015 corrected it):

```bash
git worktree list      # yours gone; one you did NOT add may be a LIVE peer lane
git worktree prune     # drops entries whose directory a peer already removed
git branch --list      # local branches THIS run created are gone too
```

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
