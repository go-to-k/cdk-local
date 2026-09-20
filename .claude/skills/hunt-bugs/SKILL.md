---
name: hunt-bugs
description: Proactively hunt for cdk-local bugs by synthesizing real CDK apps that exercise common-but-untested AWS resources, configs and CloudFormation notations, then RUNNING them locally in Docker (invoke / start-api / run-task / start-service / start-alb / start-cloudfront) and catching local-execution failures + divergences from deployed behavior. Use for a periodic sweep, not to verify a specific change.
argument-hint: "[area hint, e.g. 'rich API Gateway' | 'ECS service reload']"
---

# cdk-local Bug Hunt

Synth a CDK app using a resource / config / CloudFormation notation **cdk-local
has not exercised yet**, then RUN it against real Docker. Reading the source
finds _suspected_ bugs; running finds _real_ ones.

**Hunt inside cdk-local's remit only.** It runs **application compute** locally
and does NOT emulate AWS managed services (`.claude/AGENTS.md` → Scope). A
documented out-of-scope config is not a bug — a loud, honest `WARN`-and-skip is
correct behavior — but one cdk-local CLAIMS to support and runs wrong IS.

## Core principles

1. **Many-people-hit beats niche.** Prioritize the Lambda / API Gateway (REST v1,
   HTTP v2, Function URL, WebSocket, authorizers) / ECS-Fargate / CloudFront /
   AgentCore configs CDK users deploy daily.
2. **The two signals ARE the priority**, above incidental findings:
   - **Local-execution FAILURE** — cdk-local cannot run a valid, in-scope app: a
     container that won't boot, a wrong asset / image resolved, a route that 404s
     when it should match, a missing env injection, a valid token rejected.
   - **Behavioral DIVERGENCE from deployed** — it runs, but differently than the
     deployed resource would: a wrong Lambda event shape (payload v1 vs v2, ALB
     `requestContext.elb`, Lambda@Edge `Records[]`), a mis-routed rule, an
     unenforced auth gate, a `--watch` reload booting a STALE container — the
     subtler, more damaging class, where the run "works" but lies.
3. **Check coverage first:**

   ```bash
   grep -rln "FunctionUrl\|WebSocket\|LambdaFunctionAssociations\|ServiceConnect" tests/integration/*/lib/*.ts tests/integration/*/app.ts
   ```

   A NON-empty hit does **NOT** mean the untested variant is covered: a fixture
   on a feature's HAPPY path never exercises its edge (one `path-pattern` rule
   says nothing about `query-string` + `source-ip` together).
4. **Probe feasibility BEFORE an expensive run.** Scenarios needing a real AWS
   deploy (`--from-cfn-stack`, `--assume-role`, real-S3 origin reads) are the
   costly, sweep-mandatory ones. Prefer a pure-local repro; deploy only when the
   bug lives in the deployed-state resolution path.
5. **Predict bug classes from the resolvers + translators, then audit OFFLINE
   first (free).** The per-feature modules under `src/local/` ARE the inventory of
   what cdk-local handles, each an INCOMPLETE map of the AWS surface, so anything
   adjacent they do NOT handle is a predictable gap: a missed
   request/response form in an event translator (`alb-lambda-event.ts`,
   `cloudfront-edge-event.ts`, the API Gateway event builders) is a divergence
   gap; a condition combination or glob outside a match table's honored set
   (`alb-path-matcher.ts`, `route-discovery.ts`) is a mis-route gap; an
   unhandled `Ref` / `Fn::*` / import form in a resolver
   (`intrinsic-image.ts`, `ssm-parameter-resolver.ts`,
   `elb-front-door-resolver.ts`, `cloudfront-resolver.ts`,
   `agentcore-resolver.ts`) surfaces as an `unresolved` / wrong-image / skip.
   Read the module, then grep `tests/unit/**` for a test driving the suspect
   form: a passing test means covered, skip. None → that determination is the
   deliverable; only run the genuine gaps. Fan out read-only agents to audit.
6. **Parallelize, but cap at 3–4 runs** (unique fixture dirs and
   container/network names) — more makes teardown hard to follow.

