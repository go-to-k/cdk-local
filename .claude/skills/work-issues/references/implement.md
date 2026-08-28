<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One worktree per lane, then implement

This stage (and stages 6–8) normally runs INSIDE a lane subagent the
orchestrator dispatched — one general-purpose agent per claimed issue, so the
lane's diffs, test output and review round-trips never land in the parent
context. Every rule below applies unchanged inside the lane: hooks fire on the
lane's tool calls, and markgate markers land in the lane's own worktree.
Two actions are reserved to the parent's serialization turn and are NOT the
lane's to start: a Docker-side integ run (`/run-integ` — and the
`/create-integ` run a new-factory PR needs before `gh pr create`: ask the
parent for that turn mid-lane) and the merge (`/merge-pr`) — the
orchestrator's serialization invariant; §9. A lane stops at merge-ready and
reports.

**Before fixing, ask whether the defect has SIBLING SITES — and if it does, sweep
them in THIS lane rather than filing them.** Most defects here are a CLASS, not an
instance: one command factory mishandling a flag, one resolver arm missing a case,
one caller of a shared helper assuming the old contract. Once the root cause is
named, grep for the same shape across `src/` before writing the fix.

**Query for the PRECONDITION minus the REMEDY, never for the remedy alone.** When the
defect is a MISSING thing, the obvious grep searches for the thing that is missing —
and it can only ever return the sites that already HAVE it. The absent sites are
invisible to it by construction, so the sweep reports itself complete while covering
only the half that was never broken. Ask instead: what makes a site ELIGIBLE for this
defect, and which eligible sites lack the fix?

Measured here on 2026-08-27, in go-to-k/cdk-local#587's lane. The root cause was "a
fixture leaks the Docker image it builds". The enumeration used to bound the sweep was
`grep -n "docker rmi\|docker image rm\|docker image prune" tests/integration/*/verify.sh`
— a search for the REMEDY. It returned five sites, all of them fixtures that already had
cleanup, and the lane closed all five and declared the class done. The correct query is
eligibility minus remedy:

```bash
BUILDERS=$(grep -rl 'DockerImageFunction\|DockerImageCode\|ContainerImage.fromAsset\|fromImageAsset\|image-override\|fromDockerImageAsset' tests/integration/ \
  | awk -F/ '{print $3}' | sort -u)
for f in $BUILDERS; do
  v="tests/integration/$f/verify.sh"; [ -f "$v" ] || continue
  grep -q 'docker image rm\|docker rmi' "$v" || echo "NO CLEANUP: $f"
done
```

It returns **six** further fixtures, and a seventh (`local-invoke-agentcore`) that
neither query finds because its image comes from a Dockerfile rather than a
`DockerImageFunction` — filed as the go-to-k/cdk-local#603 umbrella. So the remedy-shaped
query saw 5 of 12 eligible sites and could not have seen the other 7.

**The same run then repeated the mistake one level up, which is why this is a rule and
not a footnote.** An agent that had just diagnosed the flaw in the orchestrator's query
sized the residue from the ONE instance it had tripped over — "one fixture, ~30 min" —
rather than asking which query would find the class. It was seven fixtures, three of them
the heaviest in the suite. **A count derived from the instance you happened to hit is not
a count**; sizing a deferral is exactly where that matters, because the `Effort` and
`Estimate` lines are what a future session budgets from.

**N sites of one root cause is ONE issue and ONE PR, never N issues.** This is the
single largest source of unbounded backlog growth: split into N, each site pays the
full fixed cost — triage, claim, worktree, review tier, integ run, merge — for a fix
that is the same edit N times. Swept together, that cost is paid once, and the
reviewer sees the whole class instead of one instance whose generality is invisible.
It also removes the failure mode where sites 2..N sit open long enough for the fix
at site 1 to drift away from them.

Two boundaries, so this does not become a licence for unbounded lanes:

- **A sweep that would make the PR unreviewable is a genuine `next`** — file it as
  an explicit umbrella naming every site, and say which sites this lane DID close,
  so the residue is unambiguous rather than "the rest, somewhere".
