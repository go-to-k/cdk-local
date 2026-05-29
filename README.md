# cdk-local

[![npm version](https://img.shields.io/npm/v/cdk-local.svg)](https://www.npmjs.com/package/cdk-local)
[![CI](https://github.com/go-to-k/cdk-local/actions/workflows/ci.yml/badge.svg)](https://github.com/go-to-k/cdk-local/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/npm/l/cdk-local.svg)](./LICENSE)

Run your CDK app's Lambda functions, API Gateway, and ECS tasks/services on your own machine — with **no AWS account**, or bound to your **deployed stack to hit real AWS resources and data**. A native, CDK-first alternative to `sam local`.

![cdkl start-api serving a local CDK app's HTTP API; curl in the right pane reaches the local Lambda](assets/cdkl-start-api.gif)

## Quick start

Requires **Docker** (running) and **Node.js 20+**.

### 1. Run locally — no AWS account

```bash
npm install -g cdk-local      # installs the `cdkl` command

cd your-cdk-app               # the directory holding cdk.json
cdkl invoke                   # pick a Lambda from the list, then run it locally
```

`cdkl` synths your CDK app and runs the real handler inside a real `public.ecr.aws/lambda/*` container. Run any command with no target and it opens an arrow-key picker — you rarely need to type a CDK path.

### 2. Bind to real AWS data — add `--from-cfn-stack`

```bash
cdkl start-api --from-cfn-stack                  # pick an API → real AWS data + real Cognito JWT
cdkl start-api MyStack/MyApi --from-cfn-stack    # or name the API explicitly
```

cdk-local reads the deployed CloudFormation stack and injects its real ARNs, Secret values, and IAM credentials into the container — your local handler reads and writes the exact same data the deployed app does, with no `.env` to wire up and no test data to seed. Point a frontend at it and you're debugging end-to-end against production-shaped state.

## Why cdk-local

Two pains, one tool:

- **Zero-friction local execution.** No AWS account, no IAM access, no deploy — just Docker and your CDK app. Onboard new engineers, review a PR by actually running its code, or work on an OSS CDK sample without owning the maintainer's AWS account.
- **Iterate against your real deployed stack — including its data.** `--from-cfn-stack` injects real ARNs, Secret values, and IAM credentials straight from CloudFormation into the local container — no `.env` file to maintain, no manual ARN copy-paste. Your local Lambda hits the same DynamoDB rows, S3 objects, Cognito users, Secret values, and anything else your IAM credentials reach that the deployed app sees.

  An offline emulator can fake the API surface, but you'd still own the cost of seeding it:
  - dumping production data into a local DB
  - mirroring Secret values into local Secrets Manager
  - anonymizing fixtures across schema changes
  - scripting realistic Cognito test users

  cdk-local skips all of that by keeping you on the real thing.

It also picks up where `sam local` leaves off:

- **CDK-native** — point it at your CDK app's `cdk.json`. No SAM templates, no extra config files.
- **Wider coverage** — Lambda (ZIP + container image + Function URL), API Gateway REST v1 / HTTP v2 / WebSocket, ECS run-task, ECS service with Service Connect + Cloud Map, and Bedrock AgentCore Runtime agents.
- **Real container images** — Lambda code runs in the real `public.ecr.aws/lambda/*` base image via the Lambda Runtime Interface Emulator (RIE); ECS tasks run as real Docker containers. The only dependency is Docker.

## What runs locally, what doesn't

cdk-local runs your **application compute** locally in Docker, using your CDK app as the source of truth. It deliberately does NOT emulate AWS managed services — the bet is: keep dependencies real, swap only the compute layer.

**Runs locally (application compute):**

- **Lambda functions** — your code in a real `public.ecr.aws/lambda/*` container via the Lambda Runtime Interface Emulator
- **HTTP APIs & Function URLs** — API Gateway REST v1 / HTTP v2 / WebSocket and Lambda Function URLs served by a local HTTP server
- **ECS** — tasks and services as real Docker containers (awsvpc / Service Connect / Cloud Map registry)
- **Bedrock AgentCore Runtime** — your agent container served over the AgentCore HTTP contract (`POST /invocations` + `GET /ping` on 8080), invoked once locally before deploy
- **Authorizers** — Lambda authorizers, Cognito User Pool JWT verification, IAM SigV4 verification

**Calls real AWS (managed services):**

- DynamoDB / S3 / Secrets Manager / SSM / SNS / SQS / Kinesis / EventBridge / Step Functions / etc.
- Your Lambda code talks to real AWS via your IAM credentials (`--assume-role`, or `--from-cfn-stack` to bind to a deployed stack)
- Want offline emulation of managed services too? Pair cdk-local with a service emulator like LocalStack — cdk-local does not bundle one.

## Two ways to use it

### 1. Standalone — no AWS deployment required

Point cdk-local at your CDK app. It synths your stack and runs Lambda functions, API Gateway routes, and ECS tasks locally with Docker. No AWS credentials needed for the basic flow.

#### The quick way — run a command and pick from the list

You almost never need to know or type a CDK path. In a terminal, just run the command with no target and cdk-local opens an arrow-key picker of the matching resources:

```bash
cdkl invoke            # pick a Lambda, then invoke it
cdkl run-task          # pick an ECS task definition, then run it
cdkl start-service     # multi-select one or more ECS services
cdkl start-api         # multi-select APIs to serve (→ selects all)
cdkl invoke-agentcore      # pick a Bedrock AgentCore Runtime, then invoke it
```

![cdkl invoke against a local sample CDK app — no AWS account, no deploy](assets/cdkl-invoke.gif)

`invoke` / `run-task` pick one target; `start-service` / `start-api` open a multi-select (space toggles, → selects all, ← clears, enter confirms). Outside a TTY — CI, pipes, redirected stdin — the picker can't run: `invoke` / `run-task` / `start-service` need the target passed explicitly (see [below](#passing-a-target-explicitly)), while a bare `start-api` serves **every** API so scripts keep working. Full picker + non-TTY behavior: [docs/cli-reference.md](docs/cli-reference.md#interactive-target-selection).

#### See what's available — `list` (alias `ls`)

`cdkl list` (or `cdkl ls`) prints every runnable target, grouped by the command that runs it. Browse it, or use it to grab the exact target string for a script. Pass `-l` to also print the stack-qualified logical ID under each path. Only the list goes to stdout (synth status goes to stderr), so `cdkl list | ...` stays clean.

```bash
cdkl list
```

```text

Lambda Functions  ->  cdkl invoke <target>
  MyStack/ItemsHandler

APIs  ->  cdkl start-api [target...]
  MyStack/MyHttpApi  (HTTP API v2)

ECS Services  ->  cdkl start-service <target...>
  MyStack/WebService

ECS Task Definitions  ->  cdkl run-task <target>
  MyStack/WebTask

AgentCore Runtimes  ->  cdkl invoke-agentcore <target>
  MyStack/ChatAgent

Application Load Balancers  ->  cdkl start-alb <target...>
  MyStack/WebAlb
```

#### Passing a target explicitly

When you want to name a target instead of picking — in a script, in CI, or to skip the prompt — pass it as the argument. Every target accepts the CDK display path (recommended) or a stack-qualified logical ID (`MyStack:MyFunction1234ABCD`, the SAM-compatible form, handy when copying straight out of `cdk.out/<Stack>.template.json`); single-stack apps may drop the stack prefix.

```bash
# Lambda — with an event payload
cdkl invoke MyStack/ItemsHandler --event ./event.json
cdkl invoke MyStack:ItemsHandler1234ABCD --event ./event.json   # logical ID (any app)

# ECS — run a task once, or start one or more long-running services
cdkl run-task MyStack/MyTask
cdkl start-service MyStack/OrdersService MyStack/Frontend

# ECS behind an ALB — name the load balancer; cdkl boots the services
# behind it and serves the listener port (round-robined across replicas)
cdkl start-alb MyStack/WebAlb

# API Gateway / Function URLs — one API, or every API in the stack
cdkl start-api MyStack/MyApi
cdkl start-api

# Bedrock AgentCore Runtime — run the agent container, POST one event
cdkl invoke-agentcore MyStack/ChatAgent --event ./event.json
```

`start-api` serves your app's HTTP surface (API Gateway REST v1 / HTTP v2 / WebSocket + Lambda Function URLs) on a local HTTP server, one server per API. In a multi-stack app a bare `cdkl start-api` errors rather than serving every stack's API at once; serve them all with `--all-stacks`, or select one with `--stack <name>`, `--from-cfn-stack <name>`, or a stack-qualified target. See [docs/cli-reference.md](docs/cli-reference.md) for the full precedence rules.

For ECS there is no cluster command — locally, Docker is the placement target a cluster abstracts away. Both `run-task` and `start-service` accept an optional `--cluster <name>`; `start-service` also wires Service Connect / Cloud Map registry.

**`start-service` vs `start-alb` — which do I run?** They mirror `run-task`/`invoke` (the compute alone) vs `start-api` (the routed entry in front of the compute):

| Command | You name | What runs | Use when |
| --- | --- | --- | --- |
| `cdkl start-service <Service>` | the ECS **service** | just the service's replicas (no load balancer) | workers / queue consumers / Service-Connect-only services, or to run the containers and hit them directly |
| `cdkl start-alb <Alb>` | the **ALB** | the ECS service(s) behind the ALB **plus** a local **front-door** on each listener port | an `ApplicationLoadBalancedFargateService`-style service you want to reach the way external traffic does |

`start-alb` is the ALB counterpart of `start-api`: you name the load balancer, and cdk-local discovers the ECS service(s) behind its HTTP `forward` listeners, boots their replicas, and stands up a host-side **front-door** on each listener port that round-robins requests across the running replicas — one stable host endpoint, just like behind a real load balancer. `start-service` stays a pure compute runner and never opens a front-door.

```bash
# Just the service replicas (no load balancer) — a worker, or direct container debugging:
cdkl start-service MyStack/Worker

# The ALB-fronted experience — name the ALB; cdkl boots the backing service(s) and
# fronts each listener. On macOS, remap the privileged listener port 80 to a
# non-privileged host port with --lb-port.
cdkl start-alb MyStack/WebAlb --lb-port 80=8080
curl http://127.0.0.1:8080/   # round-robins across the running replicas
```

See [docs/cli-reference.md](docs/cli-reference.md#cdkl-start-alb-run-an-alb-fronted-service-locally) for `start-alb`'s resolution model and scope (single HTTP `forward`, ECS targets).

`invoke-agentcore` runs a Bedrock AgentCore Runtime's container locally, waits for `GET /ping`, then POSTs your `--event` (or `{}`) to `POST /invocations` and prints the response — the same request/response loop AgentCore runs in the cloud, without a deploy. v1 covers container-artifact runtimes on the HTTP protocol; the agent's own calls to Bedrock models / memory / other managed services go to real AWS.

Use this for fast iteration on Lambda code, API routing checks, container task smoke tests, and agent request/response checks.

### 2. Bound to a deployed stack

Once your stack is deployed to AWS (via the AWS CDK CLI or any other tool), pass `--from-cfn-stack <StackName>` and cdk-local reads the deployed CloudFormation stack to inject real ARNs, Secret values, and IAM credentials (resolved from your current AWS profile) into the local execution. Env vars that reference deploy-time CloudFormation intrinsics or SSM-backed parameters are resolved too, so a Lambda or container that depends on a sibling resource's ARN or an SSM parameter runs locally without a manual `--env-vars` entry. See [docs/local-emulation.md](docs/local-emulation.md#cloudformation-driven-env-recovery---from-cfn-stack) for the full resolution model.

> SSM `SecureString` parameters are decrypted and injected like any other resolved value, but passed via docker's value-from-process-env form so the decrypted value never appears on the `docker run` argv.

#### HTTP APIs & Function URLs — `start-api` (the headline use case)

A local API talking to real AWS — point a frontend at it for end-to-end debugging, including real Cognito JWT verification.

```bash
cdkl start-api MyStack/MyApi --from-cfn-stack MyStack

# Typical shape — the bare flag auto-resolves to the routed stack's
# name (here `MyStack`). Pass an explicit value only when the deployed
# CFn stack name differs from the CDK stack name.
cdkl start-api MyStack/MyApi --from-cfn-stack
```

#### Lambda — `invoke`

Single-function debugging against real upstreams (DynamoDB rows, S3 objects, Secret values).

```bash
cdkl invoke MyStack/MyFunction --event ./event.json --from-cfn-stack MyStack
```

#### ECS — `run-task` / `start-service`

Container workloads running locally against real ARNs / Secrets / IAM credentials from the deployed stack.

```bash
cdkl run-task MyStack/MyTask --from-cfn-stack MyStack
cdkl start-service MyStack/MyService --from-cfn-stack MyStack
```

Use this for production debugging, integration verification with real AWS resources, and validating real IAM permissions before deploy.

## `--watch` (hot reload)

Pass `--watch` to `cdkl start-api` and the server re-synths and hot-reloads when your CDK app's **source** changes — edit a handler or construct, save, and the change is live:

```bash
cdkl start-api MyStack/MyApi --watch
```

- 500 ms debounced [chokidar](https://github.com/paulmillr/chokidar) file watcher on your CDK app's source tree, honoring `cdk.json`'s `watch.include` / `watch.exclude` globs exactly like `cdk watch`. `cdk.out/`, `node_modules`, and `.git` are always excluded, so the reload's own re-synth never re-triggers the watcher.
- Re-synths and re-discovers routes on each firing — adding a new route to your CDK app shows up locally on save, with no separate `cdk watch` / `cdk synth` process. Synth failures keep the previous version serving (warn-and-continue, never crashes the server).
- Compatible with `--from-cfn-stack`: each reload re-reads the deployed stack so newly-deployed ARNs are picked up on your next source save without restarting the server.

See [docs/local-emulation.md](docs/local-emulation.md#hot-reload---watch) for the full lifecycle, `watch.include` / `watch.exclude` semantics, and known limitations.

## Override env vars without a state source

When env-var values in your CDK template are CloudFormation intrinsics (`Ref`, `Fn::GetAtt`, `Fn::ImportValue`), cdk-local cannot resolve them without a state source — it drops them with a warning that names the affected key. To inject literal values instead, use `--env-vars <file>` (SAM-compatible JSON shape):

```json
{
  "Parameters": { "LOG_LEVEL": "debug" },
  "MyStack/MyFunction": {
    "SECRET_ARN": "arn:aws:secretsmanager:us-east-1:123456789012:secret:MySecret-abc123",
    "TABLE_NAME": "my-table"
  }
}
```

```bash
cdkl invoke MyStack/MyFunction --event ./event.json --env-vars ./env.json
```

- `Parameters` applies to every function / container; function-specific blocks override it.
- For Lambda (`invoke`, `start-api`), function-specific keys can be a **CDK display path** (`MyStack/MyFunction` — same form `cdkl invoke` accepts) or a **CloudFormation logical ID** (`MyFunctionLogicalId1234ABCD`, the SAM-compatible form). For ECS (`run-task`, `start-service`), keys are container names from the task definition.
- The file format matches `sam local invoke --env-vars`, so an existing SAM env-vars file works unchanged.
- Composes with `--from-cfn-stack`: the state source resolves env vars first, then `--env-vars` overrides only the keys you list. Full precedence in [docs/cli-reference.md](docs/cli-reference.md).

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
| `AWS::BedrockAgentCore::Runtime` (invoke-agentcore, container artifact + HTTP) | ✓ |

Lambda runs on every current AWS Lambda runtime — Node.js (18/20/22/24), Python (3.11–3.14), Ruby (3.2/3.3), Java (8.al2/11/17/21), .NET (6/8), and the OS-only `provided.al2` / `provided.al2023`. The retired `go1.x` runtime is rejected with a pointer to migrate to `provided.al2023`.

## Programmatic use

cdk-local also exports its commands as Commander factories so a host project can embed it into its own CLI, register custom state sources alongside the built-in `--from-cfn-stack`, and rebrand the embedded commands under its own name. See [docs/library-mode.md](docs/library-mode.md) for the API and an example.

## License

Apache-2.0