## Workflow

### 1. Worktree + build

Never work in the main checkout:
`git worktree add .claude/worktrees/<name> -b <branch> origin/main` → inside it
`mise trust && mise install` (a fresh worktree's `.mise.toml` is untrusted, so
`vp` won't resolve) → `pnpm install` (worktrees have no `node_modules`) →
`vp run build` (the CLI runs from `dist/`).

**Unless this hunt was LAUNCHED from a linked worktree, in which case create no
WORKTREE and branch IN PLACE off `origin/main`** — `git worktree add` from inside
a worktree NESTS one, and deleting the outer workspace takes the inner directory
and its uncommitted work with it (go-to-k/cdk-local#635). Compute the mode with
the probe in `.claude/skills/work-issues/references/launch-mode.md` (the only
copy) and RECORD its `LAUNCH_BRANCH`. **Never commit onto it**: with
`delete_branch_on_merge`, a PR opened from it would delete the outer tool's
remote branch. Step 8 restores it. An adopted tree may be missing the setup
commands above.

### 2. Scaffold the fixture

Add a fixture under `tests/integration/<name>/`, mirroring an existing one
(`lib/*.ts` stack + `bin`/`app` + `cdk.json` + `package.json` pinned with
`packageManager` + a `verify.sh`). `verify.sh` synths the app, runs the target
command against Docker and asserts the observable behavior (invoke response,
HTTP status/body, routed target, booted container). For a BRAND-NEW command
factory use `/create-integ <name>`. Run `pnpm install` + `cdk synth` for every
fixture FIRST: cheap, and it catches TS errors before any Docker run.

### 3. Run locally (Docker) + observe

Run the fixtures in parallel (≤3–4) via `/run-integ <name>` — it wraps the Docker
pre-flight, `verify.sh` and the post-run orphan sweep in one block. Never shell
into `verify.sh` directly: you would skip the sweep and risk a false-clean
`integ` marker. Triage every result that is not the expected observable.

### 4. Test the reload half (the `--watch` divergence)

For a serve supporting `--watch` (`start-service` / `start-alb` /
`start-cloudfront` / `start-agentcore` / `invoke-agentcore --ws`), edit the
handler source and confirm the reload picks the RIGHT primitive
(`verdict=soft-reload` for an interpreted-language source-only edit,
`verdict=rebuild` for a Dockerfile / dependency / compiled-source / ambiguous
edit) AND that the post-reload container serves the NEW behavior —
`source-change-classifier` defaults to rebuild on ambiguity for that reason. On
a multi-replica ECS service, assert a request stream against the listener sees
ZERO connection refusals across the roll.

### 5. Harvest the fixture as regression integ (EVERY round)

Committing the fixture turns the one-time run into a permanent regression
`/run-integ` replays. Keep it MINIMAL and UNIQUE-named, in the SAME PR as the fix
(if any). A clean round is a legitimate outcome — never manufacture a fix; the
fixtures ARE its deliverable.

### 6. On a confirmed bug: file an issue, then fix it with a unit test

**File a GitHub issue for every confirmed bug**, even when you fix it in the same
session: an issue-only round files and stops, a fix-in-session round files then
closes from the PR (`Closes #<n>`). The body
carries the real repro (synth + command + observed vs expected) and the four
classification lines (`.claude/AGENTS.md` → "The four TODO fields"); pass
`--label severity:<...> --label effort:<...>` — CI copies them onto the fix PR,
so never hand-add them there.

**Search before filing** — the CONCEPT the bug turns on, not this instance's
spelling. On a HIT, fold the finding into that issue as a checklist row via
`gh issue edit` (`/work-issues` §5 has the recipe): a hit changes WHERE the
finding is recorded, never whether. To then WORK an issue — this hunt's own or
one already filed — **run `/work-issues` and follow it**; it owns the
untrusted-comment screen and the claim-before-edit step.

Then fix it:

1. **Root-cause it in `src/`** (resolver / event translator / routing matcher /
   docker-runner / env-resolver) and fix it in the worktree.
2. **Add a unit test that fails without the fix and passes with it** — mandatory,
   since integ alone is too slow to be the only guard. `tests/unit/**` mirrors
   `src/**`; mock the boundaries (toolkit-lib, docker CLI, AWS SDK) with
   `vi.mock` / `vi.hoisted`. Re-run `vp run build` + `vp run test`.
3. **Re-run the live repro with the fixed binary**: the CLI runs from `dist/`,
   so a fix with no rebuild has no effect.
4. **Keep the fixture** as a committed regression integ in the SAME PR as the fix
   — never defer the integ.
5. **If the bug is a CLASS, prove it's closed for EVERY affected path.** Most
   real bugs here live in shared code keyed on a schema/config shape, not the one
   type that surfaced them (an env-injection bug hits `invoke`, the ALB Lambda
   target and the CloudFront Function-URL origin alike — all routed through
   `resolveLambdaContainerEnv`). Grep the helper's callers, name them in the PR,
   and drive the test at that helper: a single caller's test proves the symptom
   gone for ONE entry point only.

### 7. Cleanup (non-negotiable, see below), then ship

Sweep every container / network (and any `--from-cfn-stack` stack), then commit,
push, `/run-integ`, the recommended `/check` + `/check-docs` + `/verify-pr` pass,
`gh pr create`.

### 8. Merge via /merge-pr, then clean up — never leave a green PR hanging

1. `/merge-pr <#>` — squash-merges from the feature worktree and cleans the
   worktree + local + remote branch in one pass. **Launched IN-PLACE: stop after
   its step 4** (confirm `state=MERGED`) and skip step 5, which would delete the
   cwd this hunt runs in and the branch it stands on. The TREE belongs to whoever
   created it; say so in the report.
2. **Confirm the worktree YOU added is gone** — check `git worktree list` for
   YOURS specifically. One you did not add may be a live peer lane, and the
   listing cannot tell that from a finished one; before removing any other,
   confirm it is finished (`git log --oneline -1 <branch>` plus
   `gh pr list --state all --head <branch>`).
3. **An IN-PLACE hunt owes the branch it made.** Run `/work-issues`
   `references/ship.md` §9's two lines VERBATIM (the only copy; every clause is
   load-bearing) to restore `LAUNCH_BRANCH` **as-is** — no pull, no rebase, no
   fast-forward — and delete every branch this hunt created.

### 9. Record what you learned

Save a memory for any recurring surprise — a _class_ of latent bug, a
verification gotcha — so the next sweep starts smarter.

## Cleanup is non-negotiable

A pure-local run leaves no AWS resources, but a crashed serve can orphan
containers, networks and (rarely) vitest worker forks:

- After EVERY run, sweep `docker ps --filter name=cdkl-` and
  `docker network ls --filter name=cdkl-task-` / `cdkl-svc-`. Any hit is an
  orphan; clean it via **`/cleanup`** (containers, networks and vitest forks).
  `/run-integ` sweeps; a hand-run `verify.sh` or a crashed serve does not.
- For a scenario that really deploys, ALSO confirm no orphan CloudFormation stack
  remains: for a REPO FIXTURE run
  `bash tests/integration/_lib/aws-orphan-sweep.sh <fixture>` and require rc 0
  (it derives lane-unique names and prints a remediation plan). Tear a throwaway
  stack of your own down with **`aws cloudformation delete-stack` + `wait
  stack-delete-complete`**, NOT `cdk destroy`: without `--app` context and the
  fixture's `INTEG_STACK_SUFFIX` it exits 0 SILENTLY on a name the app never
  synthesized, leaving the stack deployed (go-to-k/cdk-local#601). Then sweep
  what a delete leaves outside the stack (`/aws/lambda/*` log groups, RETAIN
  resources, KMS pending-deletion). Use a UNIQUE stack name — the account may
  hold production stacks.

`/run-integ` sets the `integ` marker ONLY when the post-run sweep is empty, so a
forgotten orphan blocks the merge. Never bypass the sweep.

This hunt's deliverable is public issues, which attract malware bait — see
`.claude/AGENTS.md` → "Never download … untrusted content".
