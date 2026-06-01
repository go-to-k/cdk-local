import { getLogger } from '../utils/logger.js';
import { singleFlight } from '../utils/single-flight.js';
import {
  cleanupEcsRun,
  createEcsRunState,
  runEcsTask,
  type EcsRunState,
  type RunEcsTaskOptions,
} from './ecs-task-runner.js';
import type { ResolvedEcsService } from './ecs-service-resolver.js';
import type { CloudMapRegistry, RegistrationHandle } from './cloud-map-registry.js';
import type { CloudMapIndex } from './cloud-map-resolver.js';
import type { FrontDoorEndpointPool } from './front-door-pool.js';
import { getContainerNetworkIp, getPublishedHostPort } from './docker-inspect.js';
import { SHARED_SVC_SUBNET_OCTET, type TaskNetwork } from './ecs-network.js';
import { getEmbedConfig } from './embed-config.js';
import { attachContainerLogStreamer } from './container-log-streamer.js';

/**
 * Phase 2 of #262 — long-running ECS Service emulator. Wraps the existing
 * `ecs-task-runner` machinery in a replica pool: N concurrent task
 * instances per `DesiredCount`, each with its own docker network +
 * metadata sidecar + container set. Tasks that exit non-zero AFTER the
 * health-check grace period are restarted with exponential backoff so a
 * crash-looping container does not hammer docker.
 *
 * v1 scope (per the issue's PR-split recommendation):
 *   - Replica pool sizing via `DesiredCount` clamped by `--max-tasks`.
 *   - Restart-on-exit with exponential backoff (1s → 30s, capped) +
 *     a per-instance retry counter so a permanently-broken container
 *     stops compounding cleanup work.
 *   - Long-running lifecycle (returns only on shutdown).
 *
 * Phase 3 of #262 (Issue #460) — Cloud Map / Service Connect peer
 * discovery is wired through `ServiceRunnerOptions.discovery`. When
 * supplied, every booted replica discovers its docker IP, registers
 * itself into the shared in-process `CloudMapRegistry`, and emits
 * `--add-host` flags so consumer containers reach peer services via
 * the canonical `<discoveryName>.<namespace>` fqdn. Envoy L7 sidecar
 * emulation (design Layer B) is deferred to a follow-up PR per the
 * design's §O5 "--no-envoy by default" recommendation.
 *
 * Deferred to follow-up PRs:
 *   - Envoy sidecar for Service Connect L7 routing / retries / circuit
 *     breaking (Cloud Map DNS-only mode ships now).
 *   - Rolling deployment (`--reload` / `--watch`).
 *
 * Local load-balancer emulation is now first-class via `start-alb`, which
 * boots the same replicas behind a local front-door that mirrors the
 * deployed ALB's listener-rule / forward / redirect / fixed-response /
 * authenticate-* surface; `start-service` runs the replicas only.
 */

export class EcsServiceRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcsServiceRunnerError';
    Object.setPrototypeOf(this, EcsServiceRunnerError.prototype);
  }
}

/**
 * Phase 4 (#214) — completion-log suffix the soft-reload primitive
 * emits AFTER `Soft-reloaded replica r<i> (gen <g>): ` to confirm
 * the docker restart + TCP-ready probe + Cloud Map / front-door
 * re-publish round trip is done.
 *
 * Exported so integ fixtures + unit tests can grep against the
 * canonical text instead of hand-copying the wording — a future
 * refactor that rewords this line stays detectable via the symbol
 * import instead of silently breaking every test's regex.
 *
 * Per-repo memory (#218 / test reviewer N4): log-line text is part
 * of the public contract for `--watch` integ scripts, so it earns a
 * constant.
 */
export const SOFT_RELOAD_COMPLETION_LOG_SUFFIX =
  'restart + TCP-ready probe complete; Cloud Map + front-door re-published.';

export interface ServiceRunnerOptions {
  /**
   * Hard cap on local replica count. Even when the service's
   * `DesiredCount` is high (e.g. production-shape 10+), local dev
   * machines should not have to run that many containers. Default 3 in
   * the CLI; the runner clamps to this regardless of `DesiredCount`.
   */
  maxTasks: number;
  /**
   * Restart policy on exit. Default `on-failure`: restart only when the
   * essential container exits non-zero. `always` restarts on every exit
   * (mirroring ECS Service deployment behavior more closely but produces
   * more cleanup churn). `none` skips restart entirely; the runner
   * shuts the affected replica down and the service runs degraded.
   */
  restartPolicy: 'on-failure' | 'always' | 'none';
  /**
   * Underlying per-task options. Forwarded verbatim per replica to the
   * task runner.
   */
  taskOptions: RunEcsTaskOptions;
  /**
   * Issue #460 — Cloud Map / Service Connect shared registry. When
   * provided, every booted replica:
   *   1. Has its main-container IP resolved via `docker inspect`.
   *   2. Registers `(namespace, discoveryName) → ip:port` into the
   *      registry for every Service Connect entry AND every
   *      ServiceRegistry (Cloud Map service) referenced by this
   *      service.
   *   3. Re-builds its own `addHostFlags` from the registry's current
   *      snapshot so the consumer can reach previously-booted peer
   *      services via DNS overlay.
   * Pass `undefined` (single-service runs that don't need cross-
   * service discovery) to short-circuit registry interaction
   * entirely.
   */
  discovery?: ServiceDiscoveryContext;
  /**
   * Issue #86 v1 — local ALB front-door. When set, every replica publishes
   * each pool's target container port on an ephemeral host port and registers
   * the resulting `127.0.0.1:<port>` endpoint into the pool so the host-side
   * front-door server can round-robin to it. Registrations are dropped on
   * replica restart / shutdown, mirroring the Cloud Map handle lifecycle.
   * Undefined for services with no resolvable load-balancer listener.
   */
  frontDoor?: FrontDoorRunnerContext;
  /**
   * Issue #227 — when `true` (default), every booted replica's
   * container stdout / stderr is streamed to the host terminal with a
   * `[svc=<serviceName> r=<replicaIndex> c=<containerName>] ` prefix,
   * matching `cdkl run-task`'s log surface. Flipped to `false` by
   * `cdkl start-service --no-logs` / `cdkl start-alb --no-logs` for
   * multi-replica / multi-service runs whose interleaved log volume
   * makes the foreground unreadable; `docker logs -f <id>` in a
   * separate terminal stays available either way.
   *
   * Each per-replica streamer is attached AFTER the underlying
   * `runEcsTask` call returns (so the replica's `EcsRunState` has its
   * `startedContainers` populated) and is appended into
   * `state.logStoppers` so `cleanupEcsRun` drains + kills the streamer
   * process on shutdown / rebuild rolling reload. The soft-reload
   * pathway (`docker restart` preserves the container ID) is handled
   * inside {@link attachContainerLogStreamer} itself: the docker daemon
   * terminates `docker logs -f` on the container's PID-1 exit, so the
   * streamer auto-re-spawns `docker logs -f --since 0s` against the
   * SAME container ID to capture the post-restart PID-1's output
   * without re-emitting the pre-restart prelude.
   */
  streamLogs?: boolean;
}

/**
 * Per-service front-door wiring threaded from the CLI. One pool per resolved
 * listener `forward` target; each carries the container name + port the
 * listener targets so the runner can publish + discover the right ephemeral
 * host port per replica.
 */
export interface FrontDoorRunnerContext {
  pools: ReadonlyArray<{
    pool: FrontDoorEndpointPool;
    targetContainerName: string;
    targetContainerPort: number;
  }>;
}

/**
 * Shared Cloud Map state across all services run in one
 * `cdkl start-service` invocation. The CLI builds this once and
 * threads the same object into every `startEcsService` call so peer
 * services discover each other through the shared `registry`.
 */
export interface ServiceDiscoveryContext {
  /** The in-process registry shared across every service in this CLI run. */
  registry: CloudMapRegistry;
  /**
   * Combined `CloudMapIndex` across every CDK stack we know about,
   * keyed by stack name so the runner can resolve a service's
   * `ServiceRegistries[].cloudMapServiceLogicalId` against the right
   * stack's index.
   */
  cloudMapIndexByStack: ReadonlyMap<string, CloudMapIndex>;
  /**
   * Single docker network shared across every replica boot in this
   * CLI invocation (design doc § 5 Option A). The CLI creates one
   * `cdkl-svc-<rand>` network at startup via
   * `createSharedSvcNetwork()` and tears it down at the end of the
   * run. Per-replica `runEcsTask()` calls receive this as
   * `existingNetwork` so every container joins the shared bridge —
   * peer services then reach each other by IP / network alias
   * without docker `network connect` choreography (design rejected
   * Option B for being "unwieldy and racy"). Undefined for callers
   * that opt out of shared mode (single-service runs that do not
   * need cross-service discovery).
   */
  sharedNetwork?: TaskNetwork;
}

/**
 * One running replica instance. The runner keeps the `EcsRunState`
 * around so the shutdown path can fan out cleanup across every
 * instance. `restartCount` lets the runner backoff before re-spinning a
 * crash-looping replica.
 */
export interface ServiceReplicaInstance {
  /** Replica index 0..desiredCount-1; load-bearing for per-instance docker network names. */
  index: number;
  /**
   * Phase 2 of issue #214 — `--watch` rolling-reload generation for this
   * replica's logical slot. Bumped each time {@link rollServiceReplica}
   * lands a shadow boot for index `i`. Steady-state replicas (initial
   * boot, restart-on-exit) carry generation `0` and the docker network /
   * Cloud Map / front-door owner-key names match Phase 1's wire format
   * exactly. Generation `> 0` appends a `-g<gen>` suffix to the
   * per-replica cluster name and a `:g<gen>` suffix to the ownerKey
   * prefix so a shadow replica can coexist with the dying old one for
   * the brief swap window without colliding on docker / registry keys.
   */
  generation: number;
  state: EcsRunState;
  /** Number of restarts since service boot. Drives the backoff schedule. */
  restartCount: number;
  /** Set when the replica is being torn down so the watcher skips it. */
  shuttingDown: boolean;
  /**
   * Cloud Map registry handles published for this replica. Cleared on
   * cleanup so the service's discovery footprint shrinks atomically
   * with the docker network teardown. Empty when the service has no
   * Service Connect / ServiceRegistries OR when `discovery` was not
   * supplied at startEcsService time.
   */
  cloudMapHandles: RegistrationHandle[];
  /**
   * Issue #86 v1 — owner key this replica's endpoint is registered under in
   * every front-door pool (`<serviceLogicalId>:r<index>`). Set after the
   * replica publishes its ephemeral host port; used by the restart / shutdown
   * paths to `pool.unregister` symmetrically. `undefined` when the service has
   * no front-door OR the replica hasn't published yet.
   */
  frontDoorOwnerKey: string | undefined;
  /**
   * In-flight `bootReplica()` promise when the watcher loop is mid-
   * restart (between the old state's cleanup and the new state being
   * fully populated). `ServiceController.shutdown()` awaits this BEFORE
   * iterating `instance.state.replicas` for cleanup — otherwise a
   * SIGTERM that lands between `instance.state = createEcsRunState()`
   * and `bootReplica()` finishing would call `cleanupEcsRun()` against
   * a freshly-allocated empty state while the in-flight boot was still
   * populating `instance.state.network` / `startedContainers`,
   * leaking the just-created docker network + sidecar.
   *
   * `undefined` when the replica is not currently restarting (steady
   * state — watching the running container). Declared as
   * `Promise<void> | undefined` (not `?:`) so the runner's
   * `instance.inFlightBoot = undefined` reset compiles under
   * `exactOptionalPropertyTypes`.
   */
  inFlightBoot: Promise<void> | undefined;
  /**
   * Phase 4 of issue #214 — set by {@link softReloadReplica} while a
   * `docker cp` + `docker restart` cycle is mid-flight against this
   * replica. The watcher loop's `await waitForExitImpl(id)` resolves
   * when `docker restart`'s stop phase fires SIGTERM, and the post-
   * exit branch would otherwise enter the restart-policy logic
   * (cleanup + bootReplica from scratch) and race the in-flight
   * `docker restart`. Checking the flag right after `waitForExitImpl`
   * returns + waiting until it clears keeps the watcher's
   * restart-on-exit semantics intact: a real crash still goes through
   * the restart branch, but a soft-reload-driven exit is treated as a
   * controlled restart and the watcher re-arms `docker wait` on the
   * (same-id) restarted container.
   *
   * `undefined` in steady state. Cleared by `softReloadReplica` after
   * the post-restart TCP-ready probe completes (success OR timeout —
   * the probe is best-effort, but the flag must clear so the watcher
   * is never wedged).
   */
  softReloadInProgress?: boolean;
  /**
   * Phase 4 follow-up (#218 code reviewer Nit #4) — monotonic
   * counter incremented at the START of each {@link softReloadReplica}
   * cycle. The watcher snapshots this BEFORE `waitForExitImpl` and
   * compares on resume; any mismatch means a soft-reload happened
   * mid-wait (even if it has since completed and cleared
   * {@link softReloadInProgress}), so the watcher treats the
   * waitForExit return as a controlled restart and re-arms instead
   * of falling into the restart-policy branch.
   *
   * Closes the race the Phase 4 PR's review surfaced: under docker
   * daemon backpressure, `docker wait` can lag the actual
   * SIGTERM-to-restart-complete cycle by ~10s+. If the lag exceeds
   * the soft-reload's runtime (sub-second typical), the flag has
   * cleared by the time `waitForExitImpl` resolves and the
   * `softReloadInProgress` check alone is not sufficient.
   *
   * Defaults to 0 at boot; bumped once per soft-reload entry.
   * Numbers are not load-bearing; only the change-vs-snapshot
   * comparison matters.
   */
  softReloadGeneration?: number;
  /**
   * Phase 4 follow-up (#218) — CDK asset hash of the image this
   * replica is currently running. Updated AFTER each successful
   * boot ({@link bootReplica}) and AFTER each successful soft-reload
   * ({@link softReloadReplica}'s re-publish step). Consulted by the
   * emulator's `loadAssetContextForTarget` as the `oldAssetHash`
   * baseline so the classifier's hash-unchanged guard reads the
   * LIVE replica's hash, not the boot-time descriptor.
   *
   * Pre-Phase-4 the loader read from `controller.service` (the
   * boot-time `ResolvedEcsService`), which was never updated when a
   * rolling reload swapped the replica to a new image. The stale
   * baseline caused soft-reload to fire on reload #2-after-rebuild
   * even when the synth produced identical content — wasteful but
   * correct (`docker cp` of identical bytes + `docker restart`). The
   * per-replica field closes that gap.
   *
   * `undefined` when the image isn't a CDK asset (ECR / public pin)
   * — the classifier already routes those to rebuild via the no-ctx
   * branch.
   */
  lastDeployedAssetHash?: string | undefined;
  /**
   * Last error from a failed run, if any. Surfaced in the shutdown
   * summary so users know why a degraded service ended up degraded.
   */
  lastError?: Error;
}

