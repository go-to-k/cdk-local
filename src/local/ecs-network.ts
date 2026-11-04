import { describeExitWithoutArgv } from '../utils/docker-argv-redaction.js';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { getDockerCmd, warnFinchArgvExposure } from '../utils/docker-cmd.js';
import { getLogger } from '../utils/logger.js';
import {
  DockerRunnerError,
  pullImage,
  removeContainer,
  appendEnvFlags,
  describeRefusedSensitiveEnvKeys,
  execEnvForSecrets,
  SENSITIVE_ENV_KEYS,
} from './docker-runner.js';
import { getEmbedConfig } from './embed-config.js';
import { displayToolOutput } from '../utils/ident-display.js';

const execFileAsync = promisify(execFile);

/**
 * Docker network + AWS-published metadata-endpoints sidecar lifecycle for
 * `cdkl run-task`. The sidecar (a small Go binary maintained by
 * awslabs) is started at `169.254.170.2` on the per-task docker network so
 * containers can hit `http://169.254.170.2/v4/<container-id>` for task
 * metadata AND `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/creds` for IAM
 * task-role credentials (the sidecar is handed the already-assumed role's
 * credentials, so its `/creds` route serves exactly those; issue #853).
 * cdk-local does NOT re-implement the sidecar
 * — pulling the AWS-published image keeps cdk-local in lock-step with whatever
 * ECS-Agent fidelity AWS chooses to provide.
 */

/** AWS-published sidecar image (latest tag). amd64 is the only image AWS ships. */
export const METADATA_ENDPOINT_IMAGE = 'amazon/amazon-ecs-local-container-endpoints:latest-amd64';

/**
 * Default well-known IP for the ECS local-container-endpoints sidecar —
 * matches the documented AWS task-metadata endpoint address. Containers
 * inject `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<id>`
 * to reach it. `cdkl run-task` keeps this verbatim; `cdk-local
 * start-service` creates ONE shared network at CLI startup (design
 * § 5 Option A) — the shared sidecar lives at `169.254.171.2` (see
 * `SHARED_SVC_SUBNET_OCTET` below), one octet up so the two CLI
 * variants can run on the same host without bridge-pool collision. That
 * octet is a preference: a concurrent run moves to the next free /24.
 */
export const METADATA_ENDPOINT_IP = '169.254.170.2';

/**
 * Subnet octet of the AWS-documented `169.254.170.0/24`. Pinned whenever a
 * task role is in effect: every AWS SDK resolves
 * `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` against the fixed host
 * `169.254.170.2`, and over plain http the SDKs refuse a `FULL_URI` on any
 * other link-local address — so task-role credentials work only from a
 * sidecar at exactly that IP (issues #850 / #854). One task-role run per
 * host can hold it at a time.
 */
export const TASK_ROLE_SUBNET_OCTET = 170;

/**
 * Path of the sidecar's credentials route that serves the credentials the
 * sidecar was STARTED with. cdk-local hands the sidecar the already-assumed
 * task-role credentials, so this is the task role. `/role/<name>` and
 * `/role-arn/<arn>` would make the sidecar call `sts:AssumeRole` again with
 * those credentials (denied), and the url-encoded `/role/<arn>` form is not
 * routed at all (404, issue #853).
 */
export const TASK_ROLE_CREDENTIALS_PATH = '/creds';

/**
 * Pure-functional subnet derivation. `cdkl run-task` uses the
 * default subnet (octet 170); `cdkl start-service` uses a SINGLE
 * shared network that prefers `SHARED_SVC_SUBNET_OCTET = 171`
 * (one octet up from run-task so the two CLI variants can coexist on
 * the same host) and walks on to the next free /24 when a concurrent
 * run holds it.
 *
 * `subnetOctet` is the second-from-last byte of the network: 170 →
 * 169.254.170.0/24 (default), 171 → 169.254.171.0/24, etc. Valid
 * range is 1..254 — exported here so callers keep the CIDR /
 * sidecar-IP derivation in one place.
 */
