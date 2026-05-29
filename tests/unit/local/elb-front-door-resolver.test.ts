import { describe, it, expect } from 'vite-plus/test';
import {
  resolveAlbFrontDoor,
  isApplicationLoadBalancer,
} from '../../../src/local/elb-front-door-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

const ALB = 'WebLB';
const TG = 'WebTargetGroup';
const LISTENER = 'WebListener';
const SERVICE = 'WebService';

/**
 * Mirrors the real `ApplicationLoadBalancedFargateService` synth shape: ALB ->
 * Listener (forward) -> TargetGroup <- Service.LoadBalancers[]. Resources merge
 * in so tests can override individual pieces.
 */
function stackWith(overrides: Record<string, unknown> = {}): StackInfo {
  const base: Record<string, unknown> = {
    [ALB]: {
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      Properties: { Type: 'application' },
    },
    [TG]: {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
    },
    [LISTENER]: {
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
        LoadBalancers: [{ ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: TG } }],
      },
    },
    ...overrides,
  };
  // Strip keys explicitly overridden to `undefined` (lets a test drop a resource).
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return { stackName: 'AlbStack', template: { Resources: base } } as unknown as StackInfo;
}

describe('resolveAlbFrontDoor', () => {
  it('resolves ALB -> listener -> target group -> backing ECS service', () => {
    const { services, warnings } = resolveAlbFrontDoor(stackWith(), ALB);
    expect(warnings).toEqual([]);
    expect(services).toEqual([
      {
        serviceLogicalId: SERVICE,
        targets: [
          {
            listenerPort: 80,
            listenerProtocol: 'HTTP',
            targetContainerName: 'web',
            targetContainerPort: 80,
            targetGroupLogicalId: TG,
            listenerLogicalId: LISTENER,
          },
        ],
      },
    ]);
  });

  it('resolves the ForwardConfig.TargetGroups[] (weighted) shape too', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 8080,
          Protocol: 'HTTP',
          DefaultActions: [
            { Type: 'forward', ForwardConfig: { TargetGroups: [{ TargetGroupArn: { Ref: TG } }] } },
          ],
        },
      },
    });
    const { services } = resolveAlbFrontDoor(stack, ALB);
    expect(services).toHaveLength(1);
    expect(services[0]!.targets[0]!.listenerPort).toBe(8080);
  });

  it('ignores listeners belonging to a different ALB', () => {
    const stack = stackWith({
      OtherListener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: 'SomeOtherLB' },
          Port: 9000,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
        },
      },
    });
    const { services } = resolveAlbFrontDoor(stack, ALB);
    expect(services).toHaveLength(1);
    expect(services[0]!.targets.map((t) => t.listenerPort)).toEqual([80]);
  });

  it('skips + warns on an HTTPS listener (HTTP only in v1)', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 443,
          Protocol: 'HTTPS',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
        },
      },
    });
    const { services, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(services).toEqual([]);
    expect(warnings.join('\n')).toMatch(/HTTPS/);
  });

  it('skips + warns on a Lambda target group (deferred follow-up)', () => {
    const stack = stackWith({
      [TG]: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: { TargetType: 'lambda' },
      },
    });
    const { services, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(services).toEqual([]);
    expect(warnings.join('\n')).toMatch(/Lambda target/);
  });

  it('warns when no ECS service references the target group', () => {
    const stack = stackWith({ [SERVICE]: undefined });
    const { services, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(services).toEqual([]);
    expect(warnings.join('\n')).toMatch(/not\s+referenced by any AWS::ECS::Service/);
  });

  it('warns when a forward listener uses a non-Ref (literal / cross-stack) target group arn', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'forward',
              TargetGroupArn:
                'arn:aws:elasticloadbalancing:us-east-1:111:targetgroup/imported/abc',
            },
          ],
        },
      },
    });
    const { services, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(services).toEqual([]);
    expect(warnings.join('\n')).toMatch(/non-Ref TargetGroupArn/);
  });

  it('skips a redirect-only listener silently (no warning)', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443' } }],
        },
      },
    });
    const { services, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(services).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('warns when the forwarded target group is missing from the template', () => {
    const stack = stackWith({ [TG]: undefined });
    const { services, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(services).toEqual([]);
    expect(warnings.join('\n')).toMatch(/no AWS::ElasticLoadBalancingV2::TargetGroup/);
  });

  it('keeps only the first front-door when two listeners hit the same service on one port', () => {
    const stack = stackWith({
      SecondListener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
        },
      },
    });
    const { services, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(services).toHaveLength(1);
    expect(services[0]!.targets).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/more than one listener on host port 80/);
  });
});

describe('isApplicationLoadBalancer', () => {
  const lb = (props?: Record<string, unknown>): TemplateResource =>
    ({
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      ...(props ? { Properties: props } : {}),
    }) as TemplateResource;

  it('is true for an application LB (explicit or defaulted Type)', () => {
    expect(isApplicationLoadBalancer(lb({ Type: 'application' }))).toBe(true);
    expect(isApplicationLoadBalancer(lb())).toBe(true);
  });

  it('is false for a network LB and non-LB resources', () => {
    expect(isApplicationLoadBalancer(lb({ Type: 'network' }))).toBe(false);
    expect(isApplicationLoadBalancer({ Type: 'AWS::ECS::Service' } as TemplateResource)).toBe(false);
  });
});
