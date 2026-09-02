<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

Trigger: after §9's last lane is merged and every worktree THIS run added is
removed — an IN-PLACE run added none, so for it the trigger is the last merge —
BEFORE the wrap report; the evidence exists only while this session's context is
alive.

`/verify-pr` step 11's retrospective was per LANE; this one covers **the flow
itself** (this skill's docs + the skills it drives) across the WHOLE run —
cross-lane patterns are invisible from one lane — and **applies** the fix: a
routine call. Escalate via `AskUserQuestion` only when the edit changes what the
flow PROMISES (dropping a gate, lowering a tier, loosening §0), never for
wording, ordering, or a new trap.

### 10-0. Measure the run's net effect on the backlog

Count closed vs filed, put both in the wrap report, and split filed by what §5's
open-issue window did with each finding:

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
predicted when it was written.** A QUERY — nobody re-opens a decision they
remember making deliberately:

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

Pipe the loop through `sort -u`: a body naming a file twice otherwise prints two
findings.

**A hit is a prompt for judgement, not a verdict** — the check cannot tell a
citation from a target (one hit named four files, three cited as precedent).
A SHARED BASENAME makes it worse than uninformative: the suffix match is what
lets a body name a file by basename, so `verify.sh` (or `package.json`,
`index.ts`) matches every sibling directory at once — measured 2026-09-02, three
deferrals produced 27 hits naming nine fixtures, and the count discriminated
nothing. Read such a hit as a DIRECTORY question ("which of the sites this issue
lists did the run open?"), never as a file one.
Do the item now while the context is loaded, or re-classify it in the issue
body with the reason.

**And re-read the REASON, not just the files, because a deferral reason can name
a state that has since resolved.** A reason phrased in the run's transient state
("the PR is still open", "a fifth review round") is FALSE once that state
resolves; re-reading an expired premise is not re-litigation — keeping a `next`
alive on it is (2026-08-26, go-to-k/cdkd#2259 deferred behind go-to-k/cdkd#2247;
the reason outlived the merge).

Report one line — `closed N / filed M (new K / folded J)` — and **when M > N,
give the reason in one more line**. `J = 0` over several findings in one area
signals §5's window was searched by this instance's spelling, not the concept.
Only the first of the three usual reasons is healthy:

- **the code really does have that many independent defects** — say which area,
  so the next hunt aims there.
- **one root cause was split into many issues** — fold what is still open into
  an umbrella now.
- **discoveries were deferred that had session-only evidence** — re-read the
  `now` criteria in `CLAUDE.md`; a repro that dies with this session is not a
  residual.

**M <= N is NOT a target, and must never become one.** An unfiled finding is
strictly worse than a filed one — it removes the defect from the record while
leaving it in the product. The count makes growth VISIBLE, never a reason to
not file, soften, or merge independent defects. If you ever weigh whether to
file, file.

### 10-a. Evidence: only what this run actually produced

Walk the session and collect, each with its concrete instance:

1. **Corrections the user made.** Two on one theme across lanes is a defect in
   this text; the second occurrence is the signal.
2. **Text that was WRONG as written**: a failed command, a probe reporting
   clear while a lane was live, a flag / path / gate name gone.
3. **Steps you had to invent** because the skill is silent — the next run would
   re-invent them.
4. **Right instruction, wrong place** — done, but a step too late (claim after
   triage; rebase found after the phantom diff).
5. **Followed it and still paid** — text obeyed, retry happened anyway.

**No evidence, no edit.** A clean run's output is one wrap line
("retrospective: no skill change — §2 / §4 / §8 held"). A skill grown from
"this would be nice" stops being read to the bottom, where §9 and §10 live.

**And evidence you were HANDED is not evidence you VERIFIED.** The observation
usually survives the hand-off intact; the CAUSAL STORY attached to it does not,
because a plausible mechanism is cheap to write and costs a command to check. So
resolve the mechanism against the file before writing it up — the line, not the
belief about the line. Measured 2026-09-03 in this run's own retro: an
orchestrator handed a lane "a leaked `.markgate-pr-review-sha` would have merged
a higher-tier PR on a review of a DIFFERENT, already-merged PR", which is
fail-OPEN and alarming and wrong. `pr-review-gate.sh:344` passes only when
`recorded_sha = head_sha`, so the leak BLOCKS. The observation (markers leak
between IN-PLACE lanes) was real; the consequence was invented, and it survived
because everything around it was correct. Two properties make this the expensive
kind of error: it arrives from the party a lane trusts most, and prose is the
one artifact in the repo that no gate executes — which is why §10-d sends a
skill-only PR through reviewers at whatever tier its SIZE gives, with no
docs down-bias.

### 10-b. Where the fix belongs — pick ONE

- **A hook** (`.claude/hooks/`) when the failure is mechanically detectable —
  strongest, and the RIGHT answer when the rule was ALREADY in the text and got
  violated anyway: that proves the sentence is not load-bearing, and another
  will not be. Escalate rather than restate.
- **This skill's stage files** for lessons about running THIS flow — the
  `references/<stage>.md` where the lesson fires, never the SKILL.md
  orchestrator unless the stage list changed (byte-capped by
  `tests/unit/skills/skill-file-payload.test.ts`, the stop on the growth loop
  behind the 120 KB predecessor).
- **Another skill**, only one this run exercised (`/run-integ`, `/verify-pr`,
  `/review-pr`, `/merge-pr`, `/create-integ`, `/check-cdkd-parity`).
- **`.claude/CLAUDE.md` / `.claude/rules/**`** when it applies to any work in
  this repo (both in the `docs` gate's scope — editing them stales that
  marker).
- **Memory** for judgmental, cross-repo lessons — weakest enforcement; the
  landing spot when nothing above can hold the rule, not the default.

### 10-c. How to edit: amend, do not append

Every run appending one more bullet is how a long skill becomes an unread one.

- Put the fix **in the step where it fires** — a claiming lesson belongs in §4.
  Gotchas is for traps that span steps, not a run log.
- **Amend the sentence that was wrong** rather than adding a sibling — two
  near-duplicate bullets blunt each other.
- **Carry the evidence inline** (date, issue / PR number, what happened) — a
  rule with no incident behind it cannot be re-judged or retired.
- **Pay for what you add**: cut a line this run proved stale, subsumed, or
  wrong. Net growth is fine for a new lesson; unbounded growth is not.
- Do not restate a rule already in `CLAUDE.md` or another step — point at it.
- A FLOW lesson (vs a cdk-local one) belongs in the same-named `work-issues`
  skill in ALL THREE repos (`../cdkd`, `../cdk-real-drift`): **the session
  that FINDS it owns all three landings** before it ends, adapting the wording
  per repo (gates and ship steps differ), one PR per repo — and **that one PR
  carries ALL of the run's lessons for that repo, not one PR per lesson** (the
  gate cycle is the per-PR cost). Landing in one repo is how they drift.
  **Filing mirror issues instead is a WHOLE-REMAINDER exception, not the
  fallback of first resort**: only when the session cannot pay the remaining
  gate cycles, file into EVERY remaining repo in the SAME turn, each naming
  the other filings plus the repo already landed in (each with the
  `Session-fit` line, in English, per §4). Partial filing manufactures
  duplicates: go-to-k/cdk-local#531 mirrored a SUBSET of go-to-k/cdk-local#528
  minutes later, both closed by one PR (go-to-k/cdk-local#532);
  go-to-k/cdkd#2011 / go-to-k/cdkd#2016 hold the same shape open. **And a lane
  WORKING a mirror issue does not mirror onward** — the clause that stops the
  generator: re-filing a lesson you RECEIVED manufactures copies (the
  originating session owns all three landings); only what your ADAPTATION
  taught you is new, same rule in turn.
  **Inside this scope, `Session-fit: next` is not an available answer.** A run
  framed as "one session across the repos" cannot classify its discoveries out
  of it; three tells: filing the SAME issue body into more than one repo (the
  split §10 exists to end); a mechanical fix whose evidence is live in this
  run; a prior "finish it here" from the user, which a discovery inherits.
  §4's fields make a deferral HONEST, not available — a defensible `Effort` /
  `Estimate` for work the run is positioned to do is the tell. (2026-08-20: a
  cross-repo session re-filed its remaining gap as three per-repo issues;
  fixed same-session after the user objected — same session is the bar, same
  PR only when reviewable together.)
  **Verify the copy against the TARGET repo, claim by claim, before shipping
  it.** A sentence true here reads authoritative there while false, and
  nothing lints instruction prose — the first mirror (2026-08-18) carried four
  false claims, caught only by a read-only reviewer per target repo checking
  each gate name, hook behavior, skill name, path and cross-reference against
  that repo's files. Kept here, not in memory (per-project-path, per-machine —
  it would not load in the target repos).
  **Verify the cited EVIDENCE too, not only the repo-specific nouns — open the
  issue or PR the source names and confirm it says what the source claims.**
  Evidence can be wrong where WRITTEN and travel intact: go-to-k/cdk-local#504
  (2026-08-19) quoted a claim that go-to-k/cdk-real-drift#1761 showed a flaky
  rc=0/rc=1 tsgolint artifact; it records a DETERMINISTIC exit 134 (Vite+
  stdout `EAGAIN` panic). Reading it and go-to-k/cdk-real-drift#1765 cost one
  command each.
  **Fully qualify EVERY issue / PR reference in this file — same-repo ones
  included — as `go-to-k/<repo>#N`.** This file travels between the three
  repos, so a bare `#N` mirrors into a dead link or an unrelated real issue.
  Mechanized: `tests/unit/skills/work-issues-skill-refs.test.ts` fails CI on
  any unqualified `#N` in the plain prose of any mirrored agent-instruction
  file (`.claude/skills/**`, `.claude/agents/*.md`, `.claude/rules/*.md`);
  frontmatter, fenced code and backtick spans are exempt.

  **But NOT in a PR or issue BODY — there the qualified form is refused, and a
  full URL is the only spelling that passes.** A body does not travel;
  `pr-body-item-number-gate.sh` allows only the `closes #N` form, a
  parenthesized `(#N)`, fenced code, and full GitHub URLs — the SAME-repo
  qualified form is refused too (`go-to-k/cdk-local#587` blocked like
  `go-to-k/cdkd#1821`), so "qualify it" is never the fix in a body. Pick by
  DESTINATION: `go-to-k/<repo>#N` under `.claude/**`,
  `https://github.com/go-to-k/<repo>/issues/N` in a body. Nothing detects the
  mismatch until `gh pr create`; measured 2026-08-27, the refusal aborted a
  whole `python3 <<PY ... PY` heredoc chained to the publishing `gh api`
  before the heredoc ran — the retry then reports the identical violation,
  which reads as "my fix did not work" when the truth is "my fix never ran"
  (a gated command needs its own Bash call).

### 10-d. Ship it like any other change

After `/merge-pr` you are back on `main` (`branch-gate` blocks commits;
`main-tree-branch-gate` blocks branching there), so the retro gets its own
worktree:

MAIN-CHECKOUT (§3's launch-mode probe) — run THIS block, and not the next one:

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

IN-PLACE — run THIS block INSTEAD of the one above, never both: there is no
worktree to add, and `git worktree add` from inside this tree NESTS the very
worktree this mode exists to prevent. There is also no `main` to be back on;
the lane's own tree is still here with its deps installed, so take the retro
branch IN IT. `B` is re-assigned because a separate fenced block is a separate
shell (§9's `$MAIN` trap), and the merged lane branch cannot be reused
(re-pushing it is refused by post-merge-orphan-push-gate).
`main-tree-branch-gate` backs this switch up against a cwd reset, and since
go-to-k/cdk-local#641 (merged 2026-09-02) that covers the CHAINED form below,
not only a bare `git switch -c`. §5 carries the measurement and the one-line
grep that says whether the coverage is still on `main`.

```bash
B=chore/work-issues-retro-<lesson-slug>
git fetch origin && git switch -c "$B" origin/main
```

- `chore:` prefix — agent tooling, not `src/**`; a `fix:` / `feat:` prefix
  makes semantic-release describe a user-facing change that never happened.
- English only in every committed line (`non-english-text-gate` enforces it).
- A `work-issues`-only edit sits INSIDE the `check` gate's scope
  (go-to-k/cdk-local#620: `.claude/skills/**` / `.claude/agents/**` /
  `.claude/rules/**` are the unit suite's INPUT); markers start absent in a
  fresh worktree and `gh pr create` is gated on `verify-pr` with no diff-scope
  exemption — run `/check`, `/check-docs`, `/verify-pr`. No `src/**` change
  means no integ or live-test.
- Merge with `/merge-pr <n>` — a hand-run `gh pr merge` from a side worktree
  is gate-blocked.
- `/review-pr` no longer down-biases `.claude/**` (go-to-k/cdk-local#501): a
  skill-only PR keeps the tier its size gives — read the whole diff at that
  tier; a wrong rule here propagates into every future session.
- **Merge it (via `/merge-pr`) before the wrap report**, which also removes
  the worktree — §9's closing check is "every worktree THIS run added is
  gone". An IN-PLACE run added none: it stops `/merge-pr` after step 4 (§9),
  and instead this is where the PARENT runs §9's IN-PLACE cleanup arm — **the
  LAST step of the whole run**, and the parent's even when §10 was dispatched to
  a subagent, because two agents must not both be switching one tree:
  `git show-ref --verify --quiet refs/heads/<LAUNCH_BRANCH> || echo 'gone -> use the fallback'`
  and then
  `[ -z "$(git status --porcelain)" ] && git switch --no-guess <LAUNCH_BRANCH> && git branch -D <every branch THIS run created> || echo 'STOPPED: dirty tree (commit or stash first), or the switch failed -- read above'`
  — §9's two lines verbatim, and every part of them is load-bearing: the
  `show-ref` gate is what sends you to §9's detach fallback instead; the
  dirty-tree test comes FIRST, because a switch carries uncommitted changes
  ACROSS onto the outer tool's branch and the `-D` then takes the branches that
  were holding your commits; it is as-is (no pull, no rebase, no fast-forward);
  CHAINED so a failed switch cannot leave the `-D` to run anyway; and
  `--no-guess` so a branch that is gone locally but still on `origin` is an
  ERROR rather than a silent re-creation at origin's tip; and the `|| echo` hangs
  off the WHOLE CHAIN rather than the test, because `A || B && C` parses as
  `(A || B) && C` and would run the switch on a dirty tree. The retro branch is
  one of those branches. §9 deliberately does NOT do that per-lane,
  because THIS section branches in the same tree and would undo it. Leaving
  the tree standing on the retro branch — the previous instruction here —
  makes the unmerged-lane Stop hook warn every turn (the appendix has the
  wording), and detaching instead is visible-surprising in the outer tool's
  UI; restoring what the tool created is quiet on both counts.
  `Session-fit: now`: deferring leaves main self-inconsistent (the
  skill keeps prescribing what this run proved wrong), the evidence dies with
  the session, and the open PR is NOT CLOSEABLE.

Then report the outcome in one wrap line: what changed, in which step, and the
run evidence — or "no skill change" plus what held.
