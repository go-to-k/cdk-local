# Hooks and Gates

Reference for the `.claude/hooks/*.sh` PreToolUse safety + enforcement
hooks shipped in cdk-local. Auto-loaded when working on
`.claude/hooks/**` or `.markgate.yml`.

The hooks split into three classes:

1. **Universal-shape one-shot safety hooks** — block known foot-guns
   at the source. Each produces an actionable error with the exact
   replacement command.
2. **Branch / push safety** — keep feature work off the main worktree
   and the main branch.
3. **Markgate-backed gates** — block `git commit` / `gh pr create` /
   `gh pr merge` when the matching markgate marker is stale, forcing
   the corresponding skill (`/check`, `/check-docs`, `/run-integ`,
   `/review-pr`, `/verify-pr`, `/merge-pr`) to be re-run before the
   gated action can proceed.

## 1. Universal-shape safety hooks

- **`commit-msg-heredoc-gate.sh`** blocks
  `git commit -m "$(cat <<'EOF' ... EOF)"`-style invocations because
  outer-shell quote tracking miscounts when the body contains
  apostrophes / backticks; use `git commit -F <file>` instead.

- **`control-char-gate.sh`** blocks `git commit` (incl. the
  `cd <path> && git commit` / `git -C <path> commit` worktree forms)
  when a staged text file's blob contains a NUL (`\x00`) or any other
  C0 control byte except tab / newline / carriage-return. Catches the
  editing-artifact foot-gun where a separator lands as a raw control
  byte inside source (the formatter / linter does NOT flag it, but it
  makes `grep` treat the file as binary and silently suppress matches,
  and ships a control byte in committed text). Scans the STAGED BLOB
  (`git show :<file>`) of each `--diff-filter=ACM` file, not the diff —
  a NUL makes `git diff` report "Binary files differ" and hide the
  added lines, so a diff-only scan would miss exactly this case.
  Binary / asset extensions (images, fonts, archives, `.wasm`, etc.)
  are skipped (control bytes are legitimate there). Cwd-aware (same
  `git -C` > `cd` > payload `cwd` resolution as `branch-gate.sh`).
  Fails open when `git` / `perl` are unavailable or nothing is staged.
  No bypass marker — the fix is to remove the stray byte and re-stage.

- **`closes-paren-form-gate.sh`** blocks `gh pr merge <N>` when the
  target PR's body uses `Closes (#N)` / `Fixes (#N)` /
  `Resolves (#N)` (parens form) — GitHub's auto-close grammar
  requires parens-free `#N`, so the parens form leaves the
  referenced issue OPEN after merge. **Fail-open on `gh pr view`
  non-zero exit** (network / auth / rate-limit) — but emits a LOUD
  stderr warning so the user sees the gate couldn't verify and can
  check manually. Empty body (PR with no content) passes silently.

- **`gh-pr-edit-deprecation-gate.sh`** blocks `gh pr edit --title` /
  `--body` because they currently fail SILENTLY on a GraphQL
  Projects-classic deprecation; use
  `gh api -X PATCH repos/<owner>/<repo>/pulls/<N> -f title=... -F body=@<file>`
  instead.

- **`non-english-text-gate.sh`** blocks `gh pr create` / `gh pr edit`
  / `gh pr merge` (and their `gh -C <path>` forms) when the resolved
  PR diff (or local `origin/main..HEAD` when no PR exists yet)
  contains non-English writing-system characters — hiragana
  (U+3040-U+309F), katakana (U+30A0-U+30FF), CJK ideographs /
  kanji / Chinese (U+4E00-U+9FFF), Hangul syllables (U+AC00-U+D7AF),
  or CJK punctuation (U+3000-U+303F). Skips binary / lockfile /
  asset extensions where non-ASCII bytes are normal. Em-dashes /
  curly quotes / box-drawing chars / arrow glyphs pass through (the
  ranges are deliberately scoped to writing systems, not
  general-purpose Unicode). Fails open when `gh` is missing or
  unauthenticated.

- **`pr-body-item-number-gate.sh`** blocks `gh pr create` /
  `gh pr edit` / `gh issue create` / `gh issue comment` /
  `gh api -X PATCH .../pulls|issues/...` invocations whose body file
  (`--body-file <FILE>` or `--field body=@<FILE>` / `-F body=@<FILE>`)
  contains `#N` patterns that GitHub auto-links to issue/PR `#N` —
  the "review-fix 4 -> linked to unrelated PR 4" trap. Allow-listed
  contexts (`closes #N` / `(#N)` / fenced code blocks / GitHub URLs
  / backtick code spans) pass through; bare `Must-fix #N` /
  `review-fix #N` / `step #N` / plain `#N` in prose are blocked with
  line-numbered offender output.

