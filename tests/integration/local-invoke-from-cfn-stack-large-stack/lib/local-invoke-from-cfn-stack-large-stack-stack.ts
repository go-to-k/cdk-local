import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture for `cdkl invoke --from-cfn-stack` against a stack with MORE
 * than 100 resources.
 *
 * Regression guard for the CloudFormation `DescribeStackResources` cap:
 * that API returns only the first 100 resources of a stack with no
 * pagination token, so a stack with > 100 resources silently loses its
 * tail and every `Ref` to a dropped resource warn-and-drops its Lambda
 * env var. The `--from-cfn-stack` provider must walk the paginated
 * `ListStackResources` so all resources are mapped regardless of count.
 *
 * Shape: PARAM_COUNT (> 100) SSM parameters + one Lambda. The Lambda's
 * env has one intrinsic-valued var per parameter (`Ref` -> parameter
 * name). Two details keep the fixture honest:
 *
 *   - Each parameter carries an explicit SHORT name so the deployed
 *     Lambda env (CFn resolves every `Ref` to its name at deploy time)
 *     stays under the 4 KB Lambda env limit.
 *   - The env values are the L1 `.ref` intrinsic, not the literal
 *     explicit name, so the substitution code path is actually
 *     exercised (a literal would pass through without touching the
 *     state source).
 *
 * Without --from-cfn-stack every intrinsic env var drops (paramCount=0).
 * With --from-cfn-stack and the paginated provider, all PARAM_COUNT
 * names resolve (paramCount=PARAM_COUNT). With the old 100-cap provider
 * the count would fall short — the regression this fixture catches.
 */
const PARAM_COUNT = 105;

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

export class LocalInvokeFromCfnStackLargeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const environment: Record<string, string> = {
      // Literal env var: confirms --from-cfn-stack does not regress
      // normal-case pass-through on its way through the substituter.
      STATIC_VALUE: 'always-the-same',
    };

    for (let i = 0; i < PARAM_COUNT; i++) {
      const suffix = String(i).padStart(3, '0');
      const param = new ssm.CfnParameter(this, `Param${suffix}`, {
        type: 'String',
        name: `/cdkl-ls/p${suffix}`,
        value: `value-${suffix}`,
      });
      // `param.ref` synthesizes to `{ Ref: Param<suffix> }`, which CFn
      // resolves to the parameter NAME on the deployed stack. Forcing the
      // intrinsic (rather than using the literal explicit name) is what
      // routes this env var through the --from-cfn-stack substituter.
      environment[`P${suffix}`] = param.ref;
    }

    new lambda.Function(this, 'CountParamsHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment,
      timeout: cdk.Duration.seconds(10),
    });
  }
}
