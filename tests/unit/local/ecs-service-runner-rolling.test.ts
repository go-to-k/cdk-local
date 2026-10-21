import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { FrontDoorEndpointPool } from '../../../src/local/front-door-pool.js';
import { CloudMapRegistry } from '../../../src/local/cloud-map-registry.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';

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
    // Issue #805 — the `runEcsTask` options of every boot, in order.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskOptions: [] as any[],
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
  runEcsTask: async (_task: unknown, options: unknown, state: Record<string, unknown>) => {
    hoisted.bootCount += 1;
    hoisted.taskOptions.push(options);
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
  __setDockerNetworkConnectImpl,
  __setDockerInspectPublishesHostPortsImpl,
  __setListenProbeImpl,
  __setReloadDrainMs,
  containerPublishesHostPorts,
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
    hoisted.taskOptions = [];
    __setSleepImpl(() => Promise.resolve()); // skip restart backoff
    __setWaitForExitImpl(() => new Promise<number>(() => {})); // replicas never exit
    __setTcpProbeImpl(() => Promise.resolve()); // shadow is always TCP-ready
    // Issue #660 — the in-container LISTEN check runs first; report it
    // unavailable so these rows keep exercising the host-side TCP
    // connect. The in-container path has its own rows below.
    __setListenProbeImpl(async () => ({ kind: 'unsupported', detail: 'test: no sh' }));
    __setShadowReadyConfig({ timeoutMs: 50, intervalMs: 5 }); // shrink probe budget for the timeout case
    __setDockerNetworkDisconnectImpl(async (networkName, containerId) => {
      hoisted.disconnectCalls.push({ networkName, containerId });
    });
  });
  afterEach(() => {
    __setWaitForExitImpl(undefined);
    __setSleepImpl(undefined);
    __setTcpProbeImpl(undefined);
    __setListenProbeImpl(undefined);
    __setShadowReadyConfig(undefined);
    __setDockerNetworkDisconnectImpl(undefined);
    __setDockerNetworkConnectImpl(undefined);
    __setDockerInspectPublishesHostPortsImpl(undefined);
    __setReloadDrainMs(undefined);
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

  it('TCP-ready probe success: debug log surfaces the elapsed-ms (issue #265)', async () => {
    // Issue #265 — the probe used to log only on FAIL. On success it
    // now surfaces `${label}: TCP probe <ip>:<port> accepted in <N>ms`
    // at debug level so users tuning `--shadow-ready-timeout` know
    // what budget to set. The fake probe always resolves immediately
    // (see beforeEach) so the elapsed-ms is a small non-negative
    // integer.
    const debugSpy = vi.spyOn(ConsoleLogger.prototype, 'debug').mockImplementation(() => {});

    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    const runState = createServiceRunState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = frontDoorOptions(pool, registry) as any;
    const controller = await startEcsService(fakeServiceConnectService(), opts, runState);
    expect(controller.runState.replicas.length).toBe(2);

    await rollServiceReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeServiceConnectService(),
      newOptions: opts,
    });

    const debugLines = debugSpy.mock.calls.map((c) => String(c[0]));
    const match = debugLines.find((l) =>
      /TCP probe [\d.]+:\d+ accepted in \d+ms\.$/.test(l)
    );
    expect(match).toBeDefined();

    await controller.shutdown();
    debugSpy.mockRestore();
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

  // Issue #660 — readiness is read INSIDE the container (a `docker exec`
  // LISTEN check): on Docker Desktop the host cannot route to a
  // container's docker-network IP, so the host-side connect timed out at
  // the full budget on every reload there.
  describe('in-container LISTEN check (issue #660)', () => {
    async function rollWithProbes(): Promise<{ warns: string[]; debugs: string[] }> {
      const warnSpy = vi.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(() => {});
      const debugSpy = vi.spyOn(ConsoleLogger.prototype, 'debug').mockImplementation(() => {});
      try {
        const pool = new FrontDoorEndpointPool();
        const registry = new CloudMapRegistry();
        const runState = createServiceRunState();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const opts = frontDoorOptions(pool, registry) as any;
        const controller = await startEcsService(fakeServiceConnectService(), opts, runState);
        await rollServiceReplica({
          controller,
          oldReplicaIndex: 0,
          newService: fakeServiceConnectService(),
          newOptions: opts,
        });
        await controller.shutdown();
        return {
          warns: warnSpy.mock.calls.map((c) => String(c[0])),
          debugs: debugSpy.mock.calls.map((c) => String(c[0])),
        };
      } finally {
        warnSpy.mockRestore();
        debugSpy.mockRestore();
      }
    }

    it('is ready on the first LISTEN hit and never touches the host connect', async () => {
      const listenCalls: Array<{ id: string; port: number }> = [];
      __setListenProbeImpl(async (id, port) => {
        listenCalls.push({ id, port });
        return { kind: 'listening' };
      });
      let tcpCalls = 0;
      __setTcpProbeImpl(() => {
        tcpCalls += 1;
        return Promise.reject(new Error('host cannot route to the container IP'));
      });
      const { warns, debugs } = await rollWithProbes();
      // The shadow (boot #3) is probed on the essential container's first port.
      expect(listenCalls).toEqual([{ id: 'cid-3', port: 80 }]);
      expect(tcpCalls).toBe(0);
      expect(warns.filter((w) => w.includes('did not accept'))).toEqual([]);
      expect(debugs.some((d) => /port 80 listening in \d+ms \(in-container check\)\.$/.test(d))).toBe(
        true
      );
    });

    it('keeps polling through not-listening and transient errors until LISTEN', async () => {
      const answers = [
        { kind: 'not-listening' as const },
        { kind: 'error' as const, detail: 'Container cid-3 is not running' },
        { kind: 'listening' as const },
      ];
      let calls = 0;
      __setListenProbeImpl(async () => answers[Math.min(calls++, answers.length - 1)]!);
      __setShadowReadyConfig({ timeoutMs: 5_000, intervalMs: 1 });
      const { warns } = await rollWithProbes();
      expect(calls).toBe(3);
      expect(warns.filter((w) => w.includes('did not accept'))).toEqual([]);
    });

    it('falls back to the host-side TCP connect once the image cannot run the check', async () => {
      let listenCalls = 0;
      __setListenProbeImpl(async () => {
        listenCalls += 1;
        return { kind: 'unsupported', detail: 'exec: "sh": executable file not found' };
      });
      const tcpTargets: string[] = [];
      __setTcpProbeImpl((host, port) => {
        tcpTargets.push(`${host}:${port}`);
        return Promise.resolve();
      });
      const { warns } = await rollWithProbes();
      expect(listenCalls).toBe(1); // asked once, then never again for this probe
      expect(tcpTargets.length).toBe(1);
      expect(tcpTargets[0]).toMatch(/^172\.20\.0\.\d+:80$/);
      expect(warns.filter((w) => w.includes('did not accept'))).toEqual([]);
    });

    it('warns with the container:port target when the port never starts listening', async () => {
      __setListenProbeImpl(async () => ({ kind: 'not-listening' }));
      const { warns } = await rollWithProbes();
      const timeout = warns.filter((w) => w.includes('did not accept'));
      expect(timeout).toHaveLength(1);
      expect(timeout[0]).toContain('TCP probe web:80 did not accept within 50ms (last: not listening yet)');
    });
  });

  // Issue #805 — the multi-replica shadow used to be published (Cloud Map,
  // front-door pool) and resolvable by its Service Connect alias from the
  // moment its container started, before its app listened: a peer or the
  // front-door could reach it while it was still binding.
  describe('shadow is published only once it listens (issue #805)', () => {
    const sharedNetwork = { networkName: 'net-shared', ownedByCaller: true };

    async function rollWithGate(
      opts: Record<string, unknown>,
      publishes: boolean
    ): Promise<{ ops: string[]; shadowRegistered: boolean; poolSize: number | undefined }> {
      const ops: string[] = [];
      const registry = (opts['discovery'] as { registry: CloudMapRegistry }).registry;
      const pool = (opts['frontDoor'] as { pools: Array<{ pool: FrontDoorEndpointPool }> } | undefined)
        ?.pools[0]!.pool;
      const shadowIp = '172.20.0.13'; // boot #3; the docker-inspect mock keys IPs off the boot count
      __setDockerInspectPublishesHostPortsImpl(async () => publishes);
      __setDockerNetworkDisconnectImpl(async (net, id) => {
        ops.push(`disconnect ${net} ${id}`);
      });
      __setDockerNetworkConnectImpl(async (net, id, o) => {
        ops.push(`connect ${net} ${id} ip=${o.ip} aliases=${o.aliases.join(',')}`);
      });
      __setListenProbeImpl(async (id) => {
        const inRegistry = (registry.lookup('cdkl.local', 'svc') ?? []).some((e) => e.ip === shadowIp);
        const inPool = pool ? pool.size() > 2 : false;
        ops.push(`listen ${id} registry=${inRegistry} pool=${inPool}`);
        return { kind: 'listening' };
      });
      const runState = createServiceRunState();
      const controller = await startEcsService(fakeServiceConnectService(), opts as never, runState);
      await rollServiceReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeServiceConnectService(),
        newOptions: opts as never,
      });
      // Snapshot BEFORE shutdown, which unregisters everything.
      const shadowRegistered = (registry.lookup('cdkl.local', 'svc') ?? []).some(
        (e) => e.ip === shadowIp
      );
      const poolSize = pool?.size();
      await controller.shutdown();
      return { ops, shadowRegistered, poolSize };
    }

    it('withholds a non-publishing shadow\'s aliases at boot and attaches them after LISTEN, before any registration', async () => {
      const registry = new CloudMapRegistry();
      const opts = {
        ...frontDoorOptions(new FrontDoorEndpointPool(), registry),
        frontDoor: undefined,
        discovery: { registry, cloudMapIndexByStack: new Map(), sharedNetwork },
      };
      const { ops, shadowRegistered } = await rollWithGate(opts, false);
      // Boots 1-2 (initial replicas) carry the Service Connect aliases;
      // the shadow (boot 3) does not.
      expect(hoisted.taskOptions[0].networkAliasesByContainer?.get('web')).toEqual([
        'svc',
        'svc.cdkl.local',
      ]);
      expect(hoisted.taskOptions[2].networkAliasesByContainer?.get('web')).toBeUndefined();
      const shadowOps = ops.filter((o) => o.includes('cid-3'));
      expect(shadowOps).toEqual([
        'listen cid-3 registry=false pool=false', // replica probe: not yet registered
        'listen cid-3 registry=false pool=false', // its own port, gating its aliases
        'disconnect net-3 cid-3',
        'connect net-3 cid-3 ip=172.20.0.13 aliases=web,svc,svc.cdkl.local',
      ]);
      expect(shadowRegistered).toBe(true);
    });

    it('keeps a host-port publisher\'s aliases from boot (no running re-attach) but still gates its front-door + Cloud Map entries', async () => {
      const registry = new CloudMapRegistry();
      const pool = new FrontDoorEndpointPool();
      const opts = {
        ...frontDoorOptions(pool, registry),
        discovery: { registry, cloudMapIndexByStack: new Map(), sharedNetwork },
      };
      const { ops, shadowRegistered, poolSize } = await rollWithGate(opts, true);
      // Front-door ephemeral publish on port 80 -> the shadow publishes.
      expect(hoisted.taskOptions[2].networkAliasesByContainer?.get('web')).toEqual([
        'svc',
        'svc.cdkl.local',
      ]);
      const shadowOps = ops.filter((o) => o.includes('cid-3'));
      expect(shadowOps).toEqual(['listen cid-3 registry=false pool=false']);
      expect(poolSize).toBe(2); // shadow in, old r0 out
      expect(shadowRegistered).toBe(true);
    });

    it('retires the shadow and keeps the old replica serving when the alias attach fails', async () => {
      const registry = new CloudMapRegistry();
      const opts = {
        ...frontDoorOptions(new FrontDoorEndpointPool(), registry),
        frontDoor: undefined,
        discovery: { registry, cloudMapIndexByStack: new Map(), sharedNetwork },
      };
      __setDockerInspectPublishesHostPortsImpl(async () => false);
      __setDockerNetworkConnectImpl(async () => {
        throw new Error('synthetic connect failure');
      });
      const runState = createServiceRunState();
      const controller = await startEcsService(fakeServiceConnectService(), opts as never, runState);
      await expect(
        rollServiceReplica({
          controller,
          oldReplicaIndex: 0,
          newService: fakeServiceConnectService(),
          newOptions: opts as never,
        })
      ).rejects.toThrow(/synthetic connect failure/);
      // Old r0 (gen 0) is still the slot's replica and still registered.
      expect(controller.runState.replicas.map((r) => `${r.index}:${r.generation}`).sort()).toEqual([
        '0:0',
        '1:0',
      ]);
      const ips = (registry.lookup('cdkl.local', 'svc') ?? []).map((e) => e.ip).sort();
      expect(ips).toEqual(['172.20.0.11', '172.20.0.12']);
      await controller.shutdown();
    });
  });

  describe('gated shadow edge cases (issue #805)', () => {
    const sharedNetwork = { networkName: 'net-shared', ownedByCaller: true };
    function gatedOpts(): { opts: Record<string, unknown>; registry: CloudMapRegistry } {
      const registry = new CloudMapRegistry();
      return {
        registry,
        opts: {
          ...frontDoorOptions(new FrontDoorEndpointPool(), registry),
          frontDoor: undefined,
          discovery: { registry, cloudMapIndexByStack: new Map(), sharedNetwork },
        },
      };
    }

    it('also withholds the container-name alias when it doubles as a Service Connect name', async () => {
      const svc = (): ReturnType<typeof fakeServiceConnectService> => {
        const s = fakeServiceConnectService();
        s.serviceConnect.services[0].discoveryName = 'web'; // container is named `web` too
        return s;
      };
      const { opts } = gatedOpts();
      const connects: string[] = [];
      __setDockerNetworkConnectImpl(async (net, id, o) => {
        connects.push(`${net} ${id} ${o.aliases.join(',')}`);
      });
      __setListenProbeImpl(async () => ({ kind: 'listening' }));
      const controller = await startEcsService(svc(), opts as never, createServiceRunState());
      await rollServiceReplica({
        controller,
        oldReplicaIndex: 0,
        newService: svc(),
        newOptions: opts as never,
      });
      expect(hoisted.taskOptions[0].containerNameAliasOmitted).toBeUndefined();
      expect([...(hoisted.taskOptions[2].containerNameAliasOmitted ?? [])]).toEqual(['web']);
      // (the retired r0, cid-1, also gets its #813 IP-only drain re-attach)
      expect(connects.filter((c) => c.includes('cid-3'))).toEqual(['net-3 cid-3 web,web.cdkl.local']);
      await controller.shutdown();
    });

    it('takes a failed gated shadow off the shared network before tearing it down', async () => {
      const { opts } = gatedOpts();
      __setDockerNetworkConnectImpl(async () => {
        throw new Error('synthetic connect failure');
      });
      __setListenProbeImpl(async () => ({ kind: 'listening' }));
      const controller = await startEcsService(
        fakeServiceConnectService(),
        opts as never,
        createServiceRunState()
      );
      await expect(
        rollServiceReplica({
          controller,
          oldReplicaIndex: 0,
          newService: fakeServiceConnectService(),
          newOptions: opts as never,
        })
      ).rejects.toThrow(/synthetic connect failure/);
      const shadowDisconnects = hoisted.disconnectCalls.filter((c) => c.containerId === 'cid-3');
      // once by the gate (before the failing connect), once by the teardown
      expect(shadowDisconnects).toHaveLength(2);
      await controller.shutdown();
    });

    it('still swaps in a shadow whose container exited during startup (the new image is the user intent)', async () => {
      const { opts } = gatedOpts();
      __setListenProbeImpl(async () => ({ kind: 'exited', detail: 'is not running' }));
      const controller = await startEcsService(
        fakeServiceConnectService(),
        opts as never,
        createServiceRunState()
      );
      await rollServiceReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeServiceConnectService(),
        newOptions: opts as never,
      });
      // Documented contract (waitForReplicaTcpReady): a not-ready shadow is
      // swapped in anyway; failing the roll would strand the user on stale
      // code. The watcher's restart policy then owns the crash loop.
      expect(controller.runState.replicas.find((r) => r.index === 0)?.generation).toBe(1);
      await controller.shutdown();
    });

    it('leaves the aliases of a withheld container that exited before listening withheld (no re-attach of a stopped container)', async () => {
      const { opts, registry } = gatedOpts();
      const connects: string[] = [];
      __setDockerNetworkConnectImpl(async (_net, id) => {
        connects.push(id);
      });
      let calls = 0;
      __setListenProbeImpl(async () => {
        calls += 1;
        // The replica probe sees it listen; it then dies before its own
        // per-container check.
        return calls === 1 ? { kind: 'listening' } : { kind: 'exited', detail: 'is not running' };
      });
      const controller = await startEcsService(
        fakeServiceConnectService(),
        opts as never,
        createServiceRunState()
      );
      await rollServiceReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeServiceConnectService(),
        newOptions: opts as never,
      });
      expect(connects.filter((id) => id === 'cid-3')).toEqual([]); // the shadow
      // The roll still completes (the watcher restarts a dead shadow).
      expect(
        (registry.lookup('cdkl.local', 'svc') ?? []).some((e) => e.ip === '172.20.0.13')
      ).toBe(true);
      await controller.shutdown();
    });

    it.each([
      [1, 'during the replica probe'],
      [2, 'during the per-container wait'],
    ])('publishes nothing when shutdown starts on LISTEN call %i (%s)', async (atCall) => {
      const { opts, registry } = gatedOpts();
      const connects: string[] = [];
      __setDockerNetworkConnectImpl(async (net, id) => {
        connects.push(`${net} ${id}`);
      });
      const controller = await startEcsService(
        fakeServiceConnectService(),
        opts as never,
        createServiceRunState()
      );
      let calls = 0;
      __setListenProbeImpl(async () => {
        calls += 1;
        if (calls === atCall) controller.runState.shuttingDown = true; // SIGTERM lands mid-gate
        return { kind: 'listening' };
      });
      await rollServiceReplica({
        controller,
        oldReplicaIndex: 0,
        newService: fakeServiceConnectService(),
        newOptions: opts as never,
      });
      expect(connects.filter((c) => c.includes('cid-3'))).toEqual([]); // the shadow
      // ...and stops LISTENING too: shutdown is not held for the rest of the budget.
      expect(calls).toBe(atCall);
      expect(
        (registry.lookup('cdkl.local', 'svc') ?? []).some((e) => e.ip === '172.20.0.13')
      ).toBe(false);
      await controller.shutdown();
    });
  });

  // Issue #812 — the watcher's crash-restart re-boot used to publish the
  // replica (Cloud Map, front-door, Service Connect alias) at `docker run`,
  // with no readiness probe at all.
  describe('crash restart is published only once it listens (issue #812)', () => {
    const sharedNetwork = { networkName: 'net-shared', ownedByCaller: true };
    function crashOnce(): void {
      let crashed = false;
      __setWaitForExitImpl((id) => {
        if (id === 'cid-1' && !crashed) {
          crashed = true;
          return Promise.resolve(137); // `docker kill`: on-failure restarts it
        }
        return new Promise<number>(() => {});
      });
    }

    it('boots the restarted replica unpublished, attaches its aliases after LISTEN, then registers it', async () => {
      crashOnce();
      const registry = new CloudMapRegistry();
      const opts = {
        ...frontDoorOptions(new FrontDoorEndpointPool(), registry),
        frontDoor: undefined,
        discovery: { registry, cloudMapIndexByStack: new Map(), sharedNetwork },
      };
      const ops: string[] = [];
      __setDockerInspectPublishesHostPortsImpl(async () => false);
      __setDockerNetworkConnectImpl(async (net, id, o) => {
        ops.push(`connect ${net} ${id} ip=${o.ip} aliases=${o.aliases.join(',')}`);
      });
      __setListenProbeImpl(async (id) => {
        const registered = (registry.lookup('cdkl.local', 'svc') ?? []).some(
          (e) => e.ip === '172.20.0.13'
        );
        ops.push(`listen ${id} registered=${registered}`);
        return { kind: 'listening' };
      });
      const controller = await startEcsService(
        fakeServiceConnectService(),
        opts as never,
        createServiceRunState()
      );
      const isRegistered = (): boolean =>
        (registry.lookup('cdkl.local', 'svc') ?? []).some((e) => e.ip === '172.20.0.13');
      await waitFor(isRegistered);
      expect(hoisted.taskOptions[0].networkAliasesByContainer?.get('web')).toEqual([
        'svc',
        'svc.cdkl.local',
      ]);
      // Boot #3 is the restart of r0: aliases withheld at `docker run`.
      expect(hoisted.taskOptions[2].networkAliasesByContainer?.get('web')).toBeUndefined();
      expect(ops).toEqual([
        'listen cid-3 registered=false', // replica probe
        'listen cid-3 registered=false', // its own port, gating its aliases
        'connect net-3 cid-3 ip=172.20.0.13 aliases=web,svc,svc.cdkl.local',
      ]);
      expect(isRegistered()).toBe(true);
      await controller.shutdown();
    });

    it('does not hold a shutdown for the readiness budget while a restarted replica is still binding', async () => {
      crashOnce();
      const registry = new CloudMapRegistry();
      const opts = {
        ...frontDoorOptions(new FrontDoorEndpointPool(), registry),
        frontDoor: undefined,
        discovery: { registry, cloudMapIndexByStack: new Map(), sharedNetwork },
      };
      let listens = 0;
      __setListenProbeImpl(async () => {
        listens += 1;
        // A real tick, as `docker exec` takes: the loop must yield to the
        // event loop or shutdown() never gets to run.
        await new Promise((r) => setTimeout(r, 2));
        return { kind: 'not-listening' };
      });
      __setShadowReadyConfig({ timeoutMs: 60_000, intervalMs: 1 });
      const controller = await startEcsService(
        fakeServiceConnectService(),
        opts as never,
        createServiceRunState()
      );
      await waitFor(() => listens > 0);
      // `shutdown()` awaits the in-flight restart boot; without the probe's
      // shutdown check it would wait out the whole 60 s budget.
      const done = await Promise.race([
        controller.shutdown().then(() => 'shut down'),
        new Promise((r) => setTimeout(() => r('still waiting'), 2_000)),
      ]);
      expect(done).toBe('shut down');
      expect(
        (registry.lookup('cdkl.local', 'svc') ?? []).some((e) => e.ip === '172.20.0.13')
      ).toBe(false);
    });

    it('publishes nothing for a restart that crashes again during startup, and the restart policy re-boots it', async () => {
      // cid-1 crashes; its restart (cid-3) exits during startup and its
      // `docker wait` returns 137 too; the next restart (cid-4) comes up.
      const crashed = new Set<string>();
      __setWaitForExitImpl((id) => {
        if ((id === 'cid-1' || id === 'cid-3') && !crashed.has(id)) {
          crashed.add(id);
          return Promise.resolve(137);
        }
        return new Promise<number>(() => {});
      });
      const registry = new CloudMapRegistry();
      const opts = {
        ...frontDoorOptions(new FrontDoorEndpointPool(), registry),
        frontDoor: undefined,
        discovery: { registry, cloudMapIndexByStack: new Map(), sharedNetwork },
      };
      const connects: string[] = [];
      __setDockerNetworkConnectImpl(async (_net, id) => {
        connects.push(id);
      });
      const listens: string[] = [];
      __setListenProbeImpl(async (id) => {
        listens.push(id);
        return id === 'cid-3'
          ? { kind: 'exited', detail: 'Container cid-3 is not running' }
          : { kind: 'listening' };
      });
      __setShadowReadyConfig({ timeoutMs: 60_000, intervalMs: 1 });
      const warnSpy = vi.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(() => {});
      const controller = await startEcsService(
        fakeServiceConnectService(),
        opts as never,
        createServiceRunState()
      );
      const ips = (): string[] => (registry.lookup('cdkl.local', 'svc') ?? []).map((e) => e.ip);
      await waitFor(() => ips().includes('172.20.0.14'));
      // cid-3 was probed ONCE (no 60 s polling of a dead container), never
      // re-attached, never registered; cid-4 went through the full gate.
      expect(listens.filter((id) => id === 'cid-3')).toHaveLength(1);
      expect(connects).toEqual(['cid-4']);
      expect(ips()).not.toContain('172.20.0.13');
      const r0 = controller.runState.replicas.find((r) => r.index === 0)!;
      expect(r0.restartCount).toBe(2);
      expect(r0.shuttingDown).toBe(false); // not left degraded
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes('Restarted replica r0 (gen 0): the container exited before port 80 listened.')
        )
      ).toBe(true);
      warnSpy.mockRestore();
      await controller.shutdown();
    });
  });

  // Issue #813 — the retired replica keeps serving on its old IP for the
  // drain window after its aliases are withdrawn, before it is torn down.
  it('drains the retired replica: disconnect, IP-only re-attach, drain wait, THEN cleanup', async () => {
    const pool = new FrontDoorEndpointPool();
    const registry = new CloudMapRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = frontDoorOptions(pool, registry) as any;
    const ops: string[] = [];
    __setReloadDrainMs(4321);
    __setDockerNetworkConnectImpl(async (net, id, o) => {
      ops.push(`connect ${net} ${id} aliases=${o.aliases.join(',')} ip=${o.ip ? 'set' : 'none'}`);
    });
    __setDockerNetworkDisconnectImpl(async (net, id) => {
      ops.push(`disconnect ${net} ${id}`);
    });
    __setSleepImpl(async (ms) => {
      ops.push(`sleep ${ms} cleaned=${hoisted.cleanedStates.map((c) => c.networkName).join(',')}`);
    });
    const controller = await startEcsService(fakeServiceConnectService(), opts, createServiceRunState());
    await rollServiceReplica({
      controller,
      oldReplicaIndex: 0,
      newService: fakeServiceConnectService(),
      newOptions: opts,
    });
    const old = ops.filter((o) => o.includes('cid-1') || o.startsWith('sleep 4321'));
    expect(old).toEqual([
      'disconnect net-1 cid-1',
      'connect net-1 cid-1 aliases= ip=set',
      'sleep 4321 cleaned=', // the old replica is NOT torn down yet
    ]);
    expect(hoisted.cleanedStates.map((c) => c.networkName)).toContain('net-1');
    await controller.shutdown();
  });

  describe('containerPublishesHostPorts (issue #805)', () => {
    const c = { portMappings: [{ containerPort: 80 }, { containerPort: 9000 }] };
    it('mirrors buildDockerRunArgs: every mapping unless skipped, plus front-door ephemeral ports', () => {
      expect(
        containerPublishesHostPorts(c, { skipHostPortPublish: false, ephemeralPublishContainerPorts: [] })
      ).toBe(true);
      expect(
        containerPublishesHostPorts(c, { skipHostPortPublish: true, ephemeralPublishContainerPorts: [] })
      ).toBe(false);
      expect(
        containerPublishesHostPorts(c, { skipHostPortPublish: true, ephemeralPublishContainerPorts: [9000] })
      ).toBe(true);
      expect(
        containerPublishesHostPorts(c, { skipHostPortPublish: true, ephemeralPublishContainerPorts: [8080] })
      ).toBe(false);
      expect(
        containerPublishesHostPorts(
          { portMappings: [] },
          { skipHostPortPublish: false, ephemeralPublishContainerPorts: [80] }
        )
      ).toBe(false);
    });
  });
});
