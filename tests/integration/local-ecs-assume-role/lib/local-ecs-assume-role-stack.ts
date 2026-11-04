import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * The DEPLOYED half of the `--assume-role` fixture for the ECS commands
 * (issues #850 / #853 / #854): one role that the deploying account may
 * `sts:AssumeRole` into, so `cdkl run-task` / `start-service --assume-role
 * <arn>` can hand its credentials to the metadata sidecar. Its ARN is a
 * stack output for verify.sh.
 */
export class LocalEcsAssumeRoleRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const taskRole = new iam.Role(this, 'AssumableTaskRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        new iam.AccountRootPrincipal(),
      ),
    });

    new cdk.CfnOutput(this, 'TaskRoleArn', {
      value: taskRole.roleArn,
      description: 'ARN of the role that --assume-role assumes for the ECS tasks',
    });
  }
}

/**
 * The SYNTHESIZED-ONLY half: never deployed (a service with no capacity
 * would never stabilize). One bridge-mode task definition whose container
 * holds the AWS CLI and sleeps, so verify.sh can `docker exec` an
 * `aws sts get-caller-identity` inside it -- a real SDK reading
 * `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` from `169.254.170.2` -- plus a
 * one-replica service over the same task definition for `start-service`.
 * L1 constructs keep it free of a VPC.
 */
export class LocalEcsAssumeRoleTaskStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster');

    const taskDef = new ecs.CfnTaskDefinition(this, 'IdentityTask', {
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'cli',
          image: 'public.ecr.aws/aws-cli/aws-cli:2.31.0',
          essential: true,
          entryPoint: ['/bin/sh', '-c'],
          command: ['sleep 600'],
          memoryReservation: 64,
        },
      ],
    });

    new ecs.CfnService(this, 'IdentityService', {
      cluster: cluster.ref,
      taskDefinition: taskDef.ref,
      desiredCount: 1,
      launchType: 'EC2',
    });
  }
}
