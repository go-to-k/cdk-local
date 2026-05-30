import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture for `cdkl start-alb` -> WebSocket Upgrade proxy (#176).
 *
 * Two listeners on the same synthetic ALB exercise both branches of the
 * upgrade dispatch the front-door has to handle:
 *
 *   - Listener port 80 -> ECS forward target. The container runs a tiny
 *     Python `websockets` echo server on container port 8080. The
 *     front-door is expected to bridge the inbound upgrade request through
 *     to the picked replica so a `ws://127.0.0.1:<lb-port-80>/...` round
 *     trips a frame.
 *   - Listener port 81 -> Lambda forward target (`TargetType: lambda`).
 *     The Lambda just returns plain HTTP; the front-door is expected to
 *     refuse the upgrade with 502 over the raw TCP socket BEFORE the
 *     Lambda is ever invoked (mirrors ALB itself — Lambda TGs do not
 *     support WebSocket).
 *
 * Hand-rolled L1 ELBv2 / ECS resources so the fixture stays VPC-free and
 * deterministic (cdk-local only reads the template; it never deploys to AWS).
 *
 * `covers: AWS::ECS::Service, AWS::Lambda::Function` (the front-door bridges
 * the WS upgrade to an ECS replica and refuses upgrade on a Lambda target).
 */
// Inline Python WebSocket echo server. Keep the program as a newline-joined
// array so a stray '\n' literal here cannot accidentally split the line.
//
// The container starts by pip-installing `websockets` (a tiny pure-Python
// package), then exec's a one-shot asyncio echo server on container port 8080.
// `gethostname()` is included in the greeting message so a future round-robin
// test could distinguish replicas, but the current verify.sh only asserts on
// the echoed payload (Test 1 / Test 3).
const WS_ECHO_SERVER = [
  'import asyncio,os,socket',
  'from websockets.asyncio.server import serve',
  'async def handler(ws):',
  '  hello=("ready "+socket.gethostname()).encode()',
  '  await ws.send(hello)',
  '  async for msg in ws:',
  '    await ws.send(msg)',
  'async def main():',
  '  async with serve(handler,"0.0.0.0",8080):',
  '    await asyncio.Future()',
  'asyncio.run(main())',
].join('\n');

const WS_BOOT = [
  'set -e',
  // `--quiet --quiet` so the container log stays readable while the
  // websockets wheel is downloaded once on cold start. The image already
  // ships pip; no apk add needed.
  'pip install --quiet --quiet --disable-pip-version-check websockets',
  `exec python -c "${WS_ECHO_SERVER.replace(/"/g, '\\"')}"`,
].join('\n');

export class LocalStartAlbWebSocketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- ECS service: a WebSocket echo backend on container port 8080 ---
    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-alb-ws-fixture',
    });

    const taskDef = new ecs.CfnTaskDefinition(this, 'WsTask', {
      family: 'cdkl-start-alb-ws-echo',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'wsecho',
          image: 'public.ecr.aws/docker/library/python:3.12-alpine',
          essential: true,
          entryPoint: ['sh', '-c'],
          command: [WS_BOOT],
          memoryReservation: 64,
          portMappings: [{ containerPort: 8080, protocol: 'tcp' }],
        },
      ],
    });

    // --- Synthetic ALB shell (no real VPC needed; cdk-local only reads template) ---
    const loadBalancer = new elbv2.CfnLoadBalancer(this, 'WsLB', {
      type: 'application',
    });

    // ECS target group bound to container port 8080.
    const wsTargetGroup = new elbv2.CfnTargetGroup(this, 'WsTargetGroup', {
      port: 8080,
      protocol: 'HTTP',
      targetType: 'instance',
    });

    // ECS listener on ALB port 80 (default action -> WS echo target group).
    new elbv2.CfnListener(this, 'WsListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [{ type: 'forward', targetGroupArn: wsTargetGroup.ref }],
    });

    new ecs.CfnService(this, 'WsService', {
      cluster: cluster.ref,
      taskDefinition: taskDef.ref,
      desiredCount: 2,
      launchType: 'EC2',
      loadBalancers: [
        {
          containerName: 'wsecho',
          containerPort: 8080,
          targetGroupArn: wsTargetGroup.ref,
        },
      ],
    });

    // --- Lambda target on a separate listener to exercise the 502-on-upgrade branch ---
    const lambdaCode = lambda.Code.fromAsset(path.join(__dirname, '../lambda'));

    const plainFn = new lambda.Function(this, 'PlainFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambdaCode,
      timeout: cdk.Duration.seconds(10),
    });
    plainFn.addPermission('AlbInvoke', {
      principal: new cdk.aws_iam.ServicePrincipal('elasticloadbalancing.amazonaws.com'),
    });

    const plainTg = new elbv2.CfnTargetGroup(this, 'PlainTargetGroup', {
      targetType: 'lambda',
      targets: [{ id: plainFn.functionArn }],
    });

    // Lambda listener on ALB port 81 (default action -> plain Lambda).
    // A WS upgrade to this listener must be refused with 502 by the
    // front-door (mirrors ALB; Lambda TGs do not support WebSocket).
    new elbv2.CfnListener(this, 'PlainListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 81,
      protocol: 'HTTP',
      defaultActions: [{ type: 'forward', targetGroupArn: plainTg.ref }],
    });
  }
}