export function buildEndpointSubnet(subnetOctet: number): {
  cidr: string;
  sidecarIp: string;
} {
  if (subnetOctet < 1 || subnetOctet > 254 || !Number.isInteger(subnetOctet)) {
    throw new Error(
      `buildEndpointSubnet: subnetOctet must be an integer in 1..254 (got ${subnetOctet}).`
    );
  }
  return {
    cidr: `169.254.${subnetOctet}.0/24`,
    sidecarIp: `169.254.${subnetOctet}.2`,
  };
}

export interface TaskNetwork {
  /** Generated docker network name (`<prefix>-task-<rand>` or `<prefix>-svc-<rand>` for shared). */
  networkName: string;
  /** Container id of the metadata-endpoints sidecar. Cleaned up at teardown. */
  sidecarContainerId: string;
  /**
   * Resolved sidecar IP for THIS network instance. `cdkl run-task`
   * sees 169.254.170.2 (the default); `cdkl start-service` shares
   * a single network across every service in the run at
   * `169.254.171.2`, or `.2` of the next free /24 when a concurrent run
   * holds that one. Containers' `ECS_CONTAINER_METADATA_URI_V4` is
   * derived from this so each replica's containers hit the right
   * sidecar regardless of which network they joined.
   */
  sidecarIp: string;
  /**
   * When true, the network + sidecar are owned by the caller (the CLI
   * created them once and reuses across every task / replica boot in
   * the run) and `cleanupEcsRun()` MUST NOT teardown — only the caller
   * tears down at the end of the CLI lifecycle. When false / undefined,
   * the task runner owns the lifecycle (the pre-existing
   * `cdkl run-task` shape: one network per task, torn down
   * with the task).
   */
  ownedByCaller?: boolean;
  /**
   * ARN of the task role whose credentials this network's sidecar serves at
   * {@link TASK_ROLE_CREDENTIALS_PATH}. Set by
   * {@link serveTaskRoleFromSharedSidecar} on the shared `start-service` /
   * `start-alb` network; one sidecar holds one credential set, so a second,
   * different role is refused.
   */
  taskRoleArn?: string;
}

export interface CreateTaskNetworkOptions {
  /**
   * Docker network name prefix. Default `cdkl`; the runner injects
   * the CLI's `--cluster <name>`. The full name is `<prefix>-task-<rand>`.
   */
  prefix?: string;
  /**
   * When set, the sidecar receives `AWS_ACCESS_KEY_ID` /
   * `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` env vars so its
   * `/creds` endpoint serves these creds to the user
   * containers. When unset, the sidecar falls back to its default
   * credential chain (typically empty — the user containers will get
   * 4xx from the credentials endpoint, mimicking IAM-misconfigured prod).
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** `--cluster <name>` value. Forwarded to the sidecar's `CLUSTER` env. */
  cluster?: string;
  /** Skip `docker pull <sidecar>`. */
  skipPull?: boolean;
  /**
   * Optional second-from-last octet of the link-local /24 subnet
   * (1..254). Default 170 (the AWS-documented metadata-endpoint subnet),
   * which is pinned — the shape a task role needs. An explicit value is
   * the FIRST candidate only: when
   * that /24 is taken the create walks {@link fallbackSubnetOctets}, and
   * the returned `sidecarIp` follows the /24 it got.
   */
  subnetOctet?: number;
}

/**
 * PREFERRED subnet octet for the shared-service docker network used by
 * `cdkl start-service` / `start-alb`. One octet up from `cdkl run-task`'s
 * default (170 → 171) so the two CLI variants can run on the same host
 * without docker rejecting the second `--subnet`. It is the FIRST
 * candidate, not a fixed address: when another process already owns
 * `169.254.171.0/24` (a concurrent `start-service` / `start-alb`, issue
 * #849), `createSharedSvcNetwork` walks {@link fallbackSubnetOctets} and
 * the sidecar IP (and so every container's `ECS_CONTAINER_METADATA_URI_V4`)
 * follows whichever /24 the create won.
 */
