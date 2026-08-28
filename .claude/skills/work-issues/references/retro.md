<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

Trigger: after the last lane in §9 is merged and its worktree removed, BEFORE
the wrap report. This is part of the run, not an optional extra — the evidence for
it (what you had to re-read, what the text sent you into, which correction the user
had to make twice) exists only while this session's context is alive, and none of it
survives into the next `/work-issues`.

`/verify-pr` step 11 already ran a retrospective per LANE. This step has a different
subject and a wider scope, and neither is covered by that one:

- its subject is **the flow itself** — this skill's docs (SKILL.md + references/) and the skills it drives — not
  the code the lane changed;
- it spans the WHOLE run, so it can see the cross-lane pattern (the same probe
  missing twice, the same correction on lane A and again on lane C) that is
  invisible from inside a single lane;
- it **applies** the fix instead of proposing it. Editing this repo's own agent
  tooling is a routine call you make yourself — decide it, do not hand the
  maintainer a proposal. Escalate through `AskUserQuestion` only when the edit
  would change
  what the flow PROMISES — dropping a gate, lowering a verification tier, loosening
  §0 — never for wording, ordering, or a newly-learned trap.

### 10-0. Measure the run's net effect on the backlog

Before anything else in this step, count what the run did to the issue list and put
both numbers in the wrap report. Then split the filed count by what §5's
open-issue window did with each finding, because the aggregate cannot tell the two
apart and they mean opposite things:

```bash
# Folded INTO an existing issue rather than filed as a new one. `updatedAt`
# alone does NOT answer this: §4 makes every lane post a CLAIM comment on the
# issue it takes, so a bare updatedAt sweep counts this run's own claims and can
# never read 0. Count the issues whose BODY gained a checklist row instead.
gh issue list --state open --limit 200 --json number,updatedAt \
  --jq '.[] | select(.updatedAt > "<this run start ISO>") | .number' \
| while read -r n; do
    gh issue view "$n" --json body -q '.body' \
      | grep -qE '^[[:space:]]*- \[ \]' && echo "$n"
  done
```

**Then run the PROMOTION check on every `next` this run filed, because a
deferral is judged against the run that has now HAPPENED, not the run that was
predicted when it was written.** At wrap time nobody re-opens a decision they
remember making deliberately, so this is left as a QUERY rather than as a thing
to remember:

```bash
# For each issue this run filed, does the run's OWN merged diff touch a file
# that issue names? A hit means the deferral was written against a run that
# then went somewhere else.
RANGE="<the sha main was at when this run started>..origin/main"
git diff --name-only "$RANGE" | sort -u > /tmp/run-touched.$$
# The population is the issues this run FILED and left OPEN -- not the folded
# list above, and not the ones it filed and then fixed in the same lane, which
# section 3-a makes routine.
for n in <the numbers this run filed that are still open>; do
  b=$(gh issue view "$n" --json body -q .body)
  # The prose says every `next`; without this the loop also reports items
  # already classified `now`, which are not deferrals at all. `Session-fit`
  # carries no GitHub label, so it has to be grepped out of the body.
  printf '%s' "$b" | grep -q 'Session-fit: *next' || continue
  printf '%s' "$b" \
    | grep -oE '[A-Za-z0-9_][A-Za-z0-9_./-]*\.[a-z]+' | sort -u \
    | while read -r f; do
        # Suffix match, not equality: an issue body names a file by BASENAME far
        # more often than by full path (the bare file name, not the full
        # repo-relative one), and an exact whole-line compare misses
        # every one of those. Measured: the exact form fired on 1 of this run's 2
        # deferrals and missed the one whose body used the basename.
        grep -E "(^|/)$(printf '%s' "$f" | sed 's/[.[\*^$]/\\&/g')\$" \
          /tmp/run-touched.$$ | while read -r hit; do
            echo "PROMOTE #$n -- this run touched $hit"
          done
      done
done
rm -f /tmp/run-touched.$$
```

Pipe the whole loop through `sort -u`: a body naming the same file twice prints
twice, and the duplicate reads as two findings.

