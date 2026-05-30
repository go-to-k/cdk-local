import { describe, it, expect, vi } from 'vite-plus/test';
import { logEndpointsBanner } from '../../../src/cli/commands/ecs-service-emulator.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { PublishedHostEndpoint } from '../../../src/local/ecs-task-runner.js';
import type { StartedFrontDoorServer } from '../../../src/local/front-door-server.js';

function makeController(
  serviceName: string,
  endpointsByReplica: { shuttingDown: boolean; publishedEndpoints: PublishedHostEndpoint[] }[]
) {
  return {
    service: { serviceName },
    runState: {
      replicas: endpointsByReplica.map((r) => ({
        shuttingDown: r.shuttingDown,
        state: { publishedEndpoints: r.publishedEndpoints },
      })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeFrontDoor(
  scheme: 'http' | 'https',
  host: string,
  port: number
): StartedFrontDoorServer {
  return {
    scheme,
    host,
    port,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server: {} as any,
    close: async () => undefined,
  };
}

function capture(): { lines: string[]; logger: ReturnType<typeof getLogger> } {
  const lines: string[] = [];
  const logger = getLogger();
  vi.spyOn(logger, 'info').mockImplementation((msg: string) => {
    lines.push(msg);
  });
  return { lines, logger };
}

describe('logEndpointsBanner', () => {
  it('emits a "Service endpoints:" header followed by one indented line per published port', () => {
    const { lines, logger } = capture();
    logEndpointsBanner(
      [
        {
          controller: makeController('SvcA', [
            {
              shuttingDown: false,
              publishedEndpoints: [
                {
                  containerName: 'app',
                  containerPort: 80,
                  host: '127.0.0.1',
                  hostPort: 80,
                  protocol: 'tcp',
                  overridden: false,
                },
              ],
            },
          ]),
        },
      ],
      [],
      logger
    );
    expect(lines).toEqual([
      'Service endpoints:',
      '  SvcA',
      '    app container port 80/tcp -> http://127.0.0.1:80',
    ]);
  });

  it('appends "(--host-port override)" when the host port was remapped', () => {
    const { lines, logger } = capture();
    logEndpointsBanner(
      [
        {
          controller: makeController('SvcA', [
            {
              shuttingDown: false,
              publishedEndpoints: [
                {
                  containerName: 'app',
                  containerPort: 80,
                  host: '127.0.0.1',
                  hostPort: 8080,
                  protocol: 'tcp',
                  overridden: true,
                },
              ],
            },
          ]),
        },
      ],
      [],
      logger
    );
    expect(lines.at(-1)).toBe(
      '    app container port 80/tcp -> http://127.0.0.1:8080  (--host-port override)'
    );
  });

  it('uses udp:// for udp port mappings', () => {
    const { lines, logger } = capture();
    logEndpointsBanner(
      [
        {
          controller: makeController('SvcA', [
            {
              shuttingDown: false,
              publishedEndpoints: [
                {
                  containerName: 'app',
                  containerPort: 53,
                  host: '127.0.0.1',
                  hostPort: 53,
                  protocol: 'udp',
                  overridden: false,
                },
              ],
            },
          ]),
        },
      ],
      [],
      logger
    );
    expect(lines.at(-1)).toBe('    app container port 53/udp -> udp://127.0.0.1:53');
  });

  it('is silent when every replica has no static publishes AND no front-door is supplied (multi-replica / ALB ephemeral case)', () => {
    const { lines, logger } = capture();
    logEndpointsBanner(
      [
        {
          controller: makeController('SvcA', [{ shuttingDown: false, publishedEndpoints: [] }]),
        },
      ],
      [],
      logger
    );
    expect(lines).toEqual([]);
  });

  it('skips shutting-down replicas and reads from the first active one', () => {
    const { lines, logger } = capture();
    logEndpointsBanner(
      [
        {
          controller: makeController('SvcA', [
            { shuttingDown: true, publishedEndpoints: [] },
            {
              shuttingDown: false,
              publishedEndpoints: [
                {
                  containerName: 'app',
                  containerPort: 80,
                  host: '127.0.0.1',
                  hostPort: 80,
                  protocol: 'tcp',
                  overridden: false,
                },
              ],
            },
          ]),
        },
      ],
      [],
      logger
    );
    expect(lines).toEqual([
      'Service endpoints:',
      '  SvcA',
      '    app container port 80/tcp -> http://127.0.0.1:80',
    ]);
  });

  it('lists multiple services under one banner', () => {
    const { lines, logger } = capture();
    logEndpointsBanner(
      [
        {
          controller: makeController('SvcA', [
            {
              shuttingDown: false,
              publishedEndpoints: [
                {
                  containerName: 'app',
                  containerPort: 80,
                  host: '127.0.0.1',
                  hostPort: 80,
                  protocol: 'tcp',
                  overridden: false,
                },
              ],
            },
          ]),
        },
        {
          controller: makeController('SvcB', [
            {
              shuttingDown: false,
              publishedEndpoints: [
                {
                  containerName: 'api',
                  containerPort: 8080,
                  host: '127.0.0.1',
                  hostPort: 9090,
                  protocol: 'tcp',
                  overridden: true,
                },
              ],
            },
          ]),
        },
      ],
      [],
      logger
    );
    expect(lines).toEqual([
      'Service endpoints:',
      '  SvcA',
      '    app container port 80/tcp -> http://127.0.0.1:80',
      '  SvcB',
      '    api container port 8080/tcp -> http://127.0.0.1:9090  (--host-port override)',
    ]);
  });

  it('lists ALB front-door listener URLs when frontDoorServers is non-empty', () => {
    const { lines, logger } = capture();
    logEndpointsBanner(
      [],
      [makeFrontDoor('http', '127.0.0.1', 80), makeFrontDoor('https', '127.0.0.1', 443)],
      logger
    );
    expect(lines).toEqual([
      'Service endpoints:',
      '  ALB front-door',
      '    http://127.0.0.1:80',
      '    https://127.0.0.1:443',
    ]);
  });

  it('is silent when the perTarget entry has no controller (e.g. unbooted target)', () => {
    const { lines, logger } = capture();
    logEndpointsBanner([{ controller: undefined }], [], logger);
    expect(lines).toEqual([]);
  });

  it('falls back to http:// for unknown protocols (sctp, etc.) — pins current behavior', () => {
    const { lines, logger } = capture();
    logEndpointsBanner(
      [
        {
          controller: makeController('SvcA', [
            {
              shuttingDown: false,
              publishedEndpoints: [
                {
                  containerName: 'app',
                  containerPort: 9999,
                  host: '127.0.0.1',
                  hostPort: 9999,
                  protocol: 'sctp',
                  overridden: false,
                },
              ],
            },
          ]),
        },
      ],
      [],
      logger
    );
    expect(lines.at(-1)).toBe('    app container port 9999/sctp -> http://127.0.0.1:9999');
  });

  it('combines service replicas and front-door listeners under one banner', () => {
    const { lines, logger } = capture();
    logEndpointsBanner(
      [
        {
          controller: makeController('SvcA', [
            {
              shuttingDown: false,
              publishedEndpoints: [
                {
                  containerName: 'app',
                  containerPort: 80,
                  host: '127.0.0.1',
                  hostPort: 80,
                  protocol: 'tcp',
                  overridden: false,
                },
              ],
            },
          ]),
        },
      ],
      [makeFrontDoor('http', '127.0.0.1', 8080)],
      logger
    );
    expect(lines).toEqual([
      'Service endpoints:',
      '  SvcA',
      '    app container port 80/tcp -> http://127.0.0.1:80',
      '  ALB front-door',
      '    http://127.0.0.1:8080',
    ]);
  });
});
