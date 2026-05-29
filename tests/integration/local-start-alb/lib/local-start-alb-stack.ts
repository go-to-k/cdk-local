import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

/**
 * Fixture for `cdkl start-alb` (Issue #86 v1).
 *
 * Hand-rolls the synthesized shape of an ALB-fronted ECS service using L1
 * resources so the fixture stays VPC-free and deterministic (cdk-local only
 * reads the template; it never deploys to AWS):
 *
 *   - `AWS::ECS::Service` with DesiredCount=2 and a `LoadBalancers[]` entry
 *     pointing at the target group.
 *   - `AWS::ElasticLoadBalancingV2::TargetGroup` (HTTP:80).
 *   - `AWS::ElasticLoadBalancingV2::Listener` whose default action forwards to
 *     that target group on port 80.
 *
 * The container is a tiny Python HTTP server that replies with its own
 * hostname (the docker container id), so the integ harness can curl the
 * host-side front-door endpoint and assert it round-robins across the two
 * replicas (>= 2 distinct hostnames).
 *
 * Bridge network mode keeps the local exec path simple (no awsvpc → bridge
 * fallback noise). The container port is published on an ephemeral host port
 * per replica; the front-door binds the listener port (remapped to a
 * non-privileged host port via `--lb-port` in verify.sh).
 *
 * `covers: AWS::ECS::Service` (matrix opt-in marker — see docs/integ-coverage.md).
 */
// chr(10) is a newline in the response body; kept as chr(10) so the program
// stays a clean newline-joined array (a literal '\n' here would split the line).
const HELLO_SERVER = [
  'import http.server,socket',
  'class H(http.server.BaseHTTPRequestHandler):',
  ' def do_GET(s):',
  "  b=('replica '+socket.gethostname()+chr(10)).encode()",
  "  s.send_response(200);s.send_header('Content-Length',str(len(b)));s.end_headers();s.wfile.write(b)",
  ' def log_message(s,*a):pass',
  "http.server.HTTPServer(('0.0.0.0',80),H).serve_forever()",
].join('\n');

export class LocalStartAlbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-service-alb-fixture',
    });

    const taskDef = new ecs.CfnTaskDefinition(this, 'WebTask', {
      family: 'cdkl-start-service-alb-web',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'web',
          image: 'public.ecr.aws/docker/library/python:3.12-alpine',
          essential: true,
          entryPoint: ['python', '-c'],
          command: [HELLO_SERVER],
          memoryReservation: 32,
          portMappings: [{ containerPort: 80, protocol: 'tcp' }],
        },
      ],
    });

    // A target group + listener so the resolver can chain
    // Service.LoadBalancers[] -> TargetGroup -> Listener and learn the
    // listener port to front. Minimal L1 props — no real VPC needed.
    const targetGroup = new elbv2.CfnTargetGroup(this, 'WebTargetGroup', {
      port: 80,
      protocol: 'HTTP',
      targetType: 'instance',
    });

    const loadBalancer = new elbv2.CfnLoadBalancer(this, 'WebLB', {
      type: 'application',
    });

    new elbv2.CfnListener(this, 'WebListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.ref }],
    });

    new ecs.CfnService(this, 'WebService', {
      cluster: cluster.ref,
      taskDefinition: taskDef.ref,
      desiredCount: 2,
      launchType: 'EC2',
      loadBalancers: [
        {
          containerName: 'web',
          containerPort: 80,
          targetGroupArn: targetGroup.ref,
        },
      ],
    });
  }
}
