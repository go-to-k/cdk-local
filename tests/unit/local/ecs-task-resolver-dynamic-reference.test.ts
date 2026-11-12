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
import {
  DynamicReferenceResolver,
  crossStackDynamicReferenceHook,
} from '../../../src/local/dynamic-reference-resolver.js';

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
    // The container is the workload (#902): mixed mode routes the fetch by its sentinels.
    expect(hook).toHaveBeenCalledWith(TOKEN, expect.any(String), { containerName: 'app' });
    expect(container.secrets).toEqual([{ name: 'API_KEY', valueFrom: TOKEN }]);
  });
});

// go-to-k/cdk-local#902: `run-task` and `start-service` / `start-alb` hand the
// post-pass `crossStackDynamicReferenceHook`; the container it names reaches
// the resolver's fetch as the workload (mixed mode routes by its sentinels).
describe('crossStackDynamicReferenceHook — the ECS commands\' cross-stack hook', () => {
  it('forwards the container to the fetch, in the producer region, not overridable', async () => {
    const routes: unknown[] = [];
    const regions: Array<string | undefined> = [];
    const resolver = new DynamicReferenceResolver({
      secretsManagerClientFactory: (region, route) => {
        regions.push(region);
        routes.push(route);
        return {
          send: async () => ({ SecretString: JSON.stringify({ password: 'pl41n' }) }),
          destroy: () => undefined,
        } as never;
      },
    });
    const task = resolveEcsTaskTarget('MyStack:TaskDef', [stack()]);
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: {
        resolveImport: async () => TOKEN,
        resolveGetStackOutput: async () => undefined,
      },
      resolveDynamicReferences: crossStackDynamicReferenceHook(resolver, 'Task TaskDef cross-stack env value'),
    });
    resolver.dispose();
    expect(task.containers[0]!.environment['DB_PASSWORD']).toBe('pl41n');
    expect(routes).toEqual([{ workload: { containerName: 'app' }, emulator: false }]);
    expect(regions).toEqual(['us-east-1']);
  });

  it('passes the producer region, the container, the consumer, and overridable: false', async () => {
    const resolveString = vi.fn(async () => 'x');
    const hook = crossStackDynamicReferenceHook({ resolveString }, 'Task T cross-stack env value');
    await hook(TOKEN, 'eu-west-1', { containerName: 'web' });
    expect(resolveString).toHaveBeenCalledWith(TOKEN, {
      region: 'eu-west-1',
      workload: { containerName: 'web' },
      consumer: 'Task T cross-stack env value',
      overridable: false,
    });
  });
});
