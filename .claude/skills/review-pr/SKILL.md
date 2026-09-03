---
name: review-pr
description: Recommend the right reviewer count for a PR based on size + bias factors. Outputs a concrete plan (inline spot-check / 1 reviewer / 3-axis parallel) plus ready-to-paste Agent dispatch prompts when reviewers are warranted.
argument-hint: "<PR-number>"
---

# PR Review Recommendation

Decide how much review rigor a PR actually warrants — and surface the dispatch prompts for the orchestrator to copy-paste. Running all 3 reviewer agents on every PR is expensive (~25 min) and drains attention; running none on a large security-sensitive PR misses bugs.

The skill itself never spawns reviewers. It reads PR stats, applies the heuristic, and prints a recommendation. The **main session orchestrator** (the parent reading this skill's output) is responsible for actually issuing the `Agent` tool calls when the recommendation says to.

## Inputs

- **Required**: PR number (positional). Example: `/review-pr 42`.

## Steps

1. **Fetch PR stats** via `gh`:

   ```bash
   gh pr view <N> --json additions,deletions,changedFiles,title,headRefName,files \
     -q '{a: .additions, d: .deletions, fc: .changedFiles, title: .title, branch: .headRefName, paths: [.files[].path]}'
   ```

   Record: `additions` (`a`), `deletions` (`d`), `changedFiles` (`fc`), `title`, `branch`, list of file `paths`.

   Compute `loc = a + d`.

   **Subtract auto-generated LOC** before computing the tier — generated artifacts (snapshot fixtures, large lockfile diffs, etc.) and lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`) inflate LOC without adding reviewer surface. Reviewers do not (and cannot meaningfully) audit these files line-by-line:

   ```bash
   excluded=$(gh pr view <N> --json files \
     -q '[.files[] | select(.path | test("/pnpm-lock\\.yaml$|/package-lock\\.json$|/yarn\\.lock$")) | .additions + .deletions] | add // 0')
   loc=$(( a + d - excluded ))
   ```

   Note: `fc` is NOT adjusted — a 12-file diff is still cross-cutting even when 2 of the files are lockfiles.

2. **Determine the base tier** from `(loc, fc)` per the heuristic:

   | Condition | Base tier |
   |-----------|-----------|
   | `loc < 300` OR `fc < 5` | **inline** (inline spot-check by the orchestrator) |
   | `300 <= loc < 1000` AND `5 <= fc < 10` | **1-reviewer** (single code-quality pass) |
   | `loc >= 1000` OR `fc >= 10` | **3-axis** (spec + code + test in parallel) |

   The two boundary conditions overlap intentionally — a 200-LOC / 12-file PR triggers 3-axis via the file count even though LOC is small (a 12-file diff has cross-cutting risk regardless of LOC), and a 5000-LOC / 3-file PR triggers 3-axis via LOC.

3. **Compute bias factors** by scanning the `paths` list:

   **Up-bias triggers** (move tier UP by one step, never above 3-axis):

   - Any path matches **security / process-launch surface** — credential or secret material, inbound auth verification, or untrusted-code / image execution:
     - _Credential / secret material_
       - `src/utils/role-arn.ts`
       - `src/utils/profile-resolver.ts`
       - `src/utils/aws-proxy.ts`
       - `src/cli/commands/local-profile-credentials-file.ts`
       - `src/local/ecs-secrets-resolver.ts`
       - `src/local/ssm-parameter-resolver.ts`
       - `src/local/ecs-task-runner.ts`
     - _Inbound auth: verification, enforcement, request signing_
       - `src/local/cognito-jwt.ts`
       - `src/local/lambda-authorizer.ts`
       - `src/local/sigv4-verify.ts`
       - `src/local/authorizer-resolver.ts`
       - `src/local/authorizer-cache.ts`
       - `src/local/front-door-auth.ts`
       - `src/local/agentcore-serve-auth.ts`
       - `src/local/agentcore-sigv4-sign.ts`
       - `src/local/http-server.ts`
       - `src/local/front-door-server.ts`
       - `src/local/agentcore-http-server.ts`
       - `src/local/websocket-server.ts`
       - `src/utils/url-authority.ts`
     - _Untrusted code / argv / archive + path traversal_
       - `src/utils/docker-cmd.ts`
       - `src/local/docker-runner.ts`
       - `src/local/docker-image-builder.ts`
       - `src/local/ecr-puller.ts`
       - `src/assets/docker-build.ts`
       - `src/local/image-override-engine.ts`
       - `src/local/cloudfront-function-runtime.ts`
       - `src/local/studio-dispatch.ts`
       - `src/local/studio-serve-manager.ts`
       - `src/local/studio-option-catalog.ts`
       - `src/local/cloudfront-static-origin.ts`
       - `src/local/lambda-resolver.ts`
       - `src/local/agentcore-s3-bundle.ts`
       - `src/local/layer-arn-materializer.ts`

     This list exists in FOUR places — `UP_PATHS` in `.claude/hooks/pr-review-gate.sh`, here, `.claude/rules/hooks.md`, and `.claude/agents/pr-code-reviewer.md` — and issue go-to-k/cdk-local#506 found it drifted in both directions at once. `.claude/hooks/pr-review-gate.test.sh` (run by `vp run test:hooks`, in CI) asserts the four agree and that every entry resolves to a real file. Keep adding to it freely — a module listed here costs one extra reviewer, a module missing from it costs a security review that never happened. Do not re-quote an individual path anywhere in this bullet: the test reads the surface out of the list above, and a stray mention would refill an entry a copy had dropped.
   - Branch has > 1 fix-back commit (heuristic for "multiple sub-agents wrote the diff" — count commits whose message starts with `fix:` / `fix(` via `git log main..<branch> --oneline | grep -cE '^[a-f0-9]+ fix(\(|:)'`)

   **Down-bias triggers** (move tier DOWN by one step, never below inline) — only fires when ALL paths fall in the listed buckets:

   - **Pure docs/infra**: every path matches one of `.gitignore`, `README.md`, `**/*.md`, `docs/**`, `package.json` (top-level deps only). The `**/*.md` entry catches markdown anywhere outside `docs/**` (most commonly `tests/integration/*/README.md`).
     - **Agent-instruction files are EXCLUDED from this bucket** (issue go-to-k/cdk-local#501): `CLAUDE.md`, `.claude/CLAUDE.md`, anything under `.claude/**`, and `.markgate.yml` — they are markdown, so the `**/*.md` entry would re-admit them if the exclusion were dropped, and a wrong rule there changes how EVERY future session behaves, the opposite of the low risk a down-bias assumes. A skills-only or hooks-only PR keeps its size-derived tier. Keep in sync with cdkd's copy and with `DOWN_DOCS_REGEX` / `AGENT_INSTRUCTION_REGEX` in `.claude/hooks/pr-review-gate.sh`.
   - **Test-only**: every path matches `tests/**`

   If both up- and down-bias triggers fire (e.g. a tests-only diff that touches a security-sensitive provider's test file), prefer up-bias — security wins.

4. **Apply the bias** to compute the final tier:

   - `inline` + up → `1-reviewer`
   - `1-reviewer` + up → `3-axis`
   - `3-axis` + up → `3-axis` (clamp)
   - `3-axis` + down → `1-reviewer`
   - `1-reviewer` + down → `inline`
   - `inline` + down → `inline` (clamp)

5. **Render the recommendation** in the format below.

6. **Dispatch reviewers + set the marker** (only when `final_tier` is `1-reviewer` or `3-axis`):

   The recommendation tells the orchestrator what to do. The orchestrator
   then dispatches the recommended reviewers (1 or 3) via the Agent tool,
   waits for all of them to complete, and synthesizes the findings:

   - If **any blocker** surfaces (correctness bugs, security issues,
     test gaps that justify rejecting the PR), the marker is NOT set
     — the orchestrator addresses the blockers (or asks the
     implementing agent to fix them) and re-runs `/review-pr <N>`.
   - If every finding is **minor / nit / clean**, the orchestrator
     sets the marker bound to the PR's current HEAD sha:

     ```bash
     # The pr-review markgate gate's scope is the sentinel file at
     # repo root, so writing the PR HEAD sha into it before `markgate
     # set` implicitly binds the marker to that sha. A subsequent push
     # to the PR will invalidate the marker (the next /review-pr run
     # rewrites the sentinel and markgate's digest reports stale).
     #
     # The sentinel + markgate state both land in the CURRENT worktree
     # — the same one where `gh pr merge <N>` will later run. The gate
     # hook resolves the target worktree from the PreToolUse payload's
     # `cwd` field + `cd <path>` / `gh -C <path>` in the command, so
     # concurrent agents in different worktrees no longer collide on
     # a shared main-tree marker store. Convention: set markers from
     # the worktree you intend to merge from.
     gh pr view <N> --json headRefOid -q .headRefOid > .markgate-pr-review-sha
     mise exec -- markgate set pr-review
     ```

   For the `inline` tier, the marker is NOT set — the gate's heuristic
   also outputs `inline` for the same PR, so no enforcement fires and
   the merge proceeds without a marker.

   **NEVER set the marker without dispatching the reviewers first.**
   The whole point of the gate is that an un-reviewed large PR cannot
   reach main; bypassing dispatch defeats it. The gate's hook
   (`.claude/hooks/pr-review-gate.sh`, ship in a follow-up PR) blocks
   `gh pr merge` until the marker is fresh AND the recorded sha matches
   the PR's current HEAD.

## Output template

```
Recommendation: <inline | 1-reviewer | 3-axis>

PR #<N>: <title>
Stats: +<additions> / -<deletions> = <loc> LOC, <fc> files
Branch: <branch>

Base tier (from stats): <base>
Bias factors:
  - <factor 1, or "none">
  - <factor 2>
Applied bias: <up / down / none>
Final tier: <final>

Rationale: <one line — e.g. "Small infra-only diff; orchestrator can spot-check in 5 min." / "Touches src/local/cognito-jwt.ts (credential surface), bumps base tier up.">
```

Then, **if final tier is `1-reviewer`**, emit:

```
Dispatch this single reviewer (run via Agent tool in the main session):

  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> code review",
    prompt: |
      Read your role definition at `.claude/agents/pr-code-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
  }
```

**If final tier is `3-axis`**, emit:

```
Dispatch these three reviewers IN PARALLEL (single message, three Agent tool calls):

  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> spec compliance review",
    prompt: |
      Read your role definition at `.claude/agents/pr-spec-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
      - Design doc: <ASK THE USER — the orchestrator should fill this in before dispatching; spec review is meaningless without a design doc to compare against. If no design doc exists for this PR, downgrade to 1-reviewer instead.>
  }

  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> code review",
    prompt: |
      Read your role definition at `.claude/agents/pr-code-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
  }

  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> test adequacy review",
    prompt: |
      Read your role definition at `.claude/agents/pr-test-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
  }
```

**If final tier is `inline`**, emit:

```
No reviewer dispatch — orchestrator should spot-check inline:

  - `gh pr diff <N>` — read the full diff in one pass
  - For each changed file, ask: is it correct, complete, necessary?
  - Estimated time: 5 min

If during the inline read you discover a non-obvious bug class (cross-cutting state machine, race, security-sensitive logic), STOP and re-run /review-pr <N> after manually adding the file path to the up-bias trigger list locally, or just dispatch a code reviewer by hand.
```

## Important

- **Never auto-dispatch** the Agent tool from inside this skill. Skills run in the main conversation; this skill's job is to *recommend*, the orchestrator's job is to *act*.
- The orchestrator can extend each reviewer prompt with PR-specific context (concerns to deep-dive, design doc path for spec-reviewer, files to focus on). Treat the dispatch blocks as starting templates, not final prompts.
- For 3-axis dispatches: the spec reviewer needs a design doc path. If no design doc exists for the PR (small features, bug fixes, refactors), downgrade to 1-reviewer rather than dispatching spec-reviewer with no inputs.
- Thresholds are heuristics, not laws. When in doubt, ask: "would I be comfortable spot-checking this in 5 minutes?" — if yes, inline; if no, dispatch.
