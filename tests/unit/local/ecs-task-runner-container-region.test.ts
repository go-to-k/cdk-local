import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';
import type { RunEcsTaskOptions } from '../../../src/local/ecs-task-runner.js';

// go-to-k/cdk-local#925: a task container's AWS_REGION came only from
// `--region`. The host's AWS_REGION / AWS_DEFAULT_REGION, the stack's region,
// the state record's region and the profile's region never reached it, so the
// task's first SDK call failed with a missing region. `runEcsTask` is the
// engine `run-task`, `start-service` and `start-alb` all start containers with.
const { execFileMock, stubs, sts } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  stubs: {
    resolveEcsSecrets: vi.fn(),
    createTaskNetwork: vi.fn(),
    pullImage: vi.fn(),
  },
  sts: { profileRegion: undefined as string | undefined, profiles: [] as unknown[] },
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

// The profile / `~/.aws/config` region: the SDK's region provider, stubbed so
// the developer's own config never leaks into the result.
vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-sts')>()),
  STSClient: class {
    config: { region: () => Promise<string | undefined> };
    constructor(cfg: { profile?: string }) {
      sts.profiles.push(cfg.profile);
      this.config = {
        region: async () => {
          if (sts.profileRegion === undefined) throw new Error('Region is missing');
          return sts.profileRegion;
        },
      };
    }
    destroy(): void {}
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

const { runEcsTask, createEcsRunState } = await import('../../../src/local/ecs-task-runner.js');

function makeTask(
  environment: Record<string, string> = {},
  stackRegion?: string
): ResolvedEcsTask {
  const container = {
    name: 'app',
    image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
    environment,
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
    stack: {
      stackName: 'S',
      ...(stackRegion !== undefined && { region: stackRegion }),
    },
  } as unknown as ResolvedEcsTask;
}

const network = {
  networkName: 'cdkl-task-x',
  sidecarContainerId: 'sidecar',
  sidecarIp: '169.254.170.2',
} as never;

const KEYS = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE'] as const;

describe('runEcsTask: the container region (go-to-k/cdk-local#925)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    sts.profileRegion = undefined;
    sts.profiles = [];
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'run' ? 'cid\n' : ''
    );
    for (const s of Object.values(stubs)) s.mockReset();
    stubs.resolveEcsSecrets.mockResolvedValue([]);
    stubs.createTaskNetwork.mockResolvedValue(network);
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** The `AWS_REGION` value on the container's `docker run` argv, if any. */
  async function containerRegion(
    task: ResolvedEcsTask,
    over: Partial<RunEcsTaskOptions> = {}
  ): Promise<string | undefined> {
    await runEcsTask(
      task,
      {
        cluster: 'cdkl',
        containerHost: '127.0.0.1',
        skipPull: true,
        keepRunning: false,
        detach: true,
        skipHostPortPublish: true,
        existingNetwork: network,
        imagePlanByContainer: new Map([['app', 'busybox:latest']]),
        ...over,
      },
      createEcsRunState()
    );
    const run = execFileMock.mock.calls
      .map((c) => c[1] as string[])
      .find((a) => a[0] === 'run')!;
    const entries = run.filter((a) => a.startsWith('AWS_REGION='));
    expect(entries.length).toBeLessThanOrEqual(1);
    return entries[0]?.slice('AWS_REGION='.length);
  }

  it("the default profile's ~/.aws/config region reaches the container with nothing else set", async () => {
    sts.profileRegion = 'us-east-1';
    expect(await containerRegion(makeTask())).toBe('us-east-1');
    expect(sts.profiles).toEqual([undefined]);
  });

  it("a named --profile's region is read for that profile", async () => {
    sts.profileRegion = 'ca-central-1';
    expect(await containerRegion(makeTask(), { profile: 'dev' })).toBe('ca-central-1');
    expect(sts.profiles).toContain('dev');
  });

  it('the host AWS_REGION reaches the container (the issue repro)', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    sts.profileRegion = 'us-east-1';
    expect(await containerRegion(makeTask())).toBe('eu-west-1');
  });

  it('the host AWS_DEFAULT_REGION reaches the container when AWS_REGION is unset', async () => {
    process.env['AWS_DEFAULT_REGION'] = 'eu-central-1';
    sts.profileRegion = 'us-east-1';
    expect(await containerRegion(makeTask())).toBe('eu-central-1');
  });

  it('--region wins over the host variables and is folded to lower case', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    expect(await containerRegion(makeTask(), { region: 'AP-NORTHEAST-1' })).toBe(
      'ap-northeast-1'
    );
  });

  it("--stack-region, then the stack's own region, then the state record's sit above the profile", async () => {
    sts.profileRegion = 'us-east-1';
    expect(await containerRegion(makeTask({}, 'us-west-2'), { stackRegion: 'eu-north-1' })).toBe(
      'eu-north-1'
    );
    execFileMock.mockClear();
    expect(
      await containerRegion(makeTask({}, 'us-west-2'), { stateRecordRegion: 'sa-east-1' })
    ).toBe('us-west-2');
    execFileMock.mockClear();
    expect(await containerRegion(makeTask(), { stateRecordRegion: 'sa-east-1' })).toBe(
      'sa-east-1'
    );
  });

  it("an env-agnostic stack's unknown-region placeholder falls through", async () => {
    sts.profileRegion = 'us-east-1';
    expect(await containerRegion(makeTask({}, 'unknown-region'))).toBe('us-east-1');
  });

  it("the container's own Environment entry still wins", async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    expect(await containerRegion(makeTask({ AWS_REGION: 'me-south-1' }))).toBe('me-south-1');
  });

  it('an --env-vars entry still wins', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    expect(
      await containerRegion(makeTask(), { envOverrides: { app: { AWS_REGION: 'af-south-1' } } })
    ).toBe('af-south-1');
  });

  it('leaves the container region-less when nothing names a region', async () => {
    expect(await containerRegion(makeTask())).toBeUndefined();
  });
});
