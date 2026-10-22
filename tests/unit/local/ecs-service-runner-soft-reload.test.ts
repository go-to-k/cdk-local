import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { FrontDoorEndpointPool } from '../../../src/local/front-door-pool.js';
import { CloudMapRegistry } from '../../../src/local/cloud-map-registry.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';

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
    // Issue #660 — ordered log of every docker step the soft-reload
    // takes (stop / start / network disconnect + connect / LISTEN
    // probe), so the tests can lock the ORDER, not just the counts.
    ops: [] as string[],
    publishesHostPorts: false,
    listening: true,
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
    // Issue #660 rows: a `noip-` id models a container docker reports no IP for.
    if (containerId.startsWith('noip-')) return undefined;
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
  __setDockerStopImpl,
  __setDockerStartImpl,
  __setDockerNetworkDisconnectImpl,
  __setDockerNetworkConnectImpl,
  __setDockerInspectPublishesHostPortsImpl,
  __setListenProbeImpl,
  __setReloadDrainMs,
  SOFT_RELOAD_COMPLETION_LOG_SUFFIX,
} = await import('../../../src/local/ecs-service-runner.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeService(): any {
  return {
    stack: { stackName: 'AppStack' },
    serviceLogicalId: 'Svc',
    serviceName: 'Svc',
    serviceDisplayName: 'Svc',
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
    // Issue #227 — opt this soft-reload unit out of `docker logs -f`
    // spawning. The streamer's child-process side-effects leak across
    // vitest's parallel workers otherwise. The streamer wiring itself
    // is covered by `ecs-service-runner-stream-logs.test.ts`.
    streamLogs: false,
  };
}

