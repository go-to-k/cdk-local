import { flattenToOneLine } from './credential-error.js';
import { redactDockerArgvValues, describeExitWithoutArgv } from '../utils/docker-argv-redaction.js';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import {
  finchSecretArgvRefusal,
  getDockerCmd,
  isDockerClientEnvKey,
  isMalformedEnvKey,
  runDockerForeground,
  runDockerStreaming,
  warnFinchArgvExposure,
} from '../utils/docker-cmd.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { signalExitCode } from '../utils/shutdown-signal.js';
import { displayIdent, displayToolOutput } from '../utils/ident-display.js';
import { getLogger } from '../utils/logger.js';
import { defineOwnKey } from '../utils/own-keys.js';
import { warnIfEmulatedPlatform } from './docker-image-builder.js';
import { getEmbedConfig } from './embed-config.js';
import {
  awaitLoopbackForwarderStatus,
  buildNamespaceOwnerForwarderDockerArgs,
  describeForwarderFailure,
  ensureForwarderImage,
  newLoopbackForwarderName,
  startLoopbackForwarder,
  type LoopbackForwarderNamespace,
  type LoopbackForwarderResult,
} from './loopback-forwarder.js';
import {
  workloadGetsEmulatorKeysOnly,
  applyWorkloadAwsWiringToEnv,
  effectiveLoopbackPorts,
  loopbackForwarderPlan,
  getActiveWorkloadAwsWiring,
  resolveHostDefaultCredentials,
} from './workload-aws-wiring.js';
import type { WorkloadAwsWiring } from './workload-aws-wiring.js';

const execFileAsync = promisify(execFile);

/**
 * Wraps `docker pull` / `docker run` / `docker rm` for `cdkl invoke`.
 *
 * Mirrors the style of `src/assets/docker-asset-publisher.ts` (execFile for
 * one-shot calls, spawn for long-running ones). Kept as a separate file so
 * the command layer's wiring stays small; PR 5 (container Lambda) is
 * expected to add a second non-build call site, at which point the
 * common surface can be lifted into a shared helper.
 */

export class DockerRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerRunnerError';
    Object.setPrototypeOf(this, DockerRunnerError.prototype);
  }
}

export interface DockerRunOptions {
  /** Image to run (e.g. `public.ecr.aws/lambda/nodejs:20`). */
  image: string;
  /**
   * Bind mounts: `[hostPath, containerPath]` pairs. cdk-local uses this to
   * expose the function's local code at `/var/task` (read-only). Empty
   * for container Lambdas (PR 5) — the image already has the code at
   * `/var/task`, no host bind-mount needed.
   */
  mounts: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  /**
   * Additional bind mounts applied AFTER `mounts` (PR 6 of #224, issue
   * #232 — Lambda Layers). The split is purely organizational: it lets
   * the call site keep "the function's own code" (`mounts`) separate
   * from any extra mounts the caller wants to compose. The docker-runner
   * emits one `-v <hostPath>:<containerPath>:<ro?>` per entry, in
   * order, with NO target-path coalescing — Docker rejects duplicate
   * targets (`Error response from daemon: Duplicate mount point: ...`),
   * so the caller MUST ensure each entry's `containerPath` is unique
   * across `mounts` + `extraMounts`. For Lambda Layers specifically:
   * AWS's "last layer wins on file collision" semantic is realized by
   * the caller (`materializeLambdaLayers` in `local-invoke.ts` /
   * `local-start-api.ts`) merging every layer's asset
   * directory into ONE host tmpdir in template order, then passing a
   * single `{hostPath: <tmpdir>, containerPath: '/opt'}` entry here —
   * NOT one mount per layer.
   */
  extraMounts?: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  /** Environment variables to forward into the container. */
  env: Record<string, string>;
  /**
   * Extra env keys (beyond {@link SENSITIVE_ENV_KEYS}) whose VALUES are
   * sensitive and must be routed through docker's value-from-process-env
   * form (`-e KEY`) so they never appear on the `docker run` argv. Today
   * this carries the env keys that resolved to a decrypted `SecureString`
   * SSM parameter under `--from-cfn-stack` (issue #99). Unioned with
   * {@link SENSITIVE_ENV_KEYS} before {@link appendEnvFlags}.
   */
  sensitiveEnvKeys?: ReadonlySet<string>;
  /**
   * Container CMD. For ZIP Lambda base images this is the handler string,
   * e.g. `index.handler`. For container Lambdas (PR 5) this is the
   * `ImageConfig.Command` array — passed verbatim, may be empty when the
   * image's own CMD is sufficient.
   */
  cmd: string[];
  /** Host port to bind the container port ({@link containerPort}) to. */
  hostPort: number;
  /**
   * Container port to publish {@link hostPort} to. Defaults to `8080` (the
   * Lambda RIE port + the AgentCore HTTP contract port). `cdkl
   * invoke-agentcore` overrides it to `8000` for an MCP-protocol runtime,
   * whose container serves `POST /mcp` on `0.0.0.0:8000`.
   */
  containerPort?: number;
  /** Host to bind to (default `127.0.0.1`). */
  host?: string;
  /**
   * Optional Node.js inspector port. When set the container also publishes
   * `<port>:<port>` and the caller is expected to have set
   * `NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` in `env`.
   */
  debugPort?: number;
  /**
   * `--platform <linux/amd64|linux/arm64>`. PR 5: container Lambdas
   * declare `Architectures`, and the run-time platform must match the
   * built image. Without this an arm64 host running an x86_64 Lambda
   * hits emulation (slow) and an x86_64 host running arm64 fails with
   * `exec format error`. Omitted when undefined (the ZIP path on the
   * host's default arch is the original behavior).
   */
  platform?: string;
  /**
   * `--entrypoint <first>` for container Lambdas (PR 5,
   * `ImageConfig.EntryPoint`). When set, only the first entry is passed
   * to docker as `--entrypoint` (docker accepts a single binary there);
   * the remaining entries are pre-pended to `cmd` as positional args.
   * Most container Lambdas leave EntryPoint unset so `/lambda-entrypoint.sh`
   * stays in charge of dispatching to RIE.
   */
  entryPoint?: string[];
  /** `--workdir <dir>` for container Lambdas (PR 5, `ImageConfig.WorkingDirectory`). */
  workingDir?: string;
  /**
   * Optional `--name` for the container. `cdkl start-api` sets a
   * stable `cdkl-<logicalId>-<pid>-<rand>` name so the verify.sh
   * trap can sweep orphans (`docker ps --filter name=cdkl-`)
   * regardless of how the server exited. `cdkl invoke` leaves it
   * unset and lets docker auto-assign — short-lived containers don't
   * benefit from a stable name.
   */
  name?: string;
  /**
   * Optional `--network <name>` for the container. `cdkl run-task`
   * uses this so every container in a task lands on the same per-task
   * docker network and can reach the metadata-endpoints sidecar at
   * `169.254.170.2`. Unset → docker's default bridge network (current
   * behavior for `cdkl invoke` / `cdkl start-api`).
   */
  network?: string;
  /**
   * Optional sized tmpfs mount (issue #440 — Lambda
   * `Properties.EphemeralStorage.Size`). When set, emits
   * `--tmpfs <target>:rw,size=<sizeMb>m` so the container's `<target>`
   * (typically `/tmp`) is a memory-backed filesystem capped at
   * `sizeMb` MiB. Handlers that exceed the cap fail with `ENOSPC`
   * the way they would on AWS, and handlers that detect free space
   * via `statvfs` / `df` see the configured cap rather than the
   * host's overlay-fs.
   *
   * Unset → no `--tmpfs` flag, the container's `/tmp` is whatever
   * the base image provides (preserves the pre-#440 behavior for
   * Lambdas without `EphemeralStorage`).
   */
  tmpfs?: { target: string; sizeMb: number };
  /**
   * Extra `--add-host <host>:<ip>` mappings written into the
   * container's `/etc/hosts`. Used by `cdkl start-api`'s
   * WebSocket support (#462) to add
   * `host.docker.internal:host-gateway` so the Lambda container can
   * reach the host's `@connections` HTTP endpoint regardless of OS
   * (Docker Desktop on macOS / Windows already resolves
   * `host.docker.internal`; Linux native dockerd needs the explicit
   * `host-gateway` flag since 20.10+).
   */
  extraHosts?: { host: string; ip: string }[];
  /**
   * More `-p <host>:<hostPort>:<containerPort>` publishes after the primary
   * one. `start-microvm` publishes every port its front door may route
   * `X-aws-proxy-port` to.
   */
  extraPorts?: { hostPort: number; containerPort: number }[];
  /**
   * `false` omits `--rm`, so an exited container (and its logs) survive until
   * the caller's `removeContainer`. `start-web-function` needs that: a server
   * that crashes at boot would otherwise be gone, stack trace and all, before
   * its logs are read. Default `true`.
   */
  autoRemove?: boolean;
}