export const SHARED_SVC_SUBNET_OCTET = 171;

/**
 * Docker label recording the PID of the process that created a
 * `<prefix>-svc-*` network, and the host it ran on. The orphan sweep reads
 * them so a concurrent run's network is never reclaimed while its owner is
 * alive (issue #849).
 */
export const OWNER_PID_LABEL = 'cdk-local.owner-pid';
export const OWNER_HOST_LABEL = 'cdk-local.owner-host';

/**
 * Candidate octets for a network whose /24 may be ANY free link-local
 * subnet: `preferred` first, then 171..254, then 1..168. Skips 169
 * (`169.254.169.254`, the instance metadata service), 170 (the
 * AWS-documented `169.254.170.0/24`, which a task-role run needs; see
 * {@link TASK_ROLE_SUBNET_OCTET}) unless it is `preferred`, and 0 / 255
 * (RFC 3927 reserves the first and last /24 of 169.254.0.0/16).
 */
export function fallbackSubnetOctets(preferred: number): number[] {
  const out = [preferred];
  const push = (o: number): void => {
    if (o !== preferred) out.push(o);
  };
  for (let o = 171; o <= 254; o++) push(o);
  for (let o = 1; o <= 168; o++) push(o);
  return out;
}

/**
 * True when a `docker network create --subnet` failure means the /24 is
 * already taken by another network (docker: "Pool overlaps with other one
 * on this address space"; podman: "subnet ... is already used"), so the
 * next candidate subnet may succeed. Any other failure is not retried.
 */
export function isSubnetTakenError(message: string): boolean {
  return /pool overlaps|overlaps with|overlapping|is already used|already in use/i.test(message);
}

/**
 * Create the one shared docker network + metadata-endpoints sidecar
 * used by every service-replica boot in a single
 * `cdkl start-service` invocation. This is design doc § 5
 * Option A — one network per CLI invocation instead of one network
 * per task — so peer services can reach each other by IP / network
 * alias without docker `--network connect` choreography (Option B,
 * rejected in design § 5 as "unwieldy and racy"). The returned
 * `TaskNetwork` carries `ownedByCaller: true` so `cleanupEcsRun()`
 * (called per replica by the service runner) does NOT teardown — the
 * CLI tears down ONCE at the end of the run.
 */
export async function createSharedSvcNetwork(
  options: Omit<CreateTaskNetworkOptions, 'subnetOctet'> & {
    /**
     * A task role is in effect (`--assume-role` / `--assume-task-role`):
     * pin the network to `169.254.170.0/24` so the sidecar sits at
     * `169.254.170.2`, the only address SDKs read task-role credentials
     * from. Fails with a conflict error naming the holder when another run
     * owns that /24 (issue #854). Unset keeps the free-/24 walk from 171.
     */
    taskRole?: boolean;
  } = {}
): Promise<TaskNetwork> {
  const prefix = options.prefix ?? getEmbedConfig().resourceNamePrefix;
  // Reclaim any `<prefix>-svc-*` network left behind by a previous
  // `start-service` run that was interrupted (Ctrl-C / crash) before its
  // teardown, so leaked networks do not pile up and push later runs off the
  // preferred 169.254.171.0/24. A network whose owner process is still
  // alive (a concurrent run) is left alone.
  await sweepOrphanedSvcNetworks(prefix);
  const suffix = randomBytes(4).toString('hex');
  const networkName = `${prefix}-svc-${suffix}`;
  const { sidecarContainerId, sidecarIp } = await createNetworkAndSidecar({
    networkName,
    subnetOctets: options.taskRole
      ? [TASK_ROLE_SUBNET_OCTET]
      : fallbackSubnetOctets(SHARED_SVC_SUBNET_OCTET),
    labels: {
      [OWNER_PID_LABEL]: String(process.pid),
      [OWNER_HOST_LABEL]: hostname(),
    },
    skipPull: options.skipPull ?? false,
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    ...(options.cluster !== undefined ? { cluster: options.cluster } : {}),
  });
  return { networkName, sidecarContainerId, sidecarIp, ownedByCaller: true };
}

