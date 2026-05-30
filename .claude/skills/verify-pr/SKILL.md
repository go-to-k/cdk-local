---
name: verify-pr
description: Comprehensive PR readiness check before merge. Run quality checks, tests, CI, documentation, Docker / integ verification, and code review.
argument-hint: "[PR-number]"
---

# PR Readiness Verification

Heavy pre-merge gate. Run this before creating or merging a pull request — NOT before every commit. Per-commit verification is handled by `/check` (enforced by `check-gate.sh` that blocks `git commit` without a fresh marker).

## Checklist

Run each check and report pass/fail:

0. **Worktree pre-flight**: confirm `node_modules/` exists in the cwd:
   ```bash
   [ -d node_modules ] || pnpm install --frozen-lockfile
   ```
   `git worktree add` does NOT copy `node_modules`, so a fresh worktree's `vp run typecheck` / `lint` / `build` and `vp run test` all fail with "command not found" / "Cannot find package" — but the failure is easy to miss when the output is piped to `tail` (the exit code reflects `tail`, not `vp`, and the failure line gets buried). **Do not start step 1 until this passes**, or every quality check below silently no-ops while looking green.

1. **Code quality**
   - `vp run check` passes (unified typecheck + lint + format)
   - `vp run build` succeeds (produces `dist/cli.js` + `dist/index.js`)
   - When piping any of the above to `tail` / `head` / `grep`, **check the actual output content** for `Error` / `Command failed` markers — `$?` after a pipeline reflects the LAST stage (usually 0), NOT the build tool's exit. When in doubt, capture without piping: `vp run X > /tmp/out 2>&1; rc=$?; tail -3 /tmp/out; echo "[rc=$rc]"`.

2. **Tests**
   - `vp run test` — all unit tests pass
   - Report test count (files and tests)
   - **Test coverage check**: compare `git diff main...HEAD` for `src/` changes vs `tests/` changes. If new logic was added or modified in `src/` but no corresponding test files were added or updated, flag as **fail** and add the missing tests before proceeding.

3. **CI status**
   - If PR number is not provided as argument, auto-detect via `gh pr view --json number -q .number`
   - If no PR exists for current branch, use the `AskUserQuestion` tool to ask for the PR number
   - **First: check merge state** — `gh pr view <PR> --json mergeStateStatus,mergeable -q '"mergeable=\(.mergeable) state=\(.mergeStateStatus)"'`. When this returns `mergeable=CONFLICTING state=DIRTY`, the CI workflow will NOT fire on the PR no matter how long you wait. Resolution: `git fetch origin main && git rebase origin/main`, resolve conflicts, `git push --force-with-lease` — CI fires within ~30s of the push.
   - Only after `mergeStateStatus` is `CLEAN` / `UNSTABLE` / `BLOCKED` / `BEHIND`: `gh pr checks <PR-number>` — all checks pass.
   - If checks are pending, wait and recheck.

4. **Working tree**
   - `git status` — clean (no uncommitted changes)
   - Branch is up to date with remote

5. **Documentation consistency**
   - Invoke `/check-docs` skill logic: verify docs match code changes.
   - Check for stale references to removed code.

