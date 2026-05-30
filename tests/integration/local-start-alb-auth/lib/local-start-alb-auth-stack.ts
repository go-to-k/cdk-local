import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

/**
 * Fixture for `cdkl start-alb` authenticate-cognito guarding.
 *
 * Mirrors `local-start-alb` but wraps the default action with an
 * `authenticate-cognito` action so the local front-door's auth check
 * runs before any forward. The local check is wired by
 * `src/local/front-door-auth.ts`:
 *
 *   - No Authorization header (and no `--bearer-token`) -> 401 with a
 *     `WWW-Authenticate: Bearer` header.
 *   - `--no-verify-auth` -> short-circuit to allow.
 *
 * The Cognito userPoolDomain / userPoolArn values are NEVER contacted
 * by these two paths (the 401 branch fires before the JWKS lookup, and
 * `--no-verify-auth` bypasses the entire check), so the fixture uses
 * placeholder ARNs and a placeholder domain. JWT-verification paths
 * (signature / iss / aud / exp) are unit-tested in
 * `tests/unit/local/cognito-jwt.test.ts`; this integ covers the wiring.
 */
const HELLO_SERVER = [
  'import http.server,socket',
  'class H(http.server.BaseHTTPRequestHandler):',
  ' def do_GET(s):',
  "  b=('replica '+socket.gethostname()+chr(10)).encode()",
  "  s.send_response(200);s.send_header('Content-Length',str(len(b)));s.end_headers();s.wfile.write(b)",
  ' def log_message(s,*a):pass',
  "http.server.HTTPServer(('0.0.0.0',80),H).serve_forever()",
].join('\n');

export class LocalStartAlbAuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-alb-auth-fixture',
    });

    const taskDef = new ecs.CfnTaskDefinition(this, 'WebTask', {
      family: 'cdkl-start-alb-auth-web',
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

    // HTTP listener with TWO default actions: authenticate-cognito (order 1)
    // gates the request; forward (order 2) routes to the target group on
    // allow. The cloud-side ALB requires authenticate-* actions to precede
    // the terminal forward, and the local front-door follows the same
    // order: only when AuthCheck.allow is true does the forward fire.
    new elbv2.CfnListener(this, 'WebAuthListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [
        {
          type: 'authenticate-cognito',
          order: 1,
          authenticateCognitoConfig: {
            // The local 401-branch fires before any JWKS lookup, and
            // --no-verify-auth bypasses the check entirely, so these
            // placeholder values never produce network traffic.
            userPoolArn: 'arn:aws:cognito-idp:us-east-1:000000000000:userpool/us-east-1_PLACEHOLDER',
            userPoolClientId: 'placeholder-client-id',
            userPoolDomain: 'placeholder-domain-does-not-resolve',
            onUnauthenticatedRequest: 'deny',
          },
        },
        {
          type: 'forward',
          order: 2,
          targetGroupArn: targetGroup.ref,
        },
      ],
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
