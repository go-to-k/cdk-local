---
name: run-integ
description: Run an integration test (Docker-based, AWS-deploy-backed for the fixtures that own real AWS resources) and refresh the `integ` markgate marker on a clean run.
argument-hint: "<test-name>"
---

# Integration Test Runner

Run an integ test against real Docker — and, for fixtures that own real AWS
resources, a real CloudFormation stack. cdk-local deploys nothing itself: the
only AWS-side activity is a fixture's `verify.sh` calling `cdk deploy` (or
`aws s3api create-bucket`) to create a target stack for `--from-cfn-stack`, and
cleaning it up.

Rebase onto `origin/main` BEFORE spending a fixture run: a rebase afterwards
moves the merge base and stales the `integ` marker the run earned.

## Steps

1. **Build first**: `vp run build`. The fixture's `verify.sh` resolves the
   binary via `node ../../../dist/cli.js`, so source changes without a build
   have no effect.

2. **Resolve the fixture path**: `tests/integration/<test-name>/` (that
   directory lists the tests; with no name given, `AskUserQuestion` for one).
   Confirm `verify.sh` exists; if not, the test has no Docker-driven flow yet —
   exit with a clear error naming the missing script.

3. **Pre-flight Docker sweep**: `docker ps --filter name=cdkl- -q | wc -l` and
   `docker network ls --filter name=cdkl-task- -q | wc -l` must both return `0`.
   If not, abort and ask the user to run `/cleanup` — running on top of orphans
   causes name collisions.

4. **AWS pre-flight sweep** — run it for EVERY fixture, unconditionally:

   ```bash
   bash tests/integration/_lib/aws-orphan-sweep.sh <test-name>; rc=$?
   ```

   Do NOT decide yourself whether the fixture is AWS-resource-owning — name
   globs have silently excluded resource-owning fixtures. The script decides
   from one predicate against the fixture's own `verify.sh`; a fixture owning
   nothing makes no AWS call and exits 0 (`--list-owners` prints the set).

   When it reports the fixture AWS-owning (rc 0 with a `fixture=` line, not the
   "owns no real AWS resource" line), also run `which cdk`: the sweep checks
   that AWS is reachable, not that the fixture can deploy.

   **Gate on the exit code; never read the output and judge.**

   | rc | meaning | what to do |
   |----|---------|------------|
   | 0 | clean | proceed to step 5 |
   | 1 | usage / internal error | STOP. Nothing was concluded. Read the FATAL line. |
   | 2 | orphan found | STOP. Remediate — see below. |
   | 3 | indeterminate | STOP. A query could not run (no credentials, `aws` missing, unrecognized error). NOT clean. |
   | 4 | report-only | STOP, check by hand. An UNATTRIBUTABLE resource matched. |

   Non-zero: do NOT proceed, do NOT set the marker in step 9. The script's file
   header states the decisions it encodes, with reasons.

   **On rc=2 the script PRINTS the remediation plan. Run what it printed** — it
   names the SUFFIXED stacks (a base name matches nothing and reports success)
   and uses `aws cloudformation delete-stack`, never `cdk destroy`, which exits
   0 SILENTLY on a name the app never synthesized. Re-run the sweep afterwards:
   no delete command reports "I matched nothing".

   **First confirm it is not a LIVE peer**: a name under this lane's suffix can
   belong to a second run of the same fixture in the SAME worktree — check for a
   running `verify.sh` before deleting. Cross-worktree lanes cannot collide.
   **On rc=4** the match is a `froms3` bucket whose name carries no lane hash,
   so it may be a concurrent peer's LIVE bucket: reported, never attributed —
   delete only what you confirmed is yours.

