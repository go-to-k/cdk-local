import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { CdkLocalError, LocalStartServiceError } from '../../utils/error-handler.js';
import { resolveMultiTarget } from '../../local/target-picker.js';
import type { TargetEntry } from '../../local/target-lister.js';
import { singleFlight } from '../../utils/single-flight.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp, resolveWatchConfig } from '../config-loader.js';
import { ensureDockerAvailable } from '../../local/docker-runner.js';
import { createFileWatcher, type FileWatcher } from '../../local/file-watcher.js';
import { resolveProfileCredentials, createWatchPredicates } from './local-start-api.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from './local-profile-credentials-file.js';
import {
  applyCrossStackResolverToTask,
  derivePartitionAndUrlSuffix,
  detectEcsImageResolutionNeeds,
  parseEcsTarget,
  TASK_ROLE_ACCOUNT_PLACEHOLDER,
  type EcsImageResolutionContext,
} from '../../local/ecs-task-resolver.js';
import { resolveEcsServiceTarget } from '../../local/ecs-service-resolver.js';
import {
  createServiceRunState,
  rollServiceReplica,
  softReloadReplica,
  startEcsService,
  type ServiceController,
  type ServiceDiscoveryContext,
  type ServiceRunnerOptions,
  type ServiceRunState,
} from '../../local/ecs-service-runner.js';
import type { ResolvedEcsService } from '../../local/ecs-service-resolver.js';
import {
  classifySourceChange,
  type ReloadAssetContext,
  type ReloadVerdict,
} from '../../local/source-change-classifier.js';
import { AssetManifestLoader } from '../../assets/asset-manifest-loader.js';
import path from 'node:path';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import {
  cleanupEcsRun,
  parseHostPortOverrides,
  type RunEcsTaskOptions,
} from '../../local/ecs-task-runner.js';
import { matchStacks } from '../stack-matcher.js';
import {
  createLocalStateProvider,
  rejectExplicitCfnStackWithMultipleStacks,
  resolveCfnFallbackRegion,
  type ExtraStateProviders,
} from './local-state-source.js';
import { getEmbedConfig } from '../../local/embed-config.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';
import type { SubstitutionContext } from '../../local/state-resolver.js';
import { CloudMapRegistry } from '../../local/cloud-map-registry.js';
import { buildCloudMapIndex, type CloudMapIndex } from '../../local/cloud-map-resolver.js';
import {
  createSharedSvcNetwork,
  destroyTaskNetwork,
  type TaskNetwork,
} from '../../local/ecs-network.js';
import { FrontDoorEndpointPool } from '../../local/front-door-pool.js';
import {
  startFrontDoorServer,
  type FrontDoorDispatchTarget,
  type FrontDoorRuleConditionSummary,
  type FrontDoorRuleSummary,
  type StartedFrontDoorServer,
  type RouteAction,
  type WeightedForwardTarget,
} from '../../local/front-door-server.js';
import {
  matchAlbPathRule,
  type AlbHttpHeaderCondition,
  type AlbPathRule,
  type AlbQueryStringCondition,
} from '../../local/alb-path-matcher.js';
import {
  resolveFrontDoorTlsMaterials,
  type FrontDoorTlsMaterials,
} from '../../local/front-door-tls.js';
import type { ResolvedLambda } from '../../local/lambda-resolver.js';
import {
  createFrontDoorLambdaRunner,
  type FrontDoorLambdaRunner,
} from '../../local/front-door-lambda-runner.js';
import type { FrontDoorAuthGuard } from '../../local/elb-front-door-resolver.js';
import { buildAuthCheck } from '../../local/front-door-auth.js';
import { createJwksCache } from '../../local/cognito-jwt.js';
import { describePinnedImageUri, isLocalCdkAssetImage } from '../../local/image-pin-detector.js';

/**
 * Neutral ECS-service emulator orchestration shared by `cdkl start-service`
 * (pure replica runner) and `cdkl start-alb` (ALB front-door entry). It synths,
 * lets a {@link EmulatorStrategy} pick targets and turn them into the concrete
 * set of {@link ServiceBoot}s (plus an optional {@link FrontDoorPlan}), then
 * boots every service replica pool (shared docker network + Cloud Map registry
 * + restart watcher) and, when a front-door plan is present, stands up ONE
 * host-side reverse proxy per listener port that path-routes across the
 * services it fronts.
 *
 * The front-door MECHANISM (generic "expose services' replicas on host ports
 * and path-route between them") lives here; the ALB-specific resolution (which
 * listener fronts which service on which path) lives entirely in the
 * `start-alb` command. `start-service` returns no front-door plan, so it never
 * touches the front-door path.
 */

/** Shared CLI option shape for both ECS-service commands. */
export interface EcsServiceEmulatorOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  cluster: string;
  envVars?: string;
  containerHost: string;
  /** See `local-run-task.ts` for the same flag's three-state grammar. */
  assumeTaskRole?: string | boolean;
  pull: boolean;
  ecrRoleArn?: string;
  /** `--host-port <containerPort=hostPort>` overrides (start-service; repeatable). */
  hostPort?: string[];
  /** `--lb-port <listenerPort=hostPort>` front-door overrides (start-alb; repeatable). */
  lbPort?: string[];
  /**
   * Terminate TLS locally for HTTPS front-door listeners (start-alb).
   * Defaults to `false`: a cloud-HTTPS listener is served over plain HTTP
   * locally (with `X-Forwarded-Proto: https` preserved so the upstream app
   * still sees `https`). When `true` (or implied by `--tls-cert` /
   * `--tls-key`), the listener terminates TLS using the supplied PEM pair
   * or an auto-generated self-signed cert.
   */
  tls?: boolean;
  /**
   * Path to a PEM-encoded server cert for HTTPS front-door listeners
   * (start-alb). Must be set together with `--tls-key`. Implies
   * {@link tls}. Absent (with `--tls` alone) = auto-generated self-signed
   * cert cached under `$XDG_CACHE_HOME/cdk-local/alb-https/`.
   */
  tlsCert?: string;
  /**
   * Path to a PEM-encoded server private key for HTTPS front-door listeners
   * (start-alb). Must be set together with `--tls-cert`. Implies
   * {@link tls}.
   */
  tlsKey?: string;
  /**
   * Local enforcement of authenticate-* guards (start-alb only). Defaults to
   * `true`; `--no-verify-auth` flips it to `false` (Commander convention)
   * which makes every request pass the guard. Useful for local dev that does
   * not want to mint a Bearer token.
   */
  verifyAuth?: boolean;
  /**
   * Default Bearer JWT injected as `Authorization: Bearer <jwt>` when the
   * inbound request has none (start-alb only). Verified against the same
   * JWKS / OIDC discovery URL the deployed ALB would.
   */
  bearerToken?: string;
  platform?: string;
  /** Cap on local replica count regardless of template `DesiredCount`. */
  maxTasks: number;
  /** Restart-on-exit policy: 'on-failure' (default), 'always', or 'none'. */
  restartPolicy: 'on-failure' | 'always' | 'none';
  /**
   * Issue #606: alternative state source. Reads physical IDs from a
   * deployed CloudFormation stack via `ListStackResources`.
   */
  fromCfnStack?: string | boolean;
  stackRegion?: string;
  /**
   * Issue #214 — `cdkl start-service --watch` (Phase 1 + Phase 2) and
   * `cdkl start-alb --watch` (Phase 3). Re-synth and per-replica roll
   * each booted ECS service when the CDK app source changes (shadow
   * boot under bumped generation suffix → TCP-ready probe → atomic
   * Cloud Map + front-door pool registration swap → retire old
   * container, sequenced one replica at a time so peer services + the
   * ALB front-door's continuous request stream see zero connection
   * refusals across the reload). Wired per command via
   * `addStartServiceSpecificOptions` / `addAlbSpecificOptions`; each
   * strategy decides whether to honor it via `supportsWatch`.
   */
  watch?: boolean;
  /**
   * Issue #227 — stream each replica's container stdout / stderr to the
   * host terminal with a `[svc=<serviceName> r=<i> c=<container>] ` prefix
   * (matching `cdkl run-task`'s log surface). Defaults to `true`;
   * `--no-logs` flips it to `false` for runs whose multi-replica /
   * multi-service interleaved log volume makes the foreground
   * unreadable. `docker logs -f <id>` in a separate terminal stays
   * available either way.
   *
   * Commander's `--no-logs` form populates `logs: false` (the negation
   * convention). When neither flag is supplied, `logs` is `undefined` →
   * the emulator treats this as opt-in default-on for parity with
   * `cdkl run-task`.
   */
  logs?: boolean;
  /** Host-injected extra state-source flag fields. */
  [key: string]: unknown;
}

/** One ECS service to boot. Front-door wiring lives in the {@link FrontDoorPlan}. */
export interface ServiceBoot {
  /** Service target string (`Stack:LogicalId` or `Stack/Path`). */
  target: string;
}

/**
 * The backing target one weighted forward target routes to: either an ECS
 * service (round-robin a replica pool) or a Lambda function (invoke locally per
 * request, #123). A single weighted forward may mix both.
 */
export type PlannedForwardTarget = PlannedEcsForwardTarget | PlannedLambdaForwardTarget;

/** The backing (service target, container) an ECS weighted forward target routes to. */
export interface PlannedEcsForwardTarget {
  kind: 'ecs';
  /** Service target string (`Stack:LogicalId`) whose replica pool serves this. */
  serviceTarget: string;
  /** Container the listener forwards to. */
  targetContainerName: string;
  /** Container port the target group targets. */
  targetContainerPort: number;
  /** Forward weight for weighted routing (single-target forward = 1). */
  weight: number;
}

/** A Lambda weighted forward target (#123): a resolved function invoked locally per request. */
export interface PlannedLambdaForwardTarget {
  kind: 'lambda';
  /** The resolved Lambda the front-door boots + invokes. */
  lambda: ResolvedLambda;
  /** Target-group ARN-or-id surfaced under the event's `requestContext.elb`. */
  targetGroupArn: string;
  /** Whether the TG has `lambda.multi_value_headers.enabled=true`. */
  multiValueHeaders: boolean;
  /** Forward weight for weighted routing (single-target forward = 1). */
  weight: number;
}

/** A planned forward action: one or more weighted backing targets (ECS and/or Lambda). */
export interface PlannedForwardAction {
  kind: 'forward';
  targets: PlannedForwardTarget[];
}

/** A planned redirect action (no backing pool). */
export interface PlannedRedirectAction {
  kind: 'redirect';
  statusCode: 301 | 302;
  protocol?: string;
  host?: string;
  port?: string;
  path?: string;
  query?: string;
}

/** A planned fixed-response action (no backing pool). */
export interface PlannedFixedResponseAction {
  kind: 'fixed-response';
  statusCode: number;
  contentType?: string;
  messageBody?: string;
}

/** Any planned listener / rule action (the strategy-side mirror of the front-door's RouteAction). */
export type PlannedAction =
  | PlannedForwardAction
  | PlannedRedirectAction
  | PlannedFixedResponseAction;

