import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

    // Sibling function whose ARN the echo handler references via GetAtt.
    // Never invoked locally — it exists only to give the GetAtt a real
    // deployed ARN to resolve to.
    const sibling = new lambda.Function(this, 'SiblingHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(10),
    });

    const echo = new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
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
      },
      timeout: cdk.Duration.seconds(10),
    });

    echo.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
  }
}
