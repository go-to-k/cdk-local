---
name: verify-pr
description: Comprehensive PR readiness check before merge. Runs quality checks, tests, CI, docs, Docker / integ verification, and code review.
argument-hint: "[PR-number]"
---

# PR Readiness Verification

Recommended heavy pre-merge pass — before creating or merging a PR, not before
every commit (`/check` covers that). It sets no marker and blocks nothing; the
mechanical merge conditions are CI green plus a fresh `integ` marker.

Run each check and report pass/fail.

0. **Worktree pre-flight** — `[ -d node_modules ] || pnpm install --frozen-lockfile`.
   `git worktree add` does NOT copy `node_modules`, so a fresh worktree's checks
   all fail with "command not found". **Do not start step 1 until this passes**,
   or every check below silently no-ops while looking green.

1. **Code quality** — `vp run check` (typecheck + lint + format) and
   `vp run build` (produces `dist/cli.js` + `dist/index.js`). When piping either
   to `tail` / `head` / `grep`, **read the actual output** for `Error` /
   `Command failed`: `$?` after a pipeline reflects the LAST stage, not the
   tool's exit. When in doubt capture without piping —
   `vp run X > /tmp/out 2>&1; rc=$?; tail -3 /tmp/out; echo "[rc=$rc]"`.

2. **Tests**
   - `vp run test` — all unit tests pass; report the count (files and tests).
   - `vp run test:hooks` — the shell suites under `.claude/hooks/*.test.sh` and
     `tests/integration/_lib/*.test.sh`. **Not covered by `vp run test`** (a
     separate task in `vite.config.ts`); CI runs it separately, so skipping it
     here only moves the failure to the PR.
   - **Coverage for the change**: new or modified `src/` logic in
     `git diff origin/main...HEAD` with no added / updated test is a **fail** —
     add the tests before proceeding.

3. **CI status**
   - No PR number given → `gh pr view --json number -q .number`; no PR for the
     branch → ask for the number via `AskUserQuestion`.
   - **Check merge state first** (`gh pr view <PR> --json mergeStateStatus,mergeable`).
     On `CONFLICTING` / `DIRTY` the CI workflow will NOT fire however long you
     wait: rebase on `origin/main`, resolve, `git push --force-with-lease`. Only
     once the state is `CLEAN` / `UNSTABLE` / `BLOCKED` / `BEHIND`, require every
     row of `gh pr checks <PR>` to pass.
   - **`--watch` waits for PENDING rows to settle, not for rows to APPEAR.** With
     none reported it returns at once (rc=1, `no checks reported`), so an `until`
     loop around it hot-spins a whole tool timeout. Poll for existence first
     (`gh pr checks <PR> --json name,state`), and only watch once a row exists.

   - **The row set is not fixed — never compare it against a remembered number,
     never read a rollup as a verdict on the whole set.** Rows arrive in WAVES (a
     `needs:` job has no row until its dependency completes); the set differs by
     EVENT (`pr-inherit-issue-labels.yml` fires on `pull_request_target`
     open/edit/reopen only); and a CONFLICTING PR gets no `pull_request` rows at
     all, so a blocked PR looks like a short green. Derive what you EXPECT from
     `.github/workflows/` for the event(s) this head saw, and read "no checks
     yet" as "not queued yet".

4. **Working tree** — `git status` clean, branch in sync with the remote.

5. **Docs consistency** — run `/check-docs` once per PR, at the final sha: docs
   match the code changes, no stale references to removed code.

6. **cdkd parity reviewed** — when the diff touches the library surface cdkd
   embeds (`src/cli/commands/**`, `src/internal.ts`, `src/index.ts`), run
   `/check-cdkd-parity` and walk its four categories.

7. **Docker + integ verification** (diff touching `src/**` or
   `tests/integration/**`)

   `integ-gate.sh` blocks `gh pr merge` while the `integ` marker is stale for that
   scope (`hash: diff` against `merge-base(origin/main, HEAD)`). It reads LOCAL
   git state, so a merge from a parent worktree still on pre-PR `main` sees an
   empty diff and never consults the marker — verifying it here, in the PR's own
   worktree, closes that gap:

   ```bash
   out=$(mise exec -- markgate verify integ 2>&1 >/dev/null); rc=$?
   echo "[markgate verify integ rc=$rc] $out"
   ```

   The command substitution is not a style choice: `$?` there IS markgate's
   status, whereas `markgate verify … | tail` reports the PIPE's and a stale
   marker reads as a pass.

   Non-zero `rc` (1 = digest differs or expired by the 14 d TTL; >= 2 = could not
   evaluate, most often an unresolvable `base` ref — fix with `git fetch origin`)
   → run `/run-integ <test>` against a test exercising the changed surface:
   `local-start-api` (HTTP server / route discovery / authorizer / container
   pool), `local-invoke` (Lambda runtime / ZIP asset), `local-run-task`,
   `local-invoke-container`, `local-invoke-layers`, `local-invoke-from-cfn-stack`.
   `/run-integ` sets the marker itself once the Docker-side check passes. CI is
   necessary but not sufficient — it never exercises local execution.

   For orphan AWS resources run
   `bash tests/integration/_lib/aws-orphan-sweep.sh <test-name>`, never a
   hand-written `describe-stacks` (fixture stack names are LANE-UNIQUE, so a bare
   base name matches nothing and reports clean whatever is deployed). Gate on its
   exit code (0 clean / 1 usage or internal / 2 orphan / 3 indeterminate /
   4 report-only): non-zero means do not proceed, and `3` means the sweep could
   not look, not that nothing is there.

