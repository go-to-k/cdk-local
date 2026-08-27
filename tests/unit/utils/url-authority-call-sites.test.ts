import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Issue go-to-k/cdk-local#599 — the population fence.
 *
 * The defect was never one banner: it was that composing an authority as
 * `${host}:${port}` is the obvious thing to write, and gets written again
 * every time a new endpoint is printed. `cdkl studio` PARSES several of these
 * banners with `new URL(...)` before it will forward anything, so an IPv6
 * host that is not bracketed does not merely read badly — the serve is
 * refused.
 *
 * So this file fences the POPULATION rather than the sites that happened to
 * be found:
 *
 * - the NEGATIVE fence: no `${…host…}:${…}` adjacency may exist in `src/`
 *   unless it is on {@link NON_AUTHORITY}, each entry saying why that colon
 *   is not a URL authority;
 * - the POSITIVE fence: every site that WAS converted must still route
 *   through `formatAuthority`, so reverting one is red here even when its
 *   behaviour is only reachable through a full serve boot.
 */

const SRC = join(import.meta.dirname, '../../../src');

/** The helper itself defines the composition; scanning it would be circular. */
const SELF = 'utils/url-authority.ts';

/** Every `${expr}:${` adjacency, with the left-hand expression captured. */
const ADJACENCY_RE = /\$\{([^{}]*)\}:\$\{/g;
/** An expression that plausibly names a network host. */
const HOSTISH_RE = /host|addr|ip|endpoint|origin|domain/i;

interface Allowed {
  /** Path relative to `src/`. */
  readonly file: string;
  /** A distinctive substring of the offending line. */
  readonly contains: string;
  /** Why this colon is not a URL authority — or why it is still unfixed. */
  readonly why: string;
}

/**
 * The colons that are NOT a URL authority. Two distinct reasons, and the list
 * says which, because "exempt" is not one fact:
 *
 * - a DIFFERENT GRAMMAR — `docker run`'s `-p ip:hostPort:containerPort`,
 *   `--add-host name:ip`, `-v hostPath:containerPath`. These are not RFC 3986
 *   authorities and `formatAuthority` would be wrong in them. (Docker's `-p`
 *   accepts an IPv6 host BOTH bare and bracketed — measured on Docker 29.3.1,
 *   `-p :::18080:80` and `-p [::]:18083:80` both yield HostIp `::` — so there
 *   is no latent defect hiding behind this exemption.)
 * - HUMAN TEXT that merely mentions a host and a port, and is never fed to a
 *   parser. Five are log lines; three are 502 / 504 RESPONSE BODIES, which
 *   reach a wider reader than a log does and are labelled as such rather than
 *   lumped in with the logs.
 *
 * Every host+port URL, banner and `Host:` header in `src/` routes through the
 * helper; nothing in this list is an unconverted one.
 *
 * `docker run` argument grammars (`-p ip:hostPort:containerPort`,
 * `--add-host name:ip`, `-v hostPath:containerPath`) are their own syntax,
 * not RFC 3986 authorities, so `formatAuthority` would be wrong there. (Docker
 * has its OWN bracket rule for an IPv6 `-p` address; that is a separate
 * question from this one and is not settled here.) Diagnostic prose that
 * merely mentions a host and port is left as prose.
 */
const NON_AUTHORITY: readonly Allowed[] = [
  {
    file: 'cli/commands/local-profile-credentials-file.ts',
    contains: '${file.hostPath}:${file.containerPath}',
    why: 'docker `-v` bind mount: two filesystem paths, no host',
  },
  {
    file: 'local/docker-runner.ts',
    contains: "'--add-host', `${entry.host}:${entry.ip}`",
    why: 'docker `--add-host name:ip` grammar',
  },
  {
    file: 'local/docker-runner.ts',
    contains: "'-p', `${host}:${opts.hostPort}",
    why: 'docker `-p` publish grammar',
  },
  {
    file: 'local/docker-runner.ts',
    contains: "'-p', `${host}:${opts.debugPort}",
    why: 'docker `-p` publish grammar',
  },
  {
    file: 'local/docker-runner.ts',
    contains: '${mount.hostPath}:${mount.containerPath}',
    why: 'docker `-v` bind mount: two filesystem paths, no host',
  },
  {
    file: 'local/ecs-task-runner.ts',
    contains: "'--add-host', `${h.host}:${h.ip}`",
    why: 'docker `--add-host name:ip` grammar',
  },
  {
    file: 'local/ecs-task-runner.ts',
    contains: "'-p', `${containerHost}:${hostPort}",
    why: 'docker `-p` publish grammar',
  },
  {
    file: 'local/ecs-task-runner.ts',
    contains: '${opts.profileCredentialsFile.hostPath}:${opts.profileCredentialsFile.containerPath}',
    why: 'docker `-v` bind mount: two filesystem paths, no host',
  },
  {
    file: 'local/ecs-task-runner.ts',
    contains: '${v.hostPath}:${mp.containerPath}',
    why: 'docker `-v` bind mount: two filesystem paths, no host',
  },
  {
    file: 'local/container-pool.ts',
    contains: 'on ${spec.containerHost}:${hostPort}',
    why: 'logger.debug prose, never parsed',
  },
  {
    file: 'local/ecs-service-runner.ts',
    contains: 'registered at ${containerHost}:${hostPort}',
    why: 'logger.info / warn prose, never parsed',
  },
  {
    file: 'local/ecs-service-runner.ts',
    contains: 'TCP probe ${ip}:${port} accepted',
    why: 'logger.debug prose, never parsed',
  },
  {
    file: 'local/ecs-service-runner.ts',
    contains: 'TCP probe ${ip}:${port} did not accept',
    why: 'logger.info / warn prose, never parsed',
  },
  {
    file: 'local/front-door-server.ts',
    contains: 'Replica ${endpoint.host}:${endpoint.port} behind',
    why: 'the 504 RESPONSE BODY (writeError) — prose for a human, never parsed; the values are the replica pool\'s own endpoint, not request-derived',
  },
  {
    file: 'local/front-door-server.ts',
    contains: 'Failed to reach replica ${endpoint.host}:${endpoint.port}',
    why: 'the 502 RESPONSE BODY, twice — writeError on the HTTP path and writeRawHttpError on the upgrade path. Body, not header: it lands after the CRLF that ends the head, so it cannot inject one, and the values are the replica pool\'s own endpoint',
  },
  {
    file: 'local/front-door-server.ts',
    contains: 'WS upstream error (${endpoint.host}:${endpoint.port})',
    why: 'logger.debug prose, never parsed',
  },
];

/**
 * Every site issue #599 converted. Reverting any of them is red here — which
 * is the only guard several of them have, since their banners are only
 * reachable through a full serve boot.
 *
 * `count` is the number of sites that share the snippet, and it defaults to 1.
 * Without it an `includes()` check is satisfied by ANY one of them, so the
 * second and later copies were not pinned at all: reverting
 * `invokeRieStreaming` alone stayed green because `invokeRie` still carried
 * the byte-identical line.
 */
const CONVERTED: readonly { file: string; contains: string; count?: number }[] = [
  { file: 'cli/commands/ecs-service-emulator.ts', contains: 'ALB front-door: ${server.scheme}://${formatAuthority(server.host, server.port)}' },
  { file: 'cli/commands/ecs-service-emulator.ts', contains: '${scheme}://${formatAuthority(ep.host, ep.hostPort)}' },
  { file: 'cli/commands/ecs-service-emulator.ts', contains: '${s.scheme}://${formatAuthority(s.host, s.port)}' },
  // Both `Server listening on` sites now share one exported emitter
  // (`formatServerListeningBanner`), which has its own behavioural test.
  { file: 'cli/commands/local-start-api.ts', contains: 'Server listening on ${scheme}://${formatAuthority(host, port)}${pathSuffix}  (${label})' },
  { file: 'cli/commands/local-start-api.ts', contains: '(http://${formatAuthority(server.host, server.port)})' },
  { file: 'local/cloudfront-server.ts', contains: '`${scheme}://${formatAuthority(options.host, port)}`' },
  { file: 'local/agentcore-http-server.ts', contains: 'httpUrl: `http://${formatAuthority(host, port)}`' },
  { file: 'local/agentcore-http-server.ts', contains: 'wsUrl: `ws://${formatAuthority(host, port)}${bridge.path}`' },
  { file: 'local/agentcore-ws-bridge.ts', contains: 'url: `ws://${formatAuthority(host, port)}${attached.path}`' },
  { file: 'local/studio-server.ts', contains: 'url: `http://${formatAuthority(host, boundPort)}`' },
  { file: 'local/studio-proxy.ts', contains: 'url: `http://${formatAuthority(host, port)}`' },
  { file: 'local/ecs-task-runner.ts', contains: '`${formatAuthority(containerHost, hostPort)}${overrideNote}. `' },
  { file: 'local/ecs-task-runner.ts', contains: 'Reach it at ${formatAuthority(containerHost, hostPort)}.' },
  { file: 'local/websocket-mgmt-api.ts', contains: 'return `http://${formatAuthority(host, port)}/${stage}`' },
  { file: 'local/rie-client.ts', contains: 'RIE did not become ready on ${formatAuthority(host, port)}' },
  { file: 'local/rie-client.ts', contains: 'fetch(`http://${formatAuthority(host, port)}/`' },
  // invokeRie + invokeRieStreaming
  { file: 'local/rie-client.ts', contains: 'const url = `http://${formatAuthority(host, port)}${INVOKE_PATH}`', count: 2 },
  // waitForAgentCorePing + waitForAgentCoreHttpReady
  { file: 'local/agentcore-client.ts', contains: 'AgentCore agent did not become ready on ${formatAuthority(host, port)}', count: 2 },
  { file: 'local/agentcore-client.ts', contains: 'fetch(`http://${formatAuthority(host, port)}${PING_PATH}`' },
  { file: 'local/agentcore-client.ts', contains: 'fetch(`http://${formatAuthority(host, port)}${path}`' },
  { file: 'local/agentcore-client.ts', contains: 'const url = `http://${formatAuthority(host, port)}${INVOCATIONS_PATH}`' },
  { file: 'local/agentcore-mcp-client.ts', contains: 'const url = `http://${formatAuthority(host, port)}${MCP_PATH}`' },
  { file: 'local/agentcore-a2a-client.ts', contains: 'const url = `http://${formatAuthority(host, port)}${A2A_PATH}`' },
  // bridgeAgentCoreWs + invokeAgentCoreWs
  { file: 'local/agentcore-ws-client.ts', contains: 'const url = `ws://${formatAuthority(host, port)}${WS_PATH}`', count: 2 },
  { file: 'local/agentcore-sigv4-sign.ts', contains: 'Host: formatAuthority(opts.host, opts.port)' },
  { file: 'local/front-door-server.ts', contains: 'isDefaultPort || port === \'\' ? formatHostForAuthority(host) : formatAuthority(host, port)' },
  { file: 'local/front-door-server.ts', contains: 'hostFromAuthority(hostHeaderValue ?? \'\')' },
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function hostishAdjacencies(): Site[] {
  const sites: Site[] = [];
  for (const full of tsFiles(SRC)) {
    const file = relative(SRC, full).split(/[\\/]/).join('/');
    if (file === SELF) continue;
    const lines = readFileSync(full, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(ADJACENCY_RE)) {
        if (HOSTISH_RE.test(m[1] ?? '')) {
          sites.push({ file, line: i + 1, text: text.trim() });
          break;
        }
      }
    });
  }
  return sites;
}

