import { execFile } from 'child_process';
import { basename, dirname } from 'path';
import { promisify } from 'util';
import { buildDockerImage } from '../assets/docker-build.js';
import { getDockerCmd } from '../utils/docker-cmd.js';
import { CdkLocalError, LocalInvokeBuildError } from '../utils/error-handler.js';
import { displayToolOutput } from '../utils/ident-display.js';
import { getLogger } from '../utils/logger.js';
import { getEmbedConfig } from './embed-config.js';
import { removeContainer } from './docker-runner.js';
import { probeHttp } from './web-function-runner.js';
import {
  callRuntimeHook,
  defaultHookDeps,
  pollBuildHook,
  runHookBody,
  waitForAppAnswer,
  type HookEndpoint,
  type MicrovmHookDeps,
} from './microvm-hooks.js';
import {
  MICROVM_DEFAULT_INGRESS_PORT,
  type MicrovmCodeArtifact,
  type MicrovmImageConfig,
  type MicrovmRuntimeHook,
} from './microvm-image.js';
import {
  MicrovmStateError,
  type MicrovmProxyTarget,
  type MicrovmState,
} from './microvm-front-door.js';

const execFileAsync = promisify(execFile);

/** The default deadline of the `/terminate` hook when `TerminateTimeoutInSeconds` is unset. */
export const DEFAULT_TERMINATE_HOOK_TIMEOUT_MS = 10_000;

/** The deterministic local tag of a MicroVM image, keyed by its code asset's hash. */
export function microvmImageTag(artifact: MicrovmCodeArtifact): string {
  return `${getEmbedConfig().resourceNamePrefix}-microvm-${artifact.assetHash.slice(0, 16).toLowerCase()}`;
}

/**
 * `docker build` the code artifact's root `Dockerfile` for `platform` — the
 * step Lambda runs on its managed base image — through the same builder every
 * asset build goes through. The artifact's directory is its own build context.
 */
export async function buildMicrovmImage(opts: {
  artifact: MicrovmCodeArtifact;
  platform: string | undefined;
  /** `--no-build-cache`: build with `--no-cache`. */
  noCache: boolean;
}): Promise<string> {
  const tag = microvmImageTag(opts.artifact);
  const parent = dirname(opts.artifact.contextDir);
  getLogger().info(
    `Building MicroVM image ${tag}${opts.platform ? ` (platform=${opts.platform})` : ''}...`
  );
  await buildDockerImage(
    {
      source: {
        directory: basename(opts.artifact.contextDir),
        ...(opts.noCache && { cacheDisabled: true }),
      },
    },
    parent,
    {
      tag,
      ...(opts.platform !== undefined && { platform: opts.platform }),
      assetOutdir: parent,
      progressLabel: 'Building MicroVM image',
      wrapError: (stderr) =>
        new LocalInvokeBuildError(
          `docker build failed for the MicroVM image's Dockerfile: ${stderr}`
        ),
    }
  );
  return tag;
}

/** The container ports an image `EXPOSE`s (`docker image inspect`). Empty when it cannot be read. */
export async function readExposedPorts(image: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), [
      'image',
      'inspect',
      '-f',
      '{{json .Config.ExposedPorts}}',
      image,
    ]);
    const parsed = JSON.parse(stdout.trim() || 'null') as Record<string, unknown> | null;
    if (!parsed) return [];
    return Object.keys(parsed)
      .filter((k) => k.endsWith('/tcp') || !k.includes('/'))
      .map((k) => Number(k.split('/')[0]))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  } catch {
    return [];
  }
}

/**
 * The container ports a MicroVM's container publishes: 8080 (the default
 * ingress) first, then `Hooks.Port`, the image's `EXPOSE` ports and every
 * `--proxy-port`, de-duplicated. The front door can route only to these.
 */
