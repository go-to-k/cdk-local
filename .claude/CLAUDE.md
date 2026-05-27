# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

**cdk-local** is a CDK-native local execution CLI. Bin name: `cdkl`, npm
package: `cdk-local`. Read your CDK app's `cdk.json`, synth it, and run the
synthesized Lambda functions / API Gateway routes / ECS tasks locally in
Docker — using real `public.ecr.aws/lambda/*` base images via the Lambda
Runtime Interface Emulator (RIE).

cdk-local is a **library + CLI** consumed by cdkd (and any other host that
wants CDK-app-aware local execution). The dependency direction is
**cdkd -> cdk-local** — cdk-local does NOT depend on cdkd.

## Scope: what runs locally, what doesn't

cdk-local runs your **application compute** locally; it does NOT emulate
AWS managed services.

### Runs locally (application compute)

- Lambda functions — your code in a real `public.ecr.aws/lambda/*`
  container via the Lambda Runtime Interface Emulator
- API Gateway routing — REST v1 / HTTP v2 / Function URL / WebSocket
  served by a local HTTP server
- ECS tasks and services — real Docker containers with awsvpc /
  Service Connect / Cloud Map registry
- API Gateway authorizers — Lambda authorizers, Cognito User Pool JWT
  verification, IAM SigV4 verification

### Calls real AWS (managed services)

- DynamoDB / S3 / Secrets Manager / SSM Parameter Store / Cognito user
  pool / SNS / SQS / Kinesis / EventBridge / Step Functions / etc.
- Your Lambda code talks to real AWS via:
  - `--assume-role <arn>` to inject IAM role credentials into the
    container
  - `--from-cfn-stack <stack>` to bind to a deployed CloudFormation
    stack and inject its real ARNs / Secret values into Lambda env
- cdk-local does NOT bundle a managed-service emulator. If you need
  offline emulation, pair cdk-local with a service emulator like
  LocalStack — they are complementary, not competing.

When writing committed artifacts (README, docs, commit messages, PR
bodies, JSDoc), keep to this scope. Do NOT add comparison tables vs
`aws-cdk-local` or LocalStack. The only public comparison the docs may
make is to `sam local` (same compute-locally category for Lambda + API
Gateway).

## Architecture

`src/` layout:

- `src/cli/` — Commander command factories (`createLocalInvokeCommand`,
  `createLocalStartApiCommand`, `createLocalRunTaskCommand`,
  `createLocalStartServiceCommand`) + shared option helpers.
- `src/synthesis/` — thin wrapper over `@aws-cdk/toolkit-lib`
  (`Toolkit.fromCdkApp()` + context store threading) that returns
  `StackInfo[]` for downstream consumers.
- `src/local/` — runtime layer: docker-runner, container-pool, http-server,
  websocket-server, ecs-task-runner, ecs-service-runner, ecs-network,
  cloud-map-registry, lambda-resolver, ecs-task-resolver,
  route-discovery, authorizer-resolver, lambda-authorizer, cognito-jwt,
  sigv4-verify, rie-client, intrinsic-image, runtime-image, etc.
- `src/assets/` — asset manifest loader + docker-build for container Lambdas.
- `src/types/` — shared interfaces (`StackState`, `ResourceState`,
  `CloudFormationTemplate`) — shaped as a strict subset of cdkd's state
  schema so host-side state can flow into cdk-local unchanged.

`tests/integration/local-*` — per-fixture real-Docker E2E tests
(`verify.sh` runs the CLI against a deployed-style fixture). cdk-local
itself does not invoke AWS; integration tests that need `--from-cfn-stack`
deploy via the upstream `cdk` CLI.

## Build and test commands

