---
name: check
description: Run local quality checks (typecheck, lint, format, build, tests). Quick check during development.
---

# Local Quality Check

Run all local quality checks. Use during development to verify the current state quickly.

## Steps

Run these sequentially and report results:

1. `vp run check` — typecheck + lint + format check (the unified task wired in `vite.config.ts`).
2. `vp run build` — produces `dist/cli.js` and `dist/index.js`.
3. `vp run test` — vitest unit tests.

`vp run verify` is the convenience alias that runs all three; either path is fine.

## Output

Report as a table:

| Check | Result |
|-------|--------|
| typecheck + lint + format (`vp run check`) | pass/fail |
| build | pass/fail |
| tests (N files, M tests) | pass/fail |

If all pass, confirm "All checks passed."
If any fail, show the error output and STOP — do not write the commit-gate marker.

## Commit-gate marker (on success only)

After all three checks pass, record a marker so the `check` gate is fresh. The marker is managed by [markgate](https://github.com/go-to-k/markgate) and captures the current working tree state; any subsequent edits invalidate it and require re-running `/check`.

Run this from the repo root (cdk-local pins markgate via mise, so use `mise exec` to avoid PATH issues when shims aren't active):

```bash
mise exec -- markgate set check
```

Skip this step if any check failed — a stale or missing marker correctly forces re-running `/check` after fixing the failure.