/**
 * True when the process recorded in a network's owner labels is still
 * running. A network created on ANOTHER host (a remote `DOCKER_HOST` shared
 * by several machines) cannot be judged from here, so it counts as alive.
 */
function ownerIsAlive(pidLabel: string, hostLabel: string): boolean {
  if (hostLabel !== hostname()) return true;
  const pid = Number(pidLabel);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Startup orphan sweep for the shared `cdkl start-service` network
 * (Issue #93, design Option 1). When a `start-service` run is interrupted
 * before its end-of-run teardown, the shared `<prefix>-svc-<rand>` network
 * and its `<prefix>-svc-<rand>-metadata` sidecar LEAK, holding a link-local
 * /24. The next run no longer fails on it (the create walks to a free /24,
 * issue #849), but leaked networks would otherwise accumulate, so this sweep
 * removes `<prefix>-svc-*` networks that have NO live owner before the next
 * run creates its own.
 *
 * Classification: a `<prefix>-svc-*` network is ORPHANED when its only
 * attached container is its own `<name>-metadata` sidecar (or it has zero
 * attached containers) AND its owner is gone. A network that still has a
 * non-metadata (user replica) container attached is LEFT untouched. The
 * owner is read from the {@link OWNER_PID_LABEL} / {@link OWNER_HOST_LABEL}
 * labels the create stamps: a concurrent `start-service` / `start-alb` is
 * often still building images, with only its sidecar attached, for minutes —
 * its network is kept while that PID is alive on this host, or when it was
 * created on another host. A network without the labels (made by an older
 * release) falls back to the attached-containers test alone.
 *
 * Resilient by design: a `docker network ls` / `inspect` failure must not
 * abort the run — it logs at debug and skips, matching the idempotent
 * teardown style in this file. Returns the list of swept network names.
 */
export async function sweepOrphanedSvcNetworks(prefix: string): Promise<string[]> {
  const logger = getLogger().child('ecs-network');
  const filter = `${prefix}-svc-`;
  let names: string[];
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), [
      'network',
      'ls',
      '--filter',
      `name=${filter}`,
      '--format',
      '{{.Name}}',
    ]);
    names = stdout
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    logger.debug(
      `docker network ls (sweep) failed: ${displayToolOutput(e.stderr || e.message || String(err))}`
    );
    return [];
  }

  const swept: string[] = [];
  for (const name of names) {
    let attached: string[];
    try {
      const { stdout } = await execFileAsync(getDockerCmd(), [
        'network',
        'inspect',
        name,
        '--format',
        '{{range .Containers}}{{.Name}} {{end}}',
      ]);
      attached = stdout
        .split(/\s+/)
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      logger.debug(
        `docker network inspect ${name} (sweep) failed: ${displayToolOutput(e.stderr || e.message || String(err))}`
      );
      continue;
    }

    const sidecarName = `${name}-metadata`;
    const hasLiveOwner = attached.some((c) => c !== sidecarName);
    if (hasLiveOwner) {
      // A user replica is still attached — this is a live concurrent run.
      continue;
    }

    let owner: { pid: string; host: string };
    try {
      const { stdout } = await execFileAsync(getDockerCmd(), [
        'network',
        'inspect',
        name,
        '--format',
        `{{index .Labels "${OWNER_PID_LABEL}"}} {{index .Labels "${OWNER_HOST_LABEL}"}}`,
      ]);
      const [pid = '', host = ''] = stdout.trim().split(/\s+/);
      owner = { pid, host };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      logger.debug(
        `docker network inspect ${name} labels (sweep) failed: ${displayToolOutput(e.stderr || e.message || String(err))}`
      );
      continue;
    }
    if (owner.pid !== '' && ownerIsAlive(owner.pid, owner.host)) {
      // A concurrent run that has not attached its first replica yet.
      if (owner.host !== hostname()) {
        logger.info(
          `Keeping shared network ${name}: it was created on host ${displayToolOutput(owner.host)}, ` +
            'whose processes cannot be checked from here; `docker network rm` it if it is stale.'
        );
      }
      continue;
    }

    logger.info(`Reclaiming orphaned shared network ${name} (no live owner)...`);
    await removeContainer(sidecarName);
    await destroyNetworkOnly(name);
    swept.push(name);
  }
  return swept;
}

