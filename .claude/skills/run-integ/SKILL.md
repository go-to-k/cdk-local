---
name: run-integ
description: Run an integration test (Docker-based, optionally AWS-deploy-backed for the fixtures that own real AWS resources) and refresh the `integ` markgate marker on a clean run.
argument-hint: "<test-name>"
---

# Integration Test Runner

Run an integration test against real Docker (and, for the fixtures that own real AWS resources, a real CloudFormation stack deployed via the upstream `cdk` CLI). Which fixtures those are is DERIVED by `tests/integration/_lib/aws-orphan-sweep.sh`, never globbed from the name.

cdk-local is a local-execution CLI — it does NOT deploy resources itself. The only AWS-side activity in any integ test is when a fixture's `verify.sh` invokes the upstream `cdk deploy` (or, for `local-invoke-agentcore-froms3`, `aws s3api create-bucket`) to create a target stack for `--from-cfn-stack` to point at. Cleanup is always done by the fixture's own `verify.sh`.

## Arguments

- `test-name`: Which test to run. Run `ls tests/integration/` to see all available tests. If not specified, use the `AskUserQuestion` tool to ask which test to run, showing the available options.

## Steps

1. **Build first**: Run `vp run build` to ensure `dist/cli.js` is up to date. The fixture's `verify.sh` resolves the binary via `node ../../../dist/cli.js`, so source changes without a build have no runtime effect.

2. **Resolve the fixture path**: `tests/integration/<test-name>/`. Confirm `verify.sh` exists; if not, the test does not have a Docker-driven flow yet and this skill exits with a clear error pointing the user at the missing script.

3. **Pre-flight Docker sweep**: `docker ps --filter name=cdkl- -q | wc -l` and `docker network ls --filter name=cdkl-task- -q | wc -l` should both return `0`. If either is non-zero, abort and ask the user to run `/cleanup` first — running on top of orphans causes name collisions and confusing failures.