/**
 * Pull the image. No-op when `skipPull` is true.
 *
 * In verbose mode (`--verbose` / global log level `debug`), streams the
 * full `docker pull` progress to stdout so the user sees per-layer
 * downloads. In the default compact mode the call is silent (cached
 * images are the common case; a fresh pull still shows progress only
 * via `--verbose`). Errors are always surfaced: the captured stderr is
 * folded into the thrown `DockerRunnerError` message.
 */
export async function pullImage(
  image: string,
  skipPull: boolean,
  platform?: string
): Promise<void> {
  const logger = getLogger().child('docker');
  if (skipPull) {
    logger.debug(`Skipping docker pull for ${displayIdent(image)} (--no-pull)`);
    return;
  }
  // Pull the variant matching the Lambda's declared `Architectures`. Without
  // `--platform` docker picks the host's native arch, so on an arm64 host a
  // function declared `x86_64` (or vice versa) gets a mismatched base image and
  // a compiled `provided.*` `bootstrap` fails to exec ("exec format error").
  const platformArgs = platform ? ['--platform', platform] : [];
  if (getLogger().getLevel() === 'debug') {
    logger.info(
      `Pulling ${displayIdent(image)}${platform ? ` (${displayIdent(platform)})` : ''}...`
    );
    try {
      await runDockerForeground(['pull', ...platformArgs, image]);
    } catch (err) {
      const e = err as Error;
      throw new DockerRunnerError(`docker pull ${displayIdent(image)} failed: ${e.message}`);
    }
    return;
  }
  logger.debug(`Pulling ${displayIdent(image)} (silent — pass --verbose to stream progress)`);
  // Captured-mode pull: stdout/stderr collected, mirrored only when
  // --verbose is on (which the branch above already handles via
  // runDockerForeground), so streamLive: false keeps the silent
  // contract on the default compact log level. The spinner shows
  // motion during what is otherwise a multi-minute silent pull
  // against a real-world image.
  try {
    await runDockerStreaming(['pull', ...platformArgs, image], {
      streamLive: false,
      progressLabel: `Pulling ${displayIdent(image)}`,
    });
  } catch (err) {
    const e = err as {
      exitCode?: number | null;
      stderr?: string;
      stdout?: string;
      message?: string;
    };
    // Distinguish spawn-level failure (ENOENT — docker binary missing,
    // surfaces with the helpful Install-Docker / CDK_DOCKER hint from
    // `spawnStreaming`'s ENOENT branch) from non-zero exit (genuine
    // pull failure with captured stderr). The ENOENT path rejects with
    // a plain `Error` (no `exitCode` field); the non-zero-exit path
    // rejects with `SpawnError` (`exitCode` + `stderr` + `stdout`).
    if (e.exitCode === undefined || e.exitCode === null) {
      throw new DockerRunnerError(
        `docker pull ${displayIdent(image)} failed: ${displayToolOutput(e.message ?? String(err))}`
      );
    }
    const detail = e.stderr?.trim() || e.stdout?.trim() || '(no output)';
    throw new DockerRunnerError(
      `docker pull ${displayIdent(image)} exited with code ${e.exitCode}: ${displayToolOutput(detail)}`
    );
  }
}

