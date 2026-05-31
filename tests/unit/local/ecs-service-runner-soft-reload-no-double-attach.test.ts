import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { FrontDoorEndpointPool } from '../../../src/local/front-door-pool.js';
import { CloudMapRegistry } from '../../../src/local/cloud-map-registry.js';

/**
 * Issue #227 review fix (Test G5) — soft-reload MUST NOT call
 * `attachContainerLogStreamer` a second time.
 *
 * The Phase 4 soft-reload primitive preserves container IDs across
 * `docker restart` — the original streamer attached at boot keeps
 * tailing the new PID-1's stdout via the in-streamer re-attach
 * loop (locked in `container-log-streamer.test.ts`). A regression
 * that adds a redundant `attachContainerLogStreamer` call inside
 * `softReloadReplica` would silently DOUBLE every log line: the
 * pre-existing streamer + the new one both follow the same
 * container's logs.
 *
 * This test instruments the streamer module, runs the full
 * `softReloadReplica` cycle with `streamLogs` ON (NOT disabled like
 * the main soft-reload test file does), and asserts the attach
 * count after soft-reload equals the attach count at boot.
 *
 * Co-existing companion file:
 *
 *   - `ecs-service-runner-soft-reload.test.ts` — every other soft-
 *     reload invariant (drain order, flag transitions, error
 *     paths, generation bump). That file intentionally disables
 *     streamLogs to avoid the child-process side-effect; this file
 *     re-enables it because the assertion under test IS about the
 *     streamer-side wiring.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    bootCount: 0,
    attachCallCount: 0,
  },
}));

vi.mock('../../../src/local/container-log-streamer.js', () => ({
  attachContainerLogStreamer: () => {
    hoisted.attachCallCount += 1;
    return () => {
      /* stop function */
    };
  },
}));

vi.mock('../../../src/local/ecs-task-runner.js', () => ({
  createEcsRunState: () => ({
    network: undefined,
    dockerVolumeNames: [],
    startedContainers: [],
    logStoppers: [],
    publishedEndpoints: [],
  }),
  cleanupEcsRun: async () => undefined,
  runEcsTask: async (_task: unknown, _options: unknown, state: Record<string, unknown>) => {
    hoisted.bootCount += 1;
    state['network'] = {
      networkName: `net-${hoisted.bootCount}`,
      sidecarContainerId: `sc-${hoisted.bootCount}`,
      sidecarIp: '169.254.171.2',
      ownedByCaller: true,
    };
    (state['startedContainers'] as { name: string; id: string }[]).push({
      name: 'web',
      id: `cid-${hoisted.bootCount}`,
    });
    return { exitCode: 0, state };
  },
}));

vi.mock('../../../src/local/docker-inspect.js', () => ({
  getContainerNetworkIp: async (containerId: string) => {
    const m = /^cid-(\d+)$/.exec(containerId);
    return m ? `172.20.0.${10 + parseInt(m[1]!, 10)}` : `172.20.0.99`;
  },
  getPublishedHostPort: async (containerId: string) => {
    const m = /^cid-(\d+)$/.exec(containerId);
    return m ? 5000 + parseInt(m[1]!, 10) : 5999;
  },
}));

const {
  startEcsService,
  softReloadReplica,
  createServiceRunState,
  __setWaitForExitImpl,
  __setSleepImpl,
  __setTcpProbeImpl,
  __setShadowReadyConfig,
  __setDockerInspectWorkdirImpl,
  __setDockerCpImpl,
  __setDockerRestartImpl,
} = await import('../../../src/local/ecs-service-runner.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeService(): any {
  return {
    stack: { stackName: 'AppStack' },
    serviceLogicalId: 'Svc',
    serviceName: 'Svc',
    serviceDisplayName: 'Svc',
    desiredCount: 1,
    healthCheckGracePeriodSeconds: 30,
    task: {
      taskDefinitionLogicalId: 'TD',
      family: 'fam',
      containers: [
        {
          name: 'web',
          essential: true,
          portMappings: [{ containerPort: 80, name: 'web-port' }],
        },
      ],
      warnings: [],
    },
    loadBalancers: [],
    serviceConnect: undefined,
    serviceRegistries: [],
    warnings: [],
  };
}

function fakeOptions(pool: FrontDoorEndpointPool, registry: CloudMapRegistry) {
  return {
    maxTasks: 5,
    restartPolicy: 'on-failure' as const,
    taskOptions: {
      cluster: 'cdkl',
      containerHost: '127.0.0.1',
      skipPull: true,
      keepRunning: false,
      detach: true,
    },
    discovery: { registry, cloudMapIndexByStack: new Map() },
    frontDoor: { pools: [{ pool, targetContainerName: 'web', targetContainerPort: 80 }] },
    // The point of this file — streamLogs ON during the soft-reload.
    streamLogs: true,
  };
}

describe('softReloadReplica preserves the existing streamer (no double attach)', () => {
  beforeEach(() => {
    hoisted.bootCount = 0;
    hoisted.attachCallCount = 0;
    __setSleepImpl(() => Promise.resolve());
    __setWaitForExitImpl(() => new Promise<number>(() => {}));
    __setTcpProbeImpl(() => Promise.resolve());
    __setShadowReadyConfig({ timeoutMs: 50, intervalMs: 5 });
    __setDockerInspectWorkdirImpl(async () => '/app');
    __setDockerCpImpl(async () => undefined);
    __setDockerRestartImpl(async () => undefined);
  });

  afterEach(() => {
    __setWaitForExitImpl(undefined);
    __setSleepImpl(undefined);
    __setTcpProbeImpl(undefined);
    __setShadowReadyConfig(undefined);
    __setDockerInspectWorkdirImpl(undefined);
    __setDockerCpImpl(undefined);
    __setDockerRestartImpl(undefined);
  });

  it('does NOT re-attach a streamer during soft-reload (the boot-time streamer keeps tailing across docker restart)', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);

    // Boot phase: 1 replica x 1 container => 1 attach call.
    expect(hoisted.attachCallCount).toBe(1);

    // Soft-reload r0. The primitive does docker inspect → cp →
    // restart for each essential, then re-publishes Cloud Map /
    // front-door. It MUST NOT call attachContainerLogStreamer again
    // — the boot-time streamer's in-process re-attach loop owns the
    // post-restart follow.
    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeService(),
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });

    // Attach count is UNCHANGED.
    expect(hoisted.attachCallCount).toBe(1);

    await controller.shutdown();
  });

  it('two consecutive soft-reloads still attach only once (regression guard)', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);

    expect(hoisted.attachCallCount).toBe(1);

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeService(),
      sourceDirToCopy: '/tmp/cdk.out/asset.first',
    });
    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeService(),
      sourceDirToCopy: '/tmp/cdk.out/asset.second',
    });

    expect(hoisted.attachCallCount).toBe(1);

    await controller.shutdown();
  });
});
