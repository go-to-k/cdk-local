import { getLogger } from '../../utils/logger.js';
import { getEmbedConfig } from '../../local/embed-config.js';
import { pickFreePort, pullImage, removeContainer, streamLogs } from '../../local/docker-runner.js';
import {
  resolveLambdaContainerEnv,
  type LambdaContainerEnvOptions,
  type ResolvedProfileCredentials,
} from './local-invoke.js';
import type { ExtraStateProviders } from './local-state-source.js';
import type { ResolvedWebFunction } from '../../local/web-function-resolver.js';
import {
  disposeWebFunctionArtifact,
  parseWebFunctionBuildConfig,
  resolveWebFunctionArtifact,
  type WebFunctionArtifact,
  type WebFunctionCodeConfig,
} from '../../local/web-function-artifact.js';
import {
  defaultWebFunctionPlatform,
  resolveWebFunctionRuntime,
  type WebFunctionRuntimeSpec,
} from '../../local/web-function-runtime.js';
import {
  WEB_FUNCTION_HTTP_ENDPOINT_ENV,
  buildWebFunctionLambdaView,
  finalizeWebFunctionEnv,
  readWebFunctionServiceConfig,
  webFunctionAssumeRole,
  type WebFunctionServiceConfig,
} from '../../local/web-function-service-config.js';
import {
  RecentOutput,
  WEB_FUNCTION_CONTAINER_PORT,
  containerFailure,
  planWebFunctionContainer,
  startWebFunctionContainer,
  waitForWebFunctionReady,
  watchContainerExit,
} from '../../local/web-function-runner.js';
import type { CdkLocalError } from '../../utils/error-handler.js';

/**
 * The parts of a resolved revision the serve reads before anything touches the
 * host: its code location, its runtime row and its `ServiceConfig`. Pure, so a
 * caller fails on an unsupported runtime or code shape before booting anything.
 */
export interface PreparedWebFunction {
  resolved: ResolvedWebFunction;
  code: WebFunctionCodeConfig;
  spec: WebFunctionRuntimeSpec;
  serviceConfig: WebFunctionServiceConfig;
}

/** Read a resolved revision's code, runtime and service config (throws on an unsupported one). */
export function prepareWebFunctionServe(resolved: ResolvedWebFunction): PreparedWebFunction {
  const code = parseWebFunctionBuildConfig(
    resolved.revisionLogicalId,
    resolved.revision.Properties?.['BuildConfig'],
    resolved.stack.template
  );
  return {
    resolved,
    code,
    spec: resolveWebFunctionRuntime(code.runtime),
    serviceConfig: readWebFunctionServiceConfig(resolved.revision),
  };
}

/** The address a probe / a proxy connects to for a wildcard bind. */
export function webFunctionConnectHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return host;
}

/** How a {@link WebFunctionServe} publishes and boots its container. */
export interface WebFunctionServeOptions {
  /** The env options handed to the shared Lambda container-env resolver. */
  envOptions: LambdaContainerEnvOptions;
  profileCredentials?: ResolvedProfileCredentials;
  extraStateProviders?: ExtraStateProviders;
  /** Address the port is published on. */
  host: string;
  /** Host port; 0 picks a free one. */
  port: number;
  /** docker `--platform`; default: the runtime row's first architecture. */
  platform?: string;
  /** Skip `docker pull` of the runtime base image. */
  skipPull: boolean;
  /** Readiness deadline in ms. */
  timeoutMs: number;
}

/** Where a started web function server answers. */
export interface WebFunctionServeAddress {
  /** The address to connect to (a wildcard bind mapped to loopback). */
  host: string;
  port: number;
}

/**
 * One web function revision's server container: artifact -> env -> pull ->
 * `docker run` -> readiness, and the teardown that removes the container and the
 * extracted bundle. Shared by `start-web-function` (one revision on a local
 * port) and `start-cloudfront` (a Web Function endpoint origin).
 *
 * The teardown is safe to start at ANY point of {@link start}: it waits for an
 * in-flight artifact extraction or `docker run` so the container the docker CLI
 * goes on to create is still removed, and {@link start} then resolves
 * `undefined` instead of an address.
 */
export class WebFunctionServe {
  private artifact: WebFunctionArtifact | undefined;
  private artifactInFlight: Promise<WebFunctionArtifact> | undefined;
  private runInFlight: Promise<string> | undefined;
  private id: string | undefined;
  private name: string | undefined;
  private stopLogs: (() => void) | undefined;
  private exitWatch: ReturnType<typeof watchContainerExit> | undefined;
  private teardownPromise: Promise<void> | undefined;
  private waitingOnRunFlag = false;
  private readonly recent = new RecentOutput();
  private readonly prepared: PreparedWebFunction;
  private readonly options: WebFunctionServeOptions;

  constructor(prepared: PreparedWebFunction, options: WebFunctionServeOptions) {
    this.prepared = prepared;
    this.options = options;
  }

  /** Teardown is blocked on the in-flight `docker run` (no container id yet). */
  get waitingOnRun(): boolean {
    return this.waitingOnRunFlag;
  }

  /** The container's name once `docker run` was issued, so an abandoned shutdown can name it. */
  get containerName(): string | undefined {
    return this.name;
  }