- **Sweep the same ROOT CAUSE, not the same AREA.** Two unrelated bugs in one file
  are two issues; one wrong assumption at five call sites is one. The test is
  whether a single sentence describes the fix at every site.

**A COUNT is a claim, and one RELAYED from a subagent is unearned.** A sweep that
reports "N sites" in its commit message, its changelog entry and its PR body has
asserted that number three times, and a reader can only re-derive it if the query
is there — so paste the command beside the number. The harder half is the count
you did not derive at all: in this flow the numbers that get published usually
arrive inside a fan-out agent's summary or a reviewer's finding, already phrased
as fact, and get copied onward without anyone re-running anything.

Measured in cdkd on 2026-08-26, whose `/work-issues` run published FOUR such
counts, every one wrong and every one relayed — "all nine sibling sites" (a grep
found 78 across 14 files), "nine mutation probes" (fourteen), "ten unit shapes"
(thirteen), and a "if a third copy ever appears" trigger for a predicate that
already had nine copies. Two went into GitHub artifacts, where they outlive the
session, and the first was the load-bearing argument for deferring that work to
an umbrella at all — so being wrong by ~9x under-scoped the deferral it was
justifying.

The tell is grammatical rather than technical: a number arriving as a WORD
("nine sites", "a third copy") was counted by a person or an agent, while one
arriving as command output was counted by a machine. Before a relayed count goes
anywhere durable — an issue body, a PR body, a changelog entry, this file — run
the query yourself and put it in the text. It is one command. What worked on that
run was the implementing agent deriving its next count with `awk` and catching
its own correction mid-flight, and declining to relay a path from the
orchestrator's message after grepping and finding no such file.

**Re-derive at the FINAL sha, not at the round that produced the number.** The
rule above says a relayed count must be re-run; the half it leaves out is WHEN,
and that is where it actually fails. A count is correct when a round reports it
and stale by the time it reaches the PR body, because the PR body is written once
and the branch keeps moving. The durable artifact is the diff being merged, so
that is the tree the number has to describe.

Measured here on 2026-08-27 across one `/work-issues` run, which published FOUR
counts, every one of them accurate for the round that reported it and wrong
against the merged branch: "90 cases" (94 by the time it was checked), "52 -> 93
cases" (the file was NEW, so against `main` it is 0 -> 118), "354 -> 368"
(354 was a mid-PR peak; the real delta is 337 -> 358, and the feature that added
the difference was later deleted), and "6 sites closed" (7 — the enumeration
omitted one the totals included). Three of the four went into PR bodies and had
to be patched after review caught them.

The cheap discipline: derive every published count in the same pass that writes
the body, from the branch you are about to merge, and paste the command. A number
carried forward from a subagent's report three rounds ago is a number about a tree
that no longer exists.

**And whatever you do file, resolve it against the issues ALREADY OPEN first.**
The sweep above looks for sibling sites in the CODE. This looks for a sibling
ISSUE, and it is a different search with a different answer: the issue that
already covers your finding was written from a DIFFERENT angle, by a different
hop, and names a different section. §10-c already runs a rigorous version of
this check — the merged file, then open PRs, then open issues — but its subject
is a mirrored skill LESSON, and it is exactly the path where this repo's
duplicates come from.

