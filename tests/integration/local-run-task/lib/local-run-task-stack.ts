import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Fixture stack for `cdkl run-task` integ test.
 *
 * Single task definition with one nginx container exposing port 80 → 18080
 * on the host. The verify script curls the host port and asserts a 200.
 *
 * `SameStackTask` (issue #847) runs `ContainerImage.fromEcrRepository` on a
 * repository in this same stack — no image URI without deployed state — so the
 * verify script can only run it through `--image-override` (with
 * `--image-context`, port 80 -> 18081).
 *
 * No AWS deploy required — the integ runs against the synthesized cdk.out
 * only.
 */
export class LocalRunTaskStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const taskDef = new ecs.TaskDefinition(this, 'NginxTask', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    taskDef.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:alpine'),
      essential: true,
      portMappings: [{ containerPort: 80, hostPort: 18080, protocol: ecs.Protocol.TCP }],
      memoryReservationMiB: 64,
    });

    const repo = new ecr.Repository(this, 'AppRepository');
    const sameStackTask = new ecs.TaskDefinition(this, 'SameStackTask', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
    });
    sameStackTask.addContainer('web', {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'v1'),
      essential: true,
      portMappings: [{ containerPort: 80, hostPort: 18081, protocol: ecs.Protocol.TCP }],
      memoryReservationMiB: 64,
    });

    // Issue #883: with no credential flag the container gets the host's
    // default chain. The task role is a `Fn::GetAtt` (no role ARN resolves
    // locally), the shape that used to leave the container with nothing.
    // `aws configure list` resolves the chain without calling AWS and prints
    // the key masked.
    const credsTask = new ecs.TaskDefinition(this, 'CredsTask', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
    });
    credsTask.addContainer('cli', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-cli/aws-cli:2.31.0'),
      essential: true,
      command: ['configure', 'list'],
      memoryReservationMiB: 64,
    });
  }
}
