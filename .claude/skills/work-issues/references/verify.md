<!-- Part of the /work-issues skill (§8). A bare §N points into the stage file holding that section; the map is SKILL.md's "Stages" table. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge

Run `/verify-pr`. It walks the full checklist (typecheck / lint / build / unit
tests / `vp run test:hooks`, CI status, docs consistency, Docker + the `integ`
marker, code review, PR title/body freshness) and — critically — **live-tests
the changed behavior**. It is recommended, not enforced: the mechanical merge
conditions are CI green (`ci-ok`) and a fresh `integ` marker.

### 8-a. Integ ordering and review rounds

- **Run the integ LAST.** The `integ` gate is `hash: diff` against
  `merge-base(origin/main, HEAD)` over `src/**` plus `tests/integration/**`, so
  any later edit to an in-scope file — comment-only included — stales it and
  costs a Docker fixture run. The COMPLEMENT is free: a
  `tests/unit/**` follow-up after a green integ costs NOTHING.
- **"Last" does not hold still across review rounds — DECLARE the tree final,
  in words.** Tell the implementing agent to batch every remaining finding into
  ONE commit and report FINAL.

### 8-b. Live-testing a `src/**` runtime change

- **Drive the affected flow end-to-end against Docker / a fixture** (invoke the
  Lambda, hit the route), reproducing the CONSEQUENCE you wrote down and not
  just the code path, with the FIXED binary — build first, the CLI runs from
  `dist/`. `/run-integ <local-*>` drives the real
  Docker path; keep or extend the covering fixture in the SAME PR. **A lane
  that may not RUN the fixture yet still WRITES the arm** — §9 makes the Docker
  turn the parent's to grant, so filing the arm instead is the deferral "never
  defer the integ" forbids.
- **Granting the integ turn is not the end of the parent's job: POLL, and the
  poll must measure the RUNNING THING** (`/run-integ` step 5 has the recipe):
  a probe that cannot move, like `stat -f %z` on a SYMLINK, fails reassuringly.
- **A fixture that establishes the fix's PRECONDITION on the happy path cannot
  test the arm where the FAILING path creates it.** That state is what an
  earlier `local-*` phase leaves behind — a started `cdkl` process, a `cdkl-*`
  container or network, a `.scenario.yaml`. If the fixture's writer
  phase differs from the reachable case's, add the arm where ONE operation both
  creates and handles it, and prove it DISCRIMINATES (mutate the fix: original
  arm passes, new arm fails).

### 8-c. Fix cascades (a round's fix produces the next round's blocker, twice)

Stop reviewing the patch and question its SHAPE; the blockers are found by
executing a probe, never by re-reading the diff. After round two, name what the
rounds have in COMMON — usually one structural absence — then take the NARROW
fix and FILE the structural one (new entrypoint code at round five is how
round six happens). What ends a cascade is making the artifact CLAIM LESS; the tell
is that each fix is more SOPHISTICATED than the last while plain rc-only sweeps
beside them stay correct. Two shapes recur: TWO SPELLINGS of one question,
cured by making both sites use ONE predicate verbatim; and a PROXY for a
question only another component can answer — wrong in BOTH directions at once —
cured by making that component REPORT. WITHDRAWING the half that cannot be
made right is legitimate; the residual issue carries the MEASUREMENTS.

### 8-d. Reviewers

**One `pr-code-reviewer` by default.** Add the spec and test reviewers when the
`src/**` diff exceeds 400 lines or 8 files; add a security-lens review on
secret / credential / process-launch / Docker-exec surfaces. Reviewers run
ONCE, on the final sha; a fix round is re-checked by MESSAGING the same
reviewer, scoped to the delta, with the delta's COMMIT MESSAGE in the brief
(the agents read `gh pr diff` / `gh pr view --json files`, never `git log`).
`/check-docs` runs once per PR, at that same sha.

- **Reviewer subagents spawned BY A LANE report to the MAIN session**, so a
  lane that dispatches reviewers and waits blocks forever while the parent
  collects verdicts it did not ask for. Say which shape the dispatch uses: the
  lane runs its reviewers **synchronously**, or the **parent owns the
  dispatch** and relays down. A lane's round does not replace the parent's —
  its reviewers cannot doubt the premise it handed them.
- **Reviewers dispatched in PARALLEL share one worktree** — one mutating the
  subject corrupts its peers' runs, and a scratch COPY is not detached from git
  (deleting `.git` only makes discovery walk upward). When two reviewers CONTRADICT, settle it
  in the code YOURSELF.

### 8-e. A diff with no `src/**` change

EXEMPT from the live-test, and from the integ unless it touches
`tests/integration/**` (`integ-gate` short-circuits on either, so a tooling PR
editing a fixture is still integ-gated). The exemption drops the LIVE test, not
the verifying — the easy tier to under-verify. A diff doing both owes both:

