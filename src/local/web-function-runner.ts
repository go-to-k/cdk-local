import { request } from 'http';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { getDockerCmd } from '../utils/docker-cmd.js';
import { CdkLocalError } from '../utils/error-handler.js';
import { displayToolOutput } from '../utils/ident-display.js';
import { formatAuthority } from '../utils/url-authority.js';
import { runDetached } from './docker-runner.js';
import type { WebFunctionArtifact } from './web-function-artifact.js';
import type { WebFunctionRuntimeSpec } from './web-function-runtime.js';

const execFileAsync = promisify(execFile);

/** The port the server listens on INSIDE the container (`AWS_LAMBDA_HTTP_ENDPOINT`). */
export const WEB_FUNCTION_CONTAINER_PORT = 8080;

/** How many trailing container output lines a failure quotes. */
export const READY_FAILURE_LOG_LINES = 20;

/** The longest one readiness probe waits for a response. */
export const MAX_PROBE_TIMEOUT_MS = 10_000;

/**
 * What one artifact kind needs from the container, decided in ONE place so the
 * command never inspects an artifact: the image, the mounts and the start
 * command. `label` names what is started, for logs and errors.
 */
export interface WebFunctionContainerPlan {
  image: string;
  mounts: { hostPath: string; containerPath: string; readOnly: boolean }[];
  entryPoint: string[];
  cmd: string[];
  workingDir: string | undefined;
  label: string;
}

/**
 * Seam 1's per-kind arm. A zip bundle is bind-mounted READ-ONLY at the runtime
 * row's code path and started with the row's own start command (seam 2). The
 * reserved image kind is refused. `env` is the final container env — a row may
 * read its entrypoint variable from it.
 */
export function planWebFunctionContainer(
  artifact: WebFunctionArtifact,
  spec: WebFunctionRuntimeSpec,
  env: Readonly<Record<string, string>>,
  deps?: { fileExists?: (path: string) => boolean }
): WebFunctionContainerPlan {
  if (artifact.kind !== 'zip') {
    throw new CdkLocalError(
      `A container-image web function source is not supported yet; only a zip bundle from ` +
        `CodeConfig.S3Object runs locally.`,
      'LOCAL_START_WEB_FUNCTION_UNSUPPORTED_ARTIFACT'
    );
  }
  const start = spec.buildStart(env, artifact.codeDir, deps);
  return {
    image: spec.baseImage,
    mounts: [{ hostPath: artifact.codeDir, containerPath: spec.codeMountPath, readOnly: true }],
    entryPoint: start.entryPoint,
    cmd: start.cmd,
    workingDir: spec.codeMountPath,
    label: start.label,
  };
}

/** Options for {@link startWebFunctionContainer}. */
export interface StartWebFunctionContainerOptions {
  plan: WebFunctionContainerPlan;
  env: Record<string, string>;
  sensitiveEnvKeys: ReadonlySet<string>;
  /** Host address the port is published on. */
  host: string;
  hostPort: number;
  /** `--platform`. */
  platform: string;
  /** `cdkl-`-prefixed container name, so the orphan sweep finds it. */
  name: string;
}

/**
 * Boot the web function's server container, shared by every artifact kind: the
 * port published straight to the server (no host proxy — a plain HTTP server
 * already takes the runtime's concurrent requests), the env, and the
 * `--platform`. WITHOUT `--rm`: a server that crashes at boot keeps its logs
 * for the readiness error, so the caller MUST `removeContainer` in teardown.
 * Returns the container id.
 */
export async function startWebFunctionContainer(
  opts: StartWebFunctionContainerOptions
): Promise<string> {
  const { plan } = opts;
  return runDetached({
    image: plan.image,
    mounts: plan.mounts,
    env: opts.env,
    ...(opts.sensitiveEnvKeys.size > 0 && { sensitiveEnvKeys: opts.sensitiveEnvKeys }),
    entryPoint: plan.entryPoint,
    cmd: plan.cmd,
    ...(plan.workingDir !== undefined && { workingDir: plan.workingDir }),
    hostPort: opts.hostPort,
    containerPort: WEB_FUNCTION_CONTAINER_PORT,
    host: opts.host,
    platform: opts.platform,
    name: opts.name,
    autoRemove: false,
  });
}

/** A bounded ring of the most recent output lines of a container. */
export class RecentOutput {
  private lines: string[] = [];
  private partial = '';
  private readonly max: number;
  constructor(max: number = READY_FAILURE_LOG_LINES) {
    this.max = max;
  }

  push(chunk: Buffer | string): void {
    const text = this.partial + chunk.toString();
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.add(line);
    // Never hold an unterminated line without bound.
    if (this.partial.length > 4096) {
      this.add(this.partial);
      this.partial = '';
    }
  }

  /** The held lines, the unterminated tail last. */
  tail(): string[] {
    return this.partial.length > 0 ? [...this.lines, this.partial].slice(-this.max) : this.lines;
  }

  private add(line: string): void {
    this.lines.push(line.replace(/\r$/, ''));
    if (this.lines.length > this.max) this.lines.shift();
  }
}

/** One readiness probe's result. */
export type ProbeOutcome =
  /** Any HTTP response arrived. */
  | 'answered'
  /** Refused or reset — nothing is listening (yet). */
  | 'refused'
  /** The connection stayed open but no response arrived within the probe's timeout. */
  | 'timeout';