/**
 * Run the container detached. Returns the container ID.
 *
 * The caller is responsible for:
 *   - polling `host:port` for RIE readiness,
 *   - issuing the invoke,
 *   - calling `removeContainer` from a `try`/`finally` so the container
 *     is cleaned up on any error path including SIGINT.
 */
export async function runDetached(opts: DockerRunOptions): Promise<string> {
  // The process-wide AWS wiring (endpoint forwarding, CA bundle, default-chain
  // credentials, `--aws-emulator`) applies to every workload container
  // started here; see `workload-aws-wiring.ts`.
  const wiring = getActiveWorkloadAwsWiring();
  if (!wiring) return runDetachedContainer(opts);
  const wired = await withWorkloadAwsWiring(opts, wiring);
  // On the host network `127.0.0.1` already is the host: no forwarder.
  if (
    opts.network === 'host' &&
    wiring.mixed &&
    effectiveLoopbackPorts(wired.env, wiring).includes(wiring.mixed.resignPort)
  ) {
    // The sidecar listens on the workload's own loopback; on the host network
    // that is the host's, shared by every workload of the run.
    throw new DockerRunnerError(
      'AWS Emulator mixed mode (a "real-aws" exception in --env-vars) needs the re-signing sidecar, which cannot ' +
        'run on the host network. Drop the host network for this workload, or use --aws-emulator without a ' +
        '"real-aws" exception.'
    );
  }
  const ports = opts.network === 'host' ? [] : effectiveLoopbackPorts(wired.env, wiring);
  // Pull the forwarder image BEFORE the workload starts, so the forwarder is
  // up within moments of the workload's own start.
  if (ports.length > 0) await prepareLoopbackForwarder(wiring);
  const id = await runDetachedContainer(wired);
  await attachLoopbackForwarder(id, wiring, ports);
  return id;
}

/**
 * {@link DockerRunOptions} with the wiring applied: env entries, the CA
 * mount, default-chain credentials when the env has none, and — under
 * `--aws-emulator` — no host profile-credentials mount.
 *
 * Host-side use case: a host CLI's own `docker run` assembly for a workload
 * container (pair it with {@link attachLoopbackForwarder}).
 */
export async function withWorkloadAwsWiring(
  opts: DockerRunOptions,
  wiring: WorkloadAwsWiring
): Promise<DockerRunOptions> {
  const defaults =
    wiring.mode === 'forward' && !opts.env['AWS_ACCESS_KEY_ID']
      ? await resolveHostDefaultCredentials()
      : undefined;
  const env = applyWorkloadAwsWiringToEnv(opts.env, wiring, defaults);
  // The `--profile` credentials file's in-container path (local-profile-credentials-file.ts).
  const credsPath = `${getEmbedConfig().awsBindMountPath}/credentials`;
  // Emulator keys only (`--aws-emulator` alone, or a mixed-mode container
  // keeping no exception): no host credentials file either.
  const emulatorOnly = workloadGetsEmulatorKeysOnly(opts.env, wiring);
  const extra = (opts.extraMounts ?? []).filter(
    (m) => !emulatorOnly || m.containerPath !== credsPath
  );
  const taken = new Set([...opts.mounts, ...extra].map((m) => m.containerPath));
  for (const m of wiring.mounts) {
    if (!taken.has(m.containerPath)) extra.push({ ...m, readOnly: true });
  }
  return { ...opts, env, extraMounts: extra };
}

/**
 * Pull the forwarder image ahead of a workload start. A pull failure is fatal
 * under `--aws-emulator`; otherwise it is left for {@link attachLoopbackForwarder}
 * to report as a warning.
 */
export async function prepareLoopbackForwarder(wiring: WorkloadAwsWiring): Promise<void> {
  try {
    await ensureForwarderImage(wiring.skipPull === true);
  } catch (err) {
    if (wiring.mode === 'emulator' || wiring.mixed) {
      throw new DockerRunnerError(
        `--aws-emulator: the loopback forwarder image could not be pulled: ${(err as Error).message}`
      );
    }
  }
}

const warnedForwarderPorts = new Set<string>();

function warnForwarderOnce(key: string, message: string): void {
  if (warnedForwarderPorts.has(key)) return;
  warnedForwarderPorts.add(key);
  getLogger().warn(message);
}

async function isContainerRunning(containerId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), [
      'inspect',
      '-f',
      '{{.State.Running}}',
      containerId,
    ]);
    return stdout.trim() === 'true';
  } catch (err) {
    // Only a container that no longer exists counts as not running; any other
    // inspect failure keeps the caller on its error path.
    return !/no such (object|container)/i.test((err as { stderr?: string }).stderr ?? '');
  }
}

/** Containers {@link removeOnSignalWhile} removes on a signal, with their claim counts. */
const signalGuarded = new Map<string, number>();
let signalListeners: { signal: 'SIGINT' | 'SIGTERM'; listener: () => void }[] = [];

/**
 * Run `fn` with SIGINT / SIGTERM listeners that remove `containers`
 * synchronously. The forwarder's readiness wait can take seconds, and
 * {@link runDetached} has not handed the workload's id to its caller yet, so
 * the caller's own signal cleanup cannot know it; without this, Ctrl-C there
 * leaves the workload running. A synchronous `docker rm -f` finishes before
 * any other listener's async shutdown can exit the process. When no other
 * listener exists, Node's default (exit on the signal) is kept: exit 130 / 143.
 */
