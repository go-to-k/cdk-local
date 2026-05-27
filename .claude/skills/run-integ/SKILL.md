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
   - Scan for orphan stacks from a previous interrupted run:
     ```bash
     aws cloudformation describe-stacks --stack-name <FixtureStackName> 2>/dev/null && echo "ORPHAN" || echo "(no orphan stack)"
     ```
     If an orphan stack is reported, abort with a `cdk destroy <FixtureStackName>` recipe — do NOT proceed.

5. **Run the test**: `bash tests/integration/<test-name>/verify.sh`. Propagate the script's exit code — a non-zero exit must drive this skill into the failure path so step 7's cleanup verification fires. Do NOT swallow `verify.sh` failures.

6. **Verify Docker cleanup** (mandatory regardless of pass/fail):

   ```bash
   docker ps --filter name=cdkl- -q | wc -l         # must be 0
   docker network ls --filter name=cdkl-task- -q | wc -l   # must be 0
   docker network ls --filter name=cdkl-svc- -q  | wc -l   # must be 0
   ```

   If any are non-zero, dispatch `/cleanup` (no `--detect-only`) and re-run the checks. Never end the run with orphan Docker resources still present.

7. **Verify AWS cleanup** (only for `*-from-cfn-stack` tests):

   ```bash
   aws cloudformation describe-stacks --stack-name <FixtureStackName> 2>/dev/null \
     && echo "ORPHAN STACK REMAINS" \
     || echo "AWS clean"
   ```

   If the stack remains, run `cdk destroy <FixtureStackName> --force` until clean. Same rule: never end the run with orphan AWS resources.

8. **Report results**: Show pass/fail for the test, plus a one-line cleanup summary ("docker: 0 orphans, network: 0 orphans" / for `from-cfn-stack`: "+ AWS: 0 orphan stacks").

9. **Set the `integ` markgate marker (only on full clean success)**:

   When — and ONLY when — all of the following hold:
   - the `verify.sh` step finished with exit code 0,
   - step 6 reports 0 docker orphans,
   - step 7 (when applicable) reports 0 AWS orphans,

   record the gate so subsequent `gh pr merge` calls are unblocked:

   ```bash
   mise exec -- markgate set integ
   ```

   If any of the above failed, do NOT set the marker — that is the whole point of the gate. The `integ` gate (see `.markgate.yml`) blocks `gh pr merge` for any PR that touches `src/**` or `tests/integration/**` until this marker is fresh.

## Important

- **Never bypass this skill** by invoking the fixture's `verify.sh` directly from a shell — the cleanup verification + markgate set are part of the contract.
- **Never call `markgate set integ` directly** to skip the verification. The marker only earns its place by completing the full sequence above.
- Always confirm the test name is on the official list (`ls tests/integration/`) — typos lead to confusing "no verify.sh" errors.
- The 14-day TTL on the marker (see `.markgate.yml`) accepts that Docker base-image behavior drifts over time even when the repo doesn't; re-running an integ after two weeks is the explicit revalidation.