/** One host front-door listener: a bound host port + its routing table. */
export interface PlannedFrontDoorListener {
  /** ALB listener port (for the `X-Forwarded-Port` header / logs). */
  listenerPort: number;
  /** Host port to bind (the listener port, or its `--lb-port` override). */
  hostPort: number;
  /** Listener protocol (`HTTP` or `HTTPS`); drives TLS termination + X-Forwarded-Proto. */
  protocol: 'HTTP' | 'HTTPS';
  /** Default action (absent for a rules-only listener -> 404 on miss). */
  defaultAction?: PlannedAction;
  /** Default action's authenticate-* guard (set when DefaultActions[] wrapped one). */
  defaultAuthGuard?: FrontDoorAuthGuard;
  /** Rules, evaluated by priority (lower first); each carries up to all six ALB condition fields. */
  rules: Array<{
    priority: number;
    pathPatterns: string[];
    hostPatterns: string[];
    httpHeaderConditions: AlbHttpHeaderCondition[];
    httpRequestMethods: string[];
    queryStringConditions: AlbQueryStringCondition[];
    sourceIpCidrs: string[];
    action: PlannedAction;
    /** authenticate-* guard wrapping the action (set when Actions[] declared one). */
    authGuard?: FrontDoorAuthGuard;
  }>;
}

/** The full set of host front-doors to stand up for one emulator invocation. */
export interface FrontDoorPlan {
  listeners: PlannedFrontDoorListener[];
}

/** Mutable front-door pool list for a single service's runner (one entry per (container, port)). */
type FrontDoorServicePools = Array<{
  pool: FrontDoorEndpointPool;
  targetContainerName: string;
  targetContainerPort: number;
}>;

/**
 * Per-command behavior the neutral orchestration delegates to: how to pick
 * targets when none are passed, how to turn chosen targets into concrete
 * service boots (+ an optional front-door plan + warnings), and the `--lb-port`
 * host-port remap.
 */
export interface EmulatorStrategy {
  pickEntries(stacks: StackInfo[]): TargetEntry[];
  pickerMessage: string;
  pickerNoun: string;
  onMissing(): CdkLocalError;
  resolveBoots(
    stacks: StackInfo[],
    chosenTargets: string[]
  ): { boots: ServiceBoot[]; frontDoor?: FrontDoorPlan; warnings: string[] };
  lbPortOverrides: Record<number, number>;
  /**
   * When true, the service resolver does not emit the `LoadBalancers but
   * no local listener` hint for booted services. `start-alb` sets this:
   * by construction every service booted under it is fronted by the
   * local front-door, so the hint is misleading. `start-service` leaves
   * it falsy.
   */
  suppressLoadBalancerWarning?: boolean;
  /**
   * Issue #214 (Phase 1 + Phase 2 + Phase 3) — opt this strategy into
   * the emulator's `--watch` reload pathway. Both `serviceStrategy()`
   * (start-service) and `albStrategy()` (start-alb) set this true; a
   * source change triggers the same per-replica rolling primitive
   * (`rollServiceReplica`) for every booted ECS service. The ALB
   * front-door pool already swaps atomically as part of that primitive
   * — its `register` / `unregister` are single-assignment Map mutations
   * and `next()` reads happen on a single JS thread, so a continuous
   * external request stream against the listener port never observes
   * a partial swap. The gate is kept as a strategy field rather than a
   * runtime guard so a future strategy added through the engine (host
   * CLIs that wrap `runEcsServiceEmulator`) does not get watch implicitly.
   */
  supportsWatch?: boolean;
}

/**
 * Long-running ECS-service emulator. Synths the app, resolves the strategy's
 * targets into service boots, boots every replica pool (with optional
 * front-door), and blocks until `^C`. Idempotent single-flight cleanup tears
 * down every replica + front-door server + the shared network + sidecar.
 */
