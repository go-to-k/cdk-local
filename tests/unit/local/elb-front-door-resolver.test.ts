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

const API_TG = 'ApiTargetGroup';
const API_SERVICE = 'ApiService';
const RULE = 'ApiRule';

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

/** A second backing service (`api`) + target group, for path-rule routing tests. */
const apiServiceResources: Record<string, unknown> = {
  [API_TG]: {
    Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
  },
  [API_SERVICE]: {
    Type: 'AWS::ECS::Service',
    Properties: {
      LoadBalancers: [
        { ContainerName: 'api', ContainerPort: 8080, TargetGroupArn: { Ref: API_TG } },
      ],
    },
  },
};

describe('resolveAlbFrontDoor', () => {
  it('resolves ALB -> listener default forward -> backing ECS service', () => {
    const { listeners, warnings } = resolveAlbFrontDoor(stackWith(), ALB);
    expect(warnings).toEqual([]);
    expect(listeners).toEqual([
      {
        listenerPort: 80,
        listenerProtocol: 'HTTP',
        listenerLogicalId: LISTENER,
        defaultTarget: {
          serviceLogicalId: SERVICE,
          targetContainerName: 'web',
          targetContainerPort: 80,
          targetGroupLogicalId: TG,
        },
        rules: [],
      },
    ]);
  });

  it('resolves a single-target ForwardConfig.TargetGroups[] default action', () => {
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
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.listenerPort).toBe(8080);
    expect(listeners[0]!.defaultTarget?.serviceLogicalId).toBe(SERVICE);
  });

  it('resolves path-pattern ListenerRules into a routing table (default + rule, two services)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.defaultTarget?.serviceLogicalId).toBe(SERVICE);
    expect(listeners[0]!.rules).toEqual([
      {
        priority: 10,
        pathPatterns: ['/api/*'],
        target: {
          serviceLogicalId: API_SERVICE,
          targetContainerName: 'api',
          targetContainerPort: 8080,
          targetGroupLogicalId: API_TG,
        },
      },
    ]);
  });

  it('sorts a rule with no Priority last (Number.MAX_SAFE_INTEGER fallback)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          // No Priority -> must fall back to MAX_SAFE_INTEGER (loses to any numbered rule).
          ListenerArn: { Ref: LISTENER },
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules[0]!.priority).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reads the legacy top-level Conditions[].Values path-pattern shape', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 5,
          Conditions: [{ Field: 'path-pattern', Values: ['/legacy/*'] }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules[0]!.pathPatterns).toEqual(['/legacy/*']);
  });

  it('skips + warns on a rule with an unsupported (non-path-pattern) condition', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['api.example.com'] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    // The listener still resolves via its default forward; only the rule is dropped.
    expect(listeners[0]!.rules).toEqual([]);
    expect(warnings.join('\n')).toMatch(/unsupported condition\(s\): host-header/);
  });

  it('skips + warns on a weighted (multi-target) forward', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'forward',
              ForwardConfig: {
                TargetGroups: [{ TargetGroupArn: { Ref: TG } }, { TargetGroupArn: { Ref: API_TG } }],
              },
            },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/weighted forward/);
  });

  it('serves a rules-only listener (fixed-response default + path rule -> no defaultTarget)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } }],
        },
      },
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.defaultTarget).toBeUndefined();
    expect(listeners[0]!.rules[0]!.target.serviceLogicalId).toBe(API_SERVICE);
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
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners.map((l) => l.listenerPort)).toEqual([80]);
  });

  it('skips + warns on an HTTPS listener (HTTP only)', () => {
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
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/HTTPS/);
  });

  it('skips + warns on a Lambda target group (deferred follow-up)', () => {
    const stack = stackWith({
      [TG]: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: { TargetType: 'lambda' },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/Lambda target/);
  });

  it('warns when no ECS service references the target group', () => {
    const stack = stackWith({ [SERVICE]: undefined });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/not referenced by any AWS::ECS::Service/);
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
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/non-Ref TargetGroupArn/);
  });

  it('warns on a non-Ref target group inside a ForwardConfig.TargetGroups[]', () => {
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
              ForwardConfig: {
                TargetGroups: [
                  {
                    TargetGroupArn:
                      'arn:aws:elasticloadbalancing:us-east-1:111:targetgroup/imported/abc',
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
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
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('warns when the forwarded target group is missing from the template', () => {
    const stack = stackWith({ [TG]: undefined });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/no AWS::ElasticLoadBalancingV2::TargetGroup/);
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