async function removeOnSignalWhile<T>(
  containers: readonly string[],
  fn: () => Promise<T>
): Promise<T> {
  // One listener per signal for the whole process, shared by every attach in
  // flight (`start-api --warm` attaches several at once): each would otherwise
  // see the others and decide someone else exits.
  if (signalListeners.length === 0) {
    signalListeners = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
      const listener = (): void => {
        const names = [...signalGuarded.keys()];
        if (names.length > 0) {
          try {
            execFileSync(getDockerCmd(), ['rm', '-f', ...names], {
              stdio: 'ignore',
              timeout: 15_000,
            });
          } catch {
            // Best effort: a container already gone makes `rm -f` exit non-zero.
          }
        }
        if (process.listenerCount(signal) === 1) process.exit(signalExitCode(signal));
      };
      process.on(signal, listener);
      return { signal, listener };
    });
  }
  for (const c of containers) signalGuarded.set(c, (signalGuarded.get(c) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    for (const c of containers) {
      const n = (signalGuarded.get(c) ?? 1) - 1;
      if (n > 0) signalGuarded.set(c, n);
      else signalGuarded.delete(c);
    }
    if (signalGuarded.size === 0) {
      for (const { signal, listener } of signalListeners) process.off(signal, listener);
      signalListeners = [];
    }
  }
}

/**
 * Ports each workload's forwarder serves when they differ from the wiring's,
 * so a restart re-attaches the same set. A set equal to the wiring's (the
 * usual case, including empty for both) is not stored: the restart fallback
 * already yields it. {@link removeContainer} drops a workload's entry, so a
 * long `--watch` session that replaces containers does not accumulate them.
 */
const forwardedPortsByContainer = new Map<string, readonly number[]>();

/**
 * Start the loopback forwarder for `containerId` on `ports` (default: the
 * ports this container's forwarder served before — a restart — else the
 * wiring's). A failure is fatal under `--aws-emulator` (the container is
 * removed and the error names the fix) and a once-per-port warning otherwise.
 * A workload that already exited (a short task) is left alone.
 *
 * Host-side use case: call right after a host's own `docker run` of a
 * workload container.
 */
export async function attachLoopbackForwarder(
  containerId: string,
  wiring: WorkloadAwsWiring,
  ports: readonly number[] = forwardedPortsByContainer.get(containerId) ?? wiring.loopbackPorts
): Promise<void> {
  if (samePorts(ports, wiring.loopbackPorts)) forwardedPortsByContainer.delete(containerId);
  else forwardedPortsByContainer.set(containerId, ports);
  if (ports.length === 0) return;
  // Mixed mode: the re-signing sidecar's port is served by the sidecar, not
  // the TCP forwarder; a workload that uses it asked for the emulator, so a
  // failure is fatal as under `--aws-emulator`.
  const plan = loopbackForwarderPlan(wiring, ports);
  const fatal = forwarderFailureIsFatal(wiring, plan);
  const label = forwarderEndpointLabel(wiring);
  const forwarderName = newLoopbackForwarderName();
  let result;
  try {
    result = await removeOnSignalWhile([containerId, forwarderName], () =>
      startLoopbackForwarder({
        workloadContainer: containerId,
        ports: plan.ports,
        probe: wiring.probeHealth ? 'health' : 'tcp',
        name: forwarderName,
        ...(wiring.skipPull ? { skipPull: true } : {}),
        ...(wiring.caHostPath ? { caHostPath: wiring.caHostPath } : {}),
        ...(plan.resignConfigHostPath ? { resignConfigHostPath: plan.resignConfigHostPath } : {}),
      })
    );
  } catch (err) {
    // Joining a container that already exited fails; it needs no forwarder.
    if (!(await isContainerRunning(containerId))) return;
    const message = `${label}: ${(err as Error).message}`;
    if (fatal) {
      await removeContainer(containerId);
      throw new DockerRunnerError(message);
    }
    warnForwarderOnce('start', message);
    return;
  }
  if (result.ok) return;
  const message = describeForwarderFailure(result, label);
  if (fatal) {
    await removeContainer(containerId);
    throw new DockerRunnerError(message);
  }
  warnForwarderOnce(String(result.failedPort ?? 0), message);
}

/**
 * Start the loopback forwarder that OWNS a workload's network namespace, BEFORE
 * the workload (`buildNamespaceOwnerForwarderDockerArgs`), and wait for its
 * result. Resolves the forwarder's container id on READY: the caller then
 * starts the workload with `--network container:<name>`, so the workload's
 * first AWS call cannot race the forwarder, and removes the forwarder AFTER
 * the workload (it shares no pid namespace, so it outlives the workload).
 *
 * On any failure the forwarder is removed. Under `--aws-emulator` that throws
 * (nothing of the workload has started yet); otherwise it is the same
 * once-per-port warning as {@link attachLoopbackForwarder}, and the result is
 * `undefined`: the caller starts the workload on its own network endpoint,
 * without a forwarder. A Ctrl-C while it runs removes the forwarder.
 */