**A hit is a prompt for judgement, not a verdict** -- measured on this run's own
two deferrals, one hit on the single file its fix touches and the other hit on
FOUR, three of which its body cited as precedent rather than as files to change.
The check cannot tell a citation from a target, and should not try: its job is to
put the issue back in front of you at the moment the answer has changed.

A hit is still not something to skim past. Either do the item in this run -- the context that
made it cheap is still loaded -- or re-classify it in the issue body with the
reason it still does not belong here.

**And re-read the REASON, not just the files, because a deferral reason can name
a state that has since resolved.** Classifying once, when the item is created,
is right: it is what stops the post-merge moment being re-litigated. But it
freezes the DECISION, and a reason phrased in terms of the run's own transient
state -- "the PR carrying it is still open", "the lane holding that file is
mid-flight", "taking this now would be a fifth review round" -- is true when
written and FALSE the moment that state resolves. Measured in the sibling repo
go-to-k/cdkd on 2026-08-26 (issue go-to-k/cdkd#2259, deferred while
go-to-k/cdkd#2247 was still in review): the fix would have been a fifth review
round on that open PR, and the reason survived unchanged
into the wrap report after that PR merged, where it read as a considered
judgement rather than an expired one. Re-reading a premise that has expired is
not re-litigation; keeping a `next` alive on a reason that has stopped being
true is.

Report it as one line — `closed N / filed M (new K / folded J)` — and **when
M > N, give the reason in one more line**. `J` is the number §5's window exists to
move, and it is the only one of the three below that can be improved without
either missing a defect or leaving one unfixed; a run reporting `J = 0` over
several findings in one area is the signal that the window was searched by this
instance's spelling rather than by the concept. The reason is almost always one of
three, and only the first is healthy:

- **the code really does have that many independent defects** — the run walked into
  an untested area. Fine; say which area, so the next hunt aims there.
- **one root cause was split into many issues** — §5's sweep rule should have folded
  them. This is the failure mode to catch; fold what is still open into an umbrella
  now rather than next time.
- **discoveries were deferred that had session-only evidence** — re-read the `now`
  criteria in `CLAUDE.md`; a discovery whose repro dies with this session is not a
  residual, and deferring it means the next session re-derives it.

**M <= N is NOT a target, and must never become one.** The purpose of the system is
a correct codebase, not a short list: an unfiled finding is strictly worse than a
filed one, because it removes the defect from the record while leaving it in the
product. This count exists to make growth VISIBLE and route it to the right cause —
never to justify not writing a finding down, softening one, or merging two genuinely
independent defects into one vague issue to make the number smaller. If you ever
find yourself weighing whether to file, file.

### 10-a. Evidence: only what this run actually produced

Walk the session and collect, with the concrete instance attached to each:

1. **Corrections the user made.** Two on one theme — different lanes, different
   wording, same theme — is not a preference, it is a defect in this text. The
   second occurrence is the signal; the first one alone may be a one-off.
2. **Text that was WRONG as written**: a command that failed, a probe that reported
   a clear field while a lane was live, a flag / path / gate name that no longer
   exists.
3. **Steps you had to invent** because the skill is silent about them, and that the
   next run would have to invent again from scratch.
4. **Right instruction, wrong place** — you did the thing, but a step too late (the
   claim posted after the triage, the rebase discovered only after the phantom diff).
5. **Followed it and still paid** — the text was obeyed and a retry happened anyway.

**No evidence, no edit.** If the run was clean, the correct output is one line in the
wrap report ("retrospective: no skill change — §2 / §4 / §8 held"). A skill
that grows from "this would be nice" stops being read to the bottom, and the bottom
is where §9 and §10 live.

### 10-b. Where the fix belongs — pick ONE

- **A hook** (`.claude/hooks/`) when the failure is mechanically detectable.
  Strongest, and the RIGHT answer whenever the rule was ALREADY in the text and got
  violated anyway: that proves the sentence is not load-bearing, and another
  sentence will not make it so. Escalate rather than restate.
- **This skill's stage files** when the lesson is about running THIS flow (triage,
  claiming, fan-out, ship order). The edit target is the `references/<stage>.md`
  where the lesson fires — never the SKILL.md orchestrator, unless the stage
  list itself changed. SKILL.md's byte size is capped by
  `tests/unit/skills/skill-file-payload.test.ts`, which is the mechanical stop
  on the growth loop that produced the 120 KB single-file predecessor of this
  layout.