6. **cdkd parity reviewed** (for src/cli/commands/** or src/internal.ts or src/index.ts touches)

   The `cdkd-parity` markgate gate physically blocks `gh pr create` when its marker is stale AND the PR's diff touches the cdk-local library surface that cdkd (and any other host CLI) embeds. The pre-create gate covers the open path; checking the marker here closes the merge-time path structurally:

   ```bash
   # Only check when the PR diff actually touches the gate scope.
   if git diff origin/main...HEAD --name-only \
       | grep -qE '^src/cli/commands/|^src/internal\.ts$|^src/index\.ts$'; then
     mise exec -- markgate verify cdkd-parity
   fi
   ```

   If this exits non-zero (digest differs OR marker never set), run `/check-cdkd-parity` to walk the four host-impacting categories — new subcommand factory / new CLI option / new public helper / behavior change — and set the marker. See `.claude/skills/check-cdkd-parity/SKILL.md` and `.claude/rules/hooks.md` "cdkd-parity-gate (pre-create)".

7. **Docker + integ verification** (for src/** or tests/integration/** touches)

   The `integ` markgate gate physically blocks `gh pr merge` when its marker is stale (see `.claude/hooks/integ-gate.sh` once shipped). The merge-time gate has a known blind spot: it reads the **local working tree** digest, and when `gh pr merge` runs from a parent worktree still on pre-PR `main`, the digest matches the old content and the gate passes silently — so an unverified change can reach main via the merge-from-parent path. `/verify-pr` runs in the PR's own worktree (post-PR content), so verifying the marker here closes that gap structurally:

   ```bash
   # Only check when the PR diff actually touches the gate scope.
   if git diff main...HEAD --name-only | grep -qE '^src/|^tests/integration/'; then
     mise exec -- markgate verify integ
   fi
   ```

   If this exits non-zero (digest differs OR expired by 14d TTL), run `/run-integ <test>` against a test that exercises the changed surface — `local-start-api` for HTTP-server / route-discovery / authorizer / container-pool changes, `local-invoke` for Lambda-runtime / ZIP-asset changes, `local-run-task` for ECS task changes, `local-invoke-container` for container-Lambda changes, `local-invoke-layers` for Lambda Layers changes, `local-invoke-from-cfn-stack` for `--from-cfn-stack` AWS-binding changes. The `/run-integ` skill calls `markgate set integ` itself when the Docker-side check passes (0 orphan containers / networks; for `*-from-cfn-stack` tests, also 0 orphan CloudFormation stacks). CI is necessary but not sufficient — it does not exercise Docker-based local execution.

   For `*-from-cfn-stack` integ tests only: verify no orphan CloudFormation stack remains (`aws cloudformation describe-stacks --stack-name <FixtureStackName>` should return `Stack does not exist`).

8. **No stale references**
   - Grep for removed imports, old module names, or deprecated references in source files.
   - Check `src/index.ts` exports are consistent.

9. **Code review**
   - **First, run `/review-pr <N>`** to get a size-appropriate review plan. The skill outputs one of:
     - **inline spot-check** (small PR, < 300 LOC OR < 5 files, no security-sensitive paths) — read the diff yourself in this step; no sub-agent dispatch.
     - **1 reviewer** (medium PR, 300-1000 LOC) — dispatch a single `pr-code-reviewer` agent (the skill emits a ready-to-paste Agent call).
     - **3-axis parallel** (large PR `>=` 1000 LOC OR security-sensitive paths) — dispatch all three of `pr-spec-reviewer` / `pr-code-reviewer` / `pr-test-reviewer` in parallel (single message, three Agent tool calls).

     The skill applies bias factors (security surfaces bump up; pure-infra / docs / tests-only bump down). Trust the recommendation; override only when you have a concrete reason (note the reason here).
   - Synthesize the reviewer reports (or your inline read) into a pass / issues-found verdict. Any blocker → fix-back loop before continuing.
   - `git diff main...HEAD` — confirm the diff is what you reviewed (no last-minute commits slipped through).
   - For each change: is it correct? complete? necessary?
   - Check for:
     - Logic errors or unhandled edge cases.
     - Unnecessary changes (reverted code still in diff, dead code, unrelated changes).
     - Inconsistencies between changed files.
   - Verify all callers of changed functions handle the new behavior.
   - Verify type definitions are consistent with implementation.
   - **Shared-utility regression check**: if any file under `src/utils/**` (or another widely-imported module) changed, list every importer (`grep -rl "from '\.\./.*utils/<file>'" src tests`) and walk through each one to confirm the new behavior is correct for them. A change to a shared helper is only "done" when every caller has been considered.

10. **Live-test changed behavior**
   - Unit tests verify code correctness; this step verifies *feature* correctness against the runtime the user actually sees.
   - Build the latest source: `vp run build`.
   - For each user-visible change in the diff (CLI command, output format, flag, error message, runtime container behavior), run the actual command path against a real or fixture input and confirm the output matches the spec / sam-local parity claim:
     - CLI surface change → run `node dist/cli.js <subcommand> <args>` (or `cdkl <subcommand> <args>` if `cdkl` is on PATH) against `tests/integration/<example>/` fixture.
     - Lambda runtime change → run `cdkl invoke` against `tests/integration/local-invoke/` (or the matching language fixture) and check the output.
     - HTTP server change → run `cdkl start-api` against `tests/integration/local-start-api/` and curl one route.
     - Library-only change → run a minimal repro that imports the new code path.
     - PreToolUse hook change (`.claude/hooks/*.sh`) → exercise it end-to-end: build a throwaway git repo (simulate the base ref via `git update-ref refs/remotes/origin/main <sha>` + `git symbolic-ref refs/remotes/origin/HEAD`), commit an offending case AND a clean case, then pipe a synthesized payload (`jq -nc '{tool_input:{command:"<gated cmd>"},cwd:"<repo>"}'`) into the hook and assert it blocks the offender (exit 2) and passes the clean case + a non-matching command (exit 0). Shell hooks have no unit-test harness, so this end-to-end run is the ONLY correctness check — a hook that silently fail-opens (e.g. an unsupported `gh` flag) looks installed but never fires.
   - "Tests passed" is not "feature works." Always run the actual command before declaring done. If you cannot live-test (no Docker daemon, no fixture available), say so explicitly rather than skip silently — the gate exits non-zero so a reviewer can decide whether to accept the trade-off.

11. **Retrospective + rules update**
    - Walk back over the session that produced this PR. For each surprise, friction, or correction the user had to make, ask: "is this a one-off, or a pattern that will recur?"
    - For each pattern, propose where it should be reflected so it doesn't recur:
      - **Hook** — pattern can be detected mechanically (e.g. fragile shell pattern, deprecated tool, marker-gated step). Strongest enforcement.
      - **Skill / marker** — pattern is a checklist that must be done before some action. Use the `/check`+`check-gate` / `/check-docs`+`check-gate` / `/verify-pr`+`verify-pr-gate` / `/run-integ`+`integ-gate` template.
      - **Memory** — pattern is judgmental ("prefer X when Y") and not mechanically detectable. Weakest enforcement; honest about its limits.
    - Surface the proposals out loud (in chat, or in this PR's body) before merging. If the user agrees, write them in the same PR for code/skill/hook artifacts; memory entries are local to `~/.claude/projects/.../memory/` so they land regardless of PR boundaries.
    - The retrospective is itself one of the items the `verify-pr` marker covers — skipping this step means the marker is set on incomplete work.

12. **Residual review-nit sweep**
    - For every `/review-pr` reviewer agent output during this session (including re-reviews after fix-back), walk the reviewer's "Minor / Nit / Informational" section.
    - For EACH item there, confirm ONE of the following is true BEFORE setting the `verify-pr` marker:
      - (a) **Addressed in this PR** — point at the fix commit / file:line that resolves the nit.
      - (b) **Filed as a follow-up issue** — a GitHub issue exists AND this PR's body references it.
      - (c) **Explicitly accepted as known cost** — the PR body or a comment names the nit and explains why it's acceptable to ship as-is.
    - If NONE of (a) / (b) / (c) is true for any nit, file a bundled follow-up issue NOW (one issue per session, listing every uncovered nit) and update the PR body to reference it. Do not set the `verify-pr` marker until every reviewer-flagged item is on one of those three paths.
    - **Auto-close audit**: read the PR body (`gh pr view <PR> --json body -q .body`). For every `(#N)` parens-form reference, check whether it's adjacent to a close keyword (`closes` / `fixes` / `resolves`, case-insensitive). If yes: the merge will NOT auto-close the target issue. Either rewrite to parens-free `Closes #N` (auto-close fires), OR add a manual `gh issue close <N>` step to the merge sequence and note it in the PR body. The `closes-paren-form-gate.sh` hook ALREADY blocks `gh pr merge` for the `Closes (#N)` pattern — this skill step is the human-readable backup that catches the issue BEFORE the merge attempt.

13. **PR title + body freshness** (skip if no PR exists yet)
    - When a PR has follow-up commits after creation, both the title and body authored at PR-create time often go stale: the title was scoped to the first commit's intent only, and the body may mention reverted features, removed checks, or wrong rationale.
    - **Title check**: read `gh pr view <PR> --json title -q .title` and confirm it still describes the union of commits on the branch. Update via `gh api -X PATCH repos/{owner}/{repo}/pulls/{number} -f title="..."` (NOT `gh pr edit --title`, which fails silently due to GraphQL Projects-classic deprecation — see hook `gh-pr-edit-deprecation-gate.sh`).
    - **Body freshness commands**:
      - `gh pr view <PR> --json commits -q '.commits | length'` — commit count on the PR
      - `git log main..HEAD --oneline | wc -l` — commit count locally
      - If they match and > 1, the PR has been iterated on; the initial body is almost certainly stale.
    - Read the current body (`gh pr view <PR> --json body -q .body`) and compare against the actual final diff (`git diff main...HEAD`). Flag any of:
      - Bullets describing behavior that was reverted in a later commit.
      - Bullets describing checks/validations the code no longer performs.
      - File:line citations that no longer exist.
      - Wording that contradicts the current README.md / `.claude/CLAUDE.md`.
      - Stale numeric claims ("N tests pass" when the count has since changed).
    - If stale, rewrite the body and patch via:
      ```bash
      cat > /tmp/pr-body.md <<'EOF'
      ## Summary
      ...
      ## Test plan
      ...
      EOF
      gh api repos/{owner}/{repo}/pulls/{number} -X PATCH --field "body=@/tmp/pr-body.md" -q '.html_url'
      ```
      Verify with `gh pr view <PR> --json body -q .body | head -5` that backticks and special chars rendered correctly.

## Output

Present results as a table:

| Check | Result |
|-------|--------|
| typecheck + lint + format | pass/fail |
| build | pass/fail |
| tests (N files, M tests) | pass/fail |
| test coverage for changes | pass/fail |
| CI | pass/fail |
| working tree | clean/dirty |
| docs consistency | pass/fail |
| cdkd-parity marker (src/cli/commands/** or src/internal.ts or src/index.ts touches) | fresh/stale/n-a |
| integ marker (src/** or tests/integration/** touches) | fresh/stale/n-a |
| code review (incl. shared-utility callers) | pass/issues found |
| live-test changed behavior | pass/skipped/issues found |
| retrospective + rule proposals | done/skipped |
| residual review-nit sweep (filed / addressed / accepted) | N items / 0 unhandled |
| auto-close audit (no `Closes (#N)` in body) | clean / N traps fixed |
| PR title + body freshness | up-to-date/stale (updated)/n-a (no PR yet) |

If all pass, confirm "PR is ready to merge."
If any fail, list the issues to fix.

## Final Step

After all checks pass, record THREE markers via [markgate](https://github.com/go-to-k/markgate) so the gate hooks allow the next `git commit`, `gh pr create`, and `gh pr merge`. `/verify-pr` is a superset of `/check` (code correctness) and `/check-docs` (docs consistency), and adds live-test + retrospective + scope-match on top — so its success implies all three. cdk-local pins markgate via mise, so use `mise exec`:

```bash
mise exec -- markgate set check
mise exec -- markgate set docs
mise exec -- markgate set verify-pr
```

The `verify-pr` marker is the one consulted by `.claude/hooks/verify-pr-gate.sh` to allow `gh pr create` and `gh pr merge`. It is intentionally settable ONLY by this skill — running it by hand from a shell to bypass the gate defeats the whole point. If a check legitimately cannot pass right now (e.g. the live-test cannot run because Docker is unavailable), say so explicitly in the report and DO NOT set the marker — the gate exits non-zero so the human can decide whether to override.

Then, if there are uncommitted changes (e.g., lint fixes, doc updates made during this run), commit them and push to the remote. This ensures the remote branch is always up to date when reporting "PR is ready to merge."

Skip the marker + commit step if any check failed.
