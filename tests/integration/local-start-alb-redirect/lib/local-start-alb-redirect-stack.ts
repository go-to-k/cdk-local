import * as cdk from 'aws-cdk-lib';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

/**
 * Fixture for `cdkl start-alb` redirect action coverage (issue #250,
 * gap G4).
 *
 * Hand-rolls an HTTP:80 listener whose DEFAULT action is a `redirect`
 * to HTTPS on a different host + path. The redirect action carries
 * no backing target group — `resolveRedirectAction` is exercised
 * end-to-end with no ECS service present (the fixed-response
 * conditions fixture already proves the no-service path works for
 * a target-less default action; this fixture covers the redirect
 * variant).
 *
 * The redirect config:
 *
 *   Protocol   = HTTPS
 *   Host       = redirected.cdklocal.test
 *   Port       = 443
 *   Path       = /relocated/#{path}
 *   StatusCode = HTTP_302
 *
 * `#{path}` is ALB's placeholder for the request's original path —
 * `cdkl start-alb` substitutes it into the resolved Location header.
 * verify.sh asserts both the status code (302) AND the Location
 * header (`https://redirected.cdklocal.test:443/relocated/<path>`).
 *
 * No ECS service is declared. The ALB front-door binds the listener
 * port and answers every request from the redirect default action
 * directly, no backing pool needed.
 *
 * `covers: AWS::ElasticLoadBalancingV2::Listener` (redirect default
 * action with `#{path}` placeholder substitution).
 */
export class LocalStartAlbRedirectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const loadBalancer = new elbv2.CfnLoadBalancer(this, 'WebLB', {
      type: 'application',
    });

    new elbv2.CfnListener(this, 'WebListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [
        {
          type: 'redirect',
          redirectConfig: {
            protocol: 'HTTPS',
            host: 'redirected.cdklocal.test',
            port: '443',
            path: '/relocated/#{path}',
            statusCode: 'HTTP_302',
          },
        },
      ],
    });
  }
}
