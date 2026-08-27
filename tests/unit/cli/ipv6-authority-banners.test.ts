import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { FrontDoorPlan } from '../../../src/cli/commands/ecs-service-emulator.js';
import type { PublishedHostEndpoint } from '../../../src/local/ecs-task-runner.js';
import type { StartedFrontDoorServer } from '../../../src/local/front-door-server.js';
import { getLogger } from '../../../src/utils/logger.js';

// Issue go-to-k/cdk-local#599 — the ALB front-door banner and the endpoints
// banner are what `cdkl studio` reads to find the serve. Mock the ONE boundary
// that would otherwise need a real socket (`startFrontDoorServer`) so the
// bind-address spelling under test is free: the banner is composed from the
// host the started server reports, not from anything the OS hands back.
const { startFrontDoorServerMock } = vi.hoisted(() => ({ startFrontDoorServerMock: vi.fn() }));

vi.mock('../../../src/local/front-door-server.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/local/front-door-server.js')>();
  return { ...actual, startFrontDoorServer: startFrontDoorServerMock };
});

const { buildFrontDoor, logEndpointsBanner } = await import(
  '../../../src/cli/commands/ecs-service-emulator.js'
);

/** A one-listener plan whose default action needs no backing target at all. */
function fixedResponsePlan(): FrontDoorPlan {
  return {
    listeners: [
      {
        listenerPort: 80,
        hostPort: 0,
        protocol: 'HTTP',
        defaultAction: { kind: 'fixed-response', statusCode: 404 },
        rules: [],
      },
    ],
  } as unknown as FrontDoorPlan;
}

function startedServer(host: string, port: number): StartedFrontDoorServer {
  return {
    scheme: 'http',
    host,
    port,
    server: {} as never,
    close: async () => undefined,
  } as unknown as StartedFrontDoorServer;
}

function captureInfo(): string[] {
  const lines: string[] = [];
  vi.spyOn(getLogger(), 'info').mockImplementation((msg: string) => {
    lines.push(msg);
  });
  return lines;
}

beforeEach(() => {
  startFrontDoorServerMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The banner under mutation probe. `--container-host ::` used to print
 * `ALB front-door: http://:::8080`, which `new URL(...)` rejects — so studio
 * refused the serve outright.
 */
describe('buildFrontDoor — ALB front-door banner (issue #599)', () => {
  async function bannerFor(host: string, port: number): Promise<string> {
    startFrontDoorServerMock.mockResolvedValue(startedServer(host, port));
    const lines = captureInfo();
    const logger = getLogger();
    await buildFrontDoor(fixedResponsePlan(), { containerHost: host } as never, logger);
    const banner = lines.find((l) => l.startsWith('ALB front-door: '));
    expect(banner, `no ALB front-door banner in ${JSON.stringify(lines)}`).toBeDefined();
    return banner as string;
  }

  function endpointOf(banner: string): string {
    const m = /^ALB front-door: (\S+) /.exec(banner);
    expect(m, `banner does not carry a whitespace-delimited endpoint: ${banner}`).not.toBeNull();
    return (m as RegExpExecArray)[1] as string;
  }

  it('brackets an IPv6 bind address so the endpoint is a URL', async () => {
    const banner = await bannerFor('::', 8080);
    expect(banner).toBe('ALB front-door: http://[::]:8080 (listener port 80)');
    const url = new URL(endpointOf(banner));
    expect(url.hostname).toBe('[::]');
    expect(url.port).toBe('8080');
  });

  it('brackets an IPv6 loopback bind address', async () => {
    const url = new URL(endpointOf(await bannerFor('::1', 51234)));
    expect(url.hostname).toBe('[::1]');
  });

  it('leaves an IPv4 wildcard byte-identical — the integ fixtures grep this line', async () => {
    const banner = await bannerFor('0.0.0.0', 8080);
    expect(banner).toBe('ALB front-door: http://0.0.0.0:8080 (listener port 80)');
    expect(new URL(endpointOf(banner)).hostname).toBe('0.0.0.0');
  });

  it('leaves IPv4 loopback byte-identical', async () => {
    const banner = await bannerFor('127.0.0.1', 8080);
    expect(banner).toBe('ALB front-door: http://127.0.0.1:8080 (listener port 80)');
  });

  it('leaves a DNS host unbracketed', async () => {
    const banner = await bannerFor('localhost', 8080);
    expect(banner).toBe('ALB front-door: http://localhost:8080 (listener port 80)');
    expect(new URL(endpointOf(banner)).hostname).toBe('localhost');
  });
});

describe('logEndpointsBanner — published + front-door endpoints (issue #599)', () => {
  function controller(host: string) {
    return {
      service: { serviceName: 'SvcA' },
      runState: {
        replicas: [
          {
            shuttingDown: false,
            state: {
              publishedEndpoints: [
                {
                  containerName: 'app',
                  containerPort: 80,
                  host,
                  hostPort: 8080,
                  protocol: 'tcp',
                  overridden: false,
                } as PublishedHostEndpoint,
              ],
            },
          },
        ],
      },
    } as never;
  }

  function run(host: string): string[] {
    const lines = captureInfo();
    logEndpointsBanner(
      [{ controller: controller(host) }],
      [startedServer(host, 9090)],
      getLogger()
    );
    return lines;
  }

  it('brackets an IPv6 host in both the published line and the front-door line', () => {
    const lines = run('::1');
    expect(lines).toContain('    app container port 80/tcp -> http://[::1]:8080');
    expect(lines).toContain('    http://[::1]:9090');
    for (const l of lines.filter((x) => x.includes('://'))) {
      expect(() => new URL(l.trim().split(' -> ').pop() as string)).not.toThrow();
    }
  });

  it('leaves an IPv4 host byte-identical', () => {
    const lines = run('127.0.0.1');
    expect(lines).toContain('    app container port 80/tcp -> http://127.0.0.1:8080');
    expect(lines).toContain('    http://127.0.0.1:9090');
  });

  it('leaves a DNS host unbracketed', () => {
    const lines = run('localhost');
    expect(lines).toContain('    app container port 80/tcp -> http://localhost:8080');
    expect(lines).toContain('    http://localhost:9090');
  });
});