- **Another skill**, but only one this run actually exercised (`/run-integ`,
  `/verify-pr`, `/review-pr`, `/merge-pr`, `/create-integ`, `/check-cdkd-parity`).
- **`.claude/CLAUDE.md` / `.claude/rules/**`** when it applies to any work in this
  repo, not just this flow (both are in the `docs` gate's scope, so editing them
  stales that marker).
- **Memory** (`~/.claude/projects/.../memory/`) when the lesson is judgmental and
  cross-repo. Weakest enforcement — the landing spot when nothing above can hold the
  rule, not the default one.

### 10-c. How to edit: amend, do not append

Every run appending one more bullet is exactly how a long skill becomes an unread one.

- Put the fix **in the step where it fires** — a claiming lesson belongs in §4, not
  in a tail section. Gotchas is for traps that span steps, not a run log.
- **Amend the sentence that was wrong** rather than adding a sibling beside it. Two
  bullets saying nearly the same thing blunt each other.
- **Carry the evidence inline**, in this file's existing style: date, issue / PR
  number, what actually happened ("On 2026-08-11 ... pushed four minutes earlier").
  A rule with no incident behind it cannot be re-judged or retired later.
- **Pay for what you add**: look for a line this run proved stale, subsumed, or
  wrong, and cut it. Net growth is fine when the lesson is genuinely new; unbounded
  growth is not.
- Do not restate a rule that already lives in `CLAUDE.md` or in another step — point
  at it instead.
