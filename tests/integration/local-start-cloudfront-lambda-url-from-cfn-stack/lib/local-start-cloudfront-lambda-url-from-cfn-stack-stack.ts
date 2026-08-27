import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

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
 * Fixture stack for `cdkl start-cloudfront --from-cfn-stack` on a Lambda
 * Function URL origin (issue #380).
 *
 * A DynamoDB table + a Lambda whose `Environment.Variables` carries
 * `TABLE_NAME: Ref MyTable` (an intrinsic resolved from `ListStackResources`
 * physical IDs only under `--from-cfn-stack`) plus a literal `STATIC_VALUE`.
 * The Lambda has a Function URL (`AuthType: NONE`), and a CloudFront
 * distribution fronts it via `origins.FunctionUrlOrigin`.
 *
 * `verify.sh` deploys via the upstream `cdk` CLI, then serves the
 * distribution locally and asserts that a request through the CDN reaches the
 * Lambda with `TABLE_NAME` resolved to the deployed table's physical name —
 * proving the front-door Lambda path resolves env vars exactly like
 * `cdkl invoke --from-cfn-stack`. Without the flag, `TABLE_NAME` is dropped.
 *
 * The table carries `removalPolicy: DESTROY` so `cdk destroy` is fully
 * self-contained.
 */
export class LocalStartCloudFrontLambdaUrlFromCfnStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'MyTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'OriginFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      environment: {
        // Intrinsic — only resolvable under --from-cfn-stack (Ref -> the
        // deployed table's physical name via ListStackResources).
        TABLE_NAME: table.tableName,
        // Literal — always present, even without a state source.
        STATIC_VALUE: 'static-ok',
      },
    });

    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const stampHeader = new cloudfront.Function(this, 'StampFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var response = event.response;',
          "  response.headers['x-cdkl-fixture'] = { value: 'lambda-url-from-cfn' };",
          '  return response;',
          '}',
        ].join('\n')
      ),
    });

    new cloudfront.Distribution(this, 'ApiDist', {
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(fnUrl),
        functionAssociations: [
          { function: stampHeader, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
        ],
      },
    });
  }
}