describe('softReloadReplica (Phase 4 of issue #214)', () => {
  beforeEach(() => {
    hoisted.bootCount = 0;
    hoisted.inspectCalls = [];
    hoisted.cpCalls = [];
    hoisted.restartCalls = [];
    hoisted.ops = [];
    hoisted.publishesHostPorts = false;
    hoisted.listening = true;
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
    // A "restart" is now `docker stop` + `docker start`; `restartCalls`
    // records the START, i.e. a completed cycle.
    __setDockerStopImpl(async (id) => {
      hoisted.ops.push(`stop ${id}`);
    });
    __setDockerStartImpl(async (id) => {
      hoisted.ops.push(`start ${id}`);
      hoisted.restartCalls.push(id);
    });
    __setDockerNetworkDisconnectImpl(async (net, id) => {
      hoisted.ops.push(`disconnect ${net} ${id}`);
    });
    __setDockerNetworkConnectImpl(async (net, id, opts) => {
      hoisted.ops.push(`connect ${net} ${id} ip=${opts.ip} aliases=${opts.aliases.join(',')}`);
    });
    __setDockerInspectPublishesHostPortsImpl(async () => hoisted.publishesHostPorts);
    __setListenProbeImpl(async (id) => {
      hoisted.ops.push(`listen ${id}`);
      return hoisted.listening ? { kind: 'listening' } : { kind: 'not-listening' };
    });
  });

  afterEach(() => {
    __setWaitForExitImpl(undefined);
    __setSleepImpl(undefined);
    __setTcpProbeImpl(undefined);
    __setShadowReadyConfig(undefined);
    __setDockerInspectWorkdirImpl(undefined);
    __setDockerCpImpl(undefined);
    __setDockerStopImpl(undefined);
    __setDockerStartImpl(undefined);
    __setDockerNetworkDisconnectImpl(undefined);
    __setDockerNetworkConnectImpl(undefined);
    __setDockerInspectPublishesHostPortsImpl(undefined);
    __setListenProbeImpl(undefined);
    __setReloadDrainMs(undefined);
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
    __setDockerStartImpl(async () => {
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
    ).rejects.toThrow(/docker stop \/ start/);

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

  it('renders a forging container name as one JSON literal in the missing-container error (#761)', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);
    const newService = fakeService();
    newService.task.containers[0].name = "a' b";

    await expect(
      softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService,
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      })
    ).rejects.toThrow(`has no started container named "a' b" (started:`);

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
    ).rejects.toThrow(/no started container named webv2/);

    // No docker work ran — we failed before flipping the flag.
    expect(hoisted.inspectCalls).toEqual([]);

    await controller.shutdown();
  });

  // Phase 4 follow-up (#218 test reviewer S3, S4) — branches inside
  // the `containersToCycle` resolution that the existing test rows
  // don't reach.

  it('falls back to the first container when no container is flagged essential (mirrors the watcher picker)', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);

    // Cook a "new" service whose ONLY container is NOT flagged
    // essential. The primitive should fall back to the first
    // container in template order — same heuristic the watcher's
    // `pickEssentialContainerId` uses.
    const newService = fakeService();
    newService.task.containers[0].essential = false;

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService,
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });

    // The single non-essential container is the one cycled.
    expect(hoisted.inspectCalls.length).toBe(1);
    expect(hoisted.cpCalls.length).toBe(1);
    expect(hoisted.restartCalls.length).toBe(1);

    await controller.shutdown();
  });

  it('throws "no containers to cycle" when the new service has zero containers', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);

    // Cook a "new" service descriptor with an EMPTY containers
    // array. Should never happen in practice (the resolver guards
    // earlier) but the defensive guard inside softReloadReplica
    // needs to be locked so a future refactor doesn't drop it.
    const newService = fakeService();
    newService.task.containers = [];

    await expect(
      softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService,
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      })
    ).rejects.toThrow(/no containers to cycle/);

    // Failed BEFORE the flag flip and BEFORE the docker hooks fired.
    expect(hoisted.inspectCalls).toEqual([]);
    expect(hoisted.cpCalls).toEqual([]);
    expect(hoisted.restartCalls).toEqual([]);

    await controller.shutdown();
  });

  // Phase 4 follow-up (#218 test reviewer S5) — locks the watcher
  // defer behavior at the unit level. The integ multi-replica
  // fixture (2721 samples / FAIL=0) covers the end-to-end zero-
  // refusal contract; this row makes the per-replica state machine
  // verifiable without docker.
  // Phase 4 follow-up (#218 code reviewer Nit #2) — the runner
  // stamps `lastDeployedAssetHash` on the instance after a
  // successful boot AND after a successful soft-reload re-publish.
  // The emulator's classifier-context loader reads this stamp as
  // the `oldAssetHash` baseline so the next reload sees the CURRENT
  // image's hash, not the boot-time descriptor's.
  // Phase 4 follow-up (#218 code reviewer Nit #4) — under docker
  // daemon backpressure, `docker wait` can lag past the soft-
  // reload's flag clear. The `softReloadGeneration` counter catches
  // that case: the watcher snapshots it before waitForExitImpl and
  // detects any mismatch on resume, treating it as a controlled
  // restart even when the flag is already false.
  it('bumps softReloadGeneration once per soft-reload entry (watcher race protection)', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);
    const r0 = controller.runState.replicas[0]!;

    // Boot default: counter is undefined OR 0.
    expect(r0.softReloadGeneration ?? 0).toBe(0);

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeService(),
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });
    expect(r0.softReloadGeneration).toBe(1);

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeService(),
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });
    expect(r0.softReloadGeneration).toBe(2);

    await controller.shutdown();
  });

  it('stamps lastDeployedAssetHash after a successful soft-reload (closes the chatty oldHash loop)', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    // Pre-test: the fakeService() helper declares the essential
    // image as `image: undefined` (no asset metadata) — bootReplica
    // stamps undefined. Cook a service whose container carries a
    // hash so we can prove the stamp lands after a soft-reload.
    const svc = fakeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc.task.containers[0] as any).image = {
      kind: 'cdk-asset',
      assetHash: 'boothash',
    };
    const controller = await startEcsService(svc, opts, runState);
    const r0 = controller.runState.replicas[0]!;
    // Boot stamp lands.
    expect(r0.lastDeployedAssetHash).toBe('boothash');

    const newSvc = fakeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (newSvc.task.containers[0] as any).image = {
      kind: 'cdk-asset',
      assetHash: 'newhash-after-reload',
    };

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: newSvc,
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });

    // Post-soft-reload stamp updated.
    expect(r0.lastDeployedAssetHash).toBe('newhash-after-reload');

    await controller.shutdown();
  });

  it('stamps lastDeployedAssetHash = undefined when the new image is not a CDK asset', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const svc = fakeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc.task.containers[0] as any).image = {
      kind: 'cdk-asset',
      assetHash: 'boothash',
    };
    const controller = await startEcsService(svc, opts, runState);
    const r0 = controller.runState.replicas[0]!;
    expect(r0.lastDeployedAssetHash).toBe('boothash');

    const newSvc = fakeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (newSvc.task.containers[0] as any).image = {
      kind: 'ecr',
      uri: 'public.ecr.aws/foo:bar',
    };

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: newSvc,
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });

    // Non-CDK-asset image → stamp cleared to undefined; the loader
    // will fall back to the boot-time descriptor (and the
    // classifier will route subsequent reloads to rebuild because
    // there's no asset to soft-reload anyway).
    expect(r0.lastDeployedAssetHash).toBeUndefined();

    await controller.shutdown();
  });

  // Phase 4 follow-up (#218 test reviewer N4) — exported constant
  // for the integ scripts' grep target. The runner's emit MUST stay
  // bound to this constant; the constant itself MUST stay bound to
  // the grep regex in `tests/integration/local-start-service-watch-fast/verify.sh`
  // and the path-agnostic regex in the watch-multi / alb-watch
  // fixtures. A wording change in the runner that doesn't update the
  // constant trips this row.
  it('exposes SOFT_RELOAD_COMPLETION_LOG_SUFFIX matching the integ-script grep contract', () => {
    expect(SOFT_RELOAD_COMPLETION_LOG_SUFFIX).toBe(
      'restart + TCP-ready probe complete; Cloud Map + front-door re-published.'
    );
    // The integ scripts grep for this fragment as a regex
    // (`Soft-reloaded replica .*restart \+ TCP-ready probe complete`);
    // confirm the constant CONTAINS that fragment so a future tweak
    // to the constant (e.g. dropping the semicolon) doesn't silently
    // break the integ regex.
    expect(SOFT_RELOAD_COMPLETION_LOG_SUFFIX).toMatch(
      /^restart \+ TCP-ready probe complete/
    );
  });

  it('sets softReloadInProgress BEFORE docker cp and clears it AFTER the re-publish (watcher-defer contract)', async () => {
    const observed: Array<{
      step: 'inspect' | 'cp' | 'restart';
      flag: boolean;
    }> = [];
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = fakeOptions(pool, registry) as any;
    const controller = await startEcsService(fakeService(), opts, runState);
    const r0 = controller.runState.replicas[0]!;

    // Re-install spies that capture the flag value at each step.
    __setDockerInspectWorkdirImpl(async () => {
      observed.push({ step: 'inspect', flag: !!r0.softReloadInProgress });
      return '/app';
    });
    __setDockerCpImpl(async () => {
      observed.push({ step: 'cp', flag: !!r0.softReloadInProgress });
    });
    __setDockerStartImpl(async () => {
      observed.push({ step: 'restart', flag: !!r0.softReloadInProgress });
    });

    expect(r0.softReloadInProgress).toBeFalsy(); // initial state

    await softReloadReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeService(),
      sourceDirToCopy: '/tmp/cdk.out/asset.h',
    });

    // The watcher's defer-loop polls this flag every 100ms. It MUST
    // be true throughout the cp + restart window — otherwise a SIGTERM
    // unblocking `docker wait` mid-window would fall through to the
    // restart-on-exit branch and race against the in-flight restart.
    expect(observed).toEqual([
      { step: 'inspect', flag: true },
      { step: 'cp', flag: true },
      { step: 'restart', flag: true },
    ]);
    // And cleared on completion so the watcher's NEXT iteration can
    // re-arm waitForExitImpl on the restarted container.
    expect(r0.softReloadInProgress).toBe(false);

    await controller.shutdown();
  });

  // Issue #660 — the registry drain never reached Docker's embedded
  // DNS, so a Service Connect peer kept resolving the replica's alias
  // to an app that had already exited (`Connection refused`). These rows
  // lock the shared-network detach / re-attach ORDER around the cycle.
  describe('shared-network alias drain (issue #660)', () => {
    async function bootAndReload(mutate?: (r0: any) => void): Promise<{
      cid: string;
      net: string;
      ip: string;
      controller: Awaited<ReturnType<typeof startEcsService>>;
    }> {
      const pool = new FrontDoorEndpointPool();
      const registry = new CloudMapRegistry();
      const runState = createServiceRunState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = fakeOptions(pool, registry) as any;
      const controller = await startEcsService(fakeService(), opts, runState);
      const r0 = controller.runState.replicas[0]!;
      mutate?.(r0);
      const cid = r0.state.startedContainers[0]!.id;
      const net = r0.state.network!.networkName;
      // Independent of the mock: the docker-inspect mock maps cid-<n> to 172.20.0.<10+n>.
      const ip = `172.20.0.${10 + Number(cid.slice('cid-'.length))}`;
      return { cid, net, ip, controller };
    }

    it('detaches BEFORE the stop, re-attaches by IP only while stopped, and restores the aliases only AFTER the LISTEN probe passes', async () => {
      const { cid, net, ip, controller } = await bootAndReload();
      await softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      });
      expect(hoisted.ops).toEqual([
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=`, // #813 drain: IP only, still running
        `stop ${cid}`,
        `start ${cid}`,
        `listen ${cid}`, // the replica probe
        `listen ${cid}`, // this container's own port, gating its aliases
        `disconnect ${net} ${cid}`,
        // container-name alias + the Service Connect discoveryName + fqdn
        `connect ${net} ${cid} ip=${ip} aliases=web,svc,svc.cdkl.local`,
      ]);
      await controller.shutdown();
    });

    // Issue #813 — between the alias withdrawal and the stop, the old app
    // keeps serving on its IP for a bounded drain, so a request already
    // aimed at that IP is answered instead of hanging until it times out.
    it('drains: IP-only re-attach of the still-running old app, then the drain wait, then the stop', async () => {
      __setReloadDrainMs(1234);
      __setSleepImpl(async (ms) => {
        hoisted.ops.push(`sleep ${ms}`);
      });
      const { cid, net, ip, controller } = await bootAndReload();
      await softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      });
      expect(hoisted.ops.slice(0, 4)).toEqual([
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=`,
        'sleep 1234',
        `stop ${cid}`,
      ]);
      await controller.shutdown();
    });

    it('skips the drain wait and attaches while stopped when the drain re-attach fails', async () => {
      __setReloadDrainMs(1234);
      __setSleepImpl(async (ms) => {
        hoisted.ops.push(`sleep ${ms}`);
      });
      let connects = 0;
      __setDockerNetworkConnectImpl(async (net, id, opts) => {
        connects += 1;
        hoisted.ops.push(`connect ${net} ${id} ip=${opts.ip} aliases=${opts.aliases.join(',')}`);
        if (connects === 1) throw new Error('synthetic drain re-attach failure');
      });
      const { cid, net, ip, controller } = await bootAndReload();
      await softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      });
      expect(hoisted.ops.slice(0, 5)).toEqual([
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=`, // fails: no drain wait
        `stop ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=`, // attached while stopped, as before #813
        `start ${cid}`,
      ]);
      await controller.shutdown();
    });

    it('re-attaches a host-port publisher WITH its aliases while stopped (a running re-attach drops its ports)', async () => {
      hoisted.publishesHostPorts = true;
      const { cid, net, ip, controller } = await bootAndReload();
      await softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      });
      expect(hoisted.ops).toEqual([
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=`, // #813 drain
        `stop ${cid}`,
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=web,svc,svc.cdkl.local`,
        `start ${cid}`,
        `listen ${cid}`,
      ]);
      await controller.shutdown();
    });

    it('leaves a container on a non-shared network in place (no disconnect / connect)', async () => {
      const { cid, controller } = await bootAndReload((r0) => {
        r0.state.network.ownedByCaller = false;
      });
      await softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      });
      expect(hoisted.ops).toEqual([`stop ${cid}`, `start ${cid}`, `listen ${cid}`]);
      await controller.shutdown();
    });

    it('cycles in place when the detach fails (never connects a container it did not detach)', async () => {
      __setDockerNetworkDisconnectImpl(async () => {
        throw new Error('synthetic disconnect failure');
      });
      const { cid, controller } = await bootAndReload();
      await softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      });
      expect(hoisted.ops).toEqual([`stop ${cid}`, `start ${cid}`, `listen ${cid}`]);
      await controller.shutdown();
    });

    it('never detaches a container whose docker cp failed (it keeps running, ports and aliases intact)', async () => {
      hoisted.failCpOnCount = 1;
      const { controller } = await bootAndReload();
      await expect(
        softReloadReplica({
          controller,
          oldReplicaIndex: 0,
          newService: fakeService(),
          sourceDirToCopy: '/tmp/cdk.out/asset.h',
        })
      ).rejects.toThrow(/docker cp/);
      expect(hoisted.ops).toEqual([]);
      await controller.shutdown();
    });

    it('treats an unreadable port-publish state as a publisher (aliases while stopped, never a running re-attach)', async () => {
      __setDockerInspectPublishesHostPortsImpl(async () => {
        throw new Error('synthetic inspect failure');
      });
      const { cid, net, ip, controller } = await bootAndReload();
      await softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      });
      expect(hoisted.ops).toEqual([
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=`, // #813 drain
        `stop ${cid}`,
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=web,svc,svc.cdkl.local`,
        `start ${cid}`,
        `listen ${cid}`,
      ]);
      await controller.shutdown();
    });

    it('cycles in place when docker reports no IP for the container', async () => {
      const { cid, controller } = await bootAndReload((r0) => {
        r0.state.startedContainers[0].id = 'noip-1';
      });
      expect(cid).toBe('noip-1');
      await softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeService(),
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      });
      expect(hoisted.ops).toEqual([`stop ${cid}`, `start ${cid}`, `listen ${cid}`]);
      await controller.shutdown();
    });

    it('throws when restoring the aliases fails after the probe, and retries the restore in the catch', async () => {
      let disconnects = 0;
      __setDockerNetworkDisconnectImpl(async (net, id) => {
        hoisted.ops.push(`disconnect ${net} ${id}`);
        disconnects += 1;
        if (disconnects >= 2) throw new Error('synthetic disconnect failure');
      });
      const { cid, net, ip, controller } = await bootAndReload();
      await expect(
        softReloadReplica({
          controller,
          oldReplicaIndex: 0,
          newService: fakeService(),
          sourceDirToCopy: '/tmp/cdk.out/asset.h',
        })
      ).rejects.toThrow(/restoring the network aliases/);
      expect(hoisted.ops).toEqual([
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=`, // #813 drain
        `stop ${cid}`,
        `start ${cid}`,
        `listen ${cid}`,
        `listen ${cid}`,
        `disconnect ${net} ${cid}`, // post-probe restore: fails
        `disconnect ${net} ${cid}`, // catch: still attached IP-only, so detach again (fails, swallowed)
      ]);
      expect(controller.runState.replicas[0]!.softReloadInProgress).toBe(false);
      await controller.shutdown();
    });

    it('falls back to a connect WITHOUT --ip when the old IP cannot be re-taken', async () => {
      __setDockerNetworkConnectImpl(async (net, id, opts) => {
        hoisted.ops.push(`connect ${net} ${id} ip=${opts.ip} aliases=${opts.aliases.join(',')}`);
        if (opts.aliases.length > 0 && opts.ip !== undefined) {
          throw new Error('Address already in use');
        }
      });
      const { cid, net, ip, controller } = await bootAndReload();
      await expect(
        softReloadReplica({
          controller,
          oldReplicaIndex: 0,
          newService: fakeService(),
          sourceDirToCopy: '/tmp/cdk.out/asset.h',
        })
      ).rejects.toThrow(/restoring the network aliases/);
      expect(hoisted.ops.slice(-2)).toEqual([
        `connect ${net} ${cid} ip=${ip} aliases=web,svc,svc.cdkl.local`, // catch: same IP fails again
        `connect ${net} ${cid} ip=undefined aliases=web,svc,svc.cdkl.local`, // any IP beats none
      ]);
      await controller.shutdown();
    });

    it('waits for EACH IP-only container own port before giving its aliases back', async () => {
      const listenAnswers = new Map<string, boolean[]>();
      __setListenProbeImpl(async (id, port) => {
        hoisted.ops.push(`listen ${id}:${port}`);
        const queue = listenAnswers.get(id);
        return queue && queue.length > 0 && !queue.shift()
          ? { kind: 'not-listening' }
          : { kind: 'listening' };
      });
      const { cid, net, controller } = await bootAndReload((r0) => {
        r0.state.startedContainers.push({ name: 'sidecar', id: `${r0.state.startedContainers[0].id}-sidecar` });
      });
      const side = `${cid}-sidecar`;
      listenAnswers.set(side, [false, false]); // two misses, then listening
      const newSvc = fakeService();
      newSvc.task.containers.push({
        name: 'sidecar',
        essential: true,
        portMappings: [{ containerPort: 9000 }],
      });
      __setShadowReadyConfig({ timeoutMs: 5_000, intervalMs: 1 });
      await softReloadReplica({
        controller,
        oldReplicaIndex: 0,
        newService: newSvc,
        sourceDirToCopy: '/tmp/cdk.out/asset.h',
      });
      const sideRestore = hoisted.ops.findIndex((o) =>
        o.startsWith(`connect ${net} ${side} `) && !o.endsWith('aliases=')
      );
      const lastSideListen = hoisted.ops.lastIndexOf(`listen ${side}:9000`);
      expect(hoisted.ops.filter((o) => o === `listen ${side}:9000`)).toHaveLength(3);
      expect(sideRestore).toBeGreaterThan(lastSideListen);
      await controller.shutdown();
    });

    it('re-attaches WITH aliases when the start fails after an IP-only re-attach', async () => {
      __setDockerStartImpl(async (id) => {
        hoisted.ops.push(`start ${id}`);
        throw new Error('synthetic start failure');
      });
      const { cid, net, ip, controller } = await bootAndReload();
      await expect(
        softReloadReplica({
          controller,
          oldReplicaIndex: 0,
          newService: fakeService(),
          sourceDirToCopy: '/tmp/cdk.out/asset.h',
        })
      ).rejects.toThrow(/docker stop \/ start/);
      expect(hoisted.ops).toEqual([
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=`, // #813 drain
        `stop ${cid}`,
        `start ${cid}`,
        `disconnect ${net} ${cid}`,
        `connect ${net} ${cid} ip=${ip} aliases=web,svc,svc.cdkl.local`,
      ]);
      await controller.shutdown();
    });
  });

  // Issue #660 — the completion line used to claim
  // "restart + TCP-ready probe complete" even after the probe timed out.
  describe('completion line reflects the probe outcome (issue #660)', () => {
    async function reloadAndCollectInfo(): Promise<string[]> {
      const infoSpy = vi.spyOn(ConsoleLogger.prototype, 'info').mockImplementation(() => {});
      try {
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
        await controller.shutdown();
        return infoSpy.mock.calls.map((c) => String(c[0]));
      } finally {
        infoSpy.mockRestore();
      }
    }

    it('names the passed probe only when the LISTEN check passed', async () => {
      const lines = await reloadAndCollectInfo();
      const done = lines.filter((l) => l.startsWith('Soft-reloaded replica r0'));
      expect(done).toEqual([`Soft-reloaded replica r0 (gen 0): ${SOFT_RELOAD_COMPLETION_LOG_SUFFIX}`]);
    });

    it('says the probe timed out — never the success suffix — when it never passed', async () => {
      hoisted.listening = false;
      const lines = await reloadAndCollectInfo();
      const done = lines.filter((l) => l.startsWith('Soft-reloaded replica r0'));
      expect(done).toEqual([
        'Soft-reloaded replica r0 (gen 0): restarted, but the TCP-ready probe timed out; ' +
          'Cloud Map + front-door re-published anyway.',
      ]);
      // The integ fixtures grep this regex to count PASSED probes.
      expect(done.some((l) => /Soft-reloaded replica .*restart \+ TCP-ready probe complete/.test(l))).toBe(
        false
      );
    });
  });
});
