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
cdkl start-api --from-cfn-stack            # a local API on real AWS data + real Cognito JWT
cdkl invoke MyStack/Fn --from-cfn-stack    # one Lambda against real DynamoDB / S3 / Secrets
```

## Why cdk-local

- **Zero-friction local execution** — run standalone with just Docker and your CDK app, no AWS account or deploy needed. Verify the parts of your app that don't touch AWS in seconds — handy as a zero-setup first run, or in CI where no credentials are available:
  - API Gateway routing and request shaping
  - Lambda authorizers, running in real local containers
  - pure handler logic — validation, transforms, branching
- **Iterate against your real deployed stack — including its data.** `--from-cfn-stack` reads the deployed CloudFormation stack and injects its real ARNs, Secret values, and IAM credentials into the container — no `.env` file to maintain, no manual ARN copy-paste — so you stay on the real DynamoDB rows, S3 objects, Cognito users, and Secret values your IAM credentials reach. An offline emulator can fake the API surface, but you'd still own the cost of seeding it:
  - dumping production data into a local DB
  - mirroring Secret values into local Secrets Manager
  - anonymizing fixtures across schema changes
  - scripting realistic Cognito test users

## What runs locally

cdk-local runs your **application compute** in Docker, using your CDK app as the source of truth. It deliberately does NOT emulate AWS managed services: your code reaches DynamoDB / S3 / Secrets Manager / Cognito / SNS / SQS / etc. as **real AWS** through your IAM credentials (`--assume-role`, or `--from-cfn-stack` to bind to a deployed stack).

The locally executable resources are listed under [Supported resources](#supported-resources).

## Commands

Run any command with no target for an arrow-key picker (`invoke` / `run-task` pick one; `start-service` / `start-alb` / `start-api` multi-select). Or name a target — the CDK display path (recommended) or a stack-qualified logical ID (`MyStack:Fn1234ABCD`, the SAM-compatible form); single-stack apps may drop the stack prefix.

```bash
cdkl invoke MyStack/Fn --event ./event.json   # Lambda (ZIP / container image / Function URL)
cdkl run-task MyStack/Task                     # ECS task, run once
cdkl start-service MyStack/Worker              # ECS service replicas (no load balancer)
cdkl start-alb MyStack/WebAlb                  # ECS behind an ALB (front-door per listener)
cdkl start-api MyStack/Api                     # API Gateway REST v1 / HTTP v2 / WebSocket + Function URLs
cdkl invoke-agentcore MyStack/Agent            # Bedrock AgentCore Runtime (one POST /invocations)
cdkl list                                      # every runnable target, grouped by command (alias: ls)
```

![cdkl invoke against a local sample CDK app — standalone, no deploy](assets/cdkl-invoke.gif)

- **`start-api`** serves one HTTP server per API; a bare `start-api` in a multi-stack app needs `--all-stacks` or `--stack <name>`.
- **`run-task`** / single-replica **`start-service`** publish declared container ports on the host (`--host-port <container>=<host>` remaps; handy for privileged ports on macOS). **`start-service`** / **`start-alb`** also list each host URL in a `Service endpoints:` banner after boot so the access URL stays visible.
- **`start-alb`** stands up the ECS service(s) behind an ALB plus a host-side front-door on each listener port, honoring all six listener-rule conditions, weighted forwards, redirect / fixed-response actions, mixed ECS + Lambda targets, `authenticate-cognito` / `authenticate-oidc` actions (local Bearer-JWT enforcement), and WebSocket `Upgrade` proxying to ECS targets ([details](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally)).
- **`invoke-agentcore`** invokes a Bedrock AgentCore Runtime agent locally — container or `fromCodeAsset` / `fromS3` managed runtime, HTTP / SSE / WebSocket / MCP protocols, with `customJwtAuthorizer` and `--sigv4` enforcement ([details](docs/cli-reference.md#cdkl-invoke-agentcore-run-bedrock-agentcore-runtime-agents-locally)).
- Non-TTY (CI / pipes): every command except a bare `start-api` needs an explicit target.

Full flags, precedence, and `--from-cfn-stack` resolution: [docs/cli-reference.md](docs/cli-reference.md) and [docs/local-emulation.md](docs/local-emulation.md).

### Environment variables — `--env-vars`

Every command accepts `--env-vars <file>`, a SAM-shape JSON file that overlays the container's environment — point a handler at a different backend for a local run, or supply a value the synthesized template only knows as an intrinsic:

```bash
cdkl invoke MyStack/Fn --env-vars ./env.json
```

```json
{
  "Parameters": { "LOG_LEVEL": "debug" },
  "MyStack/Fn": { "TABLE_ENDPOINT": "http://localhost:8000" }
}
```

`Parameters` applies to every function; a key matching a function's CDK path or CloudFormation logical ID overrides just that one. Precedence is template literals < `Parameters` < function-specific, and a `null` value clears a variable. Running standalone, env vars whose template value is an intrinsic (`Ref` / `Fn::GetAtt`) can't be resolved without a deployed stack and are dropped with a warning — `--env-vars` is how you supply a concrete value for them.

### Hot reload — `--watch`

```bash
cdkl start-api --watch        # reload API routes on save
cdkl start-service --watch    # roll ECS replicas on save
cdkl start-alb --watch        # roll ALB-fronted ECS replicas on save
```

`cdkl start-api --watch` re-synths your CDK app and reloads routes when the source changes, so editing a handler is reflected on the next request without restarting the server. Synth failures keep the previous version serving (warn-and-continue). Honors `cdk.json`'s `watch.include` / `watch.exclude` globs, so no separate `cdk watch` process is needed.

`cdkl start-service --watch` and `cdkl start-alb --watch` bring the same edit-and-go loop to ECS services. A source-only edit on an interpreted-language handler (Node / Python / Ruby / shell) takes a sub-second fast path; a Dockerfile / dependency / compiled-source change triggers a rolling rebuild. Either way replicas roll one at a time, so the service stays available — an external request stream against the ALB listener port sees zero connection refusals, even on multi-replica services. Synth failures keep the previous replica(s) serving.

Full reload pipeline + glob defaults: [docs/local-emulation.md#hot-reload---watch](docs/local-emulation.md#hot-reload---watch).

### start-service vs start-alb — which one?

`start-service` runs just the ECS service's replicas (workers, queue consumers, Service-Connect-only). `start-alb` boots the ECS service(s) behind an ALB **plus** a host-side front-door on each listener port — HTTP, and HTTPS served over plain HTTP locally by default (with `X-Forwarded-Proto: https` preserved so the upstream app still sees `https`); pass `--tls` (or `--tls-cert` / `--tls-key`) to terminate TLS locally — so external traffic reaches them the way it does in the cloud. Full resolution model: [docs/cli-reference.md](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally).

## Supported resources

| Resource | Local execution |
|----------|-----------------|
| Lambda functions (ZIP, container image, Function URLs) | `invoke` — every current Lambda runtime |
| API Gateway (REST v1, HTTP v2, WebSocket) + Lambda Function URLs | `start-api` |
| ECS task definitions | `run-task` |
| ECS services | `start-service` |
| Cloud Map / Service Connect registry | service discovery between local replicas |
| ALB-fronted ECS / Lambda services | `start-alb` — HTTP / HTTPS listeners, all six listener-rule conditions, weighted forwards, redirect / fixed-response, mixed ECS + Lambda targets, authenticate-cognito / authenticate-oidc (local Bearer-JWT enforcement), WebSocket Upgrade |
| Bedrock AgentCore Runtime agents | `invoke-agentcore` — container + `fromCodeAsset` / `fromS3` artifacts, HTTP + MCP |

Lambda runs on every current AWS Lambda runtime — Node.js (18/20/22/24), Python (3.11–3.14), Ruby (3.2/3.3), Java (8.al2/11/17/21), .NET (6/8), and the OS-only `provided.al2` / `provided.al2023`. The retired `go1.x` runtime is rejected with a pointer to migrate to `provided.al2023`.

## Programmatic use

cdk-local also exports its commands as Commander factories so a host project can embed it into its own CLI, register custom state sources alongside the built-in `--from-cfn-stack`, and rebrand the embedded commands. See [docs/library-mode.md](docs/library-mode.md) for the API and an example.

## License

Apache-2.0
