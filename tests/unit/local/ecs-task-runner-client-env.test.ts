import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

// Issue #772: a resolved secret or SecureString env key whose NAME is a
// variable the docker client / loader reads is dropped (no `-e` flag, no
// spawn-env entry) with a warning naming the key only.
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

describe('runEcsTask docker-client key refusal (issue #772)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let savedDocker: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'run' ? 'cid\n' : ''
    );
    for (const s of Object.values(stubs)) s.mockReset();
    stubs.resolveEcsSecrets.mockImplementation(
      async (secrets: { containerName: string; name: string }[]) =>
        secrets.map((s) => ({ ...s, value: `resolved-value-of-${s.name}` }))
    );
    stubs.createTaskNetwork.mockResolvedValue(network);
    savedDocker = process.env['CDK_DOCKER'];
    delete process.env['CDK_DOCKER'];
    resetFinchArgvWarningsForTest();
    warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = savedDocker;
    vi.restoreAllMocks();
  });

  function runCall(): { args: string[]; env: NodeJS.ProcessEnv | undefined } {
    const call = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'run')!;
    return {
      args: call[1] as string[],
      env: (call[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env,
    };
  }

  it('drops a secret named PATH and a SecureString env named DOCKER_CONFIG, warning by name only', async () => {
    const task = makeTask([
      makeContainer({
        environment: { DOCKER_CONFIG: 'ssm-evil-config', LOG_LEVEL: 'info' },
        sensitiveEnvKeys: ['DOCKER_CONFIG'],
        secrets: [
          { name: 'PATH', valueFrom: dbSecret.valueFrom },
          { name: 'DB_PASS', valueFrom: dbSecret.valueFrom },
        ],
      }),
    ]);
    await runEcsTask(task, runnableOptions(task), createEcsRunState());
    const { args, env } = runCall();
    expect(args).not.toContain('PATH');
    expect(args).not.toContain('DOCKER_CONFIG');
    const joined = args.join(' ');
    expect(joined).not.toContain('resolved-value-of-PATH');
    expect(joined).not.toContain('ssm-evil-config');
    expect(env!['PATH']).toBe(process.env['PATH']);
    expect(env!['DOCKER_CONFIG']).toBe(process.env['DOCKER_CONFIG']);
    // Control: the ordinary secret and the plain env are unaffected.
    expect(args).toContain('DB_PASS');
    expect(env!['DB_PASS']).toBe('resolved-value-of-DB_PASS');
    expect(args).toContain('LOG_LEVEL=info');
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    const hit = warns.filter((w) => w.includes('Container app') && w.includes('PATH'));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('DOCKER_CONFIG');
    expect(hit[0]).not.toContain('resolved-value-of-PATH');
    expect(hit[0]).not.toContain('ssm-evil-config');
    expect(hit[0]).not.toContain('DB_PASS');
  });

  it('under finch, does not refuse a task whose only secret is one that will be dropped anyway', async () => {
    process.env['CDK_DOCKER'] = 'finch';
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    const task = makeTask([
      makeContainer({ secrets: [{ name: 'LD_PRELOAD', valueFrom: dbSecret.valueFrom }] }),
    ]);
    await runEcsTask(task, runnableOptions(task), createEcsRunState());
    const { args } = runCall();
    expect(args).not.toContain('LD_PRELOAD');
  });

  it('control under finch: an ordinary secret is still refused', async () => {
    process.env['CDK_DOCKER'] = 'finch';
    delete process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    const task = makeTask([makeContainer({ secrets: [dbSecret] })]);
    const err = await runEcsTask(task, runnableOptions(task), createEcsRunState()).catch(
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('refusing to forward secret(s) DB_PASS');
  });
});