export async function startNamespaceOwnerForwarder(opts: {
  /** The forwarder container's name: the workload joins `container:<name>`. */
  name: string;
  namespace: LoopbackForwarderNamespace;
  ports: readonly number[];
  wiring: WorkloadAwsWiring;
  /** Names the workload in a failure message (e.g. `container 'app'`). */
  workloadLabel: string;
}): Promise<string | undefined> {
  const { name, wiring } = opts;
  const label = forwarderEndpointLabel(wiring);
  const plan = loopbackForwarderPlan(wiring, opts.ports);
  const fatal = forwarderFailureIsFatal(wiring, plan);
  await prepareLoopbackForwarder(wiring);
  const args = buildNamespaceOwnerForwarderDockerArgs({
    name,
    namespace: opts.namespace,
    ports: plan.ports,
    probe: wiring.probeHealth ? 'health' : 'tcp',
    ...(wiring.skipPull ? { skipPull: true } : {}),
    ...(wiring.caHostPath ? { caHostPath: wiring.caHostPath } : {}),
    ...(plan.resignConfigHostPath ? { resignConfigHostPath: plan.resignConfigHostPath } : {}),
  });
  getLogger()
    .child('docker')
    .debug(`Starting loopback forwarder ${name} for ports ${opts.ports.join(',')}`);
  const fail = async (key: string, message: string, remove = true): Promise<undefined> => {
    if (remove) await removeContainer(name);
    if (fatal) throw new DockerRunnerError(message);
    warnForwarderOnce(key, message);
    return undefined;
  };
  return removeOnSignalWhile([name], async () => {
    let id: string;
    try {
      id = (await execFileAsync(getDockerCmd(), args)).stdout.trim();
    } catch (error) {
      // The forwarder holds the workload's network aliases and published
      // ports, so a host port already in use fails HERE. A failed `run -d`
      // can still have created the container: `fail` removes it.
      const err = error as { stderr?: string };
      // A name conflict means a container this run did NOT create holds the
      // name (a `--detach` leftover, a peer run): never remove it.
      const conflict = /is already (?:in use|used) by|Conflict\. The container name/.test(
        err.stderr ?? ''
      );
      return fail(
        'start',
        `${label}: could not start the loopback forwarder for ${opts.workloadLabel} ` +
          `(it holds the ${opts.workloadLabel}'s network aliases and published ports): ` +
          displayToolOutput(err.stderr?.trim() || describeExitWithoutArgv(error)),
        !conflict
      );
    }
    let result: LoopbackForwarderResult;
    try {
      result = await awaitLoopbackForwarderStatus(name);
    } catch (err) {
      return fail('start', `${label}: ${(err as Error).message}`);
    }
    if (result.ok) return id || name;
    return fail(String(result.failedPort ?? 0), describeForwarderFailure(result, label));
  });
}

/**
 * Record the loopback ports `containerId`'s env points at when it started
 * WITHOUT a forwarder (none needed, or a failed owning forwarder outside
 * `--aws-emulator`), so a later restart's {@link attachLoopbackForwarder}
 * serves exactly those ports, none for an empty set.
 */
export function rememberForwardedPorts(
  containerId: string,
  wiring: WorkloadAwsWiring,
  ports: readonly number[]
): void {
  if (samePorts(ports, wiring.loopbackPorts)) forwardedPortsByContainer.delete(containerId);
  else forwardedPortsByContainer.set(containerId, ports);
}

function forwarderEndpointLabel(wiring: WorkloadAwsWiring): string {
  if (wiring.mode === 'emulator') return `--aws-emulator ${wiring.emulatorEndpoint?.url ?? ''}`;
  if (wiring.mixed) return `--aws-emulator ${wiring.mixed.emulatorEndpoint.url} (mixed mode)`;
  return 'The AWS endpoint override (AWS_ENDPOINT_URL*)';
}

/**
 * A forwarder failure stops the command under `--aws-emulator`, and in mixed
 * mode for a workload that uses the re-signing sidecar (it asked for the
 * emulator); otherwise it is a warning.
 */
function forwarderFailureIsFatal(
  wiring: WorkloadAwsWiring,
  plan: { resignConfigHostPath?: string }
): boolean {
  return wiring.mode === 'emulator' || plan.resignConfigHostPath !== undefined;
}

function samePorts(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((p) => b.includes(p));
}

