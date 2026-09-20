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
   `tests/integration/_lib/*.test.sh` (spawns throwaway git repos and a
   PATH-stubbed `gh`, so it is uncached).

`vp run verify` is the convenience alias that runs all four; either path is
fine.

Step 4 is not optional: CI runs `vp run test:hooks` as its own step, so
skipping it locally only moves the failure to the PR.

## Output

Report as a table:

| Check | Result |
|-------|--------|
| typecheck + lint + format (`vp run check`) | pass/fail |
| build | pass/fail |
| tests (N files, M tests) | pass/fail |
| hook shell suites (`vp run test:hooks`, N pass / M fail) | pass/fail |

If all pass, confirm "All checks passed."
If any fail, show the error output and STOP.
