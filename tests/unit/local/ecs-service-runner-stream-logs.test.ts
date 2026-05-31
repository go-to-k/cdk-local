import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { CloudMapRegistry } from '../../../src/local/cloud-map-registry.js';

/**
 * Issue #227 — locks the `cdkl start-service` / `cdkl start-alb` per-
 * replica `docker logs -f` streamer wiring at the unit level. Mocks the
 * docker boundary (ecs-task-runner + docker-inspect + the streamer
 * helper) so no real container is needed. Verifies:
 *
 *   - Default ON: each replica's `[svc=<service> r=<i> c=<container>] `
 *     streamer is attached AFTER `runEcsTask` returns, and the stopper
 *     is pushed onto `instance.state.logStoppers` so `cleanupEcsRun`
 *     reaps it on shutdown / rebuild rolling reload.
 *   - `--no-logs` (`streamLogs: false`): no streamer is attached for
 *     any replica.
 *   - Prefix shape matches the spec: `[svc=<serviceName> r=<index>
 *     c=<containerName>] ` — load-bearing for the multi-replica /
 *     multi-service line-scanning the user does in the foreground.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    bootCount: 0,
    attachCalls: [] as Array<{ prefix: string; containerId: string }>,
  },
}));

vi.mock('../../../src/local/container-log-streamer.js', () => ({
  attachContainerLogStreamer: (prefix: string, containerId: string) => {
    hoisted.attachCalls.push({ prefix, containerId });
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
  }),
  cleanupEcsRun: async () => {
    /* no-op for stream-logs unit */
  },
  runEcsTask: async (_task: unknown, _options: unknown, state: Record<string, unknown>) => {
    hoisted.bootCount += 1;
    state['network'] = {
      networkName: `net-${hoisted.bootCount}`,
      sidecarContainerId: `sc-${hoisted.bootCount}`,
      sidecarIp: '169.254.171.2',
      ownedByCaller: true,
    };
    // Two containers per replica so a single bootReplica call exercises
    // the per-container loop (catches a regression that attaches only
    // the essential).
    (state['startedContainers'] as { name: string; id: string }[]).push(
      { name: 'web', id: `cid-web-${hoisted.bootCount}` },
      { name: 'sidecar', id: `cid-sidecar-${hoisted.bootCount}` }
    );
    return { exitCode: 0, state };
  },
}));

vi.mock('../../../src/local/docker-inspect.js', () => ({
  getContainerNetworkIp: async () => `172.20.0.${10 + hoisted.bootCount}`,
  getPublishedHostPort: async () => 5999,
}));

const { startEcsService, createServiceRunState, __setWaitForExitImpl, __setSleepImpl } =
  await import('../../../src/local/ecs-service-runner.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeService(): any {
  return {
    stack: { stackName: 'AppStack' },
    serviceLogicalId: 'BackendApi5F9D8C32',
    serviceName: 'BackendApi',
    desiredCount: 2,
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
        {
          name: 'sidecar',
          essential: false,
          portMappings: [],
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseOpts(extra: Record<string, unknown> = {}): any {
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
    discovery: { registry: new CloudMapRegistry(), cloudMapIndexByStack: new Map() },
    ...extra,
  };
}

describe('startEcsService log streaming (Issue #227)', () => {
  beforeEach(() => {
    hoisted.bootCount = 0;
    hoisted.attachCalls = [];
    __setSleepImpl(() => Promise.resolve());
    __setWaitForExitImpl(() => new Promise<number>(() => {}));
  });
  afterEach(() => {
    __setWaitForExitImpl(undefined);
    __setSleepImpl(undefined);
  });

  it('attaches a `docker logs -f` streamer per container per replica by default (streamLogs unspecified)', async () => {
    const runState = createServiceRunState();
    const controller = await startEcsService(fakeService(), baseOpts(), runState);

    // 2 replicas x 2 containers = 4 streamer attachments.
    expect(hoisted.attachCalls.length).toBe(4);
    // Each replica's logStoppers list carries one stopper per container.
    expect(controller.runState.replicas[0]!.state.logStoppers.length).toBe(2);
    expect(controller.runState.replicas[1]!.state.logStoppers.length).toBe(2);
  });

  it('uses the `[svc=<serviceName> r=<i> c=<container>] ` prefix shape', async () => {
    const runState = createServiceRunState();
    await startEcsService(fakeService(), baseOpts(), runState);

    const prefixes = hoisted.attachCalls.map((c) => c.prefix);
    expect(prefixes).toContain('[svc=BackendApi r=0 c=web] ');
    expect(prefixes).toContain('[svc=BackendApi r=0 c=sidecar] ');
    expect(prefixes).toContain('[svc=BackendApi r=1 c=web] ');
    expect(prefixes).toContain('[svc=BackendApi r=1 c=sidecar] ');
  });

  it('attaches the streamer to the SAME docker container id `runEcsTask` recorded (load-bearing for `docker logs -f`)', async () => {
    const runState = createServiceRunState();
    await startEcsService(fakeService(), baseOpts(), runState);

    const idsByPrefix = Object.fromEntries(hoisted.attachCalls.map((c) => [c.prefix, c.containerId]));
    expect(idsByPrefix['[svc=BackendApi r=0 c=web] ']).toBe('cid-web-1');
    expect(idsByPrefix['[svc=BackendApi r=0 c=sidecar] ']).toBe('cid-sidecar-1');
    expect(idsByPrefix['[svc=BackendApi r=1 c=web] ']).toBe('cid-web-2');
    expect(idsByPrefix['[svc=BackendApi r=1 c=sidecar] ']).toBe('cid-sidecar-2');
  });

  it('attaches NO streamer when `streamLogs: false` (`--no-logs`)', async () => {
    const runState = createServiceRunState();
    const controller = await startEcsService(
      fakeService(),
      baseOpts({ streamLogs: false }),
      runState
    );

    expect(hoisted.attachCalls.length).toBe(0);
    expect(controller.runState.replicas[0]!.state.logStoppers).toEqual([]);
    expect(controller.runState.replicas[1]!.state.logStoppers).toEqual([]);
  });

  it('attaches streamers when `streamLogs: true` is explicit (parity with default)', async () => {
    const runState = createServiceRunState();
    await startEcsService(fakeService(), baseOpts({ streamLogs: true }), runState);

    expect(hoisted.attachCalls.length).toBe(4);
  });
});
