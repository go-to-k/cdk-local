import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { startAgentCoreHttpServer } from '../../../src/local/agentcore-http-server.js';
import { startAgentCoreWsBridge } from '../../../src/local/agentcore-ws-bridge.js';
import type { ResolvedDistribution } from '../../../src/local/cloudfront-resolver.js';
import { startCloudFrontServer } from '../../../src/local/cloudfront-server.js';
import { StudioEventBus } from '../../../src/local/studio-events.js';
import { startStudioProxy } from '../../../src/local/studio-proxy.js';
import { startStudioServer } from '../../../src/local/studio-server.js';

/**
 * Issue go-to-k/cdk-local#599 — the five serve components that BIND a socket
 * and then hand back the URL they are reachable at. `cdkl studio` resolves
 * those URLs with `new URL(...)` before it will forward anything, so an
 * unbracketed IPv6 authority makes the serve unusable rather than ugly.
 *
 * The IPv6 half needs a real `::1` bind, so it is `ctx.skip()`ped on a host
 * with no IPv6 loopback — the same treatment `studio-proxy.test.ts` gives its
 * `[::1]` upstream case, and never a bare `return`, which would pass with zero
 * assertions. The non-skippable guard for these sites is the source fence in
 * `tests/unit/utils/url-authority-call-sites.test.ts`.
 */

const closers: Array<() => Promise<void>> = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c().catch(() => undefined)));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.close(() => r());
          s.closeAllConnections?.();
        })
    )
  );
});

/** True when this host can bind IPv6 loopback at all. */
async function hasIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

/** A throwaway upstream on IPv4 loopback, for the components that need one. */
function bootUpstream(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"Healthy"}');
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
  });
}

/** Assert the URL a serve reports parses and carries exactly `expectedHost`. */
function expectServeUrl(url: string, expectedHost: string): URL {
  const parsed = new URL(url);
  expect(parsed.hostname).toBe(expectedHost);
  expect(parsed.port).not.toBe('');
  return parsed;
}

function emptyDistribution(): ResolvedDistribution {
  return {
    logicalId: 'Dist',
    stackName: 'Stack',
    behaviors: [{ targetOriginId: 'o1' }],
    origins: new Map([['o1', { kind: 's3', originId: 'o1', localDirs: [] }]]),
    customErrorResponses: [],
  } as unknown as ResolvedDistribution;
}

/**
 * One table row per bind-based serve: boot it on `host` and report the URL it
 * hands back. Every row is run for IPv4, DNS and (when available) IPv6.
 */
const SERVES: ReadonlyArray<{ name: string; boot: (host: string) => Promise<string> }> = [
  {
    name: 'startCloudFrontServer',
    boot: async (host) => {
      const s = await startCloudFrontServer({ distribution: emptyDistribution(), host, port: 0 });
      closers.push(() => s.close());
      return s.url;
    },
  },
  {
    name: 'startAgentCoreHttpServer (httpUrl)',
    boot: async (host) => {
      const containerPort = await bootUpstream();
      const s = await startAgentCoreHttpServer({ containerHost: '127.0.0.1', containerPort, host });
      closers.push(() => s.close());
      return s.httpUrl;
    },
  },
  {
    name: 'startAgentCoreHttpServer (wsUrl)',
    boot: async (host) => {
      const containerPort = await bootUpstream();
      const s = await startAgentCoreHttpServer({
        containerHost: '127.0.0.1',
        containerPort,
        host,
        attachWs: true,
      });
      closers.push(() => s.close());
      expect(s.wsUrl, 'attachWs did not produce a wsUrl').toBeDefined();
      return s.wsUrl as string;
    },
  },
  {
    name: 'startAgentCoreWsBridge',
    boot: async (host) => {
      const containerPort = await bootUpstream();
      const b = await startAgentCoreWsBridge({ containerHost: '127.0.0.1', containerPort, host });
      closers.push(() => b.close());
      return b.url;
    },
  },
  {
    name: 'startStudioServer',
    boot: async (host) => {
      const s = await startStudioServer({
        port: 0,
        host,
        bus: new StudioEventBus(),
        targetGroups: [],
        appLabel: 'App',
        cliName: 'cdkl',
      } as unknown as Parameters<typeof startStudioServer>[0]);
      closers.push(() => s.close());
      return s.url;
    },
  },
  {
    name: 'startStudioProxy',
    boot: async (host) => {
      const upstreamPort = await bootUpstream();
      const p = await startStudioProxy({
        bus: new StudioEventBus(),
        target: 'MyApi',
        kind: 'api',
        upstream: `http://127.0.0.1:${upstreamPort}`,
        host,
      } as unknown as Parameters<typeof startStudioProxy>[0]);
      closers.push(() => p.close());
      return p.url;
    },
  },
];

describe('serve URLs bracket an IPv6 bind address (issue #599)', () => {
  for (const serve of SERVES) {
    it(`${serve.name} reports a parseable URL on '::1'`, async (ctx) => {
      if (!(await hasIpv6Loopback())) {
        // Nothing to bind, so there is no claim to make either way. Reported
        // as SKIPPED rather than silently passing with no assertions.
        ctx.skip();
        return;
      }
      const url = await serve.boot('::1');
      const parsed = expectServeUrl(url, '[::1]');
      expect(url).toContain('[::1]:');
      expect(parsed.hostname).toBe('[::1]');
    });

    it(`${serve.name} leaves an IPv4 bind address unbracketed`, async () => {
      const url = await serve.boot('127.0.0.1');
      expectServeUrl(url, '127.0.0.1');
      expect(url).not.toContain('[');
    });

    it(`${serve.name} leaves a DNS bind address unbracketed`, async () => {
      const url = await serve.boot('localhost');
      expectServeUrl(url, 'localhost');
      expect(url).not.toContain('[');
    });
  }
});