5. **Run the test**: `bash tests/integration/<test-name>/verify.sh`. Propagate
   its exit code — a non-zero exit must drive this skill into the failure path
   so step 6 still fires. Never swallow a `verify.sh` failure.

   **Start it in the BACKGROUND on the FIRST attempt**, not after a foreground
   run dies: a foreground Bash call is capped at ten minutes, and a cold Docker
   cache spends most of that in the one-time `public.ecr.aws/lambda/*` pull. Use
   `run_in_background` with the BARE command — no trailing `&`, no `nohup`,
   which double-background and report the launcher's exit 0 while the real run
   is untracked — and REDIRECT output to a log:

   ```bash
   bash tests/integration/<test-name>/verify.sh > /tmp/integ-<test-name>.log 2>&1
   ```

   **Redirect, never `| tee`.** A pipeline's status is the LAST stage's, so
   `verify.sh … | tee log` reports `tee`'s success and a FAILING fixture arrives
   as rc=0 — a RED run would then satisfy step 9 and record the marker on a
   failure. With the redirect, `$?` is `verify.sh`'s own; backgrounded, the
   verdict is the exit status the completion notification reports.

   **Then POLL THE LOG; a completion notification is not a timer.** Nothing has
   a timeout, so from outside a stalled pull looks like a slow one. If the tail
   has not moved after a few minutes, kill the process tree (`pgrep -P` down to
   the `docker pull` pid), confirm 0 orphans via step 6, and re-run.

6. **Verify Docker cleanup** (mandatory regardless of pass/fail):

   ```bash
   docker ps --filter name=cdkl- -q | wc -l         # must be 0
   docker network ls --filter name=cdkl-task- -q | wc -l   # must be 0
   docker network ls --filter name=cdkl-svc- -q  | wc -l   # must be 0
   ```

   If any are non-zero, dispatch `/cleanup` (no `--detect-only`) and re-check.
   Never end a run with Docker orphans present.

7. **Verify AWS cleanup** — the SAME command as step 4, same exit-code gate:

   ```bash
   bash tests/integration/_lib/aws-orphan-sweep.sh <test-name>; rc=$?
   ```

   This run matters more than step 4's: it follows a long test where a session
   token can expire (exactly `rc=3`, NOT a clean one), and step 9 turns its
   verdict into the marker. Same table, same remediation, same live-peer check;
   re-run the sweep after any deletion and require rc=0.

8. **Report results**: pass/fail plus a one-line cleanup summary —
   `docker: 0 orphans, network: 0 orphans`, `AWS sweep: rc=0 (clean)`. QUOTE the
   sweep's own verdict line and exit code; a paraphrase is writable without
   having run anything.

9. **Set the `integ` markgate marker** — ONLY when `verify.sh` exited 0, step 6
   reports 0 docker orphans, and step 7's sweep exited **0** (1 / 2 / 3 / 4 are
   all stops; rc=3 means the sweep could not look, not that nothing is there):

   ```bash
   mise exec -- markgate set integ || echo "MARKER NOT RECORDED (rc=$?) — read the error"
   ```

   **Check the exit code; do not assume the set succeeded.** Under `hash: diff`
   it CAN fail, reporting why on stderr — an unchecked call looks successful
   while nothing was recorded:

   - `no delta against merge-base(origin/main, HEAD)` — you are on the base branch. Re-run from the PR's worktree, on the PR branch.
   - `base ref "origin/main" does not resolve` — `git fetch origin`, then set again. Re-running the integ does NOT help; the set fails identically until the ref exists.
   - `hash=diff recorded an empty in-scope delta` — a WARNING, not a failure: the marker WAS saved (exit 0). The branch just changes nothing under `src/**` / `tests/integration/**`.

   Confirm with `mise exec -- markgate status integ` (expect `state: match`).

   If any condition failed, do NOT set it. The `integ` gate (scope in
   `.markgate.yml`) blocks `gh pr merge` / `git merge` for any PR touching
   `src/**` or `tests/integration/**` until it is fresh. Markers are
   per-worktree: set it from the PR's own worktree, on the PR branch.

## Important

- **Never bypass this skill** by running a fixture's `verify.sh` from a shell,
  and **never call `markgate set integ` directly** — the marker is earned only
  by the full sequence above.
- The marker's 14-day TTL also bounds `hash: diff`'s blind spot: a branch
  changing A while `main` changed B produces no delta overlap, so only the TTL
  forces the re-run.
