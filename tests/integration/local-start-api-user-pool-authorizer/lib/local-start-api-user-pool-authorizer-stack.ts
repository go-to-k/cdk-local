import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
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
 *
 * A REST v1 API behind `CognitoUserPoolsAuthorizer` on the same pool rides
 * along (go-to-k/cdk-local#1010): its `ProviderARNs` is
 * `[Fn::GetAtt <Pool>.Arn]`, which only a state source resolves.
 *
 * go-to-k/cdk-local#1011: a scoped REST method and two scoped HTTP routes
 * (one scope every access token carries, one none does), plus a REST TOKEN
 * authorizer with an `IdentityValidationExpression`.
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
    const httpAuthorizer = new HttpUserPoolAuthorizer('Auth', pool, { userPoolClients: [clientA] });
    const httpIntegration = new HttpLambdaIntegration('SecureIntegration', fn);
    api.addRoutes({
      path: '/secure',
      methods: [apigwv2.HttpMethod.GET],
      integration: httpIntegration,
      authorizer: httpAuthorizer,
    });
    // Every Cognito access token carries this scope; none carries other/scope.
    api.addRoutes({
      path: '/secure-scoped-ok',
      methods: [apigwv2.HttpMethod.GET],
      integration: httpIntegration,
      authorizer: httpAuthorizer,
      authorizationScopes: ['aws.cognito.signin.user.admin'],
    });
    api.addRoutes({
      path: '/secure-scoped-miss',
      methods: [apigwv2.HttpMethod.GET],
      integration: httpIntegration,
      authorizer: httpAuthorizer,
      authorizationScopes: ['other/scope'],
    });

    const restApi = new apigw.RestApi(this, 'RestApi', {
      deployOptions: { stageName: 'prod' },
      // No account-level CloudWatch role: CDK retains it on destroy.
      cloudWatchRole: false,
    });
    const restAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'RestAuth', {
      cognitoUserPools: [pool],
    });
    const restIntegration = new apigw.LambdaIntegration(fn);
    restApi.root.addResource('rest-secure').addMethod('GET', restIntegration, {
      authorizer: restAuthorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
      // Not enforced locally (API keys live in the deployed API): it must be
      // warned per route rather than dropped silently.
      apiKeyRequired: true,
    });
    restApi.root.addResource('rest-scoped').addMethod('GET', restIntegration, {
      authorizer: restAuthorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
      authorizationScopes: ['aws.cognito.signin.user.admin'],
    });
    const tokenFn = new lambda.Function(this, 'TokenAuthorizerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.authorize',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(10),
    });
    restApi.root.addResource('rest-token').addMethod('GET', restIntegration, {
      authorizer: new apigw.TokenAuthorizer(this, 'TokenAuth', {
        handler: tokenFn,
        validationRegex: '^Bearer [a-z]+$',
        resultsCacheTtl: cdk.Duration.seconds(0),
      }),
      authorizationType: apigw.AuthorizationType.CUSTOM,
    });

    new cdk.CfnOutput(this, 'PoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'ClientAId', { value: clientA.userPoolClientId });
    new cdk.CfnOutput(this, 'ClientBId', { value: clientB.userPoolClientId });
  }
}