/**
 * Internal helper shared by `createTaskNetwork` (per-task) and
 * `createSharedSvcNetwork` (per-CLI-run). Creates the docker network,
 * pulls the sidecar image, and starts the sidecar at `.2` of the /24 the
 * network got.
 *
 * `subnetOctets` lists the candidate /24s in order. The create is tried on
 * each in turn, moving on only when docker reports the subnet is already
 * taken ({@link isSubnetTakenError}) — the create itself is the atomic
 * claim, so two processes starting at once never both get the same /24
 * (issue #849). A one-element list pins the subnet. Throws
 * `DockerRunnerError` with a hint on any other failure, or when every
 * candidate is taken.
 */
async function createNetworkAndSidecar(args: {
  networkName: string;
  subnetOctets: number[];
  labels?: Record<string, string>;
  credentials?: CreateTaskNetworkOptions['credentials'];
  cluster?: string;
  skipPull: boolean;
}): Promise<{ sidecarContainerId: string; sidecarIp: string }> {
  const logger = getLogger().child('ecs-network');
  const { networkName, subnetOctets, labels, credentials, cluster, skipPull } = args;

  await pullImage(METADATA_ENDPOINT_IMAGE, skipPull);

  const labelArgs = Object.entries(labels ?? {}).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  let sidecarIp: string | undefined;
  let lastCidr = '';
  let lastDetail = '';
  logger.info(`Creating docker network ${networkName}...`);
  for (const octet of subnetOctets) {
    const subnet = buildEndpointSubnet(octet);
    lastCidr = subnet.cidr;
    logger.debug(`Trying subnet ${subnet.cidr} for ${networkName}`);
    try {
      await execFileAsync(getDockerCmd(), [
        'network',
        'create',
        '--driver',
        'bridge',
        '--subnet',
        subnet.cidr,
        ...labelArgs,
        networkName,
      ]);
      sidecarIp = subnet.sidecarIp;
      logger.info(`Created docker network ${networkName} (subnet ${subnet.cidr})`);
      break;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      lastDetail = e.stderr?.trim() || e.message || String(err);
      if (subnetOctets.length > 1 && isSubnetTakenError(lastDetail)) {
        logger.debug(`Subnet ${subnet.cidr} is taken; trying the next link-local /24`);
        continue;
      }
      break;
    }
  }
  if (sidecarIp === undefined) {
    let hint: string;
    if (subnetOctets.length > 1) {
      hint = isSubnetTakenError(lastDetail)
        ? 'Hint: every candidate link-local /24 subnet is taken; remove leftover networks ' +
          'with `docker network ls` + `docker network rm`.'
        : 'Hint: check that the docker daemon is running and can create bridge networks.';
    } else if (isSubnetTakenError(lastDetail)) {
      hint = pinnedSubnetConflictHint(lastCidr, await findNetworkHoldingSubnet(lastCidr));
    } else {
      hint = 'Hint: check that the docker daemon is running and can create bridge networks.';
    }
    throw new DockerRunnerError(
      `docker network create failed: ${displayToolOutput(lastDetail)}. ${hint}`
    );
  }

  try {
    const sidecarContainerId = await startSidecar({
      networkName,
      sidecarIp,
      ...(credentials !== undefined ? { credentials } : {}),
      ...(cluster !== undefined ? { cluster } : {}),
    });
    return { sidecarContainerId, sidecarIp };
  } catch (err) {
    await destroyNetworkOnly(networkName);
    throw err;
  }
}

