# Getting Started with cdk-local

A 5-minute walkthrough: install cdk-local, point it at a sample CDK app, and run a Lambda function locally with no AWS account.

If you already use cdk-local and want the full surface, jump to [docs/cli-reference.md](./cli-reference.md). If something breaks, [docs/troubleshooting.md](./troubleshooting.md).

## Prerequisites

- **Node.js 20 or later** — `node --version` must report `v20.x` or higher.
- **Docker** — `docker info` must succeed. Lambda code runs in the real `public.ecr.aws/lambda/*` base image via the Lambda Runtime Interface Emulator (RIE), and ECS tasks run as real Docker containers, so a working Docker daemon is non-negotiable. On macOS / Windows, Docker Desktop is the easiest path; on Linux, the OS package is fine.
- **A CDK app** (TypeScript or JavaScript) with at least one Lambda function. If you don't have one handy, the next section uses the standard `cdk init sample-app` template.

You do NOT need:

- An AWS account or IAM credentials (for the standalone flow on this page).
- A SAM template — cdk-local reads `cdk.json` directly.
- A separate config file — cdk-local discovers everything from your CDK app's synth output.

## Install

```bash
npm install -g cdk-local
```

This installs the `cdkl` binary. Confirm it landed:

```bash
cdkl --version
```

## First run: invoke a Lambda

### 1. Scaffold a tiny CDK app

If you already have a CDK app, skip to step 2.

```bash
mkdir hello-cdkl && cd hello-cdkl
npx cdk init sample-app --language=typescript
```

The sample-app template ships with a single `HelloHandler` Lambda. Replace its body so we have something to print:

```typescript
// lib/hello-cdkl-stack.ts (excerpt — the handler the sample-app creates)
const hello = new lambda.Function(this, 'HelloHandler', {
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromInline(`
    exports.handler = async (event) => ({
      statusCode: 200,
      body: JSON.stringify({ greeting: 'hello, cdkl!', event }),
    });
  `),
  handler: 'index.handler',
});
```

Build the CDK app once so `cdk.out/` is populated:

```bash
npx cdk synth
```

### 2. Invoke the handler

```bash
cdkl invoke HelloCdklStack/HelloHandler
```

cdk-local will:

1. Read `cdk.json` and re-synth your app on demand.
2. Resolve the `HelloCdklStack/HelloHandler` target (CDK display path — same format `cdk` itself uses).
3. Pull the `public.ecr.aws/lambda/nodejs:20` base image on first run (cached afterwards).
4. Start a one-shot container with your function code mounted in.
5. Send an empty event to RIE and print the response:

```json
{"statusCode":200,"body":"{\"greeting\":\"hello, cdkl!\",\"event\":{}}"}
```

### 3. Send a real event

```bash
echo '{"name":"world"}' > event.json
cdkl invoke HelloCdklStack/HelloHandler --event event.json
```

The event payload lands in `event` inside your handler.

## Next steps

- **Serve API Gateway routes locally**: `cdkl start-api HelloCdklStack/HelloApi` — REST v1 / HTTP v2 / Function URL / WebSocket all served by a local HTTP server. See [docs/local-emulation.md](./local-emulation.md) when it ships.
- **Run an ECS task or service**: `cdkl run-task <Stack>/<Task>` or `cdkl start-service <Stack>/<Service>`.
- **Bind to a deployed CloudFormation stack**: `--from-cfn-stack <StackName>` injects real ARNs, Secret values, and IAM credentials from the live stack into the local container. This is the "iterate against your real deployed stack, including its data" flow described in the [README](../README.md).
- **Override env vars without redeploying**: `--env-vars <file>` — supports per-function overrides keyed by CDK logical ID (display-path keys [tracked in #27](https://github.com/go-to-k/cdk-local/issues/27)).

## Where to go when something breaks

- **"Cannot find module 'cdk.json'"** — run `cdkl` from the directory that contains your CDK app's `cdk.json`, or pass `--app <path>`.
- **"docker: Error response from daemon"** — Docker is not running, or your user lacks permission to talk to the socket. `docker info` should succeed before retrying.
- **"target not found"** — the CDK display path (`Stack/Construct`) is case-sensitive and must match exactly what `cdk synth` emits. `cdkl <subcommand> --help` lists the accepted forms.
- More patterns in [docs/troubleshooting.md](./troubleshooting.md) when it ships.

## How cdk-local positions vs other tools

- **vs `sam local`** — cdk-local is CDK-native (reads `cdk.json`, not SAM templates), covers more surfaces (REST v1 + HTTP v2 + Function URL + WebSocket + ECS run-task + ECS service vs SAM's Lambda + REST v1 only), and works against your CDK construct paths instead of CloudFormation logical IDs.
- **vs LocalStack / aws-cdk-local** — cdk-local does NOT emulate AWS managed services. It runs your **application compute** locally and lets your Lambda code talk to real DynamoDB / S3 / Secrets Manager / Cognito / etc. via your IAM credentials. The two are complementary: pair cdk-local with LocalStack if you want offline emulation of managed services as well.
