<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge (`/verify-pr`)

Run `/verify-pr`. It walks the full checklist (typecheck / lint / build / tests, CI
status, docs consistency, Docker + integ marker, code review, PR title/body
freshness) and — critically — **live-tests the changed behavior**:

**Run the integ LAST — and set the `check` / `docs` markers AFTER it, not before.**
A fixture run writes `cdk.out/`, `node_modules/` and a `pnpm-lock.yaml` inside
`tests/integration/<fixture>/`, and the `check` gate's include set is
`src/**` + `tests/**` + the configs. markgate's `files` digest covers those
artifacts even though git ignores them, so a green integ run STALES a `check`
marker set minutes earlier — with the tracked tree completely unchanged and
`git status` clean. The symptom is a `git commit` refused for "digest differs"
that no source edit explains, and re-running `/check` before the integ cannot
fix it. The working order is: edit -> integ -> `/check` -> `markgate set` ->
commit. Measured here on 2026-08-27 across all three lanes of one run; the
first occurrence cost a re-diagnosis plus a full re-run of the unit suite.

**Then run the integ LAST in the other sense too: "last" does not hold still
across review rounds — so DECLARE the tree final, in words, to whoever is still
editing it.**
The `integ` gate is `hash: diff` against `merge-base(origin/main, HEAD)`, so it
digests this branch's DELTA over the include set rather than the working tree's
behaviour. That has a consequence worth stating outright: a round of review
fixes whose change to an in-scope file is **comment-only** still stales the
marker, and still costs a full Docker fixture run. Measured in cdkd on
2026-08-26, where a lane paid THREE real-AWS runs of one fixture, the third for a
round whose provider change was verified to carry zero non-comment lines. What
ended it was telling the implementing agent, before its last pass, to batch every
remaining finding into ONE commit and report when the tree is FINAL with no
second pass — after which the integ ran once. Say that explicitly rather than
assuming it: an agent handed a list of findings will otherwise fix, verify and
hand back, which is the right instinct everywhere except in front of a gate that
costs a Docker run. The reviewer-side corollary is the reverse — dispatch a round
SCOPED to the delta and ask for the whole round's findings at once, rather than
trickling them.

- **A `src/**` runtime change** → drive the affected flow end-to-end against
  Docker / a fixture (invoke the Lambda, hit the served route, run the task), not
  just the unit suite. For an issue with a concrete repro, reproduce it with the
  FIXED binary (`vp run build` first — the CLI runs from `dist/`) and confirm the
  behavior is now correct. `/run-integ <local-*>` exercises the real Docker path;
  keep or extend the fixture that covers the fixed behavior in the SAME PR.
