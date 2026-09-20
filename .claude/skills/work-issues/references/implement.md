<!-- Part of the /work-issues skill (§5). A bare §N points into the stage file holding that section; the map is SKILL.md's "Stages" table. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One tree per lane, then implement

This stage (and §6–§8) normally runs INSIDE a lane subagent — one
general-purpose agent per claimed issue, so the lane's diffs, test output and
review round-trips never land in the parent context. Two actions belong to the
parent's serialization turn and are NOT the lane's to start: a Docker-side run
(`/run-integ`, and the `/create-integ` run a new fixture needs before
`gh pr create`) and the merge (`/merge-pr`). Ask the parent for that Docker
turn mid-lane; otherwise stop at merge-ready and report.

### 5-a. Sweep the class, not the instance

**Before fixing, ask whether the defect has SIBLING SITES — and if it does,
sweep them in THIS lane rather than filing them.** Once the root cause is
named, grep for the same shape across `src/`; when the report is a stale ENTRY
in an enumerated list, audit the whole list, both directions, and every COPY of
it.

- **Query for the PRECONDITION minus the REMEDY, never for the remedy alone.**
  When the defect is a MISSING thing, a grep for the missing thing returns only
  sites that already HAVE it — broken sites are invisible by construction. Ask
  what makes a site ELIGIBLE, then which eligible sites lack the fix:

  ```bash
  # eligible = fixtures that BUILD an image; broken = those with no cleanup
  for f in $(grep -rl 'DockerImage\|fromAsset\|image-override' tests/integration/ \
               | awk -F/ '{print $3}' | sort -u); do
    v="tests/integration/$f/verify.sh"; [ -f "$v" ] || continue
    grep -q 'docker image rm\|docker rmi' "$v" || echo "NO CLEANUP: $f"
  done
  ```

- **A published number is a claim**: run the deriving query yourself rather
  than relaying a subagent's count, and re-derive it at the FINAL sha.
- **N sites of one root cause is ONE issue and ONE PR, never N issues.** Two
  boundaries: a residue waiting on EXTERNAL INPUT is a genuine `next`
  (`.claude/rules/session-report.md`'s reason (a), the only one a residue can
  take) — file an umbrella naming every site, and which ones this lane
  closed; and sweep the same ROOT CAUSE, not the same AREA — the test is
  whether one sentence describes the fix at every site. Review size is a signal
  that a sweep is too big, never by itself the deferral reason.
- **A mechanical sweep is not verified by a PARSE — RUN every site you
  converted.** `bash -n` misses the two ways a sweep dies at every site at
  once: a shared helper is re-verified only through its CALLERS
  (`${BASH_SOURCE[0]}` stops resolving once cwd changes, so every caller must
  `source` ABOVE its `cd "$(dirname "$0")"`), and a rewrite applied after the
  construct it rewrites exists rewrites that construct's own body (an
  `s/echo "FAIL: /fail "/` sweep turns `fail()` into a call to itself).
- **A red fixture is not evidence about your lane until you have ATTRIBUTED
  it**: re-run on a clean tree and compare the failure SIGNATURE, not the exit
  code. Identical both ways = pre-existing (say so in the PR body, file it,
  proceed); different = yours, stop.

### 5-b. Resolve a finding against the issues ALREADY OPEN, then file

The code sweep finds sibling SITES; this finds a sibling ISSUE, written from
another angle. Search before filing:

