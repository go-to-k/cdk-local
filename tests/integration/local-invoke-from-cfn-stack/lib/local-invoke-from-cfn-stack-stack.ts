import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * SSM parameter name the fixture's `verify.sh` `put-parameter`s BEFORE
 * `cdk deploy` (CloudFormation resolves `AWS::SSM::Parameter::Value<String>`
 * parameters at the start of a deploy, so the SSM value must already exist).
 * Kept in sync with `verify.sh`'s `SSM_PARAM_NAME`.
 */
const SSM_DB_HOST_PARAM = '/cdkl-integ/invoke-from-cfn-stack/db-host';

/**
 * SSM parameter name for the issue #99 SecureString case. `verify.sh`
 * creates it as a plain `String` BEFORE `cdk deploy` (CloudFormation
 * rejects an `AWS::SSM::Parameter::Value<String>` template parameter that
 * points at a SecureString), then SWAPS it to a `SecureString` AFTER
 * deploy. cdkl resolves the parameter directly via SSM `GetParameters`
 * (`WithDecryption`) at invoke time — independent of CloudFormation — so
 * it sees the SecureString type and routes the decrypted value off the
 * `docker run` argv. Kept in sync with `verify.sh`'s `SSM_API_KEY_PARAM`.
 */
const SSM_API_KEY_PARAM = '/cdkl-integ/invoke-from-cfn-stack/api-key';

/**
 * Fixture stack for `cdkl invoke --from-cfn-stack` (issue #606).
 *
 * One echo Lambda + one DynamoDB table + one sibling Lambda. The echo
 * Lambda's env exercises two distinct intrinsic shapes:
 *
 *   - `TABLE_NAME: Ref MyTable` — resolved from `ListStackResources`
 *     physical IDs (the original #606 path).
 *   - `SIBLING_ARN: Fn::GetAtt SiblingHandler.Arn` — NOT returned by
 *     `ListStackResources` (which carries physical IDs only, no
 *     attributes). Without `--from-cfn-stack` it warns-and-drops; with
 *     `--from-cfn-stack` the deployed-env fallback reads the echo
 *     function's already-resolved `Environment.Variables` via
 *     `lambda:GetFunctionConfiguration` (CloudFormation resolved the
 *     GetAtt to the sibling's real ARN at deploy time).
 *
 * Without `--from-cfn-stack` both intrinsics drop (same warn-and-drop
 * semantics as the `local-invoke-from-state` fixture). With it, after
 * the CDK app is deployed via the upstream `cdk deploy` (the CDK CLI, not
 * a host CLI like cdkd), both flow through to the container.
 *
 * Table carries `removalPolicy: DESTROY` so the integ teardown is
 * fully self-contained on `cdk destroy`.
 */
export class LocalInvokeFromCfnStackStack extends cdk.Stack {
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

    new lambda.Function(this, 'EchoTableHandler', {
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
        // issue #94: a `Ref` to an `AWS::SSM::Parameter::Value<String>`
        // CloudFormation parameter (what `valueForStringParameter`
        // synthesizes). ListStackResources cannot resolve this (it is a
        // CFn PARAMETER, not a resource), so without --from-cfn-stack it
        // warns-and-drops; with it, the new SSM resolver reads the value
        // from SSM and substitutes it.
        DB_HOST: ssm.StringParameter.valueForStringParameter(this, SSM_DB_HOST_PARAM),
        // issue #99: a `Ref` to a second `AWS::SSM::Parameter::Value<String>`
        // CFn parameter whose SSM parameter `verify.sh` swaps to a
        // SecureString after deploy. Under --from-cfn-stack cdkl resolves it
        // via SSM with WithDecryption and must route the decrypted value
        // through docker's value-from-process-env form (`-e API_KEY`), never
        // the inline `-e API_KEY=<value>` argv.
        API_KEY: ssm.StringParameter.valueForStringParameter(this, SSM_API_KEY_PARAM),
      },
      timeout: cdk.Duration.seconds(10),
    });
  }
}
