import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import graphlib from 'graphlib';
import { getDockerCmd, runDockerStreaming } from '../utils/docker-cmd.js';
import { getLogger } from '../utils/logger.js';
import {
  DockerRunnerError,
  pullImage,
  removeContainer,
  appendEnvFlags,
  execEnvForSecrets,
  SENSITIVE_ENV_KEYS,
} from './docker-runner.js';
import { attachContainerLogStreamer } from './container-log-streamer.js';
import { buildDockerImage } from '../assets/docker-build.js';
import { pullEcrImage } from './ecr-puller.js';
import { LocalInvokeBuildError } from '../utils/error-handler.js';
import { AssetManifestLoader } from '../assets/asset-manifest-loader.js';
import {
  buildMetadataEnv,
  createTaskNetwork,
  destroyTaskNetwork,
  type TaskNetwork,
} from './ecs-network.js';
import { resolveEcsSecrets, type ResolvedSecret } from './ecs-secrets-resolver.js';
import {
  checkVolumeHostPath,
  type ResolvedEcsContainer,
  type ResolvedEcsImage,
  type ResolvedEcsTask,
  type ResolvedEcsVolume,
} from './ecs-task-resolver.js';
import { getEmbedConfig } from './embed-config.js';

const execFileAsync = promisify(execFile);

/**
 * Top-level orchestrator for `cdkl run-task`. Coordinates image
 * preparation, secret resolution, docker-network bring-up, container
 * boot in `dependsOn` order, log streaming, exit propagation, and
 * teardown. Designed to be called from the CLI with an idempotent
 * `cleanup()` hook hoisted in the caller so SIGINT and the outer finally
 * share teardown semantics with `cdkl invoke`.
 */

export class EcsTaskRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcsTaskRunnerError';
    Object.setPrototypeOf(this, EcsTaskRunnerError.prototype);
  }
}

export interface RunEcsTaskOptions {
  /** `--cluster <name>`. Surfaced to metadata sidecar and the network prefix. */
  cluster: string;
  /** Override container env vars (SAM-style top-level keys are container names; `Parameters` is global). */
  envOverrides?: Record<string, Record<string, string | null> | undefined>;
  /** Host IP to bind published container ports to. Default `127.0.0.1`. */
  containerHost: string;
  /**
   * When true, the runner omits EVERY `-p <hostPort>:<containerPort>`
   * flag from `docker run` (Issue #585). Set by `cdk-local
   * start-service` for multi-replica services: N replicas of one
   * service all map the same container port, so publishing a fixed host
   * port makes the 2nd+ replica fail to boot with `Bind for
   * 127.0.0.1:<port> failed: port is already allocated` — true whether
   * the TaskDefinition declares an explicit `hostPort` or omits it (cdk-local
   * defaults the omitted host port to `containerPort`). Peer comms still
   * works via container IP / network alias on the shared docker network
   * (the production-like path — real ECS Service Connect / awsvpc tasks
   * have per-task ENIs and never share a host port), so dropping the
   * host-port publish is the correct local analogue. Single-replica
   * services leave this unset so `curl localhost:<port>` from the host
   * still works.
   */
  skipHostPortPublish?: boolean;
  /**
   * `--host-port <containerPort>=<hostPort>` overrides (`containerPort ->
   * hostPort`). When a published container port has an entry here, it is
   * bound on that host port instead of the declared one. Lets the user
   * map a privileged container port (e.g. 80) to a non-privileged host
   * port (e.g. 8080) so the run avoids macOS Docker Desktop's privileged
   * helper. Empty / unset = bind the declared host port (`host ==
   * container`).
   */
  hostPortOverrides?: Record<number, number>;
  /**
   * Issue #86 v1 — container ports to publish on docker-assigned EPHEMERAL
   * host ports (`-p <containerHost>::<port>/tcp`), independent of
   * {@link skipHostPortPublish}. Set by `cdkl start-alb` for the ALB-fronted
   * service: each replica publishes its target container port on a unique
   * ephemeral host port (so N replicas never collide) and the local front-door
   * round-robins to `127.0.0.1:<ephemeralPort>`. The caller discovers the
   * assigned host port post-boot via `getPublishedHostPort`. A port listed here
   * is NOT also fixed-published (the declared `-p host:port:port` is suppressed
   * for it) so the ephemeral binding is unambiguous. Empty / unset → no extra
   * publish flags emitted.
   */
  ephemeralPublishContainerPorts?: number[];
  /** Optional STS-issued temp credentials to expose via the metadata sidecar (`--assume-task-role`). */
  taskCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** ARN of the task role being assumed (forwarded to AWS_CONTAINER_CREDENTIALS_RELATIVE_URI). */
  taskRoleArn?: string;
  /** Force a `--platform` (default: inferred from task `RuntimePlatform.CpuArchitecture`). */
  platformOverride?: string;
  /** Skip `docker pull` on every image (sidecar + each container's image). */
  skipPull: boolean;
  /**
   * Optional role ARN to assume before authenticating against ECR for
   * cross-account / centralized registry pulls (#455). Forwarded to
   * `pullEcrImage`'s `ecrRoleArn` option. Same-account / same-region
   * pulls do not need this.
   */
  ecrRoleArn?: string;
  /**
   * The CLI's `--profile`, forwarded to `pullEcrImage` so the ECR auth
   * authenticates as the profile's account. For `--from-cfn-stack` the
   * image lives in the deployed (profile) account; without this the
   * default credential chain authenticates as the wrong account and the
   * pull is denied. Distinct from `ecrRoleArn` (cross-account via
   * AssumeRole) — both can be set, in which case the assumed role wins.
   */
  profile?: string;
  /** Don't `docker rm -f` containers on task exit; useful for `docker exec` post-mortems. */
  keepRunning: boolean;
  /** Start the containers and return without streaming logs. */
  detach: boolean;
  /** AWS region for secret resolution + metadata sidecar. */
  region?: string;
  /**
   * Optional pre-resolved `ImagePlan` map — only used by tests. Production
   * callers leave undefined and let the runner walk every container's
   * Image / docker build / ECR pull path.
   */
  imagePlanByContainer?: Map<string, string>;
  /**
   * Issue #238 — per-container `--image-override` tag map (set by the
   * `start-service` / `start-alb` boot path when an override engine
   * resolved a local Dockerfile build for this task's representative
   * container). When a container's name is in this map, the runner
   * uses the override tag verbatim and skips `prepareOneImage`'s
   * pull / build path for that container. Sibling containers without
   * an entry still go through their normal resolution. Distinct from
   * {@link imagePlanByContainer} (a full short-circuit used by tests).
   */
  imageOverrideByContainer?: ReadonlyMap<string, string>;
  /**
   * Optional second-from-last octet of the link-local /24 subnet for this
   * task's docker network (1..254). Default 170 (AWS-documented). `cdkl start-service` walks this per replica so concurrent replicas
   * don't collide on the same /24. See `buildEndpointSubnet` in
   * `ecs-network.ts`.
   */
  subnetOctet?: number;
  /**
   * Phase 3 of #262 (Issue #460) — extra `--add-host name:ip` flag
   * pairs the docker-runner injects into EVERY user container's
   * `docker run` invocation. Used by the Cloud Map / Service Connect
   * overlay to map `<discoveryName>.<namespace>` (and bare
   * `<discoveryName>` ClientAlias short forms) to the IP of a peer
   * replica's container on the host's docker bridge.
   *
   * **Shape**: flat array of `['--add-host', 'name:ip', '--add-host', 'name2:ip2', ...]`.
   * The runner appends these to `docker run` verbatim — caller is
   * responsible for filtering out self-host (no point adding a
   * replica's own service to its own resolver) and for building the
   * flag pairs in the order they should be evaluated (docker's
   * resolver hits each entry in order; first match wins). Empty /
   * undefined → no extra flags emitted.
   */
  addHostFlags?: ReadonlyArray<string>;
  /**
   * Pre-existing docker network + sidecar to reuse instead of letting
   * the runner create a fresh per-task one. Set by the
   * `cdkl start-service` CLI which creates ONE shared network at
   * the start of the run (per design doc § 5 Option A — peer services
   * can reach each other by IP without docker `network connect`
   * choreography). When this option is supplied, `runEcsTask`:
   *   1. Skips `createTaskNetwork()`.
   *   2. Uses `existingNetwork.networkName` / `sidecarIp` for every
   *      container's `--network` and `ECS_CONTAINER_METADATA_URI_V4`
   *      env injection.
   *   3. Marks `state.network.ownedByCaller = true` so
   *      `cleanupEcsRun()` does NOT teardown the shared lifecycle —
   *      only the caller (CLI) tears down once at the end of the run.
   *
   * When undefined, the pre-existing per-task lifecycle applies (one
   * network per task, created + destroyed with the task).
   */
  existingNetwork?: TaskNetwork;
  /**
   * Extra docker `--network-alias <alias>` values to register against
   * specific containers in the task. Keyed by container name so the
   * runner only attaches the aliases to the matching container's
   * `docker run` invocation — Service Connect aliases belong to the
   * container that declared the matching `PortMappings[].Name`, not
   * to every container in the task.
   *
   * Used by `cdkl start-service` Option A (shared docker
   * network) so peers can reach this service by its Service Connect
   * `<discoveryName>` short-form / ClientAlias / fqdn via docker's
   * built-in DNS server — without depending on a separate Cloud Map
   * DNS sidecar. Empty / undefined → no extra aliases emitted
   * (network-aliases default to the container's `--name` only).
   */
  networkAliasesByContainer?: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * ECS analogue of the Lambda-container credential fix:
   * synthesized AWS shared credentials file (one INI section under
   * `[<profileName>]`) bind-mounted read-only into EVERY user
   * container, plus `AWS_SHARED_CREDENTIALS_FILE` +
   * `AWS_PROFILE` env-var injection. Lets handlers that call
   * `fromIni({ profile: '<name>' })` explicitly resolve to the same
   * `--profile`-resolved creds the metadata sidecar serves, instead
   * of failing with `CredentialsProviderError: Profile <name> could
   * not be found` inside the container.
   *
   * Set by the CLI ONLY when `--profile` is effective AND
   * `--assume-task-role` is NOT (precedence: assume-task-role >
   * profile-file > sidecar). Caller is responsible for the
   * `writeProfileCredentialsFile()` allocation + `dispose()` cleanup
   * in its single-flight chain — the runner just plumbs the mount
   * and env-vars through `buildDockerRunArgs`.
   */
  profileCredentialsFile?: { hostPath: string; containerPath: string; profileName: string };
}

