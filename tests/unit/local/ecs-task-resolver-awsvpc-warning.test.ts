import { describe, it, expect } from 'vite-plus/test';

import { resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function awsvpcStack(): StackInfo {
  return {
    stackName: 'S',
    displayName: 'S',
    template: {
      Resources: {
        Task: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: { NetworkMode: 'awsvpc', ContainerDefinitions: [{ Name: 'web', Image: 'nginx' }] },
        },
      },
    },
  } as never;
}

describe('ecs-task-resolver awsvpc warning', () => {
  it('names the bridge mapping without claiming where SDK calls go', () => {
    const warnings = resolveEcsTaskTarget('S:Task', [awsvpcStack()]).warnings;
    expect(warnings.some((w) => w.includes('is mapped to docker bridge locally'))).toBe(true);
    // Printed under --aws-emulator and with forwarded AWS_ENDPOINT_URL* too,
    // where SDK calls do NOT reach public endpoints.
    expect(warnings.some((w) => /public endpoint/i.test(w))).toBe(false);
  });
});
