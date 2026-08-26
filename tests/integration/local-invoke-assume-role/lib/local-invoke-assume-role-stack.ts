import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

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
 * Fixture stack for `cdkl invoke --assume-role`.
 *
 * Defines one Lambda whose handler calls `sts:GetCallerIdentity` and
 * returns the result, plus an execution role with a CUSTOM trust policy
 * that also lets the developer's account (the caller of `cdk deploy`)
 * `sts:AssumeRole` into it. cdkl's `--assume-role` injects the assumed
 * role's STS credentials as the AWS env vars seen by the Lambda
 * container, so the in-container STS call reports an
 * `arn:aws:sts::<account>:assumed-role/<RoleName>/<session>` identity —
 * a marker the integ harness greps for.
 *
 * The custom trust policy adds an `AccountRootPrincipal()` alongside the
 * standard `ServicePrincipal('lambda.amazonaws.com')`, so:
 *
 *   - Lambda continues to be allowed to use this role at deploy time
 *     (`cdk deploy` succeeds).
 *   - The deploying developer (or any caller in the same account) can
 *     `AssumeRole` it locally — what `cdkl --assume-role` needs.
 *
 * The default execution role CDK would generate trusts only the Lambda
 * service principal, so `--assume-role` against it would fail with
 * `AccessDenied`. The custom role makes the fixture self-contained.
 */
export class LocalInvokeAssumeRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const executionRole = new iam.Role(this, 'AssumableExecRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.AccountRootPrincipal(),
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    new lambda.Function(this, 'EchoIdentityHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(here, '..', 'lambda')),
      role: executionRole,
      timeout: cdk.Duration.seconds(15),
    });

    // Surface the role ARN as a stack output so verify.sh can pass it to
    // the explicit `--assume-role <arn>` test case without an extra
    // describe-stack-resources hop.
    new cdk.CfnOutput(this, 'ExecRoleArn', {
      value: executionRole.roleArn,
      description: 'ARN of the role that the Lambda runs as and that --assume-role assumes',
    });
  }
}
