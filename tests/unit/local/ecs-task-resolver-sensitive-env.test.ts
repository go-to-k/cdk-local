import { describe, it, expect } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { EcsImageResolutionContext } from '../../../src/local/ecs-task-resolver.js';

import { resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';

// Site-level binding for issue #99 in the ECS path: when a container
// Environment entry Refs a decrypted SecureString SSM parameter, the
// resolved container must flag that env key in `sensitiveEnvKeys` so the
// runner keeps the value off the `docker run` argv. The pure sensitivity
// detection (resolveWithSensitivity) is unit-tested in
// state-resolver-parameters.test.ts; this locks the resolver wiring.

function taskStackWithSsmEnv(): StackInfo {
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Parameters: {
        SsmSecret: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/api-key' },
        SsmPlain: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/db-host' },
      },
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: 'public.ecr.aws/docker/library/busybox:latest',
                Environment: [
                  { Name: 'API_KEY', Value: { Ref: 'SsmSecret' } },
                  { Name: 'DB_HOST', Value: { Ref: 'SsmPlain' } },
                  { Name: 'LOG_LEVEL', Value: 'info' },
                ],
              },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

describe('resolveEcsTaskTarget SecureString env flagging (issue #99)', () => {
  it('flags only the env key that resolved to a SecureString param', () => {
    const context: EcsImageResolutionContext = {
      stateResources: {},
      stateParameters: { SsmSecret: 's3cr3t', SsmPlain: 'db.internal' },
      stateSensitiveParameters: ['SsmSecret'],
    };

    const task = resolveEcsTaskTarget('MyStack:TaskDef', [taskStackWithSsmEnv()], context);
    const container = task.containers.find((c) => c.name === 'app')!;

    // Both values resolved into the env...
    expect(container.environment['API_KEY']).toBe('s3cr3t');
    expect(container.environment['DB_HOST']).toBe('db.internal');
    expect(container.environment['LOG_LEVEL']).toBe('info');
    // ...but only the SecureString-backed key is flagged sensitive.
    expect(container.sensitiveEnvKeys).toEqual(['API_KEY']);
  });

  it('flags no keys when no SecureString parameter is involved', () => {
    const context: EcsImageResolutionContext = {
      stateResources: {},
      stateParameters: { SsmSecret: 's3cr3t', SsmPlain: 'db.internal' },
      // No stateSensitiveParameters -> nothing flagged.
    };

    const task = resolveEcsTaskTarget('MyStack:TaskDef', [taskStackWithSsmEnv()], context);
    const container = task.containers.find((c) => c.name === 'app')!;

    expect(container.environment['API_KEY']).toBe('s3cr3t');
    expect(container.sensitiveEnvKeys).toEqual([]);
  });
});
