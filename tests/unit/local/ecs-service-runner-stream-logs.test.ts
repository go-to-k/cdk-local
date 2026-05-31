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
    attachCalls: [] as Array<{
      prefix: string;
      containerId: string;
      stopper: () => void;
    }>,
    stopperCallCount: 0,
  },
}));

vi.mock('../../../src/local/container-log-streamer.js', () => ({
  attachContainerLogStreamer: (prefix: string, containerId: string) => {
    // Return a unique stopper per attach so the
    // `logStoppers` drain test (Test G2) can assert the IDENTITY
    // pushed to `state.logStoppers` matches the stopper returned
    // by THIS call (not some other value a regression slipped in).
    const stopper = (): void => {
      hoisted.stopperCallCount += 1;
    };
    hoisted.attachCalls.push({ prefix, containerId, stopper });
    return stopper;
  },
}));

vi.mock('../../../src/local/ecs-task-runner.js', () => ({
  // Issue #227 review fix (Code #5) — mirror the real
  // `createEcsRunState()` shape: `publishedEndpoints: []` is part of
  // the production `EcsRunState`. A drift here would let a future
  // change that reads `state.publishedEndpoints` get an
  // undefined-access surprise that's invisible at unit-test time.
  createEcsRunState: () => ({
    network: undefined,
    dockerVolumeNames: [],
    startedContainers: [],
    logStoppers: [],
    publishedEndpoints: [],
  }),
  cleanupEcsRun: async () => {
    /* no-op for stream-logs unit */
  },
  runEcsTask: async (_task: unknown, _options: unknown, state: Record<string, unknown>) => {
    // Issue #227 review fix (Test F1) — the monotonic `bootCount`
    // counter ASSUMES replicas boot SEQUENTIALLY. Today's
    // `startEcsService` does exactly that (`Promise.all([...])` over
    // a Promise sequence chained with `await`s per index). A future
    // refactor to parallel-boot would race this counter and the
    // per-replica container-id mapping (`cid-web-1` vs `cid-web-2`)
    // would non-deterministically swap, breaking the
    // `idsByPrefix['[svc=... r=0 ...]'] === 'cid-web-1'` lock below.
    // Leaving the counter is the right call: the simpler shape is
    // worth more than the parallel-boot defense at unit-test scope,
    // and the integration tests catch a parallel-boot ordering bug
    // independently. If you DO refactor to parallel-boot, replace
    // this counter with `instance.index`-derived ids (e.g.
    // `cid-web-r${instance.index}`) so this test stays deterministic.
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
    serviceDisplayName: 'BackendApi',
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
    hoisted.stopperCallCount = 0;
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

  /**
   * Issue #227 review fix (Test G2) — `state.logStoppers` MUST carry
   * the IDENTITY returned by `attachContainerLogStreamer`. The runner
   * pushes the stopper onto `logStoppers` so `cleanupEcsRun` drains
   * + kills the streamer on shutdown / rebuild rolling reload.
   *
   * A regression that pushes a wrapper / a no-op / `undefined`
   * instead would silently leak the docker-logs child process across
   * a rebuild rolling reload (Phase 2 of #214) — every roll would
   * accumulate one zombie streamer per replica per container. This
   * test fails immediately if the identity isn't preserved.
   */
  it('pushes the IDENTITY returned by attachContainerLogStreamer onto state.logStoppers (drain contract)', async () => {
    const runState = createServiceRunState();
    const controller = await startEcsService(fakeService(), baseOpts(), runState);

    // 2 replicas x 2 containers => 4 attach calls + 4 stoppers in
    // each replica's logStoppers, summed across replicas.
    expect(hoisted.attachCalls.length).toBe(4);

    // Build the {prefix → stopper} map from the attach-side tracker.
    const stopperByPrefix = new Map(hoisted.attachCalls.map((c) => [c.prefix, c.stopper]));
    // Each replica's logStoppers MUST contain the stoppers returned
    // for that replica's prefix. The runner pushes them in
    // container-iteration order on `state.startedContainers`.
    const r0Stoppers = controller.runState.replicas[0]!.state.logStoppers;
    const r1Stoppers = controller.runState.replicas[1]!.state.logStoppers;
    expect(r0Stoppers).toHaveLength(2);
    expect(r1Stoppers).toHaveLength(2);
    expect(r0Stoppers[0]).toBe(stopperByPrefix.get('[svc=BackendApi r=0 c=web] '));
    expect(r0Stoppers[1]).toBe(stopperByPrefix.get('[svc=BackendApi r=0 c=sidecar] '));
    expect(r1Stoppers[0]).toBe(stopperByPrefix.get('[svc=BackendApi r=1 c=web] '));
    expect(r1Stoppers[1]).toBe(stopperByPrefix.get('[svc=BackendApi r=1 c=sidecar] '));
  });

  /**
   * Issue #227 review fix (Test G2 — drain order): when the old
   * replica's `cleanupEcsRun` runs (rebuild rolling reload retires
   * the dying replica), EVERY stopper in `logStoppers` is called
   * BEFORE returning. This is the "no zombie docker logs -f"
   * contract — without it, a long-running `--watch` session
   * accumulates one orphan streamer per replica per container per
   * roll.
   *
   * The real `cleanupEcsRun` lives in
   * `src/local/ecs-task-runner.ts` and the contract is locked by
   * its own unit tests; this test re-locks it from the
   * service-runner side by manually invoking the drain pattern
   * `cleanupEcsRun` uses, so a regression that changes the storage
   * shape of `logStoppers` (e.g. to `Set<() => void>` without
   * adapting the iterator) trips here too.
   */
  it('every stopper in logStoppers is invoked when drained (matches cleanupEcsRun drain order)', async () => {
    const runState = createServiceRunState();
    const controller = await startEcsService(fakeService(), baseOpts(), runState);

    // Pre-drain: no stopper has been called.
    expect(hoisted.stopperCallCount).toBe(0);

    // Mirror cleanupEcsRun's drain pattern (`for (const stop of
    // state.logStoppers) { stop(); }`) against r0 — every recorded
    // stopper MUST be invoked before the next step.
    for (const stop of controller.runState.replicas[0]!.state.logStoppers) {
      stop();
    }
    expect(hoisted.stopperCallCount).toBe(2); // r0's 2 containers' stoppers

    for (const stop of controller.runState.replicas[1]!.state.logStoppers) {
      stop();
    }
    expect(hoisted.stopperCallCount).toBe(4); // r1's 2 containers as well
  });
});

