import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

/**
 * Fixture for `cdkl start-alb` HTTPS termination.
 *
 * Mirrors `local-start-alb` but adds a second listener on HTTPS:443 that
 * forwards to the SAME target group, so the same 2-replica web service is
 * reachable over both HTTP and locally-terminated HTTPS. The local front-door
 * picks up the `protocol: 'HTTPS'` listener and generates a self-signed cert
 * (cached under `$XDG_CACHE_HOME/cdk-local/alb-https/`) — the deployed ALB's
 * ACM cert ARNs in `certificates[]` are NOT fetched (ACM private keys are
 * not retrievable by design), so we pass `certificates: []` here.
 *
 * The replica payload is a tiny Python HTTP server replying with its own
 * hostname; the integ harness curls both schemes and asserts the HTTPS path
 * reaches the same backing replicas as the HTTP path.
 */
// chr(10) keeps this a clean newline-joined array (a literal '\n' would
// split the line during synthesis).
const HELLO_SERVER = [
  'import http.server,socket',
  'class H(http.server.BaseHTTPRequestHandler):',
  ' def do_GET(s):',
  "  b=('replica '+socket.gethostname()+chr(10)).encode()",
  "  s.send_response(200);s.send_header('Content-Length',str(len(b)));s.end_headers();s.wfile.write(b)",
  ' def log_message(s,*a):pass',
  "http.server.HTTPServer(('0.0.0.0',80),H).serve_forever()",
].join('\n');

export class LocalStartAlbHttpsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-alb-https-fixture',
    });

    const taskDef = new ecs.CfnTaskDefinition(this, 'WebTask', {
      family: 'cdkl-start-alb-https-web',
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

    const targetGroup = new elbv2.CfnTargetGroup(this, 'WebTargetGroup', {
      port: 80,
      protocol: 'HTTP',
      targetType: 'instance',
    });

    const loadBalancer = new elbv2.CfnLoadBalancer(this, 'WebLB', {
      type: 'application',
    });

    new elbv2.CfnListener(this, 'WebHttpListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.ref }],
    });

    // HTTPS:443 forwards to the same target group. The deployed listener's
    // ACM cert ARNs would normally live in `certificates[]`, but cdk-local
    // does not fetch ACM private keys (they are not retrievable), so the
    // local front-door generates a self-signed cert on its own.
    new elbv2.CfnListener(this, 'WebHttpsListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 443,
      protocol: 'HTTPS',
      certificates: [],
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