/**
 * `docker run` the metadata-endpoints sidecar as `<networkName>-metadata` at
 * `sidecarIp`. Credentials reach it through docker's value-from-process-env
 * form, never argv. Throws `DockerRunnerError` on failure; the caller owns
 * any network cleanup.
 */
async function startSidecar(args: {
  networkName: string;
  sidecarIp: string;
  credentials?: CreateTaskNetworkOptions['credentials'];
  cluster?: string;
}): Promise<string> {
  const logger = getLogger().child('ecs-network');
  const { networkName, sidecarIp, credentials, cluster } = args;
  const sidecarArgs: string[] = [
    'run',
    '-d',
    '--rm',
    '--name',
    `${networkName}-metadata`,
    '--network',
    networkName,
    '--ip',
    sidecarIp,
  ];
  const sidecarEnv: Record<string, string> = {};
  if (credentials) {
    sidecarEnv['AWS_ACCESS_KEY_ID'] = credentials.accessKeyId;
    sidecarEnv['AWS_SECRET_ACCESS_KEY'] = credentials.secretAccessKey;
    if (credentials.sessionToken) {
      sidecarEnv['AWS_SESSION_TOKEN'] = credentials.sessionToken;
    }
  }
  if (cluster) sidecarEnv['CLUSTER'] = cluster;
  // AWS credentials served by the metadata sidecar route through docker's
  // value-from-process-env form (`-e KEY`) so they never appear in argv;
  // CLUSTER (non-secret) keeps the inline `-e KEY=VALUE` form.
  // `SENSITIVE_ENV_KEYS` is disjoint from the docker-client denylist (fenced
  // in `docker-cmd-client-env.test.ts`), so `collisions` is empty today; it is
  // still consumed so a future addition to either set cannot drop a
  // credential silently (#772).
  const { passthrough: sidecarPassthroughEnv, collisions: sidecarCollisions } = appendEnvFlags(
    sidecarArgs,
    sidecarEnv,
    SENSITIVE_ENV_KEYS
  );
  if (sidecarCollisions.length > 0) {
    logger.warn(describeRefusedSensitiveEnvKeys('Metadata sidecar', sidecarCollisions));
  }
  sidecarArgs.push(METADATA_ENDPOINT_IMAGE);
  // Under finch's Lima VM these credential values reach the limactl argv (#749).
  warnFinchArgvExposure(Object.keys(sidecarPassthroughEnv));

  logger.info(`Starting ECS local-container-endpoints sidecar at ${sidecarIp}...`);
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), sidecarArgs, {
      maxBuffer: 10 * 1024 * 1024,
      ...execEnvForSecrets(sidecarPassthroughEnv),
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new DockerRunnerError(
      `Failed to start metadata-endpoints sidecar: ${displayToolOutput(e.stderr?.trim() || describeExitWithoutArgv(err))}`
    );
  }
}

/**
 * Create the per-task docker network + start the metadata-endpoints
 * sidecar. The sidecar must come up at the well-known address BEFORE any
 * user container starts so the `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
 * lookup at container start doesn't race.
 */
export async function createTaskNetwork(
  options: CreateTaskNetworkOptions = {}
): Promise<TaskNetwork> {
  const prefix = options.prefix ?? getEmbedConfig().resourceNamePrefix;
  const suffix = randomBytes(4).toString('hex');
  const networkName = `${prefix}-task-${suffix}`;
  // No octet: pinned to the AWS-documented 169.254.170.0/24, because SDKs
  // resolve `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` against the fixed host
  // 169.254.170.2 — the shape a task role needs. An explicit octet is a
  // preference: the sidecar IP is returned, so the create may walk on to a
  // free /24 (issues #849 / #850).
  const { sidecarContainerId, sidecarIp } = await createNetworkAndSidecar({
    networkName,
    subnetOctets:
      options.subnetOctet === undefined
        ? [TASK_ROLE_SUBNET_OCTET]
        : fallbackSubnetOctets(options.subnetOctet),
    skipPull: options.skipPull ?? false,
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    ...(options.cluster !== undefined ? { cluster: options.cluster } : {}),
  });
  return { networkName, sidecarContainerId, sidecarIp };
}