export async function runEcsServiceEmulator(
  targets: string[],
  options: EcsServiceEmulatorOptions,
  strategy: EmulatorStrategy,
  extraStateProviders: ExtraStateProviders | undefined
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  warnIfDeprecatedRegion(options);

  // Commander resolves `--no-pull` to `options.pull = false` (the default is
  // true). Compute the "should we skip docker pull?" flag once here.
  const skipPull = options.pull === false;

  type PerTarget = {
    boot: ServiceBoot;
    runState: ServiceRunState;
    controller?: ServiceController;
  };
  let perTarget: PerTarget[] = [];

  let sigintHandler: (() => void) | undefined;
  let sigintCount = 0;
  let sharedNetwork: TaskNetwork | undefined;
  let profileCredsFile: ProfileCredentialsFile | undefined;
  // Host-side ALB front-door servers (one per listener port), shared across the
  // services they front. Created once before the boot loop; torn down after all
  // replicas are down so no request is forwarded to a vanished container.
  let frontDoorServers: StartedFrontDoorServer[] = [];
  // Per-service-target front-door pools to thread into each runner.
  let frontDoorByService = new Map<string, FrontDoorServicePools>();
  // Long-lived Lambda-target containers behind the front-door (#123). Torn
  // down alongside the front-door servers so no request is dispatched to a
  // vanished container.
  let frontDoorLambdaRunners: FrontDoorLambdaRunner[] = [];
  // Phase 1 of issue #214 — `cdkl start-service --watch` file watcher + the
  // chain promise that serializes reload events. Set when the watcher is wired
  // (only when `options.watch && strategy.supportsWatch`); the cleanup path
  // closes the watcher AND awaits the in-flight reload before tearing down
  // services so a reload never races shutdown.
  let watcher: FileWatcher | undefined;
  let reloadChain: Promise<unknown> = Promise.resolve();

  const cleanup = singleFlight(
    async (): Promise<void> => {
      // Phase 1 of issue #214 — close the watcher BEFORE awaiting the
      // existing reload-chain so no new reload is queued after shutdown
      // started, then drain the in-flight reload so cleanup doesn't race
      // a partial `pt.controller` swap.
      if (watcher) {
        try {
          await watcher.close();
        } catch (err) {
          getLogger().warn(
            `watcher.close() failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        watcher = undefined;
      }
      await reloadChain.catch(() => undefined);
      await Promise.allSettled(
        perTarget.map(async (pt) => {
          if (pt.controller) {
            await pt.controller.shutdown();
          } else {
            // SIGINT-during-bootOneTarget early-failure path.
            await Promise.allSettled(
              pt.runState.replicas
                .map((r) => r.inFlightBoot)
                .filter((p): p is Promise<void> => p !== undefined)
            );
            await Promise.allSettled(
              pt.runState.replicas.map((r) =>
                cleanupEcsRun(r.state, { keepRunning: false }).catch(() => undefined)
              )
            );
          }
        })
      );
      // Close the front-door servers AFTER every replica is down so no in-flight
      // request is forwarded to a torn-down container. Idempotent.
      await Promise.allSettled(
        frontDoorServers.map((s) =>
          s
            .close()
            .catch((err) =>
              getLogger().warn(
                `front-door server teardown failed: ${err instanceof Error ? err.message : String(err)}`
              )
            )
        )
      );
      frontDoorServers = [];
      // Stop the Lambda-target containers AFTER the front-door servers are
      // closed so no in-flight request lands on a torn-down RIE container.
      await Promise.allSettled(
        frontDoorLambdaRunners.map((r) =>
          r
            .stop()
            .catch((err) =>
              getLogger().warn(
                `front-door Lambda target teardown failed: ${err instanceof Error ? err.message : String(err)}`
              )
            )
        )
      );
      frontDoorLambdaRunners = [];
      if (profileCredsFile) {
        try {
          await profileCredsFile.dispose();
        } catch (err) {
          getLogger().warn(
            `Failed to remove profile credentials tmpdir ${profileCredsFile.hostPath}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        profileCredsFile = undefined;
      }
      if (sharedNetwork) {
        try {
          await destroyTaskNetwork(sharedNetwork);
        } catch (err) {
          getLogger().warn(
            `shared service network teardown failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        sharedNetwork = undefined;
      }
    },
    (err) =>
      getLogger().warn(
        `service cleanup failed: ${err instanceof Error ? err.message : String(err)}`
      )
  );

  try {
    await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });
    await ensureDockerAvailable();

    const appCmd = resolveApp(options.app);
    if (!appCmd) {
      throw new Error(
        `No CDK app specified. Pass --app, set ${getEmbedConfig().envPrefix}_APP, or add "app" to cdk.json.`
      );
    }

    logger.info('Synthesizing CDK app...');
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const synthOpts: SynthesisOptions = {
      app: appCmd,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
    };
    const { stacks } = await synthesizer.synthesize(synthOpts);

    const resolvedTargets = await resolveMultiTarget(targets, {
      entries: strategy.pickEntries(stacks),
      message: strategy.pickerMessage,
      noun: strategy.pickerNoun,
      onMissing: () => strategy.onMissing(),
    });

    const { boots, frontDoor, warnings } = strategy.resolveBoots(stacks, resolvedTargets);
    for (const w of warnings) logger.warn(w);
    // A front-door whose listeners forward ONLY to Lambda targets (#123) has no
    // ECS service to boot; it is still runnable (the Lambda containers live
    // behind the front-door). Only error when there is nothing to run at all.
    const hasFrontDoorListeners = !!frontDoor && frontDoor.listeners.length > 0;
    if (boots.length === 0 && !hasFrontDoorListeners) {
      throw new LocalStartServiceError(
        `No runnable target resolved from ${resolvedTargets.join(', ')}.`
      );
    }

    // Issue #606: reject explicit `--from-cfn-stack <name>` when multiple
    // services are booted in one invocation.
    rejectExplicitCfnStackWithMultipleStacks(options, boots.length);
    perTarget = boots.map((boot) => ({ boot, runState: createServiceRunState() }));

    const cloudMapIndexByStack = new Map<string, CloudMapIndex>();
    for (const stack of stacks) {
      const index = buildCloudMapIndex(stack);
      cloudMapIndexByStack.set(stack.stackName, index);
      for (const w of index.warnings) logger.warn(w);
    }

    const registry = new CloudMapRegistry();
    const sidecarCredentials = await resolveSharedSidecarCredentials(options);
    try {
      sharedNetwork = await createSharedSvcNetwork({
        prefix: options.cluster,
        skipPull,
        cluster: options.cluster,
        ...(sidecarCredentials !== undefined && { credentials: sidecarCredentials }),
      });
    } catch (err) {
      throw new LocalStartServiceError(
        `Failed to create shared service network: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (options.profile && sidecarCredentials) {
      profileCredsFile = await writeProfileCredentialsFile(options.profile, sidecarCredentials);
    }
    const discovery: ServiceDiscoveryContext = {
      registry,
      cloudMapIndexByStack,
      sharedNetwork,
    };

    // Stand up the host front-door(s) BEFORE booting replicas: the pools start
    // empty (so the proxy answers 503 until replicas register) and a host-port
    // bind failure should surface before any docker budget is spent. No-op when
    // the strategy returned no plan (start-service / pure compute).
    if (frontDoor && frontDoor.listeners.length > 0) {
      const built = await buildFrontDoor(frontDoor, options, logger);
      frontDoorServers = built.servers;
      frontDoorByService = built.frontDoorByService;
      frontDoorLambdaRunners = built.lambdaRunners;
    }

    sigintHandler = (): void => {
      sigintCount += 1;
      if (sigintCount >= 2) {
        process.stderr.write('Force-exit on second ^C; container cleanup skipped.\n');
        process.exit(130);
      }
      logger.info('Stopping service(s)...');
      void cleanup().then(() => process.exit(130));
    };
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigintHandler);

    // Boot every target SEQUENTIALLY so a first-target failure surfaces before
    // we burn docker budget on the rest.
    for (const pt of perTarget) {
      pt.controller = await bootOneTarget(
        pt.boot,
        pt.runState,
        stacks,
        options,
        discovery,
        skipPull,
        extraStateProviders,
        profileCredsFile,
        frontDoorByService.get(pt.boot.target),
        strategy.suppressLoadBalancerWarning === true
      );
    }

    if (perTarget.length > 0) {
      const summary = perTarget
        .map(
          (pt) =>
            `${pt.controller!.service.serviceName} (${pt.controller!.activeReplicaCount()} replica(s))`
        )
        .join(', ');
      logger.info(`Service(s) running: ${summary}.`);
    } else {
      // Lambda-target-only front-door (#123): no ECS replicas, just the
      // Lambda container(s) behind the front-door.
      logger.info(
        `Service(s) running: ${frontDoorLambdaRunners.length} Lambda target(s) behind the ALB front-door.`
      );
    }
    // Surface the consolidated endpoint URLs at the END of the boot stream so
    // the access URL doesn't get buried between streamed `docker pull` output
    // and the per-replica boot logs. Two sources:
    //   - per-service static host-port publishes recorded in
    //     `state.publishedEndpoints` by the runner (single-replica start-service);
    //   - per-listener ALB front-door servers (start-alb), echoed here so they
    //     end up at the bottom too — the buildFrontDoor `ALB front-door: ...`
    //     line is emitted earlier (and is the load-bearing marker integ tests
    //     grep for), but it streams BEFORE the docker-pull noise and ends up
    //     buried, exactly the same problem this banner solves for start-service.
    // Empty when neither source has anything to show (e.g. multi-replica
    // start-service with no front-door).
    logEndpointsBanner(perTarget, frontDoorServers, logger);
    logger.info('Press ^C to shut down.');

    // Issue #234 — when `--watch` is set, warn per booted target whose
    // representative container image is NOT a local CDK docker-image
    // asset. Such targets resolve to a deployed-registry pin (ECR via
    // `--from-cfn-stack` against `ContainerImage.fromEcrRepository(...)`,
    // or a public-registry pin like `ContainerImage.fromRegistry(...)`).
    // The rolling primitive would re-pull byte-identical content on
    // each save and report `Reload complete.` even though nothing in
    // the running container changed — a silent no-op disguised as
    // success. Warn UP-FRONT (per target) so the user knows local
    // source edits will not take effect before they spend time saving
    // files. The reload pathway also skips the no-op roll (see
    // `reloadAllServices`); this boot-time warn is the proactive half.
    //
    // The `--watch` gate (`options.watch === true && strategy.supportsWatch
    // === true`) is hoisted into a single const so the boot-time WARN
    // block + the watcher-wiring block downstream can never drift out of
    // sync, and so #238's planned "broaden the WARN to fire regardless of
    // `--watch`" follow-up is a one-line delta against the predicate
    // instead of two.
    const watchActive = options.watch === true && strategy.supportsWatch === true;
    if (watchActive) {
      for (const pt of perTarget) {
        const service = pt.controller?.service;
        if (!service) continue;
        if (isLocalCdkAssetImage(service)) continue;
        const pinnedUri = describePinnedImageUri(service);
        const uriDisplay = pinnedUri ? `\`${pinnedUri}\`` : 'a deployed registry';
        logger.warn(
          `'${pt.boot.target}': \`--watch\` will not pick up local source changes — ` +
            `running image is pinned to a deployed registry (${uriDisplay}). ` +
            'To iterate on local source, drop `--from-cfn-stack` and switch the ' +
            'CDK app to `ContainerImage.fromAsset(...)`.'
        );
      }
    }

    // Phase 1 + Phase 2 + Phase 3 of issue #214 — `cdkl start-service --watch`
    // (Phases 1-2) and `cdkl start-alb --watch` (Phase 3) source-tree
    // watcher. Both `serviceStrategy()` and `albStrategy()` opt in via
    // `supportsWatch: true`; the gate keeps a future strategy added through
    // this engine from getting `--watch` implicitly. The watcher reuses the
    // start-api debounced file-watcher and predicate composition verbatim so
    // cdk.json `watch.include` / `watch.exclude` semantics are identical.
    if (watchActive) {
      const watchRoot = process.cwd();
      const { ignored, shouldTrigger, excludePatterns } = createWatchPredicates({
        watchRoot,
        output: options.output,
        watchConfig: resolveWatchConfig(),
      });
      watcher = createFileWatcher({
        paths: [watchRoot],
        ignored,
        shouldTrigger,
        onChange: (changedPaths) => {
          logger.info(
            `Detected source change (${changedPaths.length} path(s)); reloading service(s)...`
          );
          const next = reloadChain.then(() =>
            reloadAllServices({
              perTarget,
              synthesizer,
              synthOpts,
              strategy,
              resolvedTargets,
              cloudMapIndexByStack,
              options,
              discovery,
              skipPull,
              extraStateProviders,
              profileCredsFile,
              frontDoorByService,
              changedPaths,
              logger,
            })
          );
          // Surface any unhandled throw from `reloadAllServices` (e.g. a
          // future refactor adds a step outside the function's existing
          // synth + per-target try/catches) instead of swallowing it
          // silently — otherwise the emulator goes quietly stale.
          reloadChain = next.catch((err) => {
            logger.error(
              `reloadAllServices threw: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        },
      });
      logger.info(
        `Watching ${watchRoot} for source changes (excluding ${excludePatterns.join(', ')}).`
      );
    }

    // Block on a SIGINT/SIGTERM that resolves via the cleanup -> process.exit
    // path. The replicas + front-door + Lambda containers keep serving until
    // then. The pre-#214 shape used
    // `Promise.all(perTarget.map(pt => pt.controller!.waitForShutdown()))` —
    // equivalent in non-watch mode because `controller.shutdown()` is only
    // invoked from the SIGINT handler / cleanup() pass — but the `--watch`
    // reload pathway calls `oldController.shutdown()` mid-run to swap a
    // replica, which would resolve the OLD controller's `waitForShutdown`
    // and unblock the main loop prematurely. Block on a forever-promise
    // instead and let `cleanup() -> process.exit` be the only termination
    // path; degraded replicas mark themselves shutting-down but never
    // resolve the controller's promise, so this matches the pre-#214
    // behavior for the watch-off case.
    await new Promise<void>(() => {
      /* resolved only by the SIGINT/SIGTERM handler's process.exit */
    });
  } finally {
    if (sigintHandler) {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigintHandler);
    }
    await cleanup();
  }
}

/**
 * Phase 2 + Phase 4 of issue #214 — multi-replica reload cycle for
 * `cdkl start-service --watch` (Phase 2) and `cdkl start-alb --watch`
 * (Phase 3 wires the same loop). Mirrors start-api's `reloadAllServers`
 * shape but per-ECS-service. Per-target verdict from
 * {@link classifySourceChange} (Phase 4) picks the per-replica action:
 *
 *   - `'soft-reload'` → {@link softReloadReplica} runs `docker cp`
 *     + `docker restart` against the live replica. No `docker build`,
 *     no shadow boot, no Cloud Map / front-door pool swap — the
 *     container's IP + host port are preserved across the restart, so
 *     existing registrations stay valid. Fast path (~sub-second per
 *     replica for typical interpreted-language handlers).
 *   - `'rebuild'` → {@link rollServiceReplica}, the Phase 1-3 path,
 *     replacing Phase 1's "tear single replica down, boot fresh"
 *     sequence with a per-replica rolling loop so the service stays
 *     available end-to-end:
 *
 *   1. Re-runs `synthesizer.synthesize(synthOpts)` once (failure → warn
 *      + keep every replica serving).
 *   2. Re-runs `strategy.resolveBoots(stacks, resolvedTargets)` so a
 *      target that disappears from the CDK code is detected (warn +
 *      keep previous).
 *   3. Refreshes `cloudMapIndexByStack` from the new stacks so a peer
 *      service's namespace / discovery-name rename is picked up by the
 *      next shadow replica's Cloud Map publish.
 *   4. Per-target:
 *      a. Resolves the new (service, runnerOpts) pair against the new
 *         stacks (cross-stack env / assume-task-role / `--env-vars`
 *         all re-resolved fresh).
 *      b. For each existing replica `i` in 0..min(old, new) - 1:
 *         {@link rollServiceReplica} boots a shadow replica with the
 *         new image under a bumped generation suffix, atomically swaps
 *         Cloud Map / front-door registrations, then stops + cleans up
 *         the old replica. Sequential — only one replica is mid-swap
 *         at a time, so peer services + the front-door pool always
 *         have at least N-1 live endpoints during a roll.
 *
 * Phase 2 trade-off: when the effective replica count changes mid-roll
 * (the user bumped `DesiredCount` or `--max-tasks` flips a clamp),
 * the rolling pathway keeps the existing replicas on the new image
 * but does not scale up / down to match the new count. A warn surfaces
 * so the user can `^C` + re-launch to scale; a richer "scale + roll"
 * mode is left to a follow-up under #214.
 *
 * Per-replica boot failure during the roll: the OLD replica stays
 * live (the shadow was torn down by `rollServiceReplica`), the
 * remaining replicas are still rolled, and the failure is surfaced
 * via the logger so the user can fix the source + save again.
 */
async function reloadAllServices(args: {
  perTarget: Array<{
    boot: ServiceBoot;
    runState: ServiceRunState;
    controller?: ServiceController;
  }>;
  synthesizer: Synthesizer;
  synthOpts: SynthesisOptions;
  strategy: EmulatorStrategy;
  resolvedTargets: string[];
  cloudMapIndexByStack: Map<string, CloudMapIndex>;
  options: EcsServiceEmulatorOptions;
  discovery: ServiceDiscoveryContext;
  skipPull: boolean;
  extraStateProviders: ExtraStateProviders | undefined;
  profileCredsFile: ProfileCredentialsFile | undefined;
  frontDoorByService: Map<string, FrontDoorServicePools>;
  /**
   * Phase 4 of issue #214 — the set of chokidar-reported paths that
   * triggered this reload. The classifier (run per target, after the
   * fresh synth has updated the asset manifests) decides whether each
   * target rolls via the Phase 2/3 rebuild primitive or the Phase 4
   * bind-mount fast path based on this set.
   */
  changedPaths: readonly string[];
  logger: ReturnType<typeof getLogger>;
}): Promise<void> {
  const {
    perTarget,
    synthesizer,
    synthOpts,
    strategy,
    resolvedTargets,
    cloudMapIndexByStack,
    options,
    discovery,
    skipPull,
    extraStateProviders,
    profileCredsFile,
    frontDoorByService,
    changedPaths,
    logger,
  } = args;

  let stacks: StackInfo[];
  try {
    ({ stacks } = await synthesizer.synthesize(synthOpts));
  } catch (err) {
    logger.warn(
      `cdk synth failed during reload; keeping previous version. (${err instanceof Error ? err.message : String(err)})`
    );
    return;
  }

  // The new `frontDoor` plan is intentionally discarded: `reloadAllServices`
  // only rolls EXISTING service replicas through the new task definition.
  // For `start-alb --watch`, mid-watch edits to listener rules (path /
  // host / header / method / query-string / source-ip conditions),
  // weighted-forward weights, redirect / fixed-response actions, Lambda
  // target groups, listener `Certificates[]`, or auth-* guards are NOT
  // applied across a reload — the boot-time `frontDoorByService` +
  // `frontDoorServers` lock in those decisions. To pick up listener-side
  // CDK edits the user needs to `^C` and re-launch. Tracked under
  // issue #214 (see PR body's "Out-of-scope" section) for a future
  // follow-up.
  const { boots: newBoots, warnings } = strategy.resolveBoots(stacks, resolvedTargets);
  for (const w of warnings) logger.warn(w);
  const newBootByTarget = new Map(newBoots.map((b) => [b.target, b] as const));

  // Refresh the per-stack Cloud Map index in place so the rolling
  // primitive's shadow-boot publish path reads the new namespace /
  // discovery-name shape (the discovery object holds the same map
  // reference, so the runner observes the update without a re-wire).
  cloudMapIndexByStack.clear();
  for (const stack of stacks) {
    const index = buildCloudMapIndex(stack);
    cloudMapIndexByStack.set(stack.stackName, index);
    for (const w of index.warnings) logger.warn(w);
  }

  // Phase 4 of issue #214 — pre-resolve a per-target asset context the
  // classifier consumes. `loadAssetContextForTarget` parses the freshly-
  // synthed `<stackName>.assets.json` (idempotent, cheap), pulls out the
  // target's docker-image asset hash + staged source directory, and
  // returns undefined when the target's image isn't a CDK docker-image
  // asset (ECR / public pin — the fast path has no source to copy
  // anyway). Loaded once per reload + target so the classifier stays
  // pure; `cdkOutDir` is `options.output` (the --output CLI flag).
  const cdkOutDir = options.output;
  const assetLoader = new AssetManifestLoader();

  // Per-target sequential reload — keep docker churn predictable.
  for (const pt of perTarget) {
    const newBoot = newBootByTarget.get(pt.boot.target);
    if (!newBoot) {
      logger.warn(
        `Reload: target '${pt.boot.target}' no longer resolves to a service in the synthesized ` +
          'app; keeping the previous replica(s) serving.'
      );
      continue;
    }
    const controller = pt.controller;
    if (!controller) {
      logger.warn(
        `Reload: target '${pt.boot.target}' has no live controller (previous boot likely ` +
          'failed); skipping roll. `^C` and re-run start-service to recover.'
      );
      continue;
    }
    // Phase 4 — classify this firing for THIS target. The classifier
    // is pure + synchronous; the only async work is the asset
    // manifest load which we do once per target per reload.
    let verdict: ReloadVerdict = { kind: 'rebuild', reason: 'classifier not consulted' };
    try {
      const assetCtx = await loadAssetContextForTarget({
        target: newBoot.target,
        controller,
        stacks,
        cdkOutDir,
        assetLoader,
        logger,
      });
      verdict = classifySourceChange(changedPaths, assetCtx);
      logger.info(`Reload of '${newBoot.target}': verdict=${verdict.kind} (${verdict.reason}).`);
    } catch (err) {
      // A classifier-context build failure (e.g. asset manifest
      // malformed, asset hash mismatch) is non-fatal: fall back to
      // the Phase 1-3 rebuild path which carries no asset-context
      // dependency.
      logger.warn(
        `Reload of '${newBoot.target}': classifier context unavailable ` +
          `(${err instanceof Error ? err.message : String(err)}); falling back to rebuild.`
      );
      verdict = {
        kind: 'rebuild',
        reason: 'classifier context unavailable; falling back to rebuild',
      };
    }
    // Issue #234 — when the classifier returns `rebuild` with the
    // "target image is not a CDK docker-image asset" reason, the
    // rolling primitive would re-pull a byte-identical deployed
    // image (ECR pin / public-registry pin — typical under
    // `--from-cfn-stack` against `ContainerImage.fromEcrRepository
    // (...)`). The roll docker-pulls the same bytes, swaps, retires
    // the old replica — a no-op disguised as `Reload complete.`.
    // Skip the roll for THIS target; the boot-time WARN already
    // told the user this `--watch` configuration can't pick up
    // local source changes. The rest of the per-target loop still
    // rolls peer targets whose images ARE local CDK assets.
    //
    // Follow-up (out of scope for #234): env / Secrets diff under
    // `--from-cfn-stack` is the one signal a reload could
    // legitimately propagate here (deployed stack flipped a
    // SecureString / env value); plumb a fast-path env-only reload
    // for ECR-pinned targets so a watcher firing can still apply
    // such changes without booting a shadow container.
    //
    // Narrow the skip to the actual "image is a deployed-registry
    // pin" case. `loadAssetContextForTarget` returns `undefined` (and
    // the classifier defaults to `rebuild` with the reason below) for
    // SEVEN distinct conditions — only one of which is "image is not a
    // CDK asset". The other six (no candidate stack, resolver throw,
    // no containers in the synthed task, manifest unreadable, asset
    // hash drift, executable-mode asset) are degradation / race paths
    // where the rolling primitive should still try to run and surface
    // the underlying failure to the user. We use the booted
    // controller's resolved service as the ground truth for "the
    // currently-running image is a pin", because that's what the
    // skip-rationale ("re-pulling byte-identical content") rests on.
    if (
      verdict.kind === 'rebuild' &&
      verdict.reason === 'target image is not a CDK docker-image asset' &&
      !isLocalCdkAssetImage(controller.service)
    ) {
      logger.info(
        `Reload skipped for '${newBoot.target}' (no-op): image pinned to deployed ` +
          'registry; no local rebuild possible.'
      );
      continue;
    }
    await rollOneTarget({
      controller,
      newBoot,
      stacks,
      options,
      discovery,
      skipPull,
      extraStateProviders,
      profileCredsFile,
      frontDoorPools: frontDoorByService.get(newBoot.target),
      suppressLoadBalancerWarning: strategy.suppressLoadBalancerWarning === true,
      verdict,
      logger,
    });
  }

  logger.info('Reload complete.');
}

/**
 * Phase 4 of issue #214 — load the per-target asset context the
 * source-change classifier consumes. Resolves the target's docker-image
 * asset hash via the freshly-synthed `<stackName>.assets.json` and
 * derives the staged source directory + Dockerfile basename.
 *
 * Returns `undefined` (and logs at debug) when:
 *   - The target's image isn't a CDK docker-image asset (ECR / public
 *     registry pin). The classifier treats `undefined` as `rebuild`
 *     because there's no local source tree to copy.
 *   - The asset manifest can't be loaded (stack not synthed yet, file
 *     missing). Same treatment — defensive default to `rebuild`.
 *   - The asset hash isn't in the manifest's `dockerImages`. Same.
 *
 * Throws on a malformed manifest (parse failure surfaced via
 * {@link AssetManifestLoader}) so the caller can fall back to rebuild
 * with a warn line that explains why the classifier couldn't run.
 */
/**
 * @internal — exported for unit tests of the fall-through branches
 * (the 6 `return undefined` paths + the catch arm on
 * `resolveEcsServiceTarget` throw). Not part of the semver-covered
 * public surface; the only legitimate caller is `reloadAllServices`
 * inside this file.
 */
export async function loadAssetContextForTarget(args: {
  target: string;
  controller: ServiceController;
  stacks: StackInfo[];
  cdkOutDir: string;
  assetLoader: AssetManifestLoader;
  logger: ReturnType<typeof getLogger>;
}): Promise<ReloadAssetContext | undefined> {
  const { target, controller, stacks, cdkOutDir, assetLoader, logger } = args;
  // Resolve the new task descriptor's image asset. We reuse the
  // ALREADY-resolved `controller.service` for the OLD hash diagnostic
  // (still on Phase 1-3 boot's image), and re-run the resolver on the
  // fresh stacks to discover the NEW hash. Both lookups skip when the
  // image isn't a CDK asset.
  const parsed = parseEcsTarget(target);
  const candidate = pickCandidateStack(parsed.stackPattern, stacks);
  if (!candidate) return undefined;
  let newService: ResolvedEcsService;
  try {
    newService = resolveEcsServiceTarget(target, stacks, undefined, {
      suppressLoadBalancerWarning: true,
    });
  } catch (err) {
    logger.debug(
      `loadAssetContextForTarget: target '${target}' could not be re-resolved against ` +
        `the new stacks: ${err instanceof Error ? err.message : String(err)}. ` +
        'Classifier will see no asset context (rebuild).'
    );
    return undefined;
  }
  // Pick the FIRST essential container's image — same heuristic the
  // soft-reload primitive uses to decide which container(s) to cycle.
  // A multi-essential task with mixed image kinds (one CDK asset +
  // one ECR pin) is rare; we treat the first essential's image as
  // representative.
  const essential =
    newService.task.containers.find((c) => c.essential) ?? newService.task.containers[0];
  if (!essential) return undefined;
  if (essential.image.kind !== 'cdk-asset' || !essential.image.assetHash) {
    return undefined;
  }
  const newAssetHash = essential.image.assetHash;
  const manifest = await assetLoader.loadManifest(cdkOutDir, candidate.stackName);
  if (!manifest) return undefined;
  const newDockerImage = manifest.dockerImages?.[newAssetHash];
  if (!newDockerImage) return undefined;
  if (!newDockerImage.source.directory) {
    // `executable`-mode docker asset (custom build script). No staged
    // source directory to copy from.
    return undefined;
  }
  const newAssetSourceDir = path.resolve(cdkOutDir, newDockerImage.source.directory);
  // Phase 4 follow-up (#218) — read the OLD asset hash from the
  // LIVE replica's `lastDeployedAssetHash` stamp, not from
  // `controller.service` (the boot-time descriptor, which never
  // updates across rolling reloads). The first non-shutting-down
  // replica is the source of truth for "what's running right now"
  // because the rolling primitive sequences swaps one replica at a
  // time; in steady state every replica carries the same hash. Falls
  // back to the boot-time descriptor for replicas whose stamp is
  // missing (defensive — e.g. when a host CLI hand-builds the run
  // state and skips the stamp).
  let oldAssetHash: string | undefined;
  const liveReplica = controller.runState.replicas.find((r) => !r.shuttingDown);
  if (liveReplica?.lastDeployedAssetHash !== undefined) {
    oldAssetHash = liveReplica.lastDeployedAssetHash;
  } else {
    const oldEssential =
      controller.service.task.containers.find((c) => c.essential) ??
      controller.service.task.containers[0];
    if (oldEssential?.image.kind === 'cdk-asset') {
      oldAssetHash = oldEssential.image.assetHash;
    }
  }
  return {
    ...(oldAssetHash !== undefined && { oldAssetHash }),
    newAssetHash,
    newAssetSourceDir,
    // Normalize to basename so a custom `source.dockerFile` value that
    // includes a relative path (e.g. `dockerfiles/Prod.Dockerfile`)
    // still matches the classifier's per-changed-path basename
    // comparison — otherwise an edit to such a file would silently
    // route to soft-reload and leave the running image stale.
    dockerFile: path.basename(newDockerImage.source.dockerFile ?? 'Dockerfile'),
  };
}

/**
 * Phase 2 of issue #214 — roll every replica of one target through the
 * new task descriptor sequentially. Extracted from {@link reloadAllServices}
 * so the per-target try/catch logic (synth-failure / resolve-failure /
 * per-replica boot-failure) stays uniform and readable.
 *
 * State-provider lifetime mirrors {@link bootOneTarget}: a fresh
 * `LocalStateProvider` is created at the top, disposed in `finally`,
 * even when the resolve / roll throws.
 */
async function rollOneTarget(args: {
  controller: ServiceController;
  newBoot: ServiceBoot;
  stacks: StackInfo[];
  options: EcsServiceEmulatorOptions;
  discovery: ServiceDiscoveryContext;
  skipPull: boolean;
  extraStateProviders: ExtraStateProviders | undefined;
  profileCredsFile: ProfileCredentialsFile | undefined;
  frontDoorPools: FrontDoorServicePools | undefined;
  suppressLoadBalancerWarning: boolean;
  /**
   * Phase 4 of issue #214 — per-target classifier verdict produced by
   * {@link classifySourceChange}. `'soft-reload'` skips the rebuild
   * primitive and invokes {@link softReloadReplica} for each replica
   * (`docker cp` + `docker restart`, no shadow boot, no atomic Cloud
   * Map / front-door swap because the registrations don't change).
   * `'rebuild'` falls through to the Phase 2/3 rolling primitive.
   */
  verdict: ReloadVerdict;
  logger: ReturnType<typeof getLogger>;
}): Promise<void> {
  const {
    controller,
    newBoot,
    stacks,
    options,
    discovery,
    skipPull,
    extraStateProviders,
    profileCredsFile,
    frontDoorPools,
    suppressLoadBalancerWarning,
    verdict,
    logger,
  } = args;

  const parsed = parseEcsTarget(newBoot.target);
  const candidate = pickCandidateStack(parsed.stackPattern, stacks);
  const stateProvider = createLocalStateProvider(
    options,
    candidate?.stackName ?? '',
    await resolveCfnFallbackRegion(options, candidate?.region),
    extraStateProviders
  );

  try {
    let resolved: { service: ResolvedEcsService; runnerOpts: ServiceRunnerOptions };
    try {
      resolved = await resolveServiceAndRunnerOpts(
        newBoot,
        stacks,
        options,
        discovery,
        skipPull,
        stateProvider,
        profileCredsFile,
        frontDoorPools,
        suppressLoadBalancerWarning,
        { quiet: true }
      );
    } catch (err) {
      // Resolution failure is recoverable on the next save (e.g. the
      // user added a Service Connect block referencing an undeclared
      // namespace and is mid-edit). Keep every existing replica
      // serving and tell the user what tripped.
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        `Reload of '${newBoot.target}' was rejected: ${reason}. Existing replica(s) keep serving.`
      );
      return;
    }
    const { service: newService, runnerOpts: newRunnerOpts } = resolved;

    // Snapshot the active replicas (non-shutting-down) BEFORE the roll
    // so subsequent `controller.runState.replicas.push(shadow)` doesn't
    // appear in the iteration set. Snapshot by reference identity so
    // each iteration finds its replica by index in runState.replicas
    // regardless of intra-iteration mutations.
    const oldReplicas = controller.runState.replicas.filter((r) => !r.shuttingDown);
    if (oldReplicas.length === 0) {
      logger.warn(
        `Reload of '${newBoot.target}': no live replicas to roll (all shutting down). ` +
          '`^C` and re-run start-service to recover.'
      );
      return;
    }

    // Effective new replica count (clamped by --max-tasks). When it
    // differs from the LIVE replica count (the snapshot of non-
    // shutting-down replicas), the rolling pathway still rolls
    // min(old, new) replicas through the new task definition but does
    // not add / remove the difference — scale-during-watch is left to
    // a follow-up under #214. Compare against `oldReplicas.length`
    // (the live count, refreshed every save) rather than
    // `controller.service.desiredCount` (the original boot's value,
    // never updated across rolls) so a user who saves once at
    // `DesiredCount: 2`, then saves again at the same value, does not
    // see the warn twice.
    if (newService.desiredCount !== oldReplicas.length) {
      logger.warn(
        `Reload of '${newBoot.target}': service DesiredCount=${newService.desiredCount} ` +
          `does not match the ${oldReplicas.length} live replica(s); rolling existing replicas ` +
          'only — scale changes during --watch are not yet supported. `^C` and re-run ' +
          'start-service to apply the new replica count.'
      );
    }

    // Phase 4 of issue #214 — the verdict picks the per-replica
    // action. `'soft-reload'` uses {@link softReloadReplica} (`docker
    // cp` + `docker restart`, no shadow boot, no atomic Cloud Map /
    // front-door swap because the registrations don't change);
    // `'rebuild'` uses {@link rollServiceReplica} verbatim — the
    // existing Phase 2/3 rolling primitive. The same per-replica
    // sequential loop wraps both: external traffic still sees a roll
    // that touches one replica at a time, and a per-replica failure
    // is logged + the loop continues.
    if (verdict.kind === 'soft-reload') {
      logger.info(
        `Reload of '${newBoot.target}': soft-reloading ${oldReplicas.length} replica(s) ` +
          'one at a time (docker cp source → docker restart → TCP-ready probe; no rebuild).'
      );
    } else {
      logger.info(
        `Reload of '${newBoot.target}': rolling ${oldReplicas.length} replica(s) ` +
          'one at a time (start new shadow → swap registrations → stop old).'
      );
    }

    for (const oldInstance of oldReplicas) {
      const idx = controller.runState.replicas.indexOf(oldInstance);
      if (idx === -1) {
        // The watcher tore this replica down between snapshot + roll.
        // Skip; the next save can pick up the gap.
        logger.warn(
          `Reload of '${newBoot.target}': replica r${oldInstance.index} ` +
            `(gen ${oldInstance.generation}) vanished before its roll; skipping.`
        );
        continue;
      }
      try {
        if (verdict.kind === 'soft-reload') {
          await softReloadReplica({
            controller,
            oldReplicaIndex: idx,
            newService,
            sourceDirToCopy: verdict.newAssetSourceDir,
          });
        } else {
          await rollServiceReplica({
            controller,
            oldReplicaIndex: idx,
            newService,
            newOptions: newRunnerOpts,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(
          `Reload of '${newBoot.target}' replica r${oldInstance.index}: ` +
            `${reason}. The old replica keeps serving; remaining replicas will still be rolled.`
        );
      }
    }
    // `pt.runState` and `pt.controller` are unchanged across either a
    // Phase 2 rolling reload or a Phase 4 soft-reload — the controller
    // is preserved; rebuild swaps replicas in place via
    // `rollServiceReplica`, soft-reload restarts them in place via
    // `softReloadReplica`.
  } finally {
    if (stateProvider) stateProvider.dispose();
  }
}

async function bootOneTarget(
  boot: ServiceBoot,
  runState: ServiceRunState,
  stacks: StackInfo[],
  options: EcsServiceEmulatorOptions,
  discovery: ServiceDiscoveryContext,
  skipPull: boolean,
  extraStateProviders: ExtraStateProviders | undefined,
  profileCredsFile: ProfileCredentialsFile | undefined,
  frontDoorPools: FrontDoorServicePools | undefined,
  suppressLoadBalancerWarning: boolean
): Promise<ServiceController> {
  const parsed = parseEcsTarget(boot.target);
  const candidate = pickCandidateStack(parsed.stackPattern, stacks);
  const stateProvider = createLocalStateProvider(
    options,
    candidate?.stackName ?? '',
    await resolveCfnFallbackRegion(options, candidate?.region),
    extraStateProviders
  );

  try {
    return await runOneTarget(
      boot,
      runState,
      stacks,
      options,
      discovery,
      skipPull,
      stateProvider,
      profileCredsFile,
      frontDoorPools,
      suppressLoadBalancerWarning
    );
  } finally {
    if (stateProvider) stateProvider.dispose();
  }
}

async function runOneTarget(
  boot: ServiceBoot,
  runState: ServiceRunState,
  stacks: StackInfo[],
  options: EcsServiceEmulatorOptions,
  discovery: ServiceDiscoveryContext,
  skipPull: boolean,
  stateProvider: LocalStateProvider | undefined,
  profileCredsFile: ProfileCredentialsFile | undefined,
  frontDoorPools: FrontDoorServicePools | undefined,
  suppressLoadBalancerWarning: boolean
): Promise<ServiceController> {
  const { service, runnerOpts } = await resolveServiceAndRunnerOpts(
    boot,
    stacks,
    options,
    discovery,
    skipPull,
    stateProvider,
    profileCredsFile,
    frontDoorPools,
    suppressLoadBalancerWarning
  );
  return startEcsService(service, runnerOpts, runState);
}

/**
 * Resolve a {@link ServiceBoot} to its `(ResolvedEcsService, ServiceRunnerOptions)`
 * pair. Shared by the initial boot path (`runOneTarget`) and the
 * Phase 2 of issue #214 rolling-reload pathway (`reloadAllServices`).
 *
 * Walks the same steps the original `runOneTarget` body did:
 *   1. Build the per-target image-resolution context (resolves
 *      asset / `Fn::Sub` / `--from-cfn-stack` overlays for image URIs).
 *   2. Resolve the ECS service target into a {@link ResolvedEcsService}.
 *   3. Apply the cross-stack env / secret resolver when the task
 *      references `Fn::ImportValue` / `Fn::GetStackOutput` across
 *      stacks.
 *   4. Resolve task-role credentials when `--assume-task-role` is set.
 *   5. Resolve `--env-vars` overrides.
 *   6. Compose {@link ServiceRunnerOptions} (including the shared
 *      `discovery` + per-service `frontDoor` pools the rolling
 *      reload depends on for atomic registry swaps).
 *
 * Side effects: logs the target descriptor + Service Connect /
 * ServiceRegistries banners ONLY on the initial boot. The reload
 * pathway calls this on every save; the banners would otherwise
 * spam the console once per save. Pass `quiet: true` to skip them.
 */
async function resolveServiceAndRunnerOpts(
  boot: ServiceBoot,
  stacks: StackInfo[],
  options: EcsServiceEmulatorOptions,
  discovery: ServiceDiscoveryContext,
  skipPull: boolean,
  stateProvider: LocalStateProvider | undefined,
  profileCredsFile: ProfileCredentialsFile | undefined,
  frontDoorPools: FrontDoorServicePools | undefined,
  suppressLoadBalancerWarning: boolean,
  opts: { quiet?: boolean } = {}
): Promise<{ service: ResolvedEcsService; runnerOpts: ServiceRunnerOptions }> {
  const logger = getLogger();
  const target = boot.target;
  const quiet = opts.quiet === true;

  const imageContext = await buildEcsImageResolutionContext(target, stacks, options, stateProvider);
  const service = resolveEcsServiceTarget(target, stacks, imageContext, {
    suppressLoadBalancerWarning,
  });
  if (!quiet) {
    logger.info(
      `Target: ${service.stack.stackName}/${service.serviceLogicalId} ` +
        `(service=${service.serviceName}, desiredCount=${service.desiredCount}, ` +
        `task=${service.task.taskDefinitionLogicalId})`
    );
  }
  if (!quiet && service.serviceConnect) {
    logger.info(
      `Service Connect: namespace='${service.serviceConnect.namespaceName}', ` +
        `${service.serviceConnect.services.length} service(s) registered for peer discovery.`
    );
  }
  if (!quiet && service.serviceRegistries.length > 0) {
    logger.info(`Cloud Map: ${service.serviceRegistries.length} ServiceRegistry binding(s).`);
  }

  // Cross-stack env / secret resolution post-pass.
  const taskStack = stacks.find((s) => s.stackName === service.stack.stackName) ?? service.stack;
  const taskNeeds = detectEcsImageResolutionNeeds(taskStack);
  if (stateProvider && taskNeeds.needsCrossStackResolver) {
    const consumerRegion =
      options.region ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      service.stack.region ??
      'us-east-1';
    const resolver = await stateProvider.buildCrossStackResolver(consumerRegion);
    if (resolver) {
      const subContext: SubstitutionContext = {
        resources: imageContext?.stateResources ?? {},
        ...(imageContext?.pseudoParameters && {
          pseudoParameters: imageContext.pseudoParameters,
        }),
        ...(imageContext?.stateParameters && {
          parameters: imageContext.stateParameters,
        }),
        ...(imageContext?.stateSensitiveParameters?.length && {
          sensitiveParameters: new Set(imageContext.stateSensitiveParameters),
        }),
        consumerRegion,
        crossStackResolver: resolver,
      };
      await applyCrossStackResolverToTask(service.task, subContext);
    }
  } else if (!stateProvider && taskNeeds.needsCrossStackResolver) {
    logger.warn(
      'Container Environment / Secrets entries contain Fn::ImportValue / Fn::GetStackOutput intrinsics. ' +
        'Pass a state-source flag (e.g. --from-cfn-stack or a host-provided extension) to substitute them against deployed state.'
    );
  }

  // Per-service task-role credentials.
  let assumedCredentials: RunEcsTaskOptions['taskCredentials'];
  let resolvedRoleArn: string | undefined;
  if (options.assumeTaskRole === true) {
    if (!service.task.taskRoleArn) {
      throw new LocalStartServiceError(
        `--assume-task-role passed without an ARN but service '${service.serviceLogicalId}' ` +
          `has no resolvable TaskRoleArn. Pass the ARN explicitly: --assume-task-role <arn>`
      );
    }
    resolvedRoleArn = await resolvePlaceholderAccount(service.task.taskRoleArn, options.region);
    assumedCredentials = await assumeTaskRole(resolvedRoleArn, options.region);
  } else if (typeof options.assumeTaskRole === 'string') {
    resolvedRoleArn = options.assumeTaskRole;
    assumedCredentials = await assumeTaskRole(resolvedRoleArn, options.region);
  }

  const envOverrides = readEnvOverridesFile(options.envVars);

  const taskOpts: RunEcsTaskOptions = {
    cluster: options.cluster,
    containerHost: options.containerHost,
    skipPull,
    keepRunning: false,
    detach: true,
  };
  if (envOverrides) taskOpts.envOverrides = envOverrides;
  if (assumedCredentials) taskOpts.taskCredentials = assumedCredentials;
  if (resolvedRoleArn) taskOpts.taskRoleArn = resolvedRoleArn;
  if (options.platform) taskOpts.platformOverride = options.platform;
  if (options.region) taskOpts.region = options.region;
  if (options.ecrRoleArn) taskOpts.ecrRoleArn = options.ecrRoleArn;
  if (options.profile) taskOpts.profile = options.profile;
  const hostPortOverrides = parseHostPortOverrides(options.hostPort);
  if (Object.keys(hostPortOverrides).length > 0) taskOpts.hostPortOverrides = hostPortOverrides;
  if (profileCredsFile && !assumedCredentials) {
    taskOpts.profileCredentialsFile = {
      hostPath: profileCredsFile.hostPath,
      containerPath: profileCredsFile.containerPath,
      profileName: profileCredsFile.profileName,
    };
  }

  // Front-door pools for THIS service (built once at the emulator level and
  // shared with the listener servers). Each replica publishes + registers its
  // ephemeral endpoint into these pools as it boots. Undefined / empty for a
  // pure-compute boot (start-service) or a service no listener forwards to.
  const runnerOpts: ServiceRunnerOptions = {
    maxTasks: options.maxTasks,
    restartPolicy: options.restartPolicy,
    taskOptions: taskOpts,
    discovery,
    ...(frontDoorPools && frontDoorPools.length > 0
      ? { frontDoor: { pools: frontDoorPools } }
      : {}),
    // Issue #227 — Commander's `--no-logs` populates `options.logs =
    // false`. Default ON when neither flag is supplied (`options.logs ===
    // undefined`) for parity with `cdkl run-task`.
    streamLogs: options.logs !== false,
  };

  return { service, runnerOpts };
}

/**
 * Stand up one host-side reverse-proxy server PER LISTENER PORT from the
 * resolved {@link FrontDoorPlan}, path-routing each request across the services
 * the listener fronts, and return the started servers (for teardown) plus a
 * per-service-target pool list to thread into each service's runner (so every
 * replica publishes + registers its ephemeral endpoint into the right pool).
 *
 * One `FrontDoorEndpointPool` is created per distinct (service, container,
 * port) forward target and SHARED between the listener's routing table and the
 * owning service's runner context — same object on both sides, so a replica
 * registering itself is immediately reachable through the front-door.
 *
 * On a bind failure (e.g. EACCES on a privileged listener port, or the port is
 * already in use) every server started so far is closed and the error is
 * re-thrown with a `--lb-port` hint.
 */
export async function buildFrontDoor(
  plan: FrontDoorPlan,
  options: EcsServiceEmulatorOptions,
  logger: ReturnType<typeof getLogger>
): Promise<{
  servers: StartedFrontDoorServer[];
  frontDoorByService: Map<string, FrontDoorServicePools>;
  lambdaRunners: FrontDoorLambdaRunner[];
}> {
  const containerHost = options.containerHost;
  const servers: StartedFrontDoorServer[] = [];
  // ECS poolKey -> { pool, target }. Built lazily so the same (service,
  // container, port) reuses one pool across listeners / rules.
  const poolRegistry = new Map<
    string,
    { pool: FrontDoorEndpointPool; target: PlannedEcsForwardTarget }
  >();
  // Lambda logicalId -> one warm runner, reused across listeners / rules.
  const lambdaRegistry = new Map<string, FrontDoorLambdaRunner>();

  const dispatchFor = (t: PlannedForwardTarget): FrontDoorDispatchTarget => {
    if (t.kind === 'lambda') {
      let runner = lambdaRegistry.get(t.lambda.logicalId);
      if (!runner) {
        runner = createFrontDoorLambdaRunner(t.lambda, {
          containerHost,
          skipPull: options.pull === false,
          ...(options.platform !== undefined && { platformOverride: options.platform }),
          ...(options.ecrRoleArn !== undefined && { ecrRoleArn: options.ecrRoleArn }),
          ...(options.region !== undefined && { region: options.region }),
        });
        lambdaRegistry.set(t.lambda.logicalId, runner);
      }
      const boundRunner = runner;
      return {
        kind: 'lambda',
        lambda: {
          targetGroupArn: t.targetGroupArn,
          multiValueHeaders: t.multiValueHeaders,
          label: t.lambda.logicalId,
          invoke: (event) => boundRunner.invoke(event),
        },
      };
    }
    const key = `${t.serviceTarget} ${t.targetContainerName} ${t.targetContainerPort}`;
    let entry = poolRegistry.get(key);
    if (!entry) {
      entry = { pool: new FrontDoorEndpointPool(), target: t };
      poolRegistry.set(key, entry);
    }
    return { kind: 'pool', pool: entry.pool };
  };
  // Build / reuse the weighted dispatch entry for one planned forward target:
  // an ECS pool or a Lambda invoker, carrying the target's forward weight.
  const weightedTargetFor = (t: PlannedForwardTarget): WeightedForwardTarget => {
    const dispatch = dispatchFor(t);
    return dispatch.kind === 'lambda'
      ? { lambda: dispatch.lambda, weight: t.weight }
      : { pool: dispatch.pool, weight: t.weight };
  };
  // Convert a planned action into the front-door's RouteAction, building /
  // reusing a pool or Lambda runner per weighted forward target.
  const toRouteAction = (action: PlannedAction): RouteAction => {
    if (action.kind === 'forward') {
      const pools: WeightedForwardTarget[] = action.targets.map(weightedTargetFor);
      return { kind: 'forward', pools };
    }
    if (action.kind === 'redirect') {
      return {
        kind: 'redirect',
        statusCode: action.statusCode,
        ...(action.protocol !== undefined && { protocol: action.protocol }),
        ...(action.host !== undefined && { host: action.host }),
        ...(action.port !== undefined && { port: action.port }),
        ...(action.path !== undefined && { path: action.path }),
        ...(action.query !== undefined && { query: action.query }),
      };
    }
    return {
      kind: 'fixed-response',
      statusCode: action.statusCode,
      ...(action.contentType !== undefined && { contentType: action.contentType }),
      ...(action.messageBody !== undefined && { messageBody: action.messageBody }),
    };
  };

  // Decide whether HTTPS listeners terminate TLS locally. Opting in requires
  // either an explicit `--tls`, or supplying `--tls-cert` / `--tls-key`
  // (passing the cert pair is treated as a strong signal that the user wants
  // real TLS — they would not have bothered otherwise). The default leaves
  // cloud-HTTPS listeners on plain HTTP locally; `X-Forwarded-Proto: https`
  // is preserved further down so upstream apps still see the deployed
  // listener protocol.
  const hasHttpsListener = plan.listeners.some((l) => l.protocol === 'HTTPS');
  const wantTls =
    options.tls === true || options.tlsCert !== undefined || options.tlsKey !== undefined;
  const needsTlsMaterials = hasHttpsListener && wantTls;
  // Resolve TLS materials once, up front, when any HTTPS listener will
  // actually terminate TLS locally. Kept OUTSIDE the surrounding try/catch
  // so a TLS resolution failure (e.g. openssl missing, BYO PEM unreadable)
  // surfaces its own actionable error instead of being re-wrapped in the
  // generic `--lb-port` port-bind envelope below. A single resolve is
  // shared across every HTTPS listener.
  const tlsMaterials: FrontDoorTlsMaterials | undefined = needsTlsMaterials
    ? await resolveFrontDoorTlsMaterials({
        certPath: options.tlsCert,
        keyPath: options.tlsKey,
      })
    : undefined;

  // Shared JWKS cache + warn-once Set, both at buildFrontDoor scope so two
  // rules pointing at the same Cognito JWKS URL de-dupe the "JWKS
  // unreachable -> pass-through" warn line instead of each warning
  // independently.
  const jwksCache = createJwksCache();
  const sharedWarned = new Set<string>();
  const authForGuard = (guard: FrontDoorAuthGuard): ReturnType<typeof buildAuthCheck> =>
    buildAuthCheck(guard, jwksCache, {
      ...(options.verifyAuth === false && { noVerifyAuth: true }),
      ...(options.bearerToken !== undefined && { bearerToken: options.bearerToken }),
      warned: sharedWarned,
    });
  const attachAuth = (action: RouteAction, guard: FrontDoorAuthGuard | undefined): RouteAction =>
    guard ? { ...action, auth: authForGuard(guard) } : action;

  try {
    for (const listener of plan.listeners) {
      const defaultRoute = listener.defaultAction
        ? attachAuth(toRouteAction(listener.defaultAction), listener.defaultAuthGuard)
        : undefined;
      const ruleRoutes: AlbPathRule<RouteAction>[] = listener.rules.map((r) => ({
        priority: r.priority,
        pathPatterns: r.pathPatterns,
        hostPatterns: r.hostPatterns,
        httpHeaderConditions: r.httpHeaderConditions,
        httpRequestMethods: r.httpRequestMethods,
        queryStringConditions: r.queryStringConditions,
        sourceIpCidrs: r.sourceIpCidrs,
        target: attachAuth(toRouteAction(r.action), r.authGuard),
      }));
      const route = (req: {
        path: string;
        host?: string;
        headers?: NodeJS.Dict<string | string[]>;
        method?: string;
        sourceIp?: string;
      }): RouteAction | undefined => matchAlbPathRule(req, ruleRoutes) ?? defaultRoute;

      const tls = listener.protocol === 'HTTPS' && wantTls ? tlsMaterials : undefined;
      const forwardedProto: 'http' | 'https' = listener.protocol === 'HTTPS' ? 'https' : 'http';
      const degradedHttps = listener.protocol === 'HTTPS' && !wantTls;
      // Per-listener rule summary surfaced in the no-rule-matched 404 body so a
      // user whose request missed on (say) the Host header sees every rule's
      // condition + action target, not just the request path (issue #228).
      const rulesSummary: FrontDoorRuleSummary[] = listener.rules.map(buildRuleSummary);
      const server = await startFrontDoorServer({
        route,
        port: listener.hostPort,
        host: containerHost,
        listenerPort: listener.listenerPort,
        label: `listener port ${listener.listenerPort}`,
        forwardedProto,
        rulesSummary,
        ...(tls ? { tls } : {}),
      });
      servers.push(server);

      logger.info(
        `ALB front-door: ${server.scheme}://${server.host}:${server.port} (listener port ${listener.listenerPort})`
      );
      if (degradedHttps) {
        logger.warn(
          `  WARN: listener port ${listener.listenerPort} is HTTPS in the cloud but serving HTTP ` +
            'locally (X-Forwarded-Proto: https preserved). Pass --tls to terminate TLS locally ' +
            'with a self-signed or user-supplied cert.'
        );
      }
      if (listener.defaultAction) {
        logger.info(`  default -> ${describeAction(listener.defaultAction)}`);
      }
      for (const r of [...listener.rules].sort((a, b) => a.priority - b.priority)) {
        logger.info(
          `  ${describeConditions(r)} (priority ${r.priority}) -> ${describeAction(r.action)}`
        );
      }
      if (!listener.defaultAction) {
        logger.info('  (no default action: unmatched requests return 404)');
      }
    }

    // Boot every distinct Lambda-target container before returning so the
    // front-door is invokable as soon as it accepts connections. A boot
    // failure tears down everything started so far (servers + earlier
    // runners) and propagates with the same `--lb-port` hint envelope.
    for (const runner of lambdaRegistry.values()) {
      logger.info(`Booting Lambda target '${runner.logicalId}' behind the ALB front-door...`);
      await runner.start();
    }
  } catch (err) {
    await Promise.allSettled(servers.map((s) => s.close()));
    await Promise.allSettled([...lambdaRegistry.values()].map((r) => r.stop()));
    throw new LocalStartServiceError(
      `Failed to start ALB front-door: ${err instanceof Error ? err.message : String(err)}. If a ` +
        'listener port is privileged (< 1024), remap it to a non-privileged host port with ' +
        '--lb-port <listenerPort>=<hostPort> (e.g. --lb-port 80=8080).'
    );
  }

  const frontDoorByService = new Map<string, FrontDoorServicePools>();
  for (const { pool, target } of poolRegistry.values()) {
    const list = frontDoorByService.get(target.serviceTarget) ?? [];
    list.push({
      pool,
      targetContainerName: target.targetContainerName,
      targetContainerPort: target.targetContainerPort,
    });
    frontDoorByService.set(target.serviceTarget, list);
  }
  return { servers, frontDoorByService, lambdaRunners: [...lambdaRegistry.values()] };
}

/** Human-readable summary of a planned rule's six ALB condition fields (for the boot banner). */
function describeConditions(rule: {
  pathPatterns: string[];
  hostPatterns: string[];
  httpHeaderConditions: AlbHttpHeaderCondition[];
  httpRequestMethods: string[];
  queryStringConditions: AlbQueryStringCondition[];
  sourceIpCidrs: string[];
}): string {
  const parts: string[] = [];
  if (rule.pathPatterns.length > 0) parts.push(`path ${rule.pathPatterns.join(', ')}`);
  if (rule.hostPatterns.length > 0) parts.push(`host ${rule.hostPatterns.join(', ')}`);
  for (const h of rule.httpHeaderConditions) {
    parts.push(`header ${h.name}: ${h.values.join(', ')}`);
  }
  if (rule.httpRequestMethods.length > 0) {
    parts.push(`method ${rule.httpRequestMethods.join(', ')}`);
  }
  if (rule.queryStringConditions.length > 0) {
    parts.push(`query ${rule.queryStringConditions.map(describeQueryStringCondition).join(', ')}`);
  }
  if (rule.sourceIpCidrs.length > 0) parts.push(`source-ip ${rule.sourceIpCidrs.join(', ')}`);
  return parts.join(' AND ') || '(no condition)';
}

function describeQueryStringCondition(c: AlbQueryStringCondition): string {
  return c.key !== undefined ? `${c.key}=${c.value}` : c.value;
}

/** Human-readable summary of a planned action (for the boot banner). */
function describeAction(action: PlannedAction): string {
  if (action.kind === 'redirect') {
    return `redirect ${action.statusCode}`;
  }
  if (action.kind === 'fixed-response') {
    return `fixed-response ${action.statusCode}`;
  }
  if (action.targets.length === 1) {
    return describeTarget(action.targets[0]!);
  }
  const weights = action.targets.map((t) => `${describeTargetShort(t)}@${t.weight}`).join(', ');
  return `weighted forward [${weights}]`;
}

/** One forward target, described in full (for a single-target forward banner). */
function describeTarget(t: PlannedForwardTarget): string {
  if (t.kind === 'lambda') {
    return `Lambda ${t.lambda.logicalId} (invoke)`;
  }
  return `${t.serviceTarget} (container ${t.targetContainerName}:${t.targetContainerPort}) (round-robin)`;
}

/** One forward target, described compactly (for a weighted-forward banner). */
function describeTargetShort(t: PlannedForwardTarget): string {
  return t.kind === 'lambda' ? `Lambda ${t.lambda.logicalId}` : t.serviceTarget;
}

/**
 * Build the per-rule summary the front-door surfaces in its no-rule-matched
 * 404 body (issue #228). One condition row per constrained ALB field, plus a
 * pre-formatted action target. Distinct from {@link describeConditions} /
 * {@link describeAction} (which produce a single-line boot-banner string) —
 * the 404 body needs the rule decomposed into its constituent fields so the
 * formatter can render `field in [values]` rows.
 */
function buildRuleSummary(rule: {
  priority: number;
  pathPatterns: string[];
  hostPatterns: string[];
  httpHeaderConditions: AlbHttpHeaderCondition[];
  httpRequestMethods: string[];
  queryStringConditions: AlbQueryStringCondition[];
  sourceIpCidrs: string[];
  action: PlannedAction;
}): FrontDoorRuleSummary {
  const conditions: FrontDoorRuleConditionSummary[] = [];
  if (rule.pathPatterns.length > 0) {
    conditions.push({ field: 'path-pattern', values: rule.pathPatterns });
  }
  if (rule.hostPatterns.length > 0) {
    conditions.push({ field: 'host-header', values: rule.hostPatterns });
  }
  for (const h of rule.httpHeaderConditions) {
    conditions.push({ field: 'http-header', values: [`${h.name}: ${h.values.join(', ')}`] });
  }
  if (rule.httpRequestMethods.length > 0) {
    conditions.push({ field: 'http-request-method', values: rule.httpRequestMethods });
  }
  if (rule.queryStringConditions.length > 0) {
    conditions.push({
      field: 'query-string',
      values: rule.queryStringConditions.map(describeQueryStringCondition),
    });
  }
  if (rule.sourceIpCidrs.length > 0) {
    conditions.push({ field: 'source-ip', values: rule.sourceIpCidrs });
  }
  return {
    priority: rule.priority,
    conditions,
    action: describeRuleActionForSummary(rule.action),
  };
}

/**
 * Describe a planned action for the no-rule-matched 404 body (issue #228).
 * Uses the `<ECS: ...>` / `<Lambda: ...>` shape the issue body proposes so a
 * user can read each rule's target at a glance.
 */
function describeRuleActionForSummary(action: PlannedAction): string {
  if (action.kind === 'redirect') return `redirect ${action.statusCode}`;
  if (action.kind === 'fixed-response') return `fixed-response ${action.statusCode}`;
  if (action.targets.length === 1) {
    return `forward to ${describeForwardTargetForSummary(action.targets[0]!)}`;
  }
  const weights = action.targets
    .map((t) => `${describeForwardTargetForSummary(t)}@${t.weight}`)
    .join(', ');
  return `forward weighted [${weights}]`;
}

/**
 * One forward target named the way the 404 body shows it: `<ECS: Service>` or
 * `<Lambda: LogicalId>` — distinct from the boot-banner format (which also
 * prints the container / port / round-robin hint) so the 404 body stays
 * scannable.
 */
function describeForwardTargetForSummary(t: PlannedForwardTarget): string {
  return t.kind === 'lambda' ? `<Lambda: ${t.lambda.logicalId}>` : `<ECS: ${t.serviceTarget}>`;
}

async function resolvePlaceholderAccount(arn: string, region: string | undefined): Promise<string> {
  if (!arn.includes(TASK_ROLE_ACCOUNT_PLACEHOLDER)) return arn;
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const account = identity.Account;
    if (!account) {
      throw new LocalStartServiceError(
        `--assume-task-role: GetCallerIdentity returned no Account; cannot resolve placeholder ARN '${arn}'.`
      );
    }
    return arn.split(TASK_ROLE_ACCOUNT_PLACEHOLDER).join(account);
  } finally {
    sts.destroy();
  }
}

async function assumeTaskRole(
  roleArn: string,
  region: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `${getEmbedConfig().resourceNamePrefix}-start-service-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new LocalStartServiceError(`AssumeRole(${roleArn}) returned no usable credentials.`);
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } finally {
    sts.destroy();
  }
}

/**
 * Build the substitution context the ECS resolver consumes. Exported for the
 * site-level binding test that locks the `--from-cfn-stack` SSM-parameter
 * resolution call (issue #94).
 */
export async function buildEcsImageResolutionContext(
  target: string,
  stacks: StackInfo[],
  options: EcsServiceEmulatorOptions,
  stateProvider: LocalStateProvider | undefined
): Promise<EcsImageResolutionContext | undefined> {
  const logger = getLogger();
  const parsed = parseEcsTarget(target);
  const candidate = pickCandidateStack(parsed.stackPattern, stacks);
  if (!candidate) return undefined;

  const needs = detectEcsImageResolutionNeeds(candidate);
  if (
    !needs.needsPseudoParameters &&
    !needs.needsStateResources &&
    !needs.needsEnvOrSecretSubstitution
  ) {
    return undefined;
  }

  const ctx: EcsImageResolutionContext = {};

  const wantsPseudoForEnvOrSecret = !!stateProvider && needs.needsEnvOrSecretSubstitution;
  if (needs.needsPseudoParameters || wantsPseudoForEnvOrSecret) {
    const region =
      options.region ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      candidate.region;
    if (!region) {
      logger.warn(
        `Resolver references \${AWS::Region} but ${getEmbedConfig().binaryName} could not determine the target region. ` +
          'Pass --region, set AWS_REGION, or declare env.region on the CDK stack.'
      );
    }
    let accountId: string | undefined;
    try {
      accountId = await resolveCallerAccountId(region, options.profile);
    } catch (err) {
      logger.warn(
        `Resolver needs \${AWS::AccountId} but STS GetCallerIdentity failed: ${err instanceof Error ? err.message : String(err)}. ` +
          'Substitution will be skipped; affected env / secret entries will be dropped with per-key warnings.'
      );
    }
    const partitionAndSuffix = region ? derivePartitionAndUrlSuffix(region) : undefined;
    ctx.pseudoParameters = {
      ...(accountId !== undefined && { accountId }),
      ...(region !== undefined && { region }),
      ...(partitionAndSuffix && {
        partition: partitionAndSuffix.partition,
        urlSuffix: partitionAndSuffix.urlSuffix,
      }),
    };
  }

  const wantsState = needs.needsStateResources || needs.needsEnvOrSecretSubstitution;
  if (stateProvider && wantsState) {
    const loaded = await stateProvider.load(candidate.stackName, candidate.region);
    if (loaded) {
      ctx.stateResources = loaded.resources;
    } else {
      // load() returned undefined — capture the provider's failure
      // detail so the resolver's "needs deployed state" error reports
      // what AWS actually said instead of telling the user to re-pass
      // a flag they already passed.
      const loadError = stateProvider.getLastLoadError?.();
      if (loadError) ctx.stateLoadFailureMessage = loadError;
    }
    if (needs.needsEnvOrSecretSubstitution && stateProvider.resolveTemplateSsmParameters) {
      const ssmParameters = await stateProvider.resolveTemplateSsmParameters(candidate.template);
      if (Object.keys(ssmParameters.values).length > 0) ctx.stateParameters = ssmParameters.values;
      if (ssmParameters.secureStringLogicalIds.length > 0) {
        ctx.stateSensitiveParameters = ssmParameters.secureStringLogicalIds;
      }
    }
  } else if (!stateProvider && needs.needsStateResources) {
    logger.warn(
      'Container Image references a same-stack AWS::ECR::Repository. Pass a state-source flag ' +
        '(e.g. --from-cfn-stack or a host-provided extension) to substitute the deployed repository URI.'
    );
  } else if (!stateProvider && needs.needsEnvOrSecretSubstitution) {
    logger.warn(
      'Container Environment / Secrets entries contain CloudFormation intrinsics. ' +
        'Pass a state-source flag (e.g. --from-cfn-stack or a host-provided extension) to substitute them against the deployed state.'
    );
  }

  return ctx;
}

function pickCandidateStack(
  stackPattern: string | null,
  stacks: StackInfo[]
): StackInfo | undefined {
  if (stackPattern === null) {
    if (stacks.length === 1) return stacks[0];
    return undefined;
  }
  const matched = matchStacks(stacks, [stackPattern]);
  if (matched.length === 1) return matched[0];
  return undefined;
}

async function resolveCallerAccountId(
  region: string | undefined,
  profile: string | undefined
): Promise<string | undefined> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }), ...(profile && { profile }) });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return identity.Account;
  } finally {
    sts.destroy();
  }
}

function readEnvOverridesFile(
  filePath: string | undefined
): Record<string, Record<string, string | null> | undefined> | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new LocalStartServiceError(
      `Failed to read --env-vars file '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LocalStartServiceError(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalStartServiceError(
      `--env-vars file '${filePath}' must contain a JSON object at the top level.`
    );
  }
  return parsed as Record<string, Record<string, string | null> | undefined>;
}

/**
 * Print a consolidated "Service endpoints:" banner so the access URL ends up
 * at the BOTTOM of the boot output instead of buried mid-`docker pull`. Two
 * sources are surfaced:
 *
 *  1. Per-service static host-port publishes recorded by the runner in
 *     `EcsRunState.publishedEndpoints` (single-replica `start-service`).
 *     Multi-replica services skip the host-port publish and contribute
 *     nothing here.
 *  2. Host-side ALB front-door listener URLs (`start-alb`). The
 *     `buildFrontDoor` step also logs an `ALB front-door: ...` line for each
 *     listener earlier in the stream (it's the load-bearing marker the integ
 *     tests grep for), but it streams BEFORE the docker-pull noise. Echoing
 *     it here re-surfaces the URL at the bottom for the user.
 *
 * Silent when neither source has anything to show.
 */
export function logEndpointsBanner(
  perTarget: ReadonlyArray<{ controller?: ServiceController }>,
  frontDoorServers: ReadonlyArray<StartedFrontDoorServer>,
  logger: ReturnType<typeof getLogger>
): void {
  const lines: string[] = [];
  for (const pt of perTarget) {
    const controller = pt.controller;
    if (!controller) continue;
    // Static publishes are identical across replicas (only single-replica
    // services publish; multi-replica skips host-port publish entirely), so
    // we read the first active replica's record.
    const activeReplica = controller.runState.replicas.find((r) => !r.shuttingDown);
    const endpoints = activeReplica?.state.publishedEndpoints ?? [];
    if (endpoints.length === 0) continue;
    lines.push(`  ${controller.service.serviceName}`);
    for (const ep of endpoints) {
      const scheme = ep.protocol.toLowerCase() === 'udp' ? 'udp' : 'http';
      const override = ep.overridden ? '  (--host-port override)' : '';
      lines.push(
        `    ${ep.containerName} container port ${ep.containerPort}/${ep.protocol} -> ${scheme}://${ep.host}:${ep.hostPort}${override}`
      );
    }
  }
  if (frontDoorServers.length > 0) {
    lines.push('  ALB front-door');
    for (const s of frontDoorServers) {
      lines.push(`    ${s.scheme}://${s.host}:${s.port}`);
    }
  }
  if (lines.length === 0) return;
  logger.info('Service endpoints:');
  for (const l of lines) logger.info(l);
}

function parsePositiveInt(raw: string, flagName: string): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new LocalStartServiceError(`${flagName} must be a positive integer (got '${raw}').`);
  }
  return parsed;
}

/**
 * Hard cap on `--max-tasks` driven by the per-replica subnet allocator in
 * `ecs-service-runner.ts:pickSubnetOctet`.
 */
export const MAX_TASKS_SUBNET_RANGE_CAP = 83;

export function parseMaxTasks(raw: string): number {
  const parsed = parsePositiveInt(raw, '--max-tasks');
  if (parsed > MAX_TASKS_SUBNET_RANGE_CAP) {
    throw new LocalStartServiceError(
      `--max-tasks ${parsed} exceeds the per-replica link-local /24 subnet allocator's range ` +
        `(${MAX_TASKS_SUBNET_RANGE_CAP}). Lower --max-tasks to <= ${MAX_TASKS_SUBNET_RANGE_CAP}.`
    );
  }
  return parsed;
}

export function parseRestartPolicy(raw: string): 'on-failure' | 'always' | 'none' {
  if (raw === 'on-failure' || raw === 'always' || raw === 'none') return raw;
  throw new LocalStartServiceError(
    `--restart-policy must be one of 'on-failure', 'always', or 'none' (got '${raw}').`
  );
}

/**
 * Resolve the credentials forwarded to the AWS-published metadata-endpoints
 * sidecar (shared across every replica boot in one CLI invocation). `--profile`
 * resolves via the SDK default chain; unset yields `undefined`. Per-service
 * `--assume-task-role` overrides are intentionally NOT consulted here. Exported
 * for a unit test that exercises both branches.
 */
export async function resolveSharedSidecarCredentials(options: {
  profile?: string;
}): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined> {
  if (options.profile) return resolveProfileCredentials(options.profile);
  return undefined;
}

/**
 * Add the CLI options shared by both ECS-service commands (`start-service` and
 * `start-alb`) to a command. The command-specific argument / description and
 * the one unique option (`--host-port` vs `--lb-port`) are added by each
 * factory.
 */
export function addCommonEcsServiceOptions(cmd: Command): Command {
  cmd
    .addOption(
      new Option(
        '--cluster <name>',
        'Cluster name surfaced to ECS_CONTAINER_METADATA_URI_V4 and used as the docker network prefix'
      ).default(getEmbedConfig().resourceNamePrefix)
    )
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"ContainerName":{"KEY":"VALUE"}, "Parameters":{}})'
      )
    )
    .addOption(
      new Option(
        '--container-host <ip>',
        'Host IP to bind published container ports to. Must be a numeric IP (Docker rejects hostnames here)'
      ).default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--assume-task-role [arn]',
        "Assume the task definition's TaskRoleArn (or the supplied ARN) and forward STS-issued temp " +
          'credentials via the metadata sidecar so containers run with the deployed task role. ' +
          "Bare flag uses the template's TaskRoleArn; pass an explicit ARN to override."
      )
    )
    .addOption(
      new Option('--no-pull', 'Skip docker pull for every container image and the metadata sidecar')
    )
    .addOption(
      new Option(
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized registries.'
      )
    )
    .addOption(
      new Option(
        '--platform <platform>',
        'Force docker --platform (linux/amd64 or linux/arm64). Default: inferred from task RuntimePlatform.CpuArchitecture'
      )
    )
    .addOption(
      new Option(
        '--max-tasks <n>',
        'Hard cap on local replica count. Caps the template DesiredCount so local dev machines ' +
          "don't run an unbounded number of containers. Cannot exceed " +
          `${MAX_TASKS_SUBNET_RANGE_CAP} due to the per-replica link-local /24 subnet allocator's range.`
      )
        .default(3)
        .argParser(parseMaxTasks)
    )
    .addOption(
      new Option(
        '--restart-policy <policy>',
        "How to react when an essential container exits. 'on-failure' (default) restarts only " +
          "on non-zero exit; 'always' restarts on every exit; 'none' shuts the replica down " +
          'and runs the service degraded.'
      )
        .default('on-failure')
        .argParser(parseRestartPolicy)
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via ListStackResources and substitute Ref / Fn::ImportValue ' +
          'in container env vars / secrets / image URIs with the deployed physical IDs / exports. ' +
          'Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). ' +
          `Bare form uses the ${getEmbedConfig().binaryName} stack name; pass an explicit value when the CFn stack name differs. ` +
          'Fn::GetAtt is warn-and-dropped in v1 (CFn ListStackResources does not return per-attribute values).'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-cfn-stack as the CFn client region.'
      )
    )
    .addOption(
      new Option(
        '--no-logs',
        'Disable foreground streaming of each replica container stdout/stderr. By default every ' +
          'booted replica streams its docker logs to the host terminal with a ' +
          '[svc=<service> r=<replica-index> c=<container>] prefix (parity with `run-task`). ' +
          'Pass --no-logs for multi-replica / multi-service runs whose interleaved log volume ' +
          'is unreadable; `docker logs -f <id>` in a separate terminal stays available.'
      )
    );

  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