```bash
# Search the CONCEPT, not this instance's spelling.
gh issue list --state open --limit 200 --search '<root-cause concept>' \
  --json number,title
# Then the body window the search index misses. `(.body // "")`, not `.body`:
# one body-less issue would abort the whole jq program and cost the window.
gh issue list --state open --limit 200 --json number,title,body \
  --jq '.[] | select((.body // "") | test("<shared symbol / call / assumption>";"i"))
        | "\(.number)\t\(.title)"'
```

On a HIT the finding becomes a CHECKLIST ROW in that issue, not a new number:

```bash
U=$(mktemp)   # not a fixed /tmp path: parallel lanes share the scratchpad
gh issue view <hit> --json body -q .body > "$U" \
  && [ -s "$U" ] \
  && printf -- '- [ ] <site>: <one line, plus where the evidence is>\n' >> "$U" \
  && gh issue edit <hit> --body-file "$U"
```

**The chaining and the `-s` test are load-bearing.** The redirect truncates
`$U` before `gh` runs, so an unchained recipe whose `view` fails leaves an
empty file the `printf` fills with the new row, and the `edit` then replaces
the issue's WHOLE body with it. Never fold twice at once.

On a MISS — the expected outcome for a new root cause — file it, with its
`Severity` / `Effort` values **ALSO as labels**:

```bash
B=$(mktemp)
cat > "$B" <<'BODY'
<one paragraph: the root cause, and where the evidence for it is>

Session-fit: next (not this session) -- <reason the WORK owns -- .claude/rules/session-report.md>
Severity: high -- <what stays broken while it is undone>
Effort: large (L) -- <which verification cycle it drags>
Estimate: ~3 h+ -- <what eats the time>
BODY
gh issue create -t 'fix(local): ...' --body-file "$B" \
  --label severity:high --label effort:large
```

Quote the heredoc delimiter so backticks and `$` stay literal. Prose is
invisible to `gh issue list`, which is why `Severity` / `Effort` ride as labels
too; `Session-fit` is re-decided at claim and `Estimate` is free-form. The PR
inherits the labels via `.github/workflows/pr-inherit-issue-labels.yml` — do
not hand-add them.

**Folding is not a filing threshold** — it changes only WHERE a defect is
written down (§10-0: an unfiled finding is worse than a filed one). A folded
row carries no `Session-fit` / `Severity`: put the severity in the row's text,
and write cross-references as `go-to-k/<repo>#N`.

### 5-c. `Session-fit: next` must NAME the next session's verification

**`now` is the default; `next` needs one of the two reasons
`.claude/rules/session-report.md` enumerates** (external input / COLD AND
HEAVY). Once external input is excluded the CONTEXT TEST decides: list the
files the fix touches or must read; if this session read, edited or reviewed
ANY of them it is `now` — as is anything that compounds if left loose (an integ
fixture the fix still needs is written HERE, while the subsystem is loaded).

**Before writing `Session-fit: next`, NAME the command the next session will
run to verify the fix — and say a fresh session will be able to run it.** The
check is GENERATIVE: not "run the integ" but
`/run-integ local-start-api-websocket`; not "add a test" but the assertion
going red to green (`vp test run tests/unit/local/<file>.test.ts`). A CATEGORY
statement ("a fixture / base-image change") is not a named command. When naming
it is hard, that difficulty IS the finding: the verifier is bound to THIS host
(most integ fixtures drive a real Docker daemon, whose architecture, resolved
image platform and version are part of the verifier), or to THIS account (a
`*-from-cfn-stack` fixture's `verify.sh` calls the upstream `cdk deploy`), or
it does not exist yet and writing it is most of the work (write it NOW, while
the subsystem is loaded), or you cannot name it at all — an unbounded deferral.
Same for what the next session must RE-DERIVE: if the fix rests on something
built here, `now`.

"It needs its own PR" is NOT a `next` reason — that is a `now` item which gets
its own PR. A reason about THIS SESSION's state is legal only as the EXPIRY
event of a `next` reason ("held by another open PR's diff" is reason (a),
ending at that merge; "no integ run budgeted here" is not a reason), and must
name the event that ends it on the same line.

### 5-d. The lane's tree

Never edit in the main checkout. Per lane:

```bash
# MAIN-CHECKOUT mode only (`references/launch-mode.md` holds the probe). An
# IN-PLACE run creates no WORKTREE -- a nested one dies with the outer
# workspace, taking its uncommitted work -- and branches by the recipe below.
# The setup lines still apply there: an adopted workspace may lack them.
git worktree add .claude/worktrees/<name> -b <branch> origin/main
cd .claude/worktrees/<name>
mise trust && mise install   # a fresh worktree's .mise.toml is untrusted: no vp
pnpm install    # worktrees have no node_modules; nor may the MAIN checkout
vp run build    # ...and no dist/; see below
```

**IN-PLACE: take a fresh branch here, ALWAYS, and WITHOUT leaving the tree.**
The branch the tree arrived on is `LAUNCH_BRANCH` — the OUTER TOOL's — and this
repo has `delete_branch_on_merge`, so a lane that opened its PR from it would
delete the outer tool's remote branch on the way out. Never commit onto it; §9
switches back to it untouched as the run's last step.

```bash
git fetch origin && git switch -c <branch> origin/main
```

The `&&` is deliberate: unchained, a failed `fetch` still branches, off a
stale `origin/main`.

**Build BEFORE the first test run.** A worktree starts with no `dist/`, and a
test spawning the built CLI then fails with an assertion message about its
SUBJECT, reading as a broken `main`. **A fresh worktree failing where the main
checkout passes is evidence about the WORKTREE first.**

### 5-e. The fix and its test

Do the fix in the lane's tree (match the existing module/pattern exactly; ESM
relative imports need the `.js` extension even in TS source). **Always add a
test that fails without the fix and passes with it**: `tests/unit/**` mirrors
`src/**`, with external boundaries (toolkit-lib, docker CLI, AWS SDK) mocked
via `vi.mock` / `vi.hoisted`. A `.claude/hooks/**` fix belongs in the bash
smoke test beside the hook (`vp run test:hooks`, in CI).

- **An assertion's EXEMPTION is an unproved claim about the SUBJECT that only
  the TEST's shape justified.** Assert the whole class per message so nothing
  needs exempting, assert the VALUE (`out === input` is blind wherever the
  subject maps a value to itself), and keep the expected value an INDEPENDENT
  variable from the one under test (`references/verify.md` §8-z sends you
  here). The other axis is the STATE the subject arrives in, enumerated by
  accident when every case reuses the first case's setup.
- **When the change alters a CLASSIFIER (`parseOriginOverrides`,
  `parseLbPortOverrides`, `parseContextOptions` and peers), hand-picked cases
  cannot fence it — walk the DELTA against the old implementation.** Run the
  new one and a transcription of the old (`git show origin/main:<path>`, not
  memory) over the enumerated input space, failing on any difference outside an
  enumerated set of intended classes. Bucket by the resulting VALUE, not the
  input's shape, and carry a floor per class — a pool dropping a class
  otherwise passes as "no regressions".
- **A VALUE import from a module other suites `vi.mock` reds those suites.**
  The `type`-only import is invisible to the mock; a runtime one is not, and
  the failure names the EXPORT (`[vitest] No "<CONST>" export ...`) — reading
  as a missing symbol in the file you edited.

### 5-f. Fan-out and what you tell the agents

You may fan out **one subagent per lane** (disjoint files) — give each its
worktree path, its allowed files, and an explicit "do NOT touch <the other
lanes' files>; STOP and report if the fix needs a forbidden file" guardrail. A
lane can open a PR without you seeing the diff, so enforce quality yourself;
the orchestrator still owns the MERGE via `/merge-pr`.

**A FACT you assert to an implementing agent becomes a code comment**, written
in good faith and outliving the session — the recurring cause being
verification scoped narrower than the claim (a one-file grep reported
repo-wide). **Derive a repo-wide claim with a repo-wide query**, and when you
cannot, **say the claim is unverified**. When an agent pushes back with a
measurement, correct the record where the false claim landed, not only the
chat.