async function runDetachedContainer(opts: DockerRunOptions): Promise<string> {
  const args: string[] = opts.autoRemove === false ? ['run', '-d'] : ['run', '-d', '--rm'];

  if (opts.name) {
    args.push('--name', opts.name);
  }
  if (opts.network) {
    args.push('--network', opts.network);
  }
  if (opts.platform) {
    args.push('--platform', opts.platform);
    // Surface CPU emulation (declared arch != host arch) before the
    // container boots — an emulated compiled custom runtime can die with
    // an opaque `exec format error` / `illegal instruction` otherwise.
    warnIfEmulatedPlatform(opts.platform, opts.name ? { label: opts.name } : {});
  }
  if (opts.extraHosts) {
    for (const entry of opts.extraHosts) {
      args.push('--add-host', `${entry.host}:${entry.ip}`);
    }
  }

  const host = opts.host ?? '127.0.0.1';
  args.push('-p', `${host}:${opts.hostPort}:${opts.containerPort ?? 8080}`);
  if (opts.debugPort !== undefined) {
    args.push('-p', `${host}:${opts.debugPort}:${opts.debugPort}`);
  }
  for (const extra of opts.extraPorts ?? []) {
    args.push('-p', `${host}:${extra.hostPort}:${extra.containerPort}`);
  }

  for (const mount of opts.mounts) {
    const ro = mount.readOnly ? ':ro' : '';
    args.push('-v', `${mount.hostPath}:${mount.containerPath}${ro}`);
  }
  // PR 6 (#232): layer mounts are emitted after the function's own
  // mounts. Order within `extraMounts` is preserved — the caller (the
  // CLI's `resolveZipImagePlan`) feeds layers in the same order they
  // appear in `Properties.Layers`, so AWS's "last layer wins on file
  // collision" semantics hold.
  if (opts.extraMounts) {
    for (const mount of opts.extraMounts) {
      const ro = mount.readOnly ? ':ro' : '';
      args.push('-v', `${mount.hostPath}:${mount.containerPath}${ro}`);
    }
  }

  // AWS credentials (and any caller-flagged sensitive keys, e.g. decrypted
  // SecureString SSM values — issue #99) route through docker's
  // value-from-process-env form (`-e KEY`, value supplied via the spawned
  // process's env below) so they never appear in `docker run`'s argv.
  // Non-sensitive env keeps the inline `-e KEY=VALUE` form.
  const sensitiveKeys =
    opts.sensitiveEnvKeys && opts.sensitiveEnvKeys.size > 0
      ? new Set<string>([...SENSITIVE_ENV_KEYS, ...opts.sensitiveEnvKeys])
      : SENSITIVE_ENV_KEYS;
  const { passthrough: passthroughEnv, collisions } = appendEnvFlags(args, opts.env, sensitiveKeys);

  // Issue #440 — Lambda EphemeralStorage.Size: emit `--tmpfs
  // <target>:rw,size=<N>m` so the container's `/tmp` is capped at the
  // templated value. Placed AFTER -e flags and BEFORE --workdir to
  // keep the order stable with the existing `-p` / `-v` / `-e`
  // mount-shaped block; downstream `--workdir` / `--entrypoint`
  // / image / cmd ordering is unchanged.
  if (opts.tmpfs) {
    args.push('--tmpfs', `${opts.tmpfs.target}:rw,size=${opts.tmpfs.sizeMb}m`);
  }

  if (opts.workingDir) {
    args.push('--workdir', opts.workingDir);
  }

  // ImageConfig.EntryPoint maps to `--entrypoint <first>` plus the rest
  // as positional args before CMD. Docker only accepts a single value
  // for `--entrypoint`; multi-arg entrypoints carry their tail through
  // the positional CMD slot. Most container Lambdas omit EntryPoint
  // entirely so `/lambda-entrypoint.sh` stays in charge of RIE dispatch.
  let entryPointTail: string[] = [];
  if (opts.entryPoint && opts.entryPoint.length > 0) {
    args.push('--entrypoint', opts.entryPoint[0]!);
    entryPointTail = opts.entryPoint.slice(1);
  }

  args.push(opts.image, ...entryPointTail, ...opts.cmd);

  const logger = getLogger().child('docker');
  // Every `-e` / `--env` / `--label` VALUE is masked, not only the AWS
  // credential keys: a literal template env value or an `--env-vars` override
  // is where a local secret sits. Flattened so a control character in a value
  // cannot draw on the terminal.
  logger.debug(
    `${getDockerCmd()} ${redactDockerArgvValues(args)
      .map((a) => displayUntrustedValue(a))
      .join(' ')}`
  );
  if (collisions.length > 0) {
    logger.warn(
      describeRefusedSensitiveEnvKeys(
        `Container for image ${displayUntrustedValue(opts.image)}`,
        collisions
      )
    );
  }

  // Under finch's Lima VM the value-less `-e KEY` flags do not keep the value
  // off argv (#749): refuse a caller-marked secret unless the operator opted
  // in, and warn about the rest (the AWS credential set).
  const forwardedKeys = Object.keys(passthroughEnv);
  const refusal = finchSecretArgvRefusal(
    forwardedKeys.filter((k) => opts.sensitiveEnvKeys?.has(k)),
    { label: 'Container for image', name: opts.image }
  );
  if (refusal !== undefined) throw new DockerRunnerError(refusal);
  warnFinchArgvExposure(forwardedKeys);

  try {
    const { stdout } = await execFileAsync(getDockerCmd(), args, {
      maxBuffer: 10 * 1024 * 1024,
      ...execEnvForSecrets(passthroughEnv),
    });
    return stdout.trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    // Not `err.message`: execFile folds the whole argv (`-e K=V` included)
    // into it, so an empty stderr would print every env value.
    throw new DockerRunnerError(
      `docker run failed: ${displayToolOutput(err.stderr?.trim() || describeExitWithoutArgv(error))}`
    );
  }
}

/**
 * The environment variable that switches {@link streamLogs} from a raw relay
 * to a line-prefixed one (issue go-to-k/cdk-local#598). `cdkl studio`'s serve
 * manager PINS it to `1` on every serve child it spawns; nothing else sets it,
 * so a plain `cdkl invoke` / `start-api` keeps its byte-exact passthrough.
 *
 * Why studio needs it: a serve child's stdout is where studio reads the ready
 * banner — and the endpoint its capture proxy forwards to — off a line
 * ANCHORED to column 0 (`studio-serve-manager`'s `readyRe`). A Lambda or
 * AgentCore container relayed raw puts its OWN lines at column 0 too, so a
 * handler printing `Server listening on http://127.0.0.1:9999` — an ordinary
 * thing for a web framework to print — was indistinguishable from
 * `start-api`'s banner. A `[<container>] ` tag in front of every relayed line
 * is the shape ECS output already arrives in (`container-log-streamer`), and
 * it cannot match an anchored pattern.
 *
 * Spelled as a literal in `studio-serve-manager` (which does not import this
 * module); `tests/unit/local/studio-serve-manager.test.ts` imports this
 * constant and asserts the serve child's spawned env against it, which fences
 * the two spellings together. `studio-dispatch` REMOVES it from its single-shot
 * children, whose stdout is the response.
 */
export const PREFIX_CONTAINER_OUTPUT_ENV = 'CDKL_PREFIX_CONTAINER_OUTPUT';

/** The longest unterminated line {@link createPrefixedLineRelay} holds before breaking it. */
export const MAX_HELD_LINE_CHARS = 64 * 1024;

/**
 * A line-buffered relay that writes every line of a byte stream to `out` with
 * `prefix` in front of it (issue go-to-k/cdk-local#598).
 *
 * The whole line is written in ONE `write` call, and a partial tail is HELD
 * until its newline arrives, so a chunk boundary can never leave a container's
 * text at the start of a line the prefix does not open — the property the
 * anchored ready patterns depend on. Lines are split on `\n` alone, exactly as
 * `studio-serve-manager`'s `streamLines` splits them; splitting on more (a bare
 * `\r`) here would not make that reader see more lines. A `StringDecoder`
 * keeps a multi-byte UTF-8 character that straddles two chunks intact.
 * Exported for unit testing.
 */
