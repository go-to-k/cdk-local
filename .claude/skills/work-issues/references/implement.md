<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One tree per lane, then implement

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

That placement is live-proven, not aspirational, and SKILL.md points here for
the evidence: on 2026-08-28 this repo's own skill-split PR
(go-to-k/cdk-local#621) was built END-TO-END by a lane subagent — worktree,
implementation, gates, reviewer dispatch, CI — with the parent doing only
claims, serialized merges and cleanup, and every hook and markgate gate fired
inside the lane's tool calls exactly as in the parent (the sibling
go-to-k/cdk-real-drift#1831 shipped the same way the same day).

**Before fixing, ask whether the defect has SIBLING SITES — and if it does, sweep
them in THIS lane rather than filing them.** Most defects here are a CLASS, not an
instance: once the root cause is named, grep for the same shape across `src/`.

**Query for the PRECONDITION minus the REMEDY, never for the remedy alone.** When
the defect is a MISSING thing, a grep for the missing thing returns only sites
that already HAVE it — broken sites are invisible by construction, so the sweep
reports itself complete while covering the never-broken half. Ask: what makes a
site ELIGIBLE, and which eligible sites lack the fix? In go-to-k/cdk-local#587's
lane (2026-08-27, root cause "a fixture leaks the Docker image it builds") the
remedy-shaped
`grep -n "docker rmi\|docker image rm\|docker image prune" tests/integration/*/verify.sh`
found five sites, all already clean. The correct query:

```bash
BUILDERS=$(grep -rl 'DockerImageFunction\|DockerImageCode\|ContainerImage.fromAsset\|fromImageAsset\|image-override\|fromDockerImageAsset' tests/integration/ \
  | awk -F/ '{print $3}' | sort -u)
for f in $BUILDERS; do
  v="tests/integration/$f/verify.sh"; [ -f "$v" ] || continue
  grep -q 'docker image rm\|docker rmi' "$v" || echo "NO CLEANUP: $f"
done
```

It returns six further fixtures, plus a seventh (`local-invoke-agentcore`,
Dockerfile-built, invisible to both queries) — filed as the
go-to-k/cdk-local#603 umbrella. The remedy query saw 5 of 12 eligible sites.

**A count derived from the instance you happened to hit is not a count.** The same
run sized the residue from the ONE instance it tripped over ("one fixture,
~30 min"); it was seven fixtures, three the heaviest in the suite — and `Effort`
/ `Estimate` are what a future session budgets a deferral from.

**N sites of one root cause is ONE issue and ONE PR, never N issues.** Split into
N, each site pays the full fixed cost (triage, claim, worktree, review, integ,
merge) for the same edit N times; swept together the cost is paid once, the
reviewer sees the whole class, and sites 2..N cannot sit open while site 1's fix
drifts. Two boundaries:

- **A sweep that would make the PR unreviewable is a genuine `next`** — file an
  umbrella naming every site, and say which sites this lane DID close.
- **Sweep the same ROOT CAUSE, not the same AREA.** Two unrelated bugs in one file
  are two issues; one wrong assumption at five call sites is one. Test: does a
  single sentence describe the fix at every site?

**A mechanical sweep is not verified by a PARSE — RUN every site you converted.**
`bash -n` and the typechecker see neither of the two ways a sweep dies at every
site at once, and both were hit in the go-to-k/cdk-local#603 lane
(go-to-k/cdk-local#667, 2026-09-02):

- **Extracting a shared helper re-verifies the CALLERS, not the helper.**
  Fixtures were converted to a sourced `tests/integration/_lib/` helper and
  EVERY converted caller then died BEFORE its first assertion: the `source`
  landed after the fixture's `cd "$(dirname "$0")"`, and `${BASH_SOURCE[0]}`
  stops resolving once cwd changes. The helper's own suite was green throughout,
  because the helper was never the broken part. In the shipped tree every caller
  sources ABOVE its `cd`, which is the fix and is what to check when adding the
  ninth: `grep -rl image-cleanup.sh tests/integration/*/verify.sh` lists the
  callers, and the `source` line must precede the `cd` line in each.
- **Order the rewrite BEFORE you introduce the construct it rewrites.** A
  `s/echo "FAIL: /fail "/` sweep is correct applied before the `fail()` helper is
  inserted, and rewrites the helper's own body into a call to ITSELF when applied
  after — unbounded recursion that parses clean.

Running all eight rather than one representative is also what surfaced two
fixtures ALREADY RED on `main` (go-to-k/cdk-local#659 / go-to-k/cdk-local#660,
both `severity:high`) — a worked instance of go-to-k/cdk-local#594: nothing runs
these fixtures, so one stays red indefinitely. **A red fixture is not evidence
about your lane until you have ATTRIBUTED it**: re-run it on a stashed / clean
tree and compare the failure SIGNATURE, not the exit code. Identical both ways =
pre-existing, so the lane says so in the PR body, files, and proceeds; different
= yours, and the lane stops. Skipping the attribution costs a lane either way —
blocked on someone else's red, or shipped on top of it.

**A COUNT is a claim, and one RELAYED from a subagent is unearned.** Paste the
deriving command beside every published number. The tell is grammatical: a number
arriving as a WORD ("nine sites") was counted by a person or agent; command
output, by a machine. Before a relayed count goes anywhere durable (issue body,
PR body, changelog, this file), run the query yourself. Measured in cdkd
(2026-08-26): FOUR relayed counts published in one run, all wrong ("all nine
sibling sites" was 78 across 14 files by grep), the first under-scoping by ~9x
the deferral it justified.

**Re-derive at the FINAL sha, not at the round that produced the number.** A count
is correct when a round reports it and stale by the PR body — the body is written
once, the branch keeps moving, and the durable artifact is the diff being merged.
Derive every published count in the same pass that writes the body, from the
branch about to merge. Measured here (2026-08-27): FOUR published counts, each
accurate for its round and wrong against the merged branch — e.g. "52 -> 93
cases" for a file NEW on the branch (against `main`: 0 -> 118); three needed
patching after review.

**And whatever you do file, resolve it against the issues ALREADY OPEN first.**
The code sweep finds sibling SITES; this finds a sibling ISSUE — written from a
different angle, naming a different section. §10-c's rigorous three-window
version (merged file, open PRs, open issues) covers only mirrored skill LESSONS
— exactly where this repo's duplicates come from. What this solves here is not
backlog convergence (2026-08-26: 8 open issues — go-to-k/cdk-local#560 /
go-to-k/cdk-local#561 / go-to-k/cdk-local#564 `next`, umbrella
go-to-k/cdk-local#281 with phases go-to-k/cdk-local#286 /
go-to-k/cdk-local#287 / go-to-k/cdk-local#288 parked) but a
duplicate GENERATOR, two measured pairs out of 145 filed: go-to-k/cdk-local#528
/ go-to-k/cdk-local#531 (**eight minutes apart**, 2026-08-19, subset lessons,
both closed by one PR go-to-k/cdk-local#532; go-to-k/cdk-local#528's body
records a FILE check and an open-PR scan of go-to-k/cdk-local#523 /
go-to-k/cdk-local#526) and go-to-k/cdk-local#504 / go-to-k/cdk-local#511
(**75 minutes apart**, same target section, no windows recorded). **Not one of
the four bodies records an open-ISSUE search** — the single window that would
have caught either pair.

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
truncates `$U` before `gh` runs, so an unchained recipe whose `view` fails (wrong
number, non-repo cwd, transient error) leaves an empty file the `printf` fills
with the one new row, and the `edit` replaces the issue's WHOLE body with it —
destroying every previously folded finding, the outcome §10-0 forbids. `mktemp`
for the same reason at another scale: parallel lanes share the scratchpad, and an
uncontrolled read-modify-write loses a row when two folds overlap — never run two
folds against the same issue concurrently.

On a MISS — the expected outcome for a genuinely new root cause — file it, and
record the search in the body so the next hop can see the window was checked:

```text
Dup-check: searched open issues for <terms> -- none covers this root cause
```

**File it with its `Severity` / `Effort` values ALSO as labels** -- the body
lines stay exactly as written, and the same two values ride the command as
`--label severity:<high|medium|low> --label effort:<small|medium|large>`:

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
Session-fit: next (not this session) -- <reason>
Severity: high -- <what stays broken while it is undone>
Effort: large (L) -- <which verification cycle it drags>
Estimate: ~3 h+ -- <what eats the time>
BODY
gh issue create -t 'fix(local): ...' \
  --body-file /tmp/wi-issue-body-<issue-slug>.md \
  --label severity:high --label effort:large
```

**The path is LITERAL because a `$VAR` one cannot be filed at all.**
`issue-dup-check-gate.sh` reads the command TEXT at PreToolUse time, before any
of it has run, and refuses a `--body-file` path containing `$` or a backtick
outright: it cannot open such a file to look for the `Dup-check:` line, and it
fails closed rather than guessing. Measured 2026-08-31 by driving the hook with
each payload: the `B=$(mktemp)` + `--body-file "$B"` spelling this section used
to print returns **rc=2 in all three repos** (cdk-local, cdkd, cdk-real-drift),
so the body it so carefully writes is never filed; the literal-path form above
returns **rc=0** from both gates that see it here (`issue-dup-check-gate.sh` and
`issue-classification-label-gate.sh`). Deleting just the `Dup-check:` line from
the literal form returns rc=2 again, so that rc=0 is the gate passing a good
command, not the gate failing to look.

**The FOLD recipe above keeps `mktemp`, and that asymmetry is the gate set, not
taste.** Folding runs `gh issue edit`, which `issue-dup-check-gate.sh` does not
match at all, and the classification gate falls back to reading the command text
when a path is unresolvable — measured rc=0 from both, same day, same driver.
Folding also NEEDS a unique file it reads back; minting only needs a name no
concurrent lane will reuse, which the substituted slug gives.

The `cat` is load-bearing, not filler: an empty file pointed at by
`--body-file` files an issue with NO body — no `Dup-check:` line, no
classification — and that spelling is refused for the reason you would expect
("carries no `Dup-check:` line") rather than for the path. Write the body; do
not treat the gate as the thing that will notice. `heredoc -> file ->
--body-file` in one call is the mandated shape here, with the delimiter QUOTED
so backticks and `$` in the body stay literal instead of running.

Prose is invisible to `gh issue list`, so ranking by `Severity` costs one
`gh issue view` per candidate without labels. Only these two get labels:
`Session-fit` is re-decided at claim (a stale label is worse than none),
`Estimate` is free-form. The claim rewrites an old packed body into the
four-line shape — `Severity`'s first existence for most of the backlog — so
carry `--add-label` on that `gh issue edit`. Enforced by
`.claude/hooks/issue-classification-label-gate.sh`; the lane's PR inherits the
labels via `.github/workflows/pr-inherit-issue-labels.yml` — never hand-add
them.

**This is not a filing threshold, and it must never be used as one.** §10-0:
`filed <= closed` is not a target; an unfiled finding is strictly worse than a
filed one. Nothing here changes WHETHER a defect gets written down; only WHERE.

Enforced by `.claude/hooks/issue-dup-check-gate.sh`, which refuses
`gh issue create` — and `gh api repos/<o>/<r>/issues`, the REST verb that mints
one — without the `Dup-check:` line. `gh issue edit` / `gh issue comment` are
deliberately NOT gated: folding is the steered-toward outcome, and it is not
CHEAPER than minting (three commands vs one) — the gate makes minting non-free,
not folding free. Two consequences: a folded row carries no `Session-fit` /
`Severity` (§3's ranking cannot see it — write the severity into the row's
text), and `gh issue edit` is NOT among `pr-body-item-number-gate.sh`'s verbs
(`create` and `comment` only), so a folded row is the ONE issue-body path with
no `#N` auto-link check — write `go-to-k/<repo>#N` yourself. The gate exists
because this section's rule, already written and correct, stopped neither pair
above. Registration is not execution.

**Before writing `Session-fit: next`, NAME the command the next session will run
to verify the fix -- and say that a fresh session will be able to run it.** A
deferral is a PREDICTION that a later session can finish the work; unstated, it
is never checked, and the classification decays into naming the KIND of work ("a
fixture / base-image change") — MEANS instead of purpose (the four fields make a
deferral HONEST, not available — `.claude/CLAUDE.md`). No trigger list catches
it — the next miss arrives in a shape the list lacks — so the check is
GENERATIVE: not "run the integ" but
`/run-integ local-start-api-websocket`; not "add a test" but the assertion that
goes red to green (`vp test run tests/unit/local/<file>.test.ts`). When naming
the command is hard, that difficulty IS the finding, usually one of:

- **The verifier is bound to THIS host.** 53 of 58 integ fixtures drive a real
  Docker daemon (measured 2026-08-26,
  `grep -l docker tests/integration/*/verify.sh | wc -l`): CPU architecture,
  resolved image platform, daemon version (`probeHostGatewaySupport` gates
  `host-gateway` on Docker >= 20.10) and BuildKit behaviour are part of the
  verifier and none travels with the issue.
- **The verifier is bound to THIS account.** A `*-from-cfn-stack` fixture's
  `verify.sh` calls the upstream `cdk deploy` — why `/run-integ` pre-flights
  `which cdk` and `aws sts get-caller-identity` for those fixtures.
- **The verifier does not exist yet**, and writing it is most of the work — the
  one case where `next` is genuinely right, BECAUSE you could name what is
  missing.
- **You cannot name it at all** — then nobody can confirm the fix later either;
  not a deferral but an unbounded one.

Measured 2026-08-26: go-to-k/cdk-local#560 was filed `next` on "a fixture /
base-image change, on a different axis" — a CATEGORY statement. The defect is a
Go RIE fault under `linux/amd64` emulation and the issue's own evidence records
`uname -m` = `arm64` on the filing machine, so the verification is
`/run-integ local-start-api` + `/run-integ local-start-api-websocket` ON AN
arm64 HOST, which nothing guarantees a fresh session has. Worse: a fixture with
no `Architectures` resolves to `x86_64` at `--platform linux/amd64` (defaults
in `src/cli/commands/local-start-api.ts` / `src/local/container-pool.ts`), so
an amd64 host runs it natively, never reaching the emulated path — silent about
the fault. Review caught the misclassification; nothing in this flow did.

**Then ask what the next session will have to RE-DERIVE.** The question above
names the verification; this one names the cost of the gap between now and it.
If you can point at something that exists only in THIS session — a table you
measured, a probe you built, a shape you just proved correct in a sibling repo —
the deferral is not free and the answer is `now`. Understanding survives in an
issue body; a measurement does not, and neither does a fix whose correctness you
established once and would have to establish again.

**And "it needs its own PR" is NOT a `next` reason.** It is a `now` item that
gets its own PR. The bar is the SESSION, not the diff — a separate review
surface, a new file, a hook plus its suite plus its registration are all good
reasons to split the PR and none of them is a reason to end the session.
Writing "independent review surface" on a `Session-fit` line is the
classify-by-MEANS error this section already forbids, arriving through the PR
boundary instead of through the work's category.

(2026-09-01: a hook missing from one sibling was filed `next` on exactly that
wording — minutes after the same hook's two-directional defect had been
measured and fixed in the other two repos. The probe, the corrected shape and
the rc table were all in hand, and a later session would have re-derived all
three. Re-classified `now` in the same session on the maintainer's challenge,
and shipped; the port then found four more defects in the shape it was copying,
none of which a fresh session would have known to look for.)
**And when the issue body offers more than one fix, say which one the four
fields cost.** Cost the CHEAPEST one you would actually accept. A deferral
justified by the expensive option is not a measurement, it is a choice of
comparand -- and the fields are supposed to be the measurement.

(2026-09-02, an hour after the paragraph above went in: an issue was filed
listing two fixes -- block the spelling in the gate that let the tree detach, a
behaviour change across three repos, or teach the OTHER gate to recognise a
detached HEAD, about six lines and no behaviour change. The `Session-fit: next`
reason read "a behaviour change across three repos with its own review surface",
which costs only the first. Nobody had decided which fix to take; the first one
described became the one measured.)

**The converse is the honest use of `next`, and it costs one line.** When you CAN
name the verification and a fresh session plainly has it (an existing `local-*`
fixture needing only Docker, a `vp test run <path>` assertion, an ordinary `gh`
query), the deferral is sound — put the line in the issue body beside
`Session-fit`.

Never edit in the main checkout (`main-tree-branch-gate.sh` blocks branch creation
there — with the coverage limit measured below). Per lane:

```bash
# MAIN-CHECKOUT mode only (`references/launch-mode.md` holds the probe, and
# calls itself its ONLY copy). An IN-PLACE run skips these two lines and creates
# no WORKTREE: a nested one dies with the outer workspace, taking its
# uncommitted work (go-to-k/cdk-local#635). It DOES take a branch, in place --
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
merged); go-to-k/cdkd#2417 made it unconditional. The branch the tree arrived on
is `LAUNCH_BRANCH` — the OUTER TOOL's, not this run's — and this repo has
`delete_branch_on_merge`, so a lane that opened its PR from it would delete the
outer tool's remote branch on the way out. Never commit onto it; §9 switches
back to it untouched as the run's last step. `references/launch-mode.md`'s
consequence table (row 4) is the normative statement, and it is the file an
IN-PLACE lane is dispatched to read alongside this one.

```bash
git fetch origin && git switch -c <branch> origin/main
```

The `&&` is deliberate: unchained, a failed `fetch` still branches, off a stale
`origin/main`. `main-tree-branch-gate.sh` backstops running that line after a cwd
reset: it matches in COMMAND POSITION and judges the MATCHED SEGMENT, so the
CHAINED form this file prints is refused from the main checkout — driven with a
synthesized payload on 2026-09-02, `git fetch origin && git switch -c <b>
origin/main` and `git status && git checkout -b <b>` both rc=2, while
`git fetch origin && git switch main` and the same chain from a LINKED worktree
stay rc=0. That coverage is recent (go-to-k/cdk-local#641, merged 2026-09-02);
before it the gate read the chain as `sub=fetch` and exited 0, so the spelling
this file prescribes was the one it missed, and this block carried a
re-run-`rev-parse`-first anchor until then. Ask whether the coverage is still on
`main` by CONTENT, never by the last commit subject on the file:

```bash
git show origin/main:.claude/hooks/main-tree-branch-gate.sh | grep -c gate_verb_args
```

`gate_verb_args` strips the verb off the MATCHED segment, so it exists only in
the fixed copy: non-zero means the coverage is there (5 on 2026-09-02), and `0`
means it is gone and the manual anchor is owed again.

**Build BEFORE the first test run, and read a fresh worktree's failures with that
in mind.** A worktree starts with no `dist/`; any test spawning the built CLI
fails on the missing binary with an assertion message about its SUBJECT. Integ
fixtures resolve `node ../../../dist/cli.js` (why `/run-integ` builds first),
but a UNIT suite can be exposed too: in go-to-k/cdk-real-drift (2026-08-27) a
docs-only lane saw 13 failures in a CLI exit-code suite (`expected 1 to be 2`),
reproduced them with its edit stashed, and had begun writing up "a peer merge
broke main" — one `vp run build` turned them green. **A fresh worktree failing
where the main checkout passes is evidence about the WORKTREE first.**

Do the fix in the lane's tree (match the existing module/pattern exactly; ESM
relative imports need the `.js` extension even in TS source). **Always add a test
that fails without the fix and passes with it** — usually a unit test:
`tests/unit/**` mirrors `src/**`, external boundaries (toolkit-lib, docker CLI,
AWS SDK) mocked with `vi.mock` / `vi.hoisted`. **Check first whether the
artifact already has its own harness** — it will not be under `tests/unit/**`: a
`.claude/hooks/**` fix is covered by a bash smoke test beside the hook
(`.claude/hooks/pr-review-gate.test.sh`, run by `vp run test:hooks`, in CI) —
look for a sibling `*.test.sh` before writing a new harness.

**When the issue reports a stale ENTRY in an enumerated list, audit the whole
list, in both directions, before fixing the named entry.** Drift never produces
exactly the one instance someone noticed: check that every entry resolves AND
that everything that belongs is present — the second half gets skipped because
the issue only names the first. go-to-k/cdkd#1972 (2026-08-19): one reported
dead path; the audit found a second plus four live authn / credential / exec
surfaces never added. Here, go-to-k/cdk-local#506: `/review-pr`'s up-bias path
list is written FOUR times (`UP_PATHS` in `.claude/hooks/pr-review-gate.sh`,
`.claude/skills/review-pr/SKILL.md`, `.claude/rules/hooks.md`,
`.claude/agents/pr-code-reviewer.md`) — audit every copy; the first draft of
this rule said "three" and missed the reviewer-agent copy, the one already out
of sync. Then make the recurrence mechanical: a sync-required list is a test
asserting every entry resolves and the copies agree (shipped in
`.claude/hooks/pr-review-gate.test.sh`), not a sentence asking the next reader
to remember. Writing it surfaced a trap: the first draft compared copies as
SORTED SETS, and an evidence sentence naming a dropped path put it back into
the extracted set, so deleting the entry still passed — **compare in document
order with duplicates preserved, and keep path names out of prose inside the
extracted region**. Run the backward direction too, with a subagent if the
surface is wide: the issue named 7 missing paths; a sweep of `src/**` found ~18
more (the authorizer ENFORCEMENT points, not just the verifiers).

**When the fix mechanizes a rule as a repo-wide SCANNER test, calibrate the
detection rule against the PRE-FIX broken tree — do not implement the issue's
signature literally.** An issue describes the signature as its author noticed
ONE instance, with no measured false-positive rate. Run the candidate rule over
the unrepaired tree and read every hit: in go-to-k/cdk-real-drift#1771 ->
go-to-k/cdk-real-drift#1782 (2026-08-19) the proposed signature flagged ~30
spots, mostly idiomatic prose; measuring on the broken tree yielded a
zero-false-positive rule still catching all 12 real hits. One markdown trap: a
code span may WRAP a line break — tokenize per PARAGRAPH, or scan per line and
ENFORCE the single-line-span convention in the test (as
`tests/unit/skills/work-issues-skill-refs.test.ts` does; an undecided per-line
scan pairs one span's closer with the next one's opener and invents findings).
Report the HIT's own line number, not the paragraph start — the consumer is
someone jumping to it.

**Calibrating on the broken tree proves the rule is not NOISY — not that it is
load-bearing.** It measures precision and recall over instances that HAPPEN TO
EXIST; unused spellings and exemption-defeating contexts stay untested. Probes
to close that, run against the real tree — on 2026-08-20 (go-to-k/cdk-local#537)
the first two both went red against this repo's own
`tests/unit/skills/work-issues-skill-refs.test.ts`:

- **Write the defect in EVERY spelling the language allows, and confirm each one
  is flagged.** That scanner ("no word character before the `#`") flagged bare
  `#5` but passed both half-qualified spellings — `cdk-local#5` and `go-to-k#5`
  — neither of which GitHub autolinks. Worse for
  `tests/unit/cli/sts-client-profile-audit.test.ts` (subject: credentials): it
  matched the literal `new STSClient(` and passed the aliased
  `const { STSClient: STS } = await import(…)` — already used at ten sites
  across seven files — plus a pre-paren space, `mod.STSClient`, and
  `new (await import(…)).STSClient(…)`. go-to-k/cdkd#2111, same shape: a region
  scanner calibrated at 19 hits / zero false positives matched `||` only while
  the tree used `??` at four sites; widening it surfaced a real unfiled bug.

  **But when round three is still ADDING spellings, the instrument is wrong —
  change it rather than write a better pattern.** Measured 2026-08-29 in three
  repos at once, one defect class in a hand-rolled `.markgate.yml` reader.
  go-to-k/cdkd#2383 tallies its own run as **four spellings across four rounds,
  each patch moving the hole rather than closing it** — block items only, so a
  FLOW list passed; then a quoted key; then a multi-line flow list; then a
  merge key (`<<: *anchor`) splicing an `exclude` declared on a SIBLING gate,
  which the raw-text tripwire added as that very backstop did not fire on. This
  repo's own two were different again (go-to-k/cdk-local#631): single-quoted
  and bare scalars, then a block sequence indented at the PARENT key's column,
  which a reviewer used to hide three dead globs from a 9/9 green run. Same
  shape, different spellings — which is the point. **Three spellings in three
  rounds is the signal to stop patterning.** Two shapes end
  it and neither is a sixth pattern: parse the config with a REAL parser (a
  third-party, versioned library is not the fence checking its own work),
  ALLOW-LIST the tool's own keys, fail CLOSED outside them, and raw-scan the
  whole map; or, as here — this repo declares no YAML dependency and adding one
  so a single fence can read a single config is the worse trade — REFUSE every
  shape the reader cannot model, which is the STRICTER option, not the weaker
  one: an unmodelled shape stops the fence instead of passing through it.
  `tests/unit/gates/markgate-include-globs.test.ts` is the worked example, and
  it then held against every respelling its reviewers could construct.
- **Delete the thing the fence REQUIRES, and watch it fail.** A predicate ORing
  whole-file substrings is satisfied by any one of them. A STATEFUL scanner
  fails the same way without any OR: the `#N` scan flipped one `inFence` boolean
  on any ``` or `~~~` line, so a single nested fence inverted the state and
  muted every check for the rest of the file — silently, since a scanner that
  scans nothing reports nothing.
- **Derive the POPULATION from what the rule is ABOUT, not from where you first
  saw it break.** That scanner read ONE hardcoded path while the rule exists
  because the files are MIRRORED; pointed at every mirrored agent-instruction
  file it went red immediately (eight bare refs across four files, two resolving
  in cdkd to real but unrelated issues). A hand-kept root list is the same
  defect wearing a comment: the STS audit scanned three named directories under
  `src/`, so the same construction in `src/assets/docker-build.ts` was green —
  a list ALREADY widened once (`src/utils/role-arn.ts`) after the identical
  relapse. The sharpest fence derives its population from the DEFECT itself, so
  deleting the required pattern drops the subject OUT of the population instead
  of failing (go-to-k/cdk-real-drift#1797).

**A fence is not evidence until you have watched it go red on something you had
NOT already counted** — calibration hits do not count, nor the failure direction
driven with the same instances.

**A suite enumerated along ONE dimension goes green over defects that live in
the other one.** The probes above vary the SPELLING of the input; the second
axis is the STATE the subject is in when it arrives, enumerated by accident —
every case reuses the first case's fixture setup, covering one row of a table
never drawn. Measured twice in one PR (go-to-k/cdk-local#609, 2026-08-27): a
commit gate shipped 52 green cases with two live fail-opens, then 93 green with
four more — both times the miss was a file STATE the fixture never entered
(every case used an already-staged file; untracked / modified / deleted-on-disk
branches never ran, and one let a NUL byte reach a commit). What ended it was
drawing the table: six file states x four command shapes, 24 cells, each an
actual case. Two side effects: UNCOVERED cells become nameable (the PR could
list what it deliberately does not handle — submodules, sparse-checkout, CRLF
filters, merge-conflicted paths), and three cells were false blocks — a finding
a one-dimensional suite cannot produce. So: name the subject's dimensions and
check the cases are a grid, not a line.

**When the change alters a CLASSIFIER, hand-picked cases cannot fence it —
measure the DELTA against the old implementation.** A classifier is any function
deciding which of several shapes an input is (a URI-vs-path predicate, an error
categoriser, a registry-host grammar); its defects live in shapes nobody wrote
down. In go-to-k/cdkd#2001 (2026-08-21) a region-vs-stack-name predicate
shipped THREE green revisions, each fixing the named case and breaking a
neighbouring one, each passing a suite that grew a case per round. The fence is
a differential walk: enumerate the input space, run BOTH the new implementation
and a transcription of the old one, and fail on any difference outside an
explicitly enumerated set of intended classes — an unimagined shape becomes a
failure by default. Two ways it goes inert, both measured on that lane:

- **Classify by the resulting VALUE, not by the input's shape.** The first cut
  bucketed a differing cell by which input it was, so mutating the fix into a
  total regression left every cell in the "intended repair" bucket and the fence
  stayed GREEN while nine ordinary cases caught it. Each arm must assert what
  the function now returns.
- **Carry a floor per class.** The walk reaches a class only if the input pool
  contains it; one real intended class was never reached, so a pool quietly
  dropping one would pass as "no regressions".

Get the old implementation from `git show origin/main:<path>`, not memory, and
confirm the two agree where they SHOULD agree before trusting where they differ.
Natural subjects here: the option and override parsers — `parseOriginOverrides`
/ `parseKvsFileOverrides` (`src/cli/commands/local-start-cloudfront.ts`),
`parseLbPortOverrides` (`local-start-alb.ts`), `parseAssumeRoleToken` /
`parseContextOptions` (`src/cli/options.ts`) — each accepting several spellings
over a long tail of near-misses.

**A VALUE import from a module other suites `vi.mock` reds those suites.** The
`type`-only import a module already has is invisible to the mock; a runtime one
is not, and the failure names the EXPORT (`[vitest] No "<CONST>" export ...`),
reading as a missing symbol in the file you edited rather than a mocking problem
in a suite you never touched. When two modules must agree on a constant and one
is widely mocked, spell it in both and fence the pair with a test importing both
— the sync is what matters, not the single definition.

You may fan out **one subagent per lane** (disjoint files) to run them
concurrently — give each its worktree path, its allowed files, and an explicit
"do NOT touch <the other lanes' files>; STOP and report if the fix needs a
forbidden file" guardrail. A subagent's Bash **bypasses the PreToolUse gate
hooks**, so it can `gh pr create` past `verify-pr-gate` — enforce quality
yourself; you (the orchestrator) still gate the MERGE via `/merge-pr`.

**A FACT you assert to an implementing agent becomes a code comment.** The
orchestrator's version of the relayed-count rule, and worse: the agent cannot
check you cheaply (it is inside one lane; you hold the repo-wide view), so it
writes your claim into a JSDoc or invariant comment in good faith and the claim
outlives the session. Measured here (2026-08-27): THREE wrong assertions in one
run, all from verification scoped narrower than the claim — "two `RoleArn:`
sends" (a one-file grep reported repo-wide; there are five, already written into
`src/utils/role-arn.ts` by the agent); "those sends already passed
`parseAssumeRoleToken`" (the flags have no `argParser`, so they never reach it —
the real safety was provenance — argv, never a wire source — a different argument); a
die-when-`derived < found` rule never run against a correct fixture (naming one
base twice makes `found > derived` with nothing wrong). All three were caught by
the agent verifying rather than obeying; each cost a round. Two habits: **derive
a repo-wide claim with a repo-wide query** (`grep -rn` over `src/`, not the file
you happen to be reading), and when you cannot, **say the claim is unverified**
so the agent checks before building on it. The converse made those rounds
recoverable: an agent pushing back with a measurement is doing its job — correct
the record where the false claim landed (the code comment, not only the chat),
and keep the rejected version executable if you can (that run kept the wrong
rule as a mutation probe, killed by a case named after the counterexample).
