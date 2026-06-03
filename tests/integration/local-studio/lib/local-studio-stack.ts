import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Runtime as AgentCoreRuntimeConstruct, AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkl studio` target enumeration integ test.
 *
 * Hand-rolls one resource of each kind `cdkl studio` emits a group for, using
 * inline Lambda code + L1 resources where possible so the stack synthesizes
 * without AWS / context / VPC lookups and without any asset bundling:
 *
 *   - `AWS::Lambda::Function`  (`MyHandler`)      -> Lambda Functions group
 *   - `AWS::ApiGatewayV2::Api` + Route + Integration (HTTP API v2 wired to
 *     `MyHandler`)                                -> APIs group
 *   - `AWS::Lambda::Url` on `MyHandler`           -> APIs group (Function URL)
 *   - `AWS::ECS::TaskDefinition` (`MyTask`)       -> ECS Task Definitions
 *   - `AWS::ECS::Service` (`MyService`)           -> ECS Services
 *   - `AWS::ElasticLoadBalancingV2::LoadBalancer` (`MyAlb`) +
 *     `AWS::ElasticLoadBalancingV2::TargetGroup` +
 *     `AWS::ElasticLoadBalancingV2::Listener`     -> Application Load Balancers
 *   - `AWS::BedrockAgentCore::Runtime` (`MyAgent`) -> AgentCore Runtimes
 *
 * Enumeration is a pure synth-time read over the cloud assembly templates, so
 * the Lambda / API / ECS / ALB resources use placeholder ARNs / URIs and are
 * never executed by the list assertions. Two resources ARE driven end-to-end
 * by `POST /api/run`, so they carry runnable artifacts: `MyHandler` (inline
 * code, invoked in a RIE container) and `MyAgent` (a buildable AgentCore
 * runtime whose `agent/` container is built + invoked through the studio
 * dispatch — issue #303).
 */
export class LocalStudioStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda function — inline code so synth has no asset / bundling step.
    const fn = new lambda.Function(this, 'MyHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      // Echoes the STUDIO_ENV_PROBE env var into the body so the per-target
      // `--env-vars` option (issue #301 slice 2) is observable end-to-end;
      // defaults to 'ok' so the other assertions are unaffected.
      code: lambda.Code.fromInline(
        "exports.handler = async () => ({ statusCode: 200, body: process.env.STUDIO_ENV_PROBE || 'ok' });"
      ),
    });

    // HTTP API v2 + a single Lambda-backed route.
    const httpApi = new apigwv2.CfnApi(this, 'MyHttpApi', {
      name: 'cdkl-studio-fixture-http-api',
      protocolType: 'HTTP',
    });
    const httpIntegration = new apigwv2.CfnIntegration(this, 'MyHttpIntegration', {
      apiId: httpApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: fn.functionArn,
      payloadFormatVersion: '2.0',
    });
    new apigwv2.CfnRoute(this, 'MyHttpRoute', {
      apiId: httpApi.ref,
      routeKey: 'GET /hello',
      target: cdk.Fn.join('/', ['integrations', httpIntegration.ref]),
    });

    // Function URL on the same Lambda — surfaces as an `apis` entry with
    // `(Function URL)` kind, keyed by the BACKING LAMBDA's logical ID.
    fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // WebSocket API (issue #303) — so studio can serve it and the browser
    // WebSocket console can connect + exchange frames. One inline Lambda backs
    // both routes: `$connect` admits the client; `$default` echoes the frame's
    // `text` back over the connection via the local `@connections` management
    // endpoint (`fetch`, no SDK — the local emulator does not require SigV4).
    // The body-action selection expression routes every message to `$default`.
    const wsFn = new lambda.Function(this, 'WsEchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          'exports.handler = async (event) => {',
          '  const rc = event.requestContext || {};',
          "  if (rc.routeKey === '$connect' || rc.routeKey === '$disconnect') return { statusCode: 200 };",
          '  const endpoint = process.env.AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI;',
          '  let parsed; try { parsed = JSON.parse(event.body || "{}"); } catch { parsed = { text: event.body }; }',
          '  await fetch(endpoint + "/@connections/" + encodeURIComponent(rc.connectionId), {',
          '    method: "POST",',
          '    body: JSON.stringify({ route: rc.routeKey, echo: parsed.text != null ? parsed.text : null, connectionId: rc.connectionId }),',
          '  });',
          '  return { statusCode: 200 };',
          '};',
        ].join('\n')
      ),
    });
    const wsApi = new apigwv2.CfnApi(this, 'MyWsApi', {
      name: 'cdkl-studio-fixture-ws-api',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });
    const wsRegion = cdk.Stack.of(this).region;
    const wsIntegrationUri = cdk.Fn.join('', [
      `arn:aws:apigateway:${wsRegion}:lambda:path/2015-03-31/functions/`,
      wsFn.functionArn,
      '/invocations',
    ]);
    const wsConnectInteg = new apigwv2.CfnIntegration(this, 'MyWsConnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: wsIntegrationUri,
    });
    const wsDefaultInteg = new apigwv2.CfnIntegration(this, 'MyWsDefaultIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: wsIntegrationUri,
    });
    new apigwv2.CfnRoute(this, 'MyWsConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      target: cdk.Fn.join('/', ['integrations', wsConnectInteg.ref]),
    });
    new apigwv2.CfnRoute(this, 'MyWsDefaultRoute', {
      apiId: wsApi.ref,
      routeKey: '$default',
      target: cdk.Fn.join('/', ['integrations', wsDefaultInteg.ref]),
    });
    new apigwv2.CfnStage(this, 'MyWsStage', {
      apiId: wsApi.ref,
      stageName: 'prod',
      autoDeploy: true,
    });

    // ECS cluster + bridge-mode task definition + service.
    const cluster = new ecs.CfnCluster(this, 'MyCluster', {
      clusterName: 'cdkl-studio-fixture-cluster',
    });
    const taskDef = new ecs.CfnTaskDefinition(this, 'MyTask', {
      family: 'cdkl-studio-fixture-task',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'web',
          image: 'public.ecr.aws/docker/library/python:3.12-alpine',
          essential: true,
          memoryReservation: 32,
          // Serve HTTP on the container port so the studio ALB serve has a
          // live upstream AND the service stays running (a long-running
          // command — the image's default `python3` REPL would exit at once).
          command: ['python', '-m', 'http.server', '80'],
          portMappings: [{ containerPort: 80, protocol: 'tcp' }],
        },
      ],
    });

    // Target group + listener + ALB fronting the ECS service. The listener
    // is on a high (non-privileged) port so the studio ALB serve binds it
    // locally without root and without a port remap.
    const targetGroup = new elbv2.CfnTargetGroup(this, 'MyTargetGroup', {
      port: 80,
      protocol: 'HTTP',
      targetType: 'instance',
    });
    const alb = new elbv2.CfnLoadBalancer(this, 'MyAlb', {
      type: 'application',
    });
    new elbv2.CfnListener(this, 'MyListener', {
      loadBalancerArn: alb.ref,
      port: 8080,
      protocol: 'HTTP',
      defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.ref }],
    });
    new ecs.CfnService(this, 'MyService', {
      cluster: cluster.ref,
      taskDefinition: taskDef.ref,
      desiredCount: 1,
      launchType: 'EC2',
      loadBalancers: [
        {
          containerName: 'web',
          containerPort: 80,
          targetGroupArn: targetGroup.ref,
        },
      ],
    });

    // AgentCore Runtime — a buildable L2 `Runtime` (issue #303). Its container
    // (in `agent/`, a tiny dep-free Node server) serves the AgentCore HTTP
    // contract on 8080 (GET /ping + POST /invocations, echoing the request +
    // the injected GREETING) AND a bidirectional /ws endpoint, so the studio
    // integ can drive a real single-shot invoke through the studio dispatch —
    // both the plain `POST /invocations` path and the `--ws` path — and assert
    // the agent's echoed response. The construct id stays `MyAgent` so the
    // studio target id (`LocalStudioFixture/MyAgent`, the `/Resource`-stripped
    // construct path) is unchanged for the enumeration assertion.
    new AgentCoreRuntimeConstruct(this, 'MyAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: { GREETING: 'hello-from-studio-agent' },
    });
  }
}