/**
 * Build the env var entries every user container needs so its AWS SDK
 * picks up the sidecar. `<container-id>` is replaced by the actual docker
 * id post-`run` — at this point we use the container name as a stable
 * proxy since the metadata endpoint accepts a name lookup.
 *
 * `roleArn` is the optional task role ARN. When set, the container gets
 * `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/creds`, the sidecar route that
 * serves the assumed role's credentials it was started with (issue #853).
 * SDKs resolve that path against the fixed `169.254.170.2`, so the caller
 * must have put the network on {@link TASK_ROLE_SUBNET_OCTET}; a role with
 * any other `sidecarIp` throws rather than hand out a URI nothing answers.
 * When unset, the variable is omitted (containers fall back to whichever
 * credentials AWS SDK chains find).
 */
export function buildMetadataEnv(opts: {
  containerName: string;
  roleArn?: string;
  region?: string;
  /**
   * Sidecar IP for this task's network. Defaults to the AWS-documented
   * `169.254.170.2` so `cdkl run-task` keeps the canonical shape.
   * `cdkl start-service` passes the per-replica IP allocated by
   * `buildEndpointSubnet(subnetOctet)` so each replica's containers
   * resolve their own sidecar (not a sibling replica's).
   */
  sidecarIp?: string;
}): Record<string, string> {
  const ip = opts.sidecarIp ?? METADATA_ENDPOINT_IP;
  const env: Record<string, string> = {
    ECS_CONTAINER_METADATA_URI_V4: `http://${ip}/v4/${opts.containerName}`,
    ECS_CONTAINER_METADATA_URI: `http://${ip}/v3/${opts.containerName}`,
  };
  if (opts.roleArn) {
    if (ip !== METADATA_ENDPOINT_IP) {
      throw new DockerRunnerError(
        `A task role needs the metadata sidecar at ${METADATA_ENDPOINT_IP} (SDKs read task-role ` +
          `credentials only from there), but this task's network put it at ${ip}.`
      );
    }
    env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] = TASK_ROLE_CREDENTIALS_PATH;
  }
  if (opts.region) env['AWS_REGION'] = opts.region;
  return env;
}

/**
 * Make the shared `start-service` / `start-alb` sidecar serve one task
 * role's credentials (issue #854). The sidecar takes credentials only as
 * env at start, so the first call replaces it — same name, same IP — with
 * one started with `credentials`, and records the role on `net`. A repeat
 * call for the same role keeps the running sidecar (the credentials were
 * assumed once, at startup). A different role is refused: one sidecar at
 * `169.254.170.2` holds one credential set, and handing it the caller's
 * own credentials so it could assume each role itself would expose those
 * credentials to every container at its `/creds` route.
 *
 * `net` must sit on {@link TASK_ROLE_SUBNET_OCTET}
 * (`createSharedSvcNetwork({ taskRole: true })`). Mutates `net` in place,
 * so the caller's teardown removes the replacement sidecar.
 */
