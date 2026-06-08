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
all **cwd-aware**. Each reads the PreToolUse payload's `cwd` field plus
parses leading `cd <path>` and the last `git -C <path>` /
`gh -C <path>` flag from the command, then `cd`s to that resolved
target dir before invoking `markgate verify`. This preserves
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

  Up-bias triggers (any path under `src/utils/role-arn.ts` /
  `src/local/cognito-jwt.ts` / `src/local/lambda-authorizer.ts` /
  `src/local/docker-runner.ts` / `src/local/docker-image-builder.ts`
  / `src/local/ecr-puller.ts` / `src/local/sigv4-verify.ts`, OR > 1
  `fix:`-prefixed commit on the PR branch) move the tier UP one
  step (clamped at `3-axis`). Down-bias triggers (every path under
  docs/infra OR every path under `tests/`) move it DOWN one step
  (clamped at `inline`). When both fire, up wins.

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
The 14d TTL is on top of the file-scope check — Docker base-image
behavior (`public.ecr.aws/lambda/*`, RIE binary), `dockerd`
semantics, and chokidar / network plumbing drift even when the
repo doesn't, so a marker more than two weeks old no longer proves
today's local code path actually works.

**Scope short-circuit.** Before consulting the marker, the hook diffs
the PR vs `origin/main` (`git diff origin/main...HEAD --name-only`, the
same base `create-integ-gate.sh` / `cdkd-parity-gate.sh` use) and exits
0 when NEITHER `src/**` nor `tests/integration/**` is touched. Without
this, `markgate verify integ` reports "no marker" in EVERY fresh
worktree (per-worktree marker isolation means a new worktree starts
with none), so a docs / hooks / skills-only PR would be wrongly blocked
and forced into an irrelevant Docker run. The short-circuit only fires
when the diff is computable; if `origin/main` is unresolvable it falls
through to the marker check (conservative — never weaker than before).

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
