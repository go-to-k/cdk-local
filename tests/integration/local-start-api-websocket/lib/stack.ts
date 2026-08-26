// covers: AWS::ApiGatewayV2::Api
// covers: AWS::ApiGatewayV2::Integration
// covers: AWS::ApiGatewayV2::Route
// covers: AWS::ApiGatewayV2::Stage
// covers: AWS::Lambda::Function
// covers: AWS::IAM::Role
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'node:path';

/**
 * Run this fixture's Lambdas at the HOST's CPU architecture.
 *
 * cdk-local pins `docker --platform` to each function's declared
 * `Architectures` (see `pullImage` / `architectureToPlatform`), which is
 * the correct behavior: a `provided.*` bootstrap compiled for one arch
 * must get the matching base image. But a function that declares no
 * `architecture` defaults to `X86_64`, so on an arm64 host every
 * container in this fixture ran `linux/amd64` under CPU emulation --
 * and the Go RIE inside `public.ecr.aws/lambda/nodejs:20` faults
 * intermittently there, at a different assertion on every run
 * (issue #560).
 *
 * The base image is multi-arch -- `docker manifest inspect
 * public.ecr.aws/lambda/nodejs:20` lists both `arm64`/v8 and `amd64` --
 * so declaring the host arch makes the container native on an Apple
 * Silicon dev host AND on an x86_64 CI runner, rather than trading one
 * host's emulation for the other's. Nothing in verify.sh asserts the
 * architecture, so this costs no coverage.
 *
 * Keep this on every function in this fixture: a new handler that omits
 * it silently reintroduces #560 on arm64 hosts. `tests/unit/integ-fixture-host-architecture.test.ts`
 * fences that.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

/**
 * WebSocket API fixture for the `cdkl start-api` WebSocket integ
 * test (#462). The stack synthesizes 5 Lambdas + 1 WebSocket API + 5
 * routes — `$connect`, `$disconnect`, `$default`, `sendMessage` (echo),
 * `broadcast` (uses apigatewaymanagementapi to push a frame back to the
 * connection from inside the handler).
 *
 * `cdkl start-api` runs entirely against Docker / RIE — no AWS
 * deploy. The fixture is shaped so verify.sh can exercise each route
 * via a `ws` client and assert the responses.
 */
export class LocalStartApiWebSocketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Per-route handler Lambdas. Each one is a thin asset-backed
    // function with inline code (mounted at /var/task in the local
    // container).
    const connectFn = new lambda.Function(this, 'ConnectFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(import.meta.dirname, '..', 'lambda-connect')),
    });
    const disconnectFn = new lambda.Function(this, 'DisconnectFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(import.meta.dirname, '..', 'lambda-disconnect')),
    });
    const defaultFn = new lambda.Function(this, 'DefaultFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(import.meta.dirname, '..', 'lambda-default')),
    });
    const sendFn = new lambda.Function(this, 'SendFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(import.meta.dirname, '..', 'lambda-send')),
    });
    const broadcastFn = new lambda.Function(this, 'BroadcastFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(import.meta.dirname, '..', 'lambda-broadcast')),
    });

    // CfnApi with ProtocolType: WEBSOCKET + canonical body-action
    // selection expression (matches CDK 2.x's WebSocketApi default).
    const api = new apigwv2.CfnApi(this, 'WsApi', {
      name: 'WsApi',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });

    // Per-route integrations. CDK's CfnIntegration emits the canonical
    // `Fn::Join: ['', ['arn:...:lambda:path/2015-03-31/functions/', <Fn::GetAtt Arn>, '/invocations']]`
    // IntegrationUri shape that cdk-local's `intrinsic-lambda-arn.ts` parses.
    const region = cdk.Stack.of(this).region;
    function makeIntegration(scope: Construct, id: string, fn: lambda.Function): apigwv2.CfnIntegration {
      return new apigwv2.CfnIntegration(scope, id, {
        apiId: api.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: cdk.Fn.join('', [
          `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/`,
          fn.functionArn,
          '/invocations',
        ]),
      });
    }
    const integConnect = makeIntegration(this, 'IntegConnect', connectFn);
    const integDisconnect = makeIntegration(this, 'IntegDisconnect', disconnectFn);
    const integDefault = makeIntegration(this, 'IntegDefault', defaultFn);
    const integSend = makeIntegration(this, 'IntegSend', sendFn);
    const integBroadcast = makeIntegration(this, 'IntegBroadcast', broadcastFn);

    // Routes for every supported RouteKey.
    new apigwv2.CfnRoute(this, 'ConnectRoute', {
      apiId: api.ref,
      routeKey: '$connect',
      target: cdk.Fn.join('', ['integrations/', integConnect.ref]),
    });
    new apigwv2.CfnRoute(this, 'DisconnectRoute', {
      apiId: api.ref,
      routeKey: '$disconnect',
      target: cdk.Fn.join('', ['integrations/', integDisconnect.ref]),
    });
    new apigwv2.CfnRoute(this, 'DefaultRoute', {
      apiId: api.ref,
      routeKey: '$default',
      target: cdk.Fn.join('', ['integrations/', integDefault.ref]),
    });
    new apigwv2.CfnRoute(this, 'SendMessageRoute', {
      apiId: api.ref,
      routeKey: 'sendMessage',
      target: cdk.Fn.join('', ['integrations/', integSend.ref]),
    });
    new apigwv2.CfnRoute(this, 'BroadcastRoute', {
      apiId: api.ref,
      routeKey: 'broadcast',
      target: cdk.Fn.join('', ['integrations/', integBroadcast.ref]),
    });

    new apigwv2.CfnStage(this, 'ProdStage', {
      apiId: api.ref,
      stageName: 'prod',
      autoDeploy: true,
    });
  }
}