- **`issue-dup-check-gate.sh`** blocks `gh issue create` — and a
  `gh api repos/<owner>/<repo>/issues` that is actually a MINT (an
  explicit `POST`, or a `title=` field with no explicit method, since gh
  infers POST from fields); the collection path is also the LIST
  endpoint, so plain reads and `-X GET` pass — when the issue body
  carries no `Dup-check:` line recording
  that the OPEN issue list was searched for an issue already covering
  this root cause. `gh issue edit` / `gh issue comment` are
  deliberately NOT gated: folding a finding into an issue that already
  exists is the outcome the gate steers toward, so taxing it would
  penalise the cheap path and leave the costly one free. It is NOT a
  filing threshold — `/work-issues` §10-0 forbids using it as one; it
  changes WHERE a finding is written, never whether.

  Why here, since cdk-local does not have its sibling's backlog
  problem (measured 2026-08-25: 5 open issues, none carrying
  `Session-fit: next`, nothing umbrella-shaped): the target is the
  cross-repo MIRROR path, which `/work-issues` §10-c already names as
  a duplicate generator in its own text. go-to-k/cdk-local#531 was
  filed eight minutes after go-to-k/cdk-local#528 with a strict SUBSET
  of its lessons, and go-to-k/cdk-local#511 duplicated
  go-to-k/cdk-local#504 after 75 minutes.
  go-to-k/cdk-local#528's body shows the near miss exactly — it records
  a file check and an open-PR scan, and no check of the open ISSUE
  list. Not one of the four bodies records an open-issue search, which
  is the window that would have caught either pair.

  Two marker spellings, and the split is load-bearing. In a body FILE
  the marker is ANCHORED at line start (optional `-*+>` list prefix,
  case-insensitive), so a passing mention inside a sentence does not
  satisfy it. In the raw COMMAND there is no line structure — an
  inline `--body 'Bug. Dup-check: ...'` is one line — so that scan is
  unanchored, and it reads the BODY VALUES only (`--body` / `-b` /
  `body=`), never the whole segment: `--title 'Dup-check: yes'` used to
  satisfy the gate with a marker-free body, and a title is not a record
  of having searched anything. The threat model is FORGETTING to run the
  search, not defeating the gate.

  Both scans are scoped to the `gh issue create` / `gh api ... issues`
  SEGMENT, never the whole command, and that scoping is load-bearing:
  `-F` is `git commit`'s flag as well as gh's short `--body-file`, and
  `commit-msg-heredoc-gate.sh` MANDATES `git commit -F <file>` here,
  so an unscoped extraction reads the COMMIT MESSAGE — which quotes
  the very lines it describes — and finds the marker there. Fenced in
  both command orders.

  An unreadable `--body-file` BLOCKS rather than passes ("cannot read"
  treated as "nothing to object to" is the fail-open shape of
  go-to-k/cdkd#2027), with ONE deliberate exception: `heredoc -> file
  -> --body-file` in one command is a legitimate publishing shape and
  the file does not exist yet at PreToolUse time, so an unreadable
  path falls back to scanning the WHOLE command with the ANCHORED
  marker. A `--body-file "$VAR"` whose path is unexpanded gets its own
  refusal message, because a bare "check the path" is unclearable when
  the file does carry the line. Repo opt-in via `.markgate.yml` at the
  resolved cwd's repo root, same as `branch-gate.sh` /
  `check-gate.sh`, so filing an issue in an unrelated personal repo is
  not refused; the CWD's repo decides, not any `-R <owner/repo>` in
  the command, because `-R` names where the issue LANDS while the cwd
  names whose policy the session is under.
  `gh -R go-to-k/<target> issue create` — the cross-repo mirror flow's
  own spelling, and this gate's headline case — is matched because
  `GATE_GH_C` absorbs `-R` in all three of `gh`'s separator forms —
  space, `=`, and glued (see §3; it did not until 2026-08-25, which is
  the same bypass that let `gh -R … pr merge` past `verify-pr-gate`).
  No bypass marker — running
  the search and writing one line is the entire ask. Covered by
  `.claude/hooks/issue-dup-check-gate.test.sh` (83 cases) plus
  recognition cases in `gate-command-recognition.test.sh`.

- **`issue-classification-label-gate.sh`** blocks `gh issue create` /
  `gh issue edit` when the body being published states a `Severity:` or
  `Effort:` value that the issue's LABELS do not carry. The four
  classification fields live in the body as prose lines, which is where
  their one-line reasons belong — and nothing about how they are written
  changes. But prose is invisible to every query the backlog is triaged
  with: ranking by `Severity` costs one `gh issue view` per candidate,
  while `gh issue list --label severity:high` is one call. So the two
  fields with a CLOSED token set are mirrored onto labels:
  `severity:high|medium|low` and `effort:small|medium|large`. Only those
  two — `Session-fit` is re-decided at claim time and a label silently
  disagreeing with the body is worse than none, and `Estimate` is a
  free-form duration whose informative half a label cannot hold.
  `gh issue edit` IS gated here and `gh issue comment` is not, which is
  the opposite split from `issue-dup-check-gate.sh` and is deliberate:
  that gate steers toward folding into an existing issue, while `edit`
  is the CLAIM site where an old packed body is rewritten into the
  four-line shape, so it is where `Severity` first exists for the bulk
  of the backlog. On `edit` the gate asks gh what labels the issue
  already carries, so a re-edit of an already-labelled issue is untaxed;
  an unresolvable issue number or a gh failure FAILS OPEN. The scan
  requires at least one SPACE after the key, and that separation is the
  whole gate: the label spelling is `severity:high` with no space, the
  body form is `Severity: high`, and without it a `--label` would
  satisfy its own requirement. Covered by
  `.claude/hooks/issue-classification-label-gate.test.sh` (25 cases,
  green under bash 5.x and macOS system bash 3.2; mutation-probed
  2026-08-26 — an always-`exit 0` stub fails 7, an always-`exit 2` stub
  fails all 25, and relaxing the space rule fails exactly 2).

- **`docs-inline-json-flag-gate.sh`** blocks `gh pr create` /
  `gh pr edit` / `gh pr merge` (and their `gh -C <path>` / `cd <path>
  && ...` forms) when a Markdown file in the resolved PR diff (or
  local `origin/main..HEAD` when no PR exists yet) hands an INLINE
  JSON literal to a cdk-local CLI flag that takes a FILE PATH —
  `--env-vars` or `--event`. Both are read with `readFileSync`
  (`src/cli/commands/local-invoke.ts`), so a documented
  `--env-vars '{...}'` is treated as a filename and fails at runtime
  with ENOENT; the correct form is `--env-vars ./env.json`. This bug
  shipped in two committed docs before it was caught by hand.
  Detection is a single `grep -nE` per touched `*.md` file for the
  flag followed by an opening `{` and a JSON-key quote (the
  brace-then-quote shape), so prose that describes the anti-pattern
  with a `{...}` placeholder passes through. Scans Markdown only, so
  the hook's own `.sh` source is never scanned. Fails open when `gh`
  is missing or unauthenticated. No bypass marker — the fix is to move
  the JSON into a file and pass its path.

- **`post-merge-orphan-push-gate.sh`** blocks
  `git push <remote> <branch>` (incl. `-u` / `--set-upstream` /
  `git -C <path> push`) when `<remote>` is `origin` AND
  `gh pr list --head <branch> --state merged` returns a PR whose
  `headRefName` matches. Closes the orphan-push trap: `gh pr merge
  --delete-branch` lands the PR -> GitHub's
  `delete_branch_on_merge: true` removes the source branch -> a
  near-simultaneous `git push` SUCCEEDS by re-creating the deleted
  branch as a fresh orphan ref no PR is tracking, so the commits
  silently never reach main. Scope guard: ONLY fires on the MERGED
  state (closed-not-merged passes through); ONLY fires on the
  `origin` remote; ONLY fires on `git push` (`git pull` / `git fetch`
  / etc. pass through). Fails open when `gh` is missing or
  unauthenticated.

## 2. Branch / push safety

- **`branch-gate.sh`** blocks `git commit` and `git push` when the
  **target git working tree** is on `main` / `master`. Cwd-aware
  (reads `tool_input.cwd` from the hook payload + parses
  `cd <path>` / `git -C <path>` from the command), so worktree work
  that `cd /parent && git commit`s into a parent worktree on `main`
  is also caught. When blocked, the error names the resolved target
  dir and the parsed command — create a feature branch in that dir
  (`git -C <target-dir> switch -c <branch>`) and retry.

- **`main-tree-branch-gate.sh`** blocks branch-switching commands in
  the MAIN worktree so concurrent agents don't race on the shared
  `/Users/.../cdk-local` slot. Allowed in the main tree:
  `git switch main` / `git switch master`,
  `git checkout main|master`, `git checkout -- <pathspec>` (file
  restore), `git checkout <sha>` (detached HEAD), `git worktree add
  ...` (sanctioned escape). Blocked: `git switch -c <feat>`,
  `git switch <existing-feat>`, `git checkout -b <feat>`,
  `git checkout <local-branch-name>`, `git switch -`. Inside any
  `.claude/worktrees/<x>/` subtree everything passes through —
  feature-branch work is meant to live there. The error message
  names the resolved target dir + the operation + the corrective
  `git worktree add .claude/worktrees/<branch> -b <branch> origin/main`
  recipe.

## 3. Markgate-backed gates

The seven markgate gate hooks (`check-gate.sh`, `verify-pr-gate.sh`,
`pr-review-gate.sh`, `integ-gate.sh`, `cdkd-parity-gate.sh`,
`create-integ-gate.sh`, and `gh-pr-merge-worktree-gate.sh`) are
all **cwd-aware**. Each reads the PreToolUse payload's `cwd` field, then hands
the command to `gate_target_dir` in `.claude/hooks/_command-match.sh`, which
resolves the tree in this order: a `git -C <path>` / `gh -C <path>` inside the
MATCHED segment, else the LAST `cd <path>` segment before it, else the payload
cwd. (Before go-to-k/cdk-local#542 each gate parsed only a LEADING `cd` and any
`-C` anywhere in the command.) The verb regexes in that file absorb the
LEADING FLAGS between the command and its verb: `GATE_FLAGS` for `git`, and
**`GATE_GH_C`, which is literally `GATE_FLAGS`** — the same token shape — for
`gh`.

It has been wrong twice, and both were **live gate bypasses** rather than
cosmetic gaps, because every `gh` verb regex is built on it:

1. It absorbed `-C <path>` ONLY, so `gh -R <owner/repo> pr merge 1 --squash`
   matched nothing and ran ungated.
2. Replacing it with an explicit `(-C|-R|--repo)` alternation fixed only the
   SPACE-separated form, because the alternation demanded `[[:space:]]+` between
   flag and value. `gh` accepts three separators — verified against a real repo,
   `gh pr list --repo=go-to-k/cdkd`, `-R=go-to-k/cdkd` and the GLUED
   `-Rgo-to-k/cdkd` all return the same PR number — so `gh --repo=<owner/repo>
   pr merge --squash` was still a bypass, one keystroke from the one just
   closed. `-C` had the same hole all along: `gh -C=/w/t pr merge` never matched.

Measured by driving the real hooks with markgate stubbed stale:

| gate | plain | `-R <o/r>` (round 1) | `--repo=<o/r>` / `-R<o/r>` (round 2) |
|---|---|---|---|
| `verify-pr-gate` (`pr merge`) | 2 | **0** | **0** |
| `verify-pr-gate` (`pr create`) | 2 | **0** | **0** |
| `integ-gate` (`pr merge`) | 2 | **0** | **0** |

So `/verify-pr` and the Docker integ gate were both skippable by adding a flag
the flow itself tells you to use in multi-repo sessions, and which this repo's
own `.claude/settings.json` permission allow-list already writes for cross-repo
filing. (The other `gh` gates shell out to `gh` and fail OPEN when it errors, so
under a stubbed `gh` they answer 0 to both spellings — a harness limit, not
evidence they were unaffected; they share the same absorber.)

`GATE_FLAGS`' token is `-[^[:space:]]+`, which swallows `--repo=X`, `-R=X` and
`-RX` WHOLE, with the value group needed only for the space form. All three
separators fall out of the token shape instead of being enumerated — which is
why this is not a curated flag list: an alternation must spell each flag times
each separator, and the glued form, having no separator at all, is the one it
misses. Being wider than "repo/dir flags" costs nothing, since a flag regex only
decides which spellings REACH the verb. Same defect and same fix as
go-to-k/cdkd#2027 review round 4, whose `GATE_GH_C` is this same `GATE_FLAGS`.

**Widening the absorber is necessary and NOT sufficient**, and this is the part
that bit hardest. Making the flagged commands REACH a gate does nothing about
the gate then parsing them, and four gates each rolled their own PR-selector
extraction with the same `-C`-only shape the absorber had just outgrown.
Measured against `gh -R go-to-k/cdk-local pr merge 552 --squash`:

| gate | plain resolves | flagged resolved (before) |
|---|---|---|
| `closes-paren-form-gate` | `pr view 552` | **`gh` never called — fully bypassed** |
| `non-english-text-gate` | `pr diff 552` | **`pr diff 999`** (the current branch's PR) |
| `docs-inline-json-flag-gate` | `pr diff 552` | **`pr diff 999`** |
| `pr-review-gate` | `pr view 552` | **`pr view 30`** from `sleep 30 && gh -R … merge 552` |

The last one is the worst: the wrong PR's additions / deletions / file count
chose the review tier, so if that PR is `inline` the real merge passes with no
reviewer at all. All four now call **`gate_pr_selector`** in
`_command-match.sh`, which strips `BASH_REMATCH[0]` of the SAME verb ERE that
armed the gate — whatever flags it absorbed — and scans only what follows. A
gate can no longer match one way and parse another. Each of the four also
fails CLOSED if the library predates the helper.

`gate_target_dir`'s `-C` recognition was widened alongside, for the same reason:
the absorber now admits `gh -C=/w/t pr merge 1`, which previously resolved to the
payload cwd, so a **different worktree's markgate marker** decided the verdict.

Two further instances of the same shape, both found by review rather than by the
suite, and both fixed here:

- **The flag enumeration had the wrong polarity.** `gate_pr_selector` skipped an
  enumerated list of VALUE-TAKERS, so any unlisted value-taking flag left its
  value in the walk — `gh pr merge -t 42 552` resolved to **42**. The list is now
  of VALUELESS flags, and every other `-…` consumes its next token. The direction
  of staleness is the argument: an unlisted value-taker judges a DIFFERENT PR,
  while an unlisted valueless flag merely empties the selector and the caller
  falls back to current-branch semantics. A final numeric guard makes a branch
  name, URL or repo slug yield empty rather than be handed on.
- **The `-C` scan read inside quoted flag VALUES.**
  `git -c core.pager="less -C /evil" commit -m y` resolved to `/evil`, and through
  `branch-gate` on `main` that turns rc=2 into rc=0. The cause was tokenisation,
  not the scan: `GATE_PATH_TOKEN` is "a quoted span OR a bare run of non-space",
  so it split `core.pager="less` at the first space and read the tail as a fresh
  `-C`. `GATE_EMBEDDING_TOKEN` lets a token EMBED quoted spans, and the flag run
  is now walked token-by-token. Pre-existing on `origin/main`; the widened `-C`
  scan made it reachable in more shapes.

**Which REPO the gate asks about** was a fourth blind spot with no helper at all:
a gate resolved the PR number and then ran `gh pr view <N>` from the resolved
directory WITHOUT the repo flag, so `gh -R go-to-k/OTHER pr merge 552` made every
gate judge the LOCAL repo's PR 552 — right number, wrong repo, and identical to
the correct case in both exit code and selector. `gate_cmd_repo` extracts the
named repo (all three separators, quoted spans embedded, either side of the verb)
and the four gates pass it through to their own gh calls. Fenced by `run_repo`.

The regression cases live in TWO places on purpose. `_command-match.test.sh`
pins the absorber at the regex level, in every direction — all three separator
forms match, the plain / `-C` forms keep the verdicts they already had, no `gh`
verb matches a DIFFERENT `gh` verb, and a flag VALUE does not swallow the verb
(`gh --draft pr create` still matches `pr create`, which only backtracking
saves). But a matcher test can only fail once someone
already suspects the flag, so `gate-command-recognition.test.sh` adds the
assertion that would have caught this cold: drive a gate with the plain and the
flagged spelling of the SAME command and demand the same exit code. Those pairs
carry an expected plain rc as a guard-the-guard, because a gate that fails open
under the stub would otherwise satisfy the equality vacuously at 0.

**Equal exit codes are still not enough**, which is how the four selector bugs
above were certified green. Two harness defects had to be fixed before any of
them was visible: the payloads carried no `tool_name`, so `closes-paren-form-gate`
exited at its `tool_name` check before ever reading the command and its pair
reported "both exit 0" over a live bypass; and nothing asserted **what the gate
asked GitHub about**. `run_sel` now does exactly that — a `gh` shim logs its argv
and answers `999` to `pr view --json number`, so a fall-through to
current-branch resolution shows up as a wrong PR number rather than as silence.
Every spelling must resolve the SAME PR the plain form does, with the plain arm
as the control.

**And the same lens has to be turned on every verifier a gate consults, not just
on `gh`.** Three further blind spots, each of which left a live bypass green:

- **WHICH MARKER a gate verifies.** The markgate stub logged `$PWD` and
  discarded `$*`, so swapping `verify-pr-gate`'s `markgate verify verify-pr` for
  `verify check` was fully green — a mutant that merges any PR whose `/check`
  alone is fresh, i.e. whose `/verify-pr` checklist never ran. The stub now logs
  argv and `run_marker` asserts the gate name.
- **WHICH REPO a gate asks about** — see `gate_cmd_repo` above, fenced by
  `run_repo`.
- **The directory `cdkd-parity-gate` / `create-integ-gate` resolve.** An earlier
  revision recorded "(never asked)" for these and called them uncoverable
  controls. That was FALSE: both expose the resolved directory on their first
  `git -C "$target_dir" rev-parse --git-dir`, long before markgate. A `git` shim
  logging argv reads it, and `run_git_dir` asserts it. A comment claiming
  coverage is impossible is worse than no comment — it is what stops the next
  person from adding it.

The rule these three share: **assert what the gate ASKS ITS VERIFIER, not only
what it answers.** An exit code cannot distinguish "asked the right question and
got no" from "asked the wrong question and got no".

The hook then `cd`s to that resolved target dir
before invoking `markgate verify`. This preserves
markgate's per-worktree marker isolation — each parallel agent's
worktree has its own markgate state dir
(`<worktree>/.git/worktrees/<name>/markgate/` for side worktrees,
`<main>/.git/markgate/` for the main tree).

**Convention**: `markgate set <gate>` must be run from the same
worktree (cwd) where the gated command (`git commit` / `gh pr
create` / `gh pr merge`) will eventually be invoked. Concurrent
agents in different worktrees no longer collide because each
worktree has its own markgate state dir. The
`.markgate-pr-review-sha` sentinel is already per-worktree by
construction.

### check-gate (pre-commit)

- **`check-gate.sh`** blocks `git commit` unless both the `check`
  and `docs` markgate markers are fresh.
  - `check` — recorded by `/check` (typecheck + lint + format +
    build + tests). Scope: `src/**`, `tests/**`, lockfiles,
    build/test configs (see `.markgate.yml`). Only invalidated by
    changes in that scope.
  - `docs` — recorded by `/check-docs` (README.md /
    `.claude/CLAUDE.md` / `docs/` / `.claude/rules/` consistency
    with src). Scope: `src/**`, `docs/**`, `README.md`,
    `.claude/CLAUDE.md`, `.claude/rules/**`. Only invalidated by
    changes in that scope.

  The error message extracts the parenthetical state reason from
  `markgate status <gate>` so the user knows whether to re-run
  `/check` or `/check-docs`. `/verify-pr` refreshes both markers
  in one shot.

  Match against the scope before running the skills — a tests-only
  commit only needs `/check`; a docs-only commit only needs
  `/check-docs`; a src edit needs both; changes that fall outside
  both scopes (`.claude/hooks/**`, `.claude/skills/**`,
  `.markgate.yml`) need neither. The hook is a safety net, not the
  primary trigger.

  **Run `mise install` after pulling a change to `.mise.toml`.** An
  older markgate binary rejects a newer `.markgate.yml` (an unknown
  `hash:` value fails config parsing for EVERY gate, not just the one
  that uses it), and this hook discards markgate's stderr — so the
  symptom is a misleading "run /check first" that re-running `/check`
  cannot clear. The hook's preferred `mise exec -- markgate` path
  installs the pinned version on demand; its `command -v markgate`
  fallback, used when mise is absent, does not.

### verify-pr-gate (pre-create + pre-merge)

- **`verify-pr-gate.sh`** blocks `gh pr create` and `gh pr merge`
  (incl. `--auto`) unless the `verify-pr` markgate marker is fresh.
  Declared as `requires: [check, docs]` in `.markgate.yml` so
  freshness is the AND of those children plus the `/verify-pr`
  skill's own work. The skill walks the full checklist:

  - typecheck / lint / build / tests
  - test coverage for the diff
  - CI status / working tree / docs consistency
  - Docker + integ marker check (for `src/**` or
    `tests/integration/**` touches)
  - code review (incl. shared-utility caller verification)
  - live-test the changed behavior against real or fixture input
  - retrospective + proposals for new rules / hooks / skills
  - residual review-nit sweep + auto-close audit
  - PR title + body freshness vs the actual diff

  Opening or merging a PR whose live behavior was never exercised,
  or whose retrospective produced no rule proposals for surprises
  in the session, is physically blocked — the hook refuses `gh pr
  create` / `gh pr merge` until `/verify-pr` is re-run end-to-end.

### pr-review-gate (pre-merge, size-flagged)

- **`pr-review-gate.sh`** blocks `gh pr merge` (incl. `--auto`) on
  PRs whose size + bias factors trigger the `/review-pr` skill's
  `1-reviewer` or `3-axis` recommendation, unless the `pr-review`
  marker is fresh AND bound to the PR's current HEAD sha via the
  `.markgate-pr-review-sha` sentinel.

  The hook re-applies the skill's heuristic:

  - `loc < 300 OR fc < 5` -> `inline` (pass-through)
  - `300 <= loc < 1000 AND 5 <= fc < 10` -> `1-reviewer`
  - `loc >= 1000 OR fc >= 10` -> `3-axis`

  Up-bias triggers (any path in the security surface below, OR > 1
  `fix:`-prefixed commit on the PR branch) move the tier UP one
  step (clamped at `3-axis`). The surface is `UP_PATHS` in the hook:

  - credential / secret material -- `src/utils/role-arn.ts`,
    `src/utils/profile-resolver.ts`,
    `src/cli/commands/local-profile-credentials-file.ts`,
    `src/local/ecs-secrets-resolver.ts`,
    `src/local/ssm-parameter-resolver.ts`,
    `src/local/ecs-task-runner.ts`
  - inbound auth verification / enforcement / signing --
    `src/local/cognito-jwt.ts`, `src/local/lambda-authorizer.ts`,
    `src/local/sigv4-verify.ts`, `src/local/authorizer-resolver.ts`,
    `src/local/authorizer-cache.ts`, `src/local/front-door-auth.ts`,
    `src/local/agentcore-serve-auth.ts`,
    `src/local/agentcore-sigv4-sign.ts`, `src/local/http-server.ts`,
    `src/local/front-door-server.ts`,
    `src/local/agentcore-http-server.ts`,
    `src/local/websocket-server.ts`
  - untrusted code / argv / archive + path traversal --
    `src/utils/docker-cmd.ts`, `src/local/docker-runner.ts`,
    `src/local/docker-image-builder.ts`, `src/local/ecr-puller.ts`,
    `src/assets/docker-build.ts`,
    `src/local/image-override-engine.ts`,
    `src/local/cloudfront-function-runtime.ts`,
    `src/local/studio-dispatch.ts`,
    `src/local/studio-serve-manager.ts`,
    `src/local/studio-option-catalog.ts`,
    `src/local/cloudfront-static-origin.ts`,
    `src/local/lambda-resolver.ts`,
    `src/local/agentcore-s3-bundle.ts`,
    `src/local/layer-arn-materializer.ts`

  That list is written out FOUR times (`UP_PATHS` in the hook, here,
  `.claude/skills/review-pr/SKILL.md`, `.claude/agents/pr-code-reviewer.md`)
  and issue go-to-k/cdk-local#506 found it drifted both ways at once — the reviewer-agent
  copy had dropped an entry, and seven live surfaces were missing from
  every copy, on top of which a fresh audit found ~18 more.
  `.claude/hooks/pr-review-gate.test.sh` (run by `vp run test:hooks`,
  wired into CI) now asserts the four agree, in the same order, and that
  every entry resolves to a real file, so drift fails CI rather than
  silently under-protecting. Do not re-quote an individual path in this
  paragraph: the test reads the surface out of the list above, and a
  stray mention would refill an entry a copy had dropped.

  Down-bias triggers (every path under
  docs/infra OR every path under `tests/`) move it DOWN one step
  (clamped at `inline`). When both fire, up wins. **Agent-instruction
  files are NOT docs for this purpose** (issue go-to-k/cdk-local#501): `CLAUDE.md`,
  anything under `.claude/**` and `.markgate.yml` are excluded from the
  docs bucket by `AGENT_INSTRUCTION_REGEX`, because a wrong rule there
  propagates into every future session — and since they are markdown,
  the bucket's `.*\.md` entry (which exists for integ-test READMEs)
  would otherwise re-admit them.

  `inline`-tier PRs always pass through. `gh pr create` is
  intentionally NOT gated — small PRs should be openable freely.

  Sentinel-based PR-sha binding: a new push to the PR rewrites the
  sentinel (next `/review-pr` run) and `markgate verify` reports
  stale automatically. No bespoke sha tracking inside the hook.

### integ-gate (pre-merge)

The `integ` markgate marker is set by `/run-integ` when the
Docker-based fixture run is clean and all orphan sweeps return
empty. `integ-gate.sh` is installed and consults it.

`integ-gate.sh` blocks `gh pr merge` on PRs whose
diff touches `src/**` or `tests/integration/**` when the `integ`
marker is stale (digest differs OR expired by the 14-day TTL).
The 14d TTL is on top of the diff-scope check — Docker base-image
behavior (`public.ecr.aws/lambda/*`, RIE binary), `dockerd`
semantics, and chokidar / network plumbing drift even when the
repo doesn't, so a marker more than two weeks old no longer proves
today's local code path actually works.

**`hash: diff`, not `hash: files` (markgate 0.4+).** `integ` is the
only gate on the diff mode. Its digest is this branch's delta against
`merge-base(origin/main, HEAD)` restricted to the include set, rather
than the working tree's content, so it can tell a change THIS BRANCH
made from one that arrived from `main`:

| event | marker |
|---|---|
| `main` moves an in-scope file this branch did NOT touch | **fresh** |
| `main` moves an in-scope file this branch ALSO touched | stale |
| in-scope edit on this branch (committed or not) | stale |
| out-of-scope edit | fresh |

Pulling / rebasing onto an updated `main` therefore stops forcing an
irrelevant Docker re-run — every incoming change already passed this
same gate in its own PR. `base: origin/main` is mandatory for the mode
(no `origin/HEAD` fallback: that ref is frequently unset in CI clones,
which would make the gate mean different things locally and in CI).
Accepted limitation: cross-file interaction is invisible — if this
branch changes A and `main` changes B and a caller uses both, the
deltas never overlap and the marker stays fresh though the combination
is unverified. `hash: files` caught that incidentally; the 14d TTL
still forces a periodic Docker run. See issue go-to-k/cdk-local#498 for the measurement
behind adopting it here and NOT for `cdkd-parity` / `create-integ`
(both centred on the small, hot `src/cli/commands/**` directory —
`cdkd-parity` also covers `src/internal.ts` / `src/index.ts` — where
half the invalidations are genuine overlaps) or `check` / `docs`
(cheap to re-run, so strictness costs nothing).

Two operational consequences, both louder than a silent pass:

- **Empty TOTAL delta is refused** (exit 2, "no delta against
  merge-base") — typically a clean `main`. The empty check runs BEFORE
  include/exclude filtering, so it cannot be reached through the gate: a
  branch with no delta at all also has no diff, and the scope
  short-circuit below exits 0 first. If the error ever does surface,
  `markgate status` writes it to stderr, the reason extraction yields
  nothing, and the hook falls back to its generic blocked message.
- **Empty IN-SCOPE delta is ACCEPTED**, with a warning and exit 0:
  `hash=diff recorded an empty in-scope delta (include: src/**,
  tests/integration/**); this branch changes nothing the gate covers,
  so the marker stays fresh until it does`. A docs-only branch is the
  normal case. Do not read that warning as the refusal above — the
  marker IS written, and `verify` returns 0.

**Unresolvable `base` ref is a hard stop, and `/run-integ` cannot clear
it.** When `origin/main` does not resolve (fresh clone, a worktree that
has never fetched), markgate exits 2 for `verify`, `status` AND `set`
alike: `hash=diff: base ref "origin/main" does not resolve; fetch it
first (git fetch origin)`. The hook's short-circuit is skipped in that
state too (it needs the same ref), so the merge is blocked with the
generic message — and re-running `/run-integ` cannot fix it, because
its `markgate set integ` fails identically. **The fix is `git fetch
origin`**, after which `set` succeeds normally. Under `hash: files`
this situation degraded to an ordinary marker check; it no longer does.

**Scope short-circuit.** Before consulting the marker, the hook diffs
the PR vs `origin/main` (`git diff origin/main...HEAD --name-only`, the
same base `create-integ-gate.sh` / `cdkd-parity-gate.sh` use) and exits
0 when NEITHER `src/**` nor `tests/integration/**` is touched. Without
this, `markgate verify integ` reports "no marker" in EVERY fresh
worktree (per-worktree marker isolation means a new worktree starts
with none), so a docs / hooks / skills-only PR would be wrongly blocked
and forced into an irrelevant Docker run. The short-circuit only fires
when the diff is computable; if `origin/main` is unresolvable it falls
through — but under `hash: diff` that is no longer a marker check, it
is an unconditional block (markgate exits 2 on the unresolvable base,
see above). Run `git fetch origin`, not `/run-integ`.

The skill is the ONLY legitimate setter of this marker — never
call `markgate set integ` directly from a shell.

### cdkd-parity-gate (pre-create)

- **`cdkd-parity-gate.sh`** blocks `gh pr create` (incl.
  `gh -C <path> pr create` / `cd <path> && gh pr create`) on PRs
  whose diff vs `origin/main` touches the cdk-local library surface
  and the `cdkd-parity` marker is stale. Two independent signals
  trigger the gate:

  - any change under `src/cli/commands/**`, `src/internal.ts`, or
    `src/index.ts` (the library-surface scope), OR
  - a NEW `.ts` file added under `src/local/**` (`--diff-filter=A`).
    Edits to existing `src/local/**` files are intentionally NOT in
    scope — most touches there are internal refactors that don't
    change host-CLI surface. A brand-new file is the strongest
    signal that a host-facing helper may have been introduced
    without an explicit `src/internal.ts` re-export, which is
    exactly the `/check-cdkd-parity` category 3 walk-through. The marker is set ONLY by
  `/check-cdkd-parity`, which walks the four host-impacting
  categories — new subcommand factory, new CLI option, new public
  helper / type, behavior change — and asks the structured
  questions a host CLI maintainer (cdkd) would ask before bumping
  the `cdk-local` version:

  - new subcommand factory → exported from `src/index.ts`? cdkd
    notified?
  - new CLI option → added inside `add<Cmd>SpecificOptions` (not
    inline in `create<Cmd>Command`)? contract test still green?
  - new public helper / type under `src/local/**` → exported from
    `src/internal.ts`? JSDoc names the host-side use case?
  - behavior change → cdkd informed (issue / cross-link)? migration
    note in PR body?

  Pre-create only — `gh pr merge` is intentionally NOT gated. The
  parity question is a judgment recorded once at PR-create time;
  re-blocking on a stale marker for a small follow-up commit would
  be friction without value. Out-of-scope diffs (internal refactors
  not touching the gate's paths, docs, tests, infra) pass through
  silently.

  **Tracking-issue enforcement (cat 1 / cat 2).** The marker proves the
  skill *walked* the categories — not that a cdkd tracking issue was
  actually filed. So for the two mechanically-unambiguous host-MUST-act
  categories the gate ALSO requires a cdkd issue reference, on top of the
  marker:

  - **cat 1** — a NEW `src/cli/commands/local-*.ts` file (`--diff-filter=A`)
    whose added content declares `export function createLocal<Verb>Command`
    (the same factory-content check as `create-integ-gate.sh`, so a new
    non-factory helper module does NOT fire it), OR
  - **cat 2** — a `+...addOption(new Option(...)` line added to any
    `src/cli/commands/*.ts`.

  When either fires, the gate requires the per-worktree sentinel
  `.cdkd-parity-issue` to exist AND contain a
  `github.com/go-to-k/cdkd/issues/` reference (written by
  `/check-cdkd-parity` when it auto-files the issue), blocking
  `gh pr create` until it does. cat 3 (new `src/local/**` export — noisy)
  and cat 4 (behavior change — a judgment call) are NOT hard-blocked; they
  rely on the marker (the skill walked + auto-filed for them too). This
  puts the hard floor on the cases where cdkd unambiguously must
  wrap / inherit, without over-firing on internal refactors.

  Fail-open behavior: when `gh` / `markgate` are missing, or
  `origin/main` is not resolvable, the hook exits 0 silently. The
  gate is a safety net for the four categories above, not a hard
  dependency.

  The skill is the ONLY legitimate setter of this marker — never
  call `markgate set cdkd-parity` directly from a shell. Likewise, do
  NOT hand-write `.cdkd-parity-issue` to satisfy the cat-1/2 check — run
  `/check-cdkd-parity` so the issue is actually created on go-to-k/cdkd
  (the skill auto-creates it; `.claude/settings.json` `permissions.allow`
  pre-authorizes the scoped `gh issue create`).

### create-integ-gate (pre-create)

- **`create-integ-gate.sh`** blocks `gh pr create` (incl.
  `gh -C <path> pr create` / `cd <path> && gh pr create`) on PRs whose
  diff vs `origin/main` ADDS a new command factory — a NEW
  `src/cli/commands/local-<verb>.ts` file (`--diff-filter=A`) that
  declares an `export function createLocal<Verb>Command(...)` — when
  the `create-integ` marker is stale. The content check matters:
  `src/cli/commands/local-*.ts` also holds non-factory helper modules
  (`local-state-source.ts`, `local-profile-credentials-file.ts`), which
  must NOT fire the gate, so a filename match alone is not enough.

  A new subcommand factory is brand-new top-level user-facing behavior
  with NO existing integ fixture, so it MUST ship its own. This is the
  one case where "needs a new fixture" is unambiguous (a new command
  always does), so the gate is scoped to exactly that signal — EDITS to
  existing command files (`M` / `D`, e.g. adding a flag) never fire it,
  since they reuse that command's existing fixture (which `integ-gate`
  already covers at pre-merge time).

  The marker is set ONLY by `/create-integ`, which scaffolds a fixture
  (`package.json` pinned with `packageManager` so `vp install` is a
  no-op, `bin` / `lib` / `cdk.json` / `tsconfig` / a `verify.sh`
  harness), has you fill in the stack + assertions, **RUNS it via
  `/run-integ`**, and records the marker only on a clean green run.

  Pre-create only — `gh pr merge` is intentionally NOT gated. "A fixture
  was created for the new command" is a create-time judgment; the
  `integ` gate still enforces marker freshness at pre-merge for any
  `src/**` / `tests/integration/**` touch.

  Fail-open: `gh` / `markgate` / `git` missing, or `origin/main`
  unresolvable -> exit 0 silently. The skill is the ONLY legitimate
  setter — never `markgate set create-integ` directly from a shell.

### gh-pr-merge-worktree-gate (worktree merge)

- **`gh-pr-merge-worktree-gate.sh`** blocks a hand-run `gh pr merge`
  (incl. `gh -C <path> pr merge` / `cd <path> && gh pr merge` /
  `--auto`) from inside a `.claude/worktrees/<branch>/` **side
  worktree** unless the `merge-pr` markgate marker is fresh — forcing
  every worktree merge through the `/merge-pr` skill, the single
  chokepoint that:
  - merges WITHOUT `--delete-branch` (so gh runs no local cleanup and
    never trips the `'main' is already used by worktree` fatal that a
    hand-run `gh pr merge --squash --delete-branch` hits from a side
    worktree), and
  - then cleans the worktree + local branch + remote branch correctly
    via `git -C <main>`.

  Routing every worktree merge through one skill means any future step
  added to the merge flow runs automatically — there is one path, not
  two. `/merge-pr` runs `markgate set merge-pr` in its own step BEFORE
  its `gh pr merge` call (a PreToolUse hook evaluates the whole command
  string before any line runs, so the set + merge must be SEPARATE Bash
  calls — see [[markgate-set-separate-bash-call]]), so the skill's own
  merge passes; a hand-run merge has no fresh marker and is blocked with
  an error naming `/merge-pr <N>`.

  Scope: ONLY side worktrees (`*/.claude/worktrees/*`, resolved via
  `git rev-parse --show-toplevel` after the same cwd resolution the
  other gates use). A merge from the main worktree does not hit the
  fatal and is left alone (fail-open). The `merge-pr` gate is TTL-only
  (`ttl: 30m`, see `.markgate.yml`): a merge changes no tracked files,
  so a content digest would stay fresh forever after a set — the short
  TTL bounds the window so a stale marker left by a crashed `/merge-pr`
  cannot authorize a later hand-run merge.

  Fail-open when `git` / `markgate` are missing or the target is not a
  side worktree. The `/merge-pr` skill is the ONLY legitimate setter of
  the `merge-pr` marker — never `markgate set merge-pr` directly from a
  shell to bypass this gate.
