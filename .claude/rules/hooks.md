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
   `/review-pr`, `/verify-pr`) to be re-run before the gated action
   can proceed.

## 1. Universal-shape safety hooks

- **`commit-msg-heredoc-gate.sh`** blocks
  `git commit -m "$(cat <<'EOF' ... EOF)"`-style invocations because
  outer-shell quote tracking miscounts when the body contains
  apostrophes / backticks; use `git commit -F <file>` instead.

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

The four markgate gate hooks (`check-gate.sh`, `verify-pr-gate.sh`,
`pr-review-gate.sh`, and the planned `integ-gate.sh`) are all
**cwd-aware**. Each reads the PreToolUse payload's `cwd` field plus
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

### integ-gate (pre-merge, TODO)

The `integ` markgate marker is wired (set by `/run-integ` when the
Docker-based fixture run is clean and all orphan sweeps return
empty), but the matching gate hook is not yet installed.

When shipped, `integ-gate.sh` will block `gh pr merge` on PRs whose
diff touches `src/**` or `tests/integration/**` when the `integ`
marker is stale (digest differs OR expired by the 14-day TTL).
The 14d TTL is on top of the file-scope check — Docker base-image
behavior (`public.ecr.aws/lambda/*`, RIE binary), `dockerd`
semantics, and chokidar / network plumbing drift even when the
repo doesn't, so a marker more than two weeks old no longer proves
today's local code path actually works.

The skill is the ONLY legitimate setter of this marker — never
call `markgate set integ` directly from a shell.