export function createPrefixedLineRelay(
  prefix: string,
  out: Pick<NodeJS.WritableStream, 'write'>
): { push: (chunk: Buffer) => void; flush: () => void } {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = (text: string): void => {
    // Only the new text can hold a newline the held tail did not.
    let nl = text.indexOf('\n');
    if (nl !== -1) nl += pending.length;
    pending += text;
    while (nl !== -1) {
      out.write(`${prefix}${pending.slice(0, nl + 1)}`);
      pending = pending.slice(nl + 1);
      nl = pending.indexOf('\n');
    }
    // A container that never ends a line (a `\r`-only progress bar) must not
    // grow the held tail without bound: break it, tag still in front.
    while (pending.length >= MAX_HELD_LINE_CHARS) {
      // Never cut between the halves of a surrogate pair.
      const high = pending.charCodeAt(MAX_HELD_LINE_CHARS - 1);
      const cut = high >= 0xd800 && high <= 0xdbff ? MAX_HELD_LINE_CHARS - 1 : MAX_HELD_LINE_CHARS;
      out.write(`${prefix}${pending.slice(0, cut)}\n`);
      pending = pending.slice(cut);
    }
  };
  return {
    push: (chunk) => emit(decoder.write(chunk)),
    flush: () => {
      emit(decoder.end());
      if (pending.length > 0) {
        out.write(`${prefix}${pending}\n`);
        pending = '';
      }
    },
  };
}

/**
 * `docker logs -f <id>` plumbed to stdout/stderr. Returns a function that
 * stops the stream (used by the caller in a `finally` block).
 *
 * Raw by default — what `cdkl invoke` prints is the container's output byte
 * for byte. Under {@link PREFIX_CONTAINER_OUTPUT_ENV} (a `cdkl studio` serve
 * child) every line is tagged `[<short container id>] ` instead; see that
 * constant for why. The short id is the one `docker ps` prints, so a tagged
 * line can be matched to its container.
 *
 * `opts.onOutput` additionally receives every raw stdout / stderr chunk, so a
 * caller can keep the container's recent output for an error message after a
 * `--rm` container is already gone (`start-web-function`'s readiness failure).
 */
