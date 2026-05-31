import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { FrontDoorEndpointPool } from '../../../src/local/front-door-pool.js';

// Lock the per-replica front-door lifecycle in the service runner (the
// load-bearing register/unregister symmetry the Docker integ can't reliably
// exercise — it never restarts a replica). We mock the docker boundary
// (ecs-task-runner + docker-inspect) so no real container is needed.

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    bootCount: 0,
    publishedPorts: [5001, 5002, 5003] as number[],
    publishCount: 0,
  },
}));

vi.mock('../../../src/local/ecs-task-runner.js', () => ({
  createEcsRunState: () => ({
    network: undefined,
    dockerVolumeNames: [],
    startedContainers: [],
    logStoppers: [],
  }),
  cleanupEcsRun: async () => {},
  runEcsTask: async (_task: unknown, _options: unknown, state: Record<string, unknown>) => {
    hoisted.bootCount += 1;
    state['network'] = { networkName: 'net', sidecarContainerId: 'sc', sidecarIp: '169.254.171.2' };
    (state['startedContainers'] as { name: string; id: string }[]).push({
      name: 'web',
      id: `cid-${hoisted.bootCount}`,
    });
    return { exitCode: 0, state };
  },
}));

vi.mock('../../../src/local/docker-inspect.js', () => ({
  getContainerNetworkIp: async () => '172.20.0.5',
  // Hand back a distinct host port per publish so a restart's re-register is
  // observable (the entry's port changes).
  getPublishedHostPort: async () => hoisted.publishedPorts[hoisted.publishCount++] ?? 5999,
}));

const { startEcsService, createServiceRunState, __setWaitForExitImpl, __setSleepImpl } =
  await import('../../../src/local/ecs-service-runner.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeService(): any {
  return {
    stack: { stackName: 'AlbStack' },
    serviceLogicalId: 'Svc',
    serviceName: 'Svc',
    desiredCount: 1,
    healthCheckGracePeriodSeconds: 30,
    task: {
      taskDefinitionLogicalId: 'TD',
      family: 'fam',
      containers: [{ name: 'web', essential: true, portMappings: [{ containerPort: 80 }] }],
      warnings: [],
    },
    loadBalancers: [],
    serviceRegistries: [],
    warnings: [],
  };
}

function frontDoorOptions(pool: FrontDoorEndpointPool) {
  return {
    maxTasks: 3,
    restartPolicy: 'on-failure' as const,
    taskOptions: {
      cluster: 'cdkl',
      containerHost: '127.0.0.1',
      skipPull: true,
      keepRunning: false,
      detach: true,
    },
    frontDoor: { pools: [{ pool, targetContainerName: 'web', targetContainerPort: 80 }] },
    // Issue #227 — opt this front-door unit out of `docker logs -f`
    // spawning. The streamer's child-process side-effects leak across
    // vitest's parallel workers otherwise. The streamer wiring itself
    // is covered by `ecs-service-runner-stream-logs.test.ts`.
    streamLogs: false,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('service runner front-door lifecycle', () => {
  beforeEach(() => {
    hoisted.bootCount = 0;
    hoisted.publishCount = 0;
    __setSleepImpl(() => Promise.resolve()); // skip restart backoff
  });
  afterEach(() => {
    __setWaitForExitImpl(undefined);
    __setSleepImpl(undefined);
  });

  it('registers the replica on boot and unregisters it on shutdown', async () => {
    __setWaitForExitImpl(() => new Promise<number>(() => {})); // replica never exits
    const pool = new FrontDoorEndpointPool();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controller = await startEcsService(fakeService(), frontDoorOptions(pool) as any, runState);

    expect(pool.size()).toBe(1);
    expect(pool.list()[0]).toEqual({ host: '127.0.0.1', port: 5001 });

    await controller.shutdown();
    expect(pool.size()).toBe(0);
  });

  it('re-registers under the same owner key across a restart (no leak, no duplicate)', async () => {
    // Exit non-zero exactly once (triggers one restart), then block.
    let exits = 0;
    __setWaitForExitImpl(() => {
      exits += 1;
      if (exits === 1) return Promise.resolve(1);
      return new Promise<number>(() => {});
    });
    const pool = new FrontDoorEndpointPool();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controller = await startEcsService(fakeService(), frontDoorOptions(pool) as any, runState);

    expect(pool.size()).toBe(1); // initial boot -> port 5001

    // After the restart settles, the pool still has exactly ONE entry (the
    // owner key was unregistered then re-registered, not duplicated) and its
    // port is the restart's freshly-published one.
    await waitFor(() => pool.list()[0]?.port === 5002);
    expect(pool.size()).toBe(1);

    await controller.shutdown();
    expect(pool.size()).toBe(0);
  });
});
