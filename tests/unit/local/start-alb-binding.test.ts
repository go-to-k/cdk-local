import { describe, it, expect } from 'vite-plus/test';
import { resolveAlbTarget, parseLbPortOverrides, albStrategy } from '../../../src/cli/commands/local-start-alb.js';
import { serviceStrategy } from '../../../src/cli/commands/local-start-service.js';
import { buildFrontDoor } from '../../../src/cli/commands/ecs-service-emulator.js';
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

  it('errors when a display path resolves to more than one ALB (ambiguous)', () => {
    // Two ALBs share the `AlbStack/Shared` construct-path prefix, so the path
    // `AlbStack/Shared` resolves to both -> the user must disambiguate.
    const twoAlbStack = {
      stackName: 'AlbStack',
      template: {
        Resources: {
          AlbA: {
            Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
            Properties: { Type: 'application' },
            Metadata: { 'aws:cdk:path': 'AlbStack/Shared/AlbA/Resource' },
          },
          AlbB: {
            Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
            Properties: { Type: 'application' },
            Metadata: { 'aws:cdk:path': 'AlbStack/Shared/AlbB/Resource' },
          },
        },
      },
    } as unknown as StackInfo;
    expect(() => resolveAlbTarget('AlbStack/Shared', [twoAlbStack])).toThrow(
      /matches 2 load balancers/
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
  it('boots one service but stands up both listeners when two ALBs front the SAME service', () => {
    // Alb1 listener (port 80) and Alb2 listener (port 8080) both forward to
    // Svc1 -> one boot, two listeners on distinct host ports (no collision).
    const { boots, frontDoor } = albStrategy({} as never).resolveBoots(
      [twoAlbStack('same-service')],
      ['Multi:Alb1', 'Multi:Alb2']
    );
    expect(boots).toEqual([{ target: 'Multi:Svc1' }]);
    expect(frontDoor!.listeners.map((l) => l.listenerPort).sort((a, b) => a - b)).toEqual([
      80, 8080,
    ]);
    for (const l of frontDoor!.listeners) {
      expect(l.defaultTarget?.serviceTarget).toBe('Multi:Svc1');
    }
  });

  it('produces two boots when two ALBs front two different services', () => {
    const { boots } = albStrategy({} as never).resolveBoots(
      [twoAlbStack('two-services')],
      ['Multi:Alb1', 'Multi:Alb2']
    );
    expect(boots.map((b) => b.target).sort()).toEqual(['Multi:Svc1', 'Multi:Svc2']);
  });
});

describe('albStrategy --lb-port no-match warning', () => {
  it('warns when a --lb-port override matches no resolved listener', () => {
    const { warnings } = albStrategy({ lbPort: ['9999=8080'] } as never).resolveBoots(
      [albStack()],
      ['AlbStack:WebLB']
    );
    expect(warnings.join('\n')).toMatch(/--lb-port override for listener port 9999 matched no/);
  });

  it('does not warn when the --lb-port override matches a resolved listener', () => {
    const { warnings } = albStrategy({ lbPort: ['80=8080'] } as never).resolveBoots(
      [albStack()],
      ['AlbStack:WebLB']
    );
    expect(warnings.join('\n')).not.toMatch(/--lb-port override/);
  });
});

describe('start-alb / start-service strategy binding', () => {
  it('start-alb resolves an ALB target into a service boot + a front-door plan', () => {
    const strategy = albStrategy({ lbPort: ['80=8080'] } as never);
    const { boots, frontDoor, warnings } = strategy.resolveBoots([albStack()], ['AlbStack:WebLB']);
    expect(warnings).toEqual([]);
    expect(boots).toEqual([{ target: 'AlbStack:WebService' }]);
    expect(frontDoor!.listeners).toEqual([
      {
        listenerPort: 80,
        hostPort: 8080, // remapped by --lb-port 80=8080
        defaultTarget: {
          serviceTarget: 'AlbStack:WebService',
          targetContainerName: 'web',
          targetContainerPort: 80,
        },
        rules: [],
      },
    ]);
    // --lb-port is parsed by the ALB strategy (start-service has no such flag).
    expect(strategy.lbPortOverrides).toEqual({ 80: 8080 });
  });

  it('start-service produces pure-compute boots with NO front-door plan', () => {
    const strategy = serviceStrategy();
    const { boots, frontDoor } = strategy.resolveBoots([albStack()], ['AlbStack:WebService']);
    expect(boots).toEqual([{ target: 'AlbStack:WebService' }]);
    expect(frontDoor).toBeUndefined();
    expect(strategy.lbPortOverrides).toEqual({});
  });
});

describe('buildFrontDoor', () => {
  it('binds one server per listener and groups pools by service target', async () => {
    const logger = { info: () => {}, warn: () => {} } as never;
    const { servers, frontDoorByService } = await buildFrontDoor(
      {
        listeners: [
          {
            listenerPort: 80,
            hostPort: 0, // ephemeral: avoid privileged-port binding in the unit test
            defaultTarget: {
              serviceTarget: 'S:Web',
              targetContainerName: 'web',
              targetContainerPort: 80,
            },
            rules: [
              {
                priority: 10,
                pathPatterns: ['/api/*'],
                target: { serviceTarget: 'S:Api', targetContainerName: 'api', targetContainerPort: 8080 },
              },
            ],
          },
        ],
      },
      '127.0.0.1',
      logger
    );
    try {
      expect(servers).toHaveLength(1);
      // One pool per (service, container, port); grouped by service target.
      expect([...frontDoorByService.keys()].sort()).toEqual(['S:Api', 'S:Web']);
      expect(frontDoorByService.get('S:Web')).toEqual([
        expect.objectContaining({ targetContainerName: 'web', targetContainerPort: 80 }),
      ]);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
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