4. **AWS pre-flight sweep** — run it for EVERY fixture, unconditionally:

   ```bash
   bash tests/integration/_lib/aws-orphan-sweep.sh <test-name>; rc=$?
   ```

   Do NOT first decide whether the fixture is AWS-resource-owning — that
   decision silently excluded a resource-owning fixture twice
   (`*-from-cfn-stack` missed three; the widened `*-from-cfn*` still missed
   `local-invoke-assume-role`). The script decides internally, from one
   predicate against the fixture's own `verify.sh`; a fixture that owns
   nothing makes no AWS call and exits 0 (`--list-owners` prints the derived
   set).

   **Also confirm the deploy toolchain is present** — the sweep checks that
   AWS is reachable, not that the fixture can deploy, and this was dropped
   when the recipe became a script:

   ```bash
   which cdk        # the upstream CDK CLI a *-from-cfn-stack fixture shells out to
   ```

   Only needed when the sweep reported the fixture as AWS-owning (rc 0 with a
   `fixture=` line rather than the "owns no real AWS resource" line).

   **Gate on the exit code. Do not read the output and judge.** The previous
   recipe was prose whose error branches nobody executed, carrying four
   instances of one defect class in a single PR (go-to-k/cdk-local#601):

   | rc | meaning | what to do |
   |----|---------|------------|
   | 0 | clean | proceed to step 5 |
   | 1 | usage / internal error | STOP. Nothing was concluded. Read the FATAL line. |
   | 2 | orphan found | STOP. Remediate — see below. |
   | 3 | indeterminate | STOP. A query could not be performed (no credentials, `aws` missing, an unrecognized error). This is NOT clean. |
   | 4 | report-only | STOP and check by hand. An UNATTRIBUTABLE resource matched — see below. |

   Anything non-zero means do NOT proceed and do NOT set the marker in step 9.

   The decisions the script encodes are stated in its file header, each with
   its reason, and `aws-orphan-sweep.test.sh` executes every failure path
   rather than grepping for it — read the header rather than re-deriving them
   here.

   **On rc=2, the script PRINTS the remediation plan.** Run what it printed.
   It names the SUFFIXED stacks (a base name matches nothing and reports
   success), uses `aws cloudformation delete-stack` and never `cdk destroy`
   (which needs `--app` context this cwd does not provide and, repaired by
   hand, exits 0 SILENTLY on a name the app never synthesized — this defect
   class arriving through the remediation), and tells you to re-run the sweep
   afterwards, since no delete command reports "I matched nothing".

   **First, confirm it is not a LIVE peer.** A name under this lane's suffix
   can also belong to a second run of the same fixture in the SAME worktree.
   Check for a running `verify.sh` before deleting anything. Cross-worktree
   lanes can no longer collide, which is the point of the suffix.

   **On rc=4** the match is a `froms3` bucket, whose name carries no lane hash
   at all (account + region + timestamp), so it may be a concurrently running
   peer's LIVE bucket. It is reported, never attributed — same live-peer check,
   and delete only what you have confirmed is yours.

5. **Run the test**: `bash tests/integration/<test-name>/verify.sh`. Propagate the script's exit code — a non-zero exit must drive this skill into the failure path so step 7's cleanup verification fires. Do NOT swallow `verify.sh` failures.

   **Start it in the BACKGROUND on the FIRST attempt, not after a foreground
   run dies.** A foreground Bash call is capped at ten minutes, and a
   first-ever run on a cold Docker cache spends most of that in the one-time
   `public.ecr.aws/lambda/*` base-image pull (~600 MB) — measured on
   go-to-k/cdk-local#650: the first `local-invoke` attempt was killed at the
   cap (exit 143) still inside that pull. Run this step with the Bash tool's
   `run_in_background`, handing it the BARE command — no trailing `&` and no
   `nohup`, either of which double-backgrounds and reports the launcher's
   exit 0 while the real run is untracked — and REDIRECT the output to a log:

   ```bash
   bash tests/integration/<test-name>/verify.sh > /tmp/integ-<test-name>.log 2>&1
   ```

   **Redirect, never `| tee`.** A pipeline's status is the LAST stage's, so
   `verify.sh … | tee log` reports `tee`'s success and a FAILING fixture
   arrives as rc=0 (measured under bash, zsh AND dash; only
   `set -o pipefail` recovers it and `dash` does not have it). A RED run
   would then satisfy step 9's first set-condition and `markgate set integ`
   would fire on a failure — the same family as the piped-`markgate` trap
   `markgate-pipe-gate.sh` exists for. With the redirect, `$?` is
   `verify.sh`'s own; under `run_in_background` the verdict is the exit
   status the completion notification reports.

   **Then POLL THE LOG for progress; a completion notification is not a
   timer.** Nothing in the stack has a timeout, so a stalled pull is
   indistinguishable from a slow one from outside (measured: a `docker pull`
   froze 2 h 58 m across a machine-sleep window with the image ALREADY fully
   downloaded, and nothing fired). Read the log's tail after a few minutes;
   if it has not moved, walk the process tree (`pgrep -P` down to the
   `docker pull` pid), kill the tree, confirm 0 orphans via step 6, and
   re-run — with the cache warm it completes in about a minute.

6. **Verify Docker cleanup** (mandatory regardless of pass/fail):

   ```bash
   docker ps --filter name=cdkl- -q | wc -l         # must be 0
   docker network ls --filter name=cdkl-task- -q | wc -l   # must be 0
   docker network ls --filter name=cdkl-svc- -q  | wc -l   # must be 0
   ```

   If any are non-zero, dispatch `/cleanup` (no `--detect-only`) and re-run the checks. Never end the run with orphan Docker resources still present.

7. **Verify AWS cleanup** — the SAME command as step 4, with the same
   exit-code gate:

   ```bash
   bash tests/integration/_lib/aws-orphan-sweep.sh <test-name>; rc=$?
   ```

   This run matters more than step 4's: it comes after a long test where a
   session token can expire (which is exactly the `rc=3` indeterminate case,
   NOT a clean one), and step 9 turns its verdict into a fresh `integ` marker.

   Same table, same remediation, same live-peer check. Re-run the sweep after
   any deletion and require rc=0 before continuing.

8. **Report results**: Show pass/fail for the test, plus a one-line cleanup summary — `docker: 0 orphans, network: 0 orphans` plus `AWS sweep: rc=0 (clean)` quoting the sweep's OWN verdict line and exit code. Quote what the script printed rather than paraphrasing it: a paraphrase is writable without having run anything, which is how a recipe reports clean while not having looked.

9. **Set the `integ` markgate marker (only on full clean success)**:

   When — and ONLY when — all of the following hold:
   - the `verify.sh` step finished with exit code 0,
   - step 6 reports 0 docker orphans,
   - step 7's `aws-orphan-sweep.sh` exited **0** (any of 1 / 2 / 3 / 4 is a
     stop, and rc=3 in particular means the sweep could not look — not that
     nothing is there),

   record the gate so subsequent `gh pr merge` calls are unblocked:

   ```bash
   mise exec -- markgate set integ || echo "MARKER NOT RECORDED (rc=$?) — read the error above"
   ```

   **Check the exit code; do not assume the set succeeded.** Under
   `hash: diff` the set CAN fail, reporting the reason on stderr — an
   unchecked call looks silent and successful while nothing was recorded.
   The failure modes and their fixes:

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