Be honest about which problem this solves here, because the sibling repo's
argument does not transfer. Measured 2026-08-26: cdk-local has **8 open
issues**, **three** carrying `Session-fit: next` (go-to-k/cdk-local#560,
go-to-k/cdk-local#561, go-to-k/cdk-local#564), and one umbrella
(go-to-k/cdk-local#281, parked until after launch, with its phases filed as
go-to-k/cdk-local#286 / go-to-k/cdk-local#287 / go-to-k/cdk-local#288).
There is no unbounded backlog to converge. What there is, is a duplicate
GENERATOR that §10-c already names in its own text, with two measured pairs out
of 145 issues filed (41 of them skill-flow / cross-repo-mirror shaped):

- go-to-k/cdk-local#528 (2026-08-19T06:37:46Z) and go-to-k/cdk-local#531
  (06:46:00Z) — **eight minutes apart** (8 m 14 s), and go-to-k/cdk-local#531's three lessons
  (marker-sourcing, `grep -cF`, life-only-probe) are a strict SUBSET of
  go-to-k/cdk-local#528's four. Both were then closed by one PR, go-to-k/cdk-local#532.
  go-to-k/cdk-local#528's own body shows the near miss precisely: it records a
  FILE check against the merged SKILL.md and a scan of the open PRs
  (go-to-k/cdk-local#523, go-to-k/cdk-local#526), reporting them as carrying
  different lesson sets — and no check of the open ISSUE list, where its own
  duplicate landed eight minutes later.
- go-to-k/cdk-local#504 (03:14:05Z) and go-to-k/cdk-local#511 (04:29:26Z) —
  **75 minutes apart**, same target section (`/work-issues` §8's no-src
  verification tier), same upstream lesson.

What the four bodies record is thinner than §10-c's three-window check:
go-to-k/cdk-local#528 records the file and open-PR windows,
go-to-k/cdk-local#531 the file window only, and go-to-k/cdk-local#504 /
go-to-k/cdk-local#511 none at all. **Not one of them records an open-ISSUE
search** — the single window that would have caught either pair.

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
truncates `$U` before `gh` runs, so an unchained recipe whose `view` fails —
wrong number, a non-repo cwd, a transient error — leaves an empty file that the
`printf` fills with the single new row, and the `edit` then replaces the target
issue's WHOLE body with it. Every previously folded finding would be destroyed
by the very procedure that exists to preserve them, which is the one outcome
§10-0 says must never happen. `mktemp` rather than a fixed path for the same
reason at a different scale: parallel lanes share the scratchpad, and a
read-modify-write with no concurrency control loses a row when two folds
overlap — so do not run two folds against the same issue concurrently.

On a MISS — the expected outcome for a genuinely new root cause — file it, and
record the search in the body so the next hop can see the window was checked:

```text
Dup-check: searched open issues for <terms> -- none covers this root cause
```

**File it with its `Severity` / `Effort` values ALSO as labels** -- the body
lines stay exactly as written, and the same two values ride the command as
`--label severity:<high|medium|low> --label effort:<small|medium|large>`:

```bash
gh issue create -t 'fix(local): ...' --body-file "$B" \
  --label severity:high --label effort:large
```

Prose is invisible to `gh issue list`, so ranking by `Severity` costs one
`gh issue view` per candidate without the labels. Only these two get labels:
`Session-fit` is re-decided when the issue is claimed and a stale label would be
worse than none, and `Estimate` is a free-form duration with no closed value set.
The same applies at the CLAIM, which is where an old packed body is rewritten
into the four-line shape and therefore where `Severity` first exists for most of
the backlog -- carry `--add-label` on that `gh issue edit`. Enforced by
`.claude/hooks/issue-classification-label-gate.sh`. The lane's PR inherits the
labels from the issue it closes via
`.github/workflows/pr-inherit-issue-labels.yml`, so never hand-add them to a PR.

**This is not a filing threshold, and it must never be used as one.** §10-0
below is explicit that `filed <= closed` is not a target and that an unfiled
finding is strictly worse than a filed one. Nothing here changes WHETHER a
defect gets written down; it changes only WHERE.

Enforced by `.claude/hooks/issue-dup-check-gate.sh`, which refuses
`gh issue create` without the `Dup-check:` line, and the same refusal covers
`gh api repos/<o>/<r>/issues`, which mints an issue through the REST verb.
`gh issue edit` and `gh issue comment` are deliberately NOT gated — folding
into an existing issue is the outcome this steers toward, so taxing it would
penalise the cheap path and leave the costly one free.

Be precise about what that buys, because the obvious claim is false: folding is
not CHEAPER than minting. After the same search, minting is one command and
folding is three (`view`, `printf`, `edit`). What the gate does is make minting
non-free while leaving folding untaxed — it removes minting's advantage rather
than creating one for folding. Two consequences worth stating rather than
discovering: a folded row carries no `Session-fit` / `Severity`, so §3's ranking
cannot see it (write the severity into the row's text), and `gh issue edit` is
NOT one of the verbs `pr-body-item-number-gate.sh` selects — checked against its
verb list and its `if:` entries, which cover `gh issue create` and
`gh issue comment` but not `edit` — so a folded row is the ONE issue-body path
with no `#N` auto-link check in front of it. Write `go-to-k/<repo>#N` or a bare
number in the row yourself. The gate exists because this
section's own rule — "N sites of one root cause is ONE issue and ONE PR, never
N issues", already written and already correct — did not stop either pair above.
Registration is not execution.

**Before writing `Session-fit: next`, NAME the command the next session will run
to verify the fix -- and say that a fresh session will be able to run it.** Of
the four classification lines this is one of the two that carry no label, and it
is the one that decays quietly. A deferral is a PREDICTION that a later session
can finish the work; the prediction is almost never stated, so it is never
checked, and the classification
decays into naming the KIND of work ("a fixture / base-image change", "a
different subsystem"). That describes the MEANS instead of the purpose, and it is
the failure `.claude/CLAUDE.md` names when it says the four fields exist to make
a deferral HONEST rather than to make one available -- arriving through the
reason line rather than through the values. No enumerated trigger list catches
it either, because the next miss arrives in a shape the list does not contain. So
name it concretely: not "run the integ" but the fixture, as in
`/run-integ local-start-api-websocket`; not "add a test" but the assertion that
goes from red to green, as in `vp test run tests/unit/local/<file>.test.ts`.

The check is GENERATIVE rather than a lookup, which is the point -- it fires on
conditions nobody enumerated. When naming the command is hard, that difficulty IS
the finding, and in this repo it is usually one of these:

- **The verifier is bound to THIS host.** 53 of this repo's 58 integ fixtures
  drive a real Docker daemon, measured 2026-08-26 with
  `grep -l docker tests/integration/*/verify.sh | wc -l`. So the host's CPU
  architecture, the platform of the image the fixture resolves, the daemon's
  version (`probeHostGatewaySupport` in `src/local/docker-version.ts` gates
  `host-gateway` on Docker >= 20.10) and its BuildKit behaviour are all part of
  the verifier, and none of them travels with the issue.
- **The verifier is bound to THIS account.** A `*-from-cfn-stack` fixture's
  `verify.sh` calls the upstream `cdk deploy`, so it needs the `cdk` CLI on
  `$PATH` and credentials for an account it may deploy into -- which is why
  `/run-integ` pre-flights `which cdk` and `aws sts get-caller-identity` for
  those fixtures.
- **The verifier does not exist yet**, and writing it is most of the work. This
  is the one case where `next` is genuinely right, and it is right BECAUSE you
  could name what is missing.
- **You cannot name it at all**, which means nobody can confirm the fix later
  either. That is not a deferral, it is an unbounded one.

Measured here on 2026-08-26. go-to-k/cdk-local#560 was filed
`Session-fit: next (not this session)` on the reasoning "the fix is a fixture /
base-image change, on a different axis from the log-redaction lane that surfaced
it" -- a statement about the work's CATEGORY, which reads as a sound handoff. The
defect is a Go RIE fault under `linux/amd64` emulation (a SIGSEGV in one
fixture, a `sync: inconsistent mutex state` panic in the other), and the issue's
own evidence records `uname -m` = `arm64` on the machine that filed it. So the next
session's verification is `/run-integ local-start-api` plus
`/run-integ local-start-api-websocket` ON AN arm64 HOST, and nothing guarantees
a fresh session has one. What follows is worse than an inconclusive run: a
fixture declaring no `Architectures` resolves to `x86_64` (the default in
`src/cli/commands/local-start-api.ts`) and its warm container is launched at
`--platform linux/amd64` (`architectureToPlatform`, called for a ZIP Lambda from
`startOne` in `src/local/container-pool.ts`), so on an amd64 host it runs
natively and never reaches the emulated path that
`src/local/docker-image-builder.ts` warns about -- a run there can only be
silent about the fault the issue describes. The misclassification was caught in
review; nothing in this flow caught it. One sentence of naming would have
surfaced the host.

**The converse is the honest use of `next`, and it costs one line.** When you CAN
name the verification and a fresh session will plainly have it -- an existing
`local-*` fixture needing only Docker, a `vp test run <path>` assertion, an
ordinary `gh` query -- the deferral is sound. Put that line in the issue body
beside `Session-fit`, so the next session starts from the check instead of
re-deriving it.

Never edit in the main checkout (`main-tree-branch-gate.sh` blocks branch creation
there). Per lane:

```bash
git worktree add .claude/worktrees/<name> -b <branch> origin/main
cd .claude/worktrees/<name>
# A fresh worktree's .mise.toml is untrusted, so vp / markgate do not resolve
# until this. (A backslash continuation cannot carry a trailing comment, so
# these are separate lines rather than one `&&` chain.)
mise trust && mise install
pnpm install    # worktrees have no node_modules -- and neither may the MAIN checkout
vp run build    # ...and no dist/ — see below
```

**Build BEFORE the first test run, and read a fresh worktree's failures with that
in mind.** A worktree starts with no `dist/`, and any test that spawns the built
CLI then fails on the missing binary rather than on its subject — with an
assertion message about the SUBJECT, which is what makes it costly. This repo's
integ fixtures resolve `node ../../../dist/cli.js`, so they are exposed directly,
and `/run-integ` builds first for exactly this reason; the trap is that a UNIT
suite can be exposed too. Measured in go-to-k/cdk-real-drift on 2026-08-27: a
docs-only lane in a fresh worktree saw 13 failures in a CLI exit-code suite
(`expected 1 to be 2`), reproduced them with its own edit stashed, and had begun
writing them up as "a peer merge broke main" — the same file passed in the main
checkout, which HAS a `dist/`, so every comparison pointed at main. One
`vp run build` turned it green with no other change. **A fresh worktree failing
where the main checkout passes is evidence about the WORKTREE first**, and a build
costs seconds against a false broken-main report.

Do the fix in the worktree (match the existing module/pattern exactly; ESM relative
imports need the `.js` extension even in TS source). **Always add a test that fails
without the fix and passes with it** — usually a unit test, where `tests/unit/**`
mirrors `src/**` and the external boundaries (toolkit-lib, docker CLI, AWS SDK) are
mocked with `vi.mock` / `vi.hoisted`. **Check first whether the artifact already has
its own harness**, because it will not be under `tests/unit/**` and that is the only
place you would think to look: a `.claude/hooks/**` fix is covered by a bash smoke
test beside the hook — this repo carries one such suite,
`.claude/hooks/pr-review-gate.test.sh`, run by `vp run test:hooks` and wired into CI
— so look for a sibling `*.test.sh` before writing a new harness from scratch.

**When the issue reports a stale ENTRY in an enumerated list, audit the whole list,
in both directions, before fixing the named entry.** The defect class is "this list
drifted from the repo", and drift almost never produces exactly the one instance
someone happened to notice. Check both that every entry still resolves to something
real AND that everything that belongs is present — the second half is the one that
gets skipped, because the issue only names the first. On 2026-08-19,
go-to-k/cdkd#1972 reported one dead path in a security-surface path list; auditing
the whole list found a second dead path (stale since an unrelated directory rename)
plus four live authn / credential / exec surfaces that had never been added, so the
list under-protected considerably more than it over-claimed. The same shape exists
here, and issue go-to-k/cdk-local#506 played it out end to end: `/review-pr`'s up-bias path list is
written out FOUR times (`UP_PATHS` in `.claude/hooks/pr-review-gate.sh`,
`.claude/skills/review-pr/SKILL.md`, `.claude/rules/hooks.md`, and
`.claude/agents/pr-code-reviewer.md`), so an audit checks every copy, not just the
one the issue quotes — the first draft of THIS paragraph said "three times" and
missed the reviewer-agent copy, which was also the one already out of sync.
Then ask what makes the recurrence mechanical: if a list must stay in sync with
the repo, that is a test asserting every entry resolves and that the copies agree,
not a sentence asking the next reader to remember. go-to-k/cdk-local#506 shipped exactly that in
`.claude/hooks/pr-review-gate.test.sh` — and writing it surfaced a trap worth
carrying: the first draft compared the copies as SORTED SETS, and the evidence
sentence it added beside each list ("... had silently dropped
`src/utils/role-arn.ts`") put that path back into the extracted set, so deleting
the entry from the list still passed. Compare in document order with duplicates
preserved, and keep path names out of the prose that sits inside the extracted
region. Run the audit's own backward direction too, with a subagent if the
surface is wide: go-to-k/cdk-local#506 named 7 missing paths, and an independent sweep of `src/**`
found ~18 more (the authorizer ENFORCEMENT points, not just the verifiers), which
is what actually shipped.

**When the fix mechanizes a rule as a repo-wide SCANNER test, calibrate the
detection rule against the PRE-FIX broken tree — do not implement the issue's
signature literally.** An issue describes the signature as its author noticed ONE
instance, not as a rule with a measured false-positive rate. Run the candidate
rule over the unrepaired tree and read every hit before committing to it: in
go-to-k/cdk-real-drift#1771 -> go-to-k/cdk-real-drift#1782 (2026-08-19) the
issue's proposed "code span
immediately followed by an alphanumeric" flagged ~30 spots, mostly idiomatic
prose; measuring on the broken tree split the hits by side (before-side 5/5
genuine; after-side 13 with 6 ordinary plural suffixes), yielding a rule with
zero false positives that still caught all 12 real hits. One markdown-specific
trap: a code span may WRAP a line break, so decide explicitly whether your
scanner handles that — either tokenize per PARAGRAPH, or scan per line and
ENFORCE the single-line-span convention as part of the test, the way this repo's
`tests/unit/skills/work-issues-skill-refs.test.ts` deliberately does (a per-line
scan that has not decided pairs one span's closing backtick with the next one's
opening backtick and invents findings). And report the HIT's own line number,
not the paragraph start — the consumer of a finding is someone jumping to it.

**Calibrating on the broken tree proves the rule is not NOISY — not that it is
load-bearing.** It measures precision plus recall over the instances that HAPPEN
TO EXIST, and stops there: the spellings the tree does not currently use, and
the contexts that defeat the exemption logic, are untested. Two probes close
that, both run against the real tree rather than reasoned about, and on
2026-08-20 (go-to-k/cdk-local#537) both went red against this repo's own
`tests/unit/skills/work-issues-skill-refs.test.ts`:

- **Write the defect in EVERY spelling the language allows, and confirm each one
  is flagged.** That scanner asked for "no word character before the `#`", which
  flags a bare `#5` and passes BOTH half-qualified spellings — `cdk-local#5` and
  `go-to-k#5` — neither of which GitHub autolinks at all, so the rule was blind
  to two of the three ways to break it. `tests/unit/cli/sts-client-profile-audit.test.ts`
  was worse, because its subject is credentials: it matched the literal
  `new STSClient(` and passed an aliased `const { STSClient: STS } = await import(…)`
  — a spelling this codebase already uses at ten sites across seven files — plus
  a space before the paren, a `mod.STSClient` alias, and the member form
  `new (await import(…)).STSClient(…)`. go-to-k/cdkd#2111 is the same shape again: a
  region scanner calibrated at 19 hits / zero false positives matched `||` only
  while the tree already used `??` at four sites, and widening it surfaced a real
  bug nobody had filed.
- **Delete the thing the fence REQUIRES, and watch it fail.** A predicate that
  ORs whole-file substrings is satisfied by any one of them, which is the trap
  the four-copies harness above hit from the other side. A STATEFUL scanner
  fails the same way without any OR: the `#N` scan flipped one `inFence` boolean
  on any ``` or `~~~` line, so a single nested fence inverted the state and
  muted every check for the rest of the file — silently, since a scanner that
  scans nothing reports nothing.
- **Derive the POPULATION from what the rule is ABOUT, not from where you first
  saw it break.** That scanner read ONE hardcoded path while the rule it
  mechanizes exists because these files are MIRRORED. Pointed at every mirrored
  agent-instruction file it went red immediately: eight bare refs across
  `.claude/skills/review-pr/SKILL.md`, `.claude/skills/cleanup/SKILL.md`,
  `.claude/rules/hooks.md` and `.claude/agents/pr-code-reviewer.md`, two of them
  numbers that resolve in cdkd to real but unrelated issues. A hand-kept root
  list is the same defect wearing a comment: the STS audit scanned three named
  directories under `src/`, so the same construction planted in
  `src/assets/docker-build.ts` was green — and that list had ALREADY been widened
  once, for `src/utils/role-arn.ts`, after the identical relapse. The sibling repo
  found four fences of this shape in one tree the same day, the sharpest deriving
  its population from the DEFECT itself, so deleting the required pattern dropped
  the subject OUT of the population instead of failing (go-to-k/cdk-real-drift#1797).

A fence is not evidence until you have watched it go red on something you had
NOT already counted — the calibration hits do not count, and neither does the
failure direction you drove with the same instances.

**A suite enumerated along ONE dimension goes green over defects that live in the
other one.** The probes above vary the SPELLING of the input. The second axis is
the STATE the subject is in when the input arrives, and it is the one that gets
enumerated by accident: every case reuses whatever fixture setup the first case
needed, so the suite covers one row of a table it never drew.

Measured here on 2026-08-27, twice in one PR (go-to-k/cdk-local#609). A commit
gate shipped 52 green cases with two live fail-opens, was fixed, and shipped 93
green cases with four more — and both times the misses were a file STATE the
fixture never entered, not a command shape nobody imagined. Every case in the
block that mattered used a file that was already staged, so the branches for an
untracked file, a tracked-but-modified file, and a file deleted on disk were
never executed. One of those branches let a NUL byte reach a commit.

What ended it was drawing the table: six file states crossed with four command
shapes, 24 cells, each an actual case. Two useful side effects. The cross-product
makes the UNCOVERED cells nameable, so the PR could list what it deliberately does
not handle (submodules, sparse-checkout, linked worktrees with a differing index,
CRLF filters, merge-conflicted paths) instead of leaving that as an assumption.
And three cells turned out to be false blocks nobody had noticed, which is a
finding a one-dimensional suite cannot produce at all.

So before trusting a green suite: name the dimensions the subject actually has,
and check the cases are a grid rather than a line.

**When the change alters a CLASSIFIER, hand-picked cases cannot fence it —
measure the DELTA against the old implementation.** A classifier is any function
deciding which of several shapes an input is: a URI-vs-path predicate, a route
selector, an error categoriser, a registry-host grammar. Its defects live in the
shapes nobody thought to write down, so a suite of chosen values goes green on
exactly the regressions that matter. Seen in the sibling repo on 2026-08-21
(go-to-k/cdkd#2001): a region-vs-stack-name predicate shipped THREE green
revisions, each fixing the case the previous review named and breaking a
neighbouring one, and every revision passed a suite that had grown a case per
round.

The fence that ends it is a differential walk: enumerate the input space, run
BOTH the new implementation and a transcription of the old one, and fail on any
difference outside an explicitly enumerated set of intended classes. That
inverts the burden — a shape nobody imagined is a failure by default rather than
a silent pass. Two ways it goes inert, both measured on that lane:

- **Classify by the resulting VALUE, not by the input's shape.** The first cut
  bucketed a differing cell by which input it was, so mutating the fix into a
  total regression left every cell inside the "intended repair" bucket and the
  fence stayed GREEN, while nine ordinary cases caught it. Each arm must assert
  what the function now returns.
- **Carry a floor per class.** The walk reaches a class only if the input pool
  contains it; one class there was real, intended and never reached, so a pool
  that quietly stops covering one would pass as "no regressions".

Get the old implementation from `git show origin/main:<path>` rather than from
memory, and confirm the two agree on the cells where they SHOULD agree before
trusting the cells where they differ. The natural subjects in this repo are the
option and override PARSERS — `parseOriginOverrides` / `parseKvsFileOverrides`
(`src/cli/commands/local-start-cloudfront.ts`), `parseLbPortOverrides`
(`local-start-alb.ts`), `parseAssumeRoleToken` and `parseContextOptions`
(`src/cli/options.ts`) — each of which accepts several spellings over a long
tail of near-misses, which is exactly the shape case-by-case tests under-cover.

**A VALUE import from a module other suites `vi.mock` reds those suites.** The
`type`-only import a module already has is invisible to the mock; adding a
runtime one is not, and the failure names the EXPORT rather than the mock
(`[vitest] No "<CONST>" export ...`), so it reads as a missing symbol in the
file you just edited rather than as a mocking problem in a suite you never
touched. When two modules must agree on a constant and one of them is widely
mocked, spell it in both and fence the pair with a test that imports both — the
sync is what matters, not the single definition.

You may fan out **one subagent per lane** (disjoint files) to run them
concurrently — give each agent its worktree path, its allowed files, and an
explicit "do NOT touch <the other lanes' / other agents' files>; STOP and report
if the fix needs a forbidden file" guardrail. Note: a subagent's Bash **bypasses
the PreToolUse gate hooks**, so it can `gh pr create` past `verify-pr-gate` —
enforce quality yourself; you (the orchestrator) still gate the MERGE via
`/merge-pr`.

**A FACT you assert to an implementing agent becomes a code comment.** This is
the orchestrator's own version of the relayed-count rule above, and it is worse,
because the agent cannot check you cheaply: it is inside one lane's files while
you are the only one holding the repo-wide view. So it writes what you said into
a JSDoc or an invariant comment, in good faith, and the claim outlives the
session.

Measured here on 2026-08-27 across one run, which produced THREE wrong
orchestrator assertions, all from verification scoped narrower than the claim:

- "there are two `RoleArn:` sends" — derived from a grep scoped to ONE file and
  reported as a repo-wide count. There are five. The agent had already written
  "one of the two places in the process where a role ARN is handed to STS" into
  `src/utils/role-arn.ts` before review caught it.
- "those two sends are safe, their values already passed `parseAssumeRoleToken`"
  — the flags are declared as plain `new Option('<flag> <arn>', …)` with no
  `argParser`, so they never reach that function. The real reason they were
  low-risk is provenance (argv, never a wire source), which is a different
  argument that survives a different set of changes.
- "count the call sites and die when derived < found" — a rule specified without
  running it against a correct fixture, where naming one base twice (deploy, then
  destroy) makes `found > derived` on a fixture with nothing wrong.

All three were caught by the agent verifying rather than obeying, and each cost a
round. Two cheap habits fix it: **derive a repo-wide claim with a repo-wide
query** (`grep -rn` over `src/`, not over the file you happen to be reading), and
when you cannot, **say the claim is unverified** so the agent checks it before
building on it rather than after.

The converse is worth stating too, because it is what made those rounds
recoverable: an agent that pushes back with a measurement is doing its job. When
one does, correct the record where the false claim landed — in the code comment,
not only in the chat — and keep the rejected version executable if you can. That
run kept the orchestrator's wrong rule as a mutation probe, killed by a case
named after the counterexample, so the decision is legible to whoever reads the
file next.

