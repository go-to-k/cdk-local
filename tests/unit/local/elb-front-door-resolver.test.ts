import { describe, it, expect } from 'vite-plus/test';
import { resolveFrontDoorTargets } from '../../../src/local/elb-front-door-resolver.js';
import type { ResolvedServiceLoadBalancer } from '../../../src/local/ecs-service-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Mirrors the real `ApplicationLoadBalancedFargateService` synth shape: the
 * Service forwards to a TargetGroup, and a Listener default-forwards to that
 * TargetGroup. Resources are merged in so individual tests can override.
 */
function stackWith(resources: Record<string, unknown>): StackInfo {
  return {
    stackName: 'AlbStack',
    template: { Resources: resources },
  } as unknown as StackInfo;
}

const TG = 'SvcLBPublicListenerECSGroup74B4EF70';
const LISTENER = 'SvcLBPublicListener14185DCE';

function httpForwardTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
        LoadBalancerArn: { Ref: 'SvcLB19363842' },
      },
    },
    ...overrides,
  };
}

const lb = (targetGroupLogicalId?: string): ResolvedServiceLoadBalancer => ({
  containerName: 'web',
  containerPort: 80,
  ...(targetGroupLogicalId !== undefined && { targetGroupLogicalId }),
});

describe('resolveFrontDoorTargets', () => {
  it('resolves a single HTTP default-forward listener to a front-door target', () => {
    const { targets, warnings } = resolveFrontDoorTargets(stackWith(httpForwardTemplate()), [
      lb(TG),
    ]);
    expect(warnings).toEqual([]);
    expect(targets).toEqual([
      {
        listenerPort: 80,
        listenerProtocol: 'HTTP',
        targetContainerName: 'web',
        targetContainerPort: 80,
        targetGroupLogicalId: TG,
        listenerLogicalId: LISTENER,
      },
    ]);
  });

  it('resolves the ForwardConfig.TargetGroups[] (weighted) shape too', () => {
    const tmpl = httpForwardTemplate({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          Port: 8080,
          Protocol: 'HTTP',
          DefaultActions: [
            { Type: 'forward', ForwardConfig: { TargetGroups: [{ TargetGroupArn: { Ref: TG } }] } },
          ],
        },
      },
    });
    const { targets } = resolveFrontDoorTargets(stackWith(tmpl), [lb(TG)]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.listenerPort).toBe(8080);
  });

  it('returns no targets and no warnings when the service has no load balancer', () => {
    const { targets, warnings } = resolveFrontDoorTargets(stackWith(httpForwardTemplate()), []);
    expect(targets).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('skips + warns on an HTTPS listener (HTTP only in v1)', () => {
    const tmpl = httpForwardTemplate({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          Port: 443,
          Protocol: 'HTTPS',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
        },
      },
    });
    const { targets, warnings } = resolveFrontDoorTargets(stackWith(tmpl), [lb(TG)]);
    expect(targets).toEqual([]);
    expect(warnings.join('\n')).toMatch(/HTTPS/);
  });

  it('skips + warns on a Lambda target group (deferred to a follow-up)', () => {
    const tmpl = httpForwardTemplate({
      [TG]: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: { TargetType: 'lambda' },
      },
    });
    const { targets, warnings } = resolveFrontDoorTargets(stackWith(tmpl), [lb(TG)]);
    expect(targets).toEqual([]);
    expect(warnings.join('\n')).toMatch(/Lambda target/);
  });

  it('warns when no forwarding listener references the target group', () => {
    const tmpl = httpForwardTemplate({
      // Drop the listener entirely.
      [LISTENER]: undefined as unknown as Record<string, unknown>,
    });
    delete (tmpl as Record<string, unknown>)[LISTENER];
    const { targets, warnings } = resolveFrontDoorTargets(stackWith(tmpl), [lb(TG)]);
    expect(targets).toEqual([]);
    expect(warnings.join('\n')).toMatch(/no default-forward listener/);
  });

  it('warns on a non-Ref (cross-stack / imported) target group arn', () => {
    const { targets, warnings } = resolveFrontDoorTargets(
      stackWith(httpForwardTemplate()),
      [lb(undefined)] // targetGroupLogicalId unresolved
    );
    expect(targets).toEqual([]);
    expect(warnings.join('\n')).toMatch(/non-Ref TargetGroupArn/);
  });

  it('warns when the referenced target group is missing from the template', () => {
    const { targets, warnings } = resolveFrontDoorTargets(stackWith(httpForwardTemplate()), [
      lb('NonExistentTargetGroup'),
    ]);
    expect(targets).toEqual([]);
    expect(warnings.join('\n')).toMatch(/no AWS::ElasticLoadBalancingV2::TargetGroup/);
  });

  it('keeps only the first front-door when two listeners forward to the TG on the same port', () => {
    const tmpl = httpForwardTemplate({
      // A second HTTP listener, also on port 80, also default-forwarding to TG.
      SecondListener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
        },
      },
    });
    const { targets, warnings } = resolveFrontDoorTargets(stackWith(tmpl), [lb(TG)]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.listenerPort).toBe(80);
    expect(warnings.join('\n')).toMatch(/Multiple load-balancer targets resolve to host listener port 80/);
  });
});
