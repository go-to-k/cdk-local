import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

// Issues #850 / #854: which /24 a runner-created task network asks for. A
// task role pins 169.254.170.0/24 (SDKs read task-role credentials only from
// 169.254.170.2); without one the create prefers 170 and walks on.
const { execFileMock, stubs } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  stubs: { createTaskNetwork: vi.fn() },
}));

vi.mock('node:child_process', () => ({
  execFile: (...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const out = execFileMock(rest[0], rest[1], rest.length > 3 ? rest[2] : undefined) as
      | string
      | undefined;
    cb(null, { stdout: out ?? '', stderr: '' });
  },
  spawn: vi.fn(),
}));

vi.mock('../../../src/local/ecs-network.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/local/ecs-network.js')>()),
  createTaskNetwork: stubs.createTaskNetwork,
}));

const { runEcsTask, createEcsRunState } = await import('../../../src/local/ecs-task-runner.js');

function makeTask(): ResolvedEcsTask {
  const container = {
    name: 'app',
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
  return {
    taskDefinitionLogicalId: 'TaskDef',
    family: 'fam',
    networkMode: 'bridge',
    containers: [container],
    volumes: [],
    warnings: [],
  } as unknown as ResolvedEcsTask;
}

function baseOptions() {
  return {
    cluster: 'cdkl',
    containerHost: '127.0.0.1',
    skipPull: true,
    keepRunning: false,
    detach: true,
    skipHostPortPublish: true,
    imagePlanByContainer: new Map([['app', 'busybox:latest']]),
  };
}

function dockerRunEnv(): string[] {
  const run = execFileMock.mock.calls.map((c) => c[1] as string[]).find((a) => a[0] === 'run');
  return run ?? [];
}

describe('runEcsTask network subnet (issues #850 / #854)', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'run' ? 'cid\n' : ''
    );
    stubs.createTaskNetwork.mockReset();
  });

  it('asks for 170 as a preference (walkable) when no task role is set', async () => {
    stubs.createTaskNetwork.mockResolvedValue({
      networkName: 'cdkl-task-x',
      sidecarContainerId: 'sc',
      sidecarIp: '169.254.172.2',
    });
    await runEcsTask(makeTask(), baseOptions(), createEcsRunState());
    expect(stubs.createTaskNetwork).toHaveBeenCalledTimes(1);
    expect(stubs.createTaskNetwork.mock.calls[0]![0]).toMatchObject({ subnetOctet: 170 });
    expect(dockerRunEnv().join(' ')).not.toContain('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
  });

  it('keeps a caller-chosen octet as the preference when no task role is set', async () => {
    stubs.createTaskNetwork.mockResolvedValue({
      networkName: 'cdkl-task-x',
      sidecarContainerId: 'sc',
      sidecarIp: '169.254.173.2',
    });
    await runEcsTask(makeTask(), { ...baseOptions(), subnetOctet: 173 }, createEcsRunState());
    expect(stubs.createTaskNetwork.mock.calls[0]![0]).toMatchObject({ subnetOctet: 173 });
  });

  it('pins 169.254.170.0/24 (no octet) under a task role, even when a caller chose one', async () => {
    stubs.createTaskNetwork.mockResolvedValue({
      networkName: 'cdkl-task-x',
      sidecarContainerId: 'sc',
      sidecarIp: '169.254.170.2',
    });
    const creds = { accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'TOKEN' };
    await runEcsTask(
      makeTask(),
      {
        ...baseOptions(),
        subnetOctet: 173,
        taskRoleArn: 'arn:aws:iam::123456789012:role/app',
        taskCredentials: creds,
      },
      createEcsRunState()
    );
    const netOpts = stubs.createTaskNetwork.mock.calls[0]![0] as Record<string, unknown>;
    expect(netOpts).not.toHaveProperty('subnetOctet');
    expect(netOpts['credentials']).toEqual(creds);
    expect(dockerRunEnv()).toContain('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/creds');
  });
});
