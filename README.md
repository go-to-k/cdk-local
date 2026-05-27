# cdk-local

Run AWS CDK stacks locally with Docker. A native, CDK-first alternative to `sam local`.

## Why cdk-local

- **CDK-native** — point it at your CDK app's `cdk.json`. No SAM templates, no extra config files.
- **Wider resource coverage** — Lambda (ZIP + container image), API Gateway REST v1 / HTTP v2 / Function URL / WebSocket API, ECS run-task, ECS service with Service Connect + Cloud Map.
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
