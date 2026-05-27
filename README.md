# cdk-local

Local runner for your CDK app's Lambda functions, API Gateway, and ECS tasks/services. A native, CDK-first alternative to `sam local`.

## Why cdk-local

- **CDK-native** — point it at your CDK app's `cdk.json`. No SAM templates, no extra config files.
- **Wider coverage than `sam local`** — Lambda (ZIP + container image), API Gateway REST v1 / HTTP v2 / Function URL / WebSocket API, ECS run-task, ECS service with Service Connect + Cloud Map.
- **Two execution modes** — standalone (no AWS deployment), or bound to a deployed stack to inject real ARNs / Secrets / IAM credentials.
- **No AWS emulator required** — your Lambda code runs in the real `public.ecr.aws/lambda/*` base image via Lambda Runtime Interface Emulator (RIE). ECS tasks run as real Docker containers. The only dependency is Docker.

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

## Use as a library

`cdk-local` also exports its Commander commands as factories, so you can build a custom CLI that adds your own state-source flags on top of the built-in `--from-cfn-stack`.

```typescript
import { Command } from 'commander';
import {
  createLocalInvokeCommand,
  createLocalStartApiCommand,
  type LocalStateProvider,
  type LocalStateProviderFactory,
} from 'cdk-local';

// Register a custom state source. The key (e.g. `fromMyStore`) is the
// camel-case Commander option name your factory keys off.
const extraStateProviders: Record<string, LocalStateProviderFactory> = {
  fromMyStore: (opts) => new MyStoreStateProvider(opts),
};

const program = new Command();
program.addCommand(createLocalInvokeCommand({ extraStateProviders }));
program.addCommand(createLocalStartApiCommand({ extraStateProviders }));
program.parseAsync(process.argv);

class MyStoreStateProvider implements LocalStateProvider {
  readonly label = '--from-my-store';
  async load(stackName: string, synthRegion: string | undefined) { /* ... */ return undefined; }
  async buildCrossStackResolver(consumerRegion: string) { /* ... */ return undefined; }
  dispose() { /* close clients */ }
}
```

The dispatcher enforces mutual exclusion across `--from-cfn-stack` and every registered extra flag, so users get one consistent error message when they pass conflicting flags.

## License

Apache-2.0