/**
 * Single struct that carries everything the orchestrator must tear down,
 * regardless of which step failed. Designed so the caller can hoist a
 * single `cleanup(state)` call in both the outer finally and the SIGINT
 * handler.
 */
export interface EcsRunState {
  network: TaskNetwork | undefined;
  /** Resolved docker volume names (`docker volume rm` on teardown). */
  dockerVolumeNames: string[];
  /** Container name → docker id, in start order. */
  startedContainers: { name: string; id: string }[];
  /** Active log streams (stop functions). Drained on teardown. */
  logStoppers: (() => void)[];
  /**
   * Per-container host-port publishes recorded as the runner builds the
   * `docker run -p host:hostPort:containerPort/proto` args, in publish order.
   * The orchestrator (start-service / run-task) reads this AFTER boot to
   * print a single consolidated "Endpoints:" banner so users don't have to
   * scrape it out of the streamed docker-pull output. Empty when
   * `skipHostPortPublish` (multi-replica) suppresses every publish; for
   * ALB-fronted single-replica services, only ports OUTSIDE
   * `ephemeralPublishContainerPorts` are recorded — the front-door owns
   * its own visibility for the ports it fronts.
   */
  publishedEndpoints: PublishedHostEndpoint[];
}

/**
 * One static `-p host:hostPort:containerPort/proto` publish that the runner
 * surfaced for an end-user-facing container port. Used to populate the
 * post-boot "Endpoints:" banner.
 */
export interface PublishedHostEndpoint {
  containerName: string;
  containerPort: number;
  host: string;
  hostPort: number;
  protocol: string;
  /** True when `--host-port <containerPort>=<hostPort>` remapped the host port. */
  overridden: boolean;
}

export interface RunEcsTaskResult {
  /** Exit code of the essential container (0 by default when `--keep-running` and no exit awaited). */
  exitCode: number;
  /** Name of the essential container whose exit drove the result. */
  essentialContainerName?: string;
  state: EcsRunState;
}

/**
 * Build a fresh, empty `EcsRunState`. Surfaces a single allocation point
 * so the CLI's `cleanup()` closure doesn't have to reach into runner
 * internals.
 */
