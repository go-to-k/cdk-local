# cdk-local

[![npm version](https://img.shields.io/npm/v/cdk-local.svg)](https://www.npmjs.com/package/cdk-local)
[![CI](https://github.com/go-to-k/cdk-local/actions/workflows/ci.yml/badge.svg)](https://github.com/go-to-k/cdk-local/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/npm/l/cdk-local.svg)](./LICENSE)

Run your CDK app's Lambda functions, API Gateway APIs, ECS tasks / services / ALB-fronted services, and Bedrock AgentCore agents on your own machine — with **no AWS account**, or bound to your **deployed stack to hit real AWS resources and data**. A native, CDK-first alternative to `sam local`.

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

It also picks up where `sam local` leaves off: **CDK-native** (point at `cdk.json`, no SAM templates), **wider coverage** (Lambda, API Gateway, ECS run-task / service / ALB front-door, Bedrock AgentCore), and **real container images** (the Lambda RIE base image; ECS as real Docker — the only dependency is Docker).

## What runs locally

cdk-local runs your **application compute** in Docker, using your CDK app as the source of truth. It deliberately does NOT emulate AWS managed services: your code reaches DynamoDB / S3 / Secrets Manager / Cognito / SNS / SQS / etc. as **real AWS** through your IAM credentials (`--assume-role`, or `--from-cfn-stack` to bind to a deployed stack). Want those offline too? Pair cdk-local with a service emulator like LocalStack — it does not bundle one.

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
- **`invoke-agentcore`** runs the agent (a container, or a `fromCodeAsset` managed-runtime bundle — Python 3.10-3.14 / Node 22 — built from source), waits for `GET /ping`, POSTs your `--event` to `POST /invocations`, and streams an SSE response live. `--ws` streams over the agent's bidirectional `/ws` WebSocket endpoint instead. A `customJwtAuthorizer` is enforced locally — pass `--bearer-token <jwt>` (verified against the runtime's OIDC discovery URL). MCP-protocol runtimes (`ProtocolConfiguration = MCP`) are also served — the `POST /mcp` Streamable-HTTP contract on 8000, with one JSON-RPC request (`tools/list` by default, or `--event`'s `{"method":...,"params":...}`).
- Non-TTY (CI / pipes): every command except a bare `start-api` needs an explicit target.

Full flags, precedence, and `--from-cfn-stack` resolution: [docs/cli-reference.md](docs/cli-reference.md) and [docs/local-emulation.md](docs/local-emulation.md).

## start-service vs start-alb — which one?

`start-service` and `start-alb` mirror `run-task` / `invoke` (the compute alone) vs `start-api` (the routed entry in front of the compute):

| Command | You name | What runs | Use when |
| --- | --- | --- | --- |
| `cdkl start-service <Service>` | the ECS **service** | just the service's replicas (no load balancer) | workers / queue consumers / Service-Connect-only services, or to hit the containers directly |
| `cdkl start-alb <Alb>` | the **ALB** | the ECS service(s) behind it **plus** a local **front-door** on each listener port | an `ApplicationLoadBalancedFargateService`-style service you want to reach the way external traffic does |

`start-alb` discovers the ECS service(s) behind the ALB's HTTP listeners, boots their replicas, and stands up a host-side front-door on each listener port that round-robins across the replicas — one stable host endpoint, like behind a real load balancer. It honors **`path-pattern` and `host-header` listener rules**, **weighted** forwards, and **`redirect` / `fixed-response`** actions, so a listener routing `/api/*` (or `api.example.com`) to one service and everything else to another — or returning a redirect / canned response — is reproduced locally. A **`TargetType: lambda`** target group is served by invoking the backing Lambda locally (the request is translated to the ALB `requestContext.elb` event and run through the Lambda RIE), so a forward can mix ECS and Lambda targets.

```bash
cdkl start-alb MyStack/WebAlb --lb-port 80=8080   # remap the privileged listener port 80 (macOS)
curl http://127.0.0.1:8080/        # default action -> the default service (round-robin)
curl http://127.0.0.1:8080/api/x   # path-pattern rule /api/* -> the api service
```

Resolution model + scope (HTTP listeners, `path-pattern` + `host-header` rules, weighted forwards, `redirect` / `fixed-response`, ECS **and** Lambda targets; `http-header` / `query-string` / `source-ip` conditions deferred): [docs/cli-reference.md](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally).

## Override env vars without a state source

When env-var values in your template are CloudFormation intrinsics (`Ref`, `Fn::GetAtt`, `Fn::ImportValue`) and you have no state source, inject literals with `--env-vars <file>` (the SAM-compatible `sam local invoke --env-vars` shape, so an existing file works unchanged). It composes with `--from-cfn-stack` — the state source resolves first, then `--env-vars` overrides only the keys you list.

```bash
cdkl invoke MyStack/Fn --event ./event.json --env-vars ./env.json
```

Format + full precedence: [docs/cli-reference.md](docs/cli-reference.md).

## Supported resources

| Resource | Local execution support |
|----------|------------------------|
| `AWS::Lambda::Function` (ZIP) | ✓ |
| `AWS::Lambda::Function` (container image) | ✓ |
| `AWS::Lambda::Url` | ✓ |
| `AWS::ApiGateway::*` (REST v1) | ✓ |
| `AWS::ApiGatewayV2::*` (HTTP API + WebSocket) | ✓ |
| `AWS::ECS::TaskDefinition` (run-task) | ✓ |
| `AWS::ECS::Service` (start-service) | ✓ |
| `AWS::ServiceDiscovery::*` (Cloud Map / Service Connect) | ✓ |
| `AWS::ElasticLoadBalancingV2::*` (start-alb: ALB front-door; `path-pattern` + `host-header` rules, weighted forward, redirect / fixed-response; ECS + Lambda targets) | ✓ |
| `AWS::BedrockAgentCore::Runtime` (invoke-agentcore, container + fromCodeAsset artifacts, HTTP + MCP) | ✓ |

Lambda runs on every current AWS Lambda runtime — Node.js (18/20/22/24), Python (3.11–3.14), Ruby (3.2/3.3), Java (8.al2/11/17/21), .NET (6/8), and the OS-only `provided.al2` / `provided.al2023`. The retired `go1.x` runtime is rejected with a pointer to migrate to `provided.al2023`.

## Programmatic use

cdk-local also exports its commands as Commander factories so a host project can embed it into its own CLI, register custom state sources alongside the built-in `--from-cfn-stack`, and rebrand the embedded commands. See [docs/library-mode.md](docs/library-mode.md) for the API and an example.

## License

Apache-2.0