export interface ServiceRunState {
  /** All currently-tracked replicas (active OR shutting down). */
  replicas: ServiceReplicaInstance[];
  /** When true the watcher loop stops triggering restarts. */
  shuttingDown: boolean;
}

export function createServiceRunState(): ServiceRunState {
  return { replicas: [], shuttingDown: false };
}

/**
 * Compute the effective replica count for a service: the smaller of
 * `service.desiredCount` and `--max-tasks`, floored at 1. Pure-
 * functional so the CLI can show the user what cdk-local is about to do
 * before any docker calls fire.
 */
export function computeReplicaCount(desiredCount: number, maxTasks: number): number {
  if (maxTasks < 1) {
    throw new EcsServiceRunnerError(
      `--max-tasks must be >= 1 (got ${maxTasks}); local dev needs at least one running replica.`
    );
  }
  if (desiredCount <= 0) return 1;
  return Math.min(desiredCount, maxTasks);
}

/**
 * Exponential backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... Used
 * between restarts of a crash-looping replica so docker is not hammered
 * by the watcher loop. Exposed for unit testing.
 */
export function backoffDelayMs(restartCount: number): number {
  const base = 1000;
  const cap = 30_000;
  const factor = Math.pow(2, Math.min(restartCount, 10));
  return Math.min(base * factor, cap);
}

/**
 * Maximum number of replica indices the per-replica subnet allocator
 * can serve without modulo-wrap collision. The allocator below walks
 * the link-local /24 range `169.254.170.0..169.254.253.0` (84 octets)
 * and **skips 171** because that octet is owned by the shared-service
 * network in design § 5 Option A (see `SHARED_SVC_SUBNET_OCTET`), so
 * the usable count is 83. The CLI's `--max-tasks` parser enforces this
 * cap before any boot work fires.
 */
export const SUBNET_ALLOCATOR_RANGE = 83;

/**
 * Defensive per-replica subnet octet allocator (Issue #544). Only used
 * when callers bypass the CLI's `sharedNetwork` construction — i.e.
 * test paths that hand-build `ServiceRunnerOptions.discovery` without
 * `sharedNetwork`, or the bare `cdkl run-task`-shaped path that
 * runs one network per task. Production `cdkl start-service`
 * runs always go through the shared network (design § 5 Option A) so
 * this allocator is unreachable in the standard path.
 *
 * Returns the second-from-last octet of the per-replica /24 (170 →
 * `169.254.170.0/24`). Walks the 83-slot output range
 * `[170, 172, 173, ..., 253]` — 171 is intentionally **skipped**
 * because it's reserved for the shared-service network sidecar
 * (`SHARED_SVC_SUBNET_OCTET`), and assigning a per-replica network
 * the same /24 would have docker reject the duplicate-subnet
 * `network create` with the cryptic "Pool overlaps with other one on
 * this address space" error.
 */
export function pickSubnetOctet(index: number): number {
  const slot = ((index % SUBNET_ALLOCATOR_RANGE) + SUBNET_ALLOCATOR_RANGE) % SUBNET_ALLOCATOR_RANGE;
  // Output sequence: index 0 -> 170, index 1 -> 172, index 2 -> 173, ...
  // The range [170..253] has 84 entries; we drop one (SHARED_SVC_SUBNET_OCTET)
  // to keep every replica's subnet disjoint from the shared-service network.
  const base = 170;
  const candidate = base + slot;
  // Skip SHARED_SVC_SUBNET_OCTET by shifting every slot >= its offset
  // up by one. With base=170 and SHARED_SVC_SUBNET_OCTET=171, this
  // collapses to "slot 0 -> 170; slot 1+ -> 172..253" but stays
  // defensive if either constant moves in the future.
  return candidate < SHARED_SVC_SUBNET_OCTET ? candidate : candidate + 1;
}

/**
 * Decide whether a replica that just exited should restart. Pure-
 * functional so the watcher loop's policy is easy to unit-test.
 */
export function shouldRestart(
  exitCode: number,
  policy: ServiceRunnerOptions['restartPolicy']
): boolean {
  if (policy === 'none') return false;
  if (policy === 'always') return true;
  return exitCode !== 0;
}

/**
 * Long-running entry point. Boots `replicaCount` instances of the
 * service's task descriptor, returns a controller object the CLI uses
 * to (1) wait for the first failure that gives up restarting and (2)
 * shut every replica down on SIGINT / SIGTERM.
 *
 * The returned `shutdown()` is idempotent and safe to call from
 * multiple SIGINT handlers (CLI's single-flight pattern wraps it
 * anyway).
 */
export async function startEcsService(
  service: ResolvedEcsService,
  options: ServiceRunnerOptions,
  runState: ServiceRunState
): Promise<ServiceController> {
  const logger = getLogger().child('ecs-service');
  for (const w of service.warnings) logger.warn(w);

  const replicaCount = computeReplicaCount(service.desiredCount, options.maxTasks);
  if (replicaCount < service.desiredCount) {
    logger.warn(
      `Service '${service.serviceName}' template DesiredCount=${service.desiredCount} exceeds ` +
        `--max-tasks=${options.maxTasks}; running ${replicaCount} replica(s) locally. ` +
        'Raise --max-tasks to lift the cap, or accept the reduced concurrency for local dev.'
    );
  }
  logger.info(
    `Starting ECS service '${service.serviceName}' with ${replicaCount} replica(s) ` +
      `(restartPolicy=${options.restartPolicy})`
  );

  // Boot each replica sequentially so a first-replica failure surfaces
  // before we spend `docker run` budget on the rest. Once all are up
  // the watcher loop monitors them concurrently.
  for (let i = 0; i < replicaCount; i++) {
    const instance: ServiceReplicaInstance = {
      index: i,
      generation: 0,
      state: createEcsRunState(),
      restartCount: 0,
      shuttingDown: false,
      inFlightBoot: undefined,
      cloudMapHandles: [],
      frontDoorOwnerKey: undefined,
    };
    runState.replicas.push(instance);
    // Track the in-flight boot so a concurrent shutdown awaits it
    // before iterating `instance.state` for cleanup (same contract
    // as the watcher's restart branch — see `watchReplica` below).
    const bootPromise = bootReplica(service, options, instance);
    instance.inFlightBoot = bootPromise;
    try {
      await bootPromise;
    } catch (err) {
      // Boot failure of the FIRST replica is fatal — there is no
      // healthy replica to fall back to, and the runner contract is
      // "every replica is running before startEcsService returns".
      instance.lastError = err instanceof Error ? err : new Error(String(err));
      throw new EcsServiceRunnerError(
        `Failed to boot replica ${i} of service '${service.serviceName}': ` +
          `${instance.lastError.message}`
      );
    } finally {
      instance.inFlightBoot = undefined;
    }
  }

  // Wire each replica's exit-handler ONCE the boot is complete. The
  // watcher fires on essential-container exit and decides whether to
  // restart per `restartPolicy`.
  for (const instance of runState.replicas) {
    void watchReplica(service, options, instance, runState);
  }

  // Return the controller. The CLI keeps this alive until SIGINT.
  return new ServiceController(service, runState, options);
}

/**
 * Public controller surface. The CLI awaits `controller.waitForShutdown()`
 * to block until the user ^Cs. `controller.shutdown()` is wired into the
 * SIGINT / SIGTERM handlers.
 */
export class ServiceController {
  // Note: declared as plain fields (not parameter properties) because
  // `erasableSyntaxOnly` rejects `public readonly` constructor parameter
  // shorthand. The CLI reads `service` / `runState` / `options` so they
  // stay public-readable; runtime immutability is not enforced (TS-only
  // discipline).
  readonly service: ResolvedEcsService;
  readonly runState: ServiceRunState;
  readonly options: ServiceRunnerOptions;
  private shutdownResolve: (() => void) | undefined;
  private shutdownPromise: Promise<void>;
  /**
   * Single-flight wrapper for `shutdown()` so the fan-out cleanup runs
   * exactly once even when SIGINT and the CLI's outer `finally` both
   * fire (the canonical pattern documented in
   * `feedback_sigint_finally_cleanup_singleflight.md`). Built in the
   * constructor so every call to `shutdown()` resolves against the same
   * underlying promise.
   */
  private readonly runShutdown: () => Promise<void>;

