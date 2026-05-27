# cdk-local

Run AWS CDK stacks locally with Docker. A native, CDK-first alternative to `sam local`.

## Why cdk-local

- **CDK-native** — point it at your CDK app's `cdk.json`. No SAM templates, no extra config files.
- **Wider resource coverage** — Lambda (ZIP + container image), API Gateway REST v1 / HTTP v2 / Function URL / WebSocket API, ECS run-task, ECS service with Service Connect + Cloud Map.
- **Two execution modes** — standalone (no AWS deployment), or bound to a deployed stack to inject real ARNs / Secrets / IAM credentials.
- **No AWS emulator required** — your Lambda code runs in the real `public.ecr.aws/lambda/*` base image via Lambda Runtime Interface Emulator (RIE). ECS tasks run as real Docker containers. The only dependency is Docker.

## How is this different from aws-cdk-local / LocalStack?

`cdk-local` and [`aws-cdk-local`](https://github.com/localstack/aws-cdk-local) solve **different problems** — they're complementary, not competing:

| Tool | What it is | Lambda code runs where? | Backing AWS APIs |
|------|------------|-------------------------|------------------|
| `aws-cdk-local` (`cdklocal`) | CDK CLI wrapper that deploys your CDK stack to a LocalStack server | Inside LocalStack's Lambda emulator | LocalStack's emulated AWS APIs |
| **`cdk-local` (`cdkl`)** | **CDK-native invoke / start-api / run-task — runs your actual code in Docker** | **Real `public.ecr.aws/lambda/*` container via RIE** | **Real AWS** (via `--assume-role` / `--from-cfn-stack`) or no AWS at all |
| `sam local` | SAM CLI's local invoke for SAM-template apps | Real Lambda base image via RIE | Real AWS or none |

If you want to deploy your CDK stack to LocalStack for end-to-end emulation, use `aws-cdk-local`. If you want to iterate on Lambda code, debug an API Gateway route, or run an ECS task locally — using **real AWS data and real IAM permissions** (or no AWS at all) — use `cdk-local`. Many projects benefit from both.

## Install

```bash
npm install -g cdk-local
```

This installs the `cdkl` command.

## Two ways to use it

### 1. Standalone — no AWS deployment required

Point cdk-local at your CDK app. It synths your stack and runs Lambda functions, API Gateway routes, and ECS tasks locally with Docker. No AWS credentials needed for the basic flow.

```bash
cdkl invoke MyStack/MyFunction --event ./event.json
cdkl start-api MyStack/MyApi
cdkl run-task MyStack/MyTask
cdkl start-service MyStack/MyService
```

Use this for fast iteration on Lambda code, API routing checks, and container task smoke tests.

### 2. Bound to a deployed stack

Once your stack is deployed to AWS (via the AWS CDK CLI or any other tool), cdk-local can read the deployed resources and inject real ARNs, Secrets values, and IAM credentials into the local execution.

```bash
cdkl invoke MyStack/MyFunction --event ./event.json --from-cfn-stack MyStack
```

Use this for production debugging, integration verification with real AWS resources (DynamoDB rows, S3 objects, Secrets values), and validating real IAM permissions before deploy.

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

See [docs/supported-resources.md](docs/supported-resources.md) for the detailed matrix and intrinsic / authorizer coverage.

## License

Apache-2.0
