import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

// Issue #749: under finch on macOS / Windows a value-less `-e KEY` lands on
// the limactl argv as `-e KEY=<value>`, so a task with secrets is refused
// before any image, secret or network work unless the operator opted in.
const { execFileMock, stubs } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  stubs: {
    resolveEcsSecrets: vi.fn(),
    createTaskNetwork: vi.fn(),
    pullImage: vi.fn(),
    pullEcrImage: vi.fn(),
    buildDockerImage: vi.fn(),
  },
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

vi.mock('../../../src/local/ecs-secrets-resolver.js', () => ({
  resolveEcsSecrets: stubs.resolveEcsSecrets,
}));

vi.mock('../../../src/local/ecs-network.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/local/ecs-network.js')>()),
  createTaskNetwork: stubs.createTaskNetwork,
}));

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/local/docker-runner.js')>()),
  pullImage: stubs.pullImage,
}));

vi.mock('../../../src/local/ecr-puller.js', () => ({
  isImageInLocalCache: vi.fn(async () => false),
  pullEcrImage: stubs.pullEcrImage,
}));

vi.mock('../../../src/assets/docker-build.js', () => ({
  buildDockerImage: stubs.buildDockerImage,
}));

const { runEcsTask, createEcsRunState } = await import('../../../src/local/ecs-task-runner.js');
const { resetFinchArgvWarningsForTest } = await import('../../../src/utils/docker-cmd.js');
const { getLogger } = await import('../../../src/utils/logger.js');

function makeContainer(overrides: Partial<ResolvedEcsContainer>): ResolvedEcsContainer {
  return {
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
    ...overrides,
  } as ResolvedEcsContainer;
}

function makeTask(containers: ResolvedEcsContainer[]): ResolvedEcsTask {
  return {
    taskDefinitionLogicalId: 'TaskDef',
    family: 'fam',
    networkMode: 'bridge',
    containers,
    volumes: [],
    warnings: [],
  } as unknown as ResolvedEcsTask;
}

const network = {
  networkName: 'cdkl-task-x',
  sidecarContainerId: 'sidecar',
  sidecarIp: '169.254.170.2',
} as never;

/** Options for a run that gets as far as `docker run` without real work. */
function runnableOptions(task: ResolvedEcsTask) {
  return {
    cluster: 'cdkl',
    containerHost: '127.0.0.1',
    skipPull: true,
    keepRunning: false,
    detach: true,
    skipHostPortPublish: true,
    existingNetwork: network,
    imagePlanByContainer: new Map(task.containers.map((c) => [c.name, 'busybox:latest'])),
  };
}

const dbSecret = {
  name: 'DB_PASS',
  valueFrom: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:db',
};

function dockerRunCalls(): string[][] {
  return execFileMock.mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === 'run');
}

describe('runEcsTask under finch on macOS (issue #749)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let savedDocker: string | undefined;
  let savedOptIn: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'run' ? 'cid\n' : ''
    );
    for (const s of Object.values(stubs)) s.mockReset();
    stubs.resolveEcsSecrets.mockImplementation(
      async (secrets: { containerName: string; name: string }[]) =>
        secrets.map((s) => ({ ...s, value: `resolved-${s.name}` }))
    );
    stubs.createTaskNetwork.mockResolvedValue(network);
    savedDocker = process.env['CDK_DOCKER'];
    savedOptIn = process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    delete process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    process.env['CDK_DOCKER'] = 'finch';
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    resetFinchArgvWarningsForTest();
    warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = savedDocker;
    if (savedOptIn === undefined) delete process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    else process.env['CDKL_ALLOW_SECRETS_ON_ARGV'] = savedOptIn;
    vi.restoreAllMocks();
  });

  it('refuses a task with a secret before preparing images, fetching secrets or creating the network', async () => {
    const task = makeTask([makeContainer({ secrets: [dbSecret] })]);
    const err = await runEcsTask(
      task,
      { cluster: 'cdkl', containerHost: '127.0.0.1', skipPull: false, keepRunning: false, detach: true },
      createEcsRunState()
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EcsTaskRunnerError');
    expect(err.message).toMatch(
      /Container 'app': refusing to forward secret\(s\) DB_PASS under CDK_DOCKER=finch/
    );
    expect(stubs.pullImage).not.toHaveBeenCalled();
    expect(stubs.pullEcrImage).not.toHaveBeenCalled();
    expect(stubs.buildDockerImage).not.toHaveBeenCalled();
    expect(stubs.resolveEcsSecrets).not.toHaveBeenCalled();
    expect(stubs.createTaskNetwork).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('refuses a decrypted SecureString env key (sensitiveEnvKeys) the same way', async () => {
    const task = makeTask([
      makeContainer({ environment: { API_KEY: 's3cr3t' }, sensitiveEnvKeys: ['API_KEY'] }),
    ]);
    const err = await runEcsTask(task, runnableOptions(task), createEcsRunState()).catch(
      (e: unknown) => e as Error
    );
    expect(err.message).toContain("Container 'app': refusing to forward secret(s) API_KEY");
    expect(err.message).not.toContain('s3cr3t');
    expect(dockerRunCalls()).toHaveLength(0);
  });

  it('names every refused container in one error, not only the first', async () => {
    const a = makeContainer({
      name: 'a',
      essential: false,
      secrets: [{ name: 'A_SECRET', valueFrom: dbSecret.valueFrom }],
    });
    const b = makeContainer({
      name: 'b',
      secrets: [{ name: 'B_SECRET', valueFrom: dbSecret.valueFrom }],
    });
    const task = makeTask([a, b]);
    const err = await runEcsTask(task, runnableOptions(task), createEcsRunState()).catch(
      (e: unknown) => e as Error
    );
    expect(err.message).toContain("Container 'a': refusing to forward secret(s) A_SECRET");
    expect(err.message).toContain("Container 'b': refusing to forward secret(s) B_SECRET");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('runs a task without secrets', async () => {
    const task = makeTask([makeContainer({ environment: { LOG_LEVEL: 'info' } })]);
    await runEcsTask(task, runnableOptions(task), createEcsRunState());
    expect(dockerRunCalls()).toHaveLength(1);
  });

  it('runs the task when opted in, warning with names but not values', async () => {
    process.env['CDKL_ALLOW_SECRETS_ON_ARGV'] = '1';
    const task = makeTask([makeContainer({ secrets: [dbSecret] })]);
    await runEcsTask(task, runnableOptions(task), createEcsRunState());
    expect(dockerRunCalls()).toHaveLength(1);
    const msg = warnSpy.mock.calls.map((x) => String(x[0])).join('\n');
    expect(msg).toContain('CDK_DOCKER=finch on macOS / Windows puts the values of DB_PASS');
    expect(msg).not.toContain('resolved-DB_PASS');
  });

  it.each([
    ['finch on Linux', 'finch', 'linux'],
    ['docker on macOS', 'docker', 'darwin'],
  ] as const)('neither refuses nor warns for %s', async (_label, docker, platform) => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    process.env['CDK_DOCKER'] = docker;
    const task = makeTask([makeContainer({ secrets: [dbSecret] })]);
    await runEcsTask(task, runnableOptions(task), createEcsRunState());
    expect(dockerRunCalls()).toHaveLength(1);
    expect(warnSpy.mock.calls.map((x) => String(x[0])).join('\n')).not.toContain('CDK_DOCKER=finch');
  });
});
