import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';
import {
  awsEmulatorSqsHostBlocks,
  resetWorkloadAwsWiringForTest,
  setActiveWorkloadAwsWiring,
  type WorkloadAwsWiring,
} from '../../../src/local/workload-aws-wiring.js';

// Issue #878: under a loopback AWS endpoint each task container starts inside
// a namespace-owning loopback forwarder that is already up.
const { execFileMock, stubs } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  stubs: { createTaskNetwork: vi.fn(), startFwd: vi.fn(), remember: vi.fn() },
}));

vi.mock('node:child_process', () => ({
  execFile: (...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: (Error & { stderr?: string }) | null,
      result: { stdout: string; stderr: string }
    ) => void;
    try {
      const out = execFileMock(rest[0], rest[1]) as string | undefined;
      cb(null, { stdout: out ?? '', stderr: '' });
    } catch (err) {
      cb(err as Error, { stdout: '', stderr: '' });
    }
  },
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../../src/local/ecs-network.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/local/ecs-network.js')>()),
  createTaskNetwork: stubs.createTaskNetwork,
  destroyTaskNetwork: vi.fn(async () => undefined),
}));

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/local/docker-runner.js')>()),
  startNamespaceOwnerForwarder: stubs.startFwd,
  rememberForwardedPorts: stubs.remember,
}));

const { buildDockerRunArgs, cleanupEcsRun, createEcsRunState, runEcsTask } =
  await import('../../../src/local/ecs-task-runner.js');

function container(over: Partial<ResolvedEcsContainer> = {}): ResolvedEcsContainer {
  return {
    name: 'app',
    image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
    environment: { APP: '1' },
    sensitiveEnvKeys: [],
    secrets: [],
    portMappings: [],
    mountPoints: [],
    dependsOn: [],
    links: [],
    essential: true,
    ulimits: [],
    warnings: [],
    ...over,
  } as unknown as ResolvedEcsContainer;
}

const wiring: WorkloadAwsWiring = {
  mode: 'emulator',
  env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9351' },
  scrubEnvKeys: [],
  mounts: [{ hostPath: '/tmp/ca/ca-bundle.pem', containerPath: '/cdk-local-aws/ca-bundle.pem' }],
  loopbackPorts: [9351],
  probeHealth: true,
  emulatorCredentials: { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'EMUSECRET' },
  dispose: () => undefined,
};

function build(c: ResolvedEcsContainer, extra: Record<string, unknown> = {}) {
  return buildDockerRunArgs({
    task: { family: 'fam' } as unknown as ResolvedEcsTask,
    container: c,
    image: 'busybox',
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    envOverrides: undefined,
    containerHost: '127.0.0.1',
    roleArn: undefined,
    platformOverride: undefined,
    region: 'us-east-1',
    ...extra,
  });
}

/** Every value that follows `flag` in `argv`. */
function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === flag && i + 1 < argv.length) out.push(argv[i + 1]!);
  });
  return out;
}

afterEach(() => resetWorkloadAwsWiringForTest());

