import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { FrontDoorEndpointPool } from '../../../src/local/front-door-pool.js';
import { CloudMapRegistry } from '../../../src/local/cloud-map-registry.js';

/**
 * Phase 4 of issue #214 — locks `softReloadReplica` semantics (the
 * `cdkl start-service --watch` / `cdkl start-alb --watch` bind-mount
 * fast path). Mocks the docker boundary (ecs-task-runner +
 * docker-inspect + the cp/restart/inspect-workdir test hooks) so no
 * real container is needed.
 *
 * Invariants this test locks:
 *   - The replica's docker network IP + host-port publish are
 *     PRESERVED across the soft-reload (the container ID is stable;
 *     `docker restart` doesn't change them).
 *   - Cloud Map handles + front-door pool entry are DRAINED before
 *     `docker restart` (so peers / front-door don't route to the
 *     SIGTERM'd container during the restart window) and RE-PUBLISHED
 *     under the same per-replica owner key after the TCP-ready probe
 *     confirms the new app is binding. End-state pool / Cloud Map
 *     sizes match pre-state — the round-trip is a no-op at the
 *     contract level, but the drain-then-republish shape is what
 *     preserves the multi-replica zero-connection-refusal guarantee
 *     Phase 2/3 makes.
 *   - Each essential container gets `docker inspect` → `docker cp`
 *     (with the trailing `/.` source convention) → `docker restart`,
 *     in that order.
 *   - `instance.softReloadInProgress` is set BEFORE `docker restart`
 *     and cleared AFTER the re-register step, so the watcher's
 *     post-exit branch defers to the in-flight restart.
 *   - A throw inside the cp/restart sequence clears the flag (via
 *     the `finally`) so the watcher is never wedged.
 *   - An empty / unset WORKDIR falls back to `/`, matching Docker's
 *     runtime default.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    bootCount: 0,
    inspectCalls: [] as string[],
    cpCalls: [] as Array<{ src: string; dst: string }>,
    restartCalls: [] as string[],
    workdir: '/app',
    failCpOnCount: -1, // -1 = never fail
  },
}));

vi.mock('../../../src/local/ecs-task-runner.js', () => ({
  createEcsRunState: () => ({
    network: undefined,
    dockerVolumeNames: [],
    startedContainers: [],
    logStoppers: [],
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
  // Container-ID-aware so a soft-reload's re-publish (which inspects
  // the SAME container ID after `docker restart`) gets the SAME IP it
  // had at initial boot — mirroring docker's preservation of the
  // container's network namespace across a restart.
  getContainerNetworkIp: async (containerId: string) => {
    const m = /^cid-(\d+)$/.exec(containerId);
    return m ? `172.20.0.${10 + parseInt(m[1]!, 10)}` : `172.20.0.99`;
  },
  // Same shape: container-ID-aware so the re-publish round-trip
  // returns the SAME host port the initial boot allocated.
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
      ],
      warnings: [],
    },
    loadBalancers: [],
    serviceConnect: {
      namespaceName: 'cdkl.local',
      services: [
        {
          discoveryName: 'svc',
          portName: 'web-port',
          containerPort: 80,
          clientAliases: [],
        },
      ],
    },
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
  };
}

describe('softReloadReplica (Phase 4 of issue #214)', () => {
  beforeEach(() => {
    hoisted.bootCount = 0;
    hoisted.inspectCalls = [];
    hoisted.cpCalls = [];
    hoisted.restartCalls = [];
    hoisted.workdir = '/app';
    hoisted.failCpOnCount = -1;
    __setSleepImpl(() => Promise.resolve());
    __setWaitForExitImpl(() => new Promise<number>(() => {}));
    __setTcpProbeImpl(() => Promise.resolve());
    __setShadowReadyConfig({ timeoutMs: 50, intervalMs: 5 });
    __setDockerInspectWorkdirImpl(async (id) => {
      hoisted.inspectCalls.push(id);
      return hoisted.workdir;
    });
    __setDockerCpImpl(async (src, dst) => {
      hoisted.cpCalls.push({ src, dst });
      if (hoisted.failCpOnCount === hoisted.cpCalls.length) {
        throw new Error(`synthetic cp failure on call #${hoisted.cpCalls.length}`);
      }
    });
    __setDockerRestartImpl(async (id) => {
      hoisted.restartCalls.push(id);
    });
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

  it('inspects → cp → restart → TCP-probe; drains then re-publishes pool + Cloud Map under the same owner key', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);

    expect(controller.runState.replicas.length).toBe(2);
    const poolBefore = pool.size();
    const cmBefore = registry.lookup('cdkl.local', 'svc')?.length ?? 0;
    expect(poolBefore).toBe(2);
    expect(cmBefore).toBe(2);

    const r0 = controller.runState.replicas[0]!;
    const r0CidBefore = r0.state.startedContainers[0]!.id;
    const r0CloudMapKeyBefore = r0.cloudMapHandles[0]?.ownerKey;
    const r0FrontDoorKeyBefore = r0.frontDoorOwnerKey;
    // Snapshot the front-door pool entries by host:port too — after
    // the drain+re-register round trip the (host, port) for r0 must
    // still be the SAME, because docker preserves the container's
    // ephemeral host port across `docker restart`. The
    // container-ID-aware `getPublishedHostPort` mock returns the
    // SAME port for the SAME cid, so this assertion locks the
    // production contract.
    const poolEntriesBefore = pool.list().map((e) => `${e.host}:${e.port}`).sort();

    // Soft-reload replica 0.
    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeService(),
      sourceDirToCopy: '/tmp/cdk.out/asset.newhash',
    });

    // The sequence ran in order: inspect → cp → restart.
    expect(hoisted.inspectCalls).toEqual([r0CidBefore]);
    expect(hoisted.cpCalls).toEqual([
      { src: '/tmp/cdk.out/asset.newhash/.', dst: `${r0CidBefore}:/app/` },
    ]);
    expect(hoisted.restartCalls).toEqual([r0CidBefore]);

    // The replica is the SAME instance (no shadow boot). bootCount
    // stayed at 2 (the initial boot of the 2 replicas).
    expect(hoisted.bootCount).toBe(2);
    expect(controller.runState.replicas.length).toBe(2);
    expect(controller.runState.replicas[0]).toBe(r0); // reference identity preserved
    expect(r0.state.startedContainers[0]!.id).toBe(r0CidBefore);

    // End-state pool + Cloud Map sizes match pre-state (the drain
    // is mid-flight; the re-register restores). Owner keys match
    // because the soft-reload doesn't bump generation.
    expect(pool.size()).toBe(poolBefore);
    expect(registry.lookup('cdkl.local', 'svc')?.length).toBe(cmBefore);
    expect(r0.cloudMapHandles[0]?.ownerKey).toBe(r0CloudMapKeyBefore);
    expect(r0.frontDoorOwnerKey).toBe(r0FrontDoorKeyBefore);
    // The (host, port) endpoints in the pool match pre-state too —
    // docker preserves them across `docker restart`, and the
    // re-register uses the SAME container's inspect result.
    expect(pool.list().map((e) => `${e.host}:${e.port}`).sort()).toEqual(poolEntriesBefore);

    // Flag cleared on the way out.
    expect(r0.softReloadInProgress).toBe(false);

    await controller.shutdown();
  });

  it('falls back to "/" when the image declares no WORKDIR (Dockerfile without WORKDIR)', async () => {
    hoisted.workdir = ''; // matches docker inspect's empty-string output
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeService(),
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });

    // Dest path falls back to "/" when WORKDIR is empty (no
    // double-slash: the normalizer trims trailing slash before
    // appending one).
    expect(hoisted.cpCalls[0]?.dst).toMatch(/:\/$/);
    expect(hoisted.cpCalls[0]?.dst).not.toContain('//');

    await controller.shutdown();
  });

  it('clears softReloadInProgress in a finally on docker cp failure', async () => {
    hoisted.failCpOnCount = 1; // first (and only) cp call fails
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);
    const r0 = controller.runState.replicas[0]!;

    await expect(
      softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      })
    ).rejects.toThrow(/docker cp/);

    // Flag must be cleared even though we threw — otherwise the
    // watcher's defer-loop is wedged forever and restart-on-exit is
    // dead for the rest of the replica's life.
    expect(r0.softReloadInProgress).toBe(false);
    // Drain ran before the cp failure; the replica's Cloud Map +
    // front-door pool entry are intentionally NOT re-published on
    // an aborted soft-reload (the container is in an inconsistent
    // state — new bytes on disk, but PID 1 never restarted). Peers
    // + the front-door stop routing here until the next save.
    expect(r0.cloudMapHandles.length).toBe(0);
    expect(pool.size()).toBe(1); // only the SURVIVING r1 entry remains

    await controller.shutdown();
  });

  it('clears softReloadInProgress + leaves replica drained on docker inspect failure', async () => {
    __setDockerInspectWorkdirImpl(async () => {
      throw new Error('synthetic inspect failure');
    });
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);
    const r0 = controller.runState.replicas[0]!;

    await expect(
      softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      })
    ).rejects.toThrow(/docker inspect/);

    // Inspect ran first inside the for loop — but never cp / restart.
    expect(hoisted.cpCalls).toEqual([]);
    expect(hoisted.restartCalls).toEqual([]);
    expect(r0.softReloadInProgress).toBe(false);
    // Drain ran before the for loop (per the primitive's zero-refusal
    // contract); the replica stays drained because the soft-reload
    // never reached re-publish.
    expect(r0.cloudMapHandles.length).toBe(0);
    expect(pool.size()).toBe(1);

    await controller.shutdown();
  });

  it('clears softReloadInProgress + leaves replica drained on docker restart failure (cp landed but restart did not)', async () => {
    __setDockerRestartImpl(async () => {
      throw new Error('synthetic restart failure');
    });
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);
    const r0 = controller.runState.replicas[0]!;

    await expect(
      softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      })
    ).rejects.toThrow(/docker restart/);

    // cp succeeded, restart failed — partial-success state.
    expect(hoisted.cpCalls.length).toBe(1);
    // The override impl threw before recording into hoisted.restartCalls,
    // so the counter stays at 0 — what matters is that the throw
    // surfaced as the rejected promise above.
    expect(hoisted.restartCalls.length).toBe(0);
    expect(r0.softReloadInProgress).toBe(false);
    // The replica is drained AND its PID 1 was never restarted — the
    // container has new source on disk but the old process is still
    // running it. Re-publish is intentionally NOT done; peers stop
    // routing here until a clean save recovers.
    expect(r0.cloudMapHandles.length).toBe(0);
    expect(pool.size()).toBe(1);

    await controller.shutdown();
  });

  it('cycles every essential container in a multi-essential task (one inspect + cp + restart per essential)', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);

    // Cook a "new" service with TWO essential containers, both
    // already present in the replica's started-set (the runner mock
    // populates 'web' at startEcsService time; we extend the started
    // set with a synthetic second container for this test).
    const r0 = controller.runState.replicas[0]!;
    r0.state.startedContainers.push({ name: 'sidecar', id: `${r0.state.startedContainers[0]!.id}-sidecar` });
    const newSvc = fakeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (newSvc as any).task.containers.push({
      name: 'sidecar',
      essential: true,
      portMappings: [],
    });

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: newSvc,
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });

    // One inspect + cp + restart PER essential.
    expect(hoisted.inspectCalls.length).toBe(2);
    expect(hoisted.cpCalls.length).toBe(2);
    expect(hoisted.restartCalls.length).toBe(2);
    expect(r0.softReloadInProgress).toBe(false);

    await controller.shutdown();
  });

  it('throws (no flag set, no docker calls) when the replica index is out of range', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);

    await expect(
      softReloadReplica({
        controller,
        oldReplicaIndex: 99,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      })
    ).rejects.toThrow(/no replica at index 99/);

    // No docker work ran.
    expect(hoisted.inspectCalls).toEqual([]);
    expect(hoisted.cpCalls).toEqual([]);
    expect(hoisted.restartCalls).toEqual([]);

    await controller.shutdown();
  });

  it('skips a shutting-down replica with a warn (does not throw, does not docker)', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);
    controller.runState.replicas[0]!.shuttingDown = true;

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeService(),
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });

    expect(hoisted.inspectCalls).toEqual([]);
    expect(hoisted.cpCalls).toEqual([]);
    expect(hoisted.restartCalls).toEqual([]);

    await controller.shutdown();
  });

  it('throws when the resolved service has a container name not present in the replica state', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);

    // Cook a "new" service whose essential container is named
    // 'webv2' — not present in the replica's started containers.
    const newService = fakeService();
    newService.task.containers[0].name = 'webv2';

    await expect(
      softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService,
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      })
    ).rejects.toThrow(/no started container named 'webv2'/);

    // No docker work ran — we failed before flipping the flag.
    expect(hoisted.inspectCalls).toEqual([]);

    await controller.shutdown();
  });
});
