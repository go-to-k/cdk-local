import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { ExportNames } from './producer-stack.ts';

export interface ConsumerStackProps extends cdk.StackProps {
  readonly exportNames: ExportNames;
}

const BUSYBOX = 'public.ecr.aws/docker/library/busybox:1.36';

/**
 * Prints the plain value it got as an argument, and DIGESTS of the API key
 * and the secret it got in its environment (never the values themselves).
 */
const PROBE_SCRIPT = [
  'echo "[probe] arg=$1"',
  'echo "[probe] key_sha=$(printf %s "$API_KEY" | sha256sum | cut -c1-64)"',
  'echo "[probe] secret_sha=$(printf %s "$DB_SECRET" | sha256sum | cut -c1-64)"',
].join('; ');

/** One busybox task, its container's fields overridden at the L1. */
function task(
  scope: Construct,
  id: string,
  container: Record<string, unknown>,
  executionRole?: iam.IRole
): void {
  const taskDef = new ecs.TaskDefinition(scope, id, {
    compatibility: ecs.Compatibility.EC2,
    networkMode: ecs.NetworkMode.BRIDGE,
    // CloudFormation requires an execution role on a task with Secrets.
    ...(executionRole !== undefined && { executionRole }),
  });
  taskDef.addContainer('app', {
    image: ecs.ContainerImage.fromRegistry(BUSYBOX),
    essential: true,
    memoryReservationMiB: 16,
  });
  const cfn = taskDef.node.defaultChild as ecs.CfnTaskDefinition;
  for (const [field, value] of Object.entries(container)) {
    cfn.addPropertyOverride(`ContainerDefinitions.0.${field}`, value);
  }
}

/**
 * Consumer for the producer-secret integ (go-to-k/cdkd#6339). Every
 * cross-stack value is a literal `Fn::ImportValue`, the shape a hand-written
 * or `cdk deploy`-ed template carries.
 *
 *   - ProbeTask: the plain export as a Command argument (served on the
 *     argv), the API key in Environment (served value-less, `-e API_KEY`),
 *     and the nested secret's ARN as a Secrets ValueFrom (resolved).
 *   - RefusedTask: the API key inside a Command element, which `run-task`
 *     must refuse before starting anything.
 */
export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConsumerStackProps) {
    super(scope, id, props);
    const importOf = (name: string) => ({ 'Fn::ImportValue': name });

    // The role ECS would read the secret with; cdk-local reads it with the
    // caller's own credentials, so it is never assumed here.
    const executionRole = new iam.Role(this, 'ProbeExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [cdk.Fn.importValue(props.exportNames.secretArn)],
      })
    );

    task(this, 'ProbeTask', {
      Command: ['sh', '-c', PROBE_SCRIPT, 'probe', importOf(props.exportNames.plain)],
      Environment: [{ Name: 'API_KEY', Value: importOf(props.exportNames.apiKey) }],
      Secrets: [{ Name: 'DB_SECRET', ValueFrom: importOf(props.exportNames.secretArn) }],
    }, executionRole);

    task(this, 'RefusedTask', {
      Command: [
        'sh',
        '-c',
        { 'Fn::Join': ['', ['echo key=', importOf(props.exportNames.apiKey)]] },
      ],
    });
  }
}
