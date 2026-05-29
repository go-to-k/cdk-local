import { describe, it, expect } from 'vite-plus/test';
import { resolveAlbTarget, parseLbPortOverrides, albStrategy } from '../../../src/cli/commands/local-start-alb.js';
import { serviceStrategy } from '../../../src/cli/commands/local-start-service.js';
import { startFrontDoorServers } from '../../../src/cli/commands/ecs-service-emulator.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const ALB = 'WebLB';
const TG = 'WebTargetGroup';
const SERVICE = 'WebService';

function albStack(): StackInfo {
  return {
    stackName: 'AlbStack',
    template: {
      Resources: {
        [ALB]: {
          Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          Properties: { Type: 'application' },
          Metadata: { 'aws:cdk:path': 'AlbStack/Web/LB/Resource' },
        },
        [TG]: {
          Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
        },
        WebListener: {
          Type: 'AWS::ElasticLoadBalancingV2::Listener',
          Properties: {
            LoadBalancerArn: { Ref: ALB },
            Port: 80,
            Protocol: 'HTTP',
            DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
          },
        },
        [SERVICE]: {
          Type: 'AWS::ECS::Service',
          Properties: {
            LoadBalancers: [
              { ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: TG } },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

describe('resolveAlbTarget', () => {
  it('resolves an ALB by stack-qualified logical id', () => {
    const { stack, albLogicalId } = resolveAlbTarget('AlbStack:WebLB', [albStack()]);
    expect(stack.stackName).toBe('AlbStack');
    expect(albLogicalId).toBe(ALB);
  });

  it('resolves an ALB by CDK display path', () => {
    const { albLogicalId } = resolveAlbTarget('AlbStack/Web/LB', [albStack()]);
    expect(albLogicalId).toBe(ALB);
  });

  it('errors when the target is not an application load balancer', () => {
    expect(() => resolveAlbTarget('AlbStack:WebService', [albStack()])).toThrow(
      /did not match an application Load Balancer/
    );
  });
});

describe('start-alb / start-service strategy binding', () => {
  it('start-alb resolves an ALB target into backing-service boots WITH front-door targets', () => {
    const strategy = albStrategy({ lbPort: ['80=8080'] } as never);
    const { boots, warnings } = strategy.resolveBoots([albStack()], ['AlbStack:WebLB']);
    expect(warnings).toEqual([]);
    expect(boots).toHaveLength(1);
    expect(boots[0]!.target).toBe('AlbStack:WebService');
    expect(boots[0]!.frontDoorTargets).toEqual([
      expect.objectContaining({
        listenerPort: 80,
        targetContainerName: 'web',
        targetContainerPort: 80,
      }),
    ]);
    // --lb-port is parsed by the ALB strategy (start-service has no such flag).
    expect(strategy.lbPortOverrides).toEqual({ 80: 8080 });
  });

  it('start-service produces pure-compute boots with NO front-door targets', () => {
    const strategy = serviceStrategy();
    const { boots } = strategy.resolveBoots([albStack()], ['AlbStack:WebService']);
    expect(boots).toEqual([{ target: 'AlbStack:WebService', frontDoorTargets: [] }]);
    expect(strategy.lbPortOverrides).toEqual({});
  });
});

describe('startFrontDoorServers (pure-compute path)', () => {
  it('returns no front-door context when there are no front-door targets', async () => {
    const result = await startFrontDoorServers(
      [],
      { serviceName: 'X' } as never,
      '127.0.0.1',
      {},
      { info: () => {}, warn: () => {} } as never
    );
    expect(result.frontDoorContext).toBeUndefined();
    expect(result.frontDoorServers).toEqual([]);
  });
});

describe('parseLbPortOverrides', () => {
  it('parses <listenerPort>=<hostPort> pairs', () => {
    expect(parseLbPortOverrides(['80=8080', '443=8443'])).toEqual({ 80: 8080, 443: 8443 });
    expect(parseLbPortOverrides(undefined)).toEqual({});
  });

  it('throws on a malformed value or out-of-range port', () => {
    expect(() => parseLbPortOverrides(['8080'])).toThrow(/Expected <listenerPort>=<hostPort>/);
    expect(() => parseLbPortOverrides(['80=0'])).toThrow(/host port must be 1-65535/);
  });
});
