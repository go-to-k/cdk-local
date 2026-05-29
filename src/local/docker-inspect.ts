import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDockerCmd } from '../utils/docker-cmd.js';

const execFileAsync = promisify(execFile);

/**
 * Phase 3 of #262 (Issue #460) helper — query the docker network IP
 * assigned to a freshly-started container so the Cloud Map registry
 * can publish reachable endpoints for peer discovery.
 *
 * Returns `undefined` when:
 *   - The container is not found (docker rm raced us).
 *   - The container is not attached to the named network.
 *   - The IP is empty (docker hasn't fully wired the network yet —
 *     caller should retry-or-skip; the helper deliberately does NOT
 *     embed a retry loop to keep the caller in charge of timing).
 *
 * Errors propagate verbatim to the caller (`DockerRunnerError`-style
 * wrapping is the caller's concern; this helper is structurally a
 * simple inspect wrapper).
 */
export async function getContainerNetworkIp(
  containerId: string,
  networkName: string
): Promise<string | undefined> {
  const format = `{{with index .NetworkSettings.Networks "${networkName}"}}{{.IPAddress}}{{end}}`;
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), [
      'inspect',
      '--format',
      format,
      containerId,
    ]);
    const ip = stdout.trim();
    if (!ip) return undefined;
    return ip;
  } catch {
    // Container vanished between docker run and inspect (typical on a
    // failed boot or a parallel SIGTERM); caller treats undefined as
    // "skip registration" and the cleanup path handles teardown.
    return undefined;
  }
}

/**
 * Issue #86 v1 helper — read back the docker-assigned host port a container
 * port was published on. The local ALB front-door publishes each replica's
 * target container port on an ephemeral host port (`-p <host>::<containerPort>`)
 * and round-robins to `127.0.0.1:<hostPort>`; this resolves that host port
 * after the replica boots.
 *
 * Uses a nil-safe Go template (`with index`) so a container that did NOT
 * publish the port yields empty output instead of a template error. Returns
 * `undefined` when the port is unpublished, the container vanished, or the
 * value isn't a parseable port.
 */
export async function getPublishedHostPort(
  containerId: string,
  containerPort: number,
  protocol: 'tcp' | 'udp' = 'tcp'
): Promise<number | undefined> {
  const key = `${containerPort}/${protocol}`;
  const format = `{{with index .NetworkSettings.Ports "${key}"}}{{with index . 0}}{{.HostPort}}{{end}}{{end}}`;
  try {
    const { stdout } = await execFileAsync(getDockerCmd(), [
      'inspect',
      '--format',
      format,
      containerId,
    ]);
    const raw = stdout.trim();
    if (!raw) return undefined;
    const port = parseInt(raw, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}
