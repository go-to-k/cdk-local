# cdk-local

[![npm version](https://img.shields.io/npm/v/cdk-local.svg)](https://www.npmjs.com/package/cdk-local)
[![Downloads](https://img.shields.io/npm/dw/cdk-local.svg)](https://www.npmjs.com/package/cdk-local)
[![CI](https://github.com/go-to-k/cdk-local/actions/workflows/ci.yml/badge.svg)](https://github.com/go-to-k/cdk-local/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/npm/l/cdk-local.svg)](./LICENSE)

**Run your CDK-built app locally, no deploy needed — standalone, or kept local while it reaches the real AWS resources and data it depends on, with no `.env` or local copies to maintain.**
A CDK-native alternative to `sam local`, covering Lambda, API Gateway, ECS, ALB-fronted services, and Bedrock AgentCore.

![cdkl start-api serving a local CDK app's HTTP API; curl in the right pane reaches the local Lambda](assets/cdkl-start-api.gif)

## Quick start

Requires **Docker** (running) and **Node.js 20+**.

```bash
npm install -g cdk-local      # installs the `cdkl` command
cd your-cdk-app               # the directory holding cdk.json
cdkl invoke                   # pick a Lambda from the list, then run it locally
```

`cdkl` synths your CDK app and runs the selected resource locally in Docker. Run any command with no target and it opens an arrow-key picker, so you rarely type a CDK path.

**Add `--from-cfn-stack`** to bind to a deployed stack — your handler still runs locally in Docker, but reads and writes against the real DynamoDB / S3 / Secrets the deployed app uses (see [Why cdk-local](#why-cdk-local) below).

```bash
cdkl start-api --from-cfn-stack            # local API on real AWS data; JWT verified against the real Cognito User Pool
cdkl invoke MyStack/Fn --from-cfn-stack    # one Lambda against real DynamoDB / S3 / Secrets
```

## Why cdk-local

- **Zero-friction local execution** — run standalone with just Docker and your CDK app, no AWS account or deploy needed. Verify the parts of your app that don't touch AWS in seconds — handy as a zero-setup first run, or in CI where no credentials are available:
  - API Gateway routing and request shaping
  - Lambda authorizers, running in real local containers
  - pure handler logic — validation, transforms, branching
- **Iterate against your real deployed stack — including its data.** `--from-cfn-stack` reads the deployed CloudFormation stack and injects its real ARNs and Secret values into the container — no `.env` file to maintain, no manual ARN copy-paste — so you stay on the real DynamoDB rows, S3 objects, Cognito users, and Secret values your IAM credentials reach. An offline emulator can fake the API surface, but you'd still own the cost of seeding it:
  - dumping production data into a local DB
  - mirroring Secret values into local Secrets Manager
  - anonymizing fixtures across schema changes
  - scripting realistic Cognito test users

## What runs locally

cdk-local runs your **application compute** in Docker, using your CDK app as the source of truth. It deliberately does NOT emulate AWS managed services: your code reaches DynamoDB / S3 / Secrets Manager / Cognito / SNS / SQS / etc. as **real AWS** through your IAM credentials (or pass `--assume-role <arn>` to assume a different role). Add `--from-cfn-stack` to also bind env vars to a deployed stack's real ARNs and Secret values.

The locally executable resources are listed under [Supported resources](#supported-resources).

## Commands

Run every `cdkl` command from your CDK project root (the directory containing `cdk.json`).

Run any command with no target for an arrow-key picker (`invoke` / `run-task` pick one; `start-service` / `start-alb` / `start-api` multi-select). Or name a target — the CDK display path (recommended) or a stack-qualified logical ID (`MyStack:Fn1234ABCD`, the SAM-compatible form); single-stack apps may drop the stack prefix.

```bash
cdkl invoke MyStack/Fn --event ./event.json   # Lambda (ZIP or container image)
cdkl run-task MyStack/Task                     # ECS task, run once
cdkl start-service MyStack/Worker              # ECS service replicas (no load balancer)
cdkl start-alb MyStack/WebAlb                  # ECS behind an ALB (front-door per listener)
cdkl start-api MyStack/Api                     # API Gateway REST v1 / HTTP v2 / WebSocket + Function URLs
cdkl invoke-agentcore MyStack/Agent            # Bedrock AgentCore Runtime (HTTP / MCP / A2A / AGUI)
cdkl list                                      # every runnable target, grouped by command (alias: ls)
```

![cdkl invoke against a local sample CDK app — standalone, no deploy](assets/cdkl-invoke.gif)

- **`start-api`** serves one HTTP server per API; a bare `start-api` in a multi-stack app needs `--all-stacks` or `--stack <name>`.
- **`run-task`** / single-replica **`start-service`** publish declared container ports on the host (`--host-port <container>=<host>` remaps; handy for privileged ports on macOS). **`start-service`** / **`start-alb`** also list each host URL in a `Service endpoints:` banner after boot so the access URL stays visible.
- **`start-alb`** stands up the ECS service(s) behind an ALB plus a host-side front-door on each listener port, honoring all six listener-rule conditions, weighted forwards, redirect / fixed-response actions, mixed ECS + Lambda targets, `authenticate-cognito` / `authenticate-oidc` actions (local Bearer-JWT enforcement), and WebSocket `Upgrade` proxying to ECS targets ([details](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally)).
- **`invoke-agentcore`** invokes a Bedrock AgentCore Runtime agent locally — container or `fromCodeAsset` / `fromS3` managed runtime, all four runtime protocols (HTTP and AGUI on 8080, MCP on 8000, A2A on 9000; SSE and WebSocket are HTTP wire-shape variants on the same 8080 container), with `customJwtAuthorizer` and `--sigv4` enforcement ([details](docs/cli-reference.md#cdkl-invoke-agentcore-run-bedrock-agentcore-runtime-agents-locally)).
- Non-TTY (CI / pipes): every command except a bare `start-api` needs an explicit target.

Full flags, precedence, and `--from-cfn-stack` resolution: [docs/cli-reference.md](docs/cli-reference.md) and [docs/local-emulation.md](docs/local-emulation.md).

### Deployed stack binding — `--from-cfn-stack`

`--from-cfn-stack` binds to the deployed CloudFormation stack whose name matches your CDK stack. The bare form resolves the stack name from the target; pass an explicit name only when the deployed CFn stack name differs (e.g. CDK's `stackName` prop was overridden):

```bash
cdkl invoke MyStack/Fn --from-cfn-stack                              # bare: uses resolved stack name
cdkl invoke MyStack/Fn --from-cfn-stack MyExplicitCfnName            # explicit when names differ
cdkl invoke MyStack/Fn --from-cfn-stack --stack-region eu-west-1     # cross-region CFn client
cdkl invoke MyStack/Fn --from-cfn-stack --assume-role                # auto-assume deployed execution role
```

Substitutes `Ref` / `Fn::ImportValue` / `Fn::GetStackOutput` in env vars with the deployed physical IDs / exports, decrypts `AWS::SSM::Parameter::Value` entries (kept off the `docker run` argv), and resolves same-stack ECR `ContainerUri` to the deployed image. `Fn::GetAtt` in the Lambda's own env is recovered from the deployed function's resolved `Environment.Variables` via `lambda:GetFunctionConfiguration`. Full resolution rules: [docs/cli-reference.md#cloudformation-driven-env-recovery---from-cfn-stack](docs/cli-reference.md#cloudformation-driven-env-recovery---from-cfn-stack).

### Environment variables — `--env-vars`

Every command accepts `--env-vars <file>`, a SAM-shape JSON file that overlays the container's environment — point a Lambda function or ECS container at a different backend for a local run, or supply a value the synthesized template only knows as an intrinsic:

```bash
cdkl invoke MyStack/Fn --env-vars ./env.json
cdkl start-service MyStack/MyService --env-vars ./env.json
cdkl start-alb MyStack/MyAlb --env-vars ./env.json
```

```json
{
  "Parameters": { "LOG_LEVEL": "debug" },
  "MyStack/Fn": { "TABLE_ENDPOINT": "http://localhost:8000", "PROD_FEATURE_FLAG": null },
  "AppContainer": { "DB_HOST": "host.docker.internal", "DB_PORT": "13306" }
}
```

Each top-level JSON key picks which target to overlay:

| Target | Key shape | Notes |
| --- | --- | --- |
| Every target | `Parameters` | Reserved literal; applied first to every container |
| Lambda / AgentCore Runtime | CDK construct path (e.g. `MyStack/Fn`) | From `Metadata['aws:cdk:path']` of the resource; prefix-matched (`MyStack/Fn` also catches `MyStack/Fn/Resource`) |
| Lambda / AgentCore Runtime | CloudFormation logical ID (e.g. `MyStackFn1A2B3C`) | Top-level resource key in the synthesized template; exact match |
| ECS container | Container Name (e.g. `AppContainer`) | `ContainerDefinitions[].Name` in the synthesized TaskDefinition — explicitly set via the `containerName` option of `taskDef.addContainer(id, { containerName, ... })`, or defaults to the construct id (first arg of `addContainer`) when omitted. The TaskDefinition's CDK path / logical ID is NOT accepted as a key — it would identify the TaskDef but not which container's env block to overlay |

`--env-vars` overlays the env block after the template's literals and any resolved ECS `Secrets[]` have been applied. A per-target key (from the table above) wins over `Parameters`. A `null` value clears the key — use the JSON literal `null`, not the string `"null"`.

`--env-vars` can be combined with `--from-cfn-stack`: the latter resolves intrinsics (`Ref` / `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::GetAtt`) against the deployed stack first, then `--env-vars` overlays your overrides on top. Running standalone (no `--from-cfn-stack`), env vars whose template value is an intrinsic can't be resolved and are dropped with a warning — `--env-vars` is how you supply a concrete value for them.

When pointing a container at a tunneled VPC resource (e.g. an Aurora cluster reached via a local port forward), use `host.docker.internal` instead of `127.0.0.1` — `127.0.0.1` inside the container is the container itself, not the host where the tunnel listens.

### Hot reload — `--watch`

```bash
cdkl start-api --watch                       # reload API routes on save
cdkl start-service --watch                   # roll ECS replicas on save
cdkl start-alb --watch                       # roll ALB-fronted ECS replicas on save
cdkl invoke-agentcore --ws --watch           # reload an open /ws agent session
```

`cdkl start-api --watch` re-synths your CDK app and reloads routes when the source changes, so editing a handler is reflected on the next request without restarting the server. Synth failures keep the previous version serving (warn-and-continue). Honors `cdk.json`'s `watch.include` / `watch.exclude` globs, so no separate `cdk watch` process is needed.

`cdkl start-service --watch` and `cdkl start-alb --watch` bring the same edit-and-go loop to ECS services. A source-only edit on an interpreted-language handler (Node / Python / Ruby / shell) takes a sub-second fast path; a Dockerfile / dependency / compiled-source change triggers a rolling rebuild. Either way replicas roll one at a time, so the service stays available — an external request stream against the ALB listener port sees zero connection refusals, even on multi-replica services. Synth failures keep the previous replica(s) serving.

`cdkl invoke-agentcore --watch` is wired for the long-running `--ws` session path. `--ws` adapts to its stdin: in a TTY it auto-attaches a multi-turn REPL (each typed line becomes one follow-up WS frame), in CI / piped input it stays one-shot. On a source change the same classifier picks the per-firing primitive (`docker cp` + `docker restart` for interpreted-language source edits; rebuild for Dockerfile / dependency / compiled-source / ambiguous edits). The active `/ws` socket is closed cleanly on every reload firing (AgentCore has no protocol-defined mid-session container handoff) so the next session connects to the rebuilt container. `--watch` on the single-shot HTTP `POST /invocations`, MCP `POST /mcp`, and A2A `POST /` paths logs a one-line WARN and proceeds single-shot.

The rebuild path waits for the freshly-built shadow replica's first essential-container port to accept a TCP connection before swapping registrations. The default budget is 60s, which covers realistic prod-shaped Node app cold-starts (TS->JS compile, full `node_modules` graph, framework boot, DB pool init). If the reload log surfaces `TCP probe <ip>:<port> did not accept within <N>ms`, bump it via `--shadow-ready-timeout 120000` (or set `CDKL_SHADOW_READY_TIMEOUT_MS=120000`) — typical for Java / heavy ORM init / `--inspect-brk` attach pauses.

Full reload pipeline + glob defaults: [docs/local-emulation.md#hot-reload---watch](docs/local-emulation.md#hot-reload---watch).

### Local build override — `--image-override`

`cdkl start-service` / `cdkl start-alb` against an ECS service whose CDK source uses `ContainerImage.fromEcrRepository(...)` (typical under `--from-cfn-stack`) runs the deployed image bytes locally — local source edits don't take effect, even with `--watch`. `--image-override` swaps in a local `docker build` of a supplied Dockerfile per service target so iteration still works while real DynamoDB / Secrets / SSM stay wired in.

Lead form — boot in a TTY and the command walks each detected pinned target:

```bash
cdkl start-alb --from-cfn-stack    # interactive boot prompt for each pinned target
```

```
? Detected pinned image on 'AppService' (123…/repo:4.5.1).
  Override with a local build?
    >  ./Dockerfile
       ./services/app/Dockerfile
       ./services/auth/Dockerfile
       (Enter custom path)
       (Skip — use ECR pin)
```

When cdk-local finds at least one `Dockerfile` / `Dockerfile.*` under your cwd (top 10 by mtime, excluding `node_modules` / `.git` / `cdk.out` / `dist` / `.next` / `.cache` / `build` / `coverage` / `.turbo` / `.vite`), it offers them as a picker. Otherwise the prompt falls back to free-text — type a Dockerfile path, or `N` (any case) / blank to skip the target. The intro line explaining what the prompt does + the `--no-interactive-overrides` opt-out surfaces once per session.

Or name them up-front (CI / scripted setups):

```bash
cdkl start-alb --from-cfn-stack \
  --image-override AppService=./services/app/Dockerfile \
  --image-override AuthService=./services/auth/Dockerfile
```

A bare `--image-override <dockerfile>` (no `=`) opens a multi-select picker against the pinned targets — useful when one Dockerfile is shared across several services. Mix freely with explicit forms in one invocation.

Pass build inputs through to every override:

```bash
cdkl start-alb --from-cfn-stack \
  --image-override AppService=./Dockerfile \
  --image-build-arg NODE_ENV=production \
  --image-build-secret npmrc=./.npmrc \
  --image-target builder
```

`--image-build-secret npmrc=./.npmrc` wires a private-registry token into a Dockerfile that uses `RUN --mount=type=secret,id=npmrc` — the canonical recipe for installing private packages during the local build. The `src=` path resolves against the directory you ran `cdkl` from (not the Dockerfile's parent), so `./.npmrc` means "the `.npmrc` next to your `cdk.json`" regardless of where the Dockerfile lives in the tree. A leading `~` / `~/` is expanded to your home directory so `--image-build-secret npmrc=~/.npmrc` (the POSIX-canonical npm credentials path) works the same way whether the shell pre-expanded it or not. The same expansion applies to `--image-override <svc>=~/path/Dockerfile`. Named-user tildes (`~user/foo`) are passed through literally — Node has no built-in for that shape.

`--image-build-arg KEY=` (empty value) is accepted and forwarded verbatim to `docker build --build-arg KEY=` — the canonical way to unset a Dockerfile `ARG`'s default. Empty KEY (e.g. `--image-build-arg =val`) is rejected.

**Per-service build inputs (monorepo case).** When two overridden services need different build args, secrets, or target stages, prefix the value with the service name. The per-service form wins over the global on the same target:

```bash
cdkl start-alb --from-cfn-stack \
  --image-override AppService=./services/app/Dockerfile \
  --image-override Reporting=./services/reporting/Dockerfile \
  --image-build-secret AppService:npmrc=./.npmrc-private \
  --image-build-secret Reporting:npmrc=./.npmrc-public \
  --image-target AppService=builder \
  --image-target Reporting=runtime
```

Syntax convention: flags whose payload already contains `=` (`--image-build-arg`, `--image-build-secret`) use `:` to separate the service prefix from the `<key>=<value>` payload — `<service>:<key>=<value>`. Flags whose payload is a single token (`--image-target`) use `=` — `<service>=<stage>` (matches the `--image-override <service>=<dockerfile>` convention). A per-service flag whose service name has no matching `--image-override` mapping (and no boot-prompt-injected mapping) is a boot error so a typo can't silently get ignored.

Opt-outs:

- `--no-interactive-overrides` suppresses the boot prompt + the multi-select picker; the override map is whatever explicit `--image-override <svc>=<dockerfile>` flags resolved to. Useful for scripted invocations.
- `--strict-overrides` fails fast at boot if any pinned target remains uncovered. Off by default; the per-target WARN (which fires on any cold start when an ECR pin is detected, not just under `--watch`) still surfaces regardless.

Under `--watch`, every reload re-runs `docker build` for each covered Dockerfile, then rolls the replicas through the rebuild primitive — so a source edit picked up by the Dockerfile's `COPY` flips the content-addressed tag and the new image bytes serve immediately. The Stage 1 picker / Stage 3 boot prompt are NOT re-fired on reload (resolved once at boot); a per-target rebuild failure logs a warn and keeps the old replica serving while sibling targets continue rolling.

### start-service vs start-alb — which one?

Most CDK ECS apps boot multiple replicas behind an ALB. cdk-local exposes each layer separately so you can target the slice you care about:

| Goal | Command | How to reach |
|---|---|---|
| App logic / DB / response shape — hit the handler directly | `cdkl start-service --max-tasks 1 --host-port 80=8080` | `curl http://127.0.0.1:8080/...` |
| ALB routing — listener rules, host-header / path / method, default actions, redirects, fixed-response, weighted forwards, authenticate-cognito / authenticate-oidc | `cdkl start-alb --lb-port 443=8443 --tls` | `curl -H 'Host: api.example.com' https://127.0.0.1:8443/...` |
| Multi-replica rolling-reload + Cloud Map service discovery | `cdkl start-service` (multi-replica default) | Sibling container on the `cdkl-svc-` network |

**Why the extra flags on the simple case?** The template's `DesiredCount` (typically 3 in production) is honored locally by default, but N replicas can't all bind the same host port — so `start-service` skips host publishing for multi-replica runs and the app is reachable only from inside the `cdkl-svc-` docker network. To get the simple `curl http://127.0.0.1:...` access path:

- `--max-tasks 1` clamps the local replica count to 1 without touching your CDK code.
- `--host-port <containerPort>=<hostPort>` remaps the container port to a non-privileged host port (macOS Docker Desktop needs `sudo` for ports < 1024).

`start-alb` uses the symmetric `--lb-port <listenerPort>=<hostPort>` for privileged listener ports like 80 / 443, and `--tls` (or `--tls-cert` / `--tls-key`) to terminate TLS locally instead of serving the HTTPS listener over plain HTTP (the default). Full resolution model: [docs/cli-reference.md](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally).

## Supported resources

| Resource | Local execution |
|----------|-----------------|
| Lambda functions (ZIP, container image, Function URLs) | `invoke` — every current Lambda runtime |
| API Gateway (REST v1, HTTP v2, WebSocket) + Lambda Function URLs | `start-api` |
| ECS task definitions | `run-task` |
| ECS services | `start-service` |
| Cloud Map / Service Connect registry | service discovery between local replicas |
| ALB-fronted ECS / Lambda services | `start-alb` — HTTP / HTTPS listeners, all six listener-rule conditions, weighted forwards, redirect / fixed-response, mixed ECS + Lambda targets, authenticate-cognito / authenticate-oidc (local Bearer-JWT enforcement), WebSocket Upgrade |
| Bedrock AgentCore Runtime agents | `invoke-agentcore` — container + `fromCodeAsset` / `fromS3` artifacts, HTTP / MCP / A2A / AGUI |

Lambda runs on every current AWS Lambda runtime — Node.js (18/20/22/24), Python (3.11–3.14), Ruby (3.2/3.3), Java (8.al2/11/17/21), .NET (6/8), and the OS-only `provided.al2` / `provided.al2023`. The retired `go1.x` runtime is rejected with a pointer to migrate to `provided.al2023`.

## Programmatic use

cdk-local also exports its commands as Commander factories so a host project can embed it into its own CLI, register custom state sources alongside the built-in `--from-cfn-stack`, and rebrand the embedded commands. See [docs/library-mode.md](docs/library-mode.md) for the API and an example.

## License

Apache-2.0