/** Seams for {@link waitForWebFunctionReady}, injectable in unit tests. */
export interface WebFunctionReadyDeps {
  probe: (host: string, port: number, timeoutMs: number) => Promise<ProbeOutcome>;
  /** Whether the container is still running. */
  isRunning: (containerId: string) => Promise<boolean>;
  /** The container's last log lines, read from Docker (the container still exists). */
  fetchLogs: (containerId: string, lines: number) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Wait until the server answers an HTTP request on the published port, or fail
 * with the container's last output lines.
 *
 * Readiness is an HTTP response, NOT a TCP accept: Docker's port forwarder
 * accepts the connection on the host before anything listens in the container,
 * so a connect alone reports ready too early. The probe is one `GET /` that any
 * status satisfies, allowed `min(remaining, 10s)` to answer, so an app whose
 * `/` is slow still comes up. A container that exits first fails fast.
 */
export async function waitForWebFunctionReady(
  args: {
    containerId: string;
    host: string;
    port: number;
    timeoutMs: number;
    recent: RecentOutput;
    label: string;
  },
  deps: WebFunctionReadyDeps = defaultReadyDeps
): Promise<void> {
  const deadline = deps.now() + args.timeoutMs;
  let attempt = 0;
  let last: ProbeOutcome = 'refused';
  while (deps.now() < deadline) {
    const remaining = Math.max(1, deadline - deps.now());
    last = await deps.probe(args.host, args.port, Math.min(remaining, MAX_PROBE_TIMEOUT_MS));
    if (last === 'answered') return;
    attempt++;
    if (attempt % 4 === 0 && !(await deps.isRunning(args.containerId))) {
      throw await containerFailure(
        `The web function container exited before its server listened on ` +
          `AWS_LAMBDA_HTTP_ENDPOINT (started ${args.label}).`,
        args.containerId,
        args.recent,
        deps.fetchLogs
      );
    }
    if (last === 'refused') await deps.sleep(250);
  }
  const authority = formatAuthority(args.host, args.port);
  throw await containerFailure(
    last === 'timeout'
      ? `The web function server on ${authority} accepted the connection but did not answer ` +
          `GET / within ${args.timeoutMs}ms — it is listening but slow to respond. Raise ` +
          `--timeout, or make / answer sooner (started ${args.label}).`
      : `The web function server never accepted an HTTP connection on ${authority} within ` +
          `${args.timeoutMs}ms. It must listen on the host:port given in ` +
          `AWS_LAMBDA_HTTP_ENDPOINT (started ${args.label}).`,
    args.containerId,
    args.recent,
    deps.fetchLogs
  );
}

/**
 * A container failure with its last output lines: read from Docker when it can
 * (the container is not `--rm`, so a boot crash keeps its stack trace), else
 * what the log stream relayed. Exported for the command's post-ready exit path.
 */
export async function containerFailure(
  message: string,
  containerId: string,
  recent: RecentOutput,
  fetchLogs: WebFunctionReadyDeps['fetchLogs'] = readContainerLogTail
): Promise<CdkLocalError> {
  let lines: string[] = [];
  try {
    lines = await fetchLogs(containerId, READY_FAILURE_LOG_LINES);
  } catch {
    lines = [];
  }
  if (lines.length === 0) lines = recent.tail();
  const detail =
    lines.length > 0
      ? ` Last ${lines.length} line(s) of container output:\n${lines
          .map((l) => `  ${displayToolOutput(l)}`)
          .join('\n')}`
      : ' The container printed nothing.';
  return new CdkLocalError(`${message}${detail}`, 'LOCAL_START_WEB_FUNCTION_NOT_READY');
}

/**
 * Follow a container until it exits (`docker wait`). `exited` resolves with
 * the exit code (`undefined` when it could not be read); `stop()` ends the
 * watch WITHOUT resolving, for a teardown that removes the container itself.
 * The child also keeps the event loop alive while the server runs.
 */
export function watchContainerExit(containerId: string): {
  exited: Promise<number | undefined>;
  stop: () => void;
} {
  let stopped = false;
  const proc = spawn(getDockerCmd(), ['wait', containerId], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  proc.stdout?.on('data', (c: Buffer) => (out += c.toString()));
  const exited = new Promise<number | undefined>((resolveExit) => {
    const done = (): void => {
      if (stopped) return;
      const code = Number.parseInt(out.trim(), 10);
      resolveExit(Number.isNaN(code) ? undefined : code);
    };
    proc.on('close', done);
    proc.on('error', done);
  });
  return {
    exited,
    stop: () => {
      stopped = true;
      if (!proc.killed) proc.kill('SIGTERM');
    },
  };
}

/** One `GET /` against the published port; any HTTP status counts. */
function probeHttp(host: string, port: number, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolveProbe) => {
    let timedOut = false;
    const req = request(
      {
        host,
        port,
        path: '/',
        method: 'GET',
        timeout: timeoutMs,
        headers: { connection: 'close' },
      },
      (res) => {
        res.resume();
        resolveProbe('answered');
      }
    );
    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
    });
    req.on('error', () => resolveProbe(timedOut ? 'timeout' : 'refused'));
    req.end();
  });
}

async function containerIsRunning(containerId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), [
      'inspect',
      '-f',
      '{{.State.Running}}',
      containerId,
    ]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** `docker logs --tail <n>` of a (possibly exited) container, stdout then stderr. */
export async function readContainerLogTail(containerId: string, lines: number): Promise<string[]> {
  const { stdout, stderr } = await execFileAsync(
    getDockerCmd(),
    ['logs', '--tail', String(lines), containerId],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  return `${stdout}${stderr}`
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)
    .slice(-lines);
}

const defaultReadyDeps: WebFunctionReadyDeps = {
  probe: probeHttp,
  isRunning: containerIsRunning,
  fetchLogs: readContainerLogTail,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};
