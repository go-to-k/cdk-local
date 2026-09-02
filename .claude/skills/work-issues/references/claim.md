<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 4. CLAIM the chosen issues BEFORE editing

When lanes run as SUBAGENTS (the orchestrator's default for stages 5–8), the
PARENT posts every claim in this section — the claim is the lock and must name
the session accountable for the lane — and the claim's `<ref>` names the branch
/ worktree the dispatched lane agent will create, not a branch the parent
holds. Everything else in this section is unchanged, including the re-check for
a competing claim/PR right before the lane starts.

**An IN-PLACE run names the tree it is STANDING IN**
(`references/launch-mode.md`): the `<ref>` is the branch §5 will create plus the
`LANE_TREE` the probe recorded. Take the TREE from the opening report rather than
re-deriving it with `git rev-parse --show-toplevel`, whose answer follows a cwd
that may have silently reset to the main checkout. No WORKTREE will be created,
and a claim pointing at a worktree that never appears is exactly what §9's owner
probes misread.

**Do NOT claim `LAUNCH_BRANCH` — the branch checked out here right now is the
OUTER TOOL's, not this run's** (`references/launch-mode.md`: "a branch to PUT
BACK, never one to commit to"). So the name is COMPOSED here rather than read out
of git with `git -C "<LANE_TREE>" branch --show-current`, and it does not exist
yet: §5 creates it, after this stage. Write "the branch §5 will create in
`<LANE_TREE>`" and post the claim on time. A claim delayed until the branch
exists is a claim posted after the first edit, which is the one thing this stage
forbids. Such a run may still claim SEVERAL issues (§3) — it runs its lanes
serially, not one issue per run — but every lane after the first is claimed
`QUEUED`, and a QUEUED lane the run will not reach is stood down rather than
left standing (below).

For EACH issue you will start:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

(English only — every committed/public artifact, including every issue this run
FILES, not just the claim comment. The classification lines (`Session-fit` /
`Severity` / `Effort` / `Estimate`, one field per line — see `CLAUDE.md` → "The
four TODO fields") and their parenthetical glosses are part of the issue body,
so write them in English — `Session-fit: next (not this session)`,
`Estimate: ~1-3 h — one integ run`. Nothing catches this for you:
`non-english-text-gate` guards the PR diff, not `gh issue create` — the
go-to-k/cdk-local#506 follow-up (go-to-k/cdk-local#509) shipped with a Japanese
gloss and had to be patched after creation (2026-08-19).) The claim is mandatory and comes BEFORE the first edit —
the issue-level twin of the worktree DISJOINT-FILE rule. Re-check for a
competing claim/PR right before you start; if one appeared, pick a different
issue.

**Claim what you FILE, too — filing is not claiming.** An issue this run files
as its own deferral is invisible to every ownership probe — no branch, no PR, no
comment — and only §3-a's hour covers it. So when the issue is one THIS run
means to pick up itself (a `Session-fit: now` line in the body, where you write
one), post the claim comment in the same turn you file it. Name the LANE and
what it defers from, not just your current branch: a merged branch is deleted,
so a claim naming the branch you are on now reads stale at exactly the moment
you come back for the issue — re-post the claim with the real branch when you
open that lane. An issue you are handing off to a later session gets NO claim at
filing time — that would park a released issue under a session that has decided
not to do it — but the LATER run that takes it claims it normally, per the
mandatory rule above.

**Stand a QUEUED lane down the moment the verdict is known, not at the wrap.** A
claim is a lock, and one held by a session that has already decided it will not
reach the issue is worse than none: peers skip that issue for as long as it
stands, and the wrap can be hours away. So the stand-down comment goes out when
the DECISION lands (a deadline, a cost directive, a re-scope), not when the
report is written. Carry the four classification fields, and say what did NOT
happen so the next agent can trust it — no branch created, no file touched, and,
since the claim named a branch §5 would create, that the named branch does not
exist. Measured on the overnight run of 2026-09-02 (go-to-k/cdk-local#650):
go-to-k/cdk-local#589 and go-to-k/cdk-local#583 were claimed at run start for a
session that never reached them, and standing them down mid-run unblocked peers
hours before the wrap.
