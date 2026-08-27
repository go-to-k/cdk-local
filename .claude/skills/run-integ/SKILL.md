---
name: run-integ
description: Run an integration test (Docker-based, optionally AWS-deploy-backed for `*-from-cfn-stack` tests) and refresh the `integ` markgate marker on a clean run.
argument-hint: "<test-name>"
---

# Integration Test Runner

Run an integration test against real Docker (and, for `*-from-cfn-stack` tests, a real CloudFormation stack deployed via the upstream `cdk` CLI).

cdk-local is a local-execution CLI — it does NOT deploy resources itself. The only AWS-side activity in any integ test is when a fixture's `verify.sh` invokes the upstream `cdk deploy` to create a target stack for `--from-cfn-stack` to point at. Cleanup is always done by the fixture's own `verify.sh`.

## Arguments

- `test-name`: Which test to run. Run `ls tests/integration/` to see all available tests. If not specified, use the `AskUserQuestion` tool to ask which test to run, showing the available options.

## Steps

1. **Build first**: Run `vp run build` to ensure `dist/cli.js` is up to date. The fixture's `verify.sh` resolves the binary via `node ../../../dist/cli.js`, so source changes without a build have no runtime effect.

2. **Resolve the fixture path**: `tests/integration/<test-name>/`. Confirm `verify.sh` exists; if not, the test does not have a Docker-driven flow yet and this skill exits with a clear error pointing the user at the missing script.

3. **Pre-flight Docker sweep**: `docker ps --filter name=cdkl- -q | wc -l` and `docker network ls --filter name=cdkl-task- -q | wc -l` should both return `0`. If either is non-zero, abort and ask the user to run `/cleanup` first — running on top of orphans causes name collisions and confusing failures.