  constructor(
    service: ResolvedEcsService,
    runState: ServiceRunState,
    options: ServiceRunnerOptions
  ) {
    this.service = service;
    this.runState = runState;
    this.options = options;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });
    this.runShutdown = singleFlight(() => this.doShutdown());
  }

  /**
   * Returns the count of currently-active (non-shutting-down) replicas.
   * Exposed so the CLI can surface a one-line "service is degraded"
   * banner when restarts stop firing.
   */
  activeReplicaCount(): number {
    return this.runState.replicas.filter((r) => !r.shuttingDown).length;
  }

  /**
   * Block until `shutdown()` is called. Used by the CLI as the
   * long-running blocking point — the SIGINT handler resolves it.
   */
  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  /**
   * Idempotent fan-out shutdown across every active replica. Wired into
   * both SIGINT and the outer `finally` of the CLI command; the
   * `singleFlight`-wrapped `runShutdown` collapses concurrent / repeated
   * callers to one underlying invocation.
   */
  async shutdown(): Promise<void> {
    await this.runShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    this.runState.shuttingDown = true;
    const logger = getLogger().child('ecs-service');
    logger.info(`Shutting down service '${this.service.serviceName}'...`);

    // Mark every replica as shutting-down BEFORE awaiting cleanup so
    // an in-flight watcher restart cannot resurrect it mid-cleanup.
    for (const r of this.runState.replicas) r.shuttingDown = true;

    // CRITICAL: await every in-flight `bootReplica()` BEFORE iterating
    // `instance.state` for cleanup. The watcher loop's restart branch
    // assigns `instance.state = createEcsRunState()` and then awaits
    // `bootReplica()` — if SIGTERM lands between those two lines, the
    // cleanup loop would call `cleanupEcsRun()` against the freshly-
    // allocated empty state while `bootReplica()` is still populating
    // it (creating a docker network + sidecar that nobody tracks).
    // Settle every in-flight boot first so cleanup sees the populated
    // state. `Promise.allSettled` because we don't care whether the
    // boot succeeded — the goal is to wait until the state is no
    // longer being mutated.
    const inFlightBoots = this.runState.replicas
      .map((r) => r.inFlightBoot)
      .filter((p): p is Promise<void> => p !== undefined);
    if (inFlightBoots.length > 0) {
      logger.debug(
        `Awaiting ${inFlightBoots.length} in-flight bootReplica() call(s) before cleanup...`
      );
      await Promise.allSettled(inFlightBoots);
    }

    await Promise.allSettled(
      this.runState.replicas.map(async (instance) => {
        // Issue #460 — drop every Cloud Map registration for this
        // replica BEFORE tearing the network down so a peer service
        // observing the registry during shutdown doesn't briefly see
        // an unreachable endpoint.
        if (this.options.discovery) {
          for (const handle of instance.cloudMapHandles) {
            try {
              this.options.discovery.registry.unregister(handle);
            } catch {
              /* registry op is sync + best-effort */
            }
          }
          instance.cloudMapHandles = [];
        }
        // Issue #86 v1 — drop this replica from every front-door pool.
        unregisterReplicaFromFrontDoor(instance, this.options.frontDoor);
        try {
          await cleanupEcsRun(instance.state, {
            keepRunning: this.options.taskOptions.keepRunning,
          });
        } catch (err) {
          logger.debug(
            `Replica ${instance.index} cleanup failed: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
    );
    this.shutdownResolve?.();
  }
}

/**
 * Build the `--network-alias` map for one service's containers (design
 * doc § 5 Option A). For every Service Connect entry, attach the
 * fqdn (`<discoveryName>.<namespaceName>`), the bare discoveryName,
 * AND every ClientAlias DnsName to the container that owns the
 * matching PortName. Other containers in the task get NO extra
 * aliases (only their default `--name`-derived alias from
 * `buildDockerRunArgs`).
 *
 * Aliases per container are de-duplicated so docker doesn't reject
 * a `--network-alias X` repeated against the same container.
 *
 * Returns an empty map when the service has no Service Connect — the
 * runner's `... .size > 0 ? { networkAliasesByContainer } : {}` guard
 * short-circuits in that case so backward-compat callers pay no cost.
 */
export function buildNetworkAliasesByContainer(
  service: ResolvedEcsService
): Map<string, ReadonlyArray<string>> {
  const out = new Map<string, string[]>();
  const sc = service.serviceConnect;
  if (!sc) return out as Map<string, ReadonlyArray<string>>;

  // PortName → container that declared it. AWS Service Connect uses
  // the first matching PortMappings[].Name to bind a service to a
  // container; cdk-local mirrors that. The resolver already throws
  // `EcsTaskResolutionError` on PortName mismatch BEFORE this runs
  // (`ecs-service-resolver.ts` `extractServiceConnect`), so `owner`
  // is always defined here in production. The defensive `continue`
  // below keeps the helper testable in isolation (callers that hand
  // in a service with a deliberately mismatched PortName, which the
  // unit tests do) without throwing twice from two layers.
  for (const entry of sc.services) {
    const owner = service.task.containers.find((c) =>
      c.portMappings.some((pm) => pm.name === entry.portName)
    );
    if (!owner) continue;
    const aliases: string[] = [];
    aliases.push(entry.discoveryName);
    aliases.push(`${entry.discoveryName}.${sc.namespaceName}`);
    for (const ca of entry.clientAliases) {
      if (ca.dnsName) aliases.push(ca.dnsName);
    }
    const existing = out.get(owner.name) ?? [];
    for (const a of aliases) {
      if (!existing.includes(a)) existing.push(a);
    }
    out.set(owner.name, existing);
  }
  return out as Map<string, ReadonlyArray<string>>;
}

/**
 * Boot a single replica. Mutates the supplied `instance.state` so the
 * shutdown path's `cleanupEcsRun(instance.state)` covers every partial
 * side effect. Network names are suffixed with the replica index so
 * docker doesn't collide on shared per-task network names when N > 1.
 */
async function bootReplica(
  service: ResolvedEcsService,
  options: ServiceRunnerOptions,
  instance: ServiceReplicaInstance
): Promise<void> {
  const logger = getLogger().child('ecs-service');
  // Per-replica cluster suffix: docker uses the network name as a key,
  // and the existing `createTaskNetwork` already appends a 6-char
  // random suffix, but using a stable replica index in the cluster
  // prefix makes per-replica logs easier to scan and prevents
  // accidental collisions if two replicas start on the same ms.
  // Phase 2 of issue #214 — the `--watch` rolling reload bumps
  // `instance.generation` per shadow boot so the new replica's docker
  // network name and Cloud Map / front-door ownerKey prefix don't
  // collide with the dying old replica's during the swap window.
  // Generation 0 (initial boot / restart-on-exit) keeps Phase 1's wire
  // format verbatim — no `-g` / `:g` suffix — so existing integ
  // assertions and the front-door pool's owner-key matching are
  // unchanged for non-watch runs.
  const gen = instance.generation;
  const genSuffix = gen > 0 ? `-g${gen}` : '';
  const ownerKeyGenSuffix = gen > 0 ? `:g${gen}` : '';
  const perReplicaCluster = `${options.taskOptions.cluster}-svc-${service.serviceLogicalId.toLowerCase()}-r${instance.index}${genSuffix}`;
  const ownerKeyPrefix = `${service.serviceLogicalId}:r${instance.index}${ownerKeyGenSuffix}`;
  // Build per-boot `--add-host` flags from the registry's current
  // snapshot — every peer service that booted BEFORE this replica is
  // resolvable as `<discoveryName>.<namespace>` and via any bare
  // ClientAlias short-form. Exclude self entries so a service that
  // registers under, say, `frontend.cdkl.local` does not
  // resolve to its own previous replica.
  const addHostFlags = options.discovery?.registry
    ? options.discovery.registry.buildAddHostFlags(ownerKeyPrefix)
    : [];
  // Network strategy:
  //   - With a shared discovery network (design § 5 Option A — the
  //     CLI-built `cdkl-svc-<rand>` network), every replica
  //     joins the SAME docker bridge; peer services are reachable by
  //     IP / network alias without cross-network bridging. The
  //     per-replica subnet allocator is unused in this mode.
  //   - Without a shared network (defensive fallback for callers
  //     that bypass the CLI's shared-context construction), the
  //     pre-Option-A formula applies: each replica gets a per-replica
  //     subnet octet from `pickSubnetOctet()` so concurrent replicas
  //     don't collide on a single /24 — but design § 5 Option B
  //     already rejected this for cross-service routing reasons.
  //     The allocator skips SHARED_SVC_SUBNET_OCTET (Issue #544) so
  //     a hand-built ServiceRunnerOptions.discovery that DOES
  //     pre-create the shared network doesn't collide on the same
  //     /24 here.
  const sharedNetwork = options.discovery?.sharedNetwork;
  const networkAliasesByContainer = buildNetworkAliasesByContainer(service);
  // Issue #585 — when this service boots more than one replica, every
  // replica maps the same container port, so a fixed host-port publish
  // makes the 2nd+ replica fail with `port is already allocated`. Drop
  // the `-p` flag for multi-replica services; peers still reach this
  // service by IP / network alias on the shared docker network. Gated
  // on the EFFECTIVE replica count (clamped by `--max-tasks`), not the
  // raw template DesiredCount — a DesiredCount: 2 service capped to 1
  // replica boots a single container and keeps its host-port publish.
  const replicaCount = computeReplicaCount(service.desiredCount, options.maxTasks);
  const skipHostPortPublish = replicaCount > 1;
  // Issue #86 v1 — ALB front-door. Publish each pool's target container port on
  // an ephemeral host port so the host-side front-door can round-robin to this
  // replica. Distinct ports only (two pools may target the same container port).
  const ephemeralPublishContainerPorts = options.frontDoor
    ? [...new Set(options.frontDoor.pools.map((p) => p.targetContainerPort))]
    : [];
  const perReplicaTaskOptions: RunEcsTaskOptions = {
    ...options.taskOptions,
    cluster: perReplicaCluster,
    // Detach is FORCED true at the runner layer — the service runner
    // takes over essential-container monitoring (so it can restart on
    // exit) rather than letting the task runner block on
    // `waitForContainerExit`. The CLI's `--detach` flag still controls
    // whether the SERVICE runs in the background; the per-replica
    // detach is internal plumbing.
    detach: true,
    ...(skipHostPortPublish ? { skipHostPortPublish: true } : {}),
    ...(sharedNetwork
      ? { existingNetwork: sharedNetwork }
      : { subnetOctet: pickSubnetOctet(instance.index) }),
    ...(addHostFlags.length > 0 ? { addHostFlags } : {}),
    ...(networkAliasesByContainer.size > 0 ? { networkAliasesByContainer } : {}),
    ...(ephemeralPublishContainerPorts.length > 0 ? { ephemeralPublishContainerPorts } : {}),
  };
  logger.info(`Booting replica ${instance.index} (${perReplicaCluster})`);
  await runEcsTask(service.task, perReplicaTaskOptions, instance.state);

  // Issue #227 — attach a per-container `docker logs -f` streamer so the
  // replica's application stdout / stderr surfaces in the foreground.
  // Default ON; flipped off by `--no-logs`. Attached AFTER `runEcsTask`
  // returns so `state.startedContainers` is fully populated. Pushed into
  // `state.logStoppers` so `cleanupEcsRun` drains + kills the streamer
  // on shutdown / restart-on-exit / rebuild rolling reload. The
  // soft-reload pathway preserves container IDs across `docker restart`,
  // so the same streamer keeps tailing the new PID-1 (no re-attach
  // needed).
  if (options.streamLogs !== false) {
    // Issue #227 review fix — use the resolver's `serviceDisplayName`
    // (NOT `serviceName`), which prefers an explicit CFn ServiceName,
    // then the cdk-path-derived construct id with CDK-internal
    // suffixes stripped, then the logicalId fallback. Without this an
    // L2 (FargateService / ApplicationLoadBalancedFargateService) with
    // no explicit `serviceName` would surface the hash-suffixed
    // logical id (e.g. `BackendApi5F9D8C32`) in every foreground line.
    for (const started of instance.state.startedContainers) {
      const prefix = `[svc=${service.serviceDisplayName} r=${instance.index} c=${started.name}] `;
      instance.state.logStoppers.push(attachContainerLogStreamer(prefix, started.id));
    }
  }

  // Cloud Map / Service Connect publish (Issue #460). Runs AFTER the
  // task boot so we know docker has assigned an IP. Best-effort: a
  // failed publish logs warn but does NOT abort the replica — the
  // replica is still alive, peer discovery just degrades.
  if (options.discovery) {
    await publishReplicaToCloudMap(service, instance, options.discovery, ownerKeyPrefix);
  }

  // Issue #86 v1 — ALB front-door publish. Discover the ephemeral host port
  // each target container port was published on and register it into the pool
  // so the host-side server can round-robin to this replica. Best-effort: a
  // failed lookup logs warn but does NOT abort the replica.
  if (options.frontDoor) {
    await publishReplicaToFrontDoor(
      service,
      instance,
      options.frontDoor,
      options.taskOptions.containerHost,
      ownerKeyPrefix
    );
  }

  // Phase 4 follow-up (#218) — stamp the live CDK asset hash on the
  // instance AFTER a successful boot. The emulator's
  // `loadAssetContextForTarget` reads this as the `oldAssetHash`
  // baseline so the classifier's hash-unchanged guard sees the LIVE
  // replica's hash, not the boot-time descriptor (which never
  // updates across rolling reloads). Undefined when the image isn't
  // a CDK asset — the classifier already routes those to rebuild.
  instance.lastDeployedAssetHash = pickEssentialAssetHash(service);
}

/**
 * Phase 4 follow-up (#218) — extract the CDK asset hash from a
 * resolved service's first essential container (with the same
 * fallback the watcher uses: first essential, else first container).
 * Returns `undefined` when the image isn't a CDK asset OR carries
 * no hash. Pure helper so the boot + rolling + soft-reload paths
 * share one source of truth for "what's running right now".
 *
 * Exported for unit tests; not part of the semver-covered public
 * surface.
 *
 * @internal
 */
export function pickEssentialAssetHash(service: ResolvedEcsService): string | undefined {
  const essential = service.task.containers.find((c) => c.essential) ?? service.task.containers[0];
  if (!essential) return undefined;
  // Defensive: existing test fixtures + hand-built run states may
  // omit `image` entirely (the runtime contract requires it, but
  // the stamp is best-effort + non-functional for those paths).
  const image = essential.image as { kind?: string; assetHash?: string } | undefined;
  if (image?.kind !== 'cdk-asset') return undefined;
  return image.assetHash;
}

/**
 * After the replica's main container is up, discover its docker
 * network IP and publish the configured Service Connect + Cloud Map
 * endpoints into the shared registry. The handles are tracked on the
 * instance so the shutdown / restart path can unregister symmetrically.
 *
 * Errors here are best-effort: docker inspect can fail right after run
 * (container vanished, network not fully wired), and the registry is
 * advisory — losing one replica's registration means peer services
 * can't reach it via the overlay, but it doesn't break that replica's
 * own work or AWS SDK calls.
 */
async function publishReplicaToCloudMap(
  service: ResolvedEcsService,
  instance: ServiceReplicaInstance,
  discovery: ServiceDiscoveryContext,
  ownerKeyPrefix: string
): Promise<void> {
  const logger = getLogger().child('ecs-service');
  const networkName = instance.state.network?.networkName;
  if (!networkName) return; // boot didn't get far enough to have a network

  // Pick the canonical container — Service Connect uses the producer
  // TaskDef's first essential container, mirroring AWS's ECS Agent.
  // The container's docker name is recorded in startedContainers.
  const essential = service.task.containers.find((c) => c.essential) ?? service.task.containers[0];
  if (!essential) return;
  const started = instance.state.startedContainers.find((c) => c.name === essential.name);
  if (!started) return;

  let ip: string | undefined;
  try {
    ip = await getContainerNetworkIp(started.id, networkName);
  } catch (err) {
    logger.warn(
      `Replica ${instance.index}: docker inspect failed before Cloud Map publish: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (!ip) {
    logger.warn(
      `Replica ${instance.index}: no docker IP discovered on network ${networkName}; ` +
        'skipping Cloud Map publish for this replica.'
    );
    return;
  }

  // Publish Service Connect entries. Each one carries:
  //   - canonical fqdn `<discoveryName>.<namespace>` (always)
  //   - bare alias `<dnsName>` for every ClientAlias with a DnsName
  if (service.serviceConnect) {
    const ns = service.serviceConnect.namespaceName;
    // Validate against the cloud-map index. The CLI passes the index
    // for the stack the service belongs to; an unmatched namespace
    // surfaces as a warn — registration still proceeds against the
    // literal name (so a CFn-but-not-CDK consumer that hand-rolled a
    // namespace can still discover the producer).
    const index = discovery.cloudMapIndexByStack.get(service.stack.stackName);
    if (index && !index.namespacesByName.has(ns)) {
      logger.warn(
        `ECS Service '${service.serviceLogicalId}' ServiceConnectConfiguration.Namespace='${ns}' ` +
          'does not match any AWS::ServiceDiscovery::PrivateDnsNamespace declared in stack ' +
          `${service.stack.stackName}. Publishing under the literal name anyway; peer services ` +
          'using the same literal will still discover this endpoint.'
      );
    }
    let i = 0;
    for (const entry of service.serviceConnect.services) {
      const ownerKey = `${ownerKeyPrefix}:sc:${i}`;
      const handle = discovery.registry.register(ns, entry.discoveryName, {
        ip,
        port: entry.containerPort,
        ownerKey,
      });
      instance.cloudMapHandles.push(handle);
      // Each ClientAlias with a DnsName becomes a bare-name alias
      // pointing at this fqdn.
      for (const alias of entry.clientAliases) {
        if (alias.dnsName) {
          discovery.registry.registerAlias(alias.dnsName, handle.fqdn);
        }
      }
      i++;
    }
  }

  // Publish ServiceRegistries[] entries. Each one references a
  // same-stack AWS::ServiceDiscovery::Service whose namespace +
  // discovery name we resolved at index-build time.
  if (service.serviceRegistries.length > 0) {
    const index = discovery.cloudMapIndexByStack.get(service.stack.stackName);
    if (!index) {
      logger.warn(
        `ECS Service '${service.serviceLogicalId}' declares ServiceRegistries[] but ${getEmbedConfig().productName} has ` +
          `no Cloud Map index for stack ${service.stack.stackName}. Skipping registration.`
      );
      return;
    }
    let j = 0;
    for (const reg of service.serviceRegistries) {
      const cm = index.servicesByLogicalId.get(reg.cloudMapServiceLogicalId);
      if (!cm) {
        logger.warn(
          `ECS Service '${service.serviceLogicalId}' ServiceRegistries[].cloudMapServiceLogicalId=` +
            `'${reg.cloudMapServiceLogicalId}' did not resolve to an AWS::ServiceDiscovery::Service ` +
            `in stack ${service.stack.stackName}. Skipping this registration.`
        );
        continue;
      }
      // Resolve port: explicit `ContainerPort` override > the
      // essential container's first port mapping. AWS-side
      // `ServiceRegistries[].ContainerName` (the sibling override
      // that says "register THIS container's IP rather than the
      // essential one") is intentionally IGNORED in v1 — every
      // container in the task shares the same docker network IP
      // (shared-network mode, design § 5 Option A), so picking a
      // different container would resolve to the same address.
      // Multi-IP-per-task is the `awsvpc` mode case which is itself
      // deferred to [#461]. If a sibling container exposes a
      // different port-mapping that the user wants registered, file
      // a follow-up — the in-process registry's `register()` API can
      // take the port verbatim once the resolver surfaces it.
      let port = reg.containerPort;
      if (port === undefined && essential.portMappings.length > 0) {
        port = essential.portMappings[0]!.containerPort;
      }
      if (port === undefined) {
        logger.warn(
          `ECS Service '${service.serviceLogicalId}' ServiceRegistries[] entry for Cloud Map ` +
            `service '${cm.logicalId}' has no resolvable container port; skipping.`
        );
        continue;
      }
      const ownerKey = `${ownerKeyPrefix}:sr:${j}`;
      const handle = discovery.registry.register(cm.namespaceName, cm.name, {
        ip,
        port,
        ownerKey,
      });
      instance.cloudMapHandles.push(handle);
      j++;
    }
  }
}

/**
 * Issue #86 v1 — register this replica's host-reachable endpoint into every
 * front-door pool. For each pool, find the target container's docker id, read
 * back the ephemeral host port docker assigned to its target container port
 * (`-p <host>::<port>`), and register `<containerHost>:<hostPort>` under the
 * per-replica owner key.
 *
 * Best-effort, mirroring `publishReplicaToCloudMap`: a missing container / port
 * logs a warn and skips that pool rather than aborting the replica (the
 * replica is alive; the front-door just can't route to it until it re-boots).
 * The owner key is stamped on the instance so the restart / shutdown paths can
 * `pool.unregister` symmetrically.
 */
async function publishReplicaToFrontDoor(
  service: ResolvedEcsService,
  instance: ServiceReplicaInstance,
  frontDoor: FrontDoorRunnerContext,
  containerHost: string,
  ownerKeyPrefix: string
): Promise<void> {
  const logger = getLogger().child('ecs-service');
  instance.frontDoorOwnerKey = ownerKeyPrefix;
  for (const target of frontDoor.pools) {
    const started = instance.state.startedContainers.find(
      (c) => c.name === target.targetContainerName
    );
    if (!started) {
      logger.warn(
        `ECS Service '${service.serviceLogicalId}' front-door: container ` +
          `'${target.targetContainerName}' did not start for replica ${instance.index}; ` +
          'the front-door cannot route to it.'
      );
      continue;
    }
    let hostPort: number | undefined;
    try {
      hostPort = await getPublishedHostPort(started.id, target.targetContainerPort);
    } catch (err) {
      logger.warn(
        `Replica ${instance.index}: docker inspect failed before front-door publish: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    if (hostPort === undefined) {
      logger.warn(
        `Replica ${instance.index}: container port ${target.targetContainerPort} on ` +
          `'${target.targetContainerName}' was not published on a host port; ` +
          'skipping front-door registration for this replica.'
      );
      continue;
    }
    target.pool.register(ownerKeyPrefix, { host: containerHost, port: hostPort });
    logger.debug(
      `Front-door: replica ${instance.index} registered at ${containerHost}:${hostPort} ` +
        `(container ${target.targetContainerName}:${target.targetContainerPort}).`
    );
  }
}

/**
 * Drop this replica's endpoint from every front-door pool. Idempotent; called
 * from the watcher restart branch and the controller shutdown path so a
 * dying / restarting replica is removed from round-robin before its container
 * is torn down.
 */
function unregisterReplicaFromFrontDoor(
  instance: ServiceReplicaInstance,
  frontDoor: FrontDoorRunnerContext | undefined
): void {
  if (!frontDoor || !instance.frontDoorOwnerKey) return;
  for (const target of frontDoor.pools) {
    target.pool.unregister(instance.frontDoorOwnerKey);
  }
  instance.frontDoorOwnerKey = undefined;
}

/**
 * Phase 2 of issue #214 — shadow-replica readiness probe budget.
 * Issue #265 bumped the default from 10s to 60s after multiple
 * production-shaped Node apps (TS->JS compile, full `node_modules`
 * graph, framework cold-start, DB pool init) tripped the 10s ceiling
 * on every save under `--watch`, breaking the rolling primitive's
 * zero-connection-refusal guarantee. 60s covers the realistic
 * 3-15s prod-shaped cold-start range plus outliers (heavy ORM /
 * Spring-style boot, debug `--inspect-brk` attach pause) without
 * tuning. Users with edge cases override via the per-command
 * `--shadow-ready-timeout <ms>` flag or the `${envPrefix}_SHADOW_READY_TIMEOUT_MS`
 * env var (e.g. `CDKL_SHADOW_READY_TIMEOUT_MS=120000`); the
 * `start-service` / `start-alb` boot path calls
 * {@link setShadowReadyTimeoutMs} once it has resolved the flag /
 * env / default precedence.
 *
 * The cost of an extra wait for a truly-broken container is bounded:
 * a crashed container surfaces via the runner's container-exit path
 * immediately — the TCP timeout branch only fires for "container UP
 * but not yet binding". A genuinely slow-binding app then gets a
 * clean swap.
 *
 * Mutable so unit tests can shrink the timeout window without
 * standing up a real clock; production callers leave the defaults.
 * Exposed via {@link __setShadowReadyConfig} (test-only) and
 * {@link setShadowReadyTimeoutMs} (boot path).
 */
let shadowReadyTimeoutMs = 60_000;
let shadowReadyIntervalMs = 100;

/**
 * Default shadow-replica TCP-ready probe budget when no
 * `--shadow-ready-timeout` flag and no `${envPrefix}_SHADOW_READY_TIMEOUT_MS`
 * env var are set. Mirrored in JSDoc above {@link shadowReadyTimeoutMs}.
 */
export const DEFAULT_SHADOW_READY_TIMEOUT_MS = 60_000;

/**
 * Boot-path setter for the shadow-replica TCP-ready probe budget.
 * Called once from `runEcsServiceEmulator` after resolving the
 * `--shadow-ready-timeout <ms>` flag and the
 * `${envPrefix}_SHADOW_READY_TIMEOUT_MS` env var (flag wins over env,
 * env wins over the {@link DEFAULT_SHADOW_READY_TIMEOUT_MS} default).
 *
 * Re-exported from `cdk-local/internal` so host CLIs (cdkd) that
 * wrap `runEcsServiceEmulator` can adopt the same flag / env
 * surface.
 *
 * @param timeoutMs Positive integer milliseconds; values <= 0 are
 * rejected by the CLI parser before reaching here.
 */
export function setShadowReadyTimeoutMs(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `setShadowReadyTimeoutMs: timeoutMs must be a positive finite number; got ${timeoutMs}.`
    );
  }
  shadowReadyTimeoutMs = timeoutMs;
}

/**
 * Test-only hook to shrink the shadow-replica TCP-ready probe's
 * timeout / poll interval so a `rollServiceReplica` unit test can
 * exercise the timeout branch without burning real seconds. Pass
 * `undefined` to restore the production defaults.
 *
 * @internal
 */
export function __setShadowReadyConfig(
  config: { timeoutMs: number; intervalMs: number } | undefined
): void {
  if (config === undefined) {
    shadowReadyTimeoutMs = 60_000;
    shadowReadyIntervalMs = 100;
    return;
  }
  shadowReadyTimeoutMs = config.timeoutMs;
  shadowReadyIntervalMs = config.intervalMs;
}

/**
 * Phase 2 of issue #214 — per-replica rolling reload primitive used by
 * `cdkl start-service --watch`. Boots one fresh "shadow" replica under a
 * bumped generation suffix, atomically swaps Cloud Map / front-door
 * registrations off the old replica, then stops and cleans up the old
 * container.
 *
 * Sequence:
 *   1. Locate the old replica by `oldReplicaIndex` (rejects when it's
 *      already shutting down or missing — the reloader must not race
 *      itself across overlapping firings, which the emulator's
 *      `reloadChain` serializer guarantees externally).
 *   2. Allocate a shadow {@link ServiceReplicaInstance} with the same
 *      logical `index` and `generation = old.generation + 1`. Appended
 *      to `runState.replicas` so a SIGTERM mid-roll tears it down too.
 *   3. `bootReplica(newService, newOptions, shadow)` boots the new
 *      container, publishes Cloud Map handles under the bumped
 *      generation suffix, and registers the shadow in the front-door
 *      pool. The OLD replica's handles + pool entry stay live during
 *      this window so consumers never see a gap.
 *   4. Atomically swap: unregister old's Cloud Map handles, drop its
 *      front-door pool entry, mark `oldInstance.shuttingDown = true`
 *      so the watcher exits. The shadow is already serving by this
 *      point.
 *   5. `cleanupEcsRun(oldInstance.state)` tears the old container +
 *      network down. The shadow remains in `runState.replicas`.
 *   6. Start the shadow's watcher so restart-on-exit is wired the
 *      same as Phase 1's boot loop.
 *
 * Failure modes:
 *   - `bootReplica` fails: keep the old replica serving. Best-effort
 *     teardown of partial shadow state. Re-throws so the reloader can
 *     log and continue with the remaining replicas.
 *   - Old shutdown fails: surfaced via the logger; the shadow is
 *     already live so the service stays available.
 *
 * @internal — wired only by the emulator's reload pathway.
 */
export async function rollServiceReplica(args: {
  /** Controller whose `runState.replicas[oldReplicaIndex]` is rolled. */
  controller: ServiceController;
  /**
   * Index INTO `controller.runState.replicas` (NOT the logical
   * replica index) of the old replica to retire. The shadow carries
   * the same `instance.index` as the old replica for log consistency.
   */
  oldReplicaIndex: number;
  /** Resolved task descriptor for the post-reload generation. */
  newService: ResolvedEcsService;
  /**
   * Runner options for the post-reload generation. Must share the
   * same `discovery.registry` + `frontDoor.pools` object identity as
   * the controller's original options so the shared Cloud Map /
   * front-door state stays consistent across the swap.
   */
  newOptions: ServiceRunnerOptions;
}): Promise<void> {
  const { controller, oldReplicaIndex, newService, newOptions } = args;
  const logger = getLogger().child('ecs-service');
  const oldInstance = controller.runState.replicas[oldReplicaIndex];
  if (!oldInstance) {
    throw new EcsServiceRunnerError(
      `rollServiceReplica: no replica at index ${oldReplicaIndex} ` +
        `(replicas=${controller.runState.replicas.length}).`
    );
  }
  if (oldInstance.shuttingDown) {
    // Common case: the watcher retired this replica between the
    // reloader's snapshot and this iteration (e.g. essential container
    // crashed with `restartPolicy=none`, watcher flipped
    // `instance.shuttingDown = true`). Don't crash the whole reload —
    // log + skip and let the next save start a fresh boot from a
    // clean state. The "concurrent roll" pathology the original guard
    // protected against is already prevented externally by the
    // emulator's `reloadChain` serializer.
    logger.warn(
      `Rolling replica r${oldInstance.index} (gen ${oldInstance.generation}): retired by its ` +
        'own watcher mid-roll (essential container exited). Skipping this slot; save again to ' +
        're-boot it.'
    );
    return;
  }

  // Single-replica host-port-publish carve-out: when the runner is
  // booting just ONE replica AND publishing a host port (the runner
  // emits `-p hostPort:containerPort`), both the old and a freshly-
  // booted shadow would try to bind the same host port. Docker rejects
  // the shadow's bind with `port is already allocated`, so the shadow
  // boot fails before its TCP-ready probe even runs. Mirror the
  // runner's `skipHostPortPublish = replicaCount > 1` criterion: when
  // the effective replica count is exactly 1, fall back to
  // stop-old-first → boot-new, accepting Phase 1's brief downtime
  // window per save (single-replica services have no second replica
  // to forward to anyway, so there's no continuity to preserve).
  // Multi-replica services boot the shadow first (host port is NOT
  // published, no collision) and atomically swap — the Phase 2 rolling
  // path.
  const effectiveReplicaCount = computeReplicaCount(newService.desiredCount, newOptions.maxTasks);
  const teardownOldFirst = effectiveReplicaCount === 1;

  const shadow: ServiceReplicaInstance = {
    index: oldInstance.index,
    generation: oldInstance.generation + 1,
    state: createEcsRunState(),
    restartCount: 0,
    shuttingDown: false,
    inFlightBoot: undefined,
    cloudMapHandles: [],
    frontDoorOwnerKey: undefined,
  };
  // Append BEFORE the boot so a SIGTERM mid-boot tears the partial
  // shadow state down too (same contract as the initial boot loop and
  // the watcher's restart branch — see the controller's `doShutdown`
  // which awaits every `inFlightBoot` before iterating for cleanup).
  controller.runState.replicas.push(shadow);

  if (teardownOldFirst) {
    // Single-replica path — Phase 1 behavior preserved: stop old then
    // boot new, accepting the brief per-save downtime.
    logger.info(
      `Rolling replica ${shadow.index} (gen ${shadow.generation}): single-replica + ` +
        'host-port publish — tearing old down before shadow boot to avoid host-port collision.'
    );
    if (newOptions.discovery) {
      for (const handle of oldInstance.cloudMapHandles) {
        try {
          newOptions.discovery.registry.unregister(handle);
        } catch {
          /* sync best-effort */
        }
      }
      oldInstance.cloudMapHandles = [];
    }
    unregisterReplicaFromFrontDoor(oldInstance, newOptions.frontDoor);
    oldInstance.shuttingDown = true;
    try {
      await cleanupEcsRun(oldInstance.state, {
        keepRunning: newOptions.taskOptions.keepRunning,
      });
    } catch (err) {
      logger.warn(
        `Rolling replica ${oldInstance.index}: cleanup of old (gen ${oldInstance.generation}) ` +
          `failed: ${err instanceof Error ? err.message : String(err)}. ` +
          'Attempting shadow boot anyway.'
      );
    }
    const oldIdx = controller.runState.replicas.indexOf(oldInstance);
    if (oldIdx !== -1) controller.runState.replicas.splice(oldIdx, 1);
  } else {
    logger.info(
      `Rolling replica ${shadow.index} (gen ${shadow.generation}): booting shadow before retiring old.`
    );
  }

  const bootPromise = (async (): Promise<void> => {
    await bootReplica(newService, newOptions, shadow);
    // After bootReplica returns, the shadow's docker container is
    // running and its Cloud Map / front-door registrations are
    // published — but the app inside the container may still be in
    // its startup window (TCP socket not yet bound). If we swapped
    // immediately, peer requests routed to the shadow during that
    // window would see ECONNREFUSED. Wait for the essential
    // container's first port to accept a TCP connection before
    // letting the swap proceed; failure is best-effort (warn + swap
    // anyway — the shadow's new image is the user's intent, and the
    // dying old replica's already-bound port is the WORSE
    // alternative once we tear it down).
    await waitForReplicaTcpReady(newService, shadow, {
      timeoutMs: shadowReadyTimeoutMs,
      intervalMs: shadowReadyIntervalMs,
    });
  })();
  shadow.inFlightBoot = bootPromise;
  try {
    await bootPromise;
  } catch (err) {
    // Shadow boot failed: the OLD replica still serves on the
    // multi-replica path. Tear down the shadow's partial state (likely
    // a half-created docker network + sidecar) so cleanup() doesn't
    // leak it.
    const shadowIdx = controller.runState.replicas.indexOf(shadow);
    if (shadowIdx !== -1) controller.runState.replicas.splice(shadowIdx, 1);
    try {
      await cleanupEcsRun(shadow.state, { keepRunning: false });
    } catch {
      /* best-effort */
    }
    if (teardownOldFirst) {
      // Single-replica path: old is already gone. Log a hint so the
      // user knows they're now dark and can save again with a clean
      // boot to recover.
      logger.error(
        `Rolling replica ${shadow.index}: shadow boot failed and the old replica was ` +
          'already torn down for the single-replica path. Save again with a clean boot to ' +
          're-start the service.'
      );
    }
    throw err;
  } finally {
    shadow.inFlightBoot = undefined;
  }

  if (teardownOldFirst) {
    // Single-replica path: old is already retired and shadow is up.
    // Wire the shadow's watcher and we're done.
    void watchReplica(newService, newOptions, shadow, controller.runState);
    logger.info(
      `Rolling replica ${shadow.index} (gen ${shadow.generation}): single-replica reload complete.`
    );
    return;
  }

  // Atomic swap — drop the OLD replica's Cloud Map handles + front-door
  // pool entries. Both are synchronous Map mutations after the shadow
  // already registered its own (under the bumped generation owner-key
  // suffix), so consumers never see a registration gap: during the
  // window between shadow register and old unregister, BOTH endpoints
  // are reachable.
  if (newOptions.discovery) {
    for (const handle of oldInstance.cloudMapHandles) {
      try {
        newOptions.discovery.registry.unregister(handle);
      } catch {
        /* sync best-effort */
      }
    }
    oldInstance.cloudMapHandles = [];
  }
  unregisterReplicaFromFrontDoor(oldInstance, newOptions.frontDoor);

  // BEFORE the docker-stop step, disconnect the old replica's
  // containers from the SHARED service network. Docker's embedded DNS
  // strips an alias the instant a container is disconnected, so a peer
  // resolving `srv` immediately after this step never picks the
  // about-to-be-stopped IP — closing the race window where
  // cleanupEcsRun's `docker stop → docker rm` leaves the container on
  // the network (DNS still resolving to it) while its app is already
  // gone (ECONNREFUSED). The shadow + every other live replica still
  // carry the alias on the shared network, so wget round-robin
  // trivially picks one of them. This step is only meaningful for the
  // rolling pathway — SIGINT-driven cleanup tears down the whole
  // network anyway.
  await disconnectOldFromSharedNetwork(oldInstance).catch((err) => {
    logger.debug(
      `Rolling replica ${oldInstance.index}: shared-network disconnect of old ` +
        `(gen ${oldInstance.generation}) failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Proceeding with cleanup (the docker-rm step still tears it down).'
    );
  });

  // Stop the old replica's watcher loop + tear its container down. The
  // watcher's `while (!instance.shuttingDown && !runState.shuttingDown)`
  // observes this flag at the top of its next iteration (or while
  // sleeping); the in-flight `waitForExitImpl` returns when `docker
  // wait` resolves on container removal. cleanupEcsRun also stops the
  // container so the wait resolves promptly.
  oldInstance.shuttingDown = true;
  try {
    await cleanupEcsRun(oldInstance.state, {
      keepRunning: newOptions.taskOptions.keepRunning,
    });
  } catch (err) {
    logger.warn(
      `Rolling replica ${oldInstance.index}: cleanup of old (gen ${oldInstance.generation}) ` +
        `failed: ${err instanceof Error ? err.message : String(err)}. The shadow is live; ` +
        'the stale container may need a manual `docker rm`.'
    );
  }

  // Remove old from runState.replicas. The shadow keeps the logical
  // index slot. We DO NOT splice oldInstance via its previous
  // oldReplicaIndex value because the shadow.push above shifted the
  // array; re-resolve via reference identity.
  const oldIdx = controller.runState.replicas.indexOf(oldInstance);
  if (oldIdx !== -1) controller.runState.replicas.splice(oldIdx, 1);

  // Wire the shadow's exit watcher so restart-on-exit is the same as
  // Phase 1's initial boot loop. Fire-and-forget; the watcher
  // returns when `shadow.shuttingDown` or `runState.shuttingDown`
  // flips.
  void watchReplica(newService, newOptions, shadow, controller.runState);

  logger.info(
    `Rolling replica ${shadow.index} (gen ${shadow.generation}): swap complete; old retired.`
  );
}

/**
 * Phase 4 of issue #214 — bind-mount source fast path. `docker cp` the
 * post-synth asset source directory into each essential container of
 * the live replica, then `docker restart` it. Skips `docker build`,
 * skips a shadow boot, and keeps the container's network IP / Cloud
 * Map / front-door pool registrations intact (the registrations key
 * off the docker-assigned IP and the published host port; `docker
 * restart` preserves both via the container's stable network
 * namespace), so NO registry swap is needed.
 *
 * Sequence (per replica, sequenced by the rolling loop one at a time
 * so peer services + the ALB front-door always have at least N-1 live
 * endpoints across the reload — same zero-connection-refusal guarantee
 * the Phase 2/3 rebuild pathway makes):
 *   1. Locate the live replica by {@link oldReplicaIndex}; reject when
 *      shutting down (the next save can roll a clean boot instead).
 *   2. Pre-restart DRAIN: drop the replica's Cloud Map handles + every
 *      front-door pool entry under its owner key. Both registries are
 *      synchronous Map mutations; once these complete, peer wget +
 *      front-door `next()` calls route to the surviving replicas. The
 *      handle / owner-key snapshots are kept on `instance.*` so the
 *      symmetric re-register step can pick them up (Cloud Map handles
 *      are rebuilt fresh via `publishReplicaToCloudMap`; the docker
 *      network IP is preserved across `docker restart` so the new
 *      handles point at the SAME endpoint).
 *   3. Set {@link ServiceReplicaInstance.softReloadInProgress} = true
 *      so the watcher's `waitForExitImpl` post-exit branch defers to
 *      the in-flight restart instead of re-bootstrapping the replica
 *      from scratch.
 *   4. For each essential container in the replica's started set:
 *      a. Resolve the container's image WORKDIR via `docker inspect`
 *         (default `/` when unset — matches Docker's runtime default
 *         for a Dockerfile with no `WORKDIR`).
 *      b. `docker cp <sourceDirToCopy>/. <containerId>:<workdir>/`
 *         — copy the synthesized asset directory's contents into the
 *         container at the WORKDIR. Trailing `/.` is critical: it
 *         copies the SOURCE DIRECTORY'S CONTENTS, not the directory
 *         itself, mirroring `cp -r src/. dst/`.
 *      c. `docker restart <containerId>` — cycle PID 1. Image,
 *         network namespace, and host-port publish are preserved.
 *   5. {@link waitForReplicaTcpReady} confirms the essential
 *      container's first port accepts a TCP connection.
 *   6. Post-TCP-ready RE-REGISTER: re-publish Cloud Map handles +
 *      front-door pool entry under the SAME per-replica owner key
 *      prefix used at initial boot, so the registrations remain
 *      idempotent across multiple `--watch` reloads. After this
 *      step, peers + the front-door route to the replica again.
 *   7. Clear `softReloadInProgress` in a `finally` so the watcher
 *      always exits its defer-loop, even on a docker error.
 *
 * Failure modes:
 *   - `docker inspect` / `docker cp` / `docker restart` errors:
 *     surfaced to the caller via a throw. The replica may be in an
 *     inconsistent state (drained from registries + partial cp + a
 *     possibly-crashed PID 1). The caller (`reloadAllServices`) logs
 *     the failure and continues with the remaining replicas; the
 *     drained state is intentionally NOT re-registered on error so
 *     peers + the front-door stop routing to a broken replica until
 *     the next clean save (or `^C` and re-run).
 *   - TCP probe timeout: best-effort warn (mirrors
 *     {@link rollServiceReplica}); the registrations are re-published
 *     anyway because the container IS up — just slow to bind. The
 *     dying-old-handles-AND-fresh-app-not-yet-listening worst case
 *     would otherwise leave the replica drained forever.
 *
 * Out of scope for the v1 primitive (deferred follow-ups):
 *   - Per-container WORKDIR caching across multiple essential
 *     containers in the same task. The `docker inspect` call is
 *     ~10ms; not worth the cache invalidation surface for a path
 *     fired ~once per save.
 *   - SIGHUP / `docker exec`-driven in-process reload. Image-specific
 *     (uvicorn / nodemon / etc.). `docker restart` is the universal
 *     primitive; signal-based reload is a future opt-in if the
 *     per-restart latency proves prohibitive.
 *
 * @internal — wired only by the emulator's reload pathway.
 */
export async function softReloadReplica(args: {
  /** Controller whose `runState.replicas[oldReplicaIndex]` is soft-reloaded. */
  controller: ServiceController;
  /**
   * Index INTO `controller.runState.replicas`. The replica's
   * docker network IP / Cloud Map / front-door pool registrations
   * survive the soft-reload unchanged.
   */
  oldReplicaIndex: number;
  /**
   * Resolved task descriptor for the post-reload generation. Used
   * only to identify essential containers + their TCP-ready port; the
   * image / env / mounts are NOT applied (those require a rebuild —
   * `docker restart` cycles PID 1 but does not re-create the
   * container with new spec).
   */
  newService: ResolvedEcsService;
  /**
   * Absolute path of the synthesized asset source directory (the
   * post-synth `<cdkout>/asset.<newHash>/`). `docker cp <dir>/.
   * <id>:<workdir>/` lands the contents of THIS directory into the
   * container's WORKDIR. The caller (the emulator's reload pathway)
   * derives this from the asset manifest of the freshly-synthed
   * stacks.
   */
  sourceDirToCopy: string;
}): Promise<void> {
  const { controller, oldReplicaIndex, newService, sourceDirToCopy } = args;
  const logger = getLogger().child('ecs-service');
  const instance = controller.runState.replicas[oldReplicaIndex];
  if (!instance) {
    throw new EcsServiceRunnerError(
      `softReloadReplica: no replica at index ${oldReplicaIndex} ` +
        `(replicas=${controller.runState.replicas.length}).`
    );
  }
  if (instance.shuttingDown) {
    logger.warn(
      `Soft-reload of replica r${instance.index} (gen ${instance.generation}): retired by its ` +
        'own watcher mid-reload. Skipping; save again to re-boot it from scratch.'
    );
    return;
  }

  // Resolve every essential container's started-container record so we
  // know which docker IDs to cp/restart. Mirror the picker the watcher
  // uses (first essential in template order; fall back to first
  // container when none flagged) and accept multi-essential tasks by
  // applying the fast path to every essential. Sidecars / non-
  // essential containers stay running through the cycle — they read
  // their inputs once at boot and `docker cp` of the source layer
  // doesn't affect them.
  const essentialContainers = newService.task.containers.filter((c) => c.essential);
  const containersToCycle =
    essentialContainers.length > 0
      ? essentialContainers
      : newService.task.containers.length > 0
        ? [newService.task.containers[0]!]
        : [];
  if (containersToCycle.length === 0) {
    throw new EcsServiceRunnerError(
      `softReloadReplica: service '${newService.serviceLogicalId}' has no containers to cycle.`
    );
  }

  const startedById = new Map(instance.state.startedContainers.map((c) => [c.name, c.id] as const));

  // Snapshot the live docker IDs before flipping the watcher-defer
  // flag so a missing essential container fails fast without leaving
  // the flag set.
  const targets: Array<{ name: string; id: string }> = [];
  for (const container of containersToCycle) {
    const id = startedById.get(container.name);
    if (!id) {
      throw new EcsServiceRunnerError(
        `softReloadReplica: replica r${instance.index} has no started container named ` +
          `'${container.name}' (started: ${[...startedById.keys()].join(', ') || 'none'}).`
      );
    }
    targets.push({ name: container.name, id });
  }

  // Phase 4 zero-refusal guarantee — drain BEFORE the docker restart.
  // The container's docker network IP and published host port are
  // preserved across `docker restart`, so the registrations could in
  // principle stay in place — BUT during the SIGTERM → restart window
  // (~1-2s on a typical interpreted handler), the container's app is
  // not accepting connections. Without a drain, the front-door pool's
  // round-robin would still pick this replica's endpoint and a host-
  // side request would observe ECONNREFUSED until the new PID 1 binds.
  // Mirror the watcher's restart-on-exit drain shape: drop Cloud Map
  // handles + the front-door pool entry now, re-publish after
  // {@link waitForReplicaTcpReady} confirms the new app is binding.
  // Single-replica services have no peer to route to either way — the
  // brief unavailability is identical to Phase 1's stop-old-first
  // single-replica behavior, so the drain is a no-op shape there.
  const controllerOptions = controller.options;
  if (controllerOptions.discovery) {
    for (const handle of instance.cloudMapHandles) {
      try {
        controllerOptions.discovery.registry.unregister(handle);
      } catch {
        /* sync best-effort */
      }
    }
    instance.cloudMapHandles = [];
  }
  unregisterReplicaFromFrontDoor(instance, controllerOptions.frontDoor);

  instance.softReloadInProgress = true;
  // Phase 4 follow-up (#218 code reviewer Nit #4) — bump the
  // soft-reload generation so the watcher's pre-`waitForExitImpl`
  // snapshot catches any soft-reload that runs to completion
  // during the wait (docker daemon backpressure can lag
  // `docker wait` past restart completion + flag clear). The
  // comparison runs in the watcher loop; the value itself is not
  // load-bearing.
  instance.softReloadGeneration = (instance.softReloadGeneration ?? 0) + 1;
  try {
    logger.info(
      `Soft-reloading replica r${instance.index} (gen ${instance.generation}): ` +
        `docker cp ${sourceDirToCopy} -> ${targets.length} essential container(s); restart.`
    );
    for (const target of targets) {
      // Resolve WORKDIR from the running container's image config.
      // Docker's runtime default when WORKDIR is unset is `/`, so an
      // empty inspect result maps to `/`. Most Dockerfiles set
      // WORKDIR to the same directory they COPY into; the user-side
      // workaround for a non-conforming Dockerfile (COPY into
      // `/opt/app` while WORKDIR is `/`) is to set WORKDIR to the
      // COPY target — documented as a known Phase 4 limitation.
      let workdir: string;
      try {
        workdir = (await dockerInspectWorkdirImpl(target.id)) || '/';
      } catch (err) {
        throw new EcsServiceRunnerError(
          `softReloadReplica: docker inspect of container '${target.name}' (${target.id}) ` +
            `failed: ${err instanceof Error ? err.message : String(err)}. ` +
            'This replica is unregistered from Cloud Map + the front-door pool until the ' +
            'next save triggers another reload.'
        );
      }
      // Trailing `/.` on the source: copies CONTENTS, not the dir
      // itself. Trailing `/` on the dest: ensures the dest is
      // interpreted as a directory (else docker cp would rename the
      // source to that path when it doesn't exist yet). Normalize so
      // a workdir that already ends in `/` (e.g. the empty-WORKDIR
      // fallback to `/`) doesn't produce `cid://`.
      const workdirDest = workdir.endsWith('/') ? workdir : `${workdir}/`;
      try {
        await dockerCpImpl(`${sourceDirToCopy}/.`, `${target.id}:${workdirDest}`);
      } catch (err) {
        throw new EcsServiceRunnerError(
          `softReloadReplica: docker cp into '${target.name}' (${target.id}:${workdir}) ` +
            `failed: ${err instanceof Error ? err.message : String(err)}. ` +
            'This replica is unregistered from Cloud Map + the front-door pool until the ' +
            'next save triggers another reload.'
        );
      }
      try {
        await dockerRestartImpl(target.id);
      } catch (err) {
        throw new EcsServiceRunnerError(
          `softReloadReplica: docker restart of '${target.name}' (${target.id}) ` +
            `failed: ${err instanceof Error ? err.message : String(err)}. ` +
            'This replica is unregistered from Cloud Map + the front-door pool until the ' +
            'next save triggers another reload.'
        );
      }
    }
    // The TCP-ready probe re-uses the rolling pathway's helper —
    // identical semantics (poll the essential container's first port
    // on the docker network IP). The instance object's `state.network`
    // and `state.startedContainers` are unchanged by `docker restart`,
    // so the probe targets the same address it would in steady state.
    await waitForReplicaTcpReady(newService, instance, {
      timeoutMs: shadowReadyTimeoutMs,
      intervalMs: shadowReadyIntervalMs,
      label: `Soft-reloaded replica r${instance.index} (gen ${instance.generation})`,
    });
    // Re-register Cloud Map + front-door pool entries under the SAME
    // per-replica owner-key prefix used at initial boot. Generation
    // does not bump on a soft-reload (no shadow container, no new
    // logical slot), so the prefix is `<svc>:r<i>` (steady-state
    // shape) or `<svc>:r<i>:g<gen>` when a previous reload already
    // bumped the generation — same formula `bootReplica` computes.
    // Best-effort: a re-publish failure logs at warn (the publish
    // helpers already do) and leaves the replica drained until the
    // next save; the container is still serving locally on its
    // docker IP, just not reachable via Cloud Map / front-door until
    // re-published. We re-publish AFTER the TCP-ready probe so peers
    // never resolve a non-listening endpoint.
    const ownerKeyGenSuffix = instance.generation > 0 ? `:g${instance.generation}` : '';
    const ownerKeyPrefix = `${newService.serviceLogicalId}:r${instance.index}${ownerKeyGenSuffix}`;
    if (controllerOptions.discovery) {
      await publishReplicaToCloudMap(
        newService,
        instance,
        controllerOptions.discovery,
        ownerKeyPrefix
      );
    }
    if (controllerOptions.frontDoor) {
      await publishReplicaToFrontDoor(
        newService,
        instance,
        controllerOptions.frontDoor,
        controllerOptions.taskOptions.containerHost,
        ownerKeyPrefix
      );
    }
    // Phase 4 follow-up (#218) — stamp the post-soft-reload asset
    // hash on the instance so the next reload's classifier reads the
    // CURRENT image's hash, not the boot-time descriptor's. Closes
    // the chatty-soft-reload-after-rebuild loop.
    instance.lastDeployedAssetHash = pickEssentialAssetHash(newService);
    logger.info(
      `Soft-reloaded replica r${instance.index} (gen ${instance.generation}): ${SOFT_RELOAD_COMPLETION_LOG_SUFFIX}`
    );
  } finally {
    // Always clear the flag — the watcher's defer-loop polls this
    // every 100ms and a wedged flag would keep restart-on-exit dead
    // for the rest of the replica's life.
    instance.softReloadInProgress = false;
  }
}

/**
 * Production `docker inspect --format {{.Config.WorkingDir}} <id>`
 * impl. Returns the container's runtime WORKDIR; empty string when
 * the Dockerfile didn't set one (caller treats empty as `/`, matching
 * Docker's runtime default).
 *
 * Extracted as a test-overridable function so the soft-reload
 * primitive's unit tests can assert the WORKDIR resolution branch
 * without standing up a real container.
 */
const defaultDockerInspectWorkdirImpl = async (containerId: string): Promise<string> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { getDockerCmd } = await import('../utils/docker-cmd.js');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(getDockerCmd(), [
    'inspect',
    '--format',
    '{{.Config.WorkingDir}}',
    containerId,
  ]);
  return stdout.trim();
};

let dockerInspectWorkdirImpl: (containerId: string) => Promise<string> =
  defaultDockerInspectWorkdirImpl;

/**
 * Test-only hook to substitute the `docker inspect` step the
 * soft-reload primitive runs before `docker cp`. Pass `undefined`
 * to restore the production `execFile`-backed impl.
 *
 * @internal
 */
export function __setDockerInspectWorkdirImpl(
  impl: ((containerId: string) => Promise<string>) | undefined
): void {
  if (impl === undefined) {
    dockerInspectWorkdirImpl = defaultDockerInspectWorkdirImpl;
    return;
  }
  dockerInspectWorkdirImpl = impl;
}

/**
 * Production `docker cp <src> <containerId>:<dst>` impl. The source
 * path's trailing `/.` ensures CONTENTS of the directory are copied
 * (not the directory itself); the caller is responsible for that
 * convention.
 */
const defaultDockerCpImpl = async (src: string, dst: string): Promise<void> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { getDockerCmd } = await import('../utils/docker-cmd.js');
  const execFileAsync = promisify(execFile);
  await execFileAsync(getDockerCmd(), ['cp', src, dst], {
    // Asset trees can be large (a Node project's bundled JS + assets
    // easily exceeds the default 1MB buffer); raise to 64MB so docker
    // cp's stdout summary doesn't truncate. cp itself streams via the
    // docker daemon, not stdout, so the buffer cap is only for status.
    maxBuffer: 64 * 1024 * 1024,
  });
};

let dockerCpImpl: (src: string, dst: string) => Promise<void> = defaultDockerCpImpl;

/**
 * Test-only hook to substitute the `docker cp` step the soft-reload
 * primitive runs. Pass `undefined` to restore the production
 * `execFile`-backed impl.
 *
 * @internal
 */
export function __setDockerCpImpl(
  impl: ((src: string, dst: string) => Promise<void>) | undefined
): void {
  if (impl === undefined) {
    dockerCpImpl = defaultDockerCpImpl;
    return;
  }
  dockerCpImpl = impl;
}

/**
 * Production `docker restart <id>` impl. Synchronous in docker's
 * sense — blocks until the container is up again (or fails).
 */
const defaultDockerRestartImpl = async (containerId: string): Promise<void> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { getDockerCmd } = await import('../utils/docker-cmd.js');
  const execFileAsync = promisify(execFile);
  await execFileAsync(getDockerCmd(), ['restart', containerId]);
};

let dockerRestartImpl: (containerId: string) => Promise<void> = defaultDockerRestartImpl;

/**
 * Test-only hook to substitute the `docker restart` step the
 * soft-reload primitive runs. Pass `undefined` to restore the
 * production `execFile`-backed impl.
 *
 * @internal
 */
export function __setDockerRestartImpl(
  impl: ((containerId: string) => Promise<void>) | undefined
): void {
  if (impl === undefined) {
    dockerRestartImpl = defaultDockerRestartImpl;
    return;
  }
  dockerRestartImpl = impl;
}

/**
 * Phase 2 of issue #214 — disconnect every container of the dying
 * replica from the shared service network BEFORE `cleanupEcsRun`'s
 * `docker stop → docker rm` sequence. Docker's embedded DNS strips an
 * alias the instant a container is disconnected, so a peer resolving
 * the service's Service Connect / Cloud Map alias right after this
 * step never picks the dying container's IP — closing the race window
 * where the alias points at an IP whose app is already gone. Best-
 * effort: a disconnect failure logs at debug and `cleanupEcsRun`'s
 * `docker rm -f` will still tear the network membership down.
 *
 * No-op for replicas that aren't on a shared network (the defensive
 * "per-replica /24" fallback path); the per-replica network is
 * destroyed by `cleanupEcsRun` directly.
 */
async function disconnectOldFromSharedNetwork(oldInstance: ServiceReplicaInstance): Promise<void> {
  const network = oldInstance.state.network;
  if (!network || !network.ownedByCaller) return;
  const networkName = network.networkName;
  // Sidecar is owned by the run-state too but lives in its own
  // network namespace inside the SAME shared net. Disconnect it AND
  // every started container so wget's Docker DNS lookup misses the
  // dying replica entirely after this point.
  const targets: string[] = [];
  if (network.sidecarContainerId) targets.push(network.sidecarContainerId);
  for (const c of oldInstance.state.startedContainers) targets.push(c.id);
  for (const id of targets) {
    try {
      // `--force` so a stop-then-disconnect race (rare; cleanupEcsRun
      // calls stop AFTER this point in production, but a SIGTERM
      // landing mid-roll could overlap) doesn't error out the rest
      // of the disconnect loop.
      await dockerNetworkDisconnectImpl(networkName, id);
    } catch (err) {
      // Caller logs at debug — emit nothing here so the noise
      // budget stays low when the container is already gone (docker
      // exits non-zero with "not connected"-style errors which are
      // benign for our purposes).
      void err;
    }
  }
}

/**
 * Production `docker network disconnect --force <network> <id>` impl,
 * extracted as a test-overridable function so the rolling-primitive
 * unit test can assert this step actually ran (the reviewer flagged
 * that the test mock previously took the `!ownedByCaller` early-return
 * path and silently never entered the disconnect branch).
 */
const defaultDockerNetworkDisconnectImpl = async (
  networkName: string,
  containerId: string
): Promise<void> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { getDockerCmd } = await import('../utils/docker-cmd.js');
  const execFileAsync = promisify(execFile);
  await execFileAsync(getDockerCmd(), [
    'network',
    'disconnect',
    '--force',
    networkName,
    containerId,
  ]);
};

let dockerNetworkDisconnectImpl: (networkName: string, containerId: string) => Promise<void> =
  defaultDockerNetworkDisconnectImpl;

/**
 * Test-only hook to substitute / spy on the `docker network disconnect`
 * step the rolling primitive runs before tearing the old replica down.
 * Pass `undefined` to restore the production `execFile`-backed impl.
 *
 * @internal
 */
export function __setDockerNetworkDisconnectImpl(
  impl: ((networkName: string, containerId: string) => Promise<void>) | undefined
): void {
  if (impl === undefined) {
    dockerNetworkDisconnectImpl = defaultDockerNetworkDisconnectImpl;
    return;
  }
  dockerNetworkDisconnectImpl = impl;
}

/**
 * Phase 2 of issue #214 — shadow-replica TCP readiness probe used by
 * {@link rollServiceReplica} before the atomic registry swap. Polls the
 * essential container's first port mapping (the one Cloud Map / Service
 * Connect publishes) via TCP-connect on the shadow's docker network IP,
 * retrying every `intervalMs` until either the connect succeeds or the
 * timeout elapses.
 *
 * The probe is best-effort: a timeout logs a warn but DOES NOT throw.
 * Swapping anyway is the lesser evil — the dying old replica's image
 * is about to be torn down, and the shadow's new image is the user's
 * intent. A timed-out probe usually means the app inside the new image
 * has a startup bug; the user will see the connection failures on
 * their probe / curl and fix the app, then save again. Failing the
 * roll here would leave the OLD replica running on stale code with no
 * recovery path other than `^C`.
 *
 * Exposed for the unit test pattern: the probe's `connect` impl is
 * injectable via {@link __setTcpProbeImpl} so the rolling-primitive
 * unit test can avoid any real TCP socket.
 */
async function waitForReplicaTcpReady(
  service: ResolvedEcsService,
  replica: ServiceReplicaInstance,
  opts: { timeoutMs: number; intervalMs: number; label?: string }
): Promise<void> {
  const logger = getLogger().child('ecs-service');
  // Phase 4 of issue #214 — `label` distinguishes the rolling pathway's
  // "shadow replica" prose from the soft-reload pathway's "replica" prose
  // in the warn / debug log lines. Defaults to the shadow phrasing so
  // existing callers (Phase 2 rolling primitive) are unchanged.
  const label = opts.label ?? `Shadow replica r${replica.index} (gen ${replica.generation})`;
  const networkName = replica.state.network?.networkName;
  if (!networkName) return; // boot didn't get far enough; the caller's catch handles it

  const essential = service.task.containers.find((c) => c.essential) ?? service.task.containers[0];
  if (!essential || essential.portMappings.length === 0) {
    // No essential container or no port to probe — nothing to wait
    // on. Common for sidecar-only services or tasks that the user
    // expects to drive externally.
    return;
  }
  const started = replica.state.startedContainers.find((c) => c.name === essential.name);
  if (!started) return;

  let ip: string;
  try {
    const resolved = await getContainerNetworkIp(started.id, networkName);
    if (!resolved) return;
    ip = resolved;
  } catch (err) {
    logger.warn(
      `${label}: TCP-ready probe could not resolve docker IP: ` +
        `${err instanceof Error ? err.message : String(err)}. Proceeding.`
    );
    return;
  }

  const port = essential.portMappings[0]!.containerPort;
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeoutMs;
  let lastErr: string | undefined;
  while (Date.now() < deadline) {
    try {
      await tcpProbeImpl(ip, port);
      // Issue #265 — surface the elapsed-ms on success so users
      // tuning `--shadow-ready-timeout` (or
      // `${envPrefix}_SHADOW_READY_TIMEOUT_MS`) know what budget to
      // set. Kept at debug level so it only shows under verbose.
      const elapsedMs = Date.now() - startedAt;
      logger.debug(`${label}: TCP probe ${ip}:${port} accepted in ${elapsedMs}ms.`);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(opts.intervalMs);
  }
  logger.warn(
    `${label}: TCP probe ${ip}:${port} did not accept within ${opts.timeoutMs}ms ` +
      `(last: ${lastErr ?? 'n/a'}). Proceeding anyway — the new source is the user ` +
      'intent. Initial requests may 502 until the app finishes binding.'
  );
}

/**
 * Default TCP-connect probe used by {@link waitForReplicaTcpReady}.
 * Opens a socket to `host:port` and resolves on `connect`; rejects on
 * any error. The socket is destroyed immediately on connect — we don't
 * want to keep a connection open or send any bytes.
 */
const defaultTcpProbeImpl = async (host: string, port: number): Promise<void> => {
  const { createConnection } = await import('node:net');
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const onError = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', onError);
  });
};

