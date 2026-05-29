import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// Lock the start-service -> front-door binding (per the project's "site-level
// binding test" rule): the CLI must start a front-door server AND thread a
// FrontDoorRunnerContext iff the service resolves an HTTP forward listener,
// and must NOT when there is no load balancer. The front-door server module is
// mocked so no real socket binds.
const { startFrontDoorServerMock } = vi.hoisted(() => ({
  startFrontDoorServerMock: vi.fn(),
}));

vi.mock('../../../src/local/front-door-server.js', () => ({
  startFrontDoorServer: startFrontDoorServerMock,
}));

const { startFrontDoorForService } = await import('../../../src/cli/commands/local-start-service.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const TG = 'SvcTG';
const LISTENER = 'SvcListener';

function fakeServiceWithLb(loadBalancers: unknown[]): {
  stack: StackInfo;
  serviceName: string;
  loadBalancers: unknown[];
} {
  return {
    serviceName: 'WebSvc',
    loadBalancers,
    stack: {
      stackName: 'AlbStack',
      template: {
        Resources: {
          [TG]: {
            Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
            Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
          },
          [LISTENER]: {
            Type: 'AWS::ElasticLoadBalancingV2::Listener',
            Properties: {
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
            },
          },
        },
      },
    } as unknown as StackInfo,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (service: any, options: any) =>
  startFrontDoorForService(service, options, getLogger());

describe('start-service front-door binding', () => {
  beforeEach(() => {
    startFrontDoorServerMock.mockReset();
    startFrontDoorServerMock.mockResolvedValue({
      port: 80,
      host: '127.0.0.1',
      server: {},
      close: async () => {},
    });
  });

  it('starts a front-door and threads a context when a forward listener resolves', async () => {
    const service = fakeServiceWithLb([
      { containerName: 'web', containerPort: 80, targetGroupLogicalId: TG },
    ]);
    const { frontDoorContext, frontDoorServers } = await call(service, { containerHost: '127.0.0.1' });

    expect(startFrontDoorServerMock).toHaveBeenCalledTimes(1);
    expect(startFrontDoorServerMock.mock.calls[0]![0]).toMatchObject({
      port: 80,
      listenerPort: 80,
      serviceName: 'WebSvc',
    });
    expect(frontDoorServers).toHaveLength(1);
    expect(frontDoorContext?.pools).toEqual([
      expect.objectContaining({ targetContainerName: 'web', targetContainerPort: 80 }),
    ]);
  });

  it('does NOT start a front-door (context undefined) when there is no load balancer', async () => {
    const service = fakeServiceWithLb([]);
    const { frontDoorContext, frontDoorServers } = await call(service, { containerHost: '127.0.0.1' });

    expect(startFrontDoorServerMock).not.toHaveBeenCalled();
    expect(frontDoorContext).toBeUndefined();
    expect(frontDoorServers).toEqual([]);
  });

  it('binds the front-door on the --lb-port override host port', async () => {
    const service = fakeServiceWithLb([
      { containerName: 'web', containerPort: 80, targetGroupLogicalId: TG },
    ]);
    await call(service, { containerHost: '127.0.0.1', lbPort: ['80=8080'] });

    expect(startFrontDoorServerMock.mock.calls[0]![0]).toMatchObject({
      port: 8080,
      listenerPort: 80,
    });
  });

  it('closes started servers and throws with a --lb-port hint on bind failure', async () => {
    startFrontDoorServerMock.mockRejectedValueOnce(
      Object.assign(new Error('listen EACCES'), { code: 'EACCES' })
    );
    const service = fakeServiceWithLb([
      { containerName: 'web', containerPort: 80, targetGroupLogicalId: TG },
    ]);
    await expect(call(service, { containerHost: '127.0.0.1' })).rejects.toThrow(/--lb-port/);
  });
});
