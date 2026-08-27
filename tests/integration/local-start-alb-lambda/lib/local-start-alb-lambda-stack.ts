import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run this fixture's Lambdas at the HOST's CPU architecture.
 *
 * A function that declares no `architecture` defaults to `X86_64`, so on an
 * arm64 host cdk-local pins `--platform linux/amd64` and every container here
 * runs under CPU emulation -- where the Go RIE in the `public.ecr.aws/lambda/*`
 * base images faults intermittently, at a different assertion on every run
 * (issue #560; extended to the remaining fixtures by issue #569).
 *
 * Declaring the HOST arch -- rather than hardcoding either value -- is what
 * makes the container native on an Apple Silicon dev host AND on an x86_64 CI
 * runner, instead of trading one host's emulation for the other's. Keep it on
 * every function here: a new handler that omits it silently reintroduces the
 * arm64-only flake. The full rationale, the carve-outs, and the fence that
 * enforces this live in `tests/unit/integ-fixture-host-architecture.test.ts`.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

/**
 * Fixture for `cdkl start-alb` -> Lambda target groups (#123 Lambda-target
 * slice).
 *
 * Hand-rolls the synthesized shape of an ALB whose single HTTP:80 listener
 * forwards to Lambda functions (`TargetType: lambda` target groups), using L1
 * ELBv2 resources so the fixture stays VPC-free and deterministic (cdk-local
 * only reads the template; it never deploys to AWS):
 *
 *   - `EchoFn` (asset-backed Node.js Lambda) behind `EchoTargetGroup` — the
 *     listener DEFAULT action forwards here. The handler echoes the ALB event
 *     it received (httpMethod / path / query / requestContext.elb presence) so
 *     the harness can assert the HTTP -> ALB-Lambda-event translation.
 *   - `ApiFn` (asset-backed, shares the same code) behind `ApiTargetGroup`
 *     (with `lambda.multi_value_headers.enabled=true`) — a
 *     `AWS::ElasticLoadBalancingV2::ListenerRule` (priority 10, `path-pattern`
 *     `/api/*`) path-routes here, exercising the multiValueQueryStringParameters
 *     event variant.
 *
 * The synth linkage mirrors a real `TargetType: lambda` target group:
 *   TargetGroup.Targets[].Id = { "Fn::GetAtt": [<FnLogicalId>, "Arn"] }
 *   + an AWS::Lambda::Permission for the elasticloadbalancing principal.
 *
 * `covers: AWS::Lambda::Function` (matrix opt-in marker — the front-door boots
 * a Lambda target locally via RIE).
 */
export class LocalStartAlbLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const code = lambda.Code.fromAsset(path.join(__dirname, '../lambda'));

    const echoFn = new lambda.Function(this, 'EchoFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code,
      environment: { GREETING: 'hello' },
      timeout: cdk.Duration.seconds(10),
    });
    const apiFn = new lambda.Function(this, 'ApiFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code,
      environment: { GREETING: 'api-hello' },
      timeout: cdk.Duration.seconds(10),
    });

    // ALB front-door is invoked directly (no real network); the ELBv2 L1
    // resources only need the shape cdk-local reads.
    const loadBalancer = new elbv2.CfnLoadBalancer(this, 'AlbLB', { type: 'application' });

    const echoTg = new elbv2.CfnTargetGroup(this, 'EchoTargetGroup', {
      targetType: 'lambda',
      targets: [{ id: echoFn.functionArn }],
    });
    const apiTg = new elbv2.CfnTargetGroup(this, 'ApiTargetGroup', {
      targetType: 'lambda',
      targets: [{ id: apiFn.functionArn }],
      targetGroupAttributes: [{ key: 'lambda.multi_value_headers.enabled', value: 'true' }],
    });

    // ALB invoke permissions (realistic synth; cdk-local does not enforce them
    // locally, but a real template carries them).
    echoFn.addPermission('AlbInvoke', {
      principal: new cdk.aws_iam.ServicePrincipal('elasticloadbalancing.amazonaws.com'),
    });
    apiFn.addPermission('AlbInvoke', {
      principal: new cdk.aws_iam.ServicePrincipal('elasticloadbalancing.amazonaws.com'),
    });

    const listener = new elbv2.CfnListener(this, 'AlbListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      // Default action -> echo Lambda; the path rule below carves `/api/*` out.
      defaultActions: [{ type: 'forward', targetGroupArn: echoTg.ref }],
    });

    new elbv2.CfnListenerRule(this, 'ApiRule', {
      listenerArn: listener.ref,
      priority: 10,
      conditions: [{ field: 'path-pattern', pathPatternConfig: { values: ['/api/*'] } }],
      actions: [{ type: 'forward', targetGroupArn: apiTg.ref }],
    });
  }
}
