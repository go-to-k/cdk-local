/**
 * go-to-k/cdk-local#902 — `run-task` and `start-service` / `start-alb` run
 * their cross-stack post-pass through `applyCrossStackValuesToTask`. A
 * `{{resolve:...}}` a producer hands across is read for the container that
 * consumes it, so in AWS Emulator mixed mode it follows that container's own
 * `--env-vars` sentinels, as its runtime calls do.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const { smEndpoints } = vi.hoisted(() => ({ smEndpoints: [] as Array<string | undefined> }));

vi.mock('@aws-sdk/client-secrets-manager', async (orig) => ({
  ...(await orig<object>()),
  SecretsManagerClient: class {
    constructor(config: { endpoint?: string }) {
      smEndpoints.push(config.endpoint);
    }
    async send(): Promise<unknown> {
      return { SecretString: 'pl41n' };
    }
    destroy(): void {}
  },
}));

const { applyCrossStackValuesToTask, resolveEcsTaskTarget } = await import(
  '../../../src/local/ecs-task-resolver.js'
);
const { setAwsEmulatorServiceRouting } = await import('../../../src/utils/aws-proxy.js');

const EMU = 'https://127.0.0.1:9395';

function stack(): StackInfo {
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: ['app', 'worker'].map((name) => ({
              Name: name,
              Image: 'public.ecr.aws/docker/library/busybox:latest',
              Environment: [{ Name: 'DB_PASSWORD', Value: { 'Fn::ImportValue': 'Pw' } }],
            })),
          },
        },
      },
    },
  } as unknown as StackInfo;
}

afterEach(() => {
  setAwsEmulatorServiceRouting(undefined);
  smEndpoints.length = 0;
});

describe('applyCrossStackValuesToTask — mixed-mode routing per container', () => {
  it("reads the producer's secret where each container's own sentinels send it", async () => {
    setAwsEmulatorServiceRouting({
      services: ['SECRETS_MANAGER'],
      override: { endpoint: EMU, credentials: { accessKeyId: 'EMU', secretAccessKey: 'e' } },
      envOverrides: { app: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'aws-emulator' } },
    });
    const task = resolveEcsTaskTarget('MyStack:TaskDef', [stack()]);
    await applyCrossStackValuesToTask(
      task,
      {
        resolveImport: async () => '{{resolve:secretsmanager:db}}',
        resolveGetStackOutput: async () => undefined,
      },
      { imageContext: undefined, consumerRegion: 'us-east-1' }
    );
    for (const c of task.containers) expect(c.environment['DB_PASSWORD']).toBe('pl41n');
    // `app` routes Secrets Manager; `worker` has no sentinel: real AWS.
    expect(smEndpoints.sort()).toEqual([EMU, undefined].sort());
  });
});