- If the lesson is about the FLOW rather than about cdk-local, it belongs in the
  same-named `work-issues` skill in ALL THREE repos (`../cdkd`,
  `../cdk-real-drift`), and **the session that FINDS it owns all three landings** —
  three worktrees, three PRs, three gate cycles — before it ends. They run this flow
  with different gates and different ship steps, so adapt the wording per repo rather
  than copying the section verbatim; it is one PR per repo under that repo's own
  worktree + gate flow, and **that one PR carries ALL of the run's lessons for that
  repo, not one PR per lesson** — the gate cycle is the per-PR cost, so a run that
  learned five things still ships three PRs. Landing the fix in one of the three is
  how they drift apart, and landing it in two is the same defect with a smaller
  number. **Filing mirror issues instead is a WHOLE-REMAINDER exception, not the
  fallback of first resort**: when the session genuinely cannot pay for the remaining
  gate cycles, it files into EVERY remaining repo in the SAME turn, and each issue
  names the other filings plus the repo the lesson already landed in, so the next
  reader can see the set is complete instead of re-deriving it (each carries the
  `Session-fit` line, in English, per §4). Partial filing is what manufactures
  duplicates: go-to-k/cdk-local#531 (filed 2026-08-19T06:46:00Z) mirrors three
  lessons that are a SUBSET of go-to-k/cdk-local#528's four (06:37:46Z) — two hops
  eight minutes apart, neither seeing the other, both then closed by one PR
  (go-to-k/cdk-local#532, merged 07:00:28Z); the sibling holds the same shape open —
  go-to-k/cdkd#2011 (06:17:34Z) and go-to-k/cdkd#2016 (06:37:52Z) mirror the same
  three cdk-local lessons 20 minutes apart, filed by two hops of one lesson set.
  **And a lane WORKING a mirror issue does not mirror onward** — this is the clause
  that stops the generator. The originating session already owns all three landings,
  so re-filing the lesson you RECEIVED into the other two only manufactures a second
  and third copy of it. What IS new is whatever your ADAPTATION taught you, and that
  is subject to the same rule in turn: all three repos, this session.
  **Inside this scope, `Session-fit: next` is not an available answer.** A run
  the user framed as "one session across the repos" cannot classify its own
  discoveries out of that session, and three tells make the call for you: you
  are about to file the SAME issue body into more than one repo (that is the
  split §10 exists to end, not triage); the fix is mechanical and its evidence
  is live in this run, with the repro built, the files open and a gate cycle
  already turning; or the user has already said "finish it here" for the
  surrounding task, which a discovery inside that task inherits rather than
  re-litigates. The four classification lines of §4 make a deferral HONEST;
  they do not make one available, and an `Effort` / `Estimate` pair that reads
  defensibly for work this run is already positioned to do is the tell that the
  fields are being used as an excuse. Watched here on 2026-08-20: the session
  carrying one `/work-issues` lesson into cdkd, cdk-local and cdk-real-drift
  found every PreToolUse gate inert, fixed the matcher in all three, then filed
  the remaining script-level gap as three separate issues — the per-repo split
  the user had asked it to end, rebuilt one classification line at a time. The
  fix landed in the same SESSION only after the user objected, as a follow-up PR
  per repo — same session is the bar, same PR only when the work is small enough
  to review together.
  **Verify the copy against the TARGET repo, claim by claim, before shipping it.**
  Their gates, hooks and ship steps differ, so a sentence that is true here reads as
  authoritative there while being false, and nothing lints instruction prose — the
  next agent simply acts on it. On 2026-08-18 the first mirror of this section
  carried four such claims: a `verify-pr` gate that exempts a non-`src/**` diff, a
  review heuristic that still down-biases `.claude/**`, a `CLAUDE.md` rule the
  sibling does not carry, and a hook it does not ship. A read-only reviewer per
  target repo — its only job being to check each gate name, hook behavior, skill
  name, path convention and cross-reference against that repo's own files — is what
  caught them. Checking in the rule here rather than in agent memory is deliberate:
  memory is per-project-path and per-machine, so it would not load in the very repos
  this bullet sends you to.
  **Verify the cited EVIDENCE too, not only the repo-specific nouns — open the issue or
  PR the source names and confirm it says what the source claims it says.** The nouns
  fail when a sentence travels between repos; the evidence can be wrong where it was
  WRITTEN, and then travels intact. On 2026-08-19 (go-to-k/cdk-local#504) the incoming wording — quoted
  verbatim into the issue — said "on [go-to-k/cdk-real-drift#1761] the `check` gate
  flipped rc=0/rc=1 across identical runs (the tsgolint budget-cascade artifact)".
  go-to-k/cdk-real-drift#1761 itself records a DETERMINISTIC exit 134 from a Vite+
  stdout `EAGAIN` panic, measured 3/3 in each state (134 before the fix, 0 after), with
  tsgolint nowhere in it. Nothing had drifted; the source sentence was already false,
  and a per-repo noun check would have passed it through. Reading
  go-to-k/cdk-real-drift#1761 and go-to-k/cdk-real-drift#1765 cost one command each.
  **Fully qualify EVERY issue / PR reference in this file — same-repo ones
  included — as `go-to-k/<repo>#N`.** A bare `#N` means "this repo" to whoever
  reads it, and this whole file travels between the three repos, so mirroring
  silently rewrites a correct citation into a wrong one: a cross-repo bare ref
  is a dead link or — worse — resolves to a real, unrelated issue. This
  paragraph had the defect while the rule was being written: it cited `#1761`
  and `#1765` bare, and `gh issue view 1765` here answered `Could not resolve
  to an issue or pull request`. The rule is mechanized, per §10-b's "a rule
  already in the text that got violated anyway is a TEST":
  `tests/unit/skills/work-issues-skill-refs.test.ts` fails CI on any unqualified
  `#N` in the plain prose of ANY mirrored agent-instruction file — every
  `.claude/skills/*/SKILL.md`, `.claude/skills/*/references/*.md`,
  `.claude/agents/*.md` and `.claude/rules/*.md`,
  not just this one, since a sentence travels from any of them. Frontmatter,
  fenced code blocks, and backtick spans are exempt, so a paragraph can still
  show a bare `#N` as its own counter-example (this one does).

  **But NOT in a PR or issue BODY — there the qualified form is refused, and a
  full URL is the only spelling that passes.** The rule above governs the
  agent-instruction FILES, which travel between repos. A PR body does not
  travel, and `pr-body-item-number-gate.sh` refuses any `#N` its allow-list
  does not cover -- `closes #N`, `(#N)`, fenced code and full GitHub URLs are
  allowed; `go-to-k/cdkd#1821` is not. Measured here on 2026-08-27: a
  `gh pr create` was blocked on two such refs, both of them correct
  cross-repo citations written to satisfy the rule above. The two
  requirements point opposite ways for the same string, so pick by
  DESTINATION: `go-to-k/<repo>#N` in a file under `.claude/**`, and
  `https://github.com/go-to-k/<repo>/issues/N` in a PR or issue body. Nothing
  detects the mismatch until the gate fires at `gh pr create`, which is after
  the body is written.

  Two measurements from writing THIS paragraph, both worth having. The gate
  refuses the SAME-repo qualified form too — `go-to-k/cdk-local#587` in a
  cdk-local PR body is blocked exactly like the cross-repo one, so
  "qualify it" is never the fix in a body; a full URL or a bare number in
  prose is. And the refusal hit a `python3 <<PY ... PY` heredoc chained to
  the `gh api` that would publish the body, so the WHOLE command was
  aborted before the heredoc ran: the retry then re-read an unedited file
  and reported the identical violation, which reads as "my fix did not
  work" rather than "my fix never ran". That is the gotcha below about a
  gated command needing its own Bash call, arriving through the one shape
  that disguises itself as a failed edit.

### 10-d. Ship it like any other change

`/merge-pr` removed every worktree THIS run added by §9 and you are back on
`main`, where `branch-gate` blocks a commit and `main-tree-branch-gate` blocks
branching in the main tree. So the retro gets its own worktree:

```bash
# Suffix the branch with the LESSON, not just the date: a merged branch is
# deleted (re-pushing that name is refused by post-merge-orphan-push-gate), and
# a bare date collides with a peer session doing its own retro the same day —
# on 2026-08-19 `chore/work-issues-retro-20260819` was already checked out by
# another lane when this one reached §10-d.
B=chore/work-issues-retro-<lesson-slug>
git worktree add ".claude/worktrees/${B##*/}" -b "$B" origin/main
cd ".claude/worktrees/${B##*/}"
mise trust && mise install    # untrusted .mise.toml: vp / markgate will not resolve
pnpm install                  # worktrees have no node_modules
```

- `chore:` prefix — this is agent tooling, not `src/**`, and semantic-release turns
  a `fix:` / `feat:` prefix into a user-facing release entry that describes a
  cdk-local change that never happened.
- English only in every committed line (`non-english-text-gate` enforces it at PR
  time).
- A `work-issues`-only edit sits INSIDE the `check` gate's scope
  (go-to-k/cdk-local#620: `.claude/skills/**` / `.claude/agents/**` /
  `.claude/rules/**` are the unit suite's INPUT — the byte-cap and bare-ref
  scanners read them — so a skills edit stales the marker exactly as a
  `tests/**` edit does), and `check-gate` verifies both markers on every commit
  anyway, and a fresh worktree starts with NONE — and `gh pr create` is gated on
  `verify-pr` with no diff-scope exemption. So run `/check`, `/check-docs`,
  `/verify-pr` there. No `src/**` change means no integ and no live-test.
- Merge it with `/merge-pr <n>` like every other lane — a hand-run `gh pr merge`
  from a side worktree is gate-blocked.
- `/review-pr` no longer down-biases `.claude/**` (issue go-to-k/cdk-local#501), so a skill-only PR
  keeps the tier its size gives — read the whole diff at that tier rather than
  treating a small text diff as low risk. A wrong rule in this file propagates into
  every future session.
- **Merge it (via `/merge-pr`) before the wrap report**, which also removes the
  worktree — §9's closing check is "every worktree THIS run added is gone", and
  §10 must not undo that. This is `Session-fit: now` on the criterion that
  deferring leaves main self-inconsistent: the skill would keep telling the next
  run to do the thing this run just proved it gets wrong. Its evidence also dies
  with this session's context. Leaving the PR open is an open PR (NOT CLOSEABLE)
  as well.

Then report the outcome in one line of the wrap: what changed, in which step, and
the run evidence behind it — or "no skill change" plus what held.

