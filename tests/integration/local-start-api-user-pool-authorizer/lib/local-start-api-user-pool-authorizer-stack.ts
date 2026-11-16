import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Run the Lambda at the HOST's CPU architecture (issue #560): the default
// X86_64 would run under emulation on an arm64 host and flake the Go RIE.
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

/**
 * Fixture stack for `cdkl start-api` behind aws-cdk-lib's
 * `HttpUserPoolAuthorizer` (issue #1001). The authorizer's JwtConfiguration
 * Issuer is a `Fn::Join` over `Ref AWS::Region` + `Ref <UserPool>` and its
 * Audience is `[Ref <UserPoolClient>]`, so only a state source can resolve
 * them. Client B exists but is NOT given to the authorizer: its tokens carry
 * a valid signature and the wrong audience.
 */
export class LocalStartApiUserPoolAuthorizerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pool = new cognito.UserPool(this, 'Pool', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const clientA = pool.addClient('ClientA', { authFlows: { adminUserPassword: true } });
    const clientB = pool.addClient('ClientB', { authFlows: { adminUserPassword: true } });

    const fn = new lambda.Function(this, 'SecureHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(10),
    });

    const api = new apigwv2.HttpApi(this, 'Api');
    api.addRoutes({
      path: '/secure',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('SecureIntegration', fn),
      authorizer: new HttpUserPoolAuthorizer('Auth', pool, { userPoolClients: [clientA] }),
    });

    new cdk.CfnOutput(this, 'PoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'ClientAId', { value: clientA.userPoolClientId });
    new cdk.CfnOutput(this, 'ClientBId', { value: clientB.userPoolClientId });
  }
}
