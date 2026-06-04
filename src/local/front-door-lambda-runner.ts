import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getLogger } from '../utils/logger.js';
import {
  pickFreePort,
  pullImage,
  removeContainer,
  runDetached,
  streamLogs,
} from './docker-runner.js';
import { architectureToPlatform, buildContainerImage } from './docker-image-builder.js';
import { pullEcrImage, parseEcrUri } from './ecr-puller.js';
import { invokeRie, waitForRieReady } from './rie-client.js';
import {
  resolveRuntimeCodeMountPath,
  resolveRuntimeFileExtension,
  resolveRuntimeImage,
} from './runtime-image.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../assets/asset-manifest-loader.js';
import type { ResolvedImageLambda, ResolvedLambda, ResolvedZipLambda } from './lambda-resolver.js';
import { getEmbedConfig } from './embed-config.js';

/**
 * Issue #123 (Lambda-target slice) — boot a single Lambda function in a
 * long-lived RIE container behind a local ALB front-door, and invoke it per
 * request. This is the Lambda counterpart of the ECS `FrontDoorEndpointPool`:
 * where an ECS forward target round-robins live replica ports, a Lambda forward
 * target keeps ONE warm RIE container and invokes it via the same machinery
 * `cdkl invoke` / `start-api` use (`runDetached` -> `waitForRieReady` ->
 * `invokeRie`).
 *
 * Lifecycle:
 *   - `start()` resolves the image plan (ZIP base image + bind mount, or a
 *     built/pulled container image), `docker run`s it detached, and waits for
 *     RIE to come up. Idempotent — a second `start()` is a no-op.
 *   - `invoke(event)` POSTs the event to RIE and returns the parsed payload.
 *     The container serializes invokes on its own (one warm container, like a
 *     concurrency-1 Lambda locally); the front-door's per-request handling is
 *     what concurrency the dev loop needs.
 *   - `stop()` tears the container down + removes any materialized tmpdirs.
 *     Idempotent.
 *
 * Scope: the common ZIP (asset / inline) and IMAGE (local-build / ECR-pull)
 * cases. Lambda Layers are intentionally NOT mounted here in v1 (the front-door
 * Lambda-target path targets simple request handlers; layered functions remain
 * reachable via `cdkl invoke` / `start-api`). Env-var / state substitution and
 * `--assume-role` credential injection are also out of scope for the v1
 * front-door Lambda target — the handler runs with the dev shell's forwarded
 * AWS env (same default as `cdkl invoke` without `--assume-role`).
 */

export interface FrontDoorLambdaRunnerOptions {
  /** Host interface to bind the RIE port to (the `--container-host` value). */
  containerHost: string;
  /** Skip `docker pull` for the base image (the `--no-pull` flag). */
  skipPull?: boolean;
  /** Force `docker run --platform` for the IMAGE path. */
  platformOverride?: string;
  /** Role ARN to assume before authenticating against ECR (IMAGE ECR-pull path). */
  ecrRoleArn?: string;
  /** Region passed to the ECR-pull fallback. */
  region?: string;
  /** Whether to attach `docker logs -f`. Default true. */
  streamLogs?: boolean;
  /**
   * Pre-resolved container environment (issue #380). The caller resolves the
   * function's declared env vars + `--from-cfn-stack` state substitution +
   * `--assume-role` / shell creds via the shared `resolveLambdaContainerEnv`,
   * so a CDN-/ALB-fronted Lambda reaches the same deployed resources as a
   * direct `cdkl invoke`. When present, this REPLACES the runner's env base
   * entirely — `resolveLambdaContainerEnv` already emits the six
   * `AWS_LAMBDA_FUNCTION_*` identity vars (from the same `ResolvedLambda`), so
   * the caller owns the full env. When absent, the runner builds the
   * `AWS_LAMBDA_*` base itself and forwards only the dev shell's AWS env (the
   * pre-#380 behavior).
   */
  containerEnv?: Record<string, string>;
  /** Env keys carrying decrypted SecureStrings — kept off the `docker run` argv. */
  sensitiveEnvKeys?: Set<string>;
}

interface ImagePlan {
  image: string;
  mounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  cmd: string[];
  platform?: string;
  entryPoint?: string[];
  workingDir?: string;
  /** Temp dir to remove on stop (materialized inline ZIP code). */
  inlineTmpDir?: string;
}

/** Forward the dev shell's AWS credential / region env into the Lambda container. */
function forwardAwsEnv(): Record<string, string> {
  const env: Record<string, string> = {};
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
  return env;
}