describe('buildDockerRunArgs: the namespace-owning forwarder (issue #878)', () => {
  const rich = container({
    portMappings: [
      { containerPort: 8080, protocol: 'tcp' },
      { containerPort: 9000, protocol: 'tcp' },
    ],
    links: ['db:db'],
    user: '1000',
    privileged: true,
    readonlyRootFilesystem: true,
    workingDirectory: '/srv',
    ulimits: [{ name: 'nofile', softLimit: 1024, hardLimit: 2048 }],
    entryPoint: ['/bin/sh', '-c'],
    command: ['serve'],
    mountPoints: [
      { sourceVolume: 'data', containerPath: '/data', readOnly: true },
      { sourceVolume: 'scratch', containerPath: '/scratch', readOnly: false },
      { sourceVolume: 'named', containerPath: '/named', readOnly: false },
    ],
    healthCheck: { command: ['CMD-SHELL', 'true'], interval: 5 },
  } as unknown as Partial<ResolvedEcsContainer>);
  const extra = {
    platformOverride: 'linux/amd64',
    volumeByName: new Map([
      ['data', { kind: 'host', name: 'data', hostPath: '/host/data' }],
      ['scratch', { kind: 'host', name: 'scratch' }],
      ['named', { kind: 'docker', name: 'named', dockerVolumeName: 'cdkl-vol-named' }],
    ]),
    networkAliases: ['api.local'],
    addHostFlags: ['--add-host', 'peer.ns:10.0.0.9', '--add-host', 'host.docker.internal:host-gateway'],
    ephemeralPublishContainerPorts: [9000],
  };

  it('moves aliases, publishes, host mappings and links to the forwarder; the joiner shares its network', () => {
    setActiveWorkloadAwsWiring(wiring);
    const built = build(rich, extra);
    const fwd = built.forwarder!;
    const name = flagValues(built.args, '--name')[0]!;
    expect(fwd.name).toBe(`${name}-awsfwd`);
    expect(fwd.namespace).toEqual({
      network: 'net',
      networkAliases: ['app', 'api.local'],
      publish: ['127.0.0.1:8080:8080/tcp', '127.0.0.1::9000/tcp'],
      // The SQS host blocks of an emulator-side container follow the task's own (#947).
      addHosts: [
        'peer.ns:10.0.0.9',
        'host.docker.internal:host-gateway',
        ...awsEmulatorSqsHostBlocks({ AWS_ENDPOINT_URL: 'https://127.0.0.1:4566' }, wiring).map(
          (h) => `${h.host}:${h.ip}`
        ),
      ],
      links: ['db:db'],
    });
    // On its own network endpoint the container carries the SQS host blocks itself (#947).
    expect(built.args[built.args.indexOf('sqs.us-east-1.amazonaws.com:127.0.0.1') - 1]).toBe('--add-host');
    // The joiner: same name, the forwarder's network, none of the refused flags.
    expect(flagValues(fwd.args, '--name')).toEqual([name]);
    expect(flagValues(fwd.args, '--network')).toEqual([`container:${fwd.name}`]);
    for (const refused of ['--network-alias', '-p', '--add-host', '--link']) {
      expect(fwd.args).not.toContain(refused);
    }
    // Everything else is identical: env, mounts, user, health check, image + command.
    const strip = (argv: string[]): string[] => {
      const out: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (['--network', '--network-alias', '-p', '--add-host', '--link'].includes(argv[i]!)) {
          i++;
          continue;
        }
        out.push(argv[i]!);
      }
      return out;
    };
    expect(strip(fwd.args)).toEqual(strip(built.args));
    // The fixture exercises every shared flag family (a missing one would
    // make the equality above vacuous for it).
    for (const v of ['/host/data:/data:ro', '/scratch', 'cdkl-vol-named:/named', 'linux/amd64',
      '/srv', 'nofile=1024:2048', '--privileged', '--read-only', '--entrypoint', 'serve',
      '/tmp/ca/ca-bundle.pem:/cdk-local-aws/ca-bundle.pem:ro']) {
      expect(fwd.args).toContain(v);
    }
    expect(fwd.args).toContain('AWS_ENDPOINT_URL=https://127.0.0.1:9351');
    expect(fwd.args.join(' ')).not.toContain('EMUSECRET');
  });

  it('keeps the own-endpoint argv exactly as before', () => {
    setActiveWorkloadAwsWiring(wiring);
    const built = build(rich, extra);
    expect(flagValues(built.args, '--network')).toEqual(['net']);
    expect(flagValues(built.args, '--network-alias')).toEqual(['app', 'api.local']);
    expect(flagValues(built.args, '-p')).toEqual(['127.0.0.1:8080:8080/tcp', '127.0.0.1::9000/tcp']);
    expect(flagValues(built.args, '--link')).toEqual(['db:db']);
  });

  it('builds no forwarder without a loopback endpoint', () => {
    expect(build(rich, extra).forwarder).toBeUndefined();
    setActiveWorkloadAwsWiring({ ...wiring, mode: 'forward', env: {}, loopbackPorts: [] });
    expect(build(rich, extra).forwarder).toBeUndefined();
  });

  it('omits the container-name alias from the forwarder when the runner omits it', () => {
    setActiveWorkloadAwsWiring(wiring);
    const built = build(container(), { omitContainerNameAlias: true });
    expect(built.forwarder!.namespace.networkAliases).toEqual([]);
  });
});

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

function options(names: string[]) {
  return {
    cluster: 'cdkl',
    containerHost: '127.0.0.1',
    skipPull: true,
    keepRunning: false,
    detach: true,
    skipHostPortPublish: true,
    imagePlanByContainer: new Map(names.map((n) => [n, 'busybox:latest'])),
  };
}

