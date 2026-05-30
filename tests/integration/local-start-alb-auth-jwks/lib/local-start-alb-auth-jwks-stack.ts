import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

/**
 * Fixture for `cdkl start-alb` authenticate-oidc full JWT-verification path.
 *
 * Complements the sibling `local-start-alb-auth` fixture, which covers the
 * "no token -> 401" + "--no-verify-auth -> bypass" wiring with a placeholder
 * Cognito ARN. This fixture wires the listener's `authenticate-oidc` action
 * at a LOCAL OIDC issuer URL backed by a JWKS sidecar that `verify.sh`
 * spawns alongside `cdkl start-alb`. That lets the test mint JWTs the
 * sidecar's public key can verify, exercising the real verification path
 * (signature + `iss` + `aud` + `exp`) end-to-end.
 *
 * The Issuer string is the only URL the local front-door needs — the JWKS
 * URL is computed by the verifier as `<issuer>/.well-known/jwks.json`
 * (`src/local/cognito-jwt.ts` -> `buildJwksUrlFromIssuer`). The matching
 * sidecar serves both:
 *
 *   - `GET /.well-known/openid-configuration` -> `{issuer, jwks_uri}`
 *   - `GET /.well-known/jwks.json`           -> `{ keys: [<RSA public JWK>] }`
 *
 * The local front-door does NOT fetch the discovery document for an
 * `authenticate-oidc` action (it goes straight to the JWKS URL); the
 * discovery endpoint is there for future-proofing + parity with the
 * AgentCore `customJwtAuthorizer` discovery flow.
 *
 * `authenticate-cognito` cannot be retargeted at a local issuer because
 * the verifier hardcodes Cognito's JWKS URL to
 * `https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/jwks.json`
 * from the UserPoolArn — there is no escape hatch. `authenticate-oidc`
 * is the only authenticate-* shape that can point at a local JWKS, so
 * the JWT-verification integ ships under it.
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

/**
 * Sidecar issuer URL. Must match `JWKS_SIDECAR_ISSUER` in verify.sh — the
 * sidecar listens on this host:port, and the local front-door fetches
 * `<issuer>/.well-known/jwks.json` from it.
 */
const SIDECAR_ISSUER = 'http://127.0.0.1:19000';
const SIDECAR_CLIENT_ID = 'cdkl-test-client';

export class LocalStartAlbAuthJwksStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkl-start-alb-auth-jwks-fixture',
    });

    const taskDef = new ecs.CfnTaskDefinition(this, 'WebTask', {
      family: 'cdkl-start-alb-auth-jwks-web',
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

    // HTTP listener: authenticate-oidc (order 1) gates the request against
    // the LOCAL JWKS sidecar; forward (order 2) routes to the target group
    // on allow.
    new elbv2.CfnListener(this, 'WebAuthListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [
        {
          type: 'authenticate-oidc',
          order: 1,
          authenticateOidcConfig: {
            issuer: SIDECAR_ISSUER,
            // Cloud ALB requires all three endpoints, but the local
            // front-door never contacts them — only the issuer + JWKS
            // URL are touched. Placeholders are sufficient.
            authorizationEndpoint: `${SIDECAR_ISSUER}/authorize`,
            tokenEndpoint: `${SIDECAR_ISSUER}/token`,
            userInfoEndpoint: `${SIDECAR_ISSUER}/userinfo`,
            clientId: SIDECAR_CLIENT_ID,
            clientSecret: 'placeholder-not-used-locally',
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