export function planMicrovmPorts(
  hooksPort: number | undefined,
  exposed: readonly number[],
  extra: readonly number[]
): number[] {
  const out = [MICROVM_DEFAULT_INGRESS_PORT];
  for (const p of [...(hooksPort !== undefined ? [hooksPort] : []), ...exposed, ...extra]) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** `docker pause` / `docker unpause`. */
export async function setContainerPaused(containerId: string, paused: boolean): Promise<void> {
  try {
    await execFileAsync(getDockerCmd(), [paused ? 'pause' : 'unpause', containerId]);
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new CdkLocalError(
      `docker ${paused ? 'pause' : 'unpause'} failed: ${displayToolOutput(err.stderr?.trim() || err.message || String(error))}`,
      'LOCAL_START_MICROVM_PAUSE_FAILED'
    );
  }
}

/** Seams for {@link LocalMicrovm}, injectable in unit tests. */
export interface LocalMicrovmDeps {
  setPaused: (containerId: string, paused: boolean) => Promise<void>;
  remove: (containerId: string) => Promise<void>;
  hooks?: MicrovmHookDeps;
  waitForAnswer?: typeof waitForAppAnswer;
  isAlive?: () => Promise<boolean>;
}

/** Options for {@link LocalMicrovm}. */
export interface LocalMicrovmOptions {
  microvmId: string;
  containerId: string;
  /** Container port -> the host endpoint it is published on. */
  ports: ReadonlyMap<number, HookEndpoint>;
  config: MicrovmImageConfig;
  /** `--timeout`: the default deadline of every hook without its own `TimeoutInSeconds`. */
  timeoutMs: number;
  /** Called once the MicroVM reached `terminated` (its container is removed). */
  onTerminated?: (vm: LocalMicrovm) => void;
}

const defaultDeps: LocalMicrovmDeps = { setPaused: setContainerPaused, remove: removeContainer };

/**
 * One local MicroVM: a container plus the lifecycle the service drives on it.
 * `boot()` runs the image-build hooks (`/ready`, then `/validate` — on the SAME
 * container, there being no snapshot to start a fresh one from) and `/run`;
 * the control actions run `/suspend` + `docker pause`, `docker unpause` +
 * `/resume`, and `/terminate` + container removal. A hook that is not
 * `ENABLED` is skipped, as in the cloud.
 */
export class LocalMicrovm implements MicrovmProxyTarget {
  readonly microvmId: string;
  readonly containerId: string;
  private current: MicrovmState | 'booting' = 'booting';
  private resuming: Promise<void> | undefined;
  private terminating: Promise<void> | undefined;
  private readonly opts: LocalMicrovmOptions;
  private readonly deps: LocalMicrovmDeps;

  constructor(opts: LocalMicrovmOptions, deps: Partial<LocalMicrovmDeps> = {}) {
    this.opts = opts;
    this.deps = { ...defaultDeps, ...deps };
    this.microvmId = opts.microvmId;
    this.containerId = opts.containerId;
  }

  state(): MicrovmState {
    // Not yet RUNNING reads as `resuming` to the front door, which is not started then anyway.
    return this.current === 'booting' ? 'resuming' : this.current;
  }

  upstreamFor(containerPort: number): HookEndpoint | undefined {
    return this.opts.ports.get(containerPort);
  }

  routablePorts(): number[] {
    return [...this.opts.ports.keys()];
  }

  private log(message: string): void {
    getLogger().info(`MicroVM ${this.microvmId}: ${message}`);
  }

  private hookEndpoint(): HookEndpoint {
    const port = this.opts.config.hooksPort;
    const endpoint = port !== undefined ? this.opts.ports.get(port) : undefined;
    if (!endpoint) {
      throw new CdkLocalError(
        'The hooks port is not published.',
        'LOCAL_START_MICROVM_HOOK_FAILED'
      );
    }
    return endpoint;
  }

  private hookTimeoutMs(hook: keyof MicrovmImageConfig['hooks']): number {
    const seconds = this.opts.config.hooks[hook]?.timeoutSeconds;
    if (seconds !== undefined) return seconds * 1000;
    return hook === 'terminate' ? DEFAULT_TERMINATE_HOOK_TIMEOUT_MS : this.opts.timeoutMs;
  }

  /** The hook seams, with the container liveness check when one is wired. */
  private hookDeps(): MicrovmHookDeps {
    return {
      ...(this.deps.hooks ?? defaultHookDeps),
      ...(this.deps.isAlive && { isAlive: this.deps.isAlive }),
    };
  }

  private async runtimeHook(hook: MicrovmRuntimeHook, body?: string): Promise<boolean> {
    if (!this.opts.config.hooks[hook]) return false;
    await callRuntimeHook(
      hook,
      this.hookEndpoint(),
      this.hookTimeoutMs(hook),
      body,
      this.hookDeps()
    );
    this.log(`/${hook} hook answered 200`);
    return true;
  }

  /**
   * Bring the MicroVM to RUNNING: `/ready` (503 retried; without it, wait for
   * the app to answer HTTP), `/validate` (503 retried), then `/run` with the
   * `{ microvmId, runHookPayload }` body. Throws on the first failure; the
   * caller removes the container.
   */
  async boot(runHookPayload: string | undefined): Promise<void> {
    const { hooks } = this.opts.config;
    const deps = this.hookDeps();
    if (hooks.ready) {
      const attempts = await pollBuildHook(
        'ready',
        this.hookEndpoint(),
        this.hookTimeoutMs('ready'),
        deps
      );
      this.log(`/ready hook answered 200 after ${attempts} attempt(s)`);
    } else {
      const port = this.opts.config.hooksPort ?? MICROVM_DEFAULT_INGRESS_PORT;
      const endpoint = this.opts.ports.get(port)!;
      const wait = this.deps.waitForAnswer ?? waitForAppAnswer;
      await wait(endpoint, this.opts.timeoutMs, {
        probe: probeHttp,
        sleep: deps.sleep,
        now: deps.now,
        ...(this.deps.isAlive && { isAlive: this.deps.isAlive }),
      });
      this.log('application answered HTTP (no /ready hook)');
    }
    if (hooks.validate) {
      const attempts = await pollBuildHook(
        'validate',
        this.hookEndpoint(),
        this.hookTimeoutMs('validate'),
        deps
      );
      this.log(`/validate hook answered 200 after ${attempts} attempt(s)`);
    }
    await this.runtimeHook('run', runHookBody(this.microvmId, runHookPayload));
    this.current = 'running';
  }

  async suspend(): Promise<void> {
    if (this.current !== 'running') {
      throw new MicrovmStateError(
        `MicroVM ${this.microvmId} is ${this.state()}; only a running MicroVM can be suspended.`
      );
    }
    this.current = 'suspending';
    try {
      await this.runtimeHook('suspend');
      await this.deps.setPaused(this.containerId, true);
    } catch (err) {
      this.current = 'running';
      throw err;
    }
    this.current = 'suspended';
    this.log('suspended (container paused)');
  }

  /** Resume a suspended MicroVM. Concurrent callers (auto-resumed requests) share one resume. */
  resume(): Promise<void> {
    if (this.current === 'resuming' && this.resuming) return this.resuming;
    if (this.current !== 'suspended') {
      return Promise.reject(
        new MicrovmStateError(
          `MicroVM ${this.microvmId} is ${this.state()}; only a suspended MicroVM can be resumed.`
        )
      );
    }
    this.current = 'resuming';
    this.resuming = (async () => {
      try {
        await this.deps.setPaused(this.containerId, false);
        try {
          await this.runtimeHook('resume');
        } catch (err) {
          // The /resume hook failed: back to SUSPENDED, as the cloud keeps it there.
          await this.deps.setPaused(this.containerId, true).catch(() => undefined);
          throw err;
        }
      } catch (err) {
        this.current = 'suspended';
        throw err;
      } finally {
        this.resuming = undefined;
      }
      this.current = 'running';
      this.log('resumed');
    })();
    return this.resuming;
  }

  /**
   * Terminate: `/terminate` (a failure or timeout is reported, not fatal —
   * the container is removed either way), then remove the container.
   * Idempotent: every caller awaits the same termination.
   */
  terminate(): Promise<void> {
    this.terminating ??= (async () => {
      const was = this.current;
      this.current = 'terminating';
      try {
        if (was === 'suspended' || was === 'suspending') {
          await this.deps.setPaused(this.containerId, false).catch(() => undefined);
        }
        if (was !== 'booting') await this.runtimeHook('terminate');
      } catch (err) {
        getLogger().warn(
          `MicroVM ${this.microvmId}: ${err instanceof Error ? err.message : String(err)} Removing its container anyway.`
        );
      }
      await this.deps.remove(this.containerId);
      this.current = 'terminated';
      this.log('terminated (container removed)');
      this.opts.onTerminated?.(this);
    })();
    return this.terminating;
  }
}
