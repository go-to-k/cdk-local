import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ConsumerStackProps extends cdk.StackProps {
  /**
   * The CloudFormation `Export.Name` to resolve via `Fn::ImportValue`.
   * Must match the producer stack's exported name.
   */
  readonly exportName: string;
}

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
 * Consumer stack for the 2-stack `Fn::ImportValue` integ (issue #611).
 *
 * One Lambda whose `SHARED_VALUE` env var is `Fn::ImportValue:
 * <exportName>` — an intrinsic that resolves at CloudFormation deploy
 * time to whatever the producer stack exported. The handler echoes
 * the env var back so the integ can assert two things:
 *
 *   1. Baseline (no `--from-cfn-stack`): `SHARED_VALUE` is `"unset"`
 *      because cdk-local's local-invoke default behavior drops
 *      intrinsic-valued env vars (warn-and-drop).
 *   2. With `--from-cfn-stack`: `SHARED_VALUE` equals the producer's
 *      deployed parameter name, proving `Fn::ImportValue` substitution
 *      works against `cloudformation:ListExports`.
 *
 * That second assertion is what makes this fixture distinct from the
 * single-stack `local-invoke-from-cfn-stack` fixture, which only
 * exercises `Ref` substitution.
 */
export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConsumerStackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'EchoSharedHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(10),
    });

    // CDK's typed env-var API auto-tokenizes intrinsics, but
    // Fn::ImportValue across stacks resolves through the cross-stack
    // export path which is exactly what we want. Use the CfnFunction
    // override directly so the synthesized template carries a literal
    // `Fn::ImportValue` against the configured export name with no
    // intermediate parameter — exactly mirroring the shape of a
    // hand-authored CFn template the user might deploy via `cdk
    // deploy`.
    const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
    cfnFn.addPropertyOverride('Environment.Variables.SHARED_VALUE', {
      'Fn::ImportValue': props.exportName,
    });
    // A literal env var to confirm --from-cfn-stack doesn't break
    // normal-case behavior on its way through (parallel to the
    // single-stack fixture's STATIC_VALUE).
    cfnFn.addPropertyOverride('Environment.Variables.STATIC_VALUE', 'always-the-same');
  }
}