- **A fixture that establishes the fix's PRECONDITION on the happy path cannot
  test the arm where the FAILING path creates it.** The most expensive shape this
  flow produces, because every signal says pass: in cdkd (go-to-k/cdkd#2125) a fix
  keyed on state that only the SUCCESS path persisted cleared unit tests, a
  real-AWS fixture and four reviewers, and the fifth caught it by tracing the
  EVIDENCE rather than the code. Here the state is whatever an earlier phase of a
  `local-*` fixture leaves behind — a started `cdkl` process (`CDKL_PID`), a
  container or network named `cdkl-*`, a written `.scenario.yaml` — so a fixture
  that starts the server successfully and only then exercises the failure can
  never reach the case where ONE operation both creates the situation and has to
  handle it. Ask **which phase writes the state in the fixture, and which writes it
  in the reachable case**; if they differ, add the arm where one operation does
  both, and prove it DISCRIMINATES by mutating the fix and confirming the ORIGINAL
  arm still passes while the new one fails.
- **A `cleanup` that ALSO runs before the run must not destroy anything the run
  then needs.** A scratch path computed at load time (`WORKDIR="$(mktemp -d …)"`),
  an `rm -rf "$WORKDIR"` inside `cleanup`, and the pre-run `cleanup` call are each
  correct alone; together the directory is gone before its first write and the
  symptom is a bare `No such file or directory` from a redirect far from the cause.
  It cost a real cycle in cdkd. This repo is exposed: `local-*` fixtures DO call
  `cleanup` pre-run (`local-start-alb-redirect`, `local-start-alb-auth-jwks`,
  `local-ecs-service-connect` and others), and today they survive only because
  their `cleanup` sweeps PROCESSES and containers — things a phase re-creates —
  and no fixture yet computes a scratch dir at variable-definition time. The moment
  one does, that combination is a live foot-gun. Anything `cleanup` removes must
  either be re-created by a phase or be created AFTER the pre-run call, and a
  stubbed end-to-end dry run (pre-run cleanup, then the full run) catches it in
  seconds instead of a Docker cycle.
- **When a fix round produces the NEXT round's blocker twice, stop reviewing the
  patch and question its SHAPE.** `/verify-pr` already says to re-review the fix
  delta; this is what to do when that keeps paying out. Each fix is locally
  correct and moves the failure one layer out rather than removing it, and the
  blockers are found by executing a probe or tracing a window — never by
  re-reading the diff. After round two, ask what the rounds have in COMMON: it is
  usually one structural absence, and naming it does not skip the rounds but does
  tell everyone what they are chasing. Then do NOT take the structural fix late
  in the cascade — adding new code to a command entrypoint at round five is how
  round six happens. Take the narrow fix, file the structural one, and reference
  it from the narrow fix so the next reader sees the choice was made rather than
  missed.

  **Filing the structural fix does not stop the cascade, and the rule above used
  to imply it would.** Measured here on 2026-08-27
  (go-to-k/cdk-local#596): the structural issue was filed at round five and the
  rounds ran to TWELVE, producing eleven instances of one defect class in one
  PR, five of them introduced by the fix for the previous one. What ended it was
  not a better check. It was making the artifact **CLAIM LESS**.

  The tell that you are in this state: each round's fix is more SOPHISTICATED
  than the last. In that PR a `/run-integ` orphan sweep went from a name scan,
  to a scoped filter, to a guarded filter, to stderr classification, to a status
  filter — and the simple `rc`-only sweeps sitting beside it were correct the
  whole time, under the exact conditions that defeated the clever ones. The
  sophistication WAS the defect: `grep -q 'does not exist'` also matches
  botocore's `The source_profile ... does not exist`, raised before any network
  call, so a broken profile reported CLEAN having queried nothing.

  So when the rounds keep coming, ask what the artifact is CLAIMING, and delete
  the claim rather than defending it. That sweep now prints the raw command
  output and names both outcomes instead of emitting a verdict — a command that
  claims nothing cannot claim something false. Expect this to feel like a
  retreat; it is one, and it is the move that converges.

  Two corollaries, both paid for in that PR:

  - **Fence the REMEDIATION, not just the detection.** Five of the eleven
    instances arrived through a fix, and the last one was in the remediation:
    `cdk destroy` on names built without the suffix exits 0 SILENTLY, so the
    operator read success with both stacks still deployed. Every fence up to
    that point pinned the SCAN, so restoring that line left the suite green. If
    a recipe both detects and repairs, the repair is where the next instance
    goes.
  - **Do not pre-commit to a remedy for a finding you have not seen.** Twice
    there, the plan was "if instance nine appears, delete the whole thing" —
    stated before instance nine existed. When it arrived, deleting would have
    left the flow with NO orphan check, which is instance one made permanent.
    A rule announced in advance is not judgement; it is a way of not having to
    exercise any. Say what the next finding would have to SHOW, not what you
    will do about it.

  Two shapes recur, and they are distinguishable a round apart:
  - **TWO SPELLINGS OF ONE QUESTION** — the fix is to make both sites use ONE
    predicate verbatim, not to write a better second spelling. A better spelling
    looks like a fix and passes its own test, so this is the sub-case that keeps
    regenerating. Name the SITE THAT OWNS the question and make every other site
    call or copy it exactly; a paraphrase is another round waiting to happen.
    Measured in cdkd (go-to-k/cdkd#2134) over three rounds, ending only when the
    authority's test was copied character for character — the round before, the
    two spellings still disagreed on the empty string, on the fail-OPEN side.
  - **A PROXY FOR A QUESTION ONLY ANOTHER COMPONENT CAN ANSWER** — the fix is to
    make that component REPORT, and the tell is that each proxy is wrong in BOTH
    directions at once. Two spellings DISAGREE at an edge; a proxy has no access
    to the fact at all, so every candidate both misses real cases and fires on
    unreal ones. When a round's fix lands on a new OBSERVABLE rather than a new
    spelling — "it threw", "the text survived", "a marker exists" — ask whether
    the thing you want to know is even derivable from outside the component that
    decides it. If it is not, the rounds are unbounded. Measured in cdkd
    (go-to-k/cdkd#2157 / go-to-k/cdkd#2166) over three rounds asking "did this
    reference go unresolved?" from outside the resolver: keying on "it THREW"
    missed the path that warns and continues without throwing, and over-reported
    an unrelated failure that merely shared the same bag; keying on "the raw text
    SURVIVED" missed input a downstream step rewrote without resolving, broke on
    JSON escaping, and fired permanently on PROSE that merely mentioned the
    syntax. The local analogue is any question only the Docker daemon or the
    running `cdkl` process can answer — "did the container actually start", "did
    the route really bind" — where every outside proxy (a log line, a port probe,
    a file appearing) fails in both directions the same way.
- **WITHDRAWING the half that cannot be made right is a legitimate outcome, and
  the residual issue must carry the MEASUREMENTS, not just the diagnosis.** The
  rule above says where the fix goes; this says what to do with the code already
  written for the wrong one. Cut it, ship the part the issues actually scoped,
  and file the rest — the filing is cheap only if it carries what the session
  PAID for: each proxy tried, the input that broke it, and the number it
  produced. A diagnosis alone makes the next session re-run every probe. cdkd's
  go-to-k/cdkd#2166 is the worked example: three rounds of measurements plus a
  live arm that was written, passed, mutation-probed and then reverted, so none
  of it is rebuilt.
- **When two reviewers CONTRADICT each other, settle it in the code YOURSELF
  before forwarding either.** In cdkd's run the spec reviewer explicitly CLEARED
  what the security reviewer called a blocker, both having read the same lines, and
  the code's own comment settled it in one read. Forwarding both hands the
  implementing agent a contradiction to adjudicate with LESS context than you have;
  forwarding only the reassuring one is how a blocker ships. This repo dispatches
  1 or 3 reviewers by `/review-pr`'s tier, so the collision is routine here, not
  hypothetical: read the disputed lines, then tell the agent which reviewer was
  right and why.
- **A diff with no `src/**` change** (docs, skills, rules, hooks, CI, config) is
  EXEMPT from the live-test, and from the integ unless it touches
  `tests/integration/**` — `integ-gate` short-circuits on `src/**` OR
  `tests/integration/**`, so a tooling PR that edits a fixture is still integ-gated.
  It is never exempt from `/verify-pr` itself: `verify-pr-gate` gates every
  `gh pr create` / `gh pr merge` on the marker with no diff-shape carve-out, and only
  `/verify-pr` sets it. What the exemption drops is the LIVE test, not the verifying.
  This is the easy tier to under-verify: with no fixture and no integ that can fail,
  "the gates are green" reads as "nothing left to check". What SATISFIES the step
  depends on what the diff changes, and a diff that does both owes BOTH arms.

  **Arm 1 — the diff changes what a command or gate DOES** (hook logic, a
  `vite.config.ts` task, `ci.yml`, a lint / build config). The verification IS that
  command, and those runs ARE the live test rather than an exemption from it. Run
  *the command your own diff changes* — `vp run test:hooks` for a `.claude/hooks/**`
  edit, the changed task for `vite.config.ts`, `vp check` for the lint / typecheck
  config. `vp check` is not the universal answer: its lint and fmt are scoped to
  `src/**` and its typecheck project is `["src/**/*", "types/**/*"]`, so it reads
  neither `ci.yml` nor any hook, and pointing it at a hook diff is a probe that
  cannot fail. Run it BEFORE and AFTER, and drive the FAILURE direction too — a
  change that swallows an exit code looks exactly like one that fixes the gate.
  Four traps, measured here on 2026-08-19 (go-to-k/cdk-local#504, go-to-k/cdk-local#506):
  - **Repeating a CACHED `vp run <task>` re-runs nothing.** `run.cache.tasks` is on
    in `vite.config.ts`, and a task that does not opt out with `cache: false` — which
    is every task you would repeat to watch it: `check`, `test`, `lint`, `typecheck`,
    `format:check`, and `verify`, the one §6 sends you to — replays its recorded exit
    code: `vp run check` printed `cache hit, 2.01s saved` on runs 2-5 — five identical
    greens, one execution. When the POINT is to watch the exit code repeatedly, call
    the underlying command directly (`vp check` / `vp lint` / `vp fmt --check`), which
    is never cached. Do not generalize it the other way either: `test:hooks` and
    `build` DO set `cache: false`, so the hook harness really does re-run each time.
    Read the task's own block rather than assuming a direction.
  - **Inject the failure into `src/**`, never into `tests/**`.** `lint.ignorePatterns`
    / `fmt.ignorePatterns` are source-only (`['**/*', '!src', '!src/**']`): a
    non-`_`-prefixed unused variable in a `src` file fails `vp check` rc=1
    (`eslint(no-unused-vars)` + `typescript(TS6133)`), while the same injection under
    `tests/unit/**` returns rc=0 with the linted file count unmoved. A probe that
    lands in `tests/` — or that a `varsIgnorePattern: '^_'` name exempts — proves
    nothing and reads as "the gate is broken".
  - **Run a `$0`-relative harness from beside its subject.** Comparing before/after
    means running the OLD suite against the NEW code, and the obvious move — dump
    `git show origin/main:<test>` into `/tmp` and run it — silently breaks any
    harness that derives its subject from `$(dirname "$0")`. On 2026-08-19 the go-to-k/cdk-local#506
    lane read `pass: 0  fail: 9` from `pr-review-gate.test.sh` in `/tmp` and briefly
    took it for a regression; the same file run from `.claude/hooks/` gave
    `pass: 9  fail: 0`. Write the old copy next to the real one under a temporary
    name and delete it after, or the probe measures its own path resolution.
  - **Then guard the SHAPE of the fix**, because nothing else re-checks a config or
    hook line. For a `.claude/hooks/**` fix the repo's own mechanism is a bash smoke
    test beside the hook — `.claude/hooks/pr-review-gate.test.sh`, run by
    `vp run test:hooks` and wired into CI — added for go-to-k/cdk-local#501 precisely because a
    heuristic edit has no other regression net.

  Why BOTH directions, concretely. An exit code can lie in either direction, and the
  two repos supply one example each. **Non-zero that means nothing**:
  go-to-k/cdk-real-drift#1761 / go-to-k/cdk-real-drift#1765 — `vp run check` exited
  134 on a clean tree while finding 0 errors (a Vite+ stdout `EAGAIN` panic),
  deterministically — measured 3/3 in each state, 134 before the fix and 0 after. The
  fix was a one-line change to the `check` task command, and the risk it carried was
  the opposite of a flake: a redirect that swallows the exit code turns a RED tree
  green, which is why go-to-k/cdk-real-drift#1765 shipped a test asserting the
  `exit 1` survives.
  **Zero that means nothing**: right here, `vp test run` returned rc=0,0,1,0,1 across
  five identical runs on a clean branch (2026-08-19) with all 3126 tests passing every
  time — the go-to-k/cdk-local#402 forks-worker exit, which kills a reused worker AFTER its assertions
  pass. So one green proves neither that a command is broken nor that it is fixed.
  Note the flap is task-specific (`vp check` was stable, 5x rc=0), which is the point:
  measure the command you actually changed rather than assuming its behavior.

  **Arm 2 — the diff changes PROSE only** (a skill, a rule, a doc — including this
  file). There is no command to re-run, so the CLAIMS are the artifact: resolve every
  gate, hook, skill, path, task and command the new text names against this repo's
  own files, and RUN each command the text will send the next agent to run,
  confirming its output matches what the text promises. That is §10-c's claim-by-claim
  pass, owed whether or not the text came from a sibling repo. Mirroring go-to-k/cdk-local#511 into
  this repo is the worked example: four artifacts the sibling wording named do not
  exist here — `.claude/hooks/run-tests.sh`, a `tests/unit/scripts/` directory,
  `matrix-regen-coverage.test.ts`, and a `dirty-path-restore-gate` hook — so a
  verbatim copy would have sent the next agent to run a harness this repo does not
  ship. A read-only reviewer whose only job is to resolve each named noun against
  this repo is what catches these; it also caught the two stale claims this section
  had accumulated on its own.

After a Docker-backed run, sweep for orphans and clean up via `/cleanup` (the
container / network filters and the AWS orphan sweep -- run for EVERY fixture via
`tests/integration/_lib/aws-orphan-sweep.sh`, not scoped by a `*-from-cfn-stack`
glob, which missed three resource-owning fixtures -- are in `.claude/CLAUDE.md` ->
"After running integration tests"). Leaving orphan resources after a run is never
acceptable.

`/verify-pr` sets the `check` + `docs` + `verify-pr` markers, which clear
`verify-pr-gate` — not `gh pr merge` as a whole. That merge is additionally gated by
`integ-gate` (any `src/**` / `tests/integration/**` touch; only `/run-integ` sets it),
`pr-review-gate` (size / bias tier; only `/review-pr`), and, from a side worktree,
`gh-pr-merge-worktree-gate` (only `/merge-pr`).

### 8-z. When a mutation probe reports NO discrimination

**A probe that reports NO discrimination is a claim about the FENCE, and three
other things produce the identical output.** Ask them in order before touching
the fence, because each was hit in one session (2026-08-25) and each cost a
working assertion nearly being deleted or rewritten:

1. **Did the edit land?** `sed`/`perl` one-liners fail silently in ways that read
   as "no match". A `perl -0pi -e "s|^\|...|...|m"` whose pattern is delimited by
   the same `|` it escapes matches nothing; a `sed -E`-only alternation (`\|`) is
   a GNU extension that matches nothing on macOS; a `sed: bad flag` prints ABOVE
   the suite output and scrolls past. Prove it with `grep -c '<the mutated text>'`
   before reading the result, and prefer `python3` with an `assert anchor in s`
   over a shell one-liner — an assertion that throws is louder than a quoting
   slip that quietly matches zero.
2. **Does the case's execution path REACH the edited line?** The edit can land
   and still prove nothing. Breaking a hook's branch-lookup call left its suite
   fully green because every case carried an explicit PR number, so the lookup
   never ran. The fence was fine; the probe was aimed outside the cases' path.
   The fix is a case that HAS to take that path, not a change to the fence.
3. **Did the command run where you think it did?** A relative-path edit under a
   silently reset cwd lands in another worktree, and the `git status` confirming
   it runs in that same wrong tree — so "clean" and "clean somewhere else" print
   identically. Use ABSOLUTE paths and confirm by a property the wrong tree
   cannot fake (`ls -la` mtime).

And one shape inside the fixture itself: **an expected value must be an
INDEPENDENT variable from the one under test.** A stub keyed its content on a
sha whose default was the same literal on both the producing and the consuming
side, so breaking the producing call still served the content and the case could
not fail.

Only after all four does "the fence is weak" remain as the explanation. Deleting
an assertion on the strength of an unexamined green is how a working guard gets
removed.

Ported from cdkd, where all four shapes were measured in one session (go-to-k/cdkd#2197 / go-to-k/cdkd#2200 / go-to-k/cdkd#2198). The mechanism is the shell and the tooling, not anything cdkd-specific, so it applies here unchanged.

