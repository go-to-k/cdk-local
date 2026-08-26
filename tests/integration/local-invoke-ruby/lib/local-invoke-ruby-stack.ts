import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
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
 * Fixture stack for `cdkl invoke` Ruby integ test (issue #248).
 *
 * Two Lambdas:
 *   - `EchoHandler` — asset-backed Ruby 3.3 function that echoes its
 *     event plus the value of an env var. Exercises the asset-path
 *     bind-mount code path AND the env-var resolution code path against
 *     the Ruby Lambda base image.
 *   - `InlineHandler` — `CfnFunction` with `Code: { ZipFile: ... }`
 *     directly (the L2 `lambda.Code.fromInline` construct refuses Ruby
 *     at synth time even though AWS Lambda itself accepts it; using the
 *     L1 escape hatch bypasses the construct-side guard). Exercises
 *     cdk-local's inline-code materializer with the `.rb` extension.
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only, mirroring `tests/integration/local-invoke-python/`.
 */
export class LocalInvokeRubyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.RUBY_3_3,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    const inlineRole = new iam.Role(this, 'InlineHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    new lambda.CfnFunction(this, 'InlineHandler', {
      runtime: 'ruby3.3',
      architectures: [HOST_ARCHITECTURE.name],
      handler: 'index.handler',
      role: inlineRole.roleArn,
      code: {
        zipFile: [
          'def handler(event:, context:)',
          '  { "inlineEcho" => event }',
          'end',
          '',
        ].join('\n'),
      },
      timeout: 10,
    });
  }
}