/**
 * Materialize an inline (`Code.ZipFile`) ZIP Lambda's source into a temp dir at
 * the path implied by `handler`, returning the dir to bind-mount. Mirrors
 * `local-invoke.ts:materializeInlineCode`.
 */
function materializeInlineCode(handler: string, source: string, fileExtension: string): string {
  const lastDot = handler.lastIndexOf('.');
  if (lastDot <= 0) {
    throw new Error(`Handler '${handler}' is malformed: expected '<modulePath>.<exportName>'.`);
  }
  const modulePath = handler.substring(0, lastDot);
  const dir = mkdtempSync(
    path.join(tmpdir(), `${getEmbedConfig().resourceNamePrefix}-alb-lambda-`)
  );
  const filePath = path.join(dir, `${modulePath}${fileExtension}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, 'utf-8');
  return dir;
}

async function resolveZipImagePlan(
  lambda: ResolvedZipLambda,
  opts: FrontDoorLambdaRunnerOptions
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
  await pullImage(image, opts.skipPull === true);
  const containerCodePath = resolveRuntimeCodeMountPath(lambda.runtime);
  return {
    image,
    mounts: [{ hostPath: codeDir, containerPath: containerCodePath, readOnly: true }],
    cmd: [lambda.handler],
    ...(inlineTmpDir !== undefined && { inlineTmpDir }),
  };
}

async function resolveContainerImagePlan(
  lambda: ResolvedImageLambda,
  opts: FrontDoorLambdaRunnerOptions
): Promise<ImagePlan> {
  const logger = getLogger().child('front-door-lambda');
  const platform = opts.platformOverride ?? architectureToPlatform(lambda.architecture);

  const manifestPath = lambda.stack.assetManifestPath;
  let imageRef: string;
  let localBuilt = false;
  if (manifestPath) {
    const cdkOutDir = path.dirname(manifestPath);
    const loader = new AssetManifestLoader();
    const manifest = await loader.loadManifest(cdkOutDir, lambda.stack.stackName);
    const entry = manifest ? getDockerImageBySourceHash(manifest, lambda.imageUri) : undefined;
    if (entry) {
      imageRef = await buildContainerImage(entry.asset, cdkOutDir, {
        architecture: lambda.architecture,
      });
      localBuilt = true;
    }
  }
  if (!localBuilt) {
    if (!parseEcrUri(lambda.imageUri)) {
      throw new Error(
        `Container Lambda '${lambda.logicalId}' has no matching asset in cdk.out, and Code.ImageUri ` +
          `'${lambda.imageUri}' is not an ECR URI ${getEmbedConfig().binaryName} can authenticate against. ` +
          'Re-synthesize the CDK app or deploy the image to ECR first.'
      );
    }
    logger.info(`No matching cdk.out asset for ${lambda.imageUri}; falling back to ECR pull...`);
    imageRef = await pullEcrImage(lambda.imageUri, {
      skipPull: opts.skipPull === true,
      ...(opts.region !== undefined && { region: opts.region }),
      ...(opts.ecrRoleArn !== undefined && { ecrRoleArn: opts.ecrRoleArn }),
    });
  }

  return {
    image: imageRef!,
    mounts: [],
    cmd: lambda.imageConfig.command ?? [],
    platform,
    ...(lambda.imageConfig.entryPoint &&
      lambda.imageConfig.entryPoint.length > 0 && {
        entryPoint: lambda.imageConfig.entryPoint,
      }),
    ...(lambda.imageConfig.workingDirectory !== undefined && {
      workingDir: lambda.imageConfig.workingDirectory,
    }),
  };
}

/**
 * A booted, invokable Lambda behind the front-door. Reuses the same RIE
 * container machinery as `cdkl invoke`. Construct via {@link createFrontDoorLambdaRunner}.
 */
export interface FrontDoorLambdaRunner {
  /** Logical id of the backing `AWS::Lambda::Function` (diagnostics). */
  readonly logicalId: string;
  /** Boot the RIE container (idempotent). Throws if the container never becomes ready. */
  start(): Promise<void>;
  /** Invoke the warm container with the ALB event; returns the parsed RIE payload. */
  invoke(event: unknown, timeoutMs?: number): Promise<unknown>;
  /** Tear the container down + remove any materialized tmpdirs (idempotent). */
  stop(): Promise<void>;
}

/**
 * Build a {@link FrontDoorLambdaRunner} for a resolved Lambda. Construction is
 * pure (no docker work); `start()` does the boot. The invoke timeout defaults
 * to `max(30s, timeoutSec * 2 * 1000)` — same formula as `cdkl invoke`.
 */
export function createFrontDoorLambdaRunner(
  lambda: ResolvedLambda,
  opts: FrontDoorLambdaRunnerOptions
): FrontDoorLambdaRunner {
  const logger = getLogger().child('front-door-lambda');
  const defaultTimeoutMs = Math.max(30_000, lambda.timeoutSec * 2 * 1000);

  let plan: ImagePlan | undefined;
  let containerId: string | undefined;
  let hostPort: number | undefined;
  let stopLogStream: (() => void) | undefined;
  let starting: Promise<void> | undefined;
  let stopped = false;

  async function doStart(): Promise<void> {
    plan =
      lambda.kind === 'zip'
        ? await resolveZipImagePlan(lambda, opts)
        : await resolveContainerImagePlan(lambda, opts);
    const port = await pickFreePort();
    hostPort = port;
    const name = `${getEmbedConfig().resourceNamePrefix}-alblambda-${lambda.logicalId}-${process.pid}-${Math.floor(
      Math.random() * 1_000_000
    )}`;
    // When the caller pre-resolved the container env (issue #380 — declared
    // env vars + `--from-cfn-stack` state substitution + `--assume-role` /
    // shell creds, via `resolveLambdaContainerEnv`), it already carries the
    // `AWS_LAMBDA_*` identity vars + resolved env + credentials, so use it
    // directly. Otherwise fall back to the pre-#380 behavior: `AWS_LAMBDA_*`
    // + only the dev shell's forwarded AWS env.
    const env: Record<string, string> = opts.containerEnv
      ? { ...opts.containerEnv }
      : {
          AWS_LAMBDA_FUNCTION_NAME: lambda.logicalId,
          AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(lambda.memoryMb),
          AWS_LAMBDA_FUNCTION_TIMEOUT: String(lambda.timeoutSec),
          AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
          AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${lambda.logicalId}`,
          AWS_LAMBDA_LOG_STREAM_NAME: 'local',
          ...forwardAwsEnv(),
        };
    logger.info(
      `Starting Lambda target container for ${lambda.logicalId} (image=${plan.image}, port=${port})...`
    );
    const id = await runDetached({
      image: plan.image,
      mounts: plan.mounts,
      env,
      ...(opts.sensitiveEnvKeys &&
        opts.sensitiveEnvKeys.size > 0 && { sensitiveEnvKeys: opts.sensitiveEnvKeys }),
      cmd: plan.cmd,
      hostPort: port,
      host: opts.containerHost,
      name,
      ...(plan.platform !== undefined && { platform: plan.platform }),
      ...(plan.entryPoint !== undefined && { entryPoint: plan.entryPoint }),
      ...(plan.workingDir !== undefined && { workingDir: plan.workingDir }),
    });
    containerId = id;
    stopLogStream = opts.streamLogs === false ? undefined : streamLogs(id);
    try {
      await waitForRieReady(opts.containerHost, port, 30_000);
    } catch (err) {
      // RIE never came up — clean up before propagating so we don't leak.
      try {
        stopLogStream?.();
      } catch {
        /* swallow */
      }
      await removeContainer(id).catch(() => undefined);
      containerId = undefined;
      throw err;
    }
  }

  return {
    logicalId: lambda.logicalId,
    async start(): Promise<void> {
      if (stopped) throw new Error('FrontDoorLambdaRunner.start called after stop');
      if (containerId) return;
      if (!starting) starting = doStart();
      await starting;
    },
    async invoke(event: unknown, timeoutMs?: number): Promise<unknown> {
      if (!containerId || hostPort === undefined) {
        throw new Error(
          `FrontDoorLambdaRunner('${lambda.logicalId}').invoke called before start() completed.`
        );
      }
      const result = await invokeRie(
        opts.containerHost,
        hostPort,
        event,
        timeoutMs ?? defaultTimeoutMs
      );
      return result.payload;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        stopLogStream?.();
      } catch (err) {
        logger.debug(
          `stopLogStream(${lambda.logicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (containerId) {
        try {
          await removeContainer(containerId);
        } catch (err) {
          logger.warn(
            `Failed to remove Lambda target container for ${lambda.logicalId}: ${err instanceof Error ? err.message : String(err)}. Continuing cleanup.`
          );
        }
        containerId = undefined;
      }
      if (plan?.inlineTmpDir) {
        try {
          rmSync(plan.inlineTmpDir, { recursive: true, force: true });
        } catch (err) {
          logger.debug(
            `Failed to remove inline-code tmpdir ${plan.inlineTmpDir}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    },
  };
}
