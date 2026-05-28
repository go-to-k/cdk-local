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
import { withErrorHandling, LocalStartServiceError } from '../../utils/error-handler.js';
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
import { cleanupEcsRun, type RunEcsTaskOptions } from '../../local/ecs-task-runner.js';
import { matchStacks } from '../stack-matcher.js';
import {
  createLocalStateProvider,
  rejectExplicitCfnStackWithMultipleStacks,
  resolveCfnFallbackRegion,
  type ExtraStateProviders,
} from './local-state-source.js';
import {
  getEmbedConfig,
  setEmbedConfig,
  type CdkLocalEmbedConfig,
} from '../../local/embed-config.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';
import type { SubstitutionContext } from '../../local/state-resolver.js';
import { CloudMapRegistry } from '../../local/cloud-map-registry.js';
import { buildCloudMapIndex, type CloudMapIndex } from '../../local/cloud-map-resolver.js';
import {
  createSharedSvcNetwork,
  destroyTaskNetwork,
  type TaskNetwork,
} from '../../local/ecs-network.js';

interface LocalStartServiceOptions {
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

/**
 * Factory options for {@link createLocalStartServiceCommand}.
 */
export interface CreateLocalStartServiceCommandOptions {
  extraStateProviders?: ExtraStateProviders;
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

/**
 * `cdkl start-service <Stack/Service>` — Phase 2 of #262. Spins up
 * `DesiredCount` task replicas locally (clamped by `--max-tasks`) using
 * the existing `ecs-task-runner` per replica. Long-running; ^C cleans
 * every replica + sidecar + per-task network.
 */
async function localStartServiceCommand(
  targets: string[],
  options: LocalStartServiceOptions,
  extraStateProviders: ExtraStateProviders | undefined
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  warnIfDeprecatedRegion(options);

  // Commander resolves `--no-pull` to `options.pull = false` (the
  // default is true). Compute the "should we skip docker pull?" flag
  // once here so the shared-network creation, the per-target task
  // boot, and any future call site share one source of truth.
  const skipPull = options.pull === false;

  if (!targets || targets.length === 0) {
    throw new LocalStartServiceError(
      `${getEmbedConfig().cliName} start-service requires at least one <target>. ` +
        "Pass one or more service paths like 'Stack/Orders' 'Stack/Frontend'."
    );
  }

  // Issue #606: reject explicit `--from-cfn-stack <name>` when multiple
  // service targets are booted in one invocation. The explicit name
  // would apply to every target and silently mismap logical IDs across
  // siblings that happen to share a `Ref` key. Bare `--from-cfn-stack`
  // is fine (each target uses its own cdkl stack name as the CFn name).
  rejectExplicitCfnStackWithMultipleStacks(options, targets.length);

  // Per-target run-state + controller, plus a shared Cloud Map
  // registry across every service. Building everything upfront and
  // hoisting cleanup keeps SIGINT correctness in lock-step with the
  // pre-PR single-service shape.
  type PerTarget = {
    target: string;
    runState: ServiceRunState;
    controller?: ServiceController;
  };
  const perTarget: PerTarget[] = targets.map((t) => ({
    target: t,
    runState: createServiceRunState(),
  }));

  let sigintHandler: (() => void) | undefined;
  let sigintCount = 0;
  // Hoisted out of the try block so the single-flight cleanup closure
  // can teardown the shared network after every container is gone.
  let sharedNetwork: TaskNetwork | undefined;
  // ECS analogue of cdkd PR #670: synthesized AWS shared credentials
  // file bind-mounted into every service replica's containers so
  // `fromIni({ profile })` handlers resolve to the same creds the
  // sidecar serves. One-per-CLI-invocation (mirrors the shared
  // sidecar's shape — `--profile` is a CLI-level concern, not a
  // per-service one). Disposed by the single-flight cleanup AFTER
  // every replica's containers are gone but BEFORE the shared
  // network is torn down (the file outlives running containers but
  // can vanish once they're stopped).
  let profileCredsFile: ProfileCredentialsFile | undefined;

  // Single-flight cleanup so the SIGINT handler and the outer `finally`
  // collapse to one underlying invocation. Fans out across every
  // target's controller; falls back to per-replica cleanupEcsRun when
  // a controller never finished construction (early-failure case).
  // The shared network is torn down LAST so per-replica
  // `cleanupEcsRun()` calls finish first.
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
      // Profile credentials file dispose — must happen AFTER every
      // replica's containers are gone (the bind-mount keeps the
      // file alive for as long as a container references it) but
      // BEFORE / parallel-with the shared network teardown.
      // Idempotent (`rm` is `force: true`); see
      // `writeProfileCredentialsFile`'s `dispose` for the contract.
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

      // Shared network teardown.
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

    // Build the shared Cloud Map index once across every stack the
    // synth produced. Per-stack lookups in the runner then pick the
    // matching CloudMapIndex by stack name.
    const cloudMapIndexByStack = new Map<string, CloudMapIndex>();
    for (const stack of stacks) {
      const index = buildCloudMapIndex(stack);
      cloudMapIndexByStack.set(stack.stackName, index);
      for (const w of index.warnings) logger.warn(w);
    }

    // Shared Cloud Map registry — every per-service runner registers
    // into the same instance, and every per-service runner reads from
    // it to build per-replica `--add-host` flags.
    const registry = new CloudMapRegistry();
    // Create ONE shared docker network used by every service-replica
    // boot in this CLI invocation.
    //
    // cdkd#658: when `--profile <p>` is set, the resolved credentials
    // are forwarded to the AWS-published metadata-endpoints sidecar so
    // its `/role/<role-arn>` endpoint serves them to user containers.
    // Without this, the sidecar starts inside a fresh container with
    // no SSO config / no `~/.aws/credentials` and falls back to its
    // own (empty) default chain, breaking every container that hits
    // 169.254.171.2. Per-service `--assume-task-role <Service>=<arn>`
    // overrides are independent — they flow into `buildMetadataEnv`
    // per container and are unrelated to the SIDECAR's own startup
    // credentials.
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
    // ECS analogue of cdkd PR #670 — when `--profile <p>` is set, write
    // ONCE the host-side credentials file used by every replica's
    // containers. Mirrors the shared-sidecar shape (one-per-CLI-
    // invocation): `--profile` is a CLI-level concern. Per-service
    // `--assume-task-role <Service>=<arn>` overrides are independent
    // and re-gated INSIDE `runOneTarget` so an assume-role'd service
    // does NOT receive the file env vars (preserves the assume >
    // file > sidecar precedence applied per-service).
    if (options.profile && sidecarCredentials) {
      profileCredsFile = await writeProfileCredentialsFile(options.profile, sidecarCredentials);
    }
    const discovery: ServiceDiscoveryContext = {
      registry,
      cloudMapIndexByStack,
      sharedNetwork,
    };

    // SIGINT pattern: double-^C bypasses cleanup and exits 130
    // immediately so users have an escape hatch when docker hangs.
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

    // Boot every target SEQUENTIALLY so a first-target failure surfaces
    // before we burn docker budget on the rest.
    for (const pt of perTarget) {
      pt.controller = await bootOneTarget(
        pt.target,
        pt.runState,
        stacks,
        options,
        discovery,
        skipPull,
        extraStateProviders,
        profileCredsFile
      );
    }

    const summary = perTarget
      .map(
        (pt) =>
          `${pt.controller!.service.serviceName} (${pt.controller!.activeReplicaCount()} replica(s))`
      )
      .join(', ');
    logger.info(`Service(s) running: ${summary}. Press ^C to shut down.`);

    // Block until ALL services shut down.
    await Promise.all(perTarget.map((pt) => pt.controller!.waitForShutdown()));
  } finally {
    if (sigintHandler) {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigintHandler);
    }
    await cleanup();
  }
}

