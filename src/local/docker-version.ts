import { runDockerStreaming } from '../utils/docker-cmd.js';

/**
 * Lower bound for `--add-host=<name>:host-gateway` support. The
 * `host-gateway` magic alias was introduced in Docker 20.10 (October
 * 2020) and is the load-bearing primitive cdk-local uses to let Lambda
 * containers reach the host's `cdkl start-api` server on Linux
 * native dockerd. Without it, the AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI
 * override fails with `ENOTFOUND host.docker.internal` at SDK-call time.
 *
 * Docker Desktop (macOS / Windows) ships `host.docker.internal` as
 * a built-in alias regardless of the engine version, but the probe
 * still fires there to keep the error path uniform — the `host-gateway`
 * flag itself is harmless on Docker Desktop.
 *
 * Issue #527 M2.
 */
export const HOST_GATEWAY_MIN_VERSION: ParsedDockerVersion = { major: 20, minor: 10, patch: 0 };

export interface ParsedDockerVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a Docker server version string (`20.10.21` / `24.0.7-rd` /
 * `27.3.1+podman` etc.) into a comparable `{major, minor, patch}` tuple.
 * Returns `null` on any unparseable input — the caller treats that as
 * "version unknown, skip the comparison and let the user proceed with
 * a warn" rather than hard-failing on a Docker-compatible CLI binary
 * that doesn't follow Docker's version-string conventions
 * (e.g. podman / finch).
 */
export function parseDockerVersion(raw: string): ParsedDockerVersion | null {
  const trimmed = raw.trim();
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/**
 * Compare two `ParsedDockerVersion` tuples. Returns negative when `a <
 * b`, zero when equal, positive when `a > b`. Patch-level differences
 * are part of the ordering so a future bump (e.g. 20.10.0 -> 20.10.5
 * to fix a CVE-related regression) can be expressed if needed.
 */
export function compareDockerVersions(a: ParsedDockerVersion, b: ParsedDockerVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export interface HostGatewayProbeResult {
  /** Reported Docker server version string ("20.10.21" / "27.3.1" / etc.). */
  rawVersion: string;
  /** Parsed tuple, `null` when the raw string didn't match `<int>.<int>(.<int>)?`. */
  parsed: ParsedDockerVersion | null;
  /**
   * `true` when the parsed version is ≥ {@link HOST_GATEWAY_MIN_VERSION}
   * (or `null` parsed — see {@link parseDockerVersion} for the
   * unknown-version policy: defer to the warn path rather than hard-fail).
   */
  supported: boolean;
}

/**
 * Probe the Docker server's version to gate the `--add-host=...:host-gateway`
 * mapping that WebSocket Lambda containers need to reach the host
 * server. Issued ONCE per `cdkl start-api` invocation at WebSocket
 * attach time — HTTP-only / REST-only sessions skip the probe entirely.
 *
 * Throws when:
 *   1. The docker subprocess itself fails (binary missing, daemon down,
 *      permission error) — the caller's catch surfaces the original
 *      error so the user knows to install / start Docker.
 *   2. The probe succeeds but the parsed version is < the supported
 *      minimum — caller decides whether to error or warn (the WebSocket
 *      attach loop errors; HTTP-only sessions never call this).
 *
 * Implementation: `docker version --format '{{.Server.Version}}'`
 * returns the daemon's version (not the client's) so a brand-new
 * client against an old daemon is still caught.
 */
export async function probeHostGatewaySupport(): Promise<HostGatewayProbeResult> {
  const result = await runDockerStreaming(['version', '--format', '{{.Server.Version}}'], {
    streamLive: false,
  });
  const rawVersion = result.stdout.trim();
  const parsed = parseDockerVersion(rawVersion);
  // Empty stdout is treated as `supported=false` — `docker version
  // --format '{{.Server.Version}}'` returning an empty string is much
  // more likely a broken probe (daemon unreachable, permission stripped
  // output, format string mismatch on a forked CLI) than a podman /
  // finch shape. Masking it as "unknown engine, proceed" would defeat
  // the whole point of the probe — the caller's error path surfaces
  // the empty string explicitly so the user can diagnose the
  // underlying daemon failure. Surfaced by PR #539 review.
  if (rawVersion === '') {
    return { rawVersion, parsed: null, supported: false };
  }
  // Treat unparseable-but-non-empty versions as "supported" — podman /
  // finch / nerdctl emit version strings cdk-local can't always compare
  // against Docker's. Defer to the warn path rather than refuse the
  // boot.
  const supported = parsed === null || compareDockerVersions(parsed, HOST_GATEWAY_MIN_VERSION) >= 0;
  return { rawVersion, parsed, supported };
}

/**
 * The `host.docker.internal:host-gateway` extra-host mapping that lets a
 * container reach a server bound on the host loopback. Docker Desktop
 * (macOS / Windows) resolves `host.docker.internal` natively, but Linux
 * native dockerd needs this explicit `--add-host` (since Docker 20.10).
 */
export const HOST_DOCKER_INTERNAL_GATEWAY: { host: string; ip: string } = {
  host: 'host.docker.internal',
  ip: 'host-gateway',
};

let hostGatewayExtraHostsCache: Promise<{ host: string; ip: string }[]> | undefined;

/**
 * Resolve the `extraHosts` entries to inject so a launched container can
 * reach a server on the host via `host.docker.internal` — the
 * load-bearing primitive behind pointing a Lambda / ECS container at a
 * local endpoint (e.g. `AWS_ENDPOINT_URL_*` to a local server, or a
 * tunneled VPC resource).
 *
 * Returns `[{@link HOST_DOCKER_INTERNAL_GATEWAY}]` when the Docker daemon
 * supports the `host-gateway` alias (>= 20.10, or an unparseable
 * podman / finch version per {@link probeHostGatewaySupport}), else `[]`
 * — passing `--add-host ...:host-gateway` to a pre-20.10 daemon would
 * fail the `docker run`, so an old / unknown-failed daemon silently
 * degrades to "no mapping" (Docker Desktop still resolves the name
 * natively; Linux native dockerd loses host reachability, matching the
 * pre-fix behavior). A probe error (daemon down, binary missing)
 * resolves to `[]` rather than throwing — reachability is best-effort
 * convenience here, NOT a hard requirement like the start-api WebSocket
 * path. Memoized per process: the probe (`docker version`) fires at most
 * once regardless of how many containers / replicas are launched.
 */
export async function resolveHostGatewayExtraHosts(): Promise<{ host: string; ip: string }[]> {
  if (hostGatewayExtraHostsCache === undefined) {
    hostGatewayExtraHostsCache = probeHostGatewaySupport()
      .then((probe) => (probe.supported ? [{ ...HOST_DOCKER_INTERNAL_GATEWAY }] : []))
      .catch(() => []);
  }
  return hostGatewayExtraHostsCache;
}

/**
 * Test-only: reset the {@link resolveHostGatewayExtraHosts} memo so each
 * test controls the underlying probe mock.
 */
export function resetHostGatewayExtraHostsCache(): void {
  hostGatewayExtraHostsCache = undefined;
}
