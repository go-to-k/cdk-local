import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import * as path from 'node:path';
import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  regionOption,
  parseContextOptions,
} from '../options.js';
import { resolveProfileCredentials, buildStsClientConfig } from '../../utils/profile-resolver.js';
import { resolveContainerFallbackRegion } from './local-start-api.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { CdkLocalError, withErrorHandling } from '../../utils/error-handler.js';
import { listTargets } from '../../local/target-lister.js';
import { resolveSingleTarget } from '../../local/target-picker.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import { readCdkPathOrUndefined } from '../cdk-path.js';
import {
  createLocalStateProvider,
  resolveCfnFallbackRegion,
  type ExtraStateProviders,
} from './local-state-source.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';
import {
  getEmbedConfig,
  setEmbedConfig,
  type CdkLocalEmbedConfig,
} from '../../local/embed-config.js';
import {
  resolveLambdaTarget,
  type ResolvedImageLambda,
  type ResolvedLambda,
  type ResolvedLambdaLayer,
  type ResolvedZipLambda,
} from '../../local/lambda-resolver.js';
import { materializeLayerFromArn } from '../../local/layer-arn-materializer.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local/env-resolver.js';
import {
  applyDeployedEnvFallback,
  substituteEnvVarsFromStateAsync,
  type StateEnvSubstitutionAudit,
  type SubstitutionContext,
} from '../../local/state-resolver.js';
import { derivePartitionAndUrlSuffix } from '../../local/ecs-task-resolver.js';
import {
  resolveRuntimeCodeMountPath,
  resolveRuntimeFileExtension,
  resolveRuntimeImage,
} from '../../local/runtime-image.js';
import {
  ensureDockerAvailable,
  pickFreePort,
  pullImage,
  removeContainer,
  runDetached,
  streamLogs,
} from '../../local/docker-runner.js';
import { architectureToPlatform, buildContainerImage } from '../../local/docker-image-builder.js';
import { pullEcrImage, parseEcrUri } from '../../local/ecr-puller.js';
import { invokeRie, waitForRieReady } from '../../local/rie-client.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../../assets/asset-manifest-loader.js';
import { singleFlight } from '../../utils/single-flight.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from './local-profile-credentials-file.js';
import type { StackState } from '../../types/state.js';

interface LocalInvokeOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  event?: string;
  eventStdin?: boolean;
  envVars?: string;
  /**
   * Commander maps `--no-pull` to `pull: boolean` (default `true`). When
   * the user passes `--no-pull` the value flips to `false` and we skip
   * `docker pull`.
   */
  pull: boolean;
  /**
   * Commander maps `--no-build` to `build: boolean` (default `true`).
   * When the user passes `--no-build` the value flips to `false` and we
   * skip `docker build` on the IMAGE local-build path.
   */
  build: boolean;
  debugPort?: string;
  containerHost: string;
  /**
   * Optional Lambda execution role to assume before invoking. Commander's
   * `[arn]` syntax maps to `string | boolean` here:
   *   - flag absent → `undefined` (pass dev creds through; SAM-compatible default)
   *   - `--assume-role` (bare) → `true` (auto-resolve from state if a host extension is active)
   *   - `--assume-role <arn>` → `'<arn>'` (explicit ARN; precedence wins)
   *   - `--no-assume-role` → `false` (explicit opt-out)
   */
  assumeRole?: string | boolean;
  /**
   * Issue #448: explicit role to `sts:AssumeRole` into before calling
   * `lambda:GetLayerVersion` for every literal-ARN entry in a Lambda's
   * `Properties.Layers`.
   */
  layerRoleArn?: string;
  /**
   * Optional role ARN passed to `pullEcrImage` when the IMAGE ECR-pull
   * path fires.
   */
  ecrRoleArn?: string;
  /**
   * Issue #606: alternative state source for CDK apps deployed via the
   * upstream CDK CLI (`cdk deploy` → CloudFormation). Reads the named
   * CFn stack via `ListStackResources` to populate physical IDs.
   * Commander maps:
   *   - flag absent → `undefined`
   *   - `--from-cfn-stack` (bare) → `true` (use the resolved stack name)
   *   - `--from-cfn-stack <name>` → `'<name>'`
   */
  fromCfnStack?: string | boolean;
  /**
   * Region of the state record to read. Drives the CFn client's region
   * when `--from-cfn-stack` is set.
   */
  stackRegion?: string;
  /** Host-injected extra state-source flag fields. */
  [key: string]: unknown;
}

/**
 * Factory options for {@link createLocalInvokeCommand}.
 */
