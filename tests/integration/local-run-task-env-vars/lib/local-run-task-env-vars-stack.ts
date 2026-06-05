import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Fixture stack for the `cdkl run-task --env-vars` overlay integ test.
 *
 * A single short-lived busybox container (`probe`) prints its full
 * environment to stdout and exits. The container declares two template
 * env vars:
 *   - KEEP_ME=kept-value      (left untouched by the overlay)
 *   - DROP_ME=from-template   (cleared by a `null` in the --env-vars file)
 *
 * verify.sh runs the task with an `--env-vars` file that sets a new key,
 * keeps KEEP_ME, and clears DROP_ME via JSON `null`, then asserts against
 * the `[probe]`-prefixed env dump that:
 *   - the added + kept keys appear,
 *   - DROP_ME is GONE entirely (not `DROP_ME=null`, not empty) — the SAM
 *     `null`-clears-a-key semantic on the ECS task-container env path.
 *
 * No AWS deploy required — runs against the synthesized cdk.out only.
 */
export class LocalRunTaskEnvVarsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const taskDef = new ecs.TaskDefinition(this, 'EnvProbeTask', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    taskDef.addContainer('probe', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:1.36'),
      essential: true,
      entryPoint: ['/bin/sh', '-c'],
      command: ['env'],
      memoryReservationMiB: 16,
      environment: {
        KEEP_ME: 'kept-value',
        DROP_ME: 'from-template',
      },
    });
  }
}
