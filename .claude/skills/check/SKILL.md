---
name: check
description: Run local quality checks (typecheck, lint, format, build, unit tests, hook shell suites). Quick check during development.
---

# Local Quality Check

Run all local quality checks. Use during development to verify the current state quickly.

## Steps

Run these sequentially and report results:

1. `vp run check` — typecheck + lint + format check (the unified task wired in `vite.config.ts`).
2. `vp run build` — produces `dist/cli.js` and `dist/index.js`.
3. `vp run test` — vitest unit tests.
4. `vp run test:hooks` — the shell suites under `.claude/hooks/*.test.sh` and
   `tests/integration/_lib/*.test.sh` (~75 s; spawns throwaway git repos and a
   PATH-stubbed `gh`, so it is uncached).

`vp run verify` is the convenience alias that runs all four; either path is
fine.

Step 4 is NOT optional. `.claude/hooks/**` is inside the `check` gate's
include, so editing a hook stales the marker — and a `/check` that skipped
`test:hooks` would clear that marker while never running the assertions the
edit could have broken, leaving the marker attesting to a suite that does not
contain them (go-to-k/cdk-local#630). The inverse holds too: the four-copy `UP_PATHS` sync
assertion in `.claude/hooks/pr-review-gate.test.sh` reads `.claude/rules/hooks.md`,
`.claude/agents/pr-code-reviewer.md` and `.claude/skills/review-pr/SKILL.md`,
all already in scope, so an edit there staled the marker without anything
re-running the check. CI runs `vp run test:hooks` as its own step, so skipping
it locally only moves the failure to the PR.

## Output

Report as a table:

| Check | Result |
|-------|--------|
| typecheck + lint + format (`vp run check`) | pass/fail |
| build | pass/fail |
| tests (N files, M tests) | pass/fail |
| hook shell suites (`vp run test:hooks`, N pass / M fail) | pass/fail |

If all pass, confirm "All checks passed."
If any fail, show the error output and STOP — do not write the commit-gate marker.

## Commit-gate marker (on success only)

After all four checks pass, record a marker so the `check` gate is fresh. The marker is managed by [markgate](https://github.com/go-to-k/markgate) and captures the current working tree state; any subsequent edits invalidate it and require re-running `/check`.

Run this from the WORKTREE you will commit from — not the main checkout (each worktree has its own markgate marker store, so a marker set elsewhere surfaces later as a mystifying "no marker"; see the convention in `.claude/rules/hooks.md`). cdk-local pins markgate via mise, so use `mise exec` to avoid PATH issues when shims aren't active:

```bash
mise exec -- markgate set check
```

Skip this step if any check failed — a stale or missing marker correctly forces re-running `/check` after fixing the failure.