export function createEcsRunState(): EcsRunState {
  return {
    network: undefined,
    dockerVolumeNames: [],
    startedContainers: [],
    logStoppers: [],
    publishedEndpoints: [],
  };
}

/**
 * Cleanup the resources tracked in `state`. Idempotent and safe to call
 * from both the outer `finally` AND the SIGINT handler. Errors per-step
 * are logged at debug so cleanup never masks a real handler error.
 */
export async function cleanupEcsRun(
  state: EcsRunState,
  options: { keepRunning: boolean }
): Promise<void> {
  const logger = getLogger().child('ecs-runner');
  for (const stop of state.logStoppers) {
    try {
      stop();
    } catch (err) {
      logger.debug(`log stream stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  state.logStoppers = [];

  if (!options.keepRunning) {
    for (const c of state.startedContainers) {
      try {
        await stopContainer(c.id, 10);
      } catch (err) {
        logger.debug(
          `docker stop ${c.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        await removeContainer(c.id);
      } catch (err) {
        logger.debug(
          `docker rm -f ${c.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    state.startedContainers = [];
  }

  // Sidecar + network teardown runs unconditionally for runner-owned
  // networks (the docs spell out that `--keep-running` only spares
  // user containers — the network + sidecar would otherwise leak
  // across runs). Caller-owned (shared) networks survive per-task
  // cleanup — `cdkl start-service` tears down ONCE at the end
  // of the run after every replica has been cleaned up.
  if (state.network && !state.network.ownedByCaller) {
    await destroyTaskNetwork(state.network);
  }
  state.network = undefined;

  for (const v of state.dockerVolumeNames) {
    try {
      await execFileAsync(getDockerCmd(), ['volume', 'rm', v]);
      logger.debug(`Removed docker volume ${v}`);
    } catch (err) {
      logger.debug(
        `docker volume rm ${v} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  state.dockerVolumeNames = [];
}

/**
 * Top-level entry point. Mutates `state` as it makes progress so the
 * caller's `cleanup(state)` can roll back partial side effects on any
 * thrown error.
 */
export async function runEcsTask(
  task: ResolvedEcsTask,
  options: RunEcsTaskOptions,
  state: EcsRunState
): Promise<RunEcsTaskResult> {
  const logger = getLogger();

  if (task.containers.length === 0) {
    throw new EcsTaskRunnerError(
      `Task '${task.taskDefinitionLogicalId}' has no containers — nothing to run.`
    );
  }

  for (const w of task.warnings) logger.warn(w);

  // Build the dependency DAG up front so cyclic configs fail before we
  // touch docker.
  const dag = buildDependencyGraph(task.containers);
  const startOrder = topoSort(dag, task.containers);

  // Resolve every container's image. Production callers leave
  // `imagePlanByContainer` undefined — the resolver below walks the asset
  // manifest / ECR / public-image path per image.
  const imagePlan = options.imagePlanByContainer ?? new Map<string, string>();
  if (!options.imagePlanByContainer) {
    await prepareImages(task, imagePlan, options);
  }

  // Resolve every container's secrets in parallel BEFORE network /
  // container boot — any failure short-circuits the whole task. Mirrors
  // the ECS Agent's "fail-fast on missing secret" UX.
  const allSecrets: { containerName: string; name: string; valueFrom: string }[] = [];
  for (const c of task.containers) {
    for (const s of c.secrets) {
      allSecrets.push({ containerName: c.name, name: s.name, valueFrom: s.valueFrom });
    }
  }
  const resolvedSecrets = await resolveEcsSecrets(allSecrets, {
    ...(options.region !== undefined && { region: options.region }),
    ...(options.profile !== undefined && { profile: options.profile }),
  });
  const secretsByContainer = groupSecretsByContainer(resolvedSecrets);

  // Bring the network + sidecar up. From this point on the cleanup
  // path is non-trivial — any failure must `destroyTaskNetwork(state.network)`
  // for runner-owned networks, but caller-owned (shared) networks survive
  // per-task cleanup.
  if (options.existingNetwork) {
    // Option A (design § 5) — `cdkl start-service` creates one
    // shared network at the start of the run; every replica reuses it.
    // The runner marks the state's network as caller-owned so
    // `cleanupEcsRun()` skips teardown (only the CLI tears down once).
    state.network = { ...options.existingNetwork, ownedByCaller: true };
  } else {
    const netCreateOpts: Parameters<typeof createTaskNetwork>[0] = {
      prefix: options.cluster,
      skipPull: options.skipPull,
    };
    if (options.taskCredentials) netCreateOpts.credentials = options.taskCredentials;
    if (options.cluster) netCreateOpts.cluster = options.cluster;
    if (options.subnetOctet !== undefined) netCreateOpts.subnetOctet = options.subnetOctet;
    state.network = await createTaskNetwork(netCreateOpts);
  }

  // Realize docker volumes (per-task `Scope: 'task'` are torn down at
  // cleanup; `Scope: 'shared'` would survive but the docs explicitly
  // pin v1 to per-task semantics).
  const volumeByName = await realizeDockerVolumes(task.volumes, state);

  // Pre-compute every container's CMD args so the start loop only does
  // docker calls.
  const dockerCmds = new Map<string, { args: string[]; sensitiveEnv: Record<string, string> }>();
  for (const container of task.containers) {
    const image = imagePlan.get(container.name);
    if (!image) {
      throw new EcsTaskRunnerError(
        `Internal: no resolved image for container '${container.name}'.`
      );
    }
    const built = buildDockerRunArgs({
      task,
      container,
      image,
      network: state.network.networkName,
      volumeByName,
      secrets: secretsByContainer.get(container.name) ?? [],
      envOverrides: options.envOverrides,
      containerHost: options.containerHost,
      roleArn: options.taskRoleArn,
      platformOverride: options.platformOverride,
      region: options.region,
      sidecarIp: state.network.sidecarIp,
      ...(options.skipHostPortPublish ? { skipHostPortPublish: true } : {}),
      ...(options.hostPortOverrides ? { hostPortOverrides: options.hostPortOverrides } : {}),
      ...(options.ephemeralPublishContainerPorts &&
      options.ephemeralPublishContainerPorts.length > 0
        ? { ephemeralPublishContainerPorts: options.ephemeralPublishContainerPorts }
        : {}),
      ...(options.addHostFlags && options.addHostFlags.length > 0
        ? { addHostFlags: options.addHostFlags }
        : {}),
      ...((options.networkAliasesByContainer?.get(container.name)?.length ?? 0) > 0
        ? { networkAliases: options.networkAliasesByContainer!.get(container.name)! }
        : {}),
      ...(options.profileCredentialsFile && {
        profileCredentialsFile: options.profileCredentialsFile,
      }),
    });
    dockerCmds.set(container.name, { args: built.args, sensitiveEnv: built.sensitiveEnv });
    for (const ep of built.publishedEndpoints) state.publishedEndpoints.push(ep);
  }

  // Boot containers in dependency order. Each container's `dependsOn`
  // gates its start: START condition needs `docker run` to have
  // returned; COMPLETE / SUCCESS / HEALTHY each wait for the dependency
  // container's lifecycle to reach the matching state. The DAG's
  // `startOrder` is the dependency-respecting topological order; any
  // remaining condition gating fires inside the per-container
  // `awaitDependencies` step.
  const startedByName = new Map<string, { id: string; container: ResolvedEcsContainer }>();
  for (const containerName of startOrder) {
    const container = task.containers.find((c) => c.name === containerName)!;
    await awaitDependencies(container, startedByName);

    const { args, sensitiveEnv } = dockerCmds.get(container.name)!;
    logger.info(`Starting container '${container.name}' (image=${imagePlan.get(container.name)})`);
    let id: string;
    try {
      const { stdout } = await execFileAsync(getDockerCmd(), args, {
        maxBuffer: 10 * 1024 * 1024,
        ...execEnvForSecrets(sensitiveEnv),
      });
      id = stdout.trim();
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new DockerRunnerError(
        `docker run failed for container '${container.name}': ${e.stderr?.trim() || e.message || String(err)}`
      );
    }
    state.startedContainers.push({ name: container.name, id });
    startedByName.set(container.name, { id, container });

    if (!options.detach) {
      state.logStoppers.push(attachContainerLogStreamer(`[${container.name}] `, id));
    }
  }

  if (options.detach) {
    return { exitCode: 0, state };
  }

  // Wait for the essential container to exit. AWS-side ECS treats the
  // first `essential: true` container as the task-driving one; cdk-local
  // mirrors that. When no container declares `essential: false`, every
  // container is essential — we use `containers[0]` as the
  // task-driving one.
  const essential = task.containers.find((c) => c.essential) ?? task.containers[0]!;
  const essentialId = startedByName.get(essential.name)?.id;
  if (!essentialId) {
    throw new EcsTaskRunnerError(`Essential container '${essential.name}' did not start.`);
  }
  const exitCode = await waitForContainerExit(essentialId);
  return { exitCode, essentialContainerName: essential.name, state };
}

/**
 * Build the directed graph for `dependsOn` ordering. Each container is
 * a node; an edge `A -> B` means A must start AFTER B. graphlib's
 * topological sort returns B before A so the start loop walks the array
 * in correct order. Cyclic graphs are rejected up front with the
 * offending cycle named.
 */
export function buildDependencyGraph(containers: ResolvedEcsContainer[]): graphlib.Graph {
  const g = new graphlib.Graph({ directed: true });
  for (const c of containers) g.setNode(c.name);
  for (const c of containers) {
    for (const d of c.dependsOn) {
      g.setEdge(c.name, d.containerName);
    }
  }
  const cycles = graphlib.alg.findCycles(g);
  if (cycles.length > 0) {
    throw new EcsTaskRunnerError(
      `Cyclic DependsOn detected: ${cycles.map((c) => c.join(' -> ')).join('; ')}`
    );
  }
  return g;
}

export function topoSort(g: graphlib.Graph, containers: ResolvedEcsContainer[]): string[] {
  // Layered topological sort with template-order tiebreak. Each node's
  // depth = max(depth of nodes it depends on) + 1; nodes with no
  // dependencies are at depth 0. Sorting by (depth, templateIndex)
  // guarantees dependencies are listed before dependents (valid topo
  // order) AND that siblings at the same depth follow the user's
  // template order. The pre-fix double-sort (`topsort.reverse().sort()`)
  // re-ranked globally by template index and could violate topo order
  // when an adversarial template listed a dependent BEFORE its
  // dependency.
  //
  // Edges point dependent -> dependency; a node's depth is one more
  // than the max depth of any node it points to. Cycles are rejected up
  // front in `buildDependencyGraph`, so memoized recursion terminates.
  const depth = new Map<string, number>();
  const computeDepth = (name: string): number => {
    const cached = depth.get(name);
    if (cached !== undefined) return cached;
    let max = -1;
    const successors = g.successors(name) ?? [];
    for (const s of successors) {
      const d = computeDepth(s);
      if (d > max) max = d;
    }
    const result = max + 1;
    depth.set(name, result);
    return result;
  };
  for (const node of g.nodes()) computeDepth(node);

  const byPosition = new Map<string, number>();
  containers.forEach((c, idx) => byPosition.set(c.name, idx));

  return containers
    .map((c) => c.name)
    .filter((n) => depth.has(n))
    .sort((a, b) => {
      const da = depth.get(a)!;
      const db = depth.get(b)!;
      if (da !== db) return da - db;
      return (byPosition.get(a) ?? 0) - (byPosition.get(b) ?? 0);
    });
}

/**
 * Await the dependency conditions for one container. Walks the
 * container's `dependsOn` list in order, blocking on each according to
 * its condition. START is a no-op when the dependency is already in
 * `startedByName` (graphlib has already ordered dependencies before
 * dependents).
 */
async function awaitDependencies(
  container: ResolvedEcsContainer,
  started: Map<string, { id: string; container: ResolvedEcsContainer }>
): Promise<void> {
  for (const dep of container.dependsOn) {
    const entry = started.get(dep.containerName);
    if (!entry) {
      throw new EcsTaskRunnerError(
        `Container '${container.name}' depends on '${dep.containerName}' but the latter never started.`
      );
    }
    switch (dep.condition) {
      case 'START':
        // already started — the topological order guarantees this.
        break;
      case 'COMPLETE':
        await waitForContainerExit(entry.id);
        break;
      case 'SUCCESS': {
        const code = await waitForContainerExit(entry.id);
        if (code !== 0) {
          throw new EcsTaskRunnerError(
            `Container '${container.name}' requires dependency '${dep.containerName}' to exit 0, but it exited ${code}.`
          );
        }
        break;
      }
      case 'HEALTHY':
        await waitForContainerHealthy(entry.id, dep.containerName);
        break;
    }
  }
}

/**
 * Poll `docker inspect --format '{{.State.Health.Status}}'` until the
 * container reports `healthy`, capped at 5 minutes (AWS-side ECS uses
 * the user-declared interval × retries × startPeriod budget but we keep
 * a fixed local cap so a hung healthcheck doesn't block teardown
 * indefinitely).
 */
async function waitForContainerHealthy(containerId: string, displayName: string): Promise<void> {
  const logger = getLogger().child('ecs-runner');
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(getDockerCmd(), [
        'inspect',
        '--format',
        '{{.State.Health.Status}}',
        containerId,
      ]);
      const status = stdout.trim();
      if (status !== lastStatus) {
        logger.debug(`Container '${displayName}' health status: ${status}`);
        lastStatus = status;
      }
      if (status === 'healthy') return;
      if (status === 'unhealthy') {
        throw new EcsTaskRunnerError(
          `Container '${displayName}' health status is 'unhealthy'; aborting before dependents start.`
        );
      }
    } catch (err) {
      if (err instanceof EcsTaskRunnerError) throw err;
      // `docker inspect` may transiently fail right after start; log and retry.
      logger.debug(
        `docker inspect on '${displayName}' failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    await sleep(1000);
  }
  throw new EcsTaskRunnerError(
    `Container '${displayName}' did not become healthy within 5 minutes.`
  );
}

async function waitForContainerExit(containerId: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), ['wait', containerId], {
      maxBuffer: 1024 * 1024,
    });
    const code = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(code) ? code : 1;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new DockerRunnerError(
      `docker wait failed: ${e.stderr?.trim() || e.message || String(err)}`
    );
  }
}

async function stopContainer(containerId: string, graceSeconds: number): Promise<void> {
  try {
    await execFileAsync(getDockerCmd(), ['stop', '-t', String(graceSeconds), containerId]);
  } catch {
    // Ignore — the subsequent `docker rm -f` covers stuck containers.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Resolve every container's `Image` to a tag the runner can pass to
 * `docker run`. The map is keyed by container name; entries are
 * populated in parallel up to the asset-manifest bound (single
 * `docker build` for shared assets is left to docker's own cache).
 */
// Exported for unit testing — the `imageOverrideByContainer`
// short-circuit (issue #238) is the load-bearing contract for
// `--image-override` end-to-end, but `runEcsTask` is too heavy to drive
// for a single short-circuit branch (network + secrets + docker run /
// log stream / exit propagation). Exposing `prepareImages` lets us
// behaviourally cover the override branch without booting the full
// task runner.
export async function prepareImages(
  task: ResolvedEcsTask,
  out: Map<string, string>,
  options: RunEcsTaskOptions
): Promise<void> {
  const logger = getLogger().child('ecs-runner');
  // Sequential is fine — most tasks have 1–3 containers and each
  // `docker build` / pull would saturate IO anyway.
  for (const container of task.containers) {
    // Issue #238 — per-container --image-override tag short-circuit.
    // The override engine already built + tagged this image locally;
    // skip the pull / build path entirely so we never `docker pull`
    // a deterministic local-only tag (which doesn't exist in any
    // registry).
    const overrideTag = options.imageOverrideByContainer?.get(container.name);
    if (overrideTag !== undefined) {
      out.set(container.name, overrideTag);
      logger.debug(`Container '${container.name}' image=${overrideTag} (--image-override)`);
      continue;
    }
    const image = await prepareOneImage(task, container, options);
    out.set(container.name, image);
    logger.debug(`Container '${container.name}' image=${image}`);
  }
}

async function prepareOneImage(
  task: ResolvedEcsTask,
  container: ResolvedEcsContainer,
  options: RunEcsTaskOptions
): Promise<string> {
  const image: ResolvedEcsImage = container.image;
  switch (image.kind) {
    case 'public': {
      await pullImage(image.uri, options.skipPull);
      return image.uri;
    }
    case 'ecr': {
      return pullEcrImage(image.uri, {
        skipPull: options.skipPull,
        ...(options.region !== undefined && { region: options.region }),
        ...(options.ecrRoleArn !== undefined && { ecrRoleArn: options.ecrRoleArn }),
        ...(options.profile !== undefined && { profile: options.profile }),
      });
    }
    case 'cdk-asset': {
      const cdkOutDir = task.stack.assetManifestPath
        ? dirname(task.stack.assetManifestPath)
        : undefined;
      if (!cdkOutDir) {
        throw new EcsTaskRunnerError(
          `Container '${container.name}' uses a CDK asset image but the stack has no asset manifest. ` +
            'Re-synthesize the app (without `--output <stale-dir>`) and retry.'
        );
      }
      const loader = new AssetManifestLoader();
      const manifest = await loader.loadManifest(cdkOutDir, task.stack.stackName);
      if (!manifest) {
        throw new EcsTaskRunnerError(
          `No asset manifest at ${cdkOutDir} for stack ${task.stack.stackName}.`
        );
      }
      const dockerImages = manifest.dockerImages ?? {};
      const entries = Object.entries(dockerImages);
      let asset: { source: import('../types/assets.js').DockerImageAssetSource } | undefined;
      if (image.assetHash && dockerImages[image.assetHash]) {
        asset = dockerImages[image.assetHash];
      } else if (entries.length === 1) {
        asset = entries[0]![1];
      }
      if (!asset) {
        throw new EcsTaskRunnerError(
          `Container '${container.name}' references a CDK asset image but no matching entry was found in cdk.out. ` +
            'Re-synthesize the CDK app and retry.'
        );
      }
      const tag = `${getEmbedConfig().resourceNamePrefix}-run-task-${(image.assetHash ?? 'single').slice(0, 16)}`;
      const actualTag = await buildDockerImage(asset, cdkOutDir, {
        tag,
        ...(options.platformOverride !== undefined && { platform: options.platformOverride }),
        wrapError: (stderr: string) =>
          new LocalInvokeBuildError(
            `docker build failed for ECS container '${container.name}' (${asset.source.directory ?? asset.source.executable?.join(' ')}): ${stderr}`
          ),
      });
      if (actualTag !== tag) {
        // `executable` source mode returns the script's own tag — re-tag
        // to the deterministic `tag` so the downstream `docker run` finds
        // the image under the expected name. Routed through the shared
        // `runDockerStreaming` helper for consistency with publisher /
        // local-invoke.
        try {
          await runDockerStreaming(['tag', actualTag, tag]);
        } catch (err) {
          const e = err as { stderr?: string; message?: string };
          throw new LocalInvokeBuildError(
            `docker tag failed re-tagging '${actualTag}' → '${tag}' for ECS container '${container.name}': ${e.stderr?.trim() || e.message || String(err)}`
          );
        }
      }
      return tag;
    }
  }
}

/**
 * `docker volume create` for every `DockerVolumeConfiguration` entry.
 * Anonymous + host-path volumes need no create call — they're realized
 * at `docker run` time via `-v <hostPath>:<containerPath>`.
 */
async function realizeDockerVolumes(
  volumes: ResolvedEcsVolume[],
  state: EcsRunState
): Promise<Map<string, ResolvedEcsVolume & { dockerVolumeName?: string }>> {
  const logger = getLogger().child('ecs-runner');
  const out = new Map<string, ResolvedEcsVolume & { dockerVolumeName?: string }>();
  for (const v of volumes) {
    if (v.kind === 'host') {
      if (v.hostPath && !checkVolumeHostPath(v.hostPath)) {
        logger.warn(
          `Volume '${v.name}': host path '${v.hostPath}' does not exist or is not a directory. ` +
            'Docker will create an anonymous bind mount; create the host path before run-task if you expected to bind-mount it.'
        );
      }
      out.set(v.name, v);
      continue;
    }
    const cfg = v.dockerVolumeConfig;
    const args: string[] = ['volume', 'create'];
    if (cfg?.driver) args.push('--driver', cfg.driver);
    if (cfg?.driverOpts) {
      for (const [k, val] of Object.entries(cfg.driverOpts)) args.push('--opt', `${k}=${val}`);
    }
    if (cfg?.labels) {
      for (const [k, val] of Object.entries(cfg.labels)) args.push('--label', `${k}=${val}`);
    }
    const dockerVolumeName = `${getEmbedConfig().resourceNamePrefix}-${v.name}-${randHex(4)}`;
    args.push(dockerVolumeName);
    try {
      await execFileAsync(getDockerCmd(), args);
      state.dockerVolumeNames.push(dockerVolumeName);
      logger.debug(`Created docker volume ${dockerVolumeName} for task volume '${v.name}'`);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new DockerRunnerError(
        `docker volume create failed for '${v.name}': ${e.stderr?.trim() || e.message || String(err)}`
      );
    }
    out.set(v.name, { ...v, dockerVolumeName });
  }
  return out;
}

function randHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function groupSecretsByContainer(
  resolved: ResolvedSecret[]
): Map<string, { name: string; value: string }[]> {
  const out = new Map<string, { name: string; value: string }[]>();
  for (const r of resolved) {
    const arr = out.get(r.containerName) ?? [];
    arr.push({ name: r.name, value: r.value });
    out.set(r.containerName, arr);
  }
  return out;
}

interface BuildDockerRunArgs {
  task: ResolvedEcsTask;
  container: ResolvedEcsContainer;
  image: string;
  network: string;
  volumeByName: Map<string, ResolvedEcsVolume & { dockerVolumeName?: string }>;
  secrets: { name: string; value: string }[];
  envOverrides: Record<string, Record<string, string | null> | undefined> | undefined;
  containerHost: string;
  roleArn: string | undefined;
  platformOverride: string | undefined;
  region: string | undefined;
  /**
   * Optional sidecar IP for the metadata-endpoints sidecar on this
   * task's docker network. Defaults to `169.254.170.2`; `cdk-local
   * start-service` overrides per replica so each replica's containers
   * point at their own sidecar instance.
   */
  sidecarIp?: string;
  /**
   * Issue #585 — when true, omit EVERY `-p <hostPort>:<containerPort>`
   * flag. Set by `cdkl start-service` for multi-replica services
   * so the 2nd+ replica does not collide on a shared host port (see the
   * matching field on {@link RunEcsTaskOptions} for the full rationale).
   */
  skipHostPortPublish?: boolean;
  /**
   * `--host-port` overrides (`containerPort -> hostPort`); see the
   * matching field on {@link RunEcsTaskOptions}.
   */
  hostPortOverrides?: Record<number, number>;
  /**
   * Issue #86 v1 — container ports to publish on EPHEMERAL host ports, used by
   * the local ALB front-door. A port is published (as
   * `-p <containerHost>::<port>/<proto>`) only when THIS container declares a
   * matching `portMappings` entry, so the flag lands on the target container
   * even when {@link skipHostPortPublish} dropped the declared mappings. See
   * the matching field on {@link RunEcsTaskOptions}.
   */
  ephemeralPublishContainerPorts?: number[];
  /**
   * Issue #460 — extra `--add-host name:ip` flag pairs forwarded
   * verbatim to `docker run`. Used by the Cloud Map overlay so
   * `<discoveryName>.<namespace>` (and bare ClientAlias short forms)
   * resolve inside this container. Caller is responsible for the
   * flag-pair shape (`['--add-host', 'name:ip', ...]`).
   */
  addHostFlags?: ReadonlyArray<string>;
  /**
   * Issue #460 / design § 5 Option A — extra `--network-alias <alias>`
   * values the runner adds to the `docker run` invocation. Used by
   * `cdkl start-service` shared-network mode so peers can reach
   * this container by its Service Connect discoveryName / ClientAlias
   * / fqdn via docker's built-in DNS server. The container's
   * `--name`-derived alias is ALWAYS added (line 813); these are
   * additional aliases registered alongside it.
   */
  networkAliases?: ReadonlyArray<string>;
  /**
   * ECS analogue of the Lambda-container credential fix — bind-mounts
   * a host-side AWS shared credentials file (one `[<profileName>]`
   * INI section) read-only into the container and sets
   * `AWS_SHARED_CREDENTIALS_FILE` + `AWS_PROFILE` env vars so handler
   * code calling `fromIni({ profile })` resolves to the same creds
   * the metadata sidecar serves. When undefined (the default), no
   * mount / env vars are emitted — `--profile` is forwarded to the
   * sidecar only.
   */
  profileCredentialsFile?: { hostPath: string; containerPath: string; profileName: string };
}

/**
 * Parse `--host-port <containerPort>=<hostPort>` overrides into a
 * `containerPort -> hostPort` map.
 *
 * By default cdk-local publishes a container port on the SAME host port
 * (`host == container`), which is predictable but fails on macOS for
 * privileged ports (< 1024): Docker Desktop binds those through the
 * `com.docker.vmnetd` privileged helper, which prompts for an admin
 * password and fails when cancelled. Rather than silently changing the
 * host port, the user opts in explicitly — e.g. `--host-port 80=8080`
 * publishes the container's port 80 on host port 8080.
 *
 * Repeatable; each value is `<containerPort>=<hostPort>` with both in
 * 1-65535. Throws on a malformed value so the CLI surfaces a clear error.
 */
export function parseHostPortOverrides(values: string[] | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  for (const raw of values ?? []) {
    const m = /^(\d+)=(\d+)$/.exec(raw.trim());
    if (!m) {
      throw new Error(
        `Invalid --host-port '${raw}'. Expected <containerPort>=<hostPort> (e.g. 80=8080).`
      );
    }
    const containerPort = Number(m[1]);
    const hostPort = Number(m[2]);
    for (const [label, p] of [
      ['container', containerPort],
      ['host', hostPort],
    ] as const) {
      if (p < 1 || p > 65535) {
        throw new Error(`Invalid --host-port '${raw}': ${label} port must be 1-65535.`);
      }
    }
    out[containerPort] = hostPort;
  }
  return out;
}

/**
 * Build the full `docker run -d` argument list for one container.
 * Exported (no-leading-underscore) so the unit tests can assert against
 * the shape directly without spawning a process.
 */
export function buildDockerRunArgs(opts: BuildDockerRunArgs): {
  args: string[];
  sensitiveEnv: Record<string, string>;
  publishedEndpoints: PublishedHostEndpoint[];
} {
  const { task, container, image, network, volumeByName, secrets, containerHost, roleArn } = opts;
  const args: string[] = ['run', '-d'];
  const publishedEndpoints: PublishedHostEndpoint[] = [];

  // Stable name so siblings can reach this container via DNS.
  args.push(
    '--name',
    `${getEmbedConfig().resourceNamePrefix}-${task.family}-${container.name}-${randHex(3)}`
  );
  args.push('--network', network);
  args.push('--network-alias', container.name);

  // Issue #460 / design § 5 Option A — extra `--network-alias` for
  // every Service Connect discoveryName / ClientAlias short-form /
  // fqdn this container should be reachable as. With a shared docker
  // network across all services in the CLI run, peers resolve any
  // alias via docker's built-in DNS server — no extra DNS sidecar
  // needed. De-duplicated against the `container.name` alias above.
  if (opts.networkAliases && opts.networkAliases.length > 0) {
    const seen = new Set<string>([container.name]);
    for (const a of opts.networkAliases) {
      if (!seen.has(a)) {
        args.push('--network-alias', a);
        seen.add(a);
      }
    }
  }

  // Issue #460 — Cloud Map / Service Connect overlay. The
  // `--add-host` flags here come from the in-process CloudMapRegistry
  // populated by the service runner after each peer replica boots.
  // Multi-replica routing is approximated as "first registered
  // endpoint per fqdn" — full multi-instance DNS rotation requires
  // the deferred DNS-sidecar option (§6 of the design).
  if (opts.addHostFlags && opts.addHostFlags.length > 0) {
    for (const f of opts.addHostFlags) args.push(f);
  }

  if (opts.platformOverride) {
    args.push('--platform', opts.platformOverride);
  } else if (task.runtimePlatform) {
    args.push(
      '--platform',
      task.runtimePlatform.cpuArchitecture === 'ARM64' ? 'linux/arm64' : 'linux/amd64'
    );
  }

  // Issue #585 — multi-replica services skip the host-port publish.
  // N replicas of one service all map the same container port; binding
  // a fixed host port makes the 2nd+ replica fail with `port is already
  // allocated`. Peer comms still works via container IP / network alias
  // on the shared docker network (production-like — real ECS Service
  // Connect tasks have per-task ENIs and never share a host port).
  // Ports that are published ephemerally for the front-door (below) must NOT
  // also get the fixed declared publish — otherwise a single-replica ALB
  // service would bind the same container port TWICE (`-p host:80:80` AND
  // `-p host::80`), and `getPublishedHostPort` could read the fixed binding
  // instead of the ephemeral one. The ephemeral publish is the front-door's
  // sole binding for these ports.
  const ephemeralPorts = new Set(opts.ephemeralPublishContainerPorts ?? []);
  if (!opts.skipHostPortPublish) {
    for (const pm of container.portMappings) {
      if (ephemeralPorts.has(pm.containerPort)) continue;
      const declaredHostPort = pm.hostPort ?? pm.containerPort;
      const hostPort = opts.hostPortOverrides?.[pm.containerPort] ?? declaredHostPort;
      const overridden = hostPort !== declaredHostPort;
      const overrideNote = overridden ? ' (--host-port override)' : '';
      getLogger()
        .child('ecs')
        .info(
          `Container '${container.name}' container port ${pm.containerPort} published on ` +
            `${containerHost}:${hostPort}${overrideNote}. Reach it at ${containerHost}:${hostPort}.`
        );
      args.push('-p', `${containerHost}:${hostPort}:${pm.containerPort}/${pm.protocol}`);
      publishedEndpoints.push({
        containerName: container.name,
        containerPort: pm.containerPort,
        host: containerHost,
        hostPort,
        protocol: pm.protocol,
        overridden,
      });
    }
  }

  // Issue #86 v1 — ALB front-door ephemeral publish. For each requested
  // target container port that THIS container actually declares, publish it on
  // a docker-assigned ephemeral host port (`-p <host>::<port>/<proto>`),
  // independent of skipHostPortPublish. N replicas can each publish the same
  // container port without colliding because the host port is unallocated; the
  // service runner discovers the assigned port via `getPublishedHostPort` and
  // round-robins the front-door to it.
  if (ephemeralPorts.size > 0) {
    const alreadyEphemeral = new Set<number>();
    for (const pm of container.portMappings) {
      if (!ephemeralPorts.has(pm.containerPort) || alreadyEphemeral.has(pm.containerPort)) continue;
      alreadyEphemeral.add(pm.containerPort);
      args.push('-p', `${containerHost}::${pm.containerPort}/${pm.protocol}`);
    }
  }

  // Bind-mount the host-side profile credentials file read-only at the
  // fixed in-container path so `fromIni({
  // profile })` handlers resolve to the same creds the sidecar
  // serves. The `:ro` flag is load-bearing: a compromised handler
  // must not be able to tamper with the host-side temp file. Set
  // BEFORE the user's own `MountPoints` so a (malformed) user mount
  // that targets `/cdk-local-aws/credentials` doesn't shadow the
  // creds file — docker honors mount-order by container path
  // uniqueness; a later mount at the same target would fail or shadow.
  if (opts.profileCredentialsFile) {
    args.push(
      '-v',
      `${opts.profileCredentialsFile.hostPath}:${opts.profileCredentialsFile.containerPath}:ro`
    );
  }

  // Mounts: walk the container's `MountPoints` and look up the matching
  // volume to decide bind-mount vs docker volume.
  for (const mp of container.mountPoints) {
    const v = volumeByName.get(mp.sourceVolume);
    if (!v) continue;
    if (v.kind === 'host') {
      if (v.hostPath) {
        const ro = mp.readOnly ? ':ro' : '';
        args.push('-v', `${v.hostPath}:${mp.containerPath}${ro}`);
      } else {
        // Anonymous: only the container path, docker manages the volume.
        args.push('-v', mp.containerPath);
      }
    } else {
      const name = v.dockerVolumeName ?? v.name;
      const ro = mp.readOnly ? ':ro' : '';
      args.push('-v', `${name}:${mp.containerPath}${ro}`);
    }
  }

  // Env precedence (highest wins):
  //   1. function-specific `--env-vars` entry
  //   2. global `Parameters` `--env-vars` entry
  //   3. resolved secrets
  //   4. template literal env
  //   5. profile credentials file env (AWS_SHARED_CREDENTIALS_FILE / AWS_PROFILE)
  //   6. metadata sidecar env (sidecar URL / role URL)
  const finalEnv: Record<string, string> = {};
  const metaEnv = buildMetadataEnv({
    containerName: container.name,
    ...(roleArn !== undefined && { roleArn }),
    ...(opts.region !== undefined && { region: opts.region }),
    ...(opts.sidecarIp !== undefined && { sidecarIp: opts.sidecarIp }),
  });
  Object.assign(finalEnv, metaEnv);
  // Point the container's SDK chain at the bind-mounted credentials file
  // so `fromIni({ profile })` calls inside
  // the handler resolve to the same creds. `AWS_PROFILE` makes
  // `fromIni()` (no explicit arg) ALSO use this profile. Sits ABOVE
  // template / secret / --env-vars overrides so a user template that
  // sets its own `AWS_PROFILE` (e.g. for a different in-container
  // chain) still wins.
  if (opts.profileCredentialsFile) {
    finalEnv['AWS_SHARED_CREDENTIALS_FILE'] = opts.profileCredentialsFile.containerPath;
    finalEnv['AWS_PROFILE'] = opts.profileCredentialsFile.profileName;
  }
  Object.assign(finalEnv, container.environment);
  for (const s of secrets) finalEnv[s.name] = s.value;

  const overrides = opts.envOverrides;
  if (overrides) {
    applyOverrideMap(finalEnv, overrides['Parameters']);
    applyOverrideMap(finalEnv, overrides[container.name]);
  }

  // Resolved secret values (and any AWS credentials that landed in the
  // env) route through docker's value-from-process-env form (`-e KEY`,
  // value supplied via the spawned docker process's env) so they never
  // appear in `docker run`'s argv. Non-secret config keeps `-e KEY=VALUE`.
  const sensitiveEnvKeys = new Set<string>(SENSITIVE_ENV_KEYS);
  for (const s of secrets) sensitiveEnvKeys.add(s.name);
  // Env keys that resolved to a decrypted SecureString SSM parameter
  // (issue #99) — same off-argv treatment as secrets.
  for (const k of container.sensitiveEnvKeys) sensitiveEnvKeys.add(k);
  const sensitiveEnv = appendEnvFlags(args, finalEnv, sensitiveEnvKeys);

  if (container.user) args.push('--user', container.user);
  if (container.privileged) args.push('--privileged');
  if (container.readonlyRootFilesystem) args.push('--read-only');
  if (container.workingDirectory) args.push('--workdir', container.workingDirectory);
  for (const u of container.ulimits) {
    args.push('--ulimit', `${u.name}=${u.softLimit}:${u.hardLimit}`);
  }
  for (const link of container.links) args.push('--link', link);

  if (container.healthCheck) {
    args.push('--health-cmd', shellJoin(container.healthCheck.command));
    if (container.healthCheck.interval !== undefined) {
      args.push('--health-interval', `${container.healthCheck.interval}s`);
    }
    if (container.healthCheck.timeout !== undefined) {
      args.push('--health-timeout', `${container.healthCheck.timeout}s`);
    }
    if (container.healthCheck.retries !== undefined) {
      args.push('--health-retries', String(container.healthCheck.retries));
    }
    if (container.healthCheck.startPeriod !== undefined) {
      args.push('--health-start-period', `${container.healthCheck.startPeriod}s`);
    }
  }

  // EntryPoint maps the same way as docker — first item to --entrypoint,
  // the rest become positional args before CMD.
  let entryPointTail: string[] = [];
  if (container.entryPoint && container.entryPoint.length > 0) {
    args.push('--entrypoint', container.entryPoint[0]!);
    entryPointTail = container.entryPoint.slice(1);
  }

  args.push(image, ...entryPointTail, ...(container.command ?? []));
  return { args, sensitiveEnv, publishedEndpoints };
}

function applyOverrideMap(
  acc: Record<string, string>,
  map: Record<string, string | null> | undefined
): void {
  if (!map) return;
  for (const [k, v] of Object.entries(map)) {
    if (v === null) delete acc[k];
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      acc[k] = String(v);
    }
  }
}

/**
 * Quote each arg for `docker --health-cmd`. Docker's healthcheck takes
 * a single string which is passed to `/bin/sh -c`, so multi-word commands
 * need to be space-joined. We escape single quotes / `$` characters to
 * avoid shell injection from CFn-supplied values.
 */
function shellJoin(parts: string[]): string {
  return parts
    .map((p) => {
      if (/^[A-Za-z0-9_\-./=:]+$/.test(p)) return p;
      return `'${p.replace(/'/g, "'\\''")}'`;
    })
    .join(' ');
}
