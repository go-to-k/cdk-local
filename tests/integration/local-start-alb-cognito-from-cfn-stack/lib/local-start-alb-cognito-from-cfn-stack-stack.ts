import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { integScopedName } from '../../_lib/stack-name.ts';

/**
 * Fixture stack for `cdkl start-alb` behind an `authenticate-cognito` action
 * whose config is the shape `ListenerAction.authenticateCognito` emits
 * (issue #1004): `UserPoolArn: Fn::GetAtt <Pool>.Arn`,
 * `UserPoolClientId: Ref <Client>`, `UserPoolDomain: Ref <Domain>`. Only a
 * state source can resolve them.
 *
 * The user pool, client and domain are deployed. The ALB and its listener are
 * NOT: a deployed ALB accepts an authenticate-* action only on an HTTPS
 * listener with a certificate, which this fixture cannot provision. They are
 * gated behind a condition that is always false, so CloudFormation skips them
 * while the synthesized template `cdkl start-alb` reads still carries them.
 * The listener's terminal action is a fixed-response, so no container image
 * is needed.
 */
export class LocalStartAlbCognitoFromCfnStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pool = new cognito.UserPool(this, 'Pool', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const client = pool.addClient('Client', { authFlows: { adminUserPassword: true } });
    const domain = pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: integScopedName('cdkl-alb-idp-fixture') },
    });

    const localOnly = new cdk.CfnCondition(this, 'LocalOnly', {
      expression: cdk.Fn.conditionEquals('deploy-the-alb', 'never'),
    });

    const alb = new elbv2.CfnLoadBalancer(this, 'WebLB', { type: 'application' });
    alb.cfnOptions.condition = localOnly;

    const listener = new elbv2.CfnListener(this, 'WebListener', {
      loadBalancerArn: alb.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [
        {
          type: 'authenticate-cognito',
          order: 1,
          authenticateCognitoConfig: {
            userPoolArn: pool.userPoolArn,
            userPoolClientId: client.userPoolClientId,
            userPoolDomain: domain.domainName,
          },
        },
        {
          type: 'fixed-response',
          order: 2,
          fixedResponseConfig: {
            statusCode: '200',
            contentType: 'text/plain',
            messageBody: 'secret',
          },
        },
      ],
    });
    listener.cfnOptions.condition = localOnly;

    new cdk.CfnOutput(this, 'PoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
  }
}