describe('runEcsTask: forwarder first, container in its namespace (issue #878)', () => {
  const order: string[] = [];
  beforeEach(() => {
    order.length = 0;
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run') {
        order.push(`run ${flagValues(args, '--network')[0]}`);
        return `cid-${flagValues(args, '--name')[0]}\n`;
      }
      order.push(args.slice(0, 2).join(' '));
      return '';
    });
    stubs.createTaskNetwork.mockReset();
    stubs.createTaskNetwork.mockResolvedValue({
      networkName: 'cdkl-task-x',
      sidecarContainerId: 'sc',
      sidecarIp: '169.254.171.2',
    });
    stubs.remember.mockReset();
    stubs.startFwd.mockReset();
    stubs.startFwd.mockImplementation(async (o: { name: string }) => {
      order.push(`fwd ${o.name}`);
      return `fid-${o.name}`;
    });
  });

  it('starts each container after its forwarder reports READY, joined to it', async () => {
    setActiveWorkloadAwsWiring(wiring);
    const state = createEcsRunState();
    await runEcsTask(
      makeTask([container(), container({ name: 'side', essential: false })]),
      options(['app', 'side']),
      state
    );
    expect(stubs.startFwd).toHaveBeenCalledTimes(2);
    const [first] = stubs.startFwd.mock.calls[0]!;
    expect(first).toMatchObject({ ports: [9351], wiring, workloadLabel: 'container app' });
    expect(first.namespace.network).toBe('cdkl-task-x');
    expect(stubs.remember).not.toHaveBeenCalled();
    expect(order.filter((o) => o.startsWith('fwd') || o.startsWith('run'))).toEqual([
      `fwd ${state.forwarders[0]!.name}`,
      `run container:${state.forwarders[0]!.name}`,
      `fwd ${state.forwarders[1]!.name}`,
      `run container:${state.forwarders[1]!.name}`,
    ]);
    expect(state.forwarders.map((f) => [f.containerName, f.joined])).toEqual([
      ['app', true],
      ['side', true],
    ]);
    expect(state.forwarders[0]!.id).toBe(`fid-${state.forwarders[0]!.name}`);
  });

  it('starts the container on its own endpoint when the forwarder failed (forward mode)', async () => {
    setActiveWorkloadAwsWiring({ ...wiring, mode: 'forward' });
    stubs.startFwd.mockResolvedValue(undefined);
    const state = createEcsRunState();
    await runEcsTask(makeTask([container()]), options(['app']), state);
    expect(order).toContain('run cdkl-task-x');
    expect(state.forwarders).toEqual([]);
    // A later --watch restart attaches a forwarder for these ports only.
    expect(stubs.remember).toHaveBeenCalledWith(state.startedContainers[0]!.id, expect.anything(), [9351]);
  });

  it('records an empty port set for a container whose env replaced the loopback endpoint', async () => {
    setActiveWorkloadAwsWiring({ ...wiring, mode: 'forward' });
    const state = createEcsRunState();
    await runEcsTask(
      makeTask([container({ environment: { AWS_ENDPOINT_URL: 'http://task-declared:1' } })]),
      options(['app']),
      state
    );
    expect(stubs.startFwd).not.toHaveBeenCalled();
    expect(stubs.remember).toHaveBeenCalledWith(state.startedContainers[0]!.id, expect.anything(), []);
  });

  it('propagates an --aws-emulator forwarder failure before the container starts', async () => {
    setActiveWorkloadAwsWiring(wiring);
    stubs.startFwd.mockRejectedValue(new Error('--aws-emulator https://127.0.0.1:9351: unreachable'));
    const state = createEcsRunState();
    await expect(runEcsTask(makeTask([container()]), options(['app']), state)).rejects.toThrow(
      /unreachable/
    );
    expect(order.some((o) => o.startsWith('run'))).toBe(false);
    expect(state.startedContainers).toEqual([]);
  });

  it('leaves the argv alone without a loopback endpoint', async () => {
    const state = createEcsRunState();
    await runEcsTask(makeTask([container()]), options(['app']), state);
    expect(stubs.startFwd).not.toHaveBeenCalled();
    expect(order).toContain('run cdkl-task-x');
  });

  it('records an unjoined forwarder when the container run fails, and teardown removes it', async () => {
    setActiveWorkloadAwsWiring(wiring);
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run') throw Object.assign(new Error('boom'), { stderr: 'port in use' });
      order.push(args.join(' '));
      return '';
    });
    const state = createEcsRunState();
    await expect(runEcsTask(makeTask([container()]), options(['app']), state)).rejects.toThrow(
      /docker run failed/
    );
    expect(state.forwarders.map((f) => f.joined)).toEqual([false]);
    const fid = state.forwarders[0]!.id;
    await cleanupEcsRun(state, { keepRunning: true });
    expect(order).toContain(`rm -f ${fid}`);
    expect(state.forwarders).toEqual([]);
  });
});

describe('cleanupEcsRun: forwarders go after their containers (issue #878)', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockReturnValue('');
  });

  function seeded() {
    const state = createEcsRunState();
    state.startedContainers.push({ name: 'app', id: 'c1' });
    state.forwarders.push(
      { containerName: 'app', name: 'f1', id: 'fid1', joined: true },
      { containerName: 'side', name: 'f2', id: 'fid2', joined: false }
    );
    return state;
  }

  it('removes the unjoined forwarder first, then the container, then its forwarder', async () => {
    const state = seeded();
    await cleanupEcsRun(state, { keepRunning: false });
    const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls).toEqual(['rm -f fid2', 'stop -t 10 c1', 'rm -f c1', 'rm -f fid1']);
    expect(state.forwarders).toEqual([]);
  });

  it('--keep-running keeps a joined forwarder with its container', async () => {
    const state = seeded();
    await cleanupEcsRun(state, { keepRunning: true });
    const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls).toEqual(['rm -f fid2']);
    expect(state.forwarders.map((f) => f.name)).toEqual(['f1']);
  });
});