4. **For `*-from-cfn-stack` tests only — AWS pre-flight**:
   - Verify the upstream `cdk` CLI is on `$PATH`: `which cdk`.
   - Verify AWS credentials: `aws sts get-caller-identity`.
   - Scan for orphan stacks from a previous interrupted run. **The stack name
     is LANE-UNIQUE (issue go-to-k/cdk-local#582)**: every AWS-deploying fixture suffixes its
     base name with 8 hex derived from this worktree's root path, so scanning
     the bare `<FixtureStackName>` matches nothing and reports clean no matter
     what is actually deployed. Resolve the name the same way the fixture does:

     ```bash
     source tests/integration/_lib/stack-name.sh
     STACK="$(integ_stack_name <FixtureStackBaseName>)"   # e.g. CdkLocalInvokeFromCfnStackFixture
     aws cloudformation describe-stacks --stack-name "${STACK}" 2>/dev/null && echo "ORPHAN" || echo "(no orphan stack)"
     ```

     If an orphan stack is reported, abort with a `cdk destroy "${STACK}"`
     recipe — do NOT proceed. Note that a stack under THIS lane's name can also
     be a second run of the same fixture in the SAME worktree, i.e. a LIVE peer
     rather than a leftover: check for a running `verify.sh` before destroying
     it. Cross-worktree lanes can no longer collide, which is the point of the
     suffix.

5. **Run the test**: `bash tests/integration/<test-name>/verify.sh`. Propagate the script's exit code — a non-zero exit must drive this skill into the failure path so step 7's cleanup verification fires. Do NOT swallow `verify.sh` failures.

6. **Verify Docker cleanup** (mandatory regardless of pass/fail):

   ```bash
   docker ps --filter name=cdkl- -q | wc -l         # must be 0
   docker network ls --filter name=cdkl-task- -q | wc -l   # must be 0
   docker network ls --filter name=cdkl-svc- -q  | wc -l   # must be 0
   ```

   If any are non-zero, dispatch `/cleanup` (no `--detect-only`) and re-run the checks. Never end the run with orphan Docker resources still present.

7. **Verify AWS cleanup** (only for `*-from-cfn-stack` tests):

   Resolve the lane-unique name the same way step 4 does — the bare base name
   matches nothing and this sweep would silently report clean:

   ```bash
   source tests/integration/_lib/stack-name.sh
   STACK="$(integ_stack_name <FixtureStackBaseName>)"
   aws cloudformation describe-stacks --stack-name "${STACK}" 2>/dev/null \
     && echo "ORPHAN STACK REMAINS" \
     || echo "AWS clean"
   ```

   If the stack remains, run `cdk destroy "${STACK}" --force` until clean. Same rule: never end the run with orphan AWS resources.

   Some fixtures also own account-global names that are NOT stacks and outlive a
   failed run — SSM parameter paths and a CloudFormation export name, all
   suffixed by the same lane hash. Sweep those too:

   ```bash
   aws ssm describe-parameters --query "Parameters[?starts_with(Name,'/cdkl')].Name" --output text
   aws cloudformation list-exports --query "Exports[?starts_with(Name,'cdkl')].[Name,ExportingStackId]" --output text
   ```

8. **Report results**: Show pass/fail for the test, plus a one-line cleanup summary ("docker: 0 orphans, network: 0 orphans" / for `from-cfn-stack`: "+ AWS: 0 orphan stacks").

9. **Set the `integ` markgate marker (only on full clean success)**:

   When — and ONLY when — all of the following hold:
   - the `verify.sh` step finished with exit code 0,
   - step 6 reports 0 docker orphans,
   - step 7 (when applicable) reports 0 AWS orphans,

   record the gate so subsequent `gh pr merge` calls are unblocked:

   ```bash
   mise exec -- markgate set integ || echo "MARKER NOT RECORDED (rc=$?) — read the error above"
   ```

   **Check the exit code; do not assume the set succeeded.** Under `hash: files` this command could not fail, so it was safe to fire and forget. Under `hash: diff` it CAN fail, and it reports the reason on stderr — an unchecked call looks silent and successful while nothing was recorded. The failure modes and their fixes:

   - `no delta against merge-base(origin/main, HEAD)` — you are on the base branch. Re-run from the PR's own worktree, on the PR branch.
   - `base ref "origin/main" does not resolve` — run `git fetch origin`, then set again. Re-running the whole integ does NOT help; the set fails identically until the ref exists.
   - `hash=diff recorded an empty in-scope delta` — this is a WARNING, not a failure: the marker WAS saved and the exit code is 0. It only means the branch changes nothing under `src/**` / `tests/integration/**`.

   Confirm with `mise exec -- markgate status integ` (expect `state: match`) before reporting the run as complete. The expensive failure this prevents: a full Docker fixture run finishes, the marker is silently not recorded, the merge stays blocked, and the natural reaction is to run the integ AGAIN rather than fetch.

   If any of the above failed, do NOT set the marker — that is the whole point of the gate. The `integ` gate (see `.markgate.yml`) blocks `gh pr merge` for any PR that touches `src/**` or `tests/integration/**` until this marker is fresh. Set the marker from the PR's own worktree, on the PR branch: the gate uses markgate's `hash: diff` mode, whose digest is that branch's delta against `merge-base(origin/main, HEAD)`.

## Important

- **Never bypass this skill** by invoking the fixture's `verify.sh` directly from a shell — the cleanup verification + markgate set are part of the contract.
- **Never call `markgate set integ` directly** to skip the verification. The marker only earns its place by completing the full sequence above.
- Always confirm the test name is on the official list (`ls tests/integration/`) — typos lead to confusing "no verify.sh" errors.
- The 14-day TTL on the marker (see `.markgate.yml`) accepts that Docker base-image behavior drifts over time even when the repo doesn't; re-running an integ after two weeks is the explicit revalidation. It is also what bounds `hash: diff`'s accepted blind spot — a caller broken by this branch changing A while `main` changed B produces no delta overlap, so only the TTL forces the eventual re-run.
