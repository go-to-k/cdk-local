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

/** Two ALBs; `wiring` decides whether they front the same service or two. */
function twoAlbStack(wiring: 'same-service' | 'two-services'): StackInfo {
  const resources: Record<string, unknown> = {
    Alb1: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application' } },
    Alb2: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application' } },
    Tg1: {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
    },
    L1: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'Alb1' },
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg1' } }],
      },
    },
    Svc1: {
      Type: 'AWS::ECS::Service',
      Properties: {
        LoadBalancers: [{ ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: 'Tg1' } }],
      },
    },
  };
  if (wiring === 'same-service') {
    // Alb2's listener (port 8080) ALSO forwards to Tg1 -> same Svc1.
    resources['L2'] = {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'Alb2' },
        Port: 8080,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg1' } }],
      },
    };
  } else {
    resources['Tg2'] = {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
    };
    resources['L2'] = {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'Alb2' },
        Port: 8080,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg2' } }],
      },
    };
    resources['Svc2'] = {
      Type: 'AWS::ECS::Service',
      Properties: {
        LoadBalancers: [{ ContainerName: 'api', ContainerPort: 80, TargetGroupArn: { Ref: 'Tg2' } }],
      },
    };
  }
  return { stackName: 'Multi', template: { Resources: resources } } as unknown as StackInfo;
}

describe('albStrategy.resolveBoots multi-service', () => {
  it('merges two ALBs fronting the SAME service into one boot with both listeners', () => {
    const { boots } = albStrategy({} as never).resolveBoots(
      [twoAlbStack('same-service')],
      ['Multi:Alb1', 'Multi:Alb2']
    );
    expect(boots).toHaveLength(1);
    expect(boots[0]!.target).toBe('Multi:Svc1');
    expect(boots[0]!.frontDoorTargets.map((t) => t.listenerPort).sort((a, b) => a - b)).toEqual([
      80, 8080,
    ]);
  });

  it('produces two boots when two ALBs front two different services', () => {
    const { boots } = albStrategy({} as never).resolveBoots(
      [twoAlbStack('two-services')],
      ['Multi:Alb1', 'Multi:Alb2']
    );
    expect(boots.map((b) => b.target).sort()).toEqual(['Multi:Svc1', 'Multi:Svc2']);
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
