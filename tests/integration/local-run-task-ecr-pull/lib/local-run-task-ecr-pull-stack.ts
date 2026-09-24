import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type { Construct } from 'constructs';

/**
 * Real-AWS fixture for `cdkl run-task` pulling a PRIVATE ECR image through each
 * registry host form AWS serves (issue #760): the plain host, the FIPS host and
 * the dual-stack host.
 *
 * The ECR repository is ALWAYS created, so `cdk deploy` (no context) deploys the
 * repository alone and `--from-cfn-stack` can resolve its name. The task
 * definitions exist ONLY under `-c withTasks=true`, i.e. in the local synth that
 * `cdkl run-task` reads — they are never registered in ECS. The `Repo`
 * construct path is identical in both synths, so its logical id matches.
 *
 * Each task's image is an `Fn::Sub` naming the same repository through a
 * different host, so the pull path under test (`ecs-task-resolver`'s ECR
 * classification, then `pullEcrImage`'s login + pull) is the only thing that
 * differs between the arms.
 */
export class LocalRunTaskEcrPullStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repo = new ecr.Repository(this, 'Repo', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
    new cdk.CfnOutput(this, 'RepoName', { value: repo.repositoryName });

    if (!this.node.tryGetContext('withTasks')) return;

    const repoRef = this.resolve(repo.repositoryName) as { Ref: string };
    const hosts: ReadonlyArray<[string, string, number]> = [
      ['PlainTask', '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}', 18760],
      ['FipsTask', '${AWS::AccountId}.dkr.ecr-fips.${AWS::Region}.${AWS::URLSuffix}', 18761],
      ['DualStackTask', '${AWS::AccountId}.dkr-ecr.${AWS::Region}.on.aws', 18762],
    ];
    for (const [taskId, host, hostPort] of hosts) {
      new ecs.CfnTaskDefinition(this, taskId, {
        family: `cdkl-ecr-pull-${taskId.toLowerCase()}`,
        networkMode: 'bridge',
        requiresCompatibilities: ['EC2'],
        containerDefinitions: [
          {
            name: 'web',
            image: cdk.Fn.sub(`${host}/\${${repoRef.Ref}}:latest`),
            essential: true,
            memoryReservation: 64,
            portMappings: [{ containerPort: 80, hostPort, protocol: 'tcp' }],
          },
        ],
      });
    }
  }
}
