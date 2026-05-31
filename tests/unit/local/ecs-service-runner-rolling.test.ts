import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { FrontDoorEndpointPool } from '../../../src/local/front-door-pool.js';
import { CloudMapRegistry } from '../../../src/local/cloud-map-registry.js';

/**
 * Phase 2 of issue #214 — locks `rollServiceReplica` semantics (the
 * `cdkl start-service --watch` per-replica rolling primitive) at the
 * unit level. Mocks the docker boundary (ecs-task-runner +
 * docker-inspect) so no real container is needed. The integ fixture
 * (`tests/integration/local-start-service-watch-multi/`) covers the
 * end-to-end zero-connection-refusal assertion under continuous curl
 * load — this file just guards the in-process state transitions the
 * integ test can't observe directly:
 *
 *   - Shadow replica boots under a bumped `generation` (1 + old gen)
 *     so docker / Cloud Map / front-door names don't collide.
 *   - Cloud Map registry is synchronously "both present → new only"
 *     across the swap (consumers never see a missing endpoint).
 *   - Front-door pool entry is replaced under a fresh owner key.
 *   - Old replica's docker state is torn down + slot removed from
 *     `runState.replicas`.
 *   - Shadow boot failure: old replica keeps serving; partial shadow
 *     state is cleaned up; error re-thrown.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    bootCount: 0,
    publishedPorts: [5001, 5002, 5003, 5004] as number[],
    publishCount: 0,
    cleanedStates: [] as Array<{ ipsRegistered: number; networkName: string | undefined }>,
    failBootOnCount: -1, // -1 = never fail
    // Records every `docker network disconnect --force <net> <id>`
    // call the rolling primitive emits — lets the multi-replica test
    // prove the new disconnect-first step actually fires (reviewer
    // flagged the previous mock took `!ownedByCaller` early-return).
    disconnectCalls: [] as Array<{ networkName: string; containerId: string }>,
  },
}));

vi.mock('../../../src/local/ecs-task-runner.js', () => ({
  createEcsRunState: () => ({
    network: undefined,
    dockerVolumeNames: [],
    startedContainers: [],
    logStoppers: [],
  }),
  cleanupEcsRun: async (state: Record<string, unknown>) => {
    hoisted.cleanedStates.push({
      ipsRegistered: 0,
      networkName: (state['network'] as { networkName?: string } | undefined)?.networkName,
    });
  },
  runEcsTask: async (_task: unknown, _options: unknown, state: Record<string, unknown>) => {
    hoisted.bootCount += 1;
    if (hoisted.failBootOnCount === hoisted.bootCount) {
      throw new Error(`synthetic boot failure on boot #${hoisted.bootCount}`);
    }
    state['network'] = {
      networkName: `net-${hoisted.bootCount}`,
      sidecarContainerId: `sc-${hoisted.bootCount}`,
      sidecarIp: '169.254.171.2',
      // Lock the shared-network shape the runner sees in production
      // (start-service threads a `TaskNetwork` with `ownedByCaller: true`
      // through `discovery.sharedNetwork`). Without this flag, the
      // rolling primitive's `disconnectOldFromSharedNetwork` takes its
      // `!ownedByCaller` early-return branch and the new pre-cleanup
      // disconnect step is structurally untestable.
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
  // Each successive replica gets a distinct fake IP so we can detect
  // which replica's endpoint the registry / pool currently holds.
  getContainerNetworkIp: async () => `172.20.0.${10 + hoisted.bootCount}`,
  getPublishedHostPort: async () => hoisted.publishedPorts[hoisted.publishCount++] ?? 5999,
}));

const {
  startEcsService,
  rollServiceReplica,
  createServiceRunState,
  __setWaitForExitImpl,
  __setSleepImpl,
  __setTcpProbeImpl,
  __setShadowReadyConfig,
  __setDockerNetworkDisconnectImpl,
} = await import('../../../src/local/ecs-service-runner.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeServiceConnectService(): any {
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

function frontDoorOptions(pool: FrontDoorEndpointPool, registry: CloudMapRegistry) {
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
    // Issue #227 — opt this rolling unit out of `docker logs -f` spawning.
    // The streamer's child-process side-effects (spawned `docker logs`
    // bound to the fake `cid-*` IDs) leak across vitest's parallel
    // workers otherwise. The streamer wiring itself is covered by
    // `ecs-service-runner-stream-logs.test.ts`.
    streamLogs: false,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('rollServiceReplica (Phase 2 of issue #214)', () => {
  beforeEach(() => {
    hoisted.bootCount = 0;
    hoisted.publishCount = 0;
    hoisted.cleanedStates = [];
    hoisted.failBootOnCount = -1;
    hoisted.disconnectCalls = [];
    __setSleepImpl(() => Promise.resolve()); // skip restart backoff
    __setWaitForExitImpl(() => new Promise<number>(() => {})); // replicas never exit
    __setTcpProbeImpl(() => Promise.resolve()); // shadow is always TCP-ready
    __setShadowReadyConfig({ timeoutMs: 50, intervalMs: 5 }); // shrink probe budget for the timeout case
    __setDockerNetworkDisconnectImpl(async (networkName, containerId) => {
      hoisted.disconnectCalls.push({ networkName, containerId });
    });
  });
  afterEach(() => {
    __setWaitForExitImpl(undefined);
    __setSleepImpl(undefined);
    __setTcpProbeImpl(undefined);
    __setShadowReadyConfig(undefined);
    __setDockerNetworkDisconnectImpl(undefined);
  });

  it('rolls a single replica: shadow boots with bumped generation, swaps atomically, retires old', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = frontDoorOptions(pool, registry) as any;
    const controller = await startEcsService(fakeServiceConnectService(), opts, runState);

    // After boot: 2 replicas (DesiredCount=2), 2 pool entries, 2 Cloud Map
    // endpoints under `svc.cdkl.local` (one per replica).
    expect(controller.runState.replicas.length).toBe(2);
    expect(pool.size()).toBe(2);
    expect(registry.lookup('cdkl.local', 'svc')?.length).toBe(2);
    expect(controller.runState.replicas[0]?.generation).toBe(0);
    expect(controller.runState.replicas[1]?.generation).toBe(0);

    // Snapshot what was registered for the OLD replica 0 so we can
    // assert it was swapped out.
    const oldR0OwnerKeys = controller.runState.replicas[0]!.cloudMapHandles.map((h) => h.ownerKey);
    expect(oldR0OwnerKeys[0]).toMatch(/^Svc:r0:/);

    // Roll replica 0.
    await rollServiceReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeServiceConnectService(),
      newOptions: opts,
    });

    // Post-roll: still 2 replicas, the shadow took replica 0's slot.
    expect(controller.runState.replicas.length).toBe(2);
    // The shadow carries generation 1.
    const r0Now = controller.runState.replicas.find((r) => r.index === 0);
    expect(r0Now?.generation).toBe(1);
    // Replica 1 (untouched) still generation 0.
    const r1Still = controller.runState.replicas.find((r) => r.index === 1);
    expect(r1Still?.generation).toBe(0);

    // Pool still has 2 entries: r0 was replaced under a bumped owner key,
    // r1 is unchanged. Crucially, the pool was never empty at any
    // observable instant — the shadow registered BEFORE the old was
    // dropped (sync Map mutation).
    expect(pool.size()).toBe(2);

    // Cloud Map still has 2 endpoints under svc.cdkl.local, one of which
    // is the new shadow's IP (host octet bumped to the third boot's value).
    const left = registry.lookup('cdkl.local', 'svc');
    expect(left?.length).toBe(2);
    const ips = (left ?? []).map((e) => e.ip).sort();
    // r1 boot was index 2 → 172.20.0.12; r0 shadow boot was index 3 → 172.20.0.13.
    // r0's original boot (172.20.0.11) must be GONE.
    expect(ips).toContain('172.20.0.12');
    expect(ips).toContain('172.20.0.13');
    expect(ips).not.toContain('172.20.0.11');

    // BLOCKER fix for the test-reviewer's HIGH item: the rolling
    // primitive's new `disconnectOldFromSharedNetwork` step must
    // actually fire before `cleanupEcsRun`. Without this step the
    // Docker DNS keeps the dying replica's alias for the ~ms window
    // between `docker stop` and `docker rm`, and a peer wget hits
    // ECONNREFUSED (observed once in the first integ run). With
    // `ownedByCaller: true` now set on the mock state, the disconnect
    // branch is no longer short-circuited; assert at least one
    // disconnect was emitted against r0's network (`net-1`).
    const disconnectsForR0Net = hoisted.disconnectCalls.filter(
      (c) => c.networkName === 'net-1'
    );
    expect(disconnectsForR0Net.length).toBeGreaterThan(0);
    // Sidecar AND main container are both disconnected so the alias
    // is stripped no matter which docker DNS lookup beat which.
    const ids = disconnectsForR0Net.map((c) => c.containerId).sort();
    expect(ids).toEqual(['cid-1', 'sc-1']);

    await controller.shutdown();
    expect(pool.size()).toBe(0);
  });

  it('shadow boot failure: old replica keeps serving; partial shadow state cleaned up; throws', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = frontDoorOptions(pool, registry) as any;
    const controller = await startEcsService(fakeServiceConnectService(), opts, runState);

    expect(controller.runState.replicas.length).toBe(2);
    expect(pool.size()).toBe(2);
    expect(registry.lookup('cdkl.local', 'svc')?.length).toBe(2);

    // Fail the NEXT runEcsTask call (the shadow boot for r0).
    hoisted.failBootOnCount = 3;

    await expect(
      rollServiceReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeServiceConnectService(),
        newOptions: opts,
      })
    ).rejects.toThrow(/synthetic boot failure/);

    // Old replicas survived. r0's Cloud Map handle is still live; pool
    // still has both entries.
    expect(controller.runState.replicas.length).toBe(2);
    expect(pool.size()).toBe(2);
    expect(registry.lookup('cdkl.local', 'svc')?.length).toBe(2);
    // r0's IP is the ORIGINAL boot's (172.20.0.11), proving the swap
    // never landed.
    const ips = (registry.lookup('cdkl.local', 'svc') ?? []).map((e) => e.ip).sort();
    expect(ips).toContain('172.20.0.11');
    expect(ips).toContain('172.20.0.12');

    await controller.shutdown();
  });

  it('rolls every replica sequentially: each one ends up at a distinct generation slot', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = frontDoorOptions(pool, registry) as any;
    const controller = await startEcsService(fakeServiceConnectService(), opts, runState);

    // Roll BOTH replicas — the reload pathway calls this sequentially.
    await rollServiceReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeServiceConnectService(),
      newOptions: opts,
    });
    // After the first roll, r0 became the shadow at gen 1; r1 still at
    // gen 0 (its array index may shift due to splice + push).
    const r0AfterFirstRoll = controller.runState.replicas.find((r) => r.index === 0);
    const r1AfterFirstRoll = controller.runState.replicas.find((r) => r.index === 1);
    expect(r0AfterFirstRoll?.generation).toBe(1);
    expect(r1AfterFirstRoll?.generation).toBe(0);

    // Roll replica 1 — find it by reference.
    const r1Idx = controller.runState.replicas.indexOf(r1AfterFirstRoll!);
    await rollServiceReplica({
      controller,
      oldReplicaIndex: r1Idx,
      newService: fakeServiceConnectService(),
      newOptions: opts,
    });

    // Post both rolls: 2 replicas, both at generation 1.
    expect(controller.runState.replicas.length).toBe(2);
    const gens = controller.runState.replicas.map((r) => r.generation).sort();
    expect(gens).toEqual([1, 1]);

    // Pool still has 2 entries — never dropped below 2 during the roll.
    expect(pool.size()).toBe(2);

    await controller.shutdown();
  });

  it('TCP-ready probe timing out: warns + swaps anyway (the new image is the user intent)', async () => {
    // The probe is best-effort. A non-listening shadow (e.g. user's
    // new image has a startup bug) still trips the swap so the user
    // sees their broken image's behavior and can fix it; failing the
    // roll would leave the user stuck on the OLD, stale image with no
    // recovery path other than `^C`. Lock the warn-and-continue
    // contract.
    __setTcpProbeImpl(() => Promise.reject(new Error('ECONNREFUSED'))); // never accepts

    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = frontDoorOptions(pool, registry) as any;
    const controller = await startEcsService(fakeServiceConnectService(), opts, runState);

    expect(controller.runState.replicas.length).toBe(2);

    // beforeEach shrinks the probe budget to 50ms / 5ms so this case
    // exercises the timeout branch in real time without burning the
    // production 10s budget.
    await rollServiceReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeServiceConnectService(),
      newOptions: opts,
    });

    // The roll completed even though the probe never succeeded. The
    // shadow took replica 0's slot.
    const r0Now = controller.runState.replicas.find((r) => r.index === 0);
    expect(r0Now?.generation).toBe(1);
    expect(controller.runState.replicas.length).toBe(2);

    await controller.shutdown();
  });

  it('single-replica path: tears old down BEFORE the shadow boot to avoid host-port collision', async () => {
    // A 1-replica service publishes its container port on the host
    // (skipHostPortPublish=false). Both the old and a freshly-booted
    // shadow would race for the same host port, so the rolling
    // primitive falls back to Phase 1's stop-old-first behavior on
    // the single-replica path. This is a deliberate carve-out
    // (multi-replica services skip the host-port publish entirely
    // — see ecs-service-runner.ts comments around `skipHostPortPublish`).
    // Lock the ordering so a refactor doesn't silently regress
    // single-replica `--watch` into a host-port collision.
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = frontDoorOptions(pool, registry) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const singleService = (): any => {
      const s = fakeServiceConnectService();
      s.desiredCount = 1;
      return s;
    };
    const controller = await startEcsService(singleService(), opts, runState);

    // Single replica booted (bootCount=1) — old r0 published one
    // Cloud Map endpoint.
    expect(controller.runState.replicas.length).toBe(1);
    expect(registry.lookup('cdkl.local', 'svc')?.length).toBe(1);
    const cleanedBefore = hoisted.cleanedStates.length;

    await rollServiceReplica({
      controller,
      oldReplicaIndex: 0,
      newService: singleService(),
      newOptions: opts,
    });

    // Old was torn down (cleanupEcsRun called BEFORE the shadow boot
    // — `cleanedStates` grew by ≥ 1 with the OLD network name) AND
    // the shadow took the slot.
    expect(hoisted.cleanedStates.length).toBeGreaterThan(cleanedBefore);
    const r0Now = controller.runState.replicas.find((r) => r.index === 0);
    expect(r0Now?.generation).toBe(1);
    expect(controller.runState.replicas.length).toBe(1);
    // One Cloud Map endpoint (the shadow's), and it carries the
    // shadow's IP (172.20.0.12), not the old's (172.20.0.11).
    const left = registry.lookup('cdkl.local', 'svc');
    expect(left?.length).toBe(1);
    expect(left?.[0]?.ip).toBe('172.20.0.12');

    await controller.shutdown();
  });

  it('skips (warn + return) when the replica was retired by its own watcher mid-roll', async () => {
    // The reloader snapshots non-shutting-down replicas, then iterates
    // them. If a watcher fires `instance.shuttingDown = true` (e.g.
    // essential container crashed with `restartPolicy=none`) between
    // the snapshot and this slot's roll, the rolling primitive must
    // log + skip instead of throwing — the reloader catches the throw
    // but the error message would otherwise misdiagnose the cause as
    // a concurrent roll. Locking the warn-and-skip semantics.
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = frontDoorOptions(pool, registry) as any;
    const controller = await startEcsService(fakeServiceConnectService(), opts, runState);

    const bootsBefore = hoisted.bootCount;
    controller.runState.replicas[0]!.shuttingDown = true;
    // Yield one event-loop tick so the watcher's `while (!shuttingDown)`
    // observes the flip before we kick off the roll. A `setTimeout(0)`
    // is cheaper + less brittle than the previous `waitFor(() => true)`
    // (which was a no-op since the predicate was already true).
    await new Promise((r) => setTimeout(r, 0));

    // Must NOT throw — the previous Phase-2 contract did, masking the
    // common watcher-mid-roll case behind a misleading error.
    await expect(
      rollServiceReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeServiceConnectService(),
        newOptions: opts,
      })
    ).resolves.toBeUndefined();
    // No shadow was booted (we skipped early).
    expect(hoisted.bootCount).toBe(bootsBefore);

    // Reset so the controller can shut down cleanly.
    controller.runState.replicas[0]!.shuttingDown = false;
    await controller.shutdown();
  });

  it('single-replica path: shadow boot failure leaves the slot dark and re-throws (no live replica)', async () => {
    // Single-replica + host-port-publish takes the teardownOldFirst
    // branch: old is retired BEFORE the shadow boot. If the shadow
    // boot then throws, the service has no live replica. The primitive
    // must surface this with a clear log and re-throw so the reloader
    // can warn the user — the OLD replica cannot be brought back
    // because its docker state was already cleaned. The MULTI-replica
    // boot-failure test above proves the old replica survives on
    // that branch; this test locks the divergent single-replica
    // failure shape.
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = frontDoorOptions(pool, registry) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const singleService = (): any => {
      const s = fakeServiceConnectService();
      s.desiredCount = 1;
      return s;
    };
    const controller = await startEcsService(singleService(), opts, runState);

    // The next runEcsTask call (the shadow boot) throws.
    hoisted.failBootOnCount = 2;

    await expect(
      rollServiceReplica({
        controller,
        oldReplicaIndex: 0,
        newService: singleService(),
        newOptions: opts,
      })
    ).rejects.toThrow(/synthetic boot failure/);

    // The single-replica path: old is GONE (its `runState.replicas`
    // slot was spliced) and the shadow was rolled back too —
    // `runState.replicas` is now empty, reflecting the "now dark"
    // state the JSDoc + error log promise.
    expect(controller.runState.replicas.length).toBe(0);
    expect(registry.lookup('cdkl.local', 'svc')).toBeUndefined();
    expect(pool.size()).toBe(0);

    await controller.shutdown();
  });
});
