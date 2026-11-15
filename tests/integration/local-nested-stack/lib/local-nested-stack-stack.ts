import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as ecs from 'aws-cdk-lib/aws-ecs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run every Lambda / task here at the HOST's CPU architecture (issue #560):
 * an undeclared architecture defaults to X86_64 and runs under emulation on an
 * arm64 host. See `tests/unit/integ-fixture-host-architecture.test.ts`.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;
const HOST_CPU_ARCHITECTURE =
  // Derived from the Lambda's, so the architecture is declared in one place.
  ecs.CpuArchitecture.of(HOST_ARCHITECTURE.name === 'arm64' ? 'ARM64' : 'X86_64');

function fn(scope: Construct, id: string, env: Record<string, string>): lambda.Function {
  return new lambda.Function(scope, id, {
    runtime: lambda.Runtime.NODEJS_20_X,
    architecture: HOST_ARCHITECTURE,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
    environment: env,
  });
}

/** A NestedStack two levels down: `Stack/Inner/Deeper/DeepFn`. */
class DeeperStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    fn(this, 'DeepFn', { WHO: 'deep' });
  }
}

/** `Stack/Inner/*`: a Lambda, a REST API, a Fargate task and a nested stack. */
class InnerStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const innerFn = fn(this, 'InnerFn', { WHO: 'inner', LITERAL: 'x' });
    new apigw.LambdaRestApi(this, 'Api', { handler: innerFn });

    const taskDef = new ecs.FargateTaskDefinition(this, 'Task', {
      runtimePlatform: {
        cpuArchitecture: HOST_CPU_ARCHITECTURE,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:1.36'),
      command: ['sh', '-c', 'echo NESTED_TASK_OK WHO=$WHO'],
      environment: { WHO: 'task' },
      essential: true,
    });

    // An ECS service for `start-service` (bridge mode: no VPC needed locally).
    const cluster = new ecs.CfnCluster(this, 'Cluster');
    const serviceTask = new ecs.CfnTaskDefinition(this, 'ServiceTask', {
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'svc',
          image: 'public.ecr.aws/docker/library/busybox:1.36',
          essential: true,
          entryPoint: ['/bin/sh', '-c'],
          command: ['while true; do echo "NESTED_SERVICE_OK WHO=$WHO"; sleep 2; done'],
          environment: [{ name: 'WHO', value: 'service' }],
          memoryReservation: 16,
        },
      ],
    });
    new ecs.CfnService(this, 'Service', {
      cluster: cluster.ref,
      taskDefinition: serviceTask.ref,
      desiredCount: 1,
      launchType: 'EC2',
    });

    new DeeperStack(this, 'Deeper');
  }
}

/**
 * Fixture for CDK NestedStack support across the `local` commands
 * (go-to-k/cdk-local#986). No AWS deploy required.
 */
export class LocalNestedStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    fn(this, 'OuterFn', { WHO: 'outer' });
    new InnerStack(this, 'Inner');
  }
}
