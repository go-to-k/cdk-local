# cdk-local

[![npm version](https://img.shields.io/npm/v/cdk-local.svg)](https://www.npmjs.com/package/cdk-local)
[![Downloads](https://img.shields.io/npm/dw/cdk-local.svg)](https://www.npmjs.com/package/cdk-local)
[![CI](https://github.com/go-to-k/cdk-local/actions/workflows/ci.yml/badge.svg)](https://github.com/go-to-k/cdk-local/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/npm/l/cdk-local.svg)](./LICENSE)

**Run your CDK app locally — no SAM template, no AWS account. Or bind to your deployed stack and hit its real data.**
A CDK-native alternative to `sam local`, covering Lambda, API Gateway, ECS, ALB-fronted services, and Bedrock AgentCore.

![cdkl start-api serving a local CDK app's HTTP API; curl in the right pane reaches the local Lambda](assets/cdkl-start-api.gif)

## Quick start

Requires **Docker** (running) and **Node.js 20+**.

```bash
npm install -g cdk-local      # installs the `cdkl` command
cd your-cdk-app               # the directory holding cdk.json
cdkl invoke                   # pick a Lambda from the list, then run it locally
```

`cdkl` synths your CDK app and runs the selected resource locally in Docker — a Lambda in its real `public.ecr.aws/lambda/*` container (via the Lambda Runtime Interface Emulator), an ECS task / service as a real container, an API on a local HTTP server. Run any command with no target and it opens an arrow-key picker, so you rarely type a CDK path.

**Bind to your real deployed stack** by adding `--from-cfn-stack`: cdk-local reads the deployed CloudFormation stack and injects its real ARNs, Secret values, and IAM credentials into the container, so your local handler reads and writes the exact same data the deployed app does — no `.env` to wire up, no test data to seed.

```bash
cdkl start-api --from-cfn-stack            # a local API on real AWS data + real Cognito JWT
cdkl invoke MyStack/Fn --from-cfn-stack    # one Lambda against real DynamoDB / S3 / Secrets
```

## Why cdk-local

- **Zero-friction local execution** — no AWS account, no IAM access, no deploy; just Docker and your CDK app. Onboard new engineers, review a PR by actually running its code, or work on an OSS CDK sample without owning the maintainer's account.
- **Iterate against your real deployed stack — including its data.** `--from-cfn-stack` keeps you on the real DynamoDB rows, S3 objects, Cognito users, and Secret values your IAM credentials reach, instead of paying to seed and anonymize a local emulator.
- **Picks up where `sam local` leaves off:**
  - **CDK-native** — point at `cdk.json`; no SAM template to maintain.
  - **Wider coverage** — Lambda, API Gateway, ECS run-task / service / ALB front-door, and Bedrock AgentCore.
  - **Real container images** — the Lambda RIE base image; ECS as real Docker. The only dependency is Docker itself.

## What runs locally

cdk-local runs your **application compute** in Docker, using your CDK app as the source of truth. It deliberately does NOT emulate AWS managed services: your code reaches DynamoDB / S3 / Secrets Manager / Cognito / SNS / SQS / etc. as **real AWS** through your IAM credentials (`--assume-role`, or `--from-cfn-stack` to bind to a deployed stack). Want those offline too? Pair cdk-local with a service emulator like [LocalStack](https://www.localstack.cloud/) — it does not bundle one.

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

![cdkl invoke against a local sample CDK app — no AWS account, no deploy](assets/cdkl-invoke.gif)

- **`start-api`** serves one HTTP server per API; a bare `start-api` in a multi-stack app needs `--all-stacks` or `--stack <name>`. Add **`--watch`** to re-synth and hot-reload on CDK source changes ([details](docs/local-emulation.md#hot-reload---watch)).
- **`run-task`** / single-replica **`start-service`** publish declared container ports on the host and log `Reach it at 127.0.0.1:<port>` (`--host-port <container>=<host>` remaps; handy for privileged ports on macOS).
- **`start-alb`** stands up the ECS service(s) behind an ALB plus a host-side front-door on each listener port, honoring all six listener-rule conditions, weighted forwards, redirect / fixed-response actions, mixed ECS + Lambda targets, `authenticate-cognito` / `authenticate-oidc` actions (local Bearer-JWT enforcement), and WebSocket `Upgrade` proxying to ECS targets ([details](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally)).
- **`invoke-agentcore`** invokes a Bedrock AgentCore Runtime agent locally — container or `fromCodeAsset` / `fromS3` managed runtime, HTTP / SSE / WebSocket / MCP protocols, with `customJwtAuthorizer` and `--sigv4` enforcement ([details](docs/cli-reference.md#cdkl-invoke-agentcore-run-bedrock-agentcore-runtime-agents-locally)).
- Non-TTY (CI / pipes): every command except a bare `start-api` needs an explicit target.

Full flags, precedence, and `--from-cfn-stack` resolution: [docs/cli-reference.md](docs/cli-reference.md) and [docs/local-emulation.md](docs/local-emulation.md).

### start-service vs start-alb — which one?

`start-service` runs just the ECS service's replicas (workers, queue consumers, Service-Connect-only). `start-alb` boots the ECS service(s) behind an ALB **plus** a host-side front-door on each listener port — HTTP and HTTPS (TLS terminated locally with `--tls-cert` / `--tls-key` or an auto-generated self-signed cert) — so external traffic reaches them the way it does in the cloud. Full resolution model: [docs/cli-reference.md](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally).

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
