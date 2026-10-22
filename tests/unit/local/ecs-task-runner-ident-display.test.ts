// #761: assembly-chosen container names / tags in ecs-task-runner's messages
// render bare when plain and as ONE JSON literal when they could forge a
// boundary. Expected strings are written by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

const { exec, stubs, manifestRef } = vi.hoisted(() => ({
  exec: { health: 'healthy', waitCode: '0', runN: 0 },
  stubs: {
    resolveEcsSecrets: vi.fn(),
    createTaskNetwork: vi.fn(),
    pullImage: vi.fn(),
    pullEcrImage: vi.fn(),
    buildDockerImage: vi.fn(),
    isImageInLocalCache: vi.fn(),
  },
  manifestRef: { value: undefined as unknown },
}));

vi.mock('node:child_process', () => ({
  execFile: (...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const args = rest[1] as string[];
    if (args[0] === 'run') cb(null, { stdout: `cid-${exec.runN++}\n`, stderr: '' });
    else if (args[0] === 'wait') cb(null, { stdout: `${exec.waitCode}\n`, stderr: '' });
    else if (args[0] === 'inspect') cb(null, { stdout: `${exec.health}\n`, stderr: '' });
    else cb(null, { stdout: '', stderr: '' });
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
  isImageInLocalCache: stubs.isImageInLocalCache,
  pullEcrImage: stubs.pullEcrImage,
}));
vi.mock('../../../src/assets/docker-build.js', () => ({
  buildDockerImage: stubs.buildDockerImage,
}));
vi.mock('../../../src/assets/asset-manifest-loader.js', () => ({
  AssetManifestLoader: class {
    async loadStackManifest(): Promise<unknown> {
      return manifestRef.value;
    }
  },
}));

const { runEcsTask, createEcsRunState, prepareImages, resolvePrivilegedHostPortRemaps } =
  await import('../../../src/local/ecs-task-runner.js');

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

function makeTask(containers: ResolvedEcsContainer[], extra: object = {}): ResolvedEcsTask {
  return {
    taskDefinitionLogicalId: 'TaskDef',
    family: 'fam',
    networkMode: 'bridge',
    containers,
    volumes: [],
    warnings: [],
    ...extra,
  } as unknown as ResolvedEcsTask;
}

const network = {
  networkName: 'cdkl-task-x',
  sidecarContainerId: 'sidecar',
  sidecarIp: '169.254.170.2',
} as never;

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

let lines: string[] = [];

beforeEach(() => {
  exec.health = 'healthy';
  exec.waitCode = '0';
  exec.runN = 0;
  lines = [];
  for (const stub of Object.values(stubs)) stub.mockReset();
  stubs.resolveEcsSecrets.mockResolvedValue([]);
  stubs.createTaskNetwork.mockResolvedValue(network);
  const grab = (m: unknown): void => {
    lines.push(String(m));
  };
  vi.spyOn(console, 'warn').mockImplementation(grab);
  vi.spyOn(console, 'info').mockImplementation(grab);
  vi.spyOn(console, 'debug').mockImplementation(grab);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function messageOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err
  );
  expect(e).toBeInstanceOf(Error);
  return (e as Error).message;
}

const DEPS = (
  dep: string,
  name: string,
  condition: 'SUCCESS' | 'HEALTHY'
): ResolvedEcsContainer[] => [
  makeContainer({ name: dep }),
  makeContainer({ name, essential: false, dependsOn: [{ containerName: dep, condition }] }),
];

describe('ecs-task-runner dependency messages (#761)', () => {
  it('requires dependency ... to exit 0: plain bare, forging quoted', async () => {
    exec.waitCode = '3';
    for (const [dep, name, expected] of [
      ['init', 'web', 'Container web requires dependency init to exit 0, but it exited 3.'],
      [
        "a' b",
        'x\u001b[2Kforged',
        'Container "x [2Kforged" requires dependency "a\' b" to exit 0, but it exited 3.',
      ],
    ] as const) {
      const task = makeTask(DEPS(dep, name, 'SUCCESS'));
      expect(await messageOf(runEcsTask(task, runnableOptions(task), createEcsRunState()))).toBe(
        expected
      );
    }
  });

  it('unhealthy dependency: plain bare, forging quoted', async () => {
    exec.health = 'unhealthy';
    for (const [dep, expected] of [
      ['db', "Container db health status is 'unhealthy'; aborting before dependents start."],
      [
        "a' b",
        "Container \"a' b\" health status is 'unhealthy'; aborting before dependents start.",
      ],
    ] as const) {
      const task = makeTask(DEPS(dep, 'web', 'HEALTHY'));
      expect(await messageOf(runEcsTask(task, runnableOptions(task), createEcsRunState()))).toBe(
        expected
      );
    }
  });

  it('did not become healthy within 5 minutes: plain bare, forging quoted', async () => {
    vi.useFakeTimers();
    exec.health = 'starting';
    for (const [dep, expected] of [
      ['db', 'Container db did not become healthy within 5 minutes.'],
      ["a' b", 'Container "a\' b" did not become healthy within 5 minutes.'],
    ] as const) {
      const task = makeTask(DEPS(dep, 'web', 'HEALTHY'));
      const p = messageOf(runEcsTask(task, runnableOptions(task), createEcsRunState()));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5000);
      expect(await p).toBe(expected);
    }
  });

  it('a task with no containers names the task def: plain bare, forging quoted', async () => {
    const mk = (id: string): ResolvedEcsTask => makeTask([], { taskDefinitionLogicalId: id });
    expect(await messageOf(runEcsTask(mk('TaskDef'), runnableOptions(mk('TaskDef')), createEcsRunState()))).toBe(
      'Task TaskDef has no containers — nothing to run.'
    );
    expect(await messageOf(runEcsTask(mk("a' b"), runnableOptions(mk("a' b")), createEcsRunState()))).toBe(
      'Task "a\' b" has no containers — nothing to run.'
    );
  });
});

