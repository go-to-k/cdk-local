/**
 * Issue #784 — the ECS cross-stack post-pass hands the dynamic-reference hook
 * to `Environment` values only. A `Secrets[].ValueFrom` is an ARN that later
 * error messages echo, so a token arriving there must never be resolved into
 * plaintext.
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import {
  applyCrossStackResolverToTask,
  resolveEcsTaskTarget,
} from '../../../src/local/ecs-task-resolver.js';

const TOKEN = '{{resolve:secretsmanager:db:SecretString:password}}';

function stack(): StackInfo {
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: 'public.ecr.aws/docker/library/busybox:latest',
                Environment: [{ Name: 'DB_PASSWORD', Value: { 'Fn::ImportValue': 'Pw' } }],
                Secrets: [{ Name: 'API_KEY', ValueFrom: { 'Fn::ImportValue': 'ApiKeyArn' } }],
              },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

describe('applyCrossStackResolverToTask — dynamic-reference hook (#784)', () => {
  it('resolves an Environment token via the hook (flagged sensitive) but never a ValueFrom', async () => {
    const task = resolveEcsTaskTarget('MyStack:TaskDef', [stack()]);
    const container = task.containers[0]!;
    const hook = vi.fn(async () => 'pl41n');
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: {
        resolveImport: async () => TOKEN,
        resolveGetStackOutput: async () => undefined,
      },
      resolveDynamicReferences: hook,
    });
    expect(container.environment['DB_PASSWORD']).toBe('pl41n');
    expect(container.sensitiveEnvKeys).toContain('DB_PASSWORD');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(container.secrets).toEqual([{ name: 'API_KEY', valueFrom: TOKEN }]);
  });
});