```bash
# Install (pnpm + vite-plus)
pnpm install

# Build (tsdown via vp pack)
vp run build

# Watch
vp run dev

# Typecheck
vp run typecheck

# Lint / format
vp run lint
vp run lint:fix
vp run format
vp run format:check

# Unified check (typecheck + lint + format-check)
vp run check

# Unit tests (vitest)
vp run test
vp run test:watch
vp run test:coverage

# verify = check + test + build
vp run verify

# Build artifact smoke test
vp run runtime:smoke
```

## Important implementation details

- **ESM Modules**: `package.json` declares `"type": "module"`. All imports
  must carry the `.js` extension even in TypeScript source:

  ```typescript
  import { foo } from './bar.js';  // OK
  import { foo } from './bar';     // wrong
  ```

- **Library + CLI dual entry**: `src/index.ts` (library exports) and
  `src/cli/index.ts` (binary entrypoint). `vp pack` produces both
  `dist/index.js` (library) and `dist/cli.js` (CLI).

- **Toolkit-lib integration**: `src/synthesis/assembly-reader.ts`
  delegates synthesis to `@aws-cdk/toolkit-lib`'s `Toolkit.fromCdkApp()`.
  CLI `-c key=value` overrides land in a `CdkAppMultiContext(workingDir,
  context)` so `cdk.json` / `cdk.context.json` / `~/.cdk.json` remain
  the base layer and overrides only win for keys they touch.

- **Node version**: `.node-version` pins to 24.x for dev / CI. `vp pack`
  targets `node20` for the shipped runtime — `package.json` engines
  declares `>=20`.

## Workflow rules

- **English only for committed files**: source, scripts, hook messages,
  configs (`.claude/settings.json`, `vite.config.ts`), docs, comments,
  commit messages, PR titles/bodies/comments, GitHub issue text. No
  Japanese characters (hiragana / katakana / kanji) in any committed
  artifact. Chat in the orchestrating session may be Japanese — this rule
  applies only to files / GitHub artifacts that land in the repo.

- **Never commit / push directly to `main`**: all changes via a feature
  branch + PR. Feature branches live under
  `.claude/worktrees/<branch>/`; use
  `git worktree add .claude/worktrees/<branch> -b <branch> origin/main`
  rather than branching in the main worktree (shared state across
  parallel agents).

- **Squash merge only**: prefer `gh pr merge <N> --squash --delete-branch`.
  PR #1 was squash-merged; keep the history flat.

- **Always add unit tests for new functionality**: don't wait to be
  asked. `tests/unit/**` mirrors `src/**`. Mock external boundaries
  (toolkit-lib, docker CLI, AWS SDK) with `vi.mock` / `vi.hoisted`.

- **After source changes**: run `vp run build` before reporting "ready
  to test" — users invoke cdk-local via `node dist/cli.js` (or the
  `cdkl` bin), so source changes without a build have no runtime
  effect.

- **Before opening a PR**: run `vp run verify` (= check + test + build).
  This is what CI runs; failing locally is faster feedback than failing
  in GitHub Actions.

## Positioning when communicating

- `cdkl` is the **binary** name (the command users type).
- `cdk-local` is the **npm package** name (what users import / install).
- When referring to the project in prose, use "cdk-local".
- When referring to the CLI command in code blocks / examples, use
  `cdkl invoke / start-api / run-task / start-service`.
- Do NOT write comparison tables against `aws-cdk-local` / `cdklocal` /
  LocalStack in committed artifacts (README, docs, JSDoc). The
  cdk-local vs LocalStack distinction is the
  "compute vs managed services" one above; lead with that, not with
  side-by-side tables.
- Do NOT reference cdkd internal implementation (deploy / destroy /
  state schema details / provider system) in cdk-local artifacts — the
  dependency direction is cdkd -> cdk-local, and cdk-local should read
  as self-contained.

## Reference

- `README.md` — user-facing intro + install + usage.
- `vite.config.ts` — vp tasks, lint / fmt / pack / test config.
- `.github/workflows/ci.yml` — CI (typecheck + lint + test + build +
  Node 20/22/24 matrix smoke).
