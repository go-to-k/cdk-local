import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

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
 * Fixture stack for `cdkl start-api --from-cfn-stack`.
 *
 * The originally-reported bug was on `start-api`: an env var set to
 * `Fn::GetAtt <SiblingFn>.Arn` warn-and-dropped under `--from-cfn-stack`
 * because `ListStackResources` returns physical IDs only (no attributes).
 * The deployed-env fallback closes that gap by reading the consumer
 * function's deploy-time-resolved `Environment.Variables`.
 *
 * The echo Lambda is fronted by a Function URL so `cdkl start-api` can
 * route to it. Its env exercises two intrinsic shapes:
 *
 *   - `TABLE_NAME: Ref MyTable` — resolved from ListStackResources
 *     physical IDs (the existing #606 behavior — regression guard).
 *   - `SIBLING_ARN: Fn::GetAtt SiblingHandler.Arn` — recovered via the
 *     deployed-env fallback (the new behavior).
 *
 * Table carries `removalPolicy: DESTROY` so `cdk destroy` fully tears
 * the fixture down.
 */
export class LocalStartApiFromCfnStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'MyTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // issue #784: a same-stack secret the echo handler's env references
    // through a CloudFormation dynamic reference. The password is a fixed
    // test value kept in sync with verify.sh's DYNREF_SECRET_PASSWORD.
    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretObjectValue: { password: cdk.SecretValue.unsafePlainText('dynref-api-pw-3b81d0') },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // issue #784: a NoEcho parameter. Its Ref is filled from the deployed env
    // under --from-cfn-stack, and that fill must stay off the docker argv.
    // Default kept in sync with verify.sh's NOECHO_PW_VALUE.
    const noEchoPw = new cdk.CfnParameter(this, 'NoEchoPw', {
      type: 'String',
      noEcho: true,
      default: 'noecho-api-pw-8e40c2',
    });

    // Sibling function whose ARN the echo handler references via GetAtt.
    // Never invoked locally — it exists only to give the GetAtt a real
    // deployed ARN to resolve to.
    const sibling = new lambda.Function(this, 'SiblingHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(10),
    });

    const echo = new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        // Intrinsic-valued env var resolved from ListStackResources
        // physical IDs. Without --from-cfn-stack it would be dropped.
        TABLE_NAME: table.tableName,
        // Intrinsic-valued env var that ListStackResources can NOT
        // resolve (Fn::GetAtt .Arn). With --from-cfn-stack the
        // deployed-env fallback recovers it from the echo function's
        // own deployed Environment.Variables.
        SIBLING_ARN: sibling.functionArn,
        // A literal env var to confirm --from-cfn-stack doesn't break
        // normal-case behavior on its way through.
        STATIC_VALUE: 'always-the-same',
        // issue #784: `{{resolve:secretsmanager:<Ref>:SecretString:password::}}`
        // — a Fn::Join over a Ref, so only --from-cfn-stack turns it into a
        // literal token, which start-api must resolve before boot.
        DYNREF_SECRET: dbSecret.secretValueFromJson('password').unsafeUnwrap(),
        // A Ref to a NoEcho parameter, recovered by the deployed-env fill.
        NOECHO_PW: noEchoPw.valueAsString,
      },
      timeout: cdk.Duration.seconds(10),
    });

    echo.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
  }
}