export function streamLogs(
  containerId: string,
  opts: {
    onOutput?: (chunk: Buffer) => void;
    /** Tag every relayed line with this prefix (`start-microvm --count N` names each MicroVM). */
    prefix?: string;
  } = {}
): () => void {
  const proc = spawn(getDockerCmd(), ['logs', '-f', containerId], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (opts.onOutput) {
    const tap = opts.onOutput;
    proc.stdout?.on('data', (chunk: Buffer) => tap(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => tap(chunk));
  }
  let flush = (): void => undefined;
  if (opts.prefix !== undefined || process.env[PREFIX_CONTAINER_OUTPUT_ENV] === '1') {
    // Read the id as untrusted for the tag: flattened, and stripped of the
    // `]` that would close the tag early.
    const tag =
      opts.prefix ?? `[${flattenToOneLine(containerId.slice(0, 12)).replace(/[\]\s]/g, '_')}] `;
    const stdoutRelay = createPrefixedLineRelay(tag, process.stdout);
    const stderrRelay = createPrefixedLineRelay(tag, process.stderr);
    proc.stdout?.on('data', (chunk: Buffer) => stdoutRelay.push(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => stderrRelay.push(chunk));
    flush = (): void => {
      stdoutRelay.flush();
      stderrRelay.flush();
    };
    // The follow ends on its own when the container exits: release a final
    // unterminated line then rather than holding it until the caller stops.
    proc.on('close', () => flush());
  } else {
    proc.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  }
  // Swallow the exit code; this child is just plumbing.
  proc.on('error', () => {
    /* the parent flow surfaces docker errors via runDetached / removeContainer */
  });
  return () => {
    flush();
    if (!proc.killed) proc.kill('SIGTERM');
  };
}

/**
 * Best-effort `docker rm -f <id>`. Errors are swallowed (logged at debug)
 * because this typically runs from a `finally` and the parent has its own
 * error to surface.
 */
export async function removeContainer(containerId: string): Promise<void> {
  if (!containerId) return;
  // The forwarder shares the workload's namespaces and ends with it.
  forwardedPortsByContainer.delete(containerId);
  const logger = getLogger().child('docker');
  try {
    await execFileAsync(getDockerCmd(), ['rm', '-f', containerId]);
    logger.debug(`Removed container ${containerId}`);
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    logger.debug(
      `docker rm -f ${containerId} failed: ${err.stderr || err.message || String(error)}`
    );
  }
}

/**
 * Verify the docker daemon is reachable. Surfaces a friendlier error than
 * the raw `ENOENT` / "Cannot connect to the Docker daemon" the user would
 * otherwise see at the first run call. Called once up front.
 */
export async function ensureDockerAvailable(): Promise<void> {
  const cmd = getDockerCmd();
  try {
    await execFileAsync(cmd, ['version', '--format', '{{.Server.Version}}']);
  } catch (error) {
    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      throw new DockerRunnerError(
        `${cmd} is not installed or not on PATH. ${getEmbedConfig().cliName} invoke needs Docker (or a compatible CLI specified via CDK_DOCKER) — install it and retry.`
      );
    }
    throw new DockerRunnerError(
      `${cmd} daemon is not reachable: ${err.stderr?.trim() || err.message || String(error)}. ` +
        'Start Docker Desktop / the docker daemon and retry.'
    );
  }
}

/**
 * Allocate a free TCP port on `127.0.0.1`. Used to pick a host port for
 * publishing the RIE :8080 endpoint without colliding with whatever else
 * the user has running. The OS assigns a port via `port: 0` and we
 * close the probe before returning so docker can bind it next.
 *
 * There is a tiny race window between close and `docker run -p` — in
 * practice it's never been observed for local invoke; if it ever
 * surfaces, the caller can retry with a fresh port.
 */
export function pickFreePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPort(new Error('Could not allocate a host port'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Env keys whose VALUES are sensitive (AWS credentials). These are
 * routed through docker's value-from-process-env form by
 * {@link appendEnvFlags} so the value never appears in `docker run`'s
 * argv (`ps` / `/proc/<pid>/cmdline`).
 */
export const SENSITIVE_ENV_KEYS: ReadonlySet<string> = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

/**
 * Append `-e` flags for `env` to `args`, routing keys in `sensitiveKeys`
 * through docker's value-from-process-env form (`-e KEY`, with NO
 * `=value`). Docker reads the value from its OWN environment at run time,
 * so the secret never lands in `docker run`'s argv — invisible to
 * `ps aux` / `/proc/<pid>/cmdline` (other users on a shared host) and to
 * shell history. Non-sensitive keys keep the inline `-e KEY=VALUE` form
 * (fine for non-secret config, and keeps `--debug` output readable).
 *
 * Returns `passthrough`, the `{ KEY: value }` map of routed-through keys; the
 * caller MUST merge it into the spawned docker process's `env` (see
 * {@link execEnvForSecrets}) so docker can resolve each passed-through
 * key. Values still appear in `docker inspect` Config.Env — that is
 * inherent to container env and matches production behavior.
 *
 * A sensitive key whose NAME is a variable the container client (or the
 * dynamic loader / a helper it execs) reads ({@link isDockerClientEnvKey}), or
 * that is MALFORMED ({@link isMalformedEnvKey}: empty, or containing `=` /
 * NUL), gets NO flag and no passthrough entry, and is returned in
 * `collisions` so the caller can warn by NAME (issue #772). Written into the
 * client's spawn env it would hijack the client (`DOCKER_HOST` redirects the
 * daemon, `PATH` / `LD_PRELOAD` choose what code runs); and a value-less
 * `-e KEY` the spawn env refuses to set would make docker resolve it against
 * its OWN environment, handing the container the HOST's value. A key
 * containing `=` is refused because the OS parses the environ entry's name as
 * everything before the first `=`, so `PATH=/tmp/evil:` would poison `PATH`
 * while slipping past the name denylist. A NON-sensitive key is container
 * env only (`-e KEY=VALUE` on the argv) and is unaffected.
 *
 * Unlike `--env-file`, this handles multi-line values (e.g. PEM secrets)
 * and needs no temp file on disk.
 */
export function appendEnvFlags(
  args: string[],
  env: Record<string, string>,
  sensitiveKeys: ReadonlySet<string>
): { passthrough: Record<string, string>; collisions: string[] } {
  const passthrough: Record<string, string> = {};
  const collisions: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (sensitiveKeys.has(k)) {
      if (isMalformedEnvKey(k) || isDockerClientEnvKey(k)) {
        collisions.push(k);
        continue;
      }
      args.push('-e', k);
      // Own-key write so a secret named `__proto__` reaches docker's process
      // env instead of being dropped by Object.prototype's setter (#769).
      defineOwnKey(passthrough, k, v);
    } else {
      args.push('-e', `${k}=${v}`);
    }
  }
  return { passthrough, collisions };
}

/**
 * The warning for keys {@link appendEnvFlags} refused. Names each key
 * display-safe (a key is template-chosen) and never a value.
 */
export function describeRefusedSensitiveEnvKeys(subject: string, keys: readonly string[]): string {
  return (
    `${subject}: sensitive env var(s) ${keys.map(displayUntrustedValue).join(', ')} ` +
    `share a name with a variable the container client reads (docker, or the CDK_DOCKER binary) ` +
    `or have a malformed name (empty, or containing '=' / NUL), and were NOT passed to the ` +
    `container at all (a colliding name would hijack that client; a malformed name cannot form ` +
    `a valid environment variable). Rename the variable if the container needs it.`
  );
}

/**
 * Build the `env` option for an `execFile` / `spawn` call that runs a
 * `docker run` whose args include passed-through sensitive keys (from
 * {@link appendEnvFlags}). Returns `{ env }`: a copy of `process.env` with the
 * accepted passthrough keys written onto it as own keys, so docker inherits
 * the normal environment PLUS the sensitive values it must resolve. Returns
 * `{}` when no key is left to pass through (preserving the default
 * inherited-environment behavior).
 *
 * The client's own variables stay authoritative: a passthrough key that names
 * one ({@link isDockerClientEnvKey}) or is malformed ({@link isMalformedEnvKey})
 * is never written (issue #772). {@link appendEnvFlags} already keeps such a
 * key out of `passthrough`; this is defence in depth for any other caller.
 */
export function execEnvForSecrets(passthrough: Record<string, string>): {
  env?: NodeJS.ProcessEnv;
} {
  const keys = Object.keys(passthrough).filter(
    (k) => !isMalformedEnvKey(k) && !isDockerClientEnvKey(k)
  );
  if (keys.length === 0) return {};
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Own-key writes, so a secret named `__proto__` still arrives (#769).
  for (const k of keys) defineOwnKey(env as Record<string, string>, k, passthrough[k]!);
  return { env };
}

/**
 * Returns a copy of `args` with any `-e <KEY>=<value>` pair whose KEY is
 * in {@link SENSITIVE_ENV_KEYS} replaced with `-e <KEY>=***`. The actual
 * `args` passed to `spawn` are never mutated. The `docker run` debug line
 * uses the stricter `redactDockerArgvValues` (every `-e` value); this
 * narrower form is kept for callers that need only the credential keys.
 */
export function redactAwsCredentialsInArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const cur = args[i]!;
    const next = args[i + 1];
    if (cur === '-e' && typeof next === 'string') {
      const eqIdx = next.indexOf('=');
      if (eqIdx > 0) {
        const key = next.substring(0, eqIdx);
        if (SENSITIVE_ENV_KEYS.has(key)) {
          out.push('-e', `${key}=***`);
          i++;
          continue;
        }
      }
    }
    out.push(cur);
  }
  return out;
}
