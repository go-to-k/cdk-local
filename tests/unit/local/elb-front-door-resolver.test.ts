import { describe, it, expect } from 'vite-plus/test';
import {
  resolveAlbFrontDoor,
  isApplicationLoadBalancer,
  type FrontDoorEcsTarget,
  type FrontDoorForwardTarget,
} from '../../../src/local/elb-front-door-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

/** Narrow a resolved forward target to its ECS variant (test ergonomics). */
function ecsTarget(t: FrontDoorForwardTarget | undefined): FrontDoorEcsTarget {
  if (!t || t.kind !== 'ecs') throw new Error(`expected an ECS forward target, got: ${t?.kind}`);
  return t;
}

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

/** Convenience: the single ECS forward target of a resolved action (throws if not a forward). */
function forwardTarget(
  action: import('../../../src/local/elb-front-door-resolver.js').ResolvedListenerAction | undefined
): FrontDoorEcsTarget {
  if (action?.kind !== 'forward') throw new Error(`expected a forward action, got ${action?.kind}`);
  return ecsTarget(action.targets[0]);
}

/** Convenience: the single forward target of a resolved action, NOT narrowed (mixed tests). */
function forwardTargetRaw(
  action: import('../../../src/local/elb-front-door-resolver.js').ResolvedListenerAction | undefined
): FrontDoorForwardTarget {
  if (action?.kind !== 'forward') throw new Error(`expected a forward action, got ${action?.kind}`);
  return action.targets[0]!;
}

