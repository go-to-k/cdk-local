import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

/**
 * Fixture for `cdkl start-alb` host-header + fixed-response rule routing
 * (#123 deferred listener-rule slice).
 *
 * Hand-rolls the synthesized shape of an ALB whose single HTTP:80 listener
 * routes by the request `Host` header across TWO ECS services, with a
 * fixed-response default action for requests that match neither host. L1
 * resources keep the fixture VPC-free and deterministic (cdk-local only reads
 * the template; it never deploys to AWS):
 *
 *   - listener DEFAULT action -> `fixed-response` (418, body `default-fixed`)
 *     so a request whose Host matches no rule gets a synthesized response with
 *     NO backing pool.
 *   - `host-header` `api.cdklocal.test` (ListenerRule priority 10) -> `api`
 *     service (DesiredCount=1), replies `api <hostname>`.
 *   - `host-header` `web.cdklocal.test` (ListenerRule priority 20) -> `web`
 *     service (DesiredCount=1), replies `web <hostname>`.
 *
 * Each container is a tiny Python HTTP server that replies with
 * `<role> <hostname>`, so the integ harness can assert that a request with
 * `Host: api.cdklocal.test` reaches the api service, `Host: web.cdklocal.test`
 * reaches the web service, and a request with an unmatched Host gets the
 * fixed-response default (synthesized by the front-door, no proxy).
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

export class LocalStartAlbRoutingConditionsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-alb-routing-conditions-fixture',
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

    const webTask = mkTask('WebTask', 'cdkl-start-alb-conditions-web', 'web');
    const apiTask = mkTask('ApiTask', 'cdkl-start-alb-conditions-api', 'api');

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
      // Default action: a fixed-response with NO backing pool. A request whose
      // Host matches neither host-header rule gets this synthesized response.
      defaultActions: [
        {
          type: 'fixed-response',
          fixedResponseConfig: {
            statusCode: '418',
            contentType: 'text/plain',
            messageBody: 'default-fixed',
          },
        },
      ],
    });

    // host-header api.cdklocal.test -> api service.
    new elbv2.CfnListenerRule(this, 'ApiHostRule', {
      listenerArn: listener.ref,
      priority: 10,
      conditions: [{ field: 'host-header', hostHeaderConfig: { values: ['api.cdklocal.test'] } }],
      actions: [{ type: 'forward', targetGroupArn: apiTg.ref }],
    });

    // host-header web.cdklocal.test -> web service.
    new elbv2.CfnListenerRule(this, 'WebHostRule', {
      listenerArn: listener.ref,
      priority: 20,
      conditions: [{ field: 'host-header', hostHeaderConfig: { values: ['web.cdklocal.test'] } }],
      actions: [{ type: 'forward', targetGroupArn: webTg.ref }],
    });

    new ecs.CfnService(this, 'WebService', {
      cluster: cluster.ref,
      taskDefinition: webTask.ref,
      desiredCount: 1,
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
