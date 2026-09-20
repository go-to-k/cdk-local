---
name: work-issues
description: Work through already-filed GitHub issues (typically the bug-hunt's output) end to end — triage safely, pick as many FILE-DISJOINT issues as the run can carry, claim each on the issue before starting, verify, then carry each through merge (via /merge-pr) → pull → worktree cleanup. Use when asked to "handle/address filed issues", not to hunt for new bugs (/hunt-bugs).
argument-hint: "[optional focus, e.g. 'start-alb issues' | '#231 #234']"
---

# Work Filed Issues

Take OPEN issues (usually filed by `/hunt-bugs`) and drive a few to merged
fixes. The differentiator over just "fix issue #N" is **safe, collision-free
PARALLELISM**: pick issues that cannot step on each other, announce which ones
you took, and only then start.

The golden rule: **decide the set FIRST, claim it on the issues, THEN edit.**
The issue comment is the lock — what stops two agents fixing the same thing and
colliding on the same file. The run does not end at the last merge: the retro
folds what it taught you back into these files.

## Launch mode: main checkout, or already inside a worktree

Every worktree instruction below assumes the MAIN checkout. From a linked
worktree instead (an Orca/ADE workspace, a `cd` into `.claude/worktrees/<x>`),
`git worktree add` NESTS one, and deleting the outer workspace takes the inner
tree and its uncommitted work with it (go-to-k/cdk-local#635).

**The PARENT runs the probe in `references/launch-mode.md` (the ONLY copy)
BEFORE stage 0** — §2's collision scan already consumes the answer, and
IN-PLACE its relative paths resolve to nothing, reporting an empty board read
as "no competing agents"; stages 0–3 go to a subagent that cannot compute it.
State all four values — `MODE`, `LANE_TREE`, `MAIN_CHECKOUT`, `LAUNCH_BRANCH` —
in the opening report before any lane starts, and pass them into every
dispatch: that report is their only recorded copy. `IN-PLACE` changes the
scan's paths, the claim, the branch recipe, the cleanup step, how `main` is
reached, and where the retro branch goes; that file maps each to its stage.

## How this skill is packaged (read before stage 0)

This file is a thin orchestrator; the procedure lives in per-stage files under
`references/`, so a run loads only the stage it is in. **Reading the stage file
at entry is MANDATORY** — each carries rules without which the summary below is
not executable. **Delegate for context; keep the locks and the serialization in
the parent.**

- **Triage (stages 0–3): a read-only subagent** (general-purpose or Explore):
  read `references/triage.md` in full, execute it here, return ONLY the
  candidate table — per issue: number, title, target files, rank + the deciding
  rule, collision evidence, premise-check findings. Hand it the probe's four
  values (§2's worktree scan needs the absolute main checkout). The raw backlog
  listing and issue bodies stay out of the parent.
- **Claim (stage 4): the PARENT, never a subagent** — the claim is the lock, so
  it names the session accountable for the lane, plus the lane branch/worktree
  the subagent will create (§4) — IN-PLACE too, in the tree already here. Never
  `LAUNCH_BRANCH`.
- **Lanes (stages 5–8): one general-purpose subagent per claimed issue.**
  Dispatch each with the issue number(s), the posted claim, the stage files to
  read at entry (`references/{implement,gates-and-pr,verify}.md`, plus
  `launch-mode.md` IN-PLACE), and the probe's four values. The lane creates its
  own worktree per §5 — or works in place — implements (unit + fixture coverage
  in the SAME PR), runs `/check` + `/check-docs`, opens the PR,
  dispatches its review (reviewer subagents, SYNCHRONOUSLY — §8), addresses
  findings, drives CI green — then STOPS at merge-ready and reports PR number,
  HEAD sha, review verdicts, the integ fixture(s) its diff needs, anything
  deferred. Its diffs and review round-trips stay out of the parent context,
  and it never starts `/run-integ` or a merge itself — it asks the parent for
  that turn.
- **Finishing (stage 9): the parent, one lane at a time.** Grant each
  merge-ready lane its turn — resume the lane agent (SendMessage) to run its
  integ fixture(s) and `/merge-pr` while it holds the turn, or run both
  yourself FROM THAT LANE'S WORKTREE: the `integ` marker is per-worktree, so it
  must land in the tree the merge is judged from (§9).
- **Retro (stage 10): a subagent**, dispatched after the last merge with
  `references/retro.md` plus this run's evidence (what you re-read, what the
  text sent you into, corrections the user made) to measure the backlog effect,
  draft the skill edits, and ship the retro PR.

Running a lane in the parent stays legal; the stage files apply unchanged. A
bare `§N` below points into the stage file holding that section.

## Stages

| Stage | File (read at entry) | What it covers |
|---|---|---|
| Before 0. Launch mode | `references/launch-mode.md` | The probe (ONLY copy), its values, the IN-PLACE consequence table |
| 0. Safety screen | `references/triage.md` | `author_association` via REST; never run third-party content |
| 1. List backlog | `references/triage.md` | REST listing, volume assessment |
| 2. Collision landscape | `references/triage.md` | Worktree/branch/PR probes via `<MAIN_CHECKOUT>`, their blind spot, the shared modules one lane may own |
| 3. Pick file-disjoint issues | `references/triage.md` | Lane count, batching as the DEFAULT, ownership probes, disjointness gate, ranking, premise checks |
| 4. Claim | `references/claim.md` | Claim BEFORE first edit; claim what you FILE too; re-check before starting |
| 5. Implement | `references/implement.md` | One tree per lane, build before first test, sibling-site sweeps, unit + integ in one PR |
| 6. Checks + PR | `references/gates-and-pr.md` | `vp run verify`, `/check` + `/check-docs` as recommended, the two merge conditions |
| 7. Main advanced | `references/gates-and-pr.md` | Rebase over parallel merges; run a peer's new repo-wide check over your diff |
| 8. Verify before merge | `references/verify.md` | `/verify-pr`, `/run-integ`, reviewer dispatch, live test, §8-z's mutation probe |
| 9. Ship | `references/ship.md` | `/merge-pr` → pull → cleanup; owner probes before removing a worktree |
| 10. Retro | `references/retro.md` | Net backlog effect, promotion check on `next` filings, where a lesson lands, the retro PR |
| Appendix | `references/gotchas.md` | Gotchas + the rules this skill leans on |

## Hard invariants (hold between stage reads)

- **Safety first**: never download, unpack, run or install anything a
  non-maintainer attached or linked; read bodies via `gh api` only. (§0)
- **Claim before the first edit, on every issue you take** — and claim what you
  FILE when this run means to pick it up; re-check right before starting.
  Before a lane's first write the claim is the ONLY artifact proving it exists.
  (§2, §4)
- **Two lanes never edit the same file**; at most one lane per shared
  cross-cutting module (list in §2). (§3)
- **Never work in the main checkout** — one tree per lane: a new worktree under
  `.claude/worktrees/<branch>/`, or the launch worktree IN-PLACE. (§3, §5)
- **Never defer the integ**: a `src/**` fix ships its Docker/fixture coverage in
  the SAME PR; the `integ` marker gates the merge. (§5, §8)
- **Merge only via `/merge-pr`** — a hand-run `gh pr merge` from a side worktree
  trips the `'main' is already used by worktree` fatal; a lane never merges on
  its own. (§9)
- **Docker-side integ runs and merges are SERIALIZED across lanes** — the
  parent grants the turn, one at a time. Everything else runs concurrently:
  markers are per-worktree, the Docker daemon is shared. (§8, §9)
- **The run ends with the retro (stage 10) and the standard wrap report**
  (Remaining work / Session close), unprompted.
- **A lesson lands in the STAGE FILE it belongs to**, never here, unless the
  stage list itself changed (§10-b/§10-c).
