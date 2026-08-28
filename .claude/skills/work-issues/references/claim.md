<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 4. CLAIM the chosen issues BEFORE editing

For EACH issue you will start:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

(English only — committed/public artifacts are English, and that includes every
issue this run FILES, not just the claim comment. The classification lines
(`Session-fit` / `Severity` / `Effort` / `Estimate`, one field per line — see
`CLAUDE.md` → "The four TODO fields") and their parenthetical glosses are part
of the issue body, so write them in English —
`Session-fit: next (not this session)`, `Estimate: ~1-3 h — one integ run`.
On 2026-08-19 the go-to-k/cdk-local#506
follow-up (go-to-k/cdk-local#509) shipped with the Japanese gloss and had to be patched after
creation; `non-english-text-gate` guards the PR diff, not `gh issue create`, so
nothing catches this for you.) The claim is mandatory and comes BEFORE the first
edit. It is the issue-level twin of the worktree
DISJOINT-FILE rule. Re-check for a competing claim/PR right before you start; if
one appeared, pick a different issue.

**Claim what you FILE, too — filing is not claiming.** An issue this run files as
its own deferral is invisible to every ownership probe: no branch, no PR, no comment,
and only §3-a's hour covers it. So when the issue is one THIS run means to pick up
itself (a `Session-fit: now` line in the body, where you write one), post the claim
comment in the same turn you file it. Name the LANE and what it defers from, not just
your current branch: a merged branch is deleted, so a claim naming the branch you are
on now reads stale at exactly the moment you come back for the issue — re-post the
claim with the real branch when you open that lane. An issue you are handing off to a
later session gets NO claim at filing time — that would park a released issue under a
session that has decided not to do it — but this says nothing about the LATER run
that takes it: that run claims it normally, per the mandatory rule above.