export interface CreateLocalInvokeCommandOptions {
  extraStateProviders?: ExtraStateProviders;
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

/**
 * `cdkl invoke <target>` — run a Lambda function locally inside a
 * Docker container that bundles the AWS Lambda Runtime Interface
 * Emulator (RIE). Modeled on `sam local invoke` but reusing cdk-local's
 * synthesis / asset / construct-path plumbing.
 */
async function localInvokeCommand(
  target: string | undefined,
  options: LocalInvokeOptions,
  extraStateProviders: ExtraStateProviders | undefined
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  let imagePlan: ImagePlan | undefined;
  let containerId: string | undefined;
  let stopLogs: (() => void) | undefined;
  let sigintHandler: (() => void) | undefined;
  // Synthesized AWS shared credentials file (one INI section) bind-mounted
  // into the container so handlers using `fromIni({ profile })` explicitly
  // resolve to the same creds. Disposed in the shared `cleanup` single-flight.
  let profileCredsFile: ProfileCredentialsFile | undefined;

  /**
   * Unified cleanup for both the success / failure unwind path AND the
   * SIGINT handler.
   */
  const cleanup = singleFlight(
    async (): Promise<void> => {
      if (stopLogs) {
        try {
          stopLogs();
        } catch (err) {
          getLogger().debug(
            `streamLogs stop failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (containerId) {
        try {
          await removeContainer(containerId);
        } catch (err) {
          getLogger().debug(
            `removeContainer(${containerId}) failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (imagePlan?.inlineTmpDir) {
        try {
          rmSync(imagePlan.inlineTmpDir, { recursive: true, force: true });
        } catch (err) {
          getLogger().debug(
            `Failed to remove inline-code tmpdir ${imagePlan.inlineTmpDir}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      if (imagePlan?.layersTmpDir) {
        try {
          rmSync(imagePlan.layersTmpDir, { recursive: true, force: true });
        } catch (err) {
          getLogger().debug(
            `Failed to remove merged-layers tmpdir ${imagePlan.layersTmpDir}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      if (imagePlan?.layerArnTmpDirs) {
        for (const dir of imagePlan.layerArnTmpDirs) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (err) {
            getLogger().debug(
              `Failed to remove ARN-layer tmpdir ${dir}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      }
      if (profileCredsFile) {
        try {
          await profileCredsFile.dispose();
        } catch (err) {
          getLogger().debug(
            `Failed to remove profile credentials tmpdir ${profileCredsFile.hostPath}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    },
    (err) => {
      getLogger().debug(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  );

  try {
    await applyRoleArnIfSet({
      roleArn: options.roleArn,
      region: options.region,
      profile: options.profile,
    });

    await ensureDockerAvailable();

    // When `--profile <p>` is set, resolve the profile to a concrete
    // credential set ONCE up-front so it can be overlaid onto the Lambda
    // container's env after `forwardAwsEnv`.
    const profileCredentials = options.profile
      ? await resolveProfileCredentials(options.profile)
      : undefined;

    // Synthesize an AWS shared credentials file with the resolved creds
    // under `[<options.profile>]` so handler code that uses
    // `fromIni({ profile: '<options.profile>' })` explicitly (instead of
    // the default credential chain) resolves to the same creds locally.
    // Mounted read-only into the container at the path pointed to by
    // `AWS_SHARED_CREDENTIALS_FILE` (set below). The default-chain path
    // (most handlers) keeps working through the existing env-var
    // injection; this file is the additive layer for the explicit-
    // profile case. Disposed in the shared `cleanup` single-flight above.
    if (options.profile && profileCredentials) {
      profileCredsFile = await writeProfileCredentialsFile(options.profile, profileCredentials);
    }

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

    const resolvedTarget = await resolveSingleTarget(target, {
      entries: listTargets(stacks).lambdas,
      message: 'Select a Lambda function to invoke',
      noun: 'Lambda functions',
      onMissing: () =>
        new CdkLocalError(
          `${getEmbedConfig().cliName} invoke requires a <target> (a Lambda display path or logical ID). ` +
            `Run \`${getEmbedConfig().cliName} list\` to see them, or run it in a TTY to pick interactively.`,
          'LOCAL_INVOKE_TARGET_REQUIRED'
        ),
    });

    const lambda = resolveLambdaTarget(resolvedTarget, stacks);
    const targetLabel = lambda.kind === 'zip' ? lambda.runtime : 'container image';
    logger.info(`Target: ${lambda.stack.stackName}/${lambda.logicalId} (${targetLabel})`);

    imagePlan = await resolveImagePlan(lambda, options);

    let stateAudit: StateEnvSubstitutionAudit | undefined;
    let templateEnv = getTemplateEnv(lambda.resource);
    let stateForRoleHint: StackState | undefined;
    // Pick the right LocalStateProvider for the supplied flags. Returns
    // `undefined` when no state-source flag is set.
    const stateProvider = createLocalStateProvider(
      options,
      lambda.stack.stackName,
      await resolveCfnFallbackRegion(options, lambda.stack.region),
      extraStateProviders
    );
    if (stateProvider) {
      try {
        const loaded = await stateProvider.load(lambda.stack.stackName, lambda.stack.region);
        if (loaded) {
          // Synthetic StackState shape consumed by the legacy
          // `--assume-role` hint path. Sufficient for
          // `resolveExecutionRoleArnFromState`, which only touches
          // `state.resources[...].properties.Role` /
          // `attributes.Arn`.
          stateForRoleHint = {
            version: 1,
            stackName: lambda.stack.stackName,
            resources: loaded.resources,
            outputs: loaded.outputs,
            lastModified: 0,
          };
          const subContext: SubstitutionContext = {
            resources: loaded.resources,
            consumerRegion: loaded.region,
          };
          if (envHasIntrinsicValue(templateEnv)) {
            const pseudo = await resolvePseudoParametersForInvoke(lambda.stack.region, options);
            if (pseudo) subContext.pseudoParameters = pseudo;
          }
          // Resolve SSM-backed template parameters
          // (`AWS::SSM::Parameter::Value<String>`) so a `Ref` to such a
          // parameter in an env var resolves to its SSM value instead of
          // being warn-and-dropped (issue #94). Only the CFn provider
          // implements this; the resolved map feeds the substitution
          // context's `parameters` field consulted by `resolveRef`.
          if (envHasIntrinsicValue(templateEnv) && stateProvider.resolveTemplateSsmParameters) {
            const ssmParams = await stateProvider.resolveTemplateSsmParameters(
              lambda.stack.template
            );
            if (Object.keys(ssmParams.values).length > 0) subContext.parameters = ssmParams.values;
            // Flag decrypted SecureString parameters so the consuming env
            // keys are kept off the `docker run` argv (issue #99).
            if (ssmParams.secureStringLogicalIds.length > 0) {
              subContext.sensitiveParameters = new Set(ssmParams.secureStringLogicalIds);
            }
          }
          if (envHasCrossStackIntrinsic(templateEnv)) {
            const resolver = await stateProvider.buildCrossStackResolver(loaded.region);
            if (resolver) {
              subContext.crossStackResolver = resolver;
            }
          }
          const { env, audit } = await substituteEnvVarsFromStateAsync(templateEnv, subContext);
          templateEnv = env;
          const label = stateProvider.label;
          for (const key of audit.resolvedKeys) {
            logger.debug(`${label}: substituted env var ${key}`);
          }
          // Deployed-env fallback: keys whose intrinsic value the static
          // substituter could not resolve (e.g. `Fn::GetAtt <Sibling>.Arn`)
          // are filled from the consumer function's deploy-time-resolved
          // `Environment.Variables`. Only the CFn provider implements
          // `resolveDeployedFunctionEnv`; the S3 provider's state already
          // carries deploy-time attributes so its GetAtt resolves above.
          let unresolved = audit.unresolved;
          const resolvedKeys = [...audit.resolvedKeys];
          if (unresolved.length > 0 && stateProvider.resolveDeployedFunctionEnv) {
            const physicalId = loaded.resources[lambda.logicalId]?.physicalId;
            if (physicalId) {
              const deployedEnv = await stateProvider.resolveDeployedFunctionEnv(physicalId);
              const fb = applyDeployedEnvFallback(templateEnv, unresolved, deployedEnv);
              templateEnv = fb.env;
              unresolved = fb.stillUnresolved;
              for (const key of fb.filled) {
                resolvedKeys.push(key);
                logger.debug(`${label}: filled env var ${key} from deployed function config`);
              }
            }
          }
          stateAudit = { resolvedKeys, unresolved, sensitiveKeys: audit.sensitiveKeys };
          for (const { key, reason } of unresolved) {
            logger.warn(
              `${label}: could not substitute env var ${key} (${reason}). ` +
                `Override it via --env-vars or it will be dropped.`
            );
          }
        }
      } catch (err) {
        // Ensure the provider is released if the substitution pass threw.
        // The success path defers dispose until after the assume-role
        // resolution below so the issue-#181 fallback can still use it.
        stateProvider.dispose();
        throw err;
      }
    }

    // Resolve env vars. Intrinsic-valued template entries are warned about
    // and dropped; the user can override them via --env-vars (SAM-shape).
    const overrides = readEnvOverridesFile(options.envVars);
    const lambdaCdkPath = readCdkPathOrUndefined(lambda.resource);
    const envResult = resolveEnvVars(lambda.logicalId, lambdaCdkPath, templateEnv, overrides);
    for (const key of envResult.unresolved) {
      if (stateAudit && stateAudit.unresolved.some((u) => u.key === key)) continue;
      // Prefer the L2 form (`MyStack/MyFn`) in the suggestion since that
      // matches the README guidance and `cdkl invoke` target shape; the
      // resolver's prefix rule accepts either form.
      const overrideKeyExample = lambdaCdkPath?.replace(/\/Resource$/, '') ?? lambda.logicalId;
      logger.warn(
        `Environment variable ${key} contains a CloudFormation intrinsic and was dropped. ` +
          `Override it with --env-vars (e.g. {"${overrideKeyExample}":{"${key}":"<literal>"}}), or pass a state-source flag (e.g. --from-cfn-stack or a host-provided extension) to recover deployed values.`
      );
    }

    // Resolve the role ARN to assume (if any). Three forms — explicit
    // ARN, bare (auto-resolve from state, with a #181 fallback to
    // GetFunctionConfiguration.Role when state misses), or absent.
    // The state provider's dispose is deferred until after this call so
    // the issue-#181 fallback can still use it.
    let resolvedAssumeRoleArn: string | undefined;
    try {
      resolvedAssumeRoleArn = await resolveAssumeRoleArnForLambda(
        options.assumeRole,
        stateForRoleHint,
        stateProvider,
        lambda.logicalId
      );
    } finally {
      stateProvider?.dispose();
    }
    if (options.assumeRole === undefined && stateForRoleHint) {
      // Legacy hint path: surface the deployed role ARN so they can re-run
      // with `--assume-role`.
      suggestAssumeRoleFromState(stateForRoleHint, lambda.logicalId);
    }

    // Read the event payload. Default to {} (matches SAM).
    const event = await readEvent(options);

    const dockerEnv: Record<string, string> = {
      AWS_LAMBDA_FUNCTION_NAME: lambda.logicalId,
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(lambda.memoryMb),
      AWS_LAMBDA_FUNCTION_TIMEOUT: String(lambda.timeoutSec),
      AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
      AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${lambda.logicalId}`,
      AWS_LAMBDA_LOG_STREAM_NAME: 'local',
      ...envResult.resolved,
    };
    let assumeSucceeded = false;
    if (resolvedAssumeRoleArn) {
      const stsRegion =
        options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
      try {
        const creds = await assumeLambdaExecutionRole(
          resolvedAssumeRoleArn,
          stsRegion,
          options.profile
        );
        dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
        dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
        dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
        if (stsRegion) dockerEnv['AWS_REGION'] = stsRegion;
        assumeSucceeded = true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(
          `--assume-role: STS AssumeRole(${resolvedAssumeRoleArn}) failed: ${reason}. ` +
            "Falling back to the developer's shell credentials."
        );
      }
    }
    if (!assumeSucceeded) {
      forwardAwsEnv(dockerEnv);
      applyProfileCredentialsOverlay(dockerEnv, profileCredentials, false);
      // Point the container's SDK chain at the bind-mounted credentials
      // file so
      // `fromIni({ profile })` calls inside the handler resolve to the
      // same creds. `AWS_PROFILE` makes `fromIni()` (no explicit arg)
      // ALSO use this profile.
      if (profileCredsFile) {
        dockerEnv['AWS_SHARED_CREDENTIALS_FILE'] = profileCredsFile.containerPath;
        dockerEnv['AWS_PROFILE'] = profileCredsFile.profileName;
      }
    }
    // Seed the container's `AWS_REGION` fallback so handler ambient-region
    // SDK calls (`new XxxClient({})`) reach the same region the deployed
    // function would. Precedence mirrors `start-api` via
    // `resolveContainerFallbackRegion`:
    //   1. `--region` / `AWS_REGION` / `AWS_DEFAULT_REGION` (forwarded above)
    //   2. the synth-derived stack region (`env.region` on the CDK stack)
    //   3. the `--profile`'s configured region (new in #245)
    if (!dockerEnv['AWS_REGION'] && !dockerEnv['AWS_DEFAULT_REGION']) {
      const fallbackRegion = resolveContainerFallbackRegion({
        stackRegionOverride: options.region,
        synthRegion: lambda.stack.region,
        profileRegion: profileCredentials?.region,
      });
      if (fallbackRegion) dockerEnv['AWS_REGION'] = fallbackRegion;
    }

    let debugPort: number | undefined;
    if (options.debugPort) {
      debugPort = Number(options.debugPort);
      if (!Number.isInteger(debugPort) || debugPort <= 0 || debugPort > 65535) {
        throw new Error(`--debug-port must be an integer in 1..65535, got '${options.debugPort}'`);
      }
      dockerEnv['NODE_OPTIONS'] = `--inspect-brk=0.0.0.0:${debugPort}`;
      if (lambda.kind === 'image') {
        logger.warn(
          '--debug-port sets NODE_OPTIONS unconditionally on container Lambdas. ' +
            "If the image's runtime is not Node.js, this flag is a no-op."
        );
      }
    }

    const hostPort = await pickFreePort();
    const containerHost = options.containerHost;

    if (lambda.layers.length > 0) {
      logger.info(
        `Mounting ${lambda.layers.length} Lambda layer${lambda.layers.length === 1 ? '' : 's'} at /opt`
      );
    }
    logger.info(`Starting container (image=${imagePlan.image}, port=${hostPort})...`);
    // Append the profile credentials file bind-mount to the existing
    // extraMounts (which
    // already carry the /opt layer mount when present). Read-only — the
    // container has no business writing to its credentials file; a
    // writable mount would let a compromised handler tamper with the
    // host-side temp file.
    const extraMountsWithProfile = profileCredsFile
      ? [
          ...(imagePlan.extraMounts ?? []),
          {
            hostPath: profileCredsFile.hostPath,
            containerPath: profileCredsFile.containerPath,
            readOnly: true,
          },
        ]
      : imagePlan.extraMounts;
    containerId = await runDetached({
      image: imagePlan.image,
      mounts: imagePlan.mounts,
      extraMounts: extraMountsWithProfile,
      env: dockerEnv,
      ...(stateAudit &&
        stateAudit.sensitiveKeys.length > 0 && {
          sensitiveEnvKeys: new Set(stateAudit.sensitiveKeys),
        }),
      cmd: imagePlan.cmd,
      hostPort,
      host: containerHost,
      ...(debugPort !== undefined && { debugPort }),
      ...(imagePlan.platform !== undefined && { platform: imagePlan.platform }),
      ...(imagePlan.entryPoint !== undefined && { entryPoint: imagePlan.entryPoint }),
      ...(imagePlan.workingDir !== undefined && { workingDir: imagePlan.workingDir }),
      ...(imagePlan.tmpfs !== undefined && { tmpfs: imagePlan.tmpfs }),
    });

    stopLogs = streamLogs(containerId);

    sigintHandler = (): void => {
      void cleanup().then(() => {
        process.exit(130);
      });
    };
    process.on('SIGINT', sigintHandler);

    await waitForRieReady(containerHost, hostPort, 5000);

    const invokeTimeoutMs = Math.max(30_000, lambda.timeoutSec * 2 * 1000);
    const result = await invokeRie(containerHost, hostPort, event, invokeTimeoutMs);

    // Settle a few hundred ms so logs fully flush before we tear down.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    process.stdout.write(`${result.raw}\n`);
  } finally {
    if (sigintHandler) process.off('SIGINT', sigintHandler);
    await cleanup();
  }
}

interface ImagePlan {
  image: string;
  mounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  extraMounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  cmd: string[];
  platform?: string;
  entryPoint?: string[];
  workingDir?: string;
  inlineTmpDir?: string;
  layersTmpDir?: string;
  layerArnTmpDirs?: string[];
  tmpfs?: { target: string; sizeMb: number };
}

async function resolveImagePlan(
  lambda: ResolvedLambda,
  options: LocalInvokeOptions
): Promise<ImagePlan> {
  if (lambda.kind === 'zip') {
    return resolveZipImagePlan(lambda, options);
  }
  return resolveContainerImagePlan(lambda, options);
}

async function resolveZipImagePlan(
  lambda: ResolvedZipLambda,
  options: LocalInvokeOptions
): Promise<ImagePlan> {
  let inlineTmpDir: string | undefined;
  let codeDir = lambda.codePath;
  if (codeDir === null) {
    inlineTmpDir = materializeInlineCode(
      lambda.handler,
      lambda.inlineCode ?? '',
      resolveRuntimeFileExtension(lambda.runtime)
    );
    codeDir = inlineTmpDir;
  }

  const image = resolveRuntimeImage(lambda.runtime);

  await pullImage(image, options.pull === false);

  const layerPlan = await materializeLambdaLayersIncludingArns(lambda.layers, options);

  // provided.al2 / provided.al2023 require the deployment package at
  // /var/runtime; every other runtime expects /var/task.
  const containerCodePath = resolveRuntimeCodeMountPath(lambda.runtime);

  const tmpfs = resolveTmpfsForLambda(lambda);

  return {
    image,
    mounts: [{ hostPath: codeDir, containerPath: containerCodePath, readOnly: true }],
    extraMounts: layerPlan.mount ? [layerPlan.mount] : [],
    cmd: [lambda.handler],
    ...(inlineTmpDir !== undefined && { inlineTmpDir }),
    ...(layerPlan.tmpDir !== undefined && { layersTmpDir: layerPlan.tmpDir }),
    ...(layerPlan.extraTmpDirs.length > 0 && { layerArnTmpDirs: layerPlan.extraTmpDirs }),
    ...(tmpfs !== undefined && { tmpfs }),
  };
}

export async function materializeLambdaLayersIncludingArns(
  layers: ResolvedLambdaLayer[],
  options: LocalInvokeOptions
): Promise<{
  mount?: { hostPath: string; containerPath: string; readOnly: boolean };
  tmpDir?: string;
  extraTmpDirs: string[];
}> {
  const extraTmpDirs: string[] = [];
  const flat: { logicalId: string; assetPath: string }[] = [];
  for (const layer of layers) {
    if (layer.kind === 'asset') {
      flat.push({ logicalId: layer.logicalId, assetPath: layer.assetPath });
      continue;
    }
    const dir = await materializeLayerFromArn(layer, {
      ...(options.layerRoleArn !== undefined && { roleArn: options.layerRoleArn }),
    });
    extraTmpDirs.push(dir);
    flat.push({ logicalId: layer.arn, assetPath: dir });
  }
  const plan = materializeLambdaLayers(flat);
  return { ...plan, extraTmpDirs };
}

export function resolveTmpfsForLambda(
  lambda: ResolvedLambda
): { target: string; sizeMb: number } | undefined {
  if (lambda.ephemeralStorageMb === undefined) return undefined;
  const logger = getLogger();
  if (lambda.kind === 'image') {
    logger.info(
      `Lambda ${lambda.logicalId}: capping /tmp at ${lambda.ephemeralStorageMb} MiB via --tmpfs (overlays any base-image /tmp content)`
    );
  } else {
    logger.debug(
      `Lambda ${lambda.logicalId}: applying EphemeralStorage cap via --tmpfs /tmp:size=${lambda.ephemeralStorageMb}m`
    );
  }
  return { target: '/tmp', sizeMb: lambda.ephemeralStorageMb };
}

export function materializeLambdaLayers(layers: { logicalId: string; assetPath: string }[]): {
  mount?: { hostPath: string; containerPath: string; readOnly: boolean };
  tmpDir?: string;
} {
  if (layers.length === 0) return {};
  if (layers.length === 1) {
    return {
      mount: { hostPath: layers[0]!.assetPath, containerPath: '/opt', readOnly: true },
    };
  }
  const tmpDir = mkdtempSync(
    path.join(tmpdir(), `${getEmbedConfig().resourceNamePrefix}-invoke-layers-`)
  );
  for (const layer of layers) {
    cpSync(layer.assetPath, tmpDir, { recursive: true, force: true });
  }
  return {
    mount: { hostPath: tmpDir, containerPath: '/opt', readOnly: true },
    tmpDir,
  };
}

export async function resolveContainerImagePlan(
  lambda: ResolvedImageLambda,
  options: LocalInvokeOptions
): Promise<ImagePlan> {
  const logger = getLogger();
  const platform = architectureToPlatform(lambda.architecture);

  const localBuild = await resolveLocalBuildPlan(lambda);
  let imageRef: string;
  if (localBuild) {
    imageRef = await buildContainerImage(localBuild.asset, localBuild.cdkOutDir, {
      architecture: lambda.architecture,
      noBuild: options.build === false,
    });
  } else {
    if (!parseEcrUri(lambda.imageUri)) {
      throw new Error(
        `Container Lambda '${lambda.logicalId}' has no matching asset in cdk.out, and Code.ImageUri ` +
          `'${lambda.imageUri}' is not an ECR URI ${getEmbedConfig().binaryName} can authenticate against. ` +
          'Re-synthesize the CDK app (so cdk.out includes the build context) or deploy the image to ECR first.'
      );
    }
    logger.info(
      `No matching cdk.out asset for ${lambda.imageUri}; falling back to ECR pull (same-acct/region only)...`
    );
    imageRef = await pullEcrImage(lambda.imageUri, {
      skipPull: options.pull === false,
      ...(options.region !== undefined && { region: options.region }),
      ...(options.ecrRoleArn !== undefined && { ecrRoleArn: options.ecrRoleArn }),
      ...(options.profile !== undefined && { profile: options.profile }),
    });
  }

  const tmpfs = resolveTmpfsForLambda(lambda);

  return {
    image: imageRef,
    mounts: [],
    extraMounts: [],
    cmd: lambda.imageConfig.command ?? [],
    platform,
    ...(lambda.imageConfig.entryPoint &&
      lambda.imageConfig.entryPoint.length > 0 && {
        entryPoint: lambda.imageConfig.entryPoint,
      }),
    ...(lambda.imageConfig.workingDirectory !== undefined && {
      workingDir: lambda.imageConfig.workingDirectory,
    }),
    ...(tmpfs !== undefined && { tmpfs }),
  };
}

async function resolveLocalBuildPlan(
  lambda: ResolvedImageLambda
): Promise<
  | { asset: { source: import('../../types/assets.js').DockerImageAssetSource }; cdkOutDir: string }
  | undefined
> {
  const manifestPath = lambda.stack.assetManifestPath;
  if (!manifestPath) return undefined;
  const cdkOutDir = dirname(manifestPath);

  const loader = new AssetManifestLoader();
  const manifest = await loader.loadManifest(cdkOutDir, lambda.stack.stackName);
  if (!manifest) return undefined;

  const entry = getDockerImageBySourceHash(manifest, lambda.imageUri);
  if (!entry) return undefined;
  return { asset: entry.asset, cdkOutDir };
}

export function envHasIntrinsicValue(templateEnv: Record<string, unknown> | undefined): boolean {
  if (!templateEnv) return false;
  for (const v of Object.values(templateEnv)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') continue;
    return true;
  }
  return false;
}

export function envHasCrossStackIntrinsic(
  templateEnv: Record<string, unknown> | undefined
): boolean {
  if (!templateEnv) return false;
  for (const v of Object.values(templateEnv)) {
    if (!v || typeof v !== 'object') continue;
    const obj = v as Record<string, unknown>;
    if ('Fn::ImportValue' in obj || 'Fn::GetStackOutput' in obj) return true;
  }
  return false;
}

async function resolvePseudoParametersForInvoke(
  stackRegion: string | undefined,
  options: LocalInvokeOptions
): Promise<
  { accountId?: string; region?: string; partition?: string; urlSuffix?: string } | undefined
> {
  const logger = getLogger();
  const region =
    options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? stackRegion;
  if (!region) {
    logger.warn(
      `Resolver references \${AWS::Region} but ${getEmbedConfig().binaryName} could not determine the target region. ` +
        'Pass --region, set AWS_REGION, or declare env.region on the CDK stack.'
    );
  }
  let accountId: string | undefined;
  try {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    // Thread `--profile` so the resolved account is the profile's account,
    // not whatever the default credential chain points at (issue #245).
    const sts = new STSClient(buildStsClientConfig({ region, profile: options.profile }));
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      accountId = identity.Account;
    } finally {
      sts.destroy();
    }
  } catch (err) {
    logger.warn(
      `Resolver needs \${AWS::AccountId} but STS GetCallerIdentity failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Substitution will be skipped; affected env entries will be dropped with per-key warnings.'
    );
  }
  const partitionAndSuffix = region ? derivePartitionAndUrlSuffix(region) : undefined;
  const bag: {
    accountId?: string;
    region?: string;
    partition?: string;
    urlSuffix?: string;
  } = {
    ...(accountId !== undefined && { accountId }),
    ...(region !== undefined && { region }),
    ...(partitionAndSuffix && {
      partition: partitionAndSuffix.partition,
      urlSuffix: partitionAndSuffix.urlSuffix,
    }),
  };
  return Object.keys(bag).length === 0 ? undefined : bag;
}

function getTemplateEnv(resource: {
  Properties?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const props = resource.Properties ?? {};
  const env = props['Environment'];
  if (!env || typeof env !== 'object') return undefined;
  const vars = (env as Record<string, unknown>)['Variables'];
  if (!vars || typeof vars !== 'object') return undefined;
  return vars as Record<string, unknown>;
}

function readEnvOverridesFile(filePath: string | undefined): EnvOverrideFile | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read --env-vars file '${filePath}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--env-vars file '${filePath}' must contain a JSON object at the top level.`);
  }
  return parsed as EnvOverrideFile;
}

async function readEvent(options: LocalInvokeOptions): Promise<unknown> {
  if (options.event && options.eventStdin) {
    throw new Error('--event and --event-stdin are mutually exclusive.');
  }
  if (options.eventStdin) {
    const raw = await readStdin();
    return parseEvent(raw, '<stdin>');
  }
  if (options.event) {
    const raw = readFileSync(options.event, 'utf-8');
    return parseEvent(raw, options.event);
  }
  return {};
}

function parseEvent(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse event payload from ${source} as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function assumeLambdaExecutionRole(
  roleArn: string,
  region: string | undefined,
  profile: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  // Thread `--profile` so the AssumeRole call is signed with the profile's
  // credentials (matching `aws sts assume-role --profile <p>`), not the
  // default env-shadowed chain (issue #245).
  const sts = new STSClient(buildStsClientConfig({ region, profile }));
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `${getEmbedConfig().resourceNamePrefix}-invoke-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new Error(`AssumeRole(${roleArn}) returned no usable credentials.`);
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

function forwardAwsEnv(env: Record<string, string>): void {
  const passThrough = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
  ] as const;
  for (const key of passThrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
}

export function applyProfileCredentialsOverlay(
  env: Record<string, string>,
  profileCreds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined,
  assumeRoleActive: boolean
): void {
  if (!profileCreds) return;
  if (assumeRoleActive) return;
  env['AWS_ACCESS_KEY_ID'] = profileCreds.accessKeyId;
  env['AWS_SECRET_ACCESS_KEY'] = profileCreds.secretAccessKey;
  if (profileCreds.sessionToken) {
    env['AWS_SESSION_TOKEN'] = profileCreds.sessionToken;
  } else {
    delete env['AWS_SESSION_TOKEN'];
  }
}

function materializeInlineCode(handler: string, source: string, fileExtension: string): string {
  const lastDot = handler.lastIndexOf('.');
  if (lastDot <= 0) {
    throw new Error(`Handler '${handler}' is malformed: expected '<modulePath>.<exportName>'.`);
  }
  const modulePath = handler.substring(0, lastDot);
  const dir = mkdtempSync(path.join(tmpdir(), `${getEmbedConfig().resourceNamePrefix}-invoke-`));
  const filePath = path.join(dir, `${modulePath}${fileExtension}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, 'utf-8');
  return dir;
}

function suggestAssumeRoleFromState(state: StackState, logicalId: string): void {
  const logger = getLogger();
  const roleArn = resolveExecutionRoleArnFromState(state, logicalId);
  if (roleArn) {
    logger.info(
      `Hint: the deployed function uses execution role ${roleArn}. ` +
        `Re-run with --assume-role to invoke under the deployed function's narrow permissions.`
    );
  }
}

/**
 * Resolve the role ARN to assume for a Lambda invoke, honoring the three
 * `--assume-role` forms:
 *
 *   - `--assume-role <arn>` (explicit) → return `<arn>`.
 *   - `--assume-role` (bare, no value) → resolve from CFn state first;
 *     if that misses, fall back to
 *     `stateProvider.resolveLambdaExecutionRoleArn(<physicalId>)`
 *     (a `lambda:GetFunctionConfiguration` call) so a sibling-stack
 *     execution role still resolves (issue #181 — `ListStackResources`
 *     returns the role's name, not its ARN, so `attributes.Arn` is
 *     empty on the CFn state map and the state-only lookup misses).
 *   - `--assume-role` absent → return undefined (no assume).
 *
 * Logs the resolution path (info on success, warn on miss) so the user
 * can tell why the container did or did not get assumed-role creds.
 *
 * Exported for unit testing.
 */
export async function resolveAssumeRoleArnForLambda(
  assumeRole: string | boolean | undefined,
  stateForRoleHint: StackState | undefined,
  stateProvider: Pick<LocalStateProvider, 'resolveLambdaExecutionRoleArn'> | undefined,
  lambdaLogicalId: string
): Promise<string | undefined> {
  const logger = getLogger();
  if (typeof assumeRole === 'string') {
    return assumeRole;
  }
  if (assumeRole !== true) {
    return undefined;
  }
  // Bare --assume-role from here on.
  if (!stateForRoleHint) {
    logger.warn(
      '--assume-role passed without an ARN, but no state was loaded. ' +
        'Pair it with a state-source flag, or pass the ARN explicitly: --assume-role <arn>. ' +
        "Falling back to the developer's shell credentials."
    );
    return undefined;
  }
  const fromState = resolveExecutionRoleArnFromState(stateForRoleHint, lambdaLogicalId);
  if (fromState) {
    logger.info(`--assume-role: auto-resolved execution role from state: ${fromState}`);
    return fromState;
  }
  const fnPhysicalId = stateForRoleHint.resources[lambdaLogicalId]?.physicalId;
  if (stateProvider?.resolveLambdaExecutionRoleArn && fnPhysicalId) {
    // Issue #181 fallback: state-only lookup misses for sibling-stack
    // exec roles because `ListStackResources` returns the role's name,
    // not its ARN. The function's deploy-time `Configuration.Role`
    // carries the full ARN.
    const liveArn = await stateProvider.resolveLambdaExecutionRoleArn(fnPhysicalId);
    if (liveArn) {
      logger.info(
        `--assume-role: auto-resolved execution role from GetFunctionConfiguration: ${liveArn}`
      );
      return liveArn;
    }
  }
  logger.warn(
    `--assume-role: could not resolve the execution role ARN for '${lambdaLogicalId}'. ` +
      "Pass the ARN explicitly: --assume-role <arn>. Falling back to the developer's shell credentials."
  );
  return undefined;
}

export function resolveExecutionRoleArnFromState(
  state: Pick<StackState, 'resources'>,
  logicalId: string,
  roleProperty = 'Role'
): string | undefined {
  const lambda = state.resources[logicalId];
  if (!lambda) return undefined;

  const roleRef = lambda.properties?.[roleProperty] ?? lambda.observedProperties?.[roleProperty];
  if (typeof roleRef === 'string' && roleRef.startsWith('arn:')) {
    return roleRef;
  }
  if (typeof roleRef === 'object' && roleRef !== null) {
    const refLogicalId = pickReferencedLogicalId(roleRef as Record<string, unknown>);
    if (refLogicalId) {
      const roleResource = state.resources[refLogicalId];
      const cached = roleResource?.attributes?.['Arn'];
      if (typeof cached === 'string' && cached.startsWith('arn:')) {
        return cached;
      }
    }
  }
  return undefined;
}

function pickReferencedLogicalId(intrinsic: Record<string, unknown>): string | undefined {
  if ('Ref' in intrinsic && typeof intrinsic['Ref'] === 'string') return intrinsic['Ref'];
  if ('Fn::GetAtt' in intrinsic) {
    const arg = intrinsic['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') return arg[0];
    if (typeof arg === 'string') return arg.split('.')[0];
  }
  return undefined;
}

export function createLocalInvokeCommand(opts: CreateLocalInvokeCommandOptions = {}): Command {
  setEmbedConfig(opts.embedConfig);
  const invoke = new Command('invoke')
    .description(
      'Run a Lambda function locally in a Docker container (RIE-backed). ' +
        'Target accepts a CDK display path (MyStack/MyApi/Handler) or stack-qualified logical ID ' +
        '(MyStack:MyApiHandler1234ABCD). Single-stack apps may omit the stack prefix. ' +
        'Omit <target> in an interactive terminal to pick the Lambda from a list.'
    )
    .argument(
      '[target]',
      'CDK display path or stack-qualified logical ID of the Lambda to invoke (omit to pick interactively in a TTY)'
    )
    .action(
      withErrorHandling(async (target: string | undefined, options: LocalInvokeOptions) => {
        await localInvokeCommand(target, options, opts.extraStateProviders);
      })
    );

  addInvokeSpecificOptions(invoke);
  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((option) =>
    invoke.addOption(option)
  );
  invoke.addOption(regionOption);

  return invoke;
}

/**
 * Register the option block that `cdkl invoke` adds on top of the shared
 * common / app / context option helpers. Shared between `cdkl invoke` and
 * any host CLI (e.g. cdkd's `local invoke`) that wraps the single-shot
 * RIE-backed Lambda runner, so adding or renaming an `invoke`-only flag
 * here propagates to every embedder without duplicate `.addOption(...)`
 * blocks.
 *
 * Calling order only affects `--help` presentation (Commander parses
 * insertion-order-independent). The host-CLI convention is host-specific
 * options first, then this helper, then the shared common / app / context
 * options — host flags / invoke flags / common flags grouped in three
 * `--help` clusters. Chainable: returns `cmd`.
 */
export function addInvokeSpecificOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option('-e, --event <file>', 'JSON event payload file (default: {})'))
    .addOption(new Option('--event-stdin', 'Read event JSON from stdin').default(false))
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"LogicalId":{"KEY":"VALUE"}})'
      )
    )
    .addOption(
      new Option(
        '--no-pull',
        'Skip docker pull (use cached image) — no-op for IMAGE local-build path; ' +
          '`docker build` does not pull base layers by default'
      )
    )
    .addOption(
      new Option(
        '--no-build',
        'Skip docker build on the IMAGE local-build path (use the previously-built tag). ' +
          'Requires the deterministic tag to already be in the local registry; errors with ' +
          'an actionable message when missing. No-op for ZIP Lambdas and the IMAGE ECR-pull path. ' +
          'Compatible with --no-pull.'
      )
    )
    .addOption(new Option('--debug-port <port>', 'Node --inspect-brk port (default: off)'))
    .addOption(
      new Option('--container-host <host>', 'Host to bind the RIE port to').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--assume-role [arn]',
        "Assume the Lambda's deployed execution role and forward STS-issued temp credentials " +
          "to the container so the handler runs with the deployed function's narrow permissions. " +
          'Three forms: ' +
          '(1) `--assume-role <arn>` assumes the explicit ARN; ' +
          "(2) `--assume-role` (bare) auto-resolves the function's execution role ARN from state " +
          '(requires an active state source); ' +
          '(3) `--no-assume-role` explicitly opts out. ' +
          "Off by default — when omitted, the developer's shell credentials are forwarded " +
          'unchanged (SAM-compatible default). STS failures degrade to a warn + dev-creds fallback.'
      )
    )
    .addOption(
      new Option(
        '--layer-role-arn <arn>',
        'Role to sts:AssumeRole before calling lambda:GetLayerVersion on every literal-ARN ' +
          'entry in Properties.Layers. Use only when the dev credentials cannot ' +
          'read the layer — typically cross-account layers. AWS-published public layers (e.g. ' +
          'Lambda Powertools) are readable from every account and need no role.'
      )
    )
    .addOption(
      new Option(
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized ' +
          'registries. Issues sts:AssumeRole via the default credential chain and uses the ' +
          'temporary credentials for ecr:GetAuthorizationToken + docker pull. Required when the ' +
          'caller does not have direct cross-account access to the target repository. ' +
          'Same-account / same-region pulls do not need this flag.'
      )
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via ListStackResources and substitute Ref / Fn::ImportValue ' +
          'in env vars with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream ' +
          'CDK CLI (`cdk deploy`). Bare form uses the resolved stack name; pass an explicit value when CFn stack name differs. ' +
          'Fn::GetAtt is warn-and-dropped in v1 (CFn ListStackResources does not return per-attribute values).'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-cfn-stack as the CFn client region.'
      )
    );
}
