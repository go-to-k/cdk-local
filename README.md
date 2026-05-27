# cdk-local

Local runner for your CDK app's Lambda functions, API Gateway, and ECS tasks/services. Run it with no AWS account, or bind it to your deployed stack to hit real AWS resources and data. A native, CDK-first alternative to `sam local`.

## Why cdk-local

Two pains, one tool:

- **Zero-friction local execution.** No AWS account, no IAM access, no deploy — just Docker and your CDK app. Onboard new engineers, review a PR by actually running its code, or work on an OSS CDK sample without owning the maintainer's AWS account.
- **Iterate against your real deployed stack — including its data.** `--from-cfn-stack` injects real ARNs, Secret values, and IAM credentials straight from CloudFormation into the local container — no `.env` file to maintain, no manual ARN copy-paste. Your local Lambda hits the same DynamoDB rows, S3 objects, Cognito users, Secret values, and anything else your IAM credentials reach through public AWS APIs that the deployed app sees. An offline emulator can fake the API surface, but you'd still own the cost of seeding it:
  - dumping production data into a local DB
  - mirroring Secret values into local Secrets Manager
  - anonymizing fixtures across schema changes
  - scripting realistic Cognito test users

  cdk-local skips all of that by keeping you on the real thing.

cdk-local deliberately does NOT emulate AWS managed services. The bet is: keep dependencies real, swap only the compute layer.

It also picks up where `sam local` leaves off:

- **CDK-native** — point it at your CDK app's `cdk.json`. No SAM templates, no extra config files.
- **Wider coverage** — Lambda (ZIP + container image), API Gateway REST v1 / HTTP v2 / Function URL / WebSocket API, ECS run-task, ECS service with Service Connect + Cloud Map.
- **Real container images** — Lambda code runs in the real `public.ecr.aws/lambda/*` base image via Lambda Runtime Interface Emulator (RIE). ECS tasks run as real Docker containers. The only dependency is Docker.

## What runs locally, what doesn't

cdk-local runs your **application compute** locally in Docker, using your CDK app as the source of truth. It does NOT emulate AWS managed services.

**Runs locally (application compute):**

- **Lambda functions** — your code in a real `public.ecr.aws/lambda/*` container via the Lambda Runtime Interface Emulator
- **API Gateway** — REST v1 / HTTP v2 / Function URL / WebSocket served by a local HTTP server
- **ECS** — tasks and services as real Docker containers (awsvpc / Service Connect / Cloud Map registry)
- **Authorizers** — Lambda authorizers, Cognito User Pool JWT verification, IAM SigV4 verification

**Calls real AWS (managed services):**

- DynamoDB / S3 / Secrets Manager / SSM / SNS / SQS / Kinesis / EventBridge / Step Functions / etc.
- Your Lambda code talks to real AWS via your IAM credentials (`--assume-role` or `--from-cfn-stack` to bind to a deployed stack)
- If you want offline emulation of managed services, pair cdk-local with a service emulator like LocalStack — cdk-local does not bundle one.

## Install

```bash
npm install -g cdk-local
```

This installs the `cdkl` command.

## Two ways to use it

### 1. Standalone — no AWS deployment required

Point cdk-local at your CDK app. It synths your stack and runs Lambda functions, API Gateway routes, and ECS tasks locally with Docker. No AWS credentials needed for the basic flow.

#### Lambda — `invoke`

Invoke a single Lambda function with an event payload.

```bash
cdkl invoke MyStack/MyFunction --event ./event.json
```

#### API Gateway — `start-api`

Serve your API Gateway routes (REST v1 / HTTP v2 / Function URL / WebSocket) on a local HTTP server.

```bash
cdkl start-api MyStack/MyApi
```

#### ECS — `run-task` / `start-service`

Run an ECS task definition once, or start a long-running service with Service Connect / Cloud Map registry.

```bash
cdkl run-task MyStack/MyTask
cdkl start-service MyStack/MyService
```

Use this for fast iteration on Lambda code, API routing checks, and container task smoke tests.

### 2. Bound to a deployed stack

Once your stack is deployed to AWS (via the AWS CDK CLI or any other tool), pass `--from-cfn-stack <StackName>` and cdk-local reads the deployed CloudFormation stack to inject real ARNs, Secrets values, and IAM credentials (resolved from your current AWS profile) into the local execution.

#### API Gateway — `start-api` (the headline use case)

A local API talking to real AWS — point a frontend at it for end-to-end debugging, including real Cognito JWT verification.

```bash
cdkl start-api MyStack/MyApi --from-cfn-stack MyStack
```

#### Lambda — `invoke`

Single-function debugging against real upstreams (DynamoDB rows, S3 objects, Secrets values).

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

## Override env vars without a state source

When env-var values in your CDK template are CloudFormation intrinsics (`Ref`, `Fn::GetAtt`, `Fn::ImportValue`), cdk-local cannot resolve them without a state source — it drops them with a warning that names the affected key. To inject literal values instead, use `--env-vars <file>` (SAM-compatible JSON shape):

```json
{
  "Parameters": { "LOG_LEVEL": "debug" },
  "MyFunctionLogicalId": {
    "SECRET_ARN": "arn:aws:secretsmanager:us-east-1:123456789012:secret:MySecret-abc123",
    "TABLE_NAME": "my-table"
  }
}
```

```bash
cdkl invoke MyStack/MyFunction --event ./event.json --env-vars ./env.json
```

- `Parameters` applies to every function; function-specific blocks override it.
- Function-specific keys are CloudFormation logical IDs (named in `cdk.out/<Stack>.template.json` or in the drop-warning message).
- Available on `invoke`, `start-api`, `run-task`, and `start-service`.
- The file format matches `sam local invoke --env-vars`, so an existing SAM env-vars file works unchanged.

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

## Programmatic use

cdk-local also exports its commands as Commander factories so a host project can embed it into its own CLI and register custom state sources alongside the built-in `--from-cfn-stack`. See [docs/library-mode.md](docs/library-mode.md) for the API and an example.

## License

Apache-2.0