describe('resolveAlbFrontDoor', () => {
  it('resolves ALB -> listener default forward -> backing ECS service', () => {
    const { listeners, warnings } = resolveAlbFrontDoor(stackWith(), ALB);
    expect(warnings).toEqual([]);
    expect(listeners).toEqual([
      {
        listenerPort: 80,
        listenerProtocol: 'HTTP',
        listenerLogicalId: LISTENER,
        defaultAction: {
          kind: 'forward',
          targets: [
            {
              kind: 'ecs',
              serviceLogicalId: SERVICE,
              targetContainerName: 'web',
              targetContainerPort: 80,
              targetGroupLogicalId: TG,
              weight: 1,
            },
          ],
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
    expect(forwardTarget(listeners[0]!.defaultAction).serviceLogicalId).toBe(SERVICE);
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
    expect(forwardTarget(listeners[0]!.defaultAction).serviceLogicalId).toBe(SERVICE);
    expect(listeners[0]!.rules).toEqual([
      {
        priority: 10,
        pathPatterns: ['/api/*'],
        hostPatterns: [],
        httpHeaderConditions: [],
        httpRequestMethods: [],
        queryStringConditions: [],
        sourceIpCidrs: [],
        action: {
          kind: 'forward',
          targets: [
            {
              kind: 'ecs',
              serviceLogicalId: API_SERVICE,
              targetContainerName: 'api',
              targetContainerPort: 8080,
              targetGroupLogicalId: API_TG,
              weight: 1,
            },
          ],
        },
      },
    ]);
  });

  it('resolves a host-header condition (and an ANDed path-pattern) on a rule', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            { Field: 'host-header', HostHeaderConfig: { Values: ['api.example.com'] } },
            { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners[0]!.rules[0]!.pathPatterns).toEqual(['/api/*']);
    expect(listeners[0]!.rules[0]!.hostPatterns).toEqual(['api.example.com']);
    expect(forwardTarget(listeners[0]!.rules[0]!.action).serviceLogicalId).toBe(API_SERVICE);
  });

  it('resolves a host-header-only rule (no path constraint)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 5,
          Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['*.api.example.com'] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners[0]!.rules[0]!.pathPatterns).toEqual([]);
    expect(listeners[0]!.rules[0]!.hostPatterns).toEqual(['*.api.example.com']);
  });

  it('resolves a weighted (multi-target) forward into all targets with weights', () => {
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
                TargetGroups: [
                  { TargetGroupArn: { Ref: TG }, Weight: 80 },
                  { TargetGroupArn: { Ref: API_TG }, Weight: 20 },
                ],
              },
            },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    const action = listeners[0]!.defaultAction;
    expect(action?.kind).toBe('forward');
    if (action?.kind === 'forward') {
      expect(action.targets.map((t) => [ecsTarget(t).serviceLogicalId, t.weight])).toEqual([
        [SERVICE, 80],
        [API_SERVICE, 20],
      ]);
    }
  });

  it('resolves a redirect default action (HTTP_301 -> statusCode 301)', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'redirect',
              RedirectConfig: {
                Protocol: 'HTTPS',
                Host: 'new.example.com',
                Port: '443',
                Path: '/#{path}',
                Query: '#{query}',
                StatusCode: 'HTTP_301',
              },
            },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners[0]!.defaultAction).toEqual({
      kind: 'redirect',
      statusCode: 301,
      protocol: 'HTTPS',
      host: 'new.example.com',
      port: '443',
      path: '/#{path}',
      query: '#{query}',
    });
  });

  it('resolves a fixed-response default action (status / content-type / body)', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'fixed-response',
              FixedResponseConfig: {
                StatusCode: '410',
                ContentType: 'application/json',
                MessageBody: '{"gone":true}',
              },
            },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners[0]!.defaultAction).toEqual({
      kind: 'fixed-response',
      statusCode: 410,
      contentType: 'application/json',
      messageBody: '{"gone":true}',
    });
  });

  it('carries a Weight: 0 target through resolution (the seam to the 502 path)', () => {
    // The real synth can emit Weight: 0; it must survive into target.weight so
    // the front-door's "every weighted target has weight 0 -> 502" path fires.
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
                TargetGroups: [
                  { TargetGroupArn: { Ref: TG }, Weight: 0 },
                  { TargetGroupArn: { Ref: API_TG }, Weight: '0' },
                ],
              },
            },
          ],
        },
      },
    });
    const action = resolveAlbFrontDoor(stack, ALB).listeners[0]!.defaultAction;
    expect(action?.kind).toBe('forward');
    if (action?.kind === 'forward') {
      expect(action.targets.map((t) => t.weight)).toEqual([0, 0]);
    }
  });

  it('defaults a redirect with no StatusCode to 302', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'redirect', RedirectConfig: { Path: '/elsewhere' } }],
        },
      },
    });
    const action = resolveAlbFrontDoor(stack, ALB).listeners[0]!.defaultAction;
    expect(action).toMatchObject({ kind: 'redirect', statusCode: 302, path: '/elsewhere' });
  });

  it('warns and skips a redirect action with no RedirectConfig', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'redirect' }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/redirect/i);
  });

  it('defaults a fixed-response with no FixedResponseConfig to status 200', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'fixed-response' }],
        },
      },
    });
    const action = resolveAlbFrontDoor(stack, ALB).listeners[0]!.defaultAction;
    expect(action).toEqual({ kind: 'fixed-response', statusCode: 200 });
  });

  it('honors a forward terminal action preceded by an authenticate-* action', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            { Type: 'authenticate-cognito', AuthenticateCognitoConfig: {}, Order: 1 },
            { Type: 'forward', TargetGroupArn: { Ref: TG }, Order: 2 },
          ],
        },
      },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    expect(forwardTarget(listeners[0]!.defaultAction).serviceLogicalId).toBe(SERVICE);
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

  it('skips + warns on a rule with an unknown condition field', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'not-a-real-field', Values: ['x'] }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    // The listener still resolves via its default forward; only the rule is dropped.
    expect(listeners[0]!.rules).toEqual([]);
    expect(warnings.join('\n')).toMatch(/unsupported condition field 'not-a-real-field'/);
  });

  it('resolves an http-header condition (name + values)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            {
              Field: 'http-header',
              HttpHeaderConfig: { HttpHeaderName: 'X-Tenant', Values: ['acme', 'globex'] },
            },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners[0]!.rules[0]!.httpHeaderConditions).toEqual([
      { name: 'X-Tenant', values: ['acme', 'globex'] },
    ]);
  });

  it('ANDs multiple http-header conditions (different names)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Tenant', Values: ['acme'] } },
            { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Env', Values: ['prod'] } },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules[0]!.httpHeaderConditions).toEqual([
      { name: 'X-Tenant', values: ['acme'] },
      { name: 'X-Env', values: ['prod'] },
    ]);
  });

  it('skips + warns on an http-header condition with no HttpHeaderName / Values', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'http-header', HttpHeaderConfig: { Values: ['x'] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules).toEqual([]);
    expect(warnings.join('\n')).toMatch(/http-header condition with no HttpHeaderName/);
  });

  it('resolves an http-request-method condition (OR-matched values)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            {
              Field: 'http-request-method',
              HttpRequestMethodConfig: { Values: ['POST', 'PUT'] },
            },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules[0]!.httpRequestMethods).toEqual(['POST', 'PUT']);
  });

  it('resolves a query-string condition (Key+Value and bare-Value entries)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            {
              Field: 'query-string',
              QueryStringConfig: {
                Values: [{ Key: 'version', Value: '2' }, { Value: '*beta*' }],
              },
            },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules[0]!.queryStringConditions).toEqual([
      { key: 'version', value: '2' },
      { value: '*beta*' },
    ]);
  });

  it('skips + warns on a query-string condition whose entries are all malformed', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            {
              Field: 'query-string',
              // Non-string `Value` on the only entry -> 0 parseable entries.
              QueryStringConfig: { Values: [{ Key: 'v', Value: 42 }] },
            },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules).toEqual([]);
    expect(warnings.join('\n')).toMatch(/query-string condition has no parseable/);
  });

  it('resolves a source-ip condition (IPv4 + IPv6 CIDRs)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            {
              Field: 'source-ip',
              SourceIpConfig: { Values: ['10.0.0.0/8', '2001:db8::/32'] },
            },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners[0]!.rules[0]!.sourceIpCidrs).toEqual(['10.0.0.0/8', '2001:db8::/32']);
  });

  it('skips + warns on a source-ip condition with an unparseable CIDR', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            { Field: 'source-ip', SourceIpConfig: { Values: ['not-a-cidr', '10.0.0.0/8'] } },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules).toEqual([]);
    expect(warnings.join('\n')).toMatch(/unparseable CIDR\(s\): not-a-cidr/);
  });

  it('ANDs path-pattern + http-header + http-request-method + query-string + source-ip on one rule', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 5,
          Conditions: [
            { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } },
            { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-API', Values: ['v2'] } },
            { Field: 'http-request-method', HttpRequestMethodConfig: { Values: ['POST'] } },
            { Field: 'query-string', QueryStringConfig: { Values: [{ Key: 'v', Value: '1' }] } },
            { Field: 'source-ip', SourceIpConfig: { Values: ['10.0.0.0/8'] } },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    const rule = listeners[0]!.rules[0]!;
    expect(rule.pathPatterns).toEqual(['/api/*']);
    expect(rule.httpHeaderConditions).toEqual([{ name: 'X-API', values: ['v2'] }]);
    expect(rule.httpRequestMethods).toEqual(['POST']);
    expect(rule.queryStringConditions).toEqual([{ key: 'v', value: '1' }]);
    expect(rule.sourceIpCidrs).toEqual(['10.0.0.0/8']);
  });

  it('drops only the unsupported target group inside a weighted forward (others kept)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      LambdaTg: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: { TargetType: 'lambda' },
      },
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
                  { TargetGroupArn: { Ref: API_TG }, Weight: 70 },
                  { TargetGroupArn: { Ref: 'LambdaTg' }, Weight: 30 },
                ],
              },
            },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    const action = listeners[0]!.defaultAction;
    expect(action?.kind).toBe('forward');
    if (action?.kind === 'forward') {
      // The Lambda target group is dropped; the ECS one survives.
      expect(action.targets.map((t) => ecsTarget(t).serviceLogicalId)).toEqual([API_SERVICE]);
    }
    expect(warnings.join('\n')).toMatch(/Lambda target group/);
  });

  it('serves a rules-only listener (fixed-response default + path rule)', () => {
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
    expect(listeners[0]!.defaultAction).toEqual({ kind: 'fixed-response', statusCode: 404 });
    expect(forwardTarget(listeners[0]!.rules[0]!.action).serviceLogicalId).toBe(API_SERVICE);
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

  it('serves an HTTPS listener with listenerProtocol=HTTPS (no warning)', () => {
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
    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.listenerProtocol).toBe('HTTPS');
    expect(listeners[0]!.listenerPort).toBe(443);
    expect(warnings).toEqual([]);
  });

  it('warns once when an HTTPS listener declares ACM Certificates (not retrievable locally)', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 443,
          Protocol: 'HTTPS',
          Certificates: [{ CertificateArn: 'arn:aws:acm:us-east-1:111:certificate/abc' }],
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/ACM Certificates/);
  });

  it('skips + warns on a non-HTTP/HTTPS listener (TLS / NLB-style)', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 443,
          Protocol: 'TLS',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/TLS/);
  });

  it('resolves a Lambda target group (default action) to its backing function (#123)', () => {
    const stack = stackWith({
      [TG]: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          TargetType: 'lambda',
          Targets: [{ Id: { 'Fn::GetAtt': ['EchoFn1234', 'Arn'] } }],
        },
      },
      // No ECS service references the TG; the function is the backing target.
      [SERVICE]: undefined,
      EchoFn1234: { Type: 'AWS::Lambda::Function', Properties: {} },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners).toHaveLength(1);
    expect(forwardTargetRaw(listeners[0]!.defaultAction)).toEqual({
      kind: 'lambda',
      lambdaLogicalId: 'EchoFn1234',
      targetGroupLogicalId: TG,
      multiValueHeaders: false,
      weight: 1,
    });
  });

  it('honors the lambda.multi_value_headers.enabled target-group attribute (#123)', () => {
    const stack = stackWith({
      [TG]: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          TargetType: 'lambda',
          Targets: [{ Id: { 'Fn::GetAtt': ['EchoFn1234', 'Arn'] } }],
          TargetGroupAttributes: [
            { Key: 'lambda.multi_value_headers.enabled', Value: 'true' },
            { Key: 'other.attr', Value: 'x' },
          ],
        },
      },
      [SERVICE]: undefined,
      EchoFn1234: { Type: 'AWS::Lambda::Function', Properties: {} },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    const target = forwardTargetRaw(listeners[0]!.defaultAction);
    expect(target.kind).toBe('lambda');
    expect((target as { multiValueHeaders: boolean }).multiValueHeaders).toBe(true);
  });

  it('resolves a Lambda target via a Ref (function-name) registration (#123)', () => {
    const stack = stackWith({
      [TG]: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          TargetType: 'lambda',
          Targets: [{ Id: { Ref: 'EchoFn1234' } }],
        },
      },
      [SERVICE]: undefined,
      EchoFn1234: { Type: 'AWS::Lambda::Function', Properties: {} },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(
      (forwardTargetRaw(listeners[0]!.defaultAction) as { lambdaLogicalId: string }).lambdaLogicalId
    ).toBe('EchoFn1234');
  });

  it('warns when a Lambda target group registration is a non-in-stack ARN (#123)', () => {
    const stack = stackWith({
      [TG]: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          TargetType: 'lambda',
          Targets: [{ Id: 'arn:aws:lambda:us-east-1:111122223333:function:imported' }],
        },
      },
      [SERVICE]: undefined,
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/in-stack Lambda target only/);
  });

  it('warns when a Lambda target group references a missing function logical id (#123)', () => {
    const stack = stackWith({
      [TG]: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          TargetType: 'lambda',
          Targets: [{ Id: { 'Fn::GetAtt': ['GhostFn', 'Arn'] } }],
        },
      },
      [SERVICE]: undefined,
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/no AWS::Lambda::Function with that logical id/);
  });

  it('routes a path-rule Lambda target alongside an ECS default (#123 mixed)', () => {
    const stack = stackWith({
      ...apiServiceResources, // ApiService not used here; the rule forwards to a Lambda TG
      [API_TG]: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          TargetType: 'lambda',
          Targets: [{ Id: { 'Fn::GetAtt': ['ApiFn', 'Arn'] } }],
        },
      },
      [API_SERVICE]: undefined,
      ApiFn: { Type: 'AWS::Lambda::Function', Properties: {} },
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
    // Default still ECS (the web service), the /api/* rule routes to the Lambda.
    expect(forwardTargetRaw(listeners[0]!.defaultAction).kind).toBe('ecs');
    expect(listeners[0]!.rules).toHaveLength(1);
    expect(forwardTargetRaw(listeners[0]!.rules[0]!.action)).toEqual({
      kind: 'lambda',
      lambdaLogicalId: 'ApiFn',
      targetGroupLogicalId: API_TG,
      multiValueHeaders: false,
      weight: 1,
    });
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

  it('serves a redirect-only listener (no backing service) without warnings', () => {
    const stack = stackWith({
      // No backing service needed for a pure-redirect listener.
      [SERVICE]: undefined,
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
    expect(warnings).toEqual([]);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.defaultAction?.kind).toBe('redirect');
  });

  it('skips + warns on an authenticate-only default action (no terminal action)', () => {
    const stack = stackWith({
      [SERVICE]: undefined,
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'authenticate-oidc', AuthenticateOidcConfig: {} }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/authenticate-/);
  });

  it('warns when the forwarded target group is missing from the template', () => {
    const stack = stackWith({ [TG]: undefined });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/no AWS::ElasticLoadBalancingV2::TargetGroup/);
  });
});

