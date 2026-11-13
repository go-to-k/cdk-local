/**
 * go-to-k/cdk-local#917: an ECR image is pulled (or cache-verified, or refused
 * under --aws-emulator) by `pullEcrImage` before `docker run`, so the run must
 * not let the daemon pull it again on its own with the host's credentials.
 */
import { describe, it, expect } from 'vite-plus/test';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

const container = {
  name: 'api',
  image: { kind: 'ecr', uri: '' },
  environment: {},
  sensitiveEnvKeys: [],
  secrets: [],
  portMappings: [],
  mountPoints: [],
  dependsOn: [],
  links: [],
  essential: true,
  ulimits: [],
  warnings: [],
} as unknown as ResolvedEcsContainer;

function argsFor(image: string): { args: string[] } {
  return buildDockerRunArgs({
    task: { family: 'fam', containers: [container] } as unknown as ResolvedEcsTask,
    container,
    image,
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    envOverrides: undefined,
    containerHost: '127.0.0.1',
    roleArn: undefined,
    platformOverride: undefined,
    region: undefined,
  });
}

describe('buildDockerRunArgs — no implicit re-pull of an ECR image', () => {
  it('puts --pull never right before an ECR image, (the joined argv shares it via `both`)', () => {
    const image = '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:v1';
    const { args } = argsFor(image);
    const i = args.indexOf(image);
    expect(args.slice(i - 2, i)).toEqual(['--pull', 'never']);
  });

  it('leaves a public or locally built image alone', () => {
    for (const image of ['public.ecr.aws/docker/library/busybox:latest', 'cdkl-ecs-abc:latest']) {
      expect(argsFor(image).args).not.toContain('--pull');
    }
  });
});