export async function serveTaskRoleFromSharedSidecar(
  net: TaskNetwork,
  args: {
    roleArn: string;
    credentials: NonNullable<CreateTaskNetworkOptions['credentials']>;
    cluster?: string;
  }
): Promise<void> {
  if (net.taskRoleArn === args.roleArn) return;
  if (net.taskRoleArn !== undefined) {
    throw new DockerRunnerError(
      `This run's services resolve to different task roles (${displayToolOutput(net.taskRoleArn)} ` +
        `and ${displayToolOutput(args.roleArn)}; on a --watch reload, the task role changed ` +
        `since startup), but the shared metadata sidecar at ` +
        `${METADATA_ENDPOINT_IP} can serve only one. Pass one role for every service with ` +
        '`--assume-role <arn>`, start the services in separate runs one at a time, or restart ' +
        'the run after changing the role.'
    );
  }
  if (net.sidecarIp !== METADATA_ENDPOINT_IP) {
    throw new DockerRunnerError(
      `A task role needs the metadata sidecar at ${METADATA_ENDPOINT_IP}, but network ` +
        `${net.networkName} put it at ${net.sidecarIp}.`
    );
  }
  getLogger()
    .child('ecs-network')
    .info(
      `Restarting the metadata sidecar to serve task role ${displayToolOutput(args.roleArn)}...`
    );
  await removeContainer(net.sidecarContainerId);
  net.sidecarContainerId = await startSidecar({
    networkName: net.networkName,
    sidecarIp: net.sidecarIp,
    credentials: args.credentials,
    ...(args.cluster !== undefined ? { cluster: args.cluster } : {}),
  });
  net.taskRoleArn = args.roleArn;
}

/**
 * Best-effort: the name of the docker network whose IPAM config holds
 * `cidr`, for a conflict message. `undefined` when docker cannot be asked
 * or no network matches.
 */
async function findNetworkHoldingSubnet(cidr: string): Promise<string | undefined> {
  try {
    const { stdout: ls } = await execFileAsync(getDockerCmd(), [
      'network',
      'ls',
      '--format',
      '{{.Name}}',
    ]);
    const names = ls
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (names.length === 0) return undefined;
    const { stdout } = await execFileAsync(getDockerCmd(), [
      'network',
      'inspect',
      '--format',
      '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}',
      ...names,
    ]);
    for (const line of stdout.split('\n')) {
      const [name, ...subnets] = line.trim().split(/\s+/);
      if (name && subnets.includes(cidr)) return name;
    }
  } catch {
    // A conflict message without the holder's name is still correct.
  }
  return undefined;
}

/**
 * Hint for a PINNED subnet that another network holds. Only a task-role run
 * pins (to `169.254.170.0/24`), so the hint explains why it cannot move.
 */
function pinnedSubnetConflictHint(cidr: string, holder: string | undefined): string {
  const { productName, cliName } = getEmbedConfig();
  const who =
    holder !== undefined
      ? `docker network ${displayToolOutput(holder)} already holds ${cidr}`
      : `another network already holds ${cidr}`;
  const remove =
    holder !== undefined
      ? `\`docker network rm ${displayToolOutput(holder)}\``
      : '`docker network ls` + `docker network rm`';
  return (
    `Hint: ${who}. A task role needs that subnet: AWS SDKs read task-role credentials only ` +
    `from the metadata sidecar at ${METADATA_ENDPOINT_IP}, so a ${productName} run with a task ` +
    `role (\`${cliName} run-task\` / \`start-service\` / \`start-alb\` with \`--assume-role\`) ` +
    `cannot move to another subnet, and only one can be active per host. Stop the run that ` +
    `owns it, or remove a leftover network with ${remove}, then retry.`
  );
}

/**
 * Tear down the metadata-endpoints sidecar + the docker network. Idempotent
 * — `docker rm -f` and `docker network rm` both swallow not-found errors
 * by design, and the function logs at debug instead of throwing.
 */
export async function destroyTaskNetwork(net: TaskNetwork | undefined): Promise<void> {
  if (!net) return;
  await removeContainer(net.sidecarContainerId);
  await destroyNetworkOnly(net.networkName);
}

async function destroyNetworkOnly(networkName: string): Promise<void> {
  if (!networkName) return;
  const logger = getLogger().child('ecs-network');
  try {
    await execFileAsync(getDockerCmd(), ['network', 'rm', networkName]);
    logger.debug(`Removed docker network ${networkName}`);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    logger.debug(
      `docker network rm ${networkName} failed: ${displayToolOutput(e.stderr || e.message || String(err))}`
    );
  }
}
