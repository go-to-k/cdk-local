import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';
import { a2aInvokeOnce } from '../../../src/local/agentcore-a2a-client.js';
import {
  invokeAgentCore,
  waitForAgentCoreHttpReady,
  waitForAgentCorePing,
} from '../../../src/local/agentcore-client.js';
import { mcpInvokeOnce } from '../../../src/local/agentcore-mcp-client.js';
import {
  bridgeAgentCoreWs,
  invokeAgentCoreWs,
} from '../../../src/local/agentcore-ws-client.js';
import { invokeRie, waitForRieReady } from '../../../src/local/rie-client.js';
import { buildMgmtEndpointEnvUrl } from '../../../src/local/websocket-mgmt-api.js';

/**
 * Issue go-to-k/cdk-local#599 — the URLs these modules build from a host and a
 * port are handed to `fetch` / the `ws` client / a Lambda's env, so an
 * unbracketed IPv6 literal is not a cosmetic defect: `http://:::8080` is not a
 * URL and the request never leaves.
 *
 * Each site is asserted three ways — an IPv6 host IS bracketed, an IPv4 and a
 * DNS host are NOT touched, and the composed string PARSES with its hostname
 * intact.
 */

/** The three host spellings every site below is crossed with. */
const IPV6 = { host: '::1', expected: '[::1]' } as const;
const IPV4 = { host: '127.0.0.1', expected: '127.0.0.1' } as const;
const DNS = { host: 'localhost', expected: 'localhost' } as const;

/** Assert `url` parses and carries exactly the expected authority. */
function expectAuthority(url: string, expectedHost: string, port: number): URL {
  const parsed = new URL(url);
  expect(parsed.hostname).toBe(expectedHost);
  expect(parsed.port).toBe(String(port));
  return parsed;
}

/** Stub global fetch, recording every URL it is handed. */
function captureFetch(body = '{"ok":true}'): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch);
  return urls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rie-client (issue #599)', () => {
  for (const { host, expected } of [IPV6, IPV4, DNS]) {
    it(`invokeRie posts to a parseable URL for host '${host}'`, async () => {
      const urls = captureFetch();
      await invokeRie(host, 9001, { k: 1 }, 1000);
      expect(urls).toHaveLength(1);
      expectAuthority(urls[0] as string, expected, 9001);
    });
  }

  it('brackets an IPv6 host in the not-ready diagnostic', async () => {
    await expect(waitForRieReady('::1', 9001, 0)).rejects.toThrow(
      /RIE did not become ready on \[::1\]:9001/
    );
  });

  it('leaves an IPv4 host bare in the not-ready diagnostic', async () => {
    await expect(waitForRieReady('127.0.0.1', 9001, 0)).rejects.toThrow(
      /RIE did not become ready on 127\.0\.0\.1:9001/
    );
  });
});

describe('agentcore-client (issue #599)', () => {
  for (const { host, expected } of [IPV6, IPV4, DNS]) {
    it(`invokeAgentCore posts to a parseable URL for host '${host}'`, async () => {
      const urls = captureFetch();
      await invokeAgentCore(host, 8080, { p: 1 }, { sessionId: 's'.repeat(33), timeoutMs: 1000 });
      expect(urls).toHaveLength(1);
      const parsed = expectAuthority(urls[0] as string, expected, 8080);
      expect(parsed.pathname).toBe('/invocations');
    });

    it(`waitForAgentCoreHttpReady probes a parseable URL for host '${host}'`, async () => {
      const urls = captureFetch();
      await waitForAgentCoreHttpReady(host, 8000, '/mcp', 5000);
      expect(urls.length).toBeGreaterThan(0);
      const parsed = expectAuthority(urls[0] as string, expected, 8000);
      expect(parsed.pathname).toBe('/mcp');
    });
  }

  it('brackets an IPv6 host in the ping-timeout diagnostic', async () => {
    await expect(waitForAgentCorePing('::1', 8080, 0)).rejects.toThrow(
      /did not become ready on \[::1\]:8080/
    );
  });

  it('leaves an IPv4 host bare in the ping-timeout diagnostic', async () => {
    await expect(waitForAgentCorePing('127.0.0.1', 8080, 0)).rejects.toThrow(
      /did not become ready on 127\.0\.0\.1:8080/
    );
  });
});

describe('agentcore MCP / A2A clients (issue #599)', () => {
  /** A fetchImpl that answers every JSON-RPC POST and records the URL. */
  function rpcFetch(urls: string[]): typeof fetch {
    return ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess' },
        })
      );
    }) as typeof fetch;
  }

  for (const { host, expected } of [IPV6, IPV4, DNS]) {
    it(`mcpInvokeOnce posts to a parseable URL for host '${host}'`, async () => {
      const urls: string[] = [];
      await mcpInvokeOnce(host, 8000, { method: 'tools/list' }, { fetchImpl: rpcFetch(urls) });
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(expectAuthority(u, expected, 8000).pathname).toBe('/mcp');
    });

    it(`a2aInvokeOnce posts to a parseable URL for host '${host}'`, async () => {
      const urls: string[] = [];
      await a2aInvokeOnce(host, 9000, { method: 'message/send' }, { fetchImpl: rpcFetch(urls) });
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(expectAuthority(u, expected, 9000).pathname).toBe('/');
    });
  }
});

