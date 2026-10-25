import { request } from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDockerCmd } from '../utils/docker-cmd.js';
import { CdkLocalError } from '../utils/error-handler.js';
import { displayToolOutput } from '../utils/ident-display.js';
import { formatAuthority } from '../utils/url-authority.js';
import { runDetached } from './docker-runner.js';
import type { WebFunctionArtifact } from './web-function-artifact.js';
import type { WebFunctionRuntimeSpec, WebFunctionStartCommand } from './web-function-runtime.js';

const execFileAsync = promisify(execFile);

/** The port the server listens on INSIDE the container (`AWS_LAMBDA_HTTP_ENDPOINT`). */
export const WEB_FUNCTION_CONTAINER_PORT = 8080;

/** How many trailing container output lines a readiness failure quotes. */
export const READY_FAILURE_LOG_LINES = 20;

/** Options for {@link startWebFunctionContainer}. */
export interface StartWebFunctionContainerOptions {
  artifact: WebFunctionArtifact;
  spec: WebFunctionRuntimeSpec;
  start: WebFunctionStartCommand;
  env: Record<string, string>;
  sensitiveEnvKeys: ReadonlySet<string>;
  /** Host address the port is published on. */
  host: string;
  hostPort: number;
  /** `--platform` (`linux/arm64` by default — the cloud runtime's architecture). */
  platform: string;
  /** `cdkl-`-prefixed container name, so the orphan sweep finds it. */
  name: string;
}

/**
 * Boot the web function's server container, shared by every artifact kind: the
 * port published straight to the server (no host proxy — a plain HTTP server
 * already takes the runtime's concurrent requests), the env, and the
 * `--platform`. A zip bundle is bind-mounted READ-ONLY at the runtime's code
 * path and started with the runtime's interpreter in place of the base image's
 * event-invoke entrypoint. Returns the container id.
 */
export async function startWebFunctionContainer(
  opts: StartWebFunctionContainerOptions
): Promise<string> {
  const { artifact, spec } = opts;
  if (artifact.kind !== 'zip') {
    throw new CdkLocalError(
      `A container-image web function source is not supported yet; only a zip bundle from ` +
        `CodeConfig.S3Object runs locally.`,
      'LOCAL_START_WEB_FUNCTION_UNSUPPORTED_ARTIFACT'
    );
  }
  return runDetached({
    image: spec.baseImage,
    mounts: [{ hostPath: artifact.codeDir, containerPath: spec.codeMountPath, readOnly: true }],
    env: opts.env,
    ...(opts.sensitiveEnvKeys.size > 0 && { sensitiveEnvKeys: opts.sensitiveEnvKeys }),
    entryPoint: opts.start.entryPoint,
    cmd: opts.start.cmd,
    workingDir: spec.codeMountPath,
    hostPort: opts.hostPort,
    containerPort: WEB_FUNCTION_CONTAINER_PORT,
    host: opts.host,
    platform: opts.platform,
    name: opts.name,
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

/** Seams for {@link waitForWebFunctionReady}, injectable in unit tests. */
export interface WebFunctionReadyDeps {
  /** One HTTP probe: resolves `true` when ANY HTTP response arrived. */
  probe: (host: string, port: number) => Promise<boolean>;
  /** Whether the container is still running. */
  isRunning: (containerId: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Wait until the server answers an HTTP request on the published port, or fail
 * with the container's recent output.
 *
 * Readiness is an HTTP response, NOT a TCP accept: Docker's port forwarder
 * accepts the connection on the host before anything listens in the container,
 * so a connect alone reports ready too early. The probe is one `GET /` that any
 * status satisfies. A container that exits first fails fast rather than waiting
 * out the timeout.
 */
export async function waitForWebFunctionReady(
  args: {
    containerId: string;
    host: string;
    port: number;
    timeoutMs: number;
    recent: RecentOutput;
    entryFile: string;
  },
  deps: WebFunctionReadyDeps = defaultReadyDeps
): Promise<void> {
  const deadline = deps.now() + args.timeoutMs;
  let attempt = 0;
  while (deps.now() < deadline) {
    if (await deps.probe(args.host, args.port)) return;
    attempt++;
    if (attempt % 4 === 0 && !(await deps.isRunning(args.containerId))) {
      throw readyFailure(
        `The web function container exited before its server listened on ` +
          `AWS_LAMBDA_HTTP_ENDPOINT (entry file ${args.entryFile}).`,
        args.recent
      );
    }
    await deps.sleep(250);
  }
  throw readyFailure(
    `The web function server did not answer HTTP on ` +
      `${formatAuthority(args.host, args.port)} within ${args.timeoutMs}ms. It must ` +
      `listen on the host:port given in AWS_LAMBDA_HTTP_ENDPOINT (entry file ${args.entryFile}).`,
    args.recent
  );
}

function readyFailure(message: string, recent: RecentOutput): CdkLocalError {
  const lines = recent.tail();
  const detail =
    lines.length > 0
      ? ` Last ${lines.length} line(s) of container output:\n${lines
          .map((l) => `  ${displayToolOutput(l)}`)
          .join('\n')}`
      : ' The container printed nothing.';
  return new CdkLocalError(`${message}${detail}`, 'LOCAL_START_WEB_FUNCTION_NOT_READY');
}

/** One `GET /` against the published port; any HTTP status counts. */
function probeHttp(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const req = request(
      { host, port, path: '/', method: 'GET', timeout: 1000, headers: { connection: 'close' } },
      (res) => {
        res.resume();
        resolveProbe(true);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolveProbe(false));
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
    // `--rm` removed it: it has exited.
    return false;
  }
}

const defaultReadyDeps: WebFunctionReadyDeps = {
  probe: probeHttp,
  isRunning: containerIsRunning,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};
