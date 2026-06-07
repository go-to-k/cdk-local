# cdk-local (`cdkl`)

[![npm version](https://img.shields.io/npm/v/cdk-local.svg)](https://www.npmjs.com/package/cdk-local)
[![Downloads](https://img.shields.io/npm/dw/cdk-local.svg)](https://www.npmjs.com/package/cdk-local)
[![License: Apache-2.0](https://img.shields.io/npm/l/cdk-local.svg)](./LICENSE)

**Run your CDK-built app locally, no deploy needed — standalone, or kept local while it reaches the real AWS resources and data it depends on, with no `.env` or local copies to maintain.**
A CDK-native alternative to `sam local`, covering Lambda, API Gateway, ECS, ALB, CloudFront, and more of your CDK app's compute.

![cdkl start-api serving a local CDK app's HTTP API; curl in the right pane reaches the local Lambda](assets/cdkl-start-api.gif)

Or drive it all from a browser with `cdkl studio` — pick a target, invoke or serve it, and watch every request, response, and log line land on one live timeline:

![cdkl studio — a local web console: start an API in the per-target composer, compose an HTTP request (method / path / headers / body) against it, Send it, and the inline response plus the captured request and streamed container logs land on a live timeline](assets/cdkl-studio.gif)

## Quick start

Requires **Docker** (running) and **Node.js 20+**.

```bash
npm install -g cdk-local      # installs the `cdkl` command
cd your-cdk-app               # the directory holding cdk.json
cdkl invoke                   # pick a Lambda from the list, then run it locally
```

**Add `--from-cfn-stack`** to bind to a deployed stack — your handler still runs locally in Docker, but reads and writes against the real AWS the deployed app uses: DynamoDB, S3, Secrets, Cognito, and more (see [Why cdk-local](#why-cdk-local) below).

```bash
cdkl start-api --from-cfn-stack   # local API on real AWS data; JWT verified against the real Cognito User Pool
```

**Prefer a browser?** `cdkl studio` opens a local web console over the same targets — pick one, invoke or serve it, and watch every request, response, and log line on a live timeline.

```bash
cdkl studio                                # open the web console (no target needed)
```

## Why cdk-local

- **Zero-friction local execution** — run standalone with just Docker and your CDK app, no AWS account or deploy needed. Verify the parts of your app that don't touch AWS in seconds — handy as a zero-setup first run, or in CI where no credentials are available:
  - pure handler logic — validation, transforms, branching
  - Lambda authorizers, running in real local containers
  - API Gateway routing and request shaping
- **Iterate against your real deployed stack — including its data.** `--from-cfn-stack` reads the deployed CloudFormation stack and injects its real ARNs and Secret values into the container — no `.env` file to maintain, no manual ARN copy-paste — so you stay on the real DynamoDB rows, S3 objects, Cognito users, and Secret values your IAM credentials reach. An offline emulator can fake the API surface, but you'd still own the cost of seeding it:
  - dumping production data into a local DB
  - mirroring Secret values into local Secrets Manager
  - anonymizing fixtures across schema changes
  - scripting realistic Cognito test users

## What runs locally

cdk-local runs your **application compute** in Docker, using your CDK app as the source of truth.

It deliberately does NOT emulate AWS managed services: your code reaches DynamoDB / S3 / Secrets Manager / Cognito / SNS / SQS / etc. as **real AWS** through your IAM credentials (or pass `--assume-role <arn>` to assume a different role). Add `--from-cfn-stack` to also bind env vars to a deployed stack's real ARNs and Secret values.

The locally executable resources are listed under [Supported resources](#supported-resources).

## Commands

Run every `cdkl` command from your CDK project root (the directory containing `cdk.json`).

Every command takes its target two ways:

- **Leave it off** and cdk-local lists every matching target for you to pick with the arrow keys — no need to know or type the CDK path (`invoke` / `invoke-agentcore` / `start-agentcore` / `run-task` / `start-cloudfront` pick one; `start-service` / `start-alb` / `start-api` multi-select).
- **Or name it** — pass the CDK display path (e.g. `cdkl invoke MyStack/Fn`) or a stack-qualified logical ID (`MyStack:Fn1234ABCD`, the SAM-compatible form); single-stack apps may drop the stack prefix.

![cdkl invoke against a local sample CDK app — standalone, no deploy](assets/cdkl-invoke.gif)

`invoke` runs one Lambda in a real RIE container; the options you reach for most:

```bash
cdkl invoke --event ./event.json             # run with a JSON event payload
cdkl invoke --env-vars ./env.json            # overlay env vars (SAM-shape file)
cdkl invoke --from-cfn-stack                 # bind env to the deployed stack's real values
cdkl invoke --from-cfn-stack --assume-role   # ...and run as its deployed execution role
```

Per-command notes — full capabilities are in [Supported resources](#supported-resources):

- **`start-api`** serves one HTTP server per API; a bare `start-api` in a multi-stack app needs `--all-stacks` or `--stack <name>`.
- **`run-task`** runs one ECS task to completion; declared container ports publish on the host (a privileged port like 80 auto-remaps to a free high port with a WARN, or `--host-port <container>=<host>` pins one).
- **`start-service`** runs the service's replicas with no load balancer; a single-replica run publishes host ports the same way. Both `start-service` and `start-alb` print each host URL in a `Service endpoints:` banner after boot.
- **`start-alb`** stands up the ECS service(s) behind an ALB with full listener-rule routing, auth, and WebSocket proxying ([details](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally)).
- **`start-cloudfront`** serves the `viewer-request` -> origin -> `viewer-response` pipeline over S3 / Lambda Function URL origins, running CloudFront Functions and Lambda@Edge locally ([details](docs/cli-reference.md#cdkl-start-cloudfront-serve-a-cloudfront-distribution-locally)).
- **`invoke-agentcore`** runs a Bedrock AgentCore Runtime agent once ([details](docs/cli-reference.md#cdkl-invoke-agentcore-run-bedrock-agentcore-runtime-agents-locally)).
- **`start-agentcore`** serves an AgentCore Runtime warm — one container you hit repeatedly until `^C` ([details](docs/cli-reference.md#cdkl-start-agentcore-serve-an-agentcore-runtimes-http-contract--ws-locally)).
- **`studio`** opens a local web console over the same targets, no target needed: [Web console — `cdkl studio`](#web-console--cdkl-studio).
- Non-TTY (CI / pipes): every command except a bare `start-api` needs an explicit target.

The full command list:

```bash
cdkl invoke             # Lambda (ZIP or container image)
cdkl run-task           # ECS task, run once
cdkl start-service      # ECS service replicas (no load balancer)
cdkl start-alb          # ECS behind an ALB (front-door per listener)
cdkl start-api          # API Gateway REST v1 / HTTP v2 / WebSocket + Function URLs
cdkl start-cloudfront   # CloudFront: S3 / Lambda Function URL origins + Functions (static site / SPA / SSR)
cdkl invoke-agentcore   # Bedrock AgentCore Runtime (HTTP / MCP / A2A / AGUI)
cdkl start-agentcore    # serve an AgentCore Runtime warm: HTTP (POST /invocations + /ws) / MCP (POST /mcp) / A2A (POST /), repeatable
cdkl list               # every runnable target, grouped by command (alias: ls)
cdkl studio             # interactive web console over every target
```

Full flags, precedence, and `--from-cfn-stack` resolution: [docs/cli-reference.md](docs/cli-reference.md) and [docs/local-emulation.md](docs/local-emulation.md).

## Web console — `cdkl studio`

`cdkl studio` is a point-and-click front over the same runners — it takes no target and lists them all. Beyond running a target, it gives you what the CLI can't:

- a live timeline where every invocation and captured serve request lands, each with its container logs bound;
- replay — re-open any past row with an edited payload and re-invoke, or re-send a captured serve request.

A served WebSocket endpoint — an API Gateway WebSocket API, or an HTTP / AGUI AgentCore runtime's `/ws` from `start-agentcore` — also gets an interactive WebSocket console (connect / send / receive frames).

```bash
cdkl studio                                  # open the console (launches your browser)
cdkl studio --no-open                        # don't launch a browser; just print the URL
cdkl studio --studio-port 8200               # pin the port (default: auto-assigned)
cdkl studio --from-cfn-stack                 # bind the whole session to the deployed stack
cdkl studio --from-cfn-stack --assume-role   # ...and run every target as its deployed role
cdkl studio --watch                          # serves started from the UI hot-reload on source changes
cdkl studio --stack 'dev/*'                  # scope the displayed target list (multi-stack apps)
```

`--from-cfn-stack` / `--assume-role` / `--watch` are session-global and also editable live from the Session bar — they apply to every invoke / serve you start from the UI. The standard synth flags (`--app` / `--profile` / `--region` / `-c`) work here too.

Each target's composer surfaces its per-run options as controls:

- curated controls per kind — a Lambda's `--env-vars` as KEY/VALUE or JSON, ALB `--tls` / `--lb-port`, ECS `--max-tasks` / `--host-port`, an AgentCore runtime's `--ws` / `--sigv4` / `--bearer-token`;
- an **All options** panel with the underlying command's full flag set plus a raw extra-args input for anything not surfaced as a control;
- a Dockerfile picker for an ECS service pinned to a deployed registry (where local edits otherwise don't take effect), rebuilding it from local source.

## Deployed stack binding — `--from-cfn-stack`

`--from-cfn-stack` binds to the deployed CloudFormation stack whose name matches your CDK stack. The bare form resolves the stack name from the target; pass an explicit name only when the deployed CFn stack name differs (e.g. CDK's `stackName` prop was overridden):

```bash
cdkl invoke --from-cfn-stack                            # bare: uses resolved stack name
cdkl invoke --from-cfn-stack MyExplicitCfnName          # explicit when names differ
cdkl invoke --from-cfn-stack --stack-region eu-west-1   # cross-region CFn client
cdkl invoke --from-cfn-stack --assume-role              # auto-assume deployed execution role
```

Substitutes `Ref` / `Fn::ImportValue` / `Fn::GetStackOutput` in env vars with the deployed physical IDs / exports, decrypts `AWS::SSM::Parameter::Value` entries (kept off the `docker run` argv), and resolves same-stack ECR `ContainerUri` to the deployed image. `Fn::GetAtt` in the Lambda's own env is recovered from the deployed function's resolved `Environment.Variables` via `lambda:GetFunctionConfiguration`. Full resolution rules: [docs/cli-reference.md#cloudformation-driven-env-recovery---from-cfn-stack](docs/cli-reference.md#cloudformation-driven-env-recovery---from-cfn-stack).

## Environment variables — `--env-vars`

Every command except `start-cloudfront` (whose CloudFront Functions and Lambda@Edge have no env vars) accepts `--env-vars <file>`, a SAM-shape JSON file that overlays the container's environment — point a Lambda function or ECS container at a different backend for a local run, or supply a value the synthesized template only knows as an intrinsic:

```bash
cdkl invoke --env-vars ./env.json
cdkl start-service --env-vars ./env.json
cdkl start-alb --env-vars ./env.json
```

```json
{
  "Parameters": { "LOG_LEVEL": "debug" },
  "MyStack/Fn": { "TABLE_ENDPOINT": "http://localhost:8000" },
  "MyStack/Worker": { "WEBHOOK_URL": null },
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

## Hot reload — `--watch`

```bash
cdkl start-api --watch                       # reload API routes on save
cdkl start-service --watch                   # roll ECS replicas on save
cdkl start-alb --watch                       # roll ALB-fronted ECS replicas on save
cdkl start-cloudfront --watch                # reload CloudFront Functions + origins on save
cdkl invoke-agentcore --ws --watch           # reload an open /ws agent session
```

Edit a handler and the next request hits the new code — no server restart. ECS reloads roll replicas one at a time so the service stays available across the reload (an external request stream against the ALB listener port sees zero connection refusals, even on multi-replica services). Synth failures keep the previous replica(s) serving. `start-cloudfront --watch` swaps its CloudFront Functions and origins in place; its Lambda@Edge / Function URL warm containers are boot-time only, so restart to pick up changes to their code. Honors `cdk.json`'s `watch.include` / `watch.exclude` globs, so no separate `cdk watch` process is needed.

Reload classifier (interpreted-language fast path vs Dockerfile rebuild), shadow-replica TCP-probe timeout (`--shadow-ready-timeout`), and per-runtime caveats: [docs/local-emulation.md#hot-reload---watch](docs/local-emulation.md#hot-reload---watch).

## Local build override — `--image-override`

When a service's image is pinned to a deployed registry — `ContainerImage.fromEcrRepository(...)`, typical under `--from-cfn-stack` — `cdkl start-service` / `cdkl start-alb` run those deployed image bytes locally, so your source edits never take effect, even with `--watch`. `--image-override` rebuilds the image locally with `docker build` instead, so iteration works while real DynamoDB / Secrets / SSM stay wired in.

Boot in a TTY and the command walks each detected pinned target with an interactive Dockerfile picker:

```bash
cdkl start-alb --from-cfn-stack    # interactive boot prompt for each pinned target
```

Or name them up-front (CI / scripted setups), with build inputs:

```bash
cdkl start-alb --from-cfn-stack \
  --image-override AppService=./services/app/Dockerfile \
  --image-build-arg NODE_ENV=production \
  --image-build-secret npmrc=./.npmrc \
  --image-target builder
```

Per-service build inputs (`<svc>:KEY=VAL` for build-arg / build-secret, `<svc>=stage` for target), monorepo recipes, private-registry npmrc threading, `--no-interactive-overrides` / `--strict-overrides`, and the `--watch` rebuild loop: [docs/local-emulation.md#local-build-override---image-override](docs/local-emulation.md#local-build-override---image-override).

## start-service vs start-alb — which one?

Most CDK ECS apps boot multiple replicas behind an ALB. cdk-local exposes each layer separately so you can target the slice you care about:

| Goal | Command | How to reach |
|---|---|---|
| App logic / DB / response shape — hit the handler directly | `cdkl start-service --max-tasks 1 --host-port 80=8080` | `curl http://127.0.0.1:8080/...` |
| ALB routing — listener rules, host-header / path / method, default actions, redirects, fixed-response, weighted forwards, authenticate-cognito / authenticate-oidc | `cdkl start-alb --lb-port 443=8443 --tls` | `curl -H 'Host: api.example.com' https://127.0.0.1:8443/...` |
| Multi-replica rolling-reload + Cloud Map service discovery | `cdkl start-service` (multi-replica default) | Sibling container on the `cdkl-svc-` network |

**Why the extra flags on the simple case?** The template's `DesiredCount` (typically 3 in production) is honored locally by default, but N replicas can't all bind the same host port — so `start-service` skips host publishing for multi-replica runs and the app is reachable only from inside the `cdkl-svc-` docker network. To get the simple `curl http://127.0.0.1:...` access path:

- `--max-tasks 1` clamps the local replica count to 1 without touching your CDK code.
- A privileged declared host port (`< 1024`, e.g. 80) is auto-remapped to a free high host port — with a WARN naming the remap — because macOS Docker Desktop refuses to publish privileged ports and a `< 1024` host port needs root. `--host-port <containerPort>=<hostPort>` pins a specific host port instead.

`start-alb` uses the symmetric `--lb-port <listenerPort>=<hostPort>` for privileged listener ports like 80 / 443, and `--tls` (or `--tls-cert` / `--tls-key`) to terminate TLS locally instead of serving the HTTPS listener over plain HTTP (the default). Full resolution model: [docs/cli-reference.md](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally).

## Supported resources

| Resource | Local execution |
|----------|-----------------|
| Lambda functions (ZIP, container image, Function URLs) | `invoke` — every current Lambda runtime |
| API Gateway (REST v1, HTTP v2, WebSocket) + Lambda Function URLs | `start-api` |
| ECS task definitions | `run-task` |
| ECS services | `start-service` |
| Cloud Map / Service Connect registry | `start-service` / `start-alb` — service discovery between local replicas |
| ALB-fronted ECS / Lambda services | `start-alb` — HTTP / HTTPS listeners, all six listener-rule conditions, weighted forwards, redirect / fixed-response, mixed ECS + Lambda targets, authenticate-cognito / authenticate-oidc (local Bearer-JWT enforcement), WebSocket Upgrade |
| CloudFront distributions (S3 + Lambda Function URL origins + CloudFront Functions + Lambda@Edge) | `start-cloudfront` — **CloudFront Functions** (viewer-request / viewer-response) and **Lambda@Edge** (real RIE container, all four event types) over an S3 origin served from **local files** — the **BucketDeployment** source or a `--origin <id>=<dir>` dir — or from **real S3** on demand (`--from-cfn-stack`); plus Lambda Function URL origins, **KeyValueStore** reads, `ResponseHeadersPolicy` CORS, `--tls`, `--watch` ([details](docs/cli-reference.md#cdkl-start-cloudfront-serve-a-cloudfront-distribution-locally)) |
| Bedrock AgentCore Runtime agents | `invoke-agentcore` — container image (ECR) + `fromCodeAsset` / `fromS3` artifacts, HTTP / MCP / A2A / AGUI; `start-agentcore` — long-running warm serve of any runtime against one warm container (HTTP / AGUI: `POST /invocations` + `GET /ping` plus the `/ws` endpoint behind a header-injecting WebSocket bridge; MCP: `POST /mcp`; A2A: `POST /`) |

Lambda runs on every current AWS Lambda runtime — Node.js (18/20/22/24), Python (3.11–3.14), Ruby (3.2/3.3), Java (8.al2/11/17/21), .NET (6/8), and the OS-only `provided.al2` / `provided.al2023`. The retired `go1.x` runtime is rejected with a pointer to migrate to `provided.al2023`.

## Programmatic use

cdk-local also exports its commands as Commander factories so a host project can embed it into its own CLI, register custom state sources alongside the built-in `--from-cfn-stack`, and rebrand the embedded commands. See [docs/library-mode.md](docs/library-mode.md) for the API and an example.

## License

Apache-2.0
