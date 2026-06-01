import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

/**
 * Fixture for `cdkl start-alb` weighted forward distribution
 * (issue #250, gap G5).
 *
 * Single HTTP:80 listener whose DEFAULT action is a `forward` with
 * TWO TargetGroups[] — a 60-weight `blue` target group and a
 * 40-weight `green` target group, each backed by its own
 * DesiredCount=1 ECS service. Each container replies with a stable
 * role tag (`blue` or `green`) so verify.sh can grep the response
 * body to count which target served each request.
 *
 * Real ALB picks one target group per request using its declared
 * weight; cdk-local's front-door implements the same per-request
 * weighted pick (`alb-path-matcher` + `front-door-server`).
 *
 * verify.sh sends 100 GETs in a loop and asserts the blue/green
 * count split is within +/-10% of the 60/40 declaration. The
 * tolerance is wide because 100 samples of a 60/40 binomial have
 * a single-sigma window of about +/-5 — +/-10 gives ~2 sigma
 * coverage, far enough above the noise floor to avoid flakes
 * while still detecting a broken weight implementation
 * (e.g. always-pick-first / 50/50 / 100/0).
 *
 * Bridge network mode keeps the local exec path simple. Each
 * replica publishes its container port on an ephemeral host port;
 * the front-door binds the listener port (remapped via
 * `--lb-port` in verify.sh).
 *
 * `covers: AWS::ElasticLoadBalancingV2::Listener` (forward action
 * with `ForwardConfig.TargetGroups[]` weighted distribution).
 */
function helloServer(role: string): string {
  return [
    'import http.server,socket',
    'class H(http.server.BaseHTTPRequestHandler):',
    ' def do_GET(s):',
    `  b=('${role}'+chr(10)).encode()`,
    "  s.send_response(200);s.send_header('Content-Length',str(len(b)));s.end_headers();s.wfile.write(b)",
    ' def log_message(s,*a):pass',
    "http.server.HTTPServer(('0.0.0.0',80),H).serve_forever()",
  ].join('\n');
}

export class LocalStartAlbWeightedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-alb-weighted-fixture',
    });

    const mkTask = (logicalId: string, family: string, role: string): ecs.CfnTaskDefinition =>
      new ecs.CfnTaskDefinition(this, logicalId, {
        family,
        networkMode: 'bridge',
        containerDefinitions: [
          {
            name: role,
            image: 'public.ecr.aws/docker/library/python:3.12-alpine',
            essential: true,
            entryPoint: ['python', '-c'],
            command: [helloServer(role)],
            memoryReservation: 32,
            portMappings: [{ containerPort: 80, protocol: 'tcp' }],
          },
        ],
      });

    const blueTask = mkTask('BlueTask', 'cdkl-start-alb-weighted-blue', 'blue');
    const greenTask = mkTask('GreenTask', 'cdkl-start-alb-weighted-green', 'green');

    const blueTg = new elbv2.CfnTargetGroup(this, 'BlueTargetGroup', {
      port: 80,
      protocol: 'HTTP',
      targetType: 'instance',
    });
    const greenTg = new elbv2.CfnTargetGroup(this, 'GreenTargetGroup', {
      port: 80,
      protocol: 'HTTP',
      targetType: 'instance',
    });

    const loadBalancer = new elbv2.CfnLoadBalancer(this, 'WebLB', {
      type: 'application',
    });

    // Weighted default-forward listener — 60/40 blue/green split.
    new elbv2.CfnListener(this, 'WebListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [
        {
          type: 'forward',
          forwardConfig: {
            targetGroups: [
              { targetGroupArn: blueTg.ref, weight: 60 },
              { targetGroupArn: greenTg.ref, weight: 40 },
            ],
          },
        },
      ],
    });

    new ecs.CfnService(this, 'BlueService', {
      cluster: cluster.ref,
      taskDefinition: blueTask.ref,
      desiredCount: 1,
      launchType: 'EC2',
      loadBalancers: [{ containerName: 'blue', containerPort: 80, targetGroupArn: blueTg.ref }],
    });

    new ecs.CfnService(this, 'GreenService', {
      cluster: cluster.ref,
      taskDefinition: greenTask.ref,
      desiredCount: 1,
      launchType: 'EC2',
      loadBalancers: [{ containerName: 'green', containerPort: 80, targetGroupArn: greenTg.ref }],
    });
  }
}
