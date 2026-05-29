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
import { resolveApp } from '../config-loader.js';
import { ensureDockerAvailable } from '../../local/docker-runner.js';
import { resolveProfileCredentials } from './local-start-api.js';
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
  startEcsService,
  type ServiceController,
  type ServiceDiscoveryContext,
  type ServiceRunnerOptions,
  type ServiceRunState,
} from '../../local/ecs-service-runner.js';
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
  type StartedFrontDoorServer,
} from '../../local/front-door-server.js';
import { matchAlbPathRule, type AlbPathRule } from '../../local/alb-path-matcher.js';

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
  /** Host-injected extra state-source flag fields. */
  [key: string]: unknown;
}

/** One ECS service to boot. Front-door wiring lives in the {@link FrontDoorPlan}. */
export interface ServiceBoot {
  /** Service target string (`Stack:LogicalId` or `Stack/Path`). */
  target: string;
}

/** The backing (service target, container) a listener action forwards to. */
export interface PlannedForwardTarget {
  /** Service target string (`Stack:LogicalId`) whose replica pool serves this. */
  serviceTarget: string;
  /** Container the listener forwards to. */
  targetContainerName: string;
  /** Container port the target group targets. */
  targetContainerPort: number;
}

/** One host front-door listener: a bound host port + its path-routing table. */
export interface PlannedFrontDoorListener {
  /** ALB listener port (for the `X-Forwarded-Port` header / logs). */
  listenerPort: number;
  /** Host port to bind (the listener port, or its `--lb-port` override). */
  hostPort: number;
  /** Default-action forward target (absent for a rules-only listener -> 404 on miss). */
  defaultTarget?: PlannedForwardTarget;
  /** Path-pattern rules, evaluated by priority (lower first). */
  rules: Array<{ priority: number; pathPatterns: string[]; target: PlannedForwardTarget }>;
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

  const cleanup = singleFlight(
    async (): Promise<void> => {
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
    if (boots.length === 0) {
      throw new LocalStartServiceError(
        `No runnable ECS service resolved from ${resolvedTargets.join(', ')}.`
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
      const built = await buildFrontDoor(frontDoor, options.containerHost, logger);
      frontDoorServers = built.servers;
      frontDoorByService = built.frontDoorByService;
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
        frontDoorByService.get(pt.boot.target)
      );
    }

    const summary = perTarget
      .map(
        (pt) =>
          `${pt.controller!.service.serviceName} (${pt.controller!.activeReplicaCount()} replica(s))`
      )
      .join(', ');
    logger.info(`Service(s) running: ${summary}.`);
    logger.info('Press ^C to shut down.');

    await Promise.all(perTarget.map((pt) => pt.controller!.waitForShutdown()));
  } finally {
    if (sigintHandler) {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigintHandler);
    }
    await cleanup();
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
  frontDoorPools: FrontDoorServicePools | undefined
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
      frontDoorPools
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
  frontDoorPools: FrontDoorServicePools | undefined
): Promise<ServiceController> {
  const logger = getLogger();
  const target = boot.target;

  const imageContext = await buildEcsImageResolutionContext(target, stacks, options, stateProvider);
  const service = resolveEcsServiceTarget(target, stacks, imageContext);
  logger.info(
    `Target: ${service.stack.stackName}/${service.serviceLogicalId} ` +
      `(service=${service.serviceName}, desiredCount=${service.desiredCount}, ` +
      `task=${service.task.taskDefinitionLogicalId})`
  );
  if (service.serviceConnect) {
    logger.info(
      `Service Connect: namespace='${service.serviceConnect.namespaceName}', ` +
        `${service.serviceConnect.services.length} service(s) registered for peer discovery.`
    );
  }
  if (service.serviceRegistries.length > 0) {
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
  };

  return startEcsService(service, runnerOpts, runState);
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
  containerHost: string,
  logger: ReturnType<typeof getLogger>
): Promise<{
  servers: StartedFrontDoorServer[];
  frontDoorByService: Map<string, FrontDoorServicePools>;
}> {
  const servers: StartedFrontDoorServer[] = [];
  // poolKey -> { pool, target }. Built lazily so the same (service, container,
  // port) reuses one pool across listeners / rules.
  const registry = new Map<string, { pool: FrontDoorEndpointPool; target: PlannedForwardTarget }>();
  const poolFor = (t: PlannedForwardTarget): FrontDoorEndpointPool => {
    const key = `${t.serviceTarget} ${t.targetContainerName} ${t.targetContainerPort}`;
    let entry = registry.get(key);
    if (!entry) {
      entry = { pool: new FrontDoorEndpointPool(), target: t };
      registry.set(key, entry);
    }
    return entry.pool;
  };

  try {
    for (const listener of plan.listeners) {
      const defaultPool = listener.defaultTarget ? poolFor(listener.defaultTarget) : undefined;
      const ruleRoutes: AlbPathRule<FrontDoorEndpointPool>[] = listener.rules.map((r) => ({
        priority: r.priority,
        pathPatterns: r.pathPatterns,
        target: poolFor(r.target),
      }));
      const selectPool = (requestPath: string): FrontDoorEndpointPool | undefined =>
        matchAlbPathRule(requestPath, ruleRoutes) ?? defaultPool;

      const server = await startFrontDoorServer({
        selectPool,
        port: listener.hostPort,
        host: containerHost,
        listenerPort: listener.listenerPort,
        label: `listener port ${listener.listenerPort}`,
      });
      servers.push(server);

      logger.info(
        `ALB front-door: http://${server.host}:${server.port} (listener port ${listener.listenerPort})`
      );
      if (listener.defaultTarget) {
        logger.info(`  default -> ${describeTarget(listener.defaultTarget)} (round-robin)`);
      }
      for (const r of [...listener.rules].sort((a, b) => a.priority - b.priority)) {
        logger.info(
          `  path ${r.pathPatterns.join(', ')} (priority ${r.priority}) -> ${describeTarget(r.target)}`
        );
      }
      if (!listener.defaultTarget) {
        logger.info('  (no default action: unmatched paths return 404)');
      }
    }
  } catch (err) {
    await Promise.allSettled(servers.map((s) => s.close()));
    throw new LocalStartServiceError(
      `Failed to start ALB front-door: ${err instanceof Error ? err.message : String(err)}. If a ` +
        'listener port is privileged (< 1024), remap it to a non-privileged host port with ' +
        '--lb-port <listenerPort>=<hostPort> (e.g. --lb-port 80=8080).'
    );
  }

  const frontDoorByService = new Map<string, FrontDoorServicePools>();
  for (const { pool, target } of registry.values()) {
    const list = frontDoorByService.get(target.serviceTarget) ?? [];
    list.push({
      pool,
      targetContainerName: target.targetContainerName,
      targetContainerPort: target.targetContainerPort,
    });
    frontDoorByService.set(target.serviceTarget, list);
  }
  return { servers, frontDoorByService };
}

function describeTarget(t: PlannedForwardTarget): string {
  return `${t.serviceTarget} (container ${t.targetContainerName}:${t.targetContainerPort})`;
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
    );

  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
