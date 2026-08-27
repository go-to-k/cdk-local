import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run this fixture's Lambdas at the HOST's CPU architecture.
 *
 * A function that declares no `architecture` defaults to `X86_64`, so on an
 * arm64 host cdk-local pins `--platform linux/amd64` and every container here
 * runs under CPU emulation -- where the Go RIE in the `public.ecr.aws/lambda/*`
 * base images faults intermittently, at a different assertion on every run
 * (issue #560; extended to the remaining fixtures by issue #569).
 *
 * Declaring the HOST arch -- rather than hardcoding either value -- is what
 * makes the container native on an Apple Silicon dev host AND on an x86_64 CI
 * runner, instead of trading one host's emulation for the other's. Keep it on
 * every function here: a new handler that omits it silently reintroduces the
 * arm64-only flake. The full rationale, the carve-outs, and the fence that
 * enforces this live in `tests/unit/integ-fixture-host-architecture.test.ts`.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

/**
 * Fixture stack for `cdkl start-api --watch` integ test.
 *
 * No AWS deploy required — the integ exercises the synthesized cdk.out
 * locally against Docker + RIE.
 *
 * One Lambda (`PingHandler`) behind a NONE-auth Function URL. verify.sh
 * boots `cdkl start-api --watch`, asserts the handler's `version`
 * marker, edits `lambda-ping/index.js` to bump the marker, and asserts
 * the served response changes after a single hot reload — proving the
 * watcher re-synths the CDK app source and swaps the container without a
 * restart, and that the reload's own `cdk.out/` re-synth writes do NOT
 * re-trigger the watcher (no loop).
 */
export class LocalStartApiWatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pingHandler = new lambda.Function(this, 'PingHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-ping')),
      timeout: cdk.Duration.seconds(10),
    });
    pingHandler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
  }
}
