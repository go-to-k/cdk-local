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
a zero-non-comment-line round). Tell the implementing agent, explicitly, to batch
every remaining finding into ONE commit and report the tree FINAL, no second
pass — otherwise it hands back per finding. Reviewer-side: dispatch a round
SCOPED to the delta, whole round's findings at once, not trickled.

- **A `src/**` runtime change** → drive the affected flow end-to-end against
  Docker / a fixture (invoke the Lambda, hit the served route, run the task),
  not just the unit suite. For a concrete repro, reproduce with the FIXED binary
  (`vp run build` first — the CLI runs from `dist/`). `/run-integ <local-*>`
  exercises the real Docker path; keep or extend the covering fixture in the
  SAME PR.
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
merge-ready". The gate is not what breaks: `pr-review-gate.sh` compares the
recorded `.markgate-pr-review-sha` sentinel against the PR's current HEAD and
refuses with a `(mismatch)` line, so a lane-set marker does not authorize an
unreviewed merge; what it destroys is the record.

**And the orchestrator's own review round is not optional because the lane
already ran one.** A lane's reviewers are its children — same brief, same
framing — so they clear what the lane already believes. Measured 2 for 2 in
that run: on go-to-k/cdk-real-drift#1838 the lane's own 3-axis round reported
clean and an independent 3-axis pass found a HIGH blocker (a flow-style
`exclude:` a hand-rolled YAML scanner could not see, leaving its "no exclude
declared" tripwire green while markgate really did subtract); on
go-to-k/cdkd#2383 the same again one spelling deeper (a merge key splicing an
`exclude` from a SIBLING gate, invisible to both the parser and a tripwire that
grepped only the `check` block). Take the tier `/review-pr` gives for YOUR
pass; a lane's clean round is not a measurement that lowers it.

**A reviewer's scratch COPY of a worktree is not detached from git, so its
`git add -A` writes to the LIVE tree.** A linked worktree's `.git` is a FILE
holding `gitdir: <repo>/.git/worktrees/<name>`, and `cp -R` carries the
pointer: every git command inside the copy reads and WRITES the real worktree's
index and HEAD. Measured 2026-08-29 in the sibling cdkd, where a read-only code
reviewer copied a lane's worktree, ran `git add -A` there, and staged three
tracked DELETIONS in the live tree that the lane's next commit would have
shipped — nothing announced it, because the reviewer believed it was on a copy.
Two lines therefore belong in every read-only reviewer's brief: **run no
WRITING git verb** (`add` / `commit` / `restore` / `checkout` / `stash` /
`clean`) anywhere, copy included, severing the pointer with `rm .git` if you
must copy at all; and **report the TARGET worktree's `git status --porcelain`
before AND after the round.** The pair is what makes damage attributable rather
than a mystery a later agent finds: that incident surfaced only because the
NEXT reviewer volunteered "the tree went dirty mid-review, not mine", after
which the responsible one repaired the index with `git restore --staged` (index
only, never the working tree). This repo runs its lanes in
`.claude/worktrees/`, so the hazard is identical here.

### 8-z. When a mutation probe reports NO discrimination

**A probe that reports NO discrimination is a claim about the FENCE, and three
other things produce the identical output.** Ask them in order before touching
the fence — each was hit in one session (2026-08-25) and each nearly cost a
working assertion:

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

And one shape inside the fixture itself: **an expected value must be an
INDEPENDENT variable from the one under test.** A stub keyed its content on a
sha whose default was the same literal on the producing and consuming sides, so
breaking the producing call still served the content and the case could not fail.

Only after all four does "the fence is weak" remain. Deleting an assertion on
the strength of an unexamined green is how a working guard gets removed. Ported
from cdkd, all four shapes measured in one session (go-to-k/cdkd#2197 /
go-to-k/cdkd#2200 / go-to-k/cdkd#2198); the mechanism is the shell and the
tooling, not anything cdkd-specific.