let tcpProbeImpl: (host: string, port: number) => Promise<void> = defaultTcpProbeImpl;

/**
 * Test-only hook to short-circuit the TCP-connect probe in unit tests
 * (the runner's rolling primitive's pre-swap readiness gate). Pass
 * `undefined` to restore the production `node:net` `createConnection`
 * implementation.
 *
 * @internal
 */
export function __setTcpProbeImpl(
  impl: ((host: string, port: number) => Promise<void>) | undefined
): void {
  if (impl === undefined) {
    tcpProbeImpl = defaultTcpProbeImpl;
    return;
  }
  tcpProbeImpl = impl;
}

/**
 * Long-running watcher loop for one replica. Polls the essential
 * container's exit code via `docker wait`; on exit, decides whether to
 * restart per `restartPolicy` + applies exponential backoff. The loop
 * exits only when the replica's `shuttingDown` flag is set.
 */
async function watchReplica(
  service: ResolvedEcsService,
  options: ServiceRunnerOptions,
  instance: ServiceReplicaInstance,
  runState: ServiceRunState
): Promise<void> {
  const logger = getLogger().child('ecs-service');
  while (!instance.shuttingDown && !runState.shuttingDown) {
    const essentialId = pickEssentialContainerId(instance, service);
    if (!essentialId) {
      // The container exited and was cleaned up between iterations of
      // the loop; the previous restart branch will have been the cause.
      // Break and let the outer loop's restart branch re-enter.
      await sleep(500);
      continue;
    }
    // Phase 4 follow-up (#218 code reviewer Nit #4) — snapshot the
    // soft-reload generation BEFORE the (potentially long) docker
    // wait so we can detect a soft-reload that ran end-to-end during
    // the wait. The `softReloadInProgress` check alone is not
    // sufficient: under docker daemon backpressure, `docker wait`
    // can lag past the soft-reload's flag clear (~10s+), leaving
    // the watcher to enter the restart-policy branch against a
    // healthy, just-re-registered container.
    const softReloadGenBeforeWait = instance.softReloadGeneration ?? 0;
    let exitCode: number;
    try {
      exitCode = await waitForExitImpl(essentialId);
    } catch (err) {
      // `docker wait` failures (e.g. container already removed) are
      // surfaced as "exited with -1" — same shape as the runner's
      // wait helper so the restart branch's decision is consistent.
      logger.debug(
        `docker wait failed for replica ${instance.index}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      exitCode = -1;
    }
    if (instance.shuttingDown || runState.shuttingDown) return;

    // Phase 4 of issue #214 — soft-reload pathway: `docker restart`
    // fires SIGTERM at PID 1, which resolves `waitForExitImpl` here
    // even though the container is being intentionally cycled.
    //
    // Two paths to defer:
    //   1. `softReloadInProgress` is still set — soft-reload is
    //      mid-flight. Wait until it clears, then re-arm.
    //   2. `softReloadGeneration` changed during the wait — a
    //      complete soft-reload happened between waitForExit's
    //      arming and its return (the daemon-lag race). Same outcome:
    //      treat as a controlled restart, re-arm.
    //
    // A real crash that lands DURING a soft-reload still gets
    // handled by the soft-reload's own error path; the watcher
    // doesn't need to second-guess it here.
    const softReloadHappenedMidWait =
      (instance.softReloadGeneration ?? 0) !== softReloadGenBeforeWait;
    if (instance.softReloadInProgress || softReloadHappenedMidWait) {
      while (instance.softReloadInProgress && !instance.shuttingDown && !runState.shuttingDown) {
        await sleep(100);
      }
      if (instance.shuttingDown || runState.shuttingDown) return;
      continue;
    }

    logger.warn(
      `Replica ${instance.index} essential container exited with code ${exitCode} ` +
        `(restartCount=${instance.restartCount}).`
    );
    // Surface the container's log tail so the user sees WHY it exited
    // (run-task streams logs in the foreground, but detached service
    // replicas otherwise leave the exit unexplained). Dump on the first
    // failure and on the terminal degraded exit, but NOT on every
    // restart cycle of a crash loop.
    const willRestart = shouldRestart(exitCode, options.restartPolicy);
    if (!willRestart || instance.restartCount === 0) {
      await printExitedContainerLogs(instance.index, essentialId, logger);
    }
    if (!willRestart) {
      logger.warn(
        `Replica ${instance.index} not restarting (policy=${options.restartPolicy}, ` +
          `exit=${exitCode}). Service running in degraded mode.`
      );
      // Mark this replica as shutting-down so the controller's
      // `activeReplicaCount` reflects the degradation but DO NOT call
      // cleanupEcsRun here — the controller's shutdown path is the
      // single owner of teardown, and racing it from the watcher
      // corrupts the shared run-state via the same SIGINT-during-
      // cleanup pattern that `feedback_sigint_finally_cleanup_singleflight.md`
      // documents.
      instance.shuttingDown = true;
      return;
    }

    // Backoff before restarting.
    const delay = backoffDelayMs(instance.restartCount);
    logger.info(`Restarting replica ${instance.index} in ${delay}ms...`);
    await sleep(delay);
    if (instance.shuttingDown || runState.shuttingDown) return;

    // Drop Cloud Map registrations from the dying replica before its
    // network teardown — peers should not route to the about-to-be-
    // killed container.
    if (options.discovery) {
      for (const handle of instance.cloudMapHandles) {
        try {
          options.discovery.registry.unregister(handle);
        } catch {
          /* sync + best-effort */
        }
      }
      instance.cloudMapHandles = [];
    }
    // Issue #86 v1 — drop this replica from the front-door round-robin before
    // its container is torn down so in-flight requests aren't routed to a
    // dying replica.
    unregisterReplicaFromFrontDoor(instance, options.frontDoor);

    // Tear down the old per-replica run-state before re-booting (else
    // the new boot collides on the docker network name).
    try {
      await cleanupEcsRun(instance.state, {
        keepRunning: false, // restart MUST clean the dead containers regardless of --keep-running
      });
    } catch (err) {
      logger.debug(
        `Replica ${instance.index} pre-restart cleanup failed: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
    instance.state = createEcsRunState();
    instance.restartCount += 1;

    // Race-safety: `instance.state = createEcsRunState()` above + the
    // upcoming `bootReplica()` populating it is the SIGTERM-mid-restart
    // hazard. Track the in-flight boot so the controller's `shutdown()`
    // can `Promise.allSettled` against it BEFORE iterating the
    // replica's state for cleanup — otherwise the cleanup loop would
    // race the boot and orphan the freshly-created docker network +
    // sidecar.
    const bootPromise = bootReplica(service, options, instance);
    instance.inFlightBoot = bootPromise;
    try {
      await bootPromise;
    } catch (err) {
      instance.lastError = err instanceof Error ? err : new Error(String(err));
      logger.error(
        `Replica ${instance.index} restart failed: ` +
          `${instance.lastError.message}. Service running in degraded mode.`
      );
      // Same single-owner rule as above — mark and exit, don't
      // cleanup from the watcher.
      instance.shuttingDown = true;
      return;
    } finally {
      instance.inFlightBoot = undefined;
    }
  }
}

function pickEssentialContainerId(
  instance: ServiceReplicaInstance,
  service?: ResolvedEcsService
): string | undefined {
  // Mirror the task runner's essential-container selection: first
  // container marked `essential: true`, else first container in
  // template order. The task runner records started containers in
  // start order (dependency-resolved), so we walk the service's task
  // descriptor (in template order) to find the first essential one
  // and look it up by name in `startedContainers`.
  if (service) {
    const essential =
      service.task.containers.find((c) => c.essential) ?? service.task.containers[0];
    if (essential) {
      const started = instance.state.startedContainers.find((c) => c.name === essential.name);
      if (started) return started.id;
    }
  }
  // Fallback: first started container. Used when the service handle
  // isn't threaded through (test-only paths).
  return instance.state.startedContainers[0]?.id;
}

/**
 * Production `docker wait <id>` implementation. Captured once so the
 * test override can restore it without duplicating the body.
 */
const defaultWaitForExitImpl = async (containerId: string): Promise<number> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { getDockerCmd } = await import('../utils/docker-cmd.js');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(getDockerCmd(), ['wait', containerId], {
    maxBuffer: 1024 * 1024,
  });
  const code = parseInt(stdout.trim(), 10);
  return Number.isFinite(code) ? code : -1;
};

/**
 * `docker wait <id>` returns the exit code on stdout. Extracted as a
 * test-overridable function so unit tests do not need a real container.
 */
let waitForExitImpl: (containerId: string) => Promise<number> = defaultWaitForExitImpl;

/**
 * Test-only hook to inject a synthetic exit-code stream without docker.
 * Restores the production implementation when called with `undefined`.
 */
export function __setWaitForExitImpl(
  impl: ((containerId: string) => Promise<number>) | undefined
): void {
  if (impl === undefined) {
    waitForExitImpl = defaultWaitForExitImpl;
    return;
  }
  waitForExitImpl = impl;
}

/** How many trailing lines of a crashed container's logs to surface. */
const EXIT_LOG_TAIL_LINES = 50;

/**
 * Production `docker logs --tail <N> <id>` reader. Captures BOTH streams
 * (apps log to stdout and stderr) so the surfaced tail shows whatever the
 * container printed before exiting.
 */
const defaultReadContainerLogsImpl = async (containerId: string): Promise<string> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { getDockerCmd } = await import('../utils/docker-cmd.js');
  const execFileAsync = promisify(execFile);
  const { stdout, stderr } = await execFileAsync(
    getDockerCmd(),
    ['logs', '--tail', String(EXIT_LOG_TAIL_LINES), containerId],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  return [stdout, stderr].filter((s) => s.length > 0).join('\n');
};

/**
 * Surface the tail of a just-exited essential container's logs so the
 * user sees WHY it stopped (e.g. an app's startup DB-connection error)
 * without manually running `docker logs`. Best-effort: a read failure or
 * empty output is swallowed (debug-logged) rather than masking the
 * primary exit message.
 *
 * `read` is injectable so the unit test can assert the formatting without
 * a real container; production callers use the default `docker logs`
 * reader.
 */
export async function printExitedContainerLogs(
  replicaIndex: number,
  containerId: string,
  logger: { warn: (m: string) => void; debug: (m: string) => void },
  read: (id: string) => Promise<string> = defaultReadContainerLogsImpl
): Promise<void> {
  let raw: string;
  try {
    raw = await read(containerId);
  } catch (err) {
    logger.debug(
      `Replica ${replicaIndex}: could not read container logs: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  const tail = raw.trimEnd();
  if (tail.length === 0) return;
  logger.warn(
    `Replica ${replicaIndex} essential container logs (last ${EXIT_LOG_TAIL_LINES} lines):\n${tail}`
  );
}

const defaultSleepImpl = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let sleepImpl: (ms: number) => Promise<void> = defaultSleepImpl;

/**
 * Test-only hook to short-circuit the restart-backoff sleep in the
 * watcher loop. Production code uses real-time `setTimeout`; the
 * canonical 1s `backoffDelayMs(0)` is too slow for a unit test poll
 * loop that wants to assert `bootCount >= 2` in <100ms.
 *
 * Restores the production `setTimeout` impl when called with `undefined`.
 */
export function __setSleepImpl(impl: ((ms: number) => Promise<void>) | undefined): void {
  if (impl === undefined) {
    sleepImpl = defaultSleepImpl;
    return;
  }
  sleepImpl = impl;
}

function sleep(ms: number): Promise<void> {
  return sleepImpl(ms);
}
