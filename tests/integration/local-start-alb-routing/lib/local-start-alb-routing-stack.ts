import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

/**
 * Fixture for `cdkl start-alb` path-pattern routing (#123 path-pattern slice).
 *
 * Hand-rolls the synthesized shape of an ALB whose single HTTP:80 listener
 * path-routes across TWO ECS services, using L1 resources so the fixture stays
 * VPC-free and deterministic (cdk-local only reads the template; it never
 * deploys to AWS):
 *
 *   - `web` service (DesiredCount=2) behind `WebTargetGroup` — the listener
 *     DEFAULT action forwards here.
 *   - `api` service (DesiredCount=1) behind `ApiTargetGroup` — a
 *     `AWS::ElasticLoadBalancingV2::ListenerRule` (priority 10,
 *     `path-pattern` `/api/*`) forwards here.
 *
 * Each container is a tiny Python HTTP server that replies with
 * `<role> <hostname>` (role = `web` / `api`, hostname = the docker container
 * id), so the integ harness can assert that `/` reaches the web replicas
 * (round-robin across 2) while `/api/...` is path-routed to the api service.
 *
 * Bridge network mode keeps the local exec path simple. The container port is
 * published on an ephemeral host port per replica; the front-door binds the
 * listener port (remapped to a non-privileged host port via `--lb-port` in
 * verify.sh).
 *
 * `covers: AWS::ElasticLoadBalancingV2::ListenerRule` (matrix opt-in marker).
 */
// chr(10) is a newline in the response body; kept as chr(10) so the program
// stays a clean newline-joined array (a literal '\n' here would split the line).
function helloServer(role: string): string {
  return [
    'import http.server,socket',
    'class H(http.server.BaseHTTPRequestHandler):',
    ' def do_GET(s):',
    `  b=('${role} '+socket.gethostname()+chr(10)).encode()`,
    "  s.send_response(200);s.send_header('Content-Length',str(len(b)));s.end_headers();s.wfile.write(b)",
    ' def log_message(s,*a):pass',
    "http.server.HTTPServer(('0.0.0.0',80),H).serve_forever()",
  ].join('\n');
}

export class LocalStartAlbRoutingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-alb-routing-fixture',
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

    const webTask = mkTask('WebTask', 'cdkl-start-alb-routing-web', 'web');
    const apiTask = mkTask('ApiTask', 'cdkl-start-alb-routing-api', 'api');

    const webTg = new elbv2.CfnTargetGroup(this, 'WebTargetGroup', {
      port: 80,
      protocol: 'HTTP',
      targetType: 'instance',
    });
    const apiTg = new elbv2.CfnTargetGroup(this, 'ApiTargetGroup', {
      port: 80,
      protocol: 'HTTP',
      targetType: 'instance',
    });

    const loadBalancer = new elbv2.CfnLoadBalancer(this, 'WebLB', { type: 'application' });

    const listener = new elbv2.CfnListener(this, 'WebListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      // Default action -> web; the path rule below carves `/api/*` out to api.
      defaultActions: [{ type: 'forward', targetGroupArn: webTg.ref }],
    });

    new elbv2.CfnListenerRule(this, 'ApiRule', {
      listenerArn: listener.ref,
      priority: 10,
      conditions: [{ field: 'path-pattern', pathPatternConfig: { values: ['/api/*'] } }],
      actions: [{ type: 'forward', targetGroupArn: apiTg.ref }],
    });

    new ecs.CfnService(this, 'WebService', {
      cluster: cluster.ref,
      taskDefinition: webTask.ref,
      desiredCount: 2,
      launchType: 'EC2',
      loadBalancers: [{ containerName: 'web', containerPort: 80, targetGroupArn: webTg.ref }],
    });

    new ecs.CfnService(this, 'ApiService', {
      cluster: cluster.ref,
      taskDefinition: apiTask.ref,
      desiredCount: 1,
      launchType: 'EC2',
      loadBalancers: [{ containerName: 'api', containerPort: 80, targetGroupArn: apiTg.ref }],
    });
  }
}
