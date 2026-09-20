<!-- Part of the /work-issues skill (§4). A bare §N points into the stage file holding that section; the map is SKILL.md's "Stages" table. READ THIS FILE IN FULL when your run enters this stage. -->

## 4. CLAIM the chosen issues BEFORE editing

When lanes run as SUBAGENTS (the default for stages 5–8), the PARENT posts
every claim — the claim is the lock and must name the session accountable for
the lane — and its `<ref>` names the branch / worktree the dispatched lane
agent will create, not a branch the parent holds.

**An IN-PLACE run names the tree it is STANDING IN**
(`references/launch-mode.md`): the `<ref>` is the branch §5 will create plus the
`LANE_TREE` the probe recorded. Take the TREE from the opening report rather
than re-deriving it with `git rev-parse --show-toplevel`, whose answer follows a
cwd that may have silently reset to the main checkout. No WORKTREE will be
created, and a claim pointing at a worktree that never appears is exactly what
§9's owner probes misread.

**Do NOT claim `LAUNCH_BRANCH` — the branch checked out here right now is the
OUTER TOOL's, not this run's** (`references/launch-mode.md`: "a branch to PUT
BACK, never one to commit to"). So the name is COMPOSED here rather than read
out of git, and it does not exist yet: §5 creates it, after this stage. Write
"the branch §5 will create in `<LANE_TREE>`" and post the claim on time — a
claim delayed until the branch exists is a claim posted after the first edit,
which is the one thing this stage forbids. Such a run may still claim SEVERAL
issues (§3), since it runs its lanes serially, but every lane after the first is
claimed `QUEUED`.

For EACH issue you will start:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

English only — every committed/public artifact, including every issue this run
FILES. The classification lines (`Session-fit` / `Severity` / `Effort` /
`Estimate`, one field per line — `CLAUDE.md` → "The four TODO fields") and
their parenthetical glosses are part of the issue body, so write them in
English: `Session-fit: next (not this session)`. `issue-conventions.yml` now
checks an issue body AFTER it is created — it reports and asks for an edit, it
cannot refuse — so the text is public before you hear about it
(go-to-k/cdk-local#509 shipped with a Japanese gloss and needed patching after
creation).

The claim is mandatory and comes BEFORE the first edit — the issue-level twin of
the worktree DISJOINT-FILE rule. Re-check for a competing claim / PR right
before you start; if one appeared, pick a different issue.

**Claim what you FILE, too — filing is not claiming.** An issue this run files
as its own deferral is invisible to every ownership probe — no branch, no PR, no
comment — and only §3-a's hour covers it. So when the issue is one THIS run
means to pick up itself (a `Session-fit: now` line in the body), post the claim
comment in the same turn you file it. Name the LANE and what it defers from, not
just your current branch: a merged branch is deleted, so a claim naming the
branch you are on now reads stale at exactly the moment you come back for the
issue — re-post the claim with the real branch when you open that lane. An issue
you are handing off to a later session gets NO claim at filing time — that would
park a released issue under a session that has decided not to do it — but the
LATER run that takes it claims it normally.

**Stand a QUEUED lane down the moment the verdict is known, not at the wrap.** A
claim held by a session that has decided it will not reach the issue is worse
than none: peers skip that issue for as long as it stands, and the wrap can be
hours away. So the stand-down comment goes out when the DECISION lands. Carry
the four classification fields, and say what did NOT happen so the next agent
can trust it — no branch created, no file touched, and, since the claim named a
branch §5 would create, that the named branch does not exist.