/**
 * Boot one target. Returns the started controller for the outer code
 * to wait + tear down.
 */
async function bootOneTarget(
  target: string,
  runState: ServiceRunState,
  stacks: StackInfo[],
  options: LocalStartServiceOptions,
  discovery: ServiceDiscoveryContext,
  skipPull: boolean,
  extraStateProviders: ExtraStateProviders | undefined,
  profileCredsFile: ProfileCredentialsFile | undefined
): Promise<ServiceController> {
  const parsed = parseEcsTarget(target);
  const candidate = pickCandidateStack(parsed.stackPattern, stacks);
  const stateProvider = createLocalStateProvider(
    options,
    candidate?.stackName ?? '',
    await resolveCfnFallbackRegion(options, candidate?.region),
    extraStateProviders
  );

  try {
    return await runOneTarget(
      target,
      runState,
      stacks,
      options,
      discovery,
      skipPull,
      stateProvider,
      profileCredsFile
    );
  } finally {
    if (stateProvider) stateProvider.dispose();
  }
}

async function runOneTarget(
  target: string,
  runState: ServiceRunState,
  stacks: StackInfo[],
  options: LocalStartServiceOptions,
  discovery: ServiceDiscoveryContext,
  skipPull: boolean,
  stateProvider: LocalStateProvider | undefined,
  profileCredsFile: ProfileCredentialsFile | undefined
): Promise<ServiceController> {
  const logger = getLogger();

  const imageContext = await buildEcsImageResolutionContext(target, stacks, options, stateProvider);
  const service = resolveEcsServiceTarget(target, stacks, imageContext);
  logger.info(
    `Target: ${service.stack.stackName}/${service.serviceLogicalId} ` +
      `(service=${service.serviceName}, desiredCount=${service.desiredCount}, ` +
      `task=${service.task.taskDefinitionLogicalId})`
  );
  for (const w of service.warnings) logger.warn(w);
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
  // Per-service gating (mirrors cdkd PR #670 fix-back finding #1
  // applied in `local-run-task.ts`): the shared credentials file is
  // bound ONLY to services that did NOT win an `--assume-task-role`.
  // An assume-role'd service serves its own STS creds via the
  // sidecar's `/role/<arn>` endpoint; injecting
  // `AWS_SHARED_CREDENTIALS_FILE` / `AWS_PROFILE` on top would
  // silently bypass the assumed creds for `fromIni({ profile })`
  // callers and break the documented precedence (assume > file >
  // sidecar).
  if (profileCredsFile && !assumedCredentials) {
    taskOpts.profileCredentialsFile = {
      hostPath: profileCredsFile.hostPath,
      containerPath: profileCredsFile.containerPath,
      profileName: profileCredsFile.profileName,
    };
  }

  const runnerOpts: ServiceRunnerOptions = {
    maxTasks: options.maxTasks,
    restartPolicy: options.restartPolicy,
    taskOptions: taskOpts,
    discovery,
  };

  return startEcsService(service, runnerOpts, runState);
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
 * Build the substitution context the ECS resolver consumes.
 */
async function buildEcsImageResolutionContext(
  target: string,
  stacks: StackInfo[],
  options: LocalStartServiceOptions,
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
      accountId = await resolveCallerAccountId(region);
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

async function resolveCallerAccountId(region: string | undefined): Promise<string | undefined> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
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
 * Hard cap on `--max-tasks` driven by the per-replica subnet allocator
 * in `ecs-service-runner.ts:pickSubnetOctet`. The allocator walks the
 * link-local /24 range `169.254.170.0..169.254.253.0` and skips 171.
 */
export const MAX_TASKS_SUBNET_RANGE_CAP = 83;

function parseMaxTasks(raw: string): number {
  const parsed = parsePositiveInt(raw, '--max-tasks');
  if (parsed > MAX_TASKS_SUBNET_RANGE_CAP) {
    throw new LocalStartServiceError(
      `--max-tasks ${parsed} exceeds the per-replica link-local /24 subnet allocator's range ` +
        `(${MAX_TASKS_SUBNET_RANGE_CAP}). Lower --max-tasks to <= ${MAX_TASKS_SUBNET_RANGE_CAP}.`
    );
  }
  return parsed;
}

function parseRestartPolicy(raw: string): 'on-failure' | 'always' | 'none' {
  if (raw === 'on-failure' || raw === 'always' || raw === 'none') return raw;
  throw new LocalStartServiceError(
    `--restart-policy must be one of 'on-failure', 'always', or 'none' (got '${raw}').`
  );
}

/**
 * cdkd#658: pick the credentials forwarded to the AWS-published
 * `amazon-ecs-local-container-endpoints` sidecar. `cdkl start-service`'s
 * sidecar is SHARED across every replica boot in one CLI invocation, so
 * this resolves ONCE at startup. Precedence:
 *   1. `--profile <p>` → resolved via {@link resolveProfileCredentials}
 *      (the SDK's default credential provider chain — SSO / IAM
 *      Identity Center / fromIni / role-assumption). NEW in this PR.
 *   2. Not set → `undefined`; the sidecar runs with its own default
 *      credential chain (typically empty inside a fresh container —
 *      user containers will get 4xx from the credentials endpoint).
 *
 * Note: per-service `--assume-task-role <Service>=<arn>` overrides are
 * INTENTIONALLY NOT consulted here. The shared sidecar has no concept
 * of per-service IAM — per-service `TaskRoleArn` flows into each
 * container's env via `buildMetadataEnv` at boot time, where the
 * sidecar's `/role/<role-arn>` path resolves per-request. The shared
 * sidecar's OWN startup credentials govern only the fallback path
 * (containers that did not bind a `TaskRoleArn`).
 *
 * Extracted as an exported helper so a unit test can exercise both
 * branches without having to mock the full Synth + Docker + AWS
 * pipeline (the strategy cdkd#655 used for the Lambda container path).
 */
export async function resolveSharedSidecarCredentials(options: {
  profile?: string;
}): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined> {
  if (options.profile) return resolveProfileCredentials(options.profile);
  return undefined;
}

export function createLocalStartServiceCommand(
  opts: CreateLocalStartServiceCommandOptions = {}
): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('start-service')
    .description(
      'Run one or more AWS::ECS::Service resources locally as a long-running emulator. Spins up ' +
        'DesiredCount task replicas per service (clamped by --max-tasks) using the same per-task ' +
        `docker network + metadata sidecar pattern as \`${getEmbedConfig().cliName} run-task\`, then keeps each ` +
        'replica running and restarts it on exit per --restart-policy. ^C tears every replica + ' +
        'sidecar + network down. Each <target> accepts a CDK display path (MyStack/MyService) ' +
        'or stack-qualified logical ID (MyStack:MyServiceXYZ); single-stack apps may omit the ' +
        'stack prefix. When two or more <target>s are supplied, every service is booted into a ' +
        'shared Cloud Map / Service Connect registry so peer services discover each other via ' +
        'docker --add-host overlay.'
    )
    .argument(
      '<targets...>',
      'One or more CDK display paths or stack-qualified logical IDs of the AWS::ECS::Service resources to run'
    )
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
    .action(
      withErrorHandling(async (targets: string[], options: LocalStartServiceOptions) => {
        await localStartServiceCommand(targets, options, opts.extraStateProviders);
      })
    );

  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
