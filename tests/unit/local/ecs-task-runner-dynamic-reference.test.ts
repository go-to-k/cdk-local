/**
 * Issue #784 — a CloudFormation dynamic reference in a container's
 * `Environment` is resolved before boot (the same resolver every
 * container-env builder uses), reaches the container through docker's
 * value-from-process-env form rather than the `docker run` argv, counts as a
 * secret for the finch refusal, and is skipped when an `--env-vars` override
 * replaces the key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

const { execFileMock, smSend, smRegions, stubs } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  smSend: vi.fn(),
  smRegions: [] as Array<string | undefined>,
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

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    constructor(config: { region?: string }) {
      smRegions.push(config.region);
    }
    send = smSend;
    destroy(): void {}
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
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
    stack: { stackName: 'S', region: 'ca-central-1' },
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


const TOKEN = '{{resolve:secretsmanager:db:SecretString:password}}';
const PLAINTEXT = 'pl41n-S3CRET';

describe('runEcsTask — dynamic references in Environment (#784)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let savedDocker: string | undefined;
  let savedOptIn: string | undefined;

  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'run' ? 'cid\n' : ''
    );
    for (const s of Object.values(stubs)) s.mockReset();
    stubs.resolveEcsSecrets.mockResolvedValue([]);
    stubs.createTaskNetwork.mockResolvedValue(network);
    smSend.mockReset();
    smRegions.length = 0;
    smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: PLAINTEXT }) });
    savedDocker = process.env['CDK_DOCKER'];
    savedOptIn = process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    delete process.env['CDK_DOCKER'];
    delete process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    resetFinchArgvWarningsForTest();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = savedDocker;
    if (savedOptIn === undefined) delete process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    else process.env['CDKL_ALLOW_SECRETS_ON_ARGV'] = savedOptIn;
    vi.restoreAllMocks();
  });

  it('resolves in the task stack region and keeps the value off the argv', async () => {
    const task = makeTask([makeContainer({ environment: { DB_PASSWORD: TOKEN, LOG: 'info' } })]);
    await runEcsTask(task, runnableOptions(task), createEcsRunState());
    expect(smRegions).toEqual(['ca-central-1']);
    const runs = execFileMock.mock.calls.filter((c) => (c[1] as string[])[0] === 'run');
    expect(runs).toHaveLength(1);
    const argv = runs[0]![1] as string[];
    expect(argv.join(' ')).not.toContain(PLAINTEXT);
    expect(argv.join(' ')).not.toContain('{{resolve:');
    expect(argv).toContain('DB_PASSWORD');
    expect(argv).toContain('LOG=info');
    const execOpts = runs[0]![2] as { env?: Record<string, string> };
    expect(execOpts.env?.['DB_PASSWORD']).toBe(PLAINTEXT);
  });

  it('an --env-vars override on the key skips the lookup', async () => {
    const task = makeTask([makeContainer({ environment: { DB_PASSWORD: TOKEN } })]);
    await runEcsTask(
      task,
      { ...runnableOptions(task), envOverrides: { app: { DB_PASSWORD: 'local' } } },
      createEcsRunState()
    );
    expect(smSend).not.toHaveBeenCalled();
    expect(dockerRunCalls()[0]!).toContain('DB_PASSWORD=local');
  });

  it('a refused lookup fails the task before any container starts', async () => {
    smSend.mockRejectedValue(
      Object.assign(new Error('denied'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: {},
      })
    );
    const task = makeTask([makeContainer({ environment: { DB_PASSWORD: TOKEN } })]);
    const err = await runEcsTask(task, runnableOptions(task), createEcsRunState()).catch(
      (e: unknown) => e as Error
    );
    expect(err.name).toBe('DynamicReferenceResolutionError');
    expect(err.message).toContain('Container app env var DB_PASSWORD');
    expect(err.message).toContain(TOKEN);
    expect(dockerRunCalls()).toHaveLength(0);
  });

  it('--stack-region wins over the synth region for a plain-name reference', async () => {
    const task = makeTask([makeContainer({ environment: { DB_PASSWORD: TOKEN } })]);
    await runEcsTask(
      task,
      { ...runnableOptions(task), stackRegion: 'eu-west-1', region: 'us-west-1' },
      createEcsRunState()
    );
    expect(smRegions).toEqual(['eu-west-1']);
  });

  it('skips a key a Parameters override or a same-name Secret replaces', async () => {
    stubs.resolveEcsSecrets.mockImplementation(
      async (secrets: { containerName: string; name: string }[]) =>
        secrets.map((s) => ({ ...s, value: `resolved-${s.name}` }))
    );
    const task = makeTask([
      makeContainer({
        environment: { A: TOKEN, B: TOKEN },
        secrets: [{ name: 'B', valueFrom: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:b' }],
      }),
    ]);
    await runEcsTask(
      task,
      { ...runnableOptions(task), envOverrides: { Parameters: { A: 'global' } } },
      createEcsRunState()
    );
    expect(smSend).not.toHaveBeenCalled();
    expect(dockerRunCalls()[0]!).toContain('A=global');
  });

  it('a key already flagged sensitive (a decrypted SecureString) is never scanned', async () => {
    const task = makeTask([
      makeContainer({ environment: { K: `x${TOKEN}` }, sensitiveEnvKeys: ['K'] }),
    ]);
    await runEcsTask(task, runnableOptions(task), createEcsRunState());
    expect(smSend).not.toHaveBeenCalled();
  });

  it.each([
    ['Command', { command: ['sh', '-c', `echo ${TOKEN}`] }],
    ['EntryPoint', { entryPoint: [TOKEN] }],
    ['HealthCheck.Command', { healthCheck: { command: ['CMD', TOKEN] } }],
  ])('refuses a dynamic reference in %s (it would land on the argv)', async (field, extra) => {
    const task = makeTask([makeContainer(extra as never)]);
    const err = await runEcsTask(task, runnableOptions(task), createEcsRunState()).catch(
      (e: unknown) => e as Error
    );
    expect(err.message).toContain(`Container app: ${field} carries a CloudFormation dynamic reference`);
    expect(smSend).not.toHaveBeenCalled();
    expect(dockerRunCalls()).toHaveLength(0);
  });

  it('under finch on macOS the key is refused like a secret, before any fetch', async () => {
    process.env['CDK_DOCKER'] = 'finch';
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    const task = makeTask([makeContainer({ environment: { DB_PASSWORD: TOKEN } })]);
    const err = await runEcsTask(task, runnableOptions(task), createEcsRunState()).catch(
      (e: unknown) => e as Error
    );
    expect(err.message).toContain('Container app: refusing to forward secret(s) DB_PASSWORD');
    expect(smSend).not.toHaveBeenCalled();
  });
});
