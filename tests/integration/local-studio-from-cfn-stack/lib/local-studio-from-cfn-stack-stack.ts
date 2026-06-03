import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';

/**
 * Fixture stack for `cdkl studio --from-cfn-stack` ECS pin classification
 * (issue #354).
 *
 * The point: an ECS Service whose container image is an INTRINSIC ECR URI
 * (`ContainerImage.fromEcrRepository(repo)` — a `Fn::Sub` / `Fn::Join`
 * referencing the repo's `RepositoryUri` plus `AWS::AccountId` /
 * `AWS::Region` pseudo parameters) is ONLY resolvable with the deployed-state
 * image-resolution context. `cdkl studio` builds that context at boot ONLY
 * when `--from-cfn-stack` is passed, so:
 *
 *   - WITHOUT `--from-cfn-stack`: the intrinsic image cannot be resolved, the
 *     pin classifier leaves the service UNMARKED (no `pinned` flag).
 *   - WITH `--from-cfn-stack <DeployedStackName>`: the boot classifier
 *     resolves the repo's deployed URI, sees it is a deployed-registry pin
 *     (not a local CDK asset), and marks the service `pinned: true` so the UI
 *     offers the image-override Dockerfile picker — matching what
 *     `cdkl start-service --from-cfn-stack` detects ("Detected pinned image").
 *
 * Deploy notes:
 *   - `desiredCount: 0` so the service deploys WITHOUT waiting for any task to
 *     reach steady state. No image is ever pushed to the repo; the deploy only
 *     needs to CREATE the ECR repository so its physical id / URI is returned
 *     by `ListStackResources` and resolves under `--from-cfn-stack`.
 *   - `RemovalPolicy.DESTROY` + `emptyOnDelete` on the repo and a minimal
 *     NAT-less VPC so `cdk destroy` is fully self-contained (no orphan repo /
 *     NAT gateway left behind).
 */
export class LocalStudioFromCfnStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The ECR repository whose intrinsic image URI the service pins to. Its
    // presence in the deployed stack is the whole point: under
    // `--from-cfn-stack`, ListStackResources returns it and the intrinsic
    // image URI resolves, so studio's boot pin classifier marks the service.
    const repo = new ecr.Repository(this, 'AppRepo', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // Minimal NAT-less VPC — desiredCount:0 means no task ever launches, so no
    // egress is needed; this keeps the deploy cheap + fast and the teardown
    // clean (no NAT gateway to orphan).
    const vpc = new ec2.Vpc(this, 'AppVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    const cluster = new ecs.Cluster(this, 'AppCluster', { vpc });

    const taskDef = new ecs.FargateTaskDefinition(this, 'AppTask', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    // The container image is an INTRINSIC ECR URI — this is the resource the
    // classifier can only resolve under `--from-cfn-stack`.
    taskDef.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromEcrRepository(repo),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'app' }),
    });

    new ecs.FargateService(this, 'AppService', {
      cluster,
      taskDefinition: taskDef,
      // Deploy WITHOUT waiting for a task to stabilize — no image is pushed to
      // the repo, so a non-zero count would never reach steady state.
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
  }
}
