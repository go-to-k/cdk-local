<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 9. Ship: merge → pull → cleanup (all via `/merge-pr`)

Merge every verified PR with the `/merge-pr` skill — NOT a hand-run
`gh pr merge --squash --delete-branch`:

```
/merge-pr <n>
```

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
`main` each of them rolls the same dice. On 2026-08-19 the go-to-k/cdk-local#509
lane's suite runs hit the go-to-k/cdk-local#515 timeout twice (2/2 in that
worktree) while the fix sat unmerged in a sibling lane; merging the fix
(go-to-k/cdk-local#522) and rebasing made the very next run green. The rebase is
what delivers the fix — a lane branched before the merge keeps flaking on its
own stale base. Corollary for a PR's CI: it runs on the MERGE ref (branch +
current `main`), so a red check can be caused by a PEER's just-merged content
your local green never saw — go-to-k/cdk-local#524's new reference harness
failed CI on a line go-to-k/cdk-local#520 had merged in parallel; the fix was
fetch + rebase + re-run, not distrusting the harness.

```bash
git checkout main && git pull origin main    # bring the merges local
```

So when your PR landed into a file another PR touched in the same window, grep the
merged `main` for a marker string from EACH side before believing both survived —
one side silently overwriting the other looks exactly like a clean merge. Grep the
MERGED text, not a working copy:
`git show origin/main:<file> | grep -cF "<marker>"`. Run from a lane worktree, a
grep of `<file>` reads YOUR branch and passes while main is missing the very lines
being checked (cdkd's copy of this check was vacuous for a while in exactly that
shape, go-to-k/cdkd#2009); after the checkout+pull above the main checkout's file
IS the merged text, but the `git show` form is correct from anywhere. `-F` is
load-bearing — prose markers are full of regex metacharacters (`.`, `[`, `*`),
and without it a marker silently fails to match, producing exactly the false
lost-content alarm this check exists to prevent (it is the double quotes, not
`-F`, that handle apostrophes). And `grep -c` exits 1 on zero matches — the very
case being hunted — so never chain the two greps with `&&`. Pick a phrase that
sits on ONE LINE of the merged file: this file's prose is hard-wrapped, grep is
line-based, and a marker spanning the wrap returns a false 0 (measured while
writing this paragraph — a phrase from go-to-k/cdk-local#530's own merged text
scored 0 until it was re-picked within one line). Source each marker
from MERGED text, never from a title or a draft you read earlier: take THEIRS
from their merge commit
(`git show "$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid):<file>"`).
On 2026-08-19 a marker lifted from go-to-k/cdk-local#518's title
("uncommitted-work probe") was absent from `main` while its actual text —
`status --porcelain`, "dirty tree" — was present, and in cdkd a draft-sourced
marker against go-to-k/cdkd#2000 came back 0 after the lane reworded the sentence
between the draft and the merge — both false lost-merge alarms. Read the two
counts asymmetrically: whichever lane merged LAST has its marker read back out of
what is now the tip, so that arm is tautological — two `1`s are one real
confirmation plus one tautology, never two independent ones. Settle a 0 from your
lane worktree with `diff <(git show origin/main:<file>) <file>` — the lines your
commit removed should be exactly the ones you meant to replace.

`/merge-pr` already removes the worktree it merged AND deletes the local branch —
its step 5 runs `git branch -D`, and `-D` is load-bearing because this repo
squash-merges: a merged tip is never an ancestor of `main`, so `-d` refuses it as
"not fully merged". Read that refusal as the expected squash artifact, not as
unmerged work — but only after confirming the PR is MERGED. The closing check is
that **every worktree AND every local branch THIS run added is gone** — never that
only the main checkout remains. `git worktree remove` on its own never deletes a
branch, so a crashed or interrupted `/merge-pr` leaves the local ref behind
(cdkd's section 9 claimed otherwise and accumulated a dozen stale merged
branches before go-to-k/cdkd#2015 corrected it):

```bash
git worktree list      # yours gone; one you did NOT add may be a LIVE peer lane
git worktree prune     # drops entries whose directory a peer already removed
git branch --list      # local branches THIS run created are gone too
```

`git worktree list` cannot tell you whose a worktree is: a finished lane and a
session working right now look identical, an already-on-`main` branch tip included
— a peer lane merges its own PR and keeps working. Before removing one you did not
add, confirm it is finished (`git log --oneline -1 <branch>`, then `gh pr list
--state all --head <branch>` for an OPEN PR), and when in doubt leave it and say so
in the wrap. Read every such probe — the §4 claim comment, §2's dirty-tree check,
the log, the PR state — as evidence of LIFE only; none can establish absence. An
absent claim comment is NO signal, never "unowned" (the §4 comment is this repo's
only ownership record, written once at claim time — so its timestamp is CLAIM
time, not last activity, and an old stamp is equally what a long-running live
session looks like), and a MERGED PR is not proof of death — its owner may still
be inside §9 or §10. Run the probes to find a reason to LEAVE a worktree, never
as a licence to remove one. In cdk-real-drift on 2026-08-19 (go-to-k/cdk-real-drift#1775) a run
read a peer's worktree as residue of the previous run — the reading the old wording
invites — and that lane merged go-to-k/cdk-real-drift#1773 while the reading lane
was still open.

Finally, comment the outcome on each issue if it was not auto-closed. Do NOT stop
here: what the run taught you is still only in this session's context, so go on to
§10 — which also decides WHERE each lesson belongs (memory is the weakest of the
options there, not the default one).