describe('ecs-task-runner --no-build / asset messages (#761)', () => {
  const asset = (name: string, assetHash?: string): ResolvedEcsTask =>
    makeTask(
      [
        makeContainer({
          name,
          image: { kind: 'cdk-asset', ...(assetHash !== undefined && { assetHash }) } as never,
        }),
      ],
      { stack: { stackName: 'S', assetManifestPath: '/cdk.out/S.assets.json' } }
    );
  const opts = { skipPull: false, skipBuild: true } as never;

  it('no asset manifest: plain bare, forging quoted', async () => {
    const mk = (name: string): ResolvedEcsTask => {
      const t = asset(name);
      (t as unknown as { stack: object }).stack = { stackName: 'S' };
      return t;
    };
    expect(await messageOf(prepareImages(mk('web'), new Map(), opts))).toMatch(
      /^Container web uses a CDK asset image but the stack has no asset manifest\. /
    );
    expect(await messageOf(prepareImages(mk("a' b"), new Map(), opts))).toMatch(
      /^Container "a' b" uses a CDK asset image but the stack has no asset manifest\. /
    );
  });

  it('--no-build without a stable assetHash: container bare, forging quoted; tag bare', async () => {
    manifestRef.value = { dockerImages: { h: { source: { directory: 'x' } } } };
    expect(await messageOf(prepareImages(asset('web'), new Map(), opts))).toMatch(
      /^Cannot honor --no-build for ECS container web: the asset has no stable assetHash \(synthetic tag cdkl-run-task-single may collide /
    );
    expect(await messageOf(prepareImages(asset('x\u001b[2Kforged'), new Map(), opts))).toMatch(
      /^Cannot honor --no-build for ECS container "x \[2Kforged": the asset has no stable assetHash \(synthetic tag cdkl-run-task-single may collide /
    );
  });

  it('--no-build image missing from the local registry: plain bare, forging quoted', async () => {
    manifestRef.value = { dockerImages: { abc: { source: { directory: 'x' } } } };
    stubs.isImageInLocalCache.mockResolvedValue(false);
    expect(await messageOf(prepareImages(asset('web', 'abc'), new Map(), opts))).toMatch(
      /^image cdkl-run-task-abc not in local registry and --no-build is set \(ECS container web\); /
    );
    expect(await messageOf(prepareImages(asset("a' b", 'abc'), new Map(), opts))).toMatch(
      /^image cdkl-run-task-abc not in local registry and --no-build is set \(ECS container "a' b"\); /
    );
  });
});

describe('ecs-task-runner privileged-port warn (#761)', () => {
  const remap = (name: string): Promise<unknown> =>
    resolvePrivilegedHostPortRemaps({
      task: makeTask([makeContainer({ name, portMappings: [{ containerPort: 80, protocol: 'tcp' }] })]),
      userOverrides: undefined,
      ephemeralPorts: new Set(),
      allocate: async () => 50000,
    });

  it('plain container name bare, forging one as a JSON literal', async () => {
    await remap('web');
    expect(lines.find((l) => l.includes('privileged host port'))).toContain(
      'WARN: Container web container port 80 declares a privileged host port 80,'
    );
    lines = [];
    await remap("a' b");
    expect(lines.find((l) => l.includes('privileged host port'))).toContain(
      'WARN: Container "a\' b" container port 80 declares a privileged host port 80,'
    );
  });
});
