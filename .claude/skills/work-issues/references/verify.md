<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge (`/verify-pr`)

Run `/verify-pr`. It walks the full checklist (typecheck / lint / build / unit
tests / `vp run test:hooks`, CI status, docs consistency, Docker + integ marker,
code review, PR title/body freshness) and — critically — **live-tests the
changed behavior**:

**Run the integ LAST — and set the `check` / `docs` markers AFTER it, not before.**
A fixture run writes `cdk.out/`, `node_modules/` and `pnpm-lock.yaml` under
`tests/integration/<fixture>/`; the `check` gate covers `tests/**` (plus `src/**`, the files that decide what green means — `vite.config.ts` / `.mise.toml` / `.node-version` / `.markgate.yml` — `.claude/hooks/**` and the checker-input agent-instruction files and workflows; `.claude/rules/hooks.md` has the authoritative list) and markgate
digests those artifacts even though git ignores them (go-to-k/cdk-local#620), so
a green integ STALES a `check` marker set minutes earlier with `git status`
clean — a `git commit` refused for "digest differs" that no source edit explains
(2026-08-27). Order: edit -> integ -> `/check` -> `markgate set` -> commit.

**Then run the integ LAST in the other sense too: "last" does not hold still
across review rounds — so DECLARE the tree final, in words, to whoever is still
editing it.** The `integ` gate is `hash: diff` vs `merge-base(origin/main, HEAD)`:
even a comment-only change to an in-scope file stales the marker and costs a
Docker fixture run (2026-08-26, cdkd: three real-AWS runs of one fixture, one for
a zero-non-comment-line round). Its COMPLEMENT is worth knowing at the same
moment, because it turns deferrals into free fixes: the include is `src/**` plus
`tests/integration/**` and nothing else, so a `tests/unit/**` follow-up after a
green integ costs NOTHING (two findings this run was about to defer for "that
would need another Docker run" were neither). Tell the implementing agent,
explicitly, to batch every remaining finding into ONE commit and report the tree
FINAL, no second pass — otherwise it hands back per finding. Reviewer-side:
dispatch a round SCOPED to the delta, whole round's findings at once, not
trickled — the delta is where a fix-introduced blocker lives, which is the class
the paragraph below is about (go-to-k/cdk-local#672's fifth round, 2026-09-02,
read only the delta and returned FIVE findings, three of them defects in fences
EARLIER rounds had added) — **and paste the delta's COMMIT MESSAGE into the
brief.** All three
reviewer agents read `gh pr diff` / `gh pr view --json files`
(`.claude/agents/pr-{code,spec,test}-reviewer.md`) and none reads `git log`, so
a false claim written into a commit message is invisible to the whole tier
however many reviewers you dispatch (ported from cdkd, measured there
2026-08-29: a delta round's blocker was a commit message citing a function that
has never existed in that repo, reachable only because the orchestrator re-read
the message itself).

- **A `src/**` runtime change** → drive the affected flow end-to-end against
  Docker / a fixture (invoke the Lambda, hit the served route, run the task),
  not just the unit suite. For a concrete repro, reproduce with the FIXED binary
  (`vp run build` first — the CLI runs from `dist/`). `/run-integ <local-*>`
  exercises the real Docker path; keep or extend the covering fixture in the
  SAME PR.

  **Granting the integ turn is not the end of the parent's job: POLL, because
  nothing in that stack has a timeout.** `/run-integ` step 5 holds the recipe and
  the measurement behind it; the parent's half is simply that the poll has to
  measure the RUNNING THING. A watcher of this run polled `stat -f %z` on an
  agent's `.output` path, which is a SYMLINK, so it read the 153-byte link length
  — constant forever — reported three transcripts "size-stable", and was
  believed until `stat -Lf` showed them still growing. A probe that cannot move
  is indistinguishable from a job that has stopped, and it fails in the
  reassuring direction.

  **Live-test the CONSEQUENCE you WROTE DOWN, not only the code path.** A
  consequence derived by READING costs nothing to state and is durable: it lands
  in a code comment, `.claude/CLAUDE.md`, a commit message and an issue comment
  before anything tests it, and outlives the session as an unearned fact
  (implement.md's "a FACT you assert becomes a code comment" is the same decay
  reached by narrow QUERYING; this is the same decay reached by narrow READING).
  An A/B of the two configurations is usually one command. go-to-k/cdk-local#608
  (2026-09-02): "those warns vanish from the log binding" was written into all
  four artifacts and then REFUTED by one live run -- the warns are never lost,
  since non-response stdout lines are emitted as log events -- while the real
  defect was different and worse, the `agentcore` branch folding them INTO the
  response, so an invoke returns `WARN: ...` where the agent's JSON belongs. The
  run corrected the diagnosis; it did not merely confirm it.
- **A fixture that establishes the fix's PRECONDITION on the happy path cannot
  test the arm where the FAILING path creates it.** Such a fix cleared unit
  tests, a real-AWS fixture and four reviewers; the fifth traced the EVIDENCE
  (go-to-k/cdkd#2125). Here the state is what an earlier `local-*` phase
  leaves behind — a started `cdkl` process (`CDKL_PID`), a `cdkl-*` container or
  network, a written `.scenario.yaml`. Ask **which phase writes the state in the
  fixture, and which writes it in the reachable case**; if they differ, add the
  arm where ONE operation both creates and handles it, and prove it
  DISCRIMINATES by mutating the fix: original arm passes, new arm fails.
- **A `cleanup` that ALSO runs before the run must not destroy anything the run
  then needs.** A load-time scratch path (`WORKDIR="$(mktemp -d …)"`), an
  `rm -rf "$WORKDIR"` in `cleanup`, and a pre-run `cleanup` call are each
  correct alone; together the directory is gone before its first write —
  symptom: a bare `No such file or directory` far from the cause (cost a real
  cycle in cdkd). This repo is exposed: `local-*` fixtures DO call `cleanup`
  pre-run (`local-start-alb-redirect` and peers), surviving only because their
  `cleanup` sweeps PROCESSES and containers, which phases re-create — and
  because no fixture yet computes a scratch dir at variable-definition time;
  the first one that does arms this. Anything `cleanup` removes must be re-created by a phase or
  created AFTER the pre-run call; a stubbed dry run (pre-run cleanup, then the
  full run) catches it in seconds.
- **When a fix round produces the NEXT round's blocker twice, stop reviewing the
  patch and question its SHAPE.** Each fix is locally correct and moves the
  failure one layer out; the blockers are found by executing a probe, never by
  re-reading the diff. After round two, name what the rounds have in COMMON —
  usually one structural absence. Do NOT take the structural fix late in the
  cascade (new entrypoint code at round five is how round six happens): take the
  narrow fix, file the structural one, and reference it from the narrow fix.

  **Filing the structural fix does not stop the cascade, and the rule above used
  to imply it would** (2026-08-27, go-to-k/cdk-local#596: filed at round five,
  the rounds ran to TWELVE — five of eleven instances came from fixes). What
  ended it was making the artifact **CLAIM LESS**. The tell: each round's fix is more SOPHISTICATED than
  the last, while simple `rc`-only sweeps beside them stayed correct — the
  sophistication WAS the defect: `grep -q 'does not exist'` also matches
  botocore's `The source_profile ... does not exist`, raised before any network
  call, so a broken profile reported CLEAN having queried nothing. Delete the
  claim rather than defending it: the sweep now prints the raw output and names
  both outcomes instead of emitting a verdict — a command that claims nothing
  cannot claim something false. It is a retreat; it converges.

  Two corollaries, both paid for in that PR:

  - **Fence the REMEDIATION, not just the detection.** `cdk destroy` on names built
    without the suffix exits 0 SILENTLY, and every fence pinned the SCAN, so
    restoring that line left the suite green. If a recipe detects and repairs,
    the repair is where the next instance goes.
  - **Do not pre-commit to a remedy for a finding you have not seen.** "If
    instance nine appears, delete the whole thing" was stated before it existed;
    deleting would have left NO orphan check — instance one made permanent. Say
    what the next finding would have to SHOW, not what you will do.

  Two shapes recur, distinguishable a round apart:
  - **TWO SPELLINGS OF ONE QUESTION** — make both sites use ONE predicate
    verbatim; a better second spelling looks like a fix and passes its own test,
    so this sub-case keeps regenerating. Name the SITE THAT OWNS the question
    and make every other site call or copy it exactly. (go-to-k/cdkd#2134:
    ended only when the authority's test was copied character for character; the round
    before, the spellings still disagreed on the empty string, fail-OPEN.)
  - **A PROXY FOR A QUESTION ONLY ANOTHER COMPONENT CAN ANSWER** — make that
    component REPORT. The tell: each proxy is wrong in BOTH directions at once
    (spellings disagree at an edge; a proxy has no access to the fact at all).
    When a round's fix lands on a new OBSERVABLE — "it threw", "the text
    survived", "a marker exists" — ask whether the fact is derivable outside the
    component that decides it; if not, the rounds are unbounded.
    (go-to-k/cdkd#2157 / go-to-k/cdkd#2166: "it THREW" and "the text
    SURVIVED" each missed real cases and fired on unreal ones.) Local analogue:
    anything only the Docker daemon or the running `cdkl` process can answer
    ("did the container actually start") — every outside proxy (log line, port
    probe, file appearing) fails both directions.
- **WITHDRAWING the half that cannot be made right is a legitimate outcome, and
  the residual issue must carry the MEASUREMENTS, not just the diagnosis.** Cut
  the code for the wrong half, ship the scoped part, and file the rest carrying
  what the session PAID for: each proxy tried, the input that broke it, the
  number it produced — a diagnosis alone makes the next session re-run every
  probe. go-to-k/cdkd#2166 carries the worked example (a live arm written,
  passed, mutation-probed, reverted — none rebuilt).
- **When two reviewers CONTRADICT each other, settle it in the code YOURSELF
  before forwarding either** — forwarding both hands the implementer a
  contradiction with LESS context than you have, forwarding only the reassuring
  one is how a blocker ships. In cdkd a spec reviewer CLEARED what a security
  reviewer called a blocker on the same lines, and the code's own comment
  settled it. Routine here, since `/review-pr` dispatches 1 or 3 reviewers:
  read the disputed lines, then say who was right and why.
- **Reviewer subagents spawned BY A LANE report to the MAIN session, not to the
  lane that spawned them.** Completion notifications go to the top-level
  session, so a lane that dispatches reviewers and then waits on their reports
  waits for something that cannot arrive, while the parent collects verdicts it
  did not ask for and may not connect to a lane. Measured 2026-09-02
  (go-to-k/cdkd#2417): a lane's two reviewers both delivered upward, the lane
  blocked, and the parent relayed both verdicts by hand. Pick one shape and say
  which in the dispatch: the lane runs its reviewers **synchronously** (holding
  its own turn until they return), or the **parent owns the review dispatch**
  and relays each verdict down — the latter under §9's queued-versus-`Resuming`
  rule, because a lane waiting on a review is stopped at exactly the moment the
  relay is sent.
- **A diff with no `src/**` change** (docs, skills, rules, hooks, CI, config) is
  EXEMPT from the live-test, and from the integ unless it touches
  `tests/integration/**` — `integ-gate` short-circuits on `src/**` OR
  `tests/integration/**`, so a tooling PR that edits a fixture is still
  integ-gated. It is never exempt from `/verify-pr` itself: `verify-pr-gate`
  gates every `gh pr create` / `gh pr merge` on the marker with no diff-shape
  carve-out, and only `/verify-pr` sets it. The exemption drops the LIVE test,
  not the verifying — the easy tier to under-verify ("the gates are green" reads
  as "nothing left to check"). What SATISFIES the step depends on what the
  diff changes; a diff that does both owes BOTH arms.

  **Arm 1 — the diff changes what a command or gate DOES** (hook logic, a
  `vite.config.ts` task, `ci.yml`, a lint / build config). The verification IS
  that command; those runs ARE the live test. Run *the command your own diff
  changes* — `vp run test:hooks` for `.claude/hooks/**`, the changed task for
  `vite.config.ts`, `vp check` for lint / typecheck config. `vp check` is not
  universal: its lint and fmt are scoped to `src/**` and its typecheck project
  is `["src/**/*", "types/**/*"]`, so it reads neither `ci.yml` nor any hook —
  pointed at a hook diff it is a probe that cannot fail. Run it BEFORE and
  AFTER, and drive the FAILURE direction too — a change that swallows an exit
  code looks exactly like one that fixes the gate. Four traps (2026-08-19,
  go-to-k/cdk-local#504, go-to-k/cdk-local#506):
  - **Repeating a CACHED `vp run <task>` re-runs nothing.** `run.cache.tasks` is
    on in `vite.config.ts`, and every task you would repeat to watch — `check`,
    `test`, `lint`, `typecheck`, `format:check`, `verify` (the one §6 sends you
    to) — replays its recorded exit code (printing `cache hit`). To watch an exit
    code, call the underlying command (`vp check` / `vp lint` /
    `vp fmt --check`), never cached. Do not generalize the other way:
    `test:hooks` and `build` set `cache: false` and really re-run — read the
    task's own block.
  - **Inject the failure into `src/**`, never into `tests/**`.**
    `lint.ignorePatterns` / `fmt.ignorePatterns` are source-only
    (`['**/*', '!src', '!src/**']`): a non-`_`-prefixed unused variable in `src`
    fails `vp check` rc=1; the same injection under `tests/unit/**` returns rc=0
    with the linted file count unmoved. A probe in `tests/` — or one a
    `varsIgnorePattern: '^_'` name exempts — proves nothing and reads as "the
    gate is broken".
  - **Run a `$0`-relative harness from beside its subject.** Dumping
    `git show origin/main:<test>` into `/tmp` silently breaks any harness that
    derives its subject from `$(dirname "$0")`: one lane read `pass: 0  fail: 9`
    from `/tmp` where `.claude/hooks/` gave `pass: 9  fail: 0`. Write the old
    copy next to the real one under a temporary name, or the probe measures its
    own path resolution.
  - **Then guard the SHAPE of the fix** — nothing else re-checks a config or
    hook line. For `.claude/hooks/**` the mechanism is a bash smoke test beside
    the hook (`.claude/hooks/pr-review-gate.test.sh`, run by `vp run test:hooks`,
    in CI; added for go-to-k/cdk-local#501 — a heuristic edit has no other
    regression net).

  An exit code lies both ways. **Non-zero that means nothing**: `vp run check`
  exited 134 on a clean tree with 0 errors (a Vite+ stdout `EAGAIN` panic),
  deterministically (go-to-k/cdk-real-drift#1761); the fix's own risk was the reverse — a redirect
  swallowing the exit code turns a RED tree green — so
  go-to-k/cdk-real-drift#1765 shipped a test asserting the `exit 1` survives.
  **Zero that means nothing**: `vp test run` gave rc=0,0,1,0,1 on five identical
  clean runs, every test passing (the go-to-k/cdk-local#402 forks-worker exit,
  killed AFTER assertions pass). One green proves neither broken nor fixed; the
  flap is task-specific, so measure the command you actually changed.

  **Arm 2 — the diff changes PROSE only** (a skill, a rule, a doc — including
  this file). No command to re-run, so the CLAIMS are the artifact: resolve
  every gate, hook, skill, path, task and command the new text names against
  this repo's own files, and RUN each command the text sends the next agent to
  run, confirming the output matches the promise — §10-c's claim-by-claim pass,
  owed even for sibling-repo text. Mirroring go-to-k/cdk-local#511: four
  sibling-named artifacts do not exist here (`.claude/hooks/run-tests.sh`,
  `tests/unit/scripts/`, `matrix-regen-coverage.test.ts`, a
  `dirty-path-restore-gate` hook), so a verbatim copy would send the next agent
  to a harness this repo does not ship. A read-only reviewer resolving each
  named noun against this repo catches these (it also caught two stale claims of
  this section's own).

After a Docker-backed run, sweep for orphans and clean up via `/cleanup` (the
container / network filters and the AWS orphan sweep — run for EVERY fixture via
`tests/integration/_lib/aws-orphan-sweep.sh`, not scoped by a `*-from-cfn-stack`
glob, which missed three resource-owning fixtures — are in `.claude/CLAUDE.md` ->
"After running integration tests"). Leaving orphans is never acceptable.

`/verify-pr` sets the `check` + `docs` + `verify-pr` markers, which clear
`verify-pr-gate` — not `gh pr merge` as a whole. That merge is additionally gated
by `integ-gate` (any `src/**` / `tests/integration/**` touch; only `/run-integ`
sets it), `pr-review-gate` (size / bias tier; only `/review-pr`), and, from a
side worktree, `gh-pr-merge-worktree-gate` (only `/merge-pr`).

**"Only `/review-pr`" is not the whole rule: `/review-pr` is run by the
ORCHESTRATOR, and a LANE must never set `pr-review`.** The marker records who
reviewed what at which sha, so a lane setting it is self-certification — the
"sub-agent self-review is not independent review" failure, arriving through the
marker rather than through the review. Measured 2026-08-29: this repo's own
go-to-k/cdk-local#631 lane set it before any independent review existed, as did
the sibling go-to-k/cdkd#2383 lane, both reading it as part of finishing rather
than as merging. Say the marker out loud in the lane's brief, beside "stop at
merge-ready".

**Do not read the sha binding as a backstop for this.**
`pr-review-gate.sh` compares the recorded `.markgate-pr-review-sha` sentinel
against the PR's current HEAD and refuses on a mismatch — which catches a
marker a later PUSH left behind, not one set by the wrong AGENT. It cannot tell
who set it; the sentinel is per-worktree, and `/merge-pr` merges from inside
the feature worktree, so a lane that sets it after its final push produces a
matching sha and merges unreviewed. go-to-k/cdk-local#631 was 1220 LOC over 13
files — `3-axis` tier — and merged. The rule is the only thing standing there.

**And the orchestrator's own review round is not optional because the lane
already ran one.** A lane's reviewers are its children — same brief, same
framing — so the thing they are least able to doubt is the premise the lane
handed them. Measured on go-to-k/cdkd#2383 (2026-08-29): three rounds of the
lane's own reviewers each found the next spelling of one defect, and it took an
independent orchestrator-level round — round 4, A/B-ing the hand-rolled parser
against the `yaml` library over 15 spellings and then against markgate 0.4.1
itself — to find the YAML merge key, **the spelling the lane's own raw-text
tripwire had been added specifically to backstop and did not fire on**. The
sibling go-to-k/cdk-real-drift#1838 spent its own rounds on the same class.
Take the tier `/review-pr` gives for YOUR pass: a lane's clean round is
evidence about the lane's assumptions, not about the diff.

**A reviewer's scratch COPY of a worktree is not detached from git, so its
`git add -A` writes to the LIVE tree.** A linked worktree's `.git` is a FILE
holding `gitdir: <repo>/.git/worktrees/<name>`, and `cp -R` carries the
pointer: every git command inside the copy reads and WRITES the real worktree's
index and HEAD. Measured 2026-08-29 in the sibling cdkd, where a read-only code
reviewer copied a lane's worktree, ran `git add -A` there, and staged three
tracked DELETIONS in the live tree that the lane's next commit would have
shipped — nothing announced it, because the reviewer believed it was on a copy.
**A PARALLEL round adds a second way to write to that tree, and it is not a
git verb at all: the mutation probe §8-z asks for.** Reviewers dispatched
together share one worktree, so one reviewer editing the subject under test
corrupts every other reviewer's run — measured on go-to-k/cdk-local#675
(2026-09-03), where a code reviewer's first two probes were invalidated by a
peer live-mutating the hook they were both reading. The brief must therefore say
to probe on a copy OUTSIDE the repository and restore from that copy, and the
`git status --porcelain` pair below does NOT catch this: a probe that mutates
and restores inside the window reports clean at both ends. Two lines therefore
belong in every read-only reviewer's brief: **run no WRITING git verb** (`add` / `commit` / `restore` / `checkout` / `stash` /
`clean`) anywhere, copy included — and if you must copy, copy OUTSIDE every
repository, since deleting the `.git` file does not detach the copy, it only
makes discovery walk UPWARD into whatever encloses it; and **report the TARGET
worktree's `git status --porcelain` before AND after the round.** The pair is
what makes damage attributable rather than a mystery a later agent finds: that
incident surfaced only because the NEXT reviewer volunteered "the tree went
dirty mid-review, not mine", after which the responsible one repaired the index
with `git restore --staged` (index only, never the working tree). This repo
runs its lanes in `.claude/worktrees/`, so the hazard is identical — and both
lines now live in `.claude/agents/pr-*-reviewer.md`, so a dispatch cannot omit
them.

### 8-z. When a mutation probe reports NO discrimination

**First, a rule that applies BEFORE any probe runs: COMMIT the round's real
fixes, then probe.** A probe deliberately breaks the tree, so an interruption
mid-probe (a session limit, a crash) leaves deliberate breakage and unfinished
fixes in ONE undifferentiated dirty tree. Measured 2026-09-02 on the
go-to-k/cdk-real-drift#1841 lane: the lane subagent died at the 5-hour session
limit mid-probe with 9 dirty files, and the resuming session had to read the
full diff to establish that none of it was probe wreckage before it could
commit. With a pre-probe commit the separator is just `git diff` — anything
unstaged after a probe is the probe's (mirrored from
go-to-k/cdk-real-drift#1853; go-to-k/cdk-local#649 is this repo's filing).

**And telling wreckage apart is the CHEAP half of the reason. The expensive
half is that a RESTORE REVERTS ANYTHING COMMITTED NOWHERE.** A probe ends by
putting the tree back, and a harness that does so from a SNAPSHOT puts back the
snapshot's whole state: work written after the snapshot and committed nowhere is
not "hard to attribute", it is gone, and `git status` reads clean afterwards
because that is exactly what the wrong restore produces (the appendix states the
same property for `git checkout -- <file>`). Measured 2026-09-02 in this run: a
lane's harness restored a snapshot taken before the round's new tests existed
and took 133 lines of them with it. Surviving the restore is what the pre-probe
commit actually buys.

**A probe that reports NO discrimination is a claim about the FENCE, and four
other things produce the identical output** — three about the PROBE, then one
each about the fixture's premise and the harness's reading. Ask the three in
order before touching the fence; each was hit in one session (2026-08-25) and
each nearly cost a working assertion:

1. **Did the edit land?** `sed`/`perl` one-liners fail silently in ways that
   read as "no match": a `perl -0pi -e "s|^\|...|...|m"` whose pattern is
   delimited by the same `|` it escapes matches nothing; a `sed -E`-only
   alternation (`\|`) is a GNU extension inert on macOS; `sed: bad flag` prints
   ABOVE the suite output and scrolls past. Prove it with
   `grep -c '<the mutated text>'` before reading the result, and prefer
   `python3` with `assert anchor in s` — a thrown assertion is louder than a
   quoting slip that quietly matches zero.
2. **Does the case's execution path REACH the edited line?** Breaking a hook's
   branch-lookup call left its suite fully green: every case carried an explicit
   PR number, so the lookup never ran. The fence was fine; the probe was aimed
   outside the cases' path. The fix is a case that HAS to take that path, not a
   change to the fence.
3. **Did the command run where you think it did?** A relative-path edit under a
   silently reset cwd lands in another worktree, and the `git status` confirming
   it runs in that same wrong tree — "clean" and "clean somewhere else" print
   identically. Use ABSOLUTE paths and confirm by a property the wrong tree
   cannot fake (`ls -la` mtime).

And one shape inside the fixture itself: **a probe passes VACUOUSLY when its
own PREMISE has evaporated, so make the premise ASSERTABLE rather than assumed.**
The first form of it: an expected value must be an INDEPENDENT variable from the
one under test -- a stub keyed its content on a sha whose default was the same
literal on the producing and consuming sides, so breaking the producing call
still served the content and the case could not fail. Four more of the same
shape in one run (2026-09-02, the go-to-k/cdk-local#667 lane): an `undefined` env
assignment that arrived as the STRING `"undefined"`, so the unset-variable branch
never ran; a docker stub exiting 0 unconditionally, making the filter-failure
branch unreachable; an after-set that was always a SUPERSET of the before-set, so
`comm -13` and `comm -3` could not disagree; and already-sorted stub data, which
hides a dropped `sort`. Note none of these is question 2 -- the edited line IS
reached, and it is the assertion's INPUT that is degenerate. The fix is never a
stronger assertion: GUARD the precondition (assert it holds before asserting the
conclusion) or feed data that can only pass one way.

And one shape in the HARNESS rather than in the fixture: **"the suite went RED"
and "the suite did not RUN" are different facts, and the summary line does not
separate them by itself.** A mutation that breaks PARSING rather than behaviour
collects nothing. Measured 2026-09-03 here, one unbalanced brace in one test
file: rc=1, `Test Files  1 failed (1)`, and `Tests  no tests` — a `Tests` line
that EXISTS and carries no digits. A harness counting case failures reads zero
and concludes the fence is DEAD, which is this section's own hazard arriving
from the harness rather than from the fixture; one keyed on rc alone reads red
and concludes it is ALIVE. Both are false — nothing ran. Believe either verdict
only when three things hold: the `Tests` line carries DIGITS, its total matches
a known BASELINE, and no `Test Files … failed` sits beside zero case failures.
The BASELINE is the one that catches a whole file silently not collecting. A
regex requiring `(\d+) passed` does catch this particular spelling, by matching
nothing — but only where the harness treats no-match as an ERROR rather than
as zero.

Only after all five does "the fence is weak" remain. Deleting an assertion on
the strength of an unexamined green is how a working guard gets removed. The
first four came from cdkd, all measured in one session there
(go-to-k/cdkd#2197 / go-to-k/cdkd#2200 / go-to-k/cdkd#2198); the fifth was
measured here (2026-09-03). The mechanism is the shell and the tooling in every
case, not anything repo-specific.
