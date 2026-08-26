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
 * Fixture stack for `cdkl invoke` Python integ test (PR 4 of #224).
 *
 * Two Lambdas:
 *   - `EchoHandler` — asset-backed Python 3.12 function that echoes its
 *     event plus the value of an env var. Exercises the asset-path
 *     bind-mount code path AND the env-var resolution code path against
 *     the Python Lambda base image.
 *   - `InlineHandler` — `Code.fromInline` Python function. Exercises the
 *     inline-code materialization code path with the `.py` extension.
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only, mirroring `tests/integration/local-invoke/`.
 */
export class LocalInvokePythonStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    new lambda.Function(this, 'InlineHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          'def handler(event, context):',
          '    return {"inlineEcho": event}',
          '',
        ].join('\n')
      ),
      timeout: cdk.Duration.seconds(10),
    });
  }
}
