import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

// Issue #990: a container that exits right after starting lost its output
// because the log follow was SIGTERMed at the exit. `runEcsTask` must let the
// ESSENTIAL container's log stream drain before it returns (and so before
// teardown stops the stream).
const { execFileMock, stubs, streamer } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  stubs: {
    resolveEcsSecrets: vi.fn(),
    createTaskNetwork: vi.fn(),
    pullImage: vi.fn(),
  },
  streamer: { attach: vi.fn() },
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

vi.mock('../../../src/local/container-log-streamer.js', () => ({
  attachContainerLogStreamer: streamer.attach,
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

const network = {
  networkName: 'cdkl-task-x',
  sidecarContainerId: 'sidecar',
  sidecarIp: '169.254.170.2',
} as never;

function makeStopper() {
  const drain = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const stopper = Object.assign(vi.fn(), { drain });
  return { stopper, drain };
}

describe('runEcsTask drains the essential container log stream (issue #990)', () => {
  const stoppers = new Map<string, ReturnType<typeof makeStopper>>();

  beforeEach(() => {
    stoppers.clear();
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run') return 'cid\n';
      if (args[0] === 'wait') return '0\n';
      return '';
    });
    for (const s of Object.values(stubs)) s.mockReset();
    stubs.resolveEcsSecrets.mockResolvedValue([]);
    stubs.createTaskNetwork.mockResolvedValue(network);
    streamer.attach.mockReset();
    streamer.attach.mockImplementation((prefix: string) => {
      const s = makeStopper();
      stoppers.set(prefix.trim(), s);
      return s.stopper;
    });
  });

  function run() {
    const containers = [
      makeContainer({ name: 'side', essential: false }),
      makeContainer({ name: 'app', essential: true }),
    ];
    const task = {
      taskDefinitionLogicalId: 'TaskDef',
      family: 'fam',
      networkMode: 'bridge',
      containers,
      volumes: [],
      warnings: [],
    } as unknown as ResolvedEcsTask;
    return runEcsTask(
      task,
      {
        cluster: 'cdkl',
        containerHost: '127.0.0.1',
        skipPull: true,
        keepRunning: false,
        detach: false,
        skipHostPortPublish: true,
        existingNetwork: network,
        imagePlanByContainer: new Map(containers.map((c) => [c.name, 'busybox:latest'])),
      },
      createEcsRunState()
    );
  }

  it("awaits the essential container's drain (2000 ms) before resolving, and not a sidecar's", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const origImpl = streamer.attach.getMockImplementation()!;
    streamer.attach.mockImplementation((prefix: string, id: string) => {
      const stopper = origImpl(prefix, id) as ReturnType<typeof makeStopper>['stopper'];
      if (prefix.includes('app')) stopper.drain.mockReturnValue(gate);
      return stopper;
    });

    let resolved = false;
    const p = run().then((r) => {
      resolved = true;
      return r;
    });

    await vi.waitFor(() => expect(stoppers.get('[app]')?.drain).toHaveBeenCalledWith(2000));
    // Let any pending microtasks run: the run must still be waiting on the drain.
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    release();
    const result = await p;
    expect(resolved).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(stoppers.get('[side]')?.drain).not.toHaveBeenCalled();
  });
});
