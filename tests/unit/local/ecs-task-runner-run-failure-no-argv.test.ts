// go-to-k/cdk-local#794: a failed container `docker run` with an empty stderr
// reports the exit code, never execFile's argv-bearing `err.message`.
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

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
    const args = rest[1] as string[];
    execFileMock(rest[0], args, rest.length > 3 ? rest[2] : undefined);
    if (args[0] === 'run') {
      // A docker run that fails with an EMPTY stderr; execFile's message
      // carries the whole argv.
      cb(Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), { code: 125, stderr: '' }), {
        stdout: '',
        stderr: '',
      });
      return;
    }
    cb(null, { stdout: '', stderr: '' });
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

const SECRET = 'literal-env-SENTINEL';

describe('runEcsTask docker run failure with an empty stderr', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    for (const stub of Object.values(stubs)) stub.mockReset();
    stubs.resolveEcsSecrets.mockResolvedValue([]);
    stubs.createTaskNetwork.mockResolvedValue(network);
  });

  it('names the exit code and carries no -e value', async () => {
    const task = makeTask([makeContainer({ environment: { DB_URL: `postgres://u:${SECRET}@h/db` } })]);
    const err = await runEcsTask(task, runnableOptions(task), createEcsRunState()).catch(
      (e: unknown) => e
    );
    // Premise: the value really was on the argv.
    const run = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'run');
    expect((run![1] as string[]).join(' ')).toContain(SECRET);
    expect((err as Error).message).toContain("docker run failed for container app: exited with code 125");
    expect((err as Error).message).not.toContain(SECRET);
  });
});
