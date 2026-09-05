<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge (`/verify-pr`)

Run `/verify-pr`. It walks the full checklist (typecheck / lint / build / unit
tests / `vp run test:hooks`, CI status, docs consistency, Docker + integ marker,
code review, PR title/body freshness) and — critically — **live-tests the
changed behavior**.

### 8-a. Integ ordering vs markers and review rounds

- **Run the integ LAST — and set the `check` / `docs` markers AFTER it, not
  before.** A fixture run writes `cdk.out/`, `node_modules/` and
  `pnpm-lock.yaml` under `tests/integration/<fixture>/`; the `check` gate
  covers `tests/**` (plus `src/**`, the files that decide what green means —
  `vite.config.ts` / `.mise.toml` / `.node-version` / `.markgate.yml` —
  `.claude/hooks/**` and the checker-input agent-instruction files and
  workflows; `.claude/rules/hooks.md` has the authoritative list) and markgate
  digests those artifacts even though git ignores them
  (go-to-k/cdk-local#620) — a green integ stales a marker set minutes earlier
  with `git status` clean. Order: edit → integ → `/check` → `markgate set` →
  commit.
- **"Last" does not hold still across review rounds — DECLARE the tree final,
  in words, to whoever is still editing it.** The `integ` gate is `hash: diff`
  vs `merge-base(origin/main, HEAD)`, so even a comment-only change to an
  in-scope file stales the marker and costs a Docker fixture run (cdkd,
  2026-08-26: three real-AWS runs of one fixture, one for a zero-non-comment
  round). Know the COMPLEMENT too — the include is `src/**` plus
  `tests/integration/**` and nothing else, so a `tests/unit/**` follow-up
  after a green integ costs NOTHING (two findings this run was about to defer
  for "another Docker run" were free). Tell the implementing agent to batch
  every remaining finding into ONE commit and report FINAL, no second pass.
- **Reviewer-side: dispatch a round SCOPED to the delta, all findings at once
  — and paste the delta's COMMIT MESSAGE into the brief.** All three reviewer
  agents read `gh pr diff` / `gh pr view --json files`
  (`.claude/agents/pr-{code,spec,test}-reviewer.md`) and none reads `git log`,
  so a false claim in a commit message is invisible to the whole tier (cdkd,
  2026-08-29: a delta round's blocker cited a function that never existed,
  caught only because the orchestrator re-read the message). The delta is
  where fix-introduced blockers live (go-to-k/cdk-local#672's fifth round
  read only the delta and returned FIVE findings, three of them defects in
  fences EARLIER rounds had added).

### 8-b. Live-testing a `src/**` runtime change

- **Drive the affected flow end-to-end against Docker / a fixture** (invoke
  the Lambda, hit the served route, run the task), not just the unit suite.
  Reproduce with the FIXED binary — `vp run build` first; the CLI runs from
  `dist/`. `/run-integ <local-*>` exercises the real Docker path; keep or
  extend the covering fixture in the SAME PR.
- **Granting the integ turn is not the end of the parent's job: POLL, and the
  poll must measure the RUNNING THING** (`/run-integ` step 5 holds the
  recipe). A watcher polled `stat -f %z` on an agent's `.output` path — a
  SYMLINK — read the constant 153-byte link length, and reported three still-
  growing transcripts "size-stable" until `stat -Lf` showed otherwise. A probe
  that cannot move fails in the reassuring direction.
- **Live-test the CONSEQUENCE you WROTE DOWN, not only the code path.** A
  consequence derived by READING lands in a code comment, `.claude/CLAUDE.md`,
  a commit message and an issue comment before anything tests it — the same
  decay implement.md names for narrow querying, reached by narrow reading. An
  A/B of the two configurations is usually one command
  (go-to-k/cdk-local#608: "those warns vanish from the log binding" was
  written into all four artifacts, then REFUTED by one live run — the real
  defect was different and worse, the `agentcore` branch folding warns INTO
  the response). The run corrects the diagnosis, not merely confirms it.
- **A fixture that establishes the fix's PRECONDITION on the happy path
  cannot test the arm where the FAILING path creates it** (go-to-k/cdkd#2125:
  such a fix cleared unit tests, a fixture and four reviewers; the fifth
  traced the evidence). Here the state is what an earlier `local-*` phase
  leaves behind — a started `cdkl` process (`CDKL_PID`), a `cdkl-*` container
  or network, a written `.scenario.yaml`. Ask which phase writes the state in
  the fixture and which writes it in the reachable case; if they differ, add
  the arm where ONE operation both creates and handles it, and prove it
  DISCRIMINATES (mutate the fix: original arm passes, new arm fails).
- **A `cleanup` that ALSO runs before the run must not destroy anything the
  run then needs** (a load-time `WORKDIR="$(mktemp -d …)"` + `rm -rf` in
  `cleanup` + a pre-run `cleanup` call deletes the workdir before its first
  write; cost a real cycle in cdkd). This repo is exposed: `local-*` fixtures
  DO call `cleanup` pre-run (`local-start-alb-redirect` and peers), surviving
  only because their `cleanup` sweeps processes and containers, which phases
  re-create — the first fixture that computes a scratch dir at
  variable-definition time arms it. The remedy: anything `cleanup` removes
  must be re-created by a phase, or created AFTER the pre-run call. A stubbed
  dry run (pre-run cleanup, then the full run) catches it in seconds.

### 8-c. Fix cascades — when a round's fix produces the next round's blocker twice

Stop reviewing the patch and question its SHAPE. The blockers are found by
executing a probe, never by re-reading the diff:

- **After round two, name what the rounds have in COMMON** — usually one
  structural absence. Do NOT take the structural fix late in the cascade (new
  entrypoint code at round five is how round six happens): take the narrow
  fix, file the structural one, and reference it from the narrow fix.
- **Filing the structural fix does not STOP a cascade — making the artifact
  CLAIM LESS does** (go-to-k/cdk-local#596: filed at round five, the rounds
  ran to TWELVE, five instances introduced by fixes; it ended when the sweep
  printed raw output and named both outcomes instead of emitting a verdict —
  `grep -q 'does not exist'` also matches botocore's
  `The source_profile ... does not exist`, so a broken profile reported CLEAN
  having queried nothing). The tell: each fix is more SOPHISTICATED than the
  last while plain rc-only sweeps beside them stayed correct. Expect the fix
  to feel like a retreat; it converges. Two riders, both paid for in that PR:
  **fence the REMEDIATION, not just the detection** (`cdk destroy` on
  suffix-less names exits 0 SILENTLY, and every fence pinned the scan), and
  **do not pre-commit to a remedy for a finding you have not seen** — say
  what the next finding would have to SHOW, not what you will do about it.
- **TWO SPELLINGS of one question → make both sites use ONE predicate
  verbatim** — a better second spelling looks like a fix and passes its own
  test (go-to-k/cdkd#2134: ended only when the authority's test was copied
  character for character; the round before, the spellings still disagreed on
  the empty string, fail-OPEN). Name the site that OWNS the question; every
  other site calls or copies it exactly.
- **A PROXY for a question only another component can answer → make that
  component REPORT.** The tell: each proxy is wrong in BOTH directions at
  once (go-to-k/cdkd#2157 / go-to-k/cdkd#2166: "it threw" and "the text
  survived" each missed real cases and fired on unreal ones). When a round's
  fix lands on a new OBSERVABLE rather than a new spelling, ask whether the
  fact is derivable outside the component that decides it; if not, the rounds
  are unbounded. Local analogue:
  anything only the Docker daemon or the running `cdkl` process can answer
  ("did the container actually start") — every outside proxy (log line, port
  probe, file appearing) fails both directions.
- **WITHDRAWING the half that cannot be made right is a legitimate outcome,
  and the residual issue must carry the MEASUREMENTS, not just the
  diagnosis** — each proxy tried, the input that broke it, the number it
  produced; a diagnosis alone makes the next session re-run every probe
  (go-to-k/cdkd#2166 carries the worked example).

### 8-d. Reviewer findings and review shapes

- **When two reviewers CONTRADICT each other, settle it in the code YOURSELF
  before forwarding either** — forwarding both hands the implementer a
  contradiction with LESS context than you have; forwarding only the
  reassuring one is how a blocker ships (in cdkd a spec reviewer CLEARED what
  a security reviewer called a blocker, and the code's own comment settled
  it). Routine here, since `/review-pr` dispatches 1 or 3 reviewers.
- **Reviewer subagents spawned BY A LANE report to the MAIN session, not to the
  lane that spawned them.** Completion notifications go to the top-level
  session, so a lane that dispatches reviewers and waits blocks forever while
  the parent collects verdicts it did not ask for (go-to-k/cdkd#2417,
  2026-09-02: a lane's two reviewers both delivered upward; the parent
  relayed by hand). Pick one shape and say which in the dispatch: the lane
  runs its reviewers **synchronously**, or the **parent owns the review
  dispatch** and relays verdicts down — the latter under §9's
  queued-versus-`Resuming` rule.

### 8-e. A diff with no `src/**` change

EXEMPT from the live-test, and from the integ unless it touches
`tests/integration/**` (`integ-gate` short-circuits on `src/**` OR
`tests/integration/**`, so a tooling PR that edits a fixture is still
integ-gated). NEVER exempt from `/verify-pr` itself: `verify-pr-gate` gates
every `gh pr create` / `gh pr merge` on the marker with no diff-shape
carve-out. The exemption drops the LIVE test, not the verifying — the easy
tier to under-verify. A diff that does both owes BOTH arms:

- **Arm 1 — the diff changes what a command or gate DOES** (hook logic, a
  `vite.config.ts` task, `ci.yml`, lint / build config) → the verification IS
  that command. Run *the command your own diff changes* — `vp run test:hooks`
  for `.claude/hooks/**`, the changed task for `vite.config.ts`, `vp check`
  for lint / typecheck config — noting `vp check` is not universal: its lint
  and fmt are scoped to `src/**` and its typecheck project is
  `["src/**/*", "types/**/*"]`, so it reads neither `ci.yml` nor any hook.
  Run it BEFORE and AFTER, and drive the FAILURE direction too — a change
  that swallows an exit code looks exactly like one that fixes the gate.
  Four traps (go-to-k/cdk-local#504 / go-to-k/cdk-local#506):
  - **Repeating a CACHED `vp run <task>` re-runs nothing** — `run.cache.tasks`
    is on, so `check` / `test` / `lint` / `typecheck` / `format:check` /
    `verify` replay their recorded exit code (printing `cache hit`). To watch
    an exit code, call the underlying command (`vp check` / `vp lint` /
    `vp fmt --check`). Do not generalize the other way: `test:hooks` and
    `build` set `cache: false` and really re-run — read the task's own block.
  - **Inject the failure into `src/**`, never into `tests/**`** —
    `lint.ignorePatterns` / `fmt.ignorePatterns` are source-only, so a probe
    under `tests/unit/**` (or one a `varsIgnorePattern: '^_'` name exempts)
    returns rc=0 and reads as "the gate is broken".
  - **Run a `$0`-relative harness from beside its subject** — a
    `git show origin/main:<test>` copy dumped into `/tmp` measures its own
    path resolution (one lane read `pass: 0 fail: 9` from `/tmp` where
    `.claude/hooks/` gave `pass: 9 fail: 0`). Write the old copy next to the
    real one under a temporary name.
  - **Then guard the SHAPE of the fix** — nothing else re-checks a config or
    hook line. For `.claude/hooks/**` the mechanism is a bash smoke test
    beside the hook (`.claude/hooks/pr-review-gate.test.sh`, run by
    `vp run test:hooks`, in CI; added for go-to-k/cdk-local#501).

  **An exit code lies both ways.** Non-zero that means nothing: `vp run check`
  exited 134 on a clean tree, deterministically (a Vite+ stdout `EAGAIN`
  panic, go-to-k/cdk-real-drift#1761; the fix's own risk was the reverse — a
  redirect swallowing the exit code — so go-to-k/cdk-real-drift#1765 shipped
  a test asserting the `exit 1` survives). Zero that means nothing:
  `vp test run` gave rc=0,0,1,0,1 on five identical clean runs, every test
  passing (the go-to-k/cdk-local#402 forks-worker exit). One green proves
  neither broken nor fixed; the flap is task-specific, so measure the command
  you actually changed.
- **Arm 2 — the diff changes PROSE only** (a skill, a rule, a doc — including
  this file) → the CLAIMS are the artifact. Resolve every gate, hook, skill,
  path, task and command the new text names against this repo's own files,
  and RUN each command the text sends the next agent to run, confirming its
  output matches what the text promises — §10-c's
  claim-by-claim pass, owed even for sibling-repo text
  (go-to-k/cdk-local#511: four sibling-named artifacts do not exist here —
  `.claude/hooks/run-tests.sh`, `tests/unit/scripts/`,
  `matrix-regen-coverage.test.ts`, a `dirty-path-restore-gate` hook — so a
  verbatim copy would send the next agent to a harness this repo does not
  ship).

### 8-f. Orphans and markers

After a Docker-backed run, sweep for orphans and clean up via `/cleanup` (the
container / network filters and the AWS orphan sweep — run for EVERY fixture
via `tests/integration/_lib/aws-orphan-sweep.sh`, not scoped by a
`*-from-cfn-stack` glob, which missed three resource-owning fixtures — are in
`.claude/CLAUDE.md` → "After running integration tests"). Leaving orphans is
never acceptable.

`/verify-pr` sets the `check` + `docs` + `verify-pr` markers, which clear
`verify-pr-gate` — not `gh pr merge` as a whole. That merge is additionally
gated by `integ-gate` (any `src/**` / `tests/integration/**` touch; only
`/run-integ` sets it), `pr-review-gate` (size / bias tier; only `/review-pr`),
and, from a side worktree, `gh-pr-merge-worktree-gate` (only `/merge-pr`).

- **"Only `/review-pr`" is not the whole rule: `/review-pr` is run by the
  ORCHESTRATOR, and a LANE must never set `pr-review`.** A lane setting it is
  self-certification — the "sub-agent self-review is not independent review"
  failure arriving through the marker (2026-08-29: this repo's own
  go-to-k/cdk-local#631 lane set it before any independent review existed, as
  did the sibling go-to-k/cdkd#2383 lane). Say the marker out loud in the
  lane's brief, beside "stop at merge-ready".
- **Do not read the sha binding as a backstop for this.** `pr-review-gate.sh`
  compares the `.markgate-pr-review-sha` sentinel against the PR's HEAD —
  which catches a marker a later PUSH left behind, not one set by the wrong
  AGENT. The sentinel is per-worktree and `/merge-pr` merges from inside the
  feature worktree, so a lane that sets it after its final push produces a
  matching sha and merges unreviewed (go-to-k/cdk-local#631 was 1220 LOC over
  13 files — `3-axis` tier — and merged). The rule is the only thing standing
  there.
- **And the orchestrator's own review round is not optional because the lane
  already ran one.** A lane's reviewers are its children — same brief, same
  framing — so what they cannot doubt is the premise the lane handed them
  (go-to-k/cdkd#2383: three rounds of lane reviewers each found the next
  spelling of one defect; the independent orchestrator round found the YAML
  merge key the lane's own tripwire had been added to backstop and did not
  fire on; go-to-k/cdk-real-drift#1838 spent its own rounds on the same
  class). Take the tier `/review-pr` gives for YOUR pass: a lane's clean
  round is evidence about the lane's assumptions, not about the diff.
- **A reviewer's scratch COPY of a worktree is not detached from git.** A
  linked worktree's `.git` is a FILE holding
  `gitdir: <repo>/.git/worktrees/<name>`, and `cp -R` carries the pointer —
  a read-only reviewer's `git add -A` inside its copy staged three tracked
  DELETIONS in the LIVE tree (cdkd, 2026-08-29). **A PARALLEL round adds a
  second way to write to that tree: the mutation probe §8-z asks for** —
  reviewers dispatched together share one worktree, so one reviewer
  live-mutating the subject corrupts every peer's run
  (go-to-k/cdk-local#675: a code reviewer's first two probes were invalidated
  by a peer mutating the hook they were both reading). Two lines belong in
  every read-only reviewer's brief (both live in
  `.claude/agents/pr-*-reviewer.md`, so a dispatch cannot omit them): **run
  no WRITING git verb** (`add` / `commit` / `restore` / `checkout` / `stash`
  / `clean`) anywhere, copy included — probe on a copy OUTSIDE every
  repository (deleting the `.git` file does not detach a copy, it only makes
  discovery walk upward) — and **report the TARGET worktree's
  `git status --porcelain` before AND after the round** (the pair makes
  damage attributable; the porcelain pair does NOT catch a probe that mutates
  and restores inside the window, which is why the copy rule exists). If
  damage happens anyway, the repair is `git restore --staged` (the INDEX
  only, never the working tree).

### 8-z. When a mutation probe reports NO discrimination

**First, a rule that applies BEFORE any probe runs: COMMIT the round's real
fixes, then probe.** A probe deliberately breaks the tree, so an interruption
mid-probe leaves deliberate breakage and unfinished fixes in ONE
undifferentiated dirty tree (go-to-k/cdk-real-drift#1841: the lane died at the
session limit mid-probe with 9 dirty files; mirrored from
go-to-k/cdk-real-drift#1853, go-to-k/cdk-local#649 is this repo's filing).
With a pre-probe commit the separator is just `git diff`. **And the expensive
half: a RESTORE REVERTS ANYTHING COMMITTED NOWHERE** — a harness restoring
from a SNAPSHOT puts back the snapshot's whole state, and `git status` reads
clean afterwards (measured 2026-09-02: a lane's harness restored a snapshot
taken before the round's new tests existed and took 133 lines of them with
it). Surviving the restore is what the pre-probe commit actually buys.

**ONE mutation per probe, and restore the tree byte-exact between them.** A
probe that changed two things at once attests to NEITHER — and unlike a
suspicious green, its RED reads as evidence and is filed as one. Measured in
the sibling go-to-k/cdkd#2612: a comment claimed reordering either consumer
"reds four cases", but that probe had also edited the rendered line's TEXT, so
the reds belonged to the text edit. Re-measured one mutation at a time, each
alone was green and the two TOGETHER reddened one case — the mechanisms are
mutually redundant, the opposite of what the comment recorded.

**A probe that reports NO discrimination is a claim about the FENCE, and four
other things produce the identical output.** Ask in order before touching the
fence (each hit in one cdkd session, go-to-k/cdkd#2197 / go-to-k/cdkd#2200 /
go-to-k/cdkd#2198; the fifth measured here 2026-09-03):

1. **Did the edit land?** `sed` / `perl` one-liners fail silently in ways
   that read as "no match" (a `perl -0pi` pattern delimited by the same `|`
   it escapes; a `sed -E`-only alternation inert on macOS; `sed: bad flag`
   scrolling past above the suite output). Prove it with
   `grep -c '<the mutated text>'` before reading the result; prefer `python3`
   with `assert anchor in s`.
2. **Does the case's execution path REACH the edited line?** Breaking a
   hook's branch-lookup call left its suite fully green — every case carried
   an explicit PR number, so the lookup never ran. The fix is a case that HAS
   to take that path, not a change to the fence.
3. **Did the command run where you think it did?** A relative-path edit under
   a silently reset cwd lands in another worktree — "clean" and "clean
   somewhere else" print identically. Use ABSOLUTE paths and confirm by a
   property the wrong tree cannot fake (`ls -la` mtime).
4. **The probe passes VACUOUSLY when its own PREMISE has evaporated — make
   the premise ASSERTABLE.** An expected value must be an INDEPENDENT
   variable from the one under test (a stub keyed content on a sha whose
   default was the same literal on both sides, so breaking the producing call
   still served it). Four more of the shape in one run (the
   go-to-k/cdk-local#667 lane): an `undefined` env assignment arriving as the
   STRING `"undefined"`; a docker stub exiting 0 unconditionally; an
   after-set always a SUPERSET of the before-set, so `comm` could not
   disagree; already-sorted stub data hiding a dropped `sort`. None is
   question 2 — the edited line IS reached; the assertion's INPUT is
   degenerate. The fix is never a stronger assertion: GUARD the precondition
   or feed data that can only pass one way.
5. **"The suite went RED" and "the suite did not RUN" are different facts,
   and the summary line does not separate them.** One unbalanced brace in one
   test file gave rc=1, `Test Files  1 failed (1)`, and `Tests  no tests` — a
   `Tests` line with no digits; a harness counting case failures reads zero
   and concludes the fence is DEAD, one keyed on rc alone concludes it is
   ALIVE, and both are false — nothing ran. Believe a verdict only when the
   `Tests` line carries DIGITS, its total matches a known BASELINE, and no
   `Test Files … failed` sits beside zero case failures. And read the RIGHT
   line: `vite.config.ts` enables `typecheck`, so a clean run prints
   `Type Errors  no errors` — which is not the separate `Errors  N errors`
   line a dying worker or a load failure puts above it. §8-e's "an exit code
   lies both ways" is the other half: neither summary line is the verdict.

Only after all five does "the fence is weak" remain. Deleting an assertion on
the strength of an unexamined green is how a working guard gets removed.