describe('resolveAlbFrontDoor — authenticate-* guards', () => {
  const COGNITO_ARN = 'arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_abcDEF123';

  it('attaches a Cognito authGuard to the wrapped forward action', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'authenticate-cognito',
              AuthenticateCognitoConfig: {
                UserPoolArn: COGNITO_ARN,
                UserPoolClientId: 'client-abc',
                UserPoolDomain: 'auth.example.com',
              },
            },
            { Type: 'forward', TargetGroupArn: { Ref: TG } },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.defaultAction?.kind).toBe('forward');
    expect(listeners[0]!.defaultAuthGuard).toEqual({
      kind: 'authenticate-cognito',
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abcDEF123',
      audience: 'client-abc',
      region: 'us-east-1',
      userPoolId: 'us-east-1_abcDEF123',
      sessionCookieName: 'AWSELBAuthSessionCookie',
      label: 'authenticate-cognito (UserPool=us-east-1_abcDEF123)',
    });
  });

  it('attaches an OIDC authGuard to the wrapped fixed-response action', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'authenticate-oidc',
              AuthenticateOidcConfig: {
                Issuer: 'https://idp.example.com/',
                AuthorizationEndpoint: 'https://idp.example.com/authorize',
                TokenEndpoint: 'https://idp.example.com/token',
                ClientId: 'oidc-client-xyz',
                SessionCookieName: 'MyAuthCookie',
              },
            },
            {
              Type: 'fixed-response',
              FixedResponseConfig: { StatusCode: '200', MessageBody: 'ok' },
            },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners[0]!.defaultAction?.kind).toBe('fixed-response');
    expect(listeners[0]!.defaultAuthGuard).toEqual({
      kind: 'authenticate-oidc',
      // trailing slash stripped:
      issuer: 'https://idp.example.com',
      audience: 'oidc-client-xyz',
      sessionCookieName: 'MyAuthCookie',
      label: 'authenticate-oidc (Issuer=https://idp.example.com/)',
    });
  });

  it('attaches a Cognito authGuard to a ListenerRule action', () => {
    const RULE = 'AuthRule';
    const stack = stackWith({
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            { Field: 'path-pattern', PathPatternConfig: { Values: ['/secure/*'] } },
          ],
          Actions: [
            {
              Type: 'authenticate-cognito',
              AuthenticateCognitoConfig: {
                UserPoolArn: COGNITO_ARN,
                UserPoolClientId: 'client-abc',
                UserPoolDomain: 'auth.example.com',
              },
            },
            { Type: 'forward', TargetGroupArn: { Ref: TG } },
          ],
        },
      },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules).toHaveLength(1);
    expect(listeners[0]!.rules[0]!.authGuard?.kind).toBe('authenticate-cognito');
    expect(listeners[0]!.rules[0]!.action.kind).toBe('forward');
  });

  it('warns + skips guard when UserPoolArn is an intrinsic (Ref / GetAtt)', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'authenticate-cognito',
              AuthenticateCognitoConfig: {
                UserPoolArn: { Ref: 'MyPool' }, // intrinsic, not a literal
                UserPoolClientId: 'client-abc',
                UserPoolDomain: 'auth.example.com',
              },
            },
            { Type: 'forward', TargetGroupArn: { Ref: TG } },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    // The terminal forward still serves, but the guard is dropped + warned.
    expect(listeners[0]!.defaultAction?.kind).toBe('forward');
    expect(listeners[0]!.defaultAuthGuard).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/UserPoolArn .*literal strings/);
  });

  it('warns + skips guard when UserPoolArn is not in the expected shape', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'authenticate-cognito',
              AuthenticateCognitoConfig: {
                UserPoolArn: 'arn:aws:s3:::not-a-cognito-arn',
                UserPoolClientId: 'client-abc',
                UserPoolDomain: 'auth.example.com',
              },
            },
            { Type: 'forward', TargetGroupArn: { Ref: TG } },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.defaultAction?.kind).toBe('forward');
    expect(listeners[0]!.defaultAuthGuard).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/not in the expected/);
  });

  it('warns + skips listener when authenticate-* has no terminal action', () => {
    const stack = stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [
            {
              Type: 'authenticate-cognito',
              AuthenticateCognitoConfig: {
                UserPoolArn: COGNITO_ARN,
                UserPoolClientId: 'client-abc',
                UserPoolDomain: 'auth.example.com',
              },
            },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toEqual([]);
    expect(warnings.join('\n')).toMatch(/no local-servable terminal action/);
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