  /** Whether {@link teardown} has started. */
  get tornDown(): boolean {
    return this.teardownPromise !== undefined;
  }

  /** Resolves with the container's exit code once it exits; `undefined` before {@link start} booted it. */
  get exited(): Promise<number | undefined> | undefined {
    return this.exitWatch?.exited;
  }

  /** Boot the server and wait until it answers HTTP. `undefined` when a teardown began meanwhile. */
  async start(): Promise<WebFunctionServeAddress | undefined> {
    const logger = getLogger();
    const { resolved, code, spec, serviceConfig } = this.prepared;
    const opts = this.options;

    this.artifactInFlight = resolveWebFunctionArtifact(
      resolved.stack,
      resolved.revisionLogicalId,
      code
    );
    this.artifact = await this.artifactInFlight;
    if (this.tornDown) return undefined;

    const assumeRole = webFunctionAssumeRole(opts.envOptions.assumeRole, serviceConfig);
    const containerEnv = await resolveLambdaContainerEnv(
      buildWebFunctionLambdaView(resolved, serviceConfig, spec.runtime),
      {
        ...opts.envOptions,
        ...(assumeRole !== undefined && { assumeRole }),
        deployedFunctionLookups: false,
      },
      opts.profileCredentials,
      opts.extraStateProviders
    );
    const { env, replacedHttpEndpoint } = finalizeWebFunctionEnv(containerEnv.env, {
      functionName: resolved.functionName,
      containerPort: WEB_FUNCTION_CONTAINER_PORT,
      timeoutSeconds: serviceConfig.timeoutSeconds,
      logGroup: serviceConfig.logGroup,
    });
    if (replacedHttpEndpoint) {
      logger.warn(
        `The revision's ${WEB_FUNCTION_HTTP_ENDPOINT_ENV} is replaced with 0.0.0.0:` +
          `${WEB_FUNCTION_CONTAINER_PORT}: the runtime owns that variable, and the local port ` +
          `is published to it.`
      );
    }
    const plan = planWebFunctionContainer(this.artifact, spec, env);
    const platform = opts.platform ?? defaultWebFunctionPlatform(spec);

    await pullImage(plan.image, opts.skipPull, platform);
    if (this.tornDown) return undefined;
    const hostPort = opts.port === 0 ? await pickFreePort() : opts.port;
    // Re-checked after the await: a teardown that began meanwhile has nothing
    // in flight to wait on, so a `docker run` issued now would never be removed.
    if (this.tornDown) return undefined;
    const name =
      (this.name = `${getEmbedConfig().resourceNamePrefix}-webfn-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    logger.info(
      `Starting web function container (image=${plan.image}, start=${plan.label}, ` +
        `port=${hostPort} -> ${WEB_FUNCTION_CONTAINER_PORT})...`
    );
    this.runInFlight = startWebFunctionContainer({
      plan,
      env,
      sensitiveEnvKeys: new Set(containerEnv.sensitiveEnvKeys),
      host: opts.host,
      hostPort,
      platform,
      name,
    });
    const id = await this.runInFlight;
    // A teardown while `docker run` was in flight awaited the same promise and
    // removes this container.
    if (this.tornDown) return undefined;
    this.id = id;
    this.stopLogs = streamLogs(id, { onOutput: (chunk) => this.recent.push(chunk) });
    this.exitWatch = watchContainerExit(id);

    const host = webFunctionConnectHost(opts.host);
    await waitForWebFunctionReady({
      containerId: id,
      host,
      port: hostPort,
      timeoutMs: opts.timeoutMs,
      recent: this.recent,
      label: plan.label,
    });
    // A teardown during the readiness wait is removing this container.
    if (this.tornDown) return undefined;
    return { host, port: hostPort };
  }

  /** The error for a container that exited on its own while serving, with its last output. */
  exitFailure(message: string): Promise<CdkLocalError> {
    return containerFailure(
      message,
      this.id ?? '',
      this.recent,
      undefined,
      'LOCAL_START_WEB_FUNCTION_EXITED'
    );
  }

  /** Remove the bundle now, synchronously — for a shutdown that abandons the teardown. */
  disposeArtifactNow(): void {
    disposeWebFunctionArtifact(this.artifact);
  }

  /**
   * Remove the container and the extracted bundle. Memoized: every caller (a
   * failure path, a signal racing it) awaits the SAME teardown.
   */
  teardown(): Promise<void> {
    return (this.teardownPromise ??= this.doTeardown());
  }

  private async doTeardown(): Promise<void> {
    const logger = getLogger();
    this.exitWatch?.stop();
    if (this.artifact === undefined && this.artifactInFlight !== undefined) {
      try {
        this.artifact = await this.artifactInFlight;
      } catch {
        /* the extraction failed: nothing to dispose */
      }
    }
    if (this.id === undefined && this.runInFlight !== undefined) {
      this.waitingOnRunFlag = true;
      try {
        this.id = await this.runInFlight;
      } catch {
        /* docker run failed: no container */
      } finally {
        this.waitingOnRunFlag = false;
      }
    }
    if (this.stopLogs) {
      try {
        this.stopLogs();
      } catch (err) {
        logger.debug(`streamLogs stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Not `--rm`, so this removal is the only one.
    if (this.id) await removeContainer(this.id);
    disposeWebFunctionArtifact(this.artifact);
  }
}