describe('URL-authority composition sites (issue #599)', () => {
  const sites = hostishAdjacencies();

  it('finds the population it is meant to fence (guard the guard)', () => {
    // If the scan silently stopped matching, every assertion below would pass
    // vacuously. The docker-argument sites alone keep this well above zero.
    expect(sites.length).toBeGreaterThan(10);
  });

  it('composes no `${host}:${port}` authority outside the declared non-authority set', () => {
    const unexplained = sites.filter(
      (s) => !NON_AUTHORITY.some((a) => a.file === s.file && s.text.includes(a.contains))
    );
    expect(
      unexplained.map((s) => `${s.file}:${s.line}  ${s.text}`),
      'a new `${host}:${port}` was composed by hand — route it through `formatAuthority` ' +
        '(src/utils/url-authority.ts), or add it to NON_AUTHORITY with the reason its colon is not a URL authority'
    ).toEqual([]);
  });

  it('carries no stale non-authority exemption', () => {
    const dead = NON_AUTHORITY.filter(
      (a) => !sites.some((s) => s.file === a.file && s.text.includes(a.contains))
    );
    expect(
      dead.map((a) => `${a.file}  ${a.contains}`),
      'an exemption no longer matches any source line — delete it'
    ).toEqual([]);
  });

  it('keeps every converted site routed through formatAuthority', () => {
    const reverted = CONVERTED.map((c) => {
      const want = c.count ?? 1;
      const got = readFileSync(join(SRC, c.file), 'utf8').split(c.contains).length - 1;
      return got === want ? undefined : `${c.file}  expected ${want}x, found ${got}x: ${c.contains}`;
    }).filter((x): x is string => x !== undefined);
    expect(
      reverted,
      'a site issue #599 converted no longer composes its authority through `formatAuthority` ' +
        '(an EXACT count, so one of two byte-identical sites cannot hide behind the other)'
    ).toEqual([]);
  });

  it('imports the helper in every file that uses it', () => {
    const files = [...new Set(CONVERTED.map((c) => c.file))];
    for (const file of files) {
      // A file may pull in more than `formatAuthority` (front-door-server also
      // needs `formatHostForAuthority` + the inverse `hostFromAuthority`), so
      // match the named-import LIST rather than a single-symbol spelling.
      expect(readFileSync(join(SRC, file), 'utf8'), file).toMatch(
        /import \{[^}]*\bformatAuthority\b[^}]*\} from '\.\.?\/[^']*url-authority\.js';/
      );
    }
  });
});
