<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One tree per lane, then implement

This stage (and §6–§8) normally runs INSIDE a lane subagent the orchestrator
dispatched — one general-purpose agent per claimed issue, so the lane's diffs,
test output and review round-trips never land in the parent context. Every
rule below applies unchanged there: hooks fire on the lane's tool calls, and
markgate markers land in the lane's own worktree. Two actions belong to the
parent's serialization turn and are NOT the lane's to start: a Docker-side
integ run (`/run-integ` — and the `/create-integ` run a new-factory PR needs
before `gh pr create`: ask the parent for that turn mid-lane) and the merge
(`/merge-pr`) — the orchestrator's serialization invariant; §9. A lane stops
at merge-ready and reports. Live-proven: go-to-k/cdk-local#621 was built
end-to-end by a lane subagent with every hook and gate firing inside it
(sibling go-to-k/cdk-real-drift#1831 shipped the same way the same day).

### 5-a. Sweep the class, not the instance

**Before fixing, ask whether the defect has SIBLING SITES — and if it does,
sweep them in THIS lane rather than filing them.** Most defects here are a
CLASS: once the root cause is named, grep for the same shape across `src/`.

- **Query for the PRECONDITION minus the REMEDY, never for the remedy alone.**
  When the defect is a MISSING thing, a grep for the missing thing returns
  only sites that already HAVE it — broken sites are invisible by
  construction. Ask: what makes a site ELIGIBLE, and which eligible sites lack
  the fix? In go-to-k/cdk-local#587's lane the remedy-shaped
  `grep -n "docker rmi\|..." tests/integration/*/verify.sh` found five sites,
  all already clean; the eligibility query below found six more, plus a
  seventh (`local-invoke-agentcore`, Dockerfile-built, invisible to both) —
  the go-to-k/cdk-local#603 umbrella. The remedy query saw 5 of 12.

  ```bash
  BUILDERS=$(grep -rl 'DockerImageFunction\|DockerImageCode\|ContainerImage.fromAsset\|fromImageAsset\|image-override\|fromDockerImageAsset' tests/integration/ \
    | awk -F/ '{print $3}' | sort -u)
  for f in $BUILDERS; do
    v="tests/integration/$f/verify.sh"; [ -f "$v" ] || continue
    grep -q 'docker image rm\|docker rmi' "$v" || echo "NO CLEANUP: $f"
  done
  ```

- **A count derived from the instance you happened to hit is not a count** —
  the same run sized the residue from the one instance it tripped over ("one
  fixture, ~30 min"); it was seven fixtures, three the heaviest in the suite,
  and `Effort` / `Estimate` are what a future session budgets from.
- **N sites of one root cause is ONE issue and ONE PR, never N issues** —
  split into N, each site pays the full fixed cost for the same edit. Two
  boundaries: a sweep whose RESIDUE carries its own verification is a genuine
  `next` (file an umbrella naming every site, say which sites this lane DID
  close); and sweep the same ROOT CAUSE, not the same AREA — the test is
  whether a single sentence describes the fix at every site.
  **Say WHY in the criteria's terms, not the PR's.** The first boundary read
  "a sweep that would make the PR unreviewable" until 2026-09-05 — a spelling
  `.claude/hooks/issue-deferral-criteria-gate.sh` refuses, so this file blessed
  what the gate blocks (the same fix as go-to-k/cdkd#2619; three repos run this
  skill and must answer it alike). Review size is the SIGNAL; under it is
  verification the residue needs and this lane is not already paying. Else the
  residue is `now`.
- **A mechanical sweep is not verified by a PARSE — RUN every site you
  converted.** `bash -n` and the typechecker see neither of the two ways a
  sweep dies at every site at once (both hit in the go-to-k/cdk-local#603
  lane, go-to-k/cdk-local#667): **extracting a shared helper re-verifies the
  CALLERS, not the helper** (every converted caller died before its first
  assertion — the `source` landed after the fixture's `cd "$(dirname "$0")"`,
  and `${BASH_SOURCE[0]}` stops resolving once cwd changes; every caller must
  source ABOVE its `cd`), and **order the rewrite BEFORE you introduce the
  construct it rewrites** (a `s/echo "FAIL: /fail "/` sweep applied after the
  `fail()` helper was inserted rewrites the helper's own body into a call to
  itself — unbounded recursion that parses clean).
- **A red fixture is not evidence about your lane until you have ATTRIBUTED
  it**: re-run on a stashed / clean tree and compare the failure SIGNATURE,
  not the exit code. Identical both ways = pre-existing (say so in the PR
  body, file, proceed); different = yours, stop. Running all eight sites
  rather than one representative is what surfaced two fixtures already red on
  `main` (go-to-k/cdk-local#659 / go-to-k/cdk-local#660, both
  `severity:high`) — a worked instance of go-to-k/cdk-local#594.
- **A COUNT is a claim, and one RELAYED from a subagent is unearned** — paste
  the deriving command beside every published number; a number arriving as a
  WORD was counted by an agent, command output by a machine. Run the query
  yourself before it goes anywhere durable (cdkd, 2026-08-26: FOUR relayed
  counts published in one run, all wrong — "all nine sibling sites" was 78
  across 14 files by grep).
- **A measurement written into a SOURCE COMMENT is a published claim too** —
  give it one of three dispositions: delete it, fence it with a test that
  reads the code, or attribute it as a DATED measurement. Nothing downstream
  re-checks such a line and no suite can see it — go-to-k/cdkd#2612's wrong
  probe result sat in a branch comment beside a destructive confirm prompt,
  and only the review round stopped it becoming a fence a later editor would
  trust. What such a comment should state is the INVARIANT the code jointly
  enforces, which is re-derivable and cannot go stale.
- **Re-derive at the FINAL sha, not at the round that produced the number** —
  the PR body is written once, the branch keeps moving (measured here
  2026-08-27: FOUR published counts each accurate for its round and wrong
  against the merged branch; three needed patching after review).

### 5-b. Resolve a finding against the issues ALREADY OPEN, then file

The code sweep finds sibling SITES; this finds a sibling ISSUE — written from
a different angle, naming a different section. §10-c's three-window version
covers only mirrored skill LESSONS. Two measured duplicate pairs out of 145
filed: go-to-k/cdk-local#528 / go-to-k/cdk-local#531 (eight minutes apart,
both closed by one PR go-to-k/cdk-local#532) and go-to-k/cdk-local#504 /
go-to-k/cdk-local#511 (75 minutes apart) — not one of the four bodies records
an open-ISSUE search, the single window that would have caught either pair.

```bash
# Search the CONCEPT, not this instance's spelling — the same reason the code
# sweep above greps for a SHAPE rather than a name.
gh issue list --state open --limit 200 --search '<root-cause concept>' \
  --json number,title
# Then the body window, which the search index misses: an issue names the
# section or symbol it targets in the body, not always in the title.
gh issue list --state open --limit 200 --json number,title,body \
  --jq '.[] | select((.body // "") | test("<shared symbol / call / assumption>";"i"))
        | "\(.number)\t\(.title)"'
# `(.body // "")`, not `.body`: an issue filed with no body makes `test` abort
# the whole jq program with "null (null) cannot be matched", so one body-less
# issue silently costs you the entire window.
```

On a HIT, the finding becomes a CHECKLIST ROW in that issue rather than a new
issue number:

```bash
U=$(mktemp)   # NOT a fixed /tmp path — parallel lanes share the scratchpad
gh issue view <hit> --json body -q .body > "$U" \
  && [ -s "$U" ] \
  && printf -- '- [ ] <site>: <one line, plus where the evidence is>\n' >> "$U" \
  && gh issue edit <hit> --body-file "$U"
```

**The chaining and the `-s` test are load-bearing, not style.** The redirect
truncates `$U` before `gh` runs, so an unchained recipe whose `view` fails
leaves an empty file the `printf` fills with the one new row, and the `edit`
replaces the issue's WHOLE body with it — destroying every previously folded
finding, the outcome §10-0 forbids. `mktemp` for the same reason at another
scale: parallel lanes share the scratchpad — never run two folds against the
same issue concurrently.

On a MISS — the expected outcome for a genuinely new root cause — file it,
recording the search in the body (`Dup-check: searched open issues for <terms>
-- none covers this root cause`), **with its `Severity` / `Effort` values ALSO
as labels**:

```bash
# A LITERAL path, and no shell variable anywhere in this command. Substitute
# `<issue-slug>` per FINDING, not per lane -- the root cause plus your branch.
# Two reasons, and the second is the one that bites: parallel lanes share /tmp,
# AND the gate prefers a READABLE file at that path over the heredoc below it.
# Measured: with a file already there carrying `Dup-check:`, a command whose
# heredoc omits that line exits 0 and then overwrites it, filing the
# marker-less body. Reusing one slug for a second finding is exactly how that
# happens. The REVERSE is reachable too, and it costs a FALSE BLOCK: run that
# same slug a THIRD time with a properly marked heredoc and the gate returns
# rc=2, because it reads the STALE marker-less file on disk in preference to
# the heredoc about to replace it -- the refusal is about a stale READABLE
# file, not a missing marker (measured 2026-09-01, here and in cdkd). Nor does
# a marker-less file need a gated writer: a plain
# `cat > /tmp/wi-issue-body-x.md` carries no `gh` verb, so no gate sees it.
cat > /tmp/wi-issue-body-<issue-slug>.md <<'BODY'
<one paragraph: the root cause, and where the evidence for it is>

Dup-check: searched open issues for <terms> -- none covers this root cause
Session-fit: next (not this session) -- <reason the WORK owns, not this session's circumstances -- .claude/rules/session-report.md>
Severity: high -- <what stays broken while it is undone>
Effort: large (L) -- <which verification cycle it drags>
Estimate: ~3 h+ -- <what eats the time>
BODY
gh issue create -t 'fix(local): ...' \
  --body-file /tmp/wi-issue-body-<issue-slug>.md \
  --label severity:high --label effort:large
```

- **The path is LITERAL because a `$VAR` one cannot be filed at all** —
  `issue-dup-check-gate.sh` reads the command TEXT at PreToolUse time and
  refuses a `--body-file` path containing `$` or a backtick outright (it
  cannot open such a file to look for the `Dup-check:` line; fails closed).
  Measured 2026-08-31 by driving the hook: the `B=$(mktemp)` spelling returns
  rc=2 in all three repos; the literal-path form returns rc=0 from both gates
  that see it here, and deleting just the `Dup-check:` line returns rc=2
  again — so that rc=0 is the gate passing a good command, not failing to
  look.
- **The FOLD recipe keeps `mktemp`, and that asymmetry is the gate set, not
  taste** — folding runs `gh issue edit`, which `issue-dup-check-gate.sh`
  does not match, and the classification gate falls back to reading the
  command text when a path is unresolvable (measured rc=0 from both). Folding
  also NEEDS a unique file it reads back.
- **The `cat` is load-bearing** — an empty file pointed at by `--body-file`
  files an issue with NO body, refused for "carries no `Dup-check:` line".
  Write the body; do not treat the gate as the thing that will notice. Quote
  the heredoc delimiter so backticks and `$` stay literal.
- **Labels**: prose is invisible to `gh issue list`, so `Severity` / `Effort`
  ride as labels; `Session-fit` is re-decided at claim (a stale label is
  worse than none), `Estimate` is free-form. A claim that rewrites an old
  packed body carries `--add-label` on that `gh issue edit`. Enforced by
  `.claude/hooks/issue-classification-label-gate.sh`; the lane's PR inherits
  the labels via `.github/workflows/pr-inherit-issue-labels.yml` — never
  hand-add them.
- **This is not a filing threshold** (§10-0: an unfiled finding is strictly
  worse than a filed one) — nothing here changes WHETHER a defect gets
  written down, only WHERE. Enforced by
  `.claude/hooks/issue-dup-check-gate.sh`, which refuses `gh issue create` —
  and `gh api repos/<o>/<r>/issues` — without the `Dup-check:` line.
  `gh issue edit` / `gh issue comment` are deliberately NOT gated: the gate
  makes minting non-free, not folding free. Two consequences: a folded row
  carries no `Session-fit` / `Severity` (write the severity into the row's
  text), and `gh issue edit` is not among `pr-body-item-number-gate.sh`'s
  verbs, so a folded row is the one issue-body path with no `#N` auto-link
  check — write `go-to-k/<repo>#N` yourself. The gate exists because this
  section's rule, already written and correct, stopped neither pair above.
  Registration is not execution.

### 5-c. `Session-fit: next` must NAME the next session's verification

**Before writing `Session-fit: next`, NAME the command the next session will
run to verify the fix — and say that a fresh session will be able to run it.**
A deferral is a PREDICTION; unstated, it is never checked, and the
classification decays into naming the KIND of work — MEANS instead of purpose.
No trigger list catches it, so the check is GENERATIVE: not "run the integ"
but `/run-integ local-start-api-websocket`; not "add a test" but the assertion
that goes red to green (`vp test run tests/unit/local/<file>.test.ts`). When
naming the command is hard, that difficulty IS the finding, usually one of:

- **The verifier is bound to THIS host.** 53 of 58 integ fixtures drive a
  real Docker daemon (measured 2026-08-26:
  `grep -l docker tests/integration/*/verify.sh | wc -l`): CPU architecture, resolved image
  platform, daemon version (`probeHostGatewaySupport` gates `host-gateway` on
  Docker >= 20.10) and BuildKit behaviour are part of the verifier and none
  travels with the issue.
- **The verifier is bound to THIS account** — a `*-from-cfn-stack` fixture's
  `verify.sh` calls the upstream `cdk deploy` (why `/run-integ` pre-flights
  `which cdk` and `aws sts get-caller-identity` for those).
- **The verifier does not exist yet**, and writing it is most of the work —
  the one case where `next` is genuinely right, BECAUSE you could name what
  is missing.
- **You cannot name it at all** — then nobody can confirm the fix later
  either; not a deferral but an unbounded one.

Measured 2026-08-26: go-to-k/cdk-local#560 was filed `next` on "a fixture /
base-image change, on a different axis" — a CATEGORY statement. The defect is
a Go RIE fault under `linux/amd64` emulation; the filing host was arm64, and a
fixture with no `Architectures` resolves to `x86_64` (defaults in
`src/cli/commands/local-start-api.ts` / `src/local/container-pool.ts`), so an
amd64 host runs it natively and never reaches the emulated path. Review caught
this; nothing in the flow did.

- **Then ask what the next session will have to RE-DERIVE.** If you can point
  at something that exists only in THIS session — a table you measured, a
  probe you built, a shape you just proved correct in a sibling repo — the
  deferral is not free and the answer is `now`. Understanding survives in an
  issue body; a measurement does not.
- **"It needs its own PR" is NOT a `next` reason** — it is a `now` item that
  gets its own PR; the bar is the SESSION, not the diff. Writing "independent
  review surface" on a `Session-fit` line is the classify-by-MEANS error
  arriving through the PR boundary (2026-09-01: a hook missing from one
  sibling was filed `next` on exactly that wording, minutes after its
  two-directional defect had been measured and fixed in the other two repos;
  re-classified `now` on the maintainer's challenge and shipped — the port then
  found four more defects a fresh session would not have looked for). Enforced
  at the filing site by `.claude/hooks/issue-deferral-criteria-gate.sh`,
  `unreviewable` included.
- **A reason about THIS SESSION's own state is legal and EXPIRES** — "held by
  another open PR's diff", "no integ run budgeted here", "no overlap with this
  session's lanes". Unlike the bullet above it is a real reason, but it goes
  false silently while the decision it justified still stands, and §10-0's
  promotion check is what finds it afterwards. Prefer a reason the WORK owns;
  write one of these anyway and it must name the event that ENDS it on the
  same line. Full shape, and the boundary against the bullet above, in
  `.claude/rules/session-report.md`.
- **When the issue body offers more than one fix, say which one the four
  fields cost** — cost the CHEAPEST one you would actually accept (2026-09-02:
  a `next` reason read "a behaviour change across three repos", costing only
  the first-described fix while a six-line no-behaviour-change alternative
  sat in the same body).
- **The converse is the honest use of `next`, and it costs one line**: when
  you CAN name the verification and a fresh session plainly has it, put the
  line in the issue body beside `Session-fit`.

### 5-d. The lane's tree

Never edit in the main checkout (`main-tree-branch-gate.sh` blocks branch
creation there — coverage limit measured below). Per lane:

```bash
# MAIN-CHECKOUT mode only (`references/launch-mode.md` holds the probe, and
# calls itself its ONLY copy). An IN-PLACE run skips these two lines and creates
# no WORKTREE: a nested one dies with the outer workspace, taking its
# uncommitted work (go-to-k/cdk-local#635). It DOES take a branch IN PLACE --
# ALWAYS, whatever state the tree arrived in -- by the recipe below this block.
# The setup lines below still apply: an adopted workspace may be missing them.
git worktree add .claude/worktrees/<name> -b <branch> origin/main
cd .claude/worktrees/<name>
# A fresh worktree's .mise.toml is untrusted, so vp / markgate do not resolve
# until this. (A backslash continuation cannot carry a trailing comment, so
# these are separate lines rather than one `&&` chain.)
mise trust && mise install
pnpm install    # worktrees have no node_modules -- and neither may the MAIN checkout
vp run build    # ...and no dist/ — see below
```

**IN-PLACE: take a fresh branch here, ALWAYS, and WITHOUT leaving the tree** —
and know what is and is not protecting you while you do. The rule used to be
conditional (only for a tree that arrived detached, or whose PR had already
merged); go-to-k/cdkd#2417 made it unconditional. The branch the tree arrived
on is `LAUNCH_BRANCH` — the OUTER TOOL's, not this run's — and this repo has
`delete_branch_on_merge`, so a lane that opened its PR from it would delete
the outer tool's remote branch on the way out. Never commit onto it; §9
switches back to it untouched as the run's last step.
`references/launch-mode.md`'s consequence table (row 4) states the same rule
in one line, for an orchestrator that has not opened this file; THIS section
is where it is defined.

```bash
git fetch origin && git switch -c <branch> origin/main
```

The `&&` is deliberate: unchained, a failed `fetch` still branches, off a
stale `origin/main`. `main-tree-branch-gate.sh` backstops running that line
after a cwd reset: it matches in COMMAND POSITION and judges the MATCHED
SEGMENT, so the CHAINED form this file prints is refused from the main
checkout (driven with synthesized payloads 2026-09-02; coverage landed in
go-to-k/cdk-local#641). Ask whether the coverage is still on `main` by
CONTENT, never by the last commit subject:

```bash
git show origin/main:.claude/hooks/main-tree-branch-gate.sh | grep -c gate_verb_args
```

`gate_verb_args` exists only in the fixed copy: non-zero means the coverage is
there (5 on 2026-09-02); `0` means it is gone and a manual
re-run-`rev-parse`-first anchor is owed again.

**Build BEFORE the first test run.** A worktree starts with no `dist/`; any
test spawning the built CLI fails on the missing binary with an assertion
message about its SUBJECT (go-to-k/cdk-real-drift, 2026-08-27: a docs-only
lane saw 13 failures in a CLI exit-code suite, reproduced them with its edit
stashed, and had begun writing up "a peer merge broke main" — one
`vp run build` turned them green). **A fresh worktree failing where the main
checkout passes is evidence about the WORKTREE first.**

### 5-e. The fix and its test

Do the fix in the lane's tree (match the existing module/pattern exactly; ESM
relative imports need the `.js` extension even in TS source). **Always add a
test that fails without the fix and passes with it** — usually a unit test:
`tests/unit/**` mirrors `src/**`, external boundaries (toolkit-lib, docker
CLI, AWS SDK) mocked with `vi.mock` / `vi.hoisted`. **Check first whether the
artifact already has its own harness** — a `.claude/hooks/**` fix is covered
by a bash smoke test beside the hook (run by `vp run test:hooks`, in CI);
look for a sibling `*.test.sh` before writing a new harness.

- **When the issue reports a stale ENTRY in an enumerated list, audit the
  whole list, in both directions, before fixing the named entry** — drift
  never produces exactly the one instance someone noticed (go-to-k/cdkd#1972:
  one reported dead path; the audit found a second plus four live surfaces
  never added). Here, go-to-k/cdk-local#506: `/review-pr`'s up-bias path list
  is written FOUR times (`UP_PATHS` in `.claude/hooks/pr-review-gate.sh`,
  `.claude/skills/review-pr/SKILL.md`, `.claude/rules/hooks.md`,
  `.claude/agents/pr-code-reviewer.md`) — audit every copy; the first draft
  of this rule said "three" and missed the copy already out of sync. Then
  make the recurrence mechanical: a sync-required list is a test asserting
  every entry resolves and the copies agree (shipped in
  `.claude/hooks/pr-review-gate.test.sh`). Traps found writing it: **compare
  in document order with duplicates preserved, and keep path names out of
  prose inside the extracted region** (a sorted-set compare let an evidence
  sentence naming a dropped path put it back). Run the backward direction
  too: the issue named 7 missing paths; a sweep of `src/**` found ~18 more
  (the authorizer ENFORCEMENT points, not just the verifiers).
- **When the fix mechanizes a rule as a repo-wide SCANNER test, calibrate the
  detection rule against the PRE-FIX broken tree — do not implement the
  issue's signature literally** (go-to-k/cdk-real-drift#1771 →
  go-to-k/cdk-real-drift#1782: the proposed signature flagged ~30 spots,
  mostly idiomatic prose; measuring on the broken tree yielded a
  zero-false-positive rule still catching all 12 real hits). Markdown trap: a
  code span may WRAP a line break — scan per line and ENFORCE the
  single-line-span convention in the test (as
  `tests/unit/skills/work-issues-skill-refs.test.ts` does). Report the HIT's
  own line number, not the paragraph start.
- **Calibrating on the broken tree proves the rule is not NOISY — not that it
  is load-bearing.** Probes to close that, run against the real tree (the
  first two both went red against this repo's own skill-refs test,
  go-to-k/cdk-local#537):
  - **Write the defect in EVERY spelling the language allows, and confirm
    each is flagged.** The `#N` scanner flagged bare `#5` but passed both
    half-qualified spellings (`cdk-local#5`, `go-to-k#5`); the STS audit
    (subject: credentials) matched `new STSClient(` and passed the aliased
    `const { STSClient: STS } = await import(…)` — already at ten sites
    across seven files (go-to-k/cdkd#2111, same shape: a `||`-only scanner
    while the tree used `??`; widening surfaced a real unfiled bug).
  - **But when round three is still ADDING spellings, the instrument is wrong
    — change it rather than write a better pattern** (measured in three
    repos at once, one defect class in a hand-rolled `.markgate.yml` reader:
    go-to-k/cdkd#2383 tallies four spellings across four rounds; this repo's
    two were different again, go-to-k/cdk-local#631 — which is the point).
    Two shapes end it and neither is a sixth pattern: parse with a REAL
    parser, allow-list the tool's own keys, fail CLOSED outside them, and
    raw-scan the WHOLE map as the backstop; or, as
    here — this repo declares no YAML dependency — REFUSE every shape the
    reader cannot model, the STRICTER option: an unmodelled shape stops the
    fence instead of passing through it
    (`tests/unit/gates/markgate-include-globs.test.ts` is the worked example,
    and it held against every respelling its reviewers could construct).
  - **Delete the thing the fence REQUIRES, and watch it fail.** A predicate
    ORing whole-file substrings is satisfied by any one of them; a STATEFUL
    scanner fails without any OR (the `#N` scan flipped one `inFence` boolean
    on any fence line, so a single nested fence muted every later check —
    silently).
  - **Derive the POPULATION from what the rule is ABOUT, not from where you
    first saw it break.** The scanner read ONE hardcoded path while the rule
    exists because the files are MIRRORED (pointed at every mirrored file it
    went red immediately: eight bare refs across four files). A hand-kept
    root list is the same defect wearing a comment; the sharpest fence
    derives its population from the DEFECT itself, so deleting the required
    pattern drops the subject OUT of the population instead of failing
    (go-to-k/cdk-real-drift#1797).
- **A fence is not evidence until you have watched it go red on something you
  had NOT already counted** — calibration hits do not count, nor the failure
  direction driven with the same instances.
- **A suite enumerated along ONE dimension goes green over defects that live
  in the other one.** The probes above vary the SPELLING; the second axis is
  the STATE the subject arrives in, enumerated by accident when every case
  reuses the first case's fixture setup. Measured twice in one PR
  (go-to-k/cdk-local#609): a commit gate shipped 52 green cases with two live
  fail-opens, then 93 green with four more — both times the miss was a file
  STATE the fixture never entered (every case used an already-staged file).
  What ended it was drawing the table: six file states × four command shapes,
  24 cells, each an actual case — which also made UNCOVERED cells nameable
  and exposed three false blocks. Name the subject's dimensions and check the
  cases are a grid, not a line.
- **When the change alters a CLASSIFIER, hand-picked cases cannot fence it —
  measure the DELTA against the old implementation** (go-to-k/cdkd#2001: a
  region-vs-stack-name predicate shipped THREE green revisions, each fixing
  the named case and breaking a neighbour). The fence is a differential walk:
  enumerate the input space, run BOTH the new implementation and a
  transcription of the old one (`git show origin/main:<path>`, not memory),
  and fail on any difference outside an enumerated set of intended classes.
  Two ways it goes inert, both measured: **classify by the resulting VALUE,
  not the input's shape** (bucketing by input left a total regression in the
  "intended repair" bucket, GREEN), and **carry a floor per class** (a pool
  quietly dropping one class passes as "no regressions"). Confirm the two
  agree where they SHOULD agree before trusting where they differ. Natural
  subjects here: `parseOriginOverrides` / `parseKvsFileOverrides`
  (`src/cli/commands/local-start-cloudfront.ts`), `parseLbPortOverrides`
  (`local-start-alb.ts`), `parseAssumeRoleToken` / `parseContextOptions`
  (`src/cli/options.ts`).
- **A VALUE import from a module other suites `vi.mock` reds those suites.**
  The `type`-only import is invisible to the mock; a runtime one is not, and
  the failure names the EXPORT (`[vitest] No "<CONST>" export ...`), reading
  as a missing symbol in the file you edited. When two modules must agree on
  a constant and one is widely mocked, spell it in both and fence the pair
  with a test importing both.

### 5-f. Fan-out and what you tell the agents

You may fan out **one subagent per lane** (disjoint files) — give each its
worktree path, its allowed files, and an explicit "do NOT touch <the other
lanes' files>; STOP and report if the fix needs a forbidden file" guardrail. A
subagent's Bash **bypasses the PreToolUse gate hooks**, so it can
`gh pr create` past `verify-pr-gate` — enforce quality yourself; you (the
orchestrator) still gate the MERGE via `/merge-pr`.

**A FACT you assert to an implementing agent becomes a code comment.** The
agent cannot check you cheaply, so it writes your claim into a JSDoc or
invariant comment in good faith and the claim outlives the session. Measured
here (2026-08-27): THREE wrong assertions in one run, all from verification
scoped narrower than the claim — "two `RoleArn:` sends" (a one-file grep
reported repo-wide; there are five, already written into
`src/utils/role-arn.ts` by the agent); "those sends already passed
`parseAssumeRoleToken`" (the flags have no `argParser`, so they never reach
it); a die-when-`derived < found` rule never run against a correct fixture.
All three were caught by the agent verifying rather than obeying; each cost a
round. Two habits: **derive a repo-wide claim with a repo-wide query**
(`grep -rn` over `src/`, not the file you happen to be reading), and when you
cannot, **say the claim is unverified**. The converse made those rounds
recoverable: an agent pushing back with a measurement is doing its job —
correct the record where the false claim landed (the code comment, not only
the chat), and keep the rejected version executable if you can (that run kept
the wrong rule as a mutation probe, killed by a case named after the
counterexample).