8. **No stale references** — grep for removed imports, old module names and
   deprecated references; confirm `src/index.ts` exports stay consistent.

9. **Code review**
   - Run `/review-pr <N>` and dispatch what it names: 1 `pr-code-reviewer` by
     default, spec + test added on a large `src/**` diff, and a security-lens
     pass on secret / credential / process-launch / Docker-exec surfaces.
   - **Reviewers run ONCE, on the FINAL sha.** Re-check a fix round by MESSAGING
     the same reviewer, never by dispatching a fresh one.
   - Synthesize the reports into a pass / issues-found verdict; any blocker goes
     through a fix-back loop first. Then `git diff origin/main...HEAD` to confirm
     the diff is what was reviewed. For each change: correct? complete?
     necessary? Look for unhandled edge cases, dead or reverted-but-present code,
     unrelated edits, callers of changed functions that do not handle the new
     behavior, and types out of step with the impl.
   - **Shared-utility regression check**: if a file under `src/utils/**` (or
     another widely-imported module) changed, list every importer
     (`grep -rl "utils/<file>" src tests`) and walk each one.

10. **Live-test changed behavior** — unit tests verify code correctness; this
    verifies *feature* correctness against the runtime the user sees. Build first
    (`vp run build`), then run the real command path for each user-visible change
    (command, output format, flag, error message, container behavior):
    - CLI surface → `node dist/cli.js <subcommand> <args>` against a
      `tests/integration/<example>/` fixture; Lambda runtime → `cdkl invoke`
      against `tests/integration/local-invoke/`; HTTP server → `cdkl start-api`
      against `tests/integration/local-start-api/` plus one curl; library-only →
      a minimal repro importing the new code path.
    - Hook (`.claude/hooks/*.sh`) → in a throwaway git repo, pipe a synthesized
      payload (`jq -nc '{tool_input:{command:"<gated cmd>"},cwd:"<repo>"}'`) into
      the hook and assert exit 2 on the offender, exit 0 on a clean case AND on a
      non-matching command — one that fail-opens looks installed but never fires.
      For a hook reading `origin/main`, simulate the base ref there
      (`git update-ref refs/remotes/origin/main <sha>`).

    "Tests passed" is not "feature works." If you cannot live-test (no Docker
    daemon, no fixture), say so explicitly rather than skip silently.

11. **Retrospective** — for each surprise, friction or user correction this
    session, ask whether it is a one-off or recurring. A pattern's FIRST
    occurrence is a row in `docs/tooling-backlog.md` and nothing is built; only a
    second justifies building anything. Surface the proposals before merging.

12. **Residual review-nit sweep** — walk every reviewer's "Minor / Nit /
    Informational" section and put EACH item on one of three paths, fixing it if
    none holds: **(a) fixed in this PR** — the default, since a reviewer's nit
    lives in a file this session just reviewed, which makes it `now` under
    `.claude/rules/session-report.md`'s context test; **(b) TODO (issue #N)** —
    only through one of that rule's two `next` reasons, written in the issue body
    and referenced from this PR's; **(c) won't-do** — the PR body or a comment
    names the nit and why shipping as-is is right.

13. **PR title + body freshness** (skip if no PR exists yet). Follow-up commits
    stale both.
    - Title: confirm it still describes the union of commits on the branch;
      update with `gh api -X PATCH repos/{owner}/{repo}/pulls/{number}
      -f title="..."`, not `gh pr edit --title` (which can fail silently).
    - Body: compare `gh pr view <PR> --json body -q .body` against
      `git diff origin/main...HEAD` and flag bullets describing reverted behavior
      or checks the code no longer performs, dead file:line citations, wording
      contradicting the docs, and stale numeric claims. If stale, rewrite into a
      file, PATCH it with `--field "body=@<file>"`, and re-read the body to
      confirm backticks rendered correctly.

## Output

Report a two-column table, one row per check above in checklist order, each
pass / fail or `n-a` for a scope the diff does not touch. If all pass, confirm
"PR is ready to merge"; otherwise list the issues to fix. Then commit and push
anything this run changed, so the remote branch matches what you verified.
