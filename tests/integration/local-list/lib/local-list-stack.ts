import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

/**
 * Fixture stack for `cdkl list` target enumeration integ test.
 *
 * Hand-rolls one resource of each kind `cdkl list` emits a group for, using
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
 * The test never executes any of these — `cdkl list` is a pure synth-time
 * read over the cloud assembly templates, so placeholder ARNs / URIs are
 * fine. The fixture only exists so the integ can assert each group + target
 * label is emitted under the expected command.
 */
export class LocalListStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda function — inline code so synth has no asset / bundling step.
    const fn = new lambda.Function(this, 'MyHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        "exports.handler = async () => ({ statusCode: 200, body: 'ok' });"
      ),
    });

    // HTTP API v2 + a single Lambda-backed route.
    const httpApi = new apigwv2.CfnApi(this, 'MyHttpApi', {
      name: 'cdkl-list-fixture-http-api',
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

    // ECS cluster + bridge-mode task definition + service.
    const cluster = new ecs.CfnCluster(this, 'MyCluster', {
      clusterName: 'cdkl-list-fixture-cluster',
    });
    const taskDef = new ecs.CfnTaskDefinition(this, 'MyTask', {
      family: 'cdkl-list-fixture-task',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'web',
          image: 'public.ecr.aws/docker/library/python:3.12-alpine',
          essential: true,
          memoryReservation: 32,
          portMappings: [{ containerPort: 80, protocol: 'tcp' }],
        },
      ],
    });

    // Target group + listener + ALB fronting the ECS service.
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
      port: 80,
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

    // AgentCore Runtime — L1 only so no role/network resolution is needed.
    // The container URI / role ARN are placeholders: `cdkl list` reads the
    // resource type + path metadata only, never these properties.
    new agentcore.CfnRuntime(this, 'MyAgent', {
      agentRuntimeName: 'cdkl_list_fixture_agent',
      roleArn: 'arn:aws:iam::123456789012:role/cdkl-list-fixture-agent-role',
      networkConfiguration: { networkMode: 'PUBLIC' },
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri:
            '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdkl-list-fixture-agent:latest',
        },
      },
    });
  }
}
