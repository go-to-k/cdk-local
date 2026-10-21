import { describe, it, expect } from 'vite-plus/test';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

// Issue #805 — a rolling rebuild's shadow container whose name doubles as
// a Service Connect name (`addContainer('api')` + discoveryName `api`) is
// booted WITHOUT the always-on container-name alias, or peers resolve it
// before it listens.
const container = {
  name: 'api',
  image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
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

function aliasesOf(omit: boolean | undefined): string[] {
  const { args } = buildDockerRunArgs({
    task: { family: 'fam', containers: [container] } as unknown as ResolvedEcsTask,
    container,
    image: 'public.ecr.aws/docker/library/busybox:latest',
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    envOverrides: undefined,
    containerHost: '127.0.0.1',
    roleArn: undefined,
    platformOverride: undefined,
    region: undefined,
    ...(omit !== undefined ? { omitContainerNameAlias: omit } : {}),
  });
  return args.flatMap((a, i) => (a === '--network-alias' ? [args[i + 1]!] : []));
}

describe('buildDockerRunArgs container-name alias (issue #805)', () => {
  it('adds `--network-alias <container.name>` by default', () => {
    expect(aliasesOf(undefined)).toEqual(['api']);
    expect(aliasesOf(false)).toEqual(['api']);
  });

  it('omits it when omitContainerNameAlias is set', () => {
    expect(aliasesOf(true)).toEqual([]);
  });
});