describe('buildMgmtEndpointEnvUrl (issue #599)', () => {
  it('brackets an IPv6 host in the @connections endpoint a Lambda receives', () => {
    const url = buildMgmtEndpointEnvUrl('::1', 3001, 'prod');
    expect(url).toBe('http://[::1]:3001/prod');
    expect(expectAuthority(url, '[::1]', 3001).pathname).toBe('/prod');
  });

  it('leaves an IPv4 host byte-identical', () => {
    expect(buildMgmtEndpointEnvUrl('127.0.0.1', 3001, 'prod')).toBe('http://127.0.0.1:3001/prod');
  });

  it('leaves a DNS host unbracketed', () => {
    expect(buildMgmtEndpointEnvUrl('localhost', 3001, 'prod')).toBe('http://localhost:3001/prod');
  });
});

describe('ecs-task-runner replica publish banner (issue #599)', () => {
  function container(): ResolvedEcsContainer {
    return {
      name: 'web',
      image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
      environment: {},
      sensitiveEnvKeys: [],
      secrets: [],
      portMappings: [{ containerPort: 8080, protocol: 'tcp' }],
      mountPoints: [],
      dependsOn: [],
      links: [],
      essential: true,
      ulimits: [],
      warnings: [],
    } as unknown as ResolvedEcsContainer;
  }

  function bannerFor(containerHost: string): string {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((msg?: unknown) => {
      lines.push(String(msg));
    });
    buildDockerRunArgs({
      task: { family: 'fam' } as unknown as ResolvedEcsTask,
      container: container(),
      image: 'public.ecr.aws/docker/library/busybox:latest',
      network: 'net',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost,
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    } as unknown as Parameters<typeof buildDockerRunArgs>[0]);
    const banner = lines.find((l) => l.includes('published on'));
    expect(banner, `no publish banner in ${JSON.stringify(lines)}`).toBeDefined();
    return banner as string;
  }

  it('brackets an IPv6 container host, so the endpoint studio reads is a URL', () => {
    const banner = bannerFor('::1');
    expect(banner).toContain("Container 'web' container port 8080 published on [::1]:8080.");
    expect(banner).toContain('Reach it at [::1]:8080.');
    expectAuthority('http://[::1]:8080', '[::1]', 8080);
  });

  it('leaves an IPv4 container host byte-identical — studio greps this line', () => {
    const banner = bannerFor('127.0.0.1');
    expect(banner).toContain("Container 'web' container port 8080 published on 127.0.0.1:8080.");
    expect(banner).toContain('Reach it at 127.0.0.1:8080.');
  });

  it('leaves a DNS container host unbracketed', () => {
    expect(bannerFor('localhost')).toContain(
      "Container 'web' container port 8080 published on localhost:8080."
    );
  });
});

describe('agentcore-ws-client (issue #599)', () => {
  /**
   * A stand-in `ws` implementation that records the URL it was constructed
   * with and then behaves like a socket that opens and closes immediately, so
   * neither entry point hangs.
   */
  function recordingWs(urls: string[]): never {
    class FakeWs {
      onceHandlers = new Map<string, Array<(...a: unknown[]) => void>>();
      constructor(url: string) {
        urls.push(url);
        setTimeout(() => {
          this.emit('open');
          this.emit('close', 1000);
        }, 0);
      }
      on(event: string, cb: (...a: unknown[]) => void): this {
        const list = this.onceHandlers.get(event) ?? [];
        list.push(cb);
        this.onceHandlers.set(event, list);
        return this;
      }
      once(event: string, cb: (...a: unknown[]) => void): this {
        return this.on(event, cb);
      }
      off(): this {
        return this;
      }
      removeListener(): this {
        return this;
      }
      emit(event: string, ...args: unknown[]): void {
        for (const cb of this.onceHandlers.get(event) ?? []) cb(...args);
      }
      send(): void {}
      close(): void {
        this.emit('close', 1000);
      }
      terminate(): void {}
      readyState = 1;
    }
    return FakeWs as never;
  }

  for (const { host, expected } of [IPV6, IPV4, DNS]) {
    it(`bridgeAgentCoreWs opens a parseable ws:// URL for host '${host}'`, () => {
      const urls: string[] = [];
      const handle = bridgeAgentCoreWs(host, 8080, {
        sessionId: 's'.repeat(33),
        onMessage: () => {},
        webSocketImpl: recordingWs(urls),
      });
      handle.close();
      expect(urls).toHaveLength(1);
      const parsed = expectAuthority(urls[0] as string, expected, 8080);
      expect(parsed.protocol).toBe('ws:');
      expect(parsed.pathname).toBe('/ws');
    });

    it(`invokeAgentCoreWs opens a parseable ws:// URL for host '${host}'`, async () => {
      const urls: string[] = [];
      await invokeAgentCoreWs(host, 8080, { p: 1 }, {
        sessionId: 's'.repeat(33),
        onMessage: () => {},
        timeoutMs: 2000,
        webSocketImpl: recordingWs(urls),
      });
      expect(urls).toHaveLength(1);
      const parsed = expectAuthority(urls[0] as string, expected, 8080);
      expect(parsed.protocol).toBe('ws:');
      expect(parsed.pathname).toBe('/ws');
    });
  }
});