- **Arm 1 — the diff changes what a command or hook DOES** (hook logic, a
  `vite.config.ts` task, `ci.yml`, lint / build config) → the verification IS
  that command: `vp run test:hooks` for `.claude/hooks/**`, the changed task
  for `vite.config.ts`, `vp check` for lint / typecheck config. `vp check` is
  not universal — its lint and fmt are scoped to `src/**` and its typecheck
  project to `["src/**/*", "types/**/*"]`, so it reads neither `ci.yml` nor any
  hook. Run it BEFORE and AFTER, and drive the FAILURE direction.
  - **Repeating a CACHED `vp run <task>` re-runs nothing** — `run.cache.tasks`
    is on, so `check` / `test` / `lint` / `typecheck` / `format:check` /
    `verify` replay their recorded exit code. Call the underlying command
    (`vp check` / `vp lint` / `vp fmt --check`); `test:hooks` and `build` set
    `cache: false`.
  - **Inject the failure into `src/**`, never `tests/**`** —
    `lint.ignorePatterns` / `fmt.ignorePatterns` are source-only, so a probe
    under `tests/unit/**` returns rc=0, reading as a broken check.
  - **An exit code lies both ways**: `vp run check` has exited 134 on a clean
    tree deterministically, and `vp test run` has given rc=0,0,1,0,1 over five
    identical clean runs with every test passing. Measure the command you
    changed.
- **Arm 2 — the diff changes PROSE only** (a skill, a rule, a doc — including
  this file) → the CLAIMS are the artifact. Resolve every hook, skill, path,
  task and command the new text names against this repo's files, and RUN each
  command it sends the next agent to run, confirming the output matches what
  the text promises.

### 8-f. Orphans and the merge conditions

After a Docker-backed run, sweep for orphans and clean up via `/cleanup` —
`.claude/AGENTS.md` → "After running integration tests" holds the container /
network filters and the EVERY-fixture `aws-orphan-sweep.sh` rule. Leaving orphans is never acceptable.

`gh pr merge` / `git merge` is blocked by `integ-gate` on any `src/**` /
`tests/integration/**` touch until the `integ` marker is fresh, and only
`/run-integ` sets it. **A LANE must never set that marker for the
orchestrator** — one that did not run the fixture has nothing to record.

### 8-z. When a mutation probe reports NO discrimination

**Before any probe runs: COMMIT the round's real fixes.** A probe deliberately
breaks the tree, so an interruption mid-probe leaves breakage and unfinished
fixes in ONE dirty tree; after a pre-probe commit the separator is `git diff`,
and the work survives a RESTORE — which reverts anything committed NOWHERE,
`git status` reading clean afterwards.

**ONE mutation per probe, and restore the tree byte-exact between them.** A
probe that changed two things attests to NEITHER — and unlike a suspicious
green, its RED reads as evidence and gets filed as one.

**A probe reporting NO discrimination is a claim about the FENCE, and four
other things produce the identical output.** Ask in order before touching it:

1. **Did the edit land, in the tree you meant?** `sed` / `perl` one-liners fail
   silently in ways that read as "no match", and a relative path under a reset
   cwd edits another worktree. Use ABSOLUTE paths and prove the edit with
   `grep -c '<the mutated text>'`, or `python3` with `assert anchor in s`.
2. **Does the case's execution path REACH the edited line?** Breaking a lookup
   leaves a suite green when every case carries a value that skips it. The fix
   is a case that HAS to take that path.
3. **The probe passes VACUOUSLY when its own PREMISE has evaporated — make the
   premise ASSERTABLE** (the independence rule is in `references/implement.md`
   §5-e). Shapes seen: a docker stub exiting 0 unconditionally; an `undefined`
   env assignment arriving as the STRING `"undefined"`; an after-set always a
   SUPERSET of the before. The edited line IS reached, the assertion's
   INPUT is degenerate — GUARD the precondition or feed data that can only pass
   one way, never write a stronger assertion.
4. **"The suite went RED" and "the suite did not RUN" are different facts, and
   the summary line does not separate them.** One unbalanced brace gives rc=1,
   `Test Files  1 failed (1)` and `Tests  no tests` — no digits on the `Tests`
   line, which reads as a DEAD fence to a harness counting cases and a live one
   to one keyed on rc, while nothing ran. Believe a verdict only when
   `Tests` carries DIGITS matching a known BASELINE and no
   `Test Files … failed` sits beside zero case failures. And read the RIGHT
   line: `typecheck` is on, so a clean run prints `Type Errors  no errors`, not
   the `Errors  N errors` line a dying worker puts above it.

Only after all four does "the fence is weak" remain. Deleting an assertion on
an unexamined green removes a working guard.
