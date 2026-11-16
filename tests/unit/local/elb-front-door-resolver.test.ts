import { describe, it, expect } from 'vite-plus/test';
import {
  resolveAlbFrontDoor,
  isApplicationLoadBalancer,
  type FrontDoorEcsTarget,
  type FrontDoorForwardTarget,
} from '../../../src/local/elb-front-door-resolver.js';
import { albHostPatternMatches } from '../../../src/local/alb-path-matcher.js';
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

  function ruleWithConditions(conditions: unknown[]): Record<string, unknown> {
    return {
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 1,
          Conditions: conditions,
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    };
  }

  it.each([
    ['list form', { 'Fn::GetAtt': [ALB, 'DNSName'] }],
    ['dotted string form', { 'Fn::GetAtt': `${ALB}.DNSName` }],
  ])(
    "turns a host-header value on this ALB's own DNSName (%s) into a match-all host",
    (_label, value) => {
      const stack = stackWith(
        ruleWithConditions([{ Field: 'host-header', HostHeaderConfig: { Values: [value] } }])
      );
      const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
      expect(warnings).toEqual([]);
      const rule = listeners[0]!.rules[0]!;
      expect(rule.hostPatterns).toEqual(['*']);
      expect(forwardTarget(rule.action).serviceLogicalId).toBe(API_SERVICE);
      for (const host of ['127.0.0.1:8088', 'localhost:8088', 'web.localhost', '192.168.1.5']) {
        expect(albHostPatternMatches(rule.hostPatterns[0]!, host)).toBe(true);
      }
    }
  );

  it('keeps literal host values next to the own-DNSName value', () => {
    const stack = stackWith(
      ruleWithConditions([
        {
          Field: 'host-header',
          HostHeaderConfig: { Values: ['api.example.com', { 'Fn::GetAtt': [ALB, 'DNSName'] }] },
        },
      ])
    );
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners[0]!.rules[0]!.hostPatterns).toEqual(['api.example.com', '*']);
  });

  it.each([
    ['host-header', 'HostHeaderConfig', { Ref: 'HostParam' }],
    ['host-header', 'HostHeaderConfig', { 'Fn::GetAtt': ['OtherLB', 'DNSName'] }],
    ['host-header', 'HostHeaderConfig', { 'Fn::GetAtt': [ALB, 'LoadBalancerFullName'] }],
    ['host-header', 'HostHeaderConfig', { 'Fn::Join': ['', ['api.', { Ref: 'Domain' }]] }],
    ['host-header', 'HostHeaderConfig', { 'Fn::ImportValue': 'SharedHost' }],
    ['http-request-method', 'HttpRequestMethodConfig', { Ref: 'MethodParam' }],
    ['source-ip', 'SourceIpConfig', { Ref: 'CidrParam' }],
  ])(
    'skips (with a warning) a rule whose %s value %j cannot be resolved, instead of widening it',
    (field, configKey, value) => {
      const stack = stackWith(
        ruleWithConditions([
          { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } },
          { Field: field, [configKey]: { Values: [value] } },
        ])
      );
      const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
      expect(listeners[0]!.rules).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining(`has a ${field} condition value that is not a literal string`),
      ]);
    }
  );

  it('keeps the path constraint of an own-DNSName host rule', () => {
    const stack = stackWith(
      ruleWithConditions([
        { Field: 'path-pattern', PathPatternConfig: { Values: ['/own/*'] } },
        { Field: 'host-header', HostHeaderConfig: { Values: [{ 'Fn::GetAtt': [ALB, 'DNSName'] }] } },
      ])
    );
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(warnings).toEqual([]);
    expect(listeners[0]!.rules[0]!.pathPatterns).toEqual(['/own/*']);
    expect(listeners[0]!.rules[0]!.hostPatterns).toEqual(['*']);
  });

  it.each([
    ['host-header', { HostHeaderConfig: { Values: { 'Fn::Split': [',', { Ref: 'Hosts' }] } } }],
    ['host-header', { HostHeaderConfig: { 'Fn::If': ['Cond', { Values: ['a'] }, { Values: ['b'] }] } }],
    ['host-header', { Values: { Ref: 'Hosts' } }],
    ['query-string', { QueryStringConfig: { Values: [{ Key: { Ref: 'KeyParam' }, Value: 'x' }] } }],
    [
      'query-string',
      {
        QueryStringConfig: {
          Values: [
            { Key: 'a', Value: '1' },
            { Key: 'env', Value: { Ref: 'EnvParam' } },
          ],
        },
      },
    ],
    ['query-string', { QueryStringConfig: { Values: { 'Fn::Split': [',', { Ref: 'Qs' }] } } }],
  ])(
    'skips (with a warning) a rule whose %s value list %j is not literal, instead of widening it',
    (field, config) => {
      const stack = stackWith(
        ruleWithConditions([
          { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } },
          { Field: field, ...config },
        ])
      );
      const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
      expect(listeners[0]!.rules).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining(`has a ${field} condition value that is not a literal string`),
      ]);
    }
  );

  it('skips (with a warning) a rule whose path-pattern value cannot be resolved', () => {
    const stack = stackWith(
      ruleWithConditions([
        { Field: 'host-header', HostHeaderConfig: { Values: ['api.example.com'] } },
        { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*', { Ref: 'PathParam' }] } },
      ])
    );
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules).toEqual([]);
    expect(warnings).toEqual([
      expect.stringContaining('has a path-pattern condition value that is not a literal string'),
    ]);
  });

  it('skips (with a warning) a rule whose http-header value cannot be resolved', () => {
    const stack = stackWith(
      ruleWithConditions([
        { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } },
        {
          Field: 'http-header',
          HttpHeaderConfig: { HttpHeaderName: 'X-Env', Values: ['dev', { Ref: 'EnvParam' }] },
        },
      ])
    );
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('http-header condition')]);
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
    expect(warnings.join('\n')).toMatch(/unsupported condition field not-a-real-field/);
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

  // #1004: a declared guard is never dropped. An intrinsic config yields the
  // placeholder guard carrying `pending` (resolved once state loads); an
  // unusable literal or a missing config yields the placeholder, warned.
  function listenerWith(defaultAction: Record<string, unknown>): StackInfo {
    return stackWith({
      [LISTENER]: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: ALB },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [defaultAction, { Type: 'forward', TargetGroupArn: { Ref: TG } }],
        },
      },
    });
  }

  it('keeps a pending placeholder guard when UserPoolArn / UserPoolClientId are intrinsics', () => {
    const { listeners, warnings } = resolveAlbFrontDoor(
      listenerWith({
        Type: 'authenticate-cognito',
        AuthenticateCognitoConfig: {
          UserPoolArn: { 'Fn::GetAtt': ['MyPool', 'Arn'] },
          UserPoolClientId: { Ref: 'MyClient' },
          UserPoolDomain: { Ref: 'MyDomain' },
        },
      }),
      ALB
    );
    expect(warnings).toEqual([]);
    expect(listeners[0]!.defaultAction?.kind).toBe('forward');
    const guard = listeners[0]!.defaultAuthGuard!;
    expect(guard.kind).toBe('authenticate-cognito');
    expect(guard.issuer).toMatch(/^https:\/\/cognito-idp\.us-east-1\.amazonaws\.com\/us-east-1_.*placeholderWebListener$/);
    expect(guard.region).toBe('us-east-1');
    expect(guard.userPoolId).toMatch(/placeholderWebListener$/);
    expect(guard.audience).toBeUndefined();
    expect(guard.pending).toEqual({
      stackName: 'AlbStack',
      siteLogicalId: LISTENER,
      location: expect.stringContaining('default action'),
      primary: { 'Fn::GetAtt': ['MyPool', 'Arn'] },
      audience: { Ref: 'MyClient' },
    });
  });

  it('keeps a placeholder guard (warned) when the literal UserPoolArn is malformed', () => {
    const { listeners, warnings } = resolveAlbFrontDoor(
      listenerWith({
        Type: 'authenticate-cognito',
        AuthenticateCognitoConfig: {
          UserPoolArn: 'arn:aws:s3:::not-a-cognito-arn',
          UserPoolClientId: 'client-abc',
        },
      }),
      ALB
    );
    expect(listeners[0]!.defaultAction?.kind).toBe('forward');
    const guard = listeners[0]!.defaultAuthGuard!;
    expect(guard.label).toBe('authenticate-cognito (unresolved)');
    expect(guard.userPoolId).toMatch(/placeholder/);
    expect(guard.pending).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/not in the expected/);
    expect(warnings.join('\n')).toMatch(/still requires a Bearer token/);
    expect(warnings.join('\n')).toMatch(/--no-verify-auth/);
  });

  it('keeps a pending placeholder OIDC guard when Issuer is an intrinsic', () => {
    const { listeners, warnings } = resolveAlbFrontDoor(
      listenerWith({
        Type: 'authenticate-oidc',
        AuthenticateOidcConfig: {
          Issuer: { Ref: 'MyIssuer' },
          AuthorizationEndpoint: 'https://idp.example.com/authorize',
          TokenEndpoint: 'https://idp.example.com/token',
          ClientId: 'oidc-client-xyz',
        },
      }),
      ALB
    );
    expect(warnings).toEqual([]);
    const guard = listeners[0]!.defaultAuthGuard!;
    expect(guard.kind).toBe('authenticate-oidc');
    expect(guard.userPoolId).toMatch(/placeholder/);
    expect(guard.pending?.primary).toEqual({ Ref: 'MyIssuer' });
    expect(guard.pending?.audience).toBe('oidc-client-xyz');
  });

  it('keeps a placeholder guard (warned) when AuthenticateCognitoConfig / AuthenticateOidcConfig is missing', () => {
    for (const type of ['authenticate-cognito', 'authenticate-oidc']) {
      const { listeners, warnings } = resolveAlbFrontDoor(listenerWith({ Type: type }), ALB);
      expect(listeners[0]!.defaultAction?.kind).toBe('forward');
      expect(listeners[0]!.defaultAuthGuard?.label).toBe(`${type} (unresolved)`);
      expect(warnings.join('\n')).toMatch(/is missing Authenticate(Cognito|Oidc)Config/);
    }
  });

  it('keeps a placeholder guard (warned) when the literal OIDC Issuer is not an http(s):// URL', () => {
    for (const issuer of ['ftp://idp.example.com', 'idp.example.com', 'not a url']) {
      const { listeners, warnings } = resolveAlbFrontDoor(
        listenerWith({
          Type: 'authenticate-oidc',
          AuthenticateOidcConfig: { Issuer: issuer, ClientId: 'c' },
        }),
        ALB
      );
      expect(listeners[0]!.defaultAuthGuard?.label).toBe('authenticate-oidc (unresolved)');
      expect(warnings.join('\n')).toMatch(/is not an http:\/\/ or https:\/\/ URL/);
    }
  });

  it('keeps a placeholder guard (warned) when the literal OIDC Issuer is empty', () => {
    const { listeners, warnings } = resolveAlbFrontDoor(
      listenerWith({
        Type: 'authenticate-oidc',
        AuthenticateOidcConfig: { Issuer: '', ClientId: 'c' },
      }),
      ALB
    );
    expect(listeners[0]!.defaultAuthGuard?.label).toBe('authenticate-oidc (unresolved)');
    expect(warnings.join('\n')).toMatch(/empty string/);
  });

  it('verifies a plain-http OIDC Issuer, loopback or not (ALB rejects http on deploy, so it is a local IdP)', () => {
    for (const issuer of ['http://127.0.0.1:19000', 'http://idp.internal:8080']) {
      const { listeners, warnings } = resolveAlbFrontDoor(
        listenerWith({
          Type: 'authenticate-oidc',
          AuthenticateOidcConfig: { Issuer: issuer, ClientId: 'c' },
        }),
        ALB
      );
      expect(warnings).toEqual([]);
      const guard = listeners[0]!.defaultAuthGuard!;
      expect(guard.issuer).toBe(issuer);
      expect(guard.label).toBe(`authenticate-oidc (Issuer=${issuer})`);
    }
  });

  it('refuses a Cognito UserPoolArn whose region would steer the JWKS host', () => {
    for (const arn of [
      'arn:aws:cognito-idp:evil.example/x:123456789012:userpool/us-east-1_abcDEF123',
      'arn:aws:cognito-idp:evil.example:123456789012:userpool/us-east-1_abcDEF123',
      'arn:aws:cognito-idp:US-EAST-1:123456789012:userpool/us-east-1_abcDEF123',
    ]) {
      const { listeners, warnings } = resolveAlbFrontDoor(
        listenerWith({
          Type: 'authenticate-cognito',
          AuthenticateCognitoConfig: { UserPoolArn: arn, UserPoolClientId: 'c' },
        }),
        ALB
      );
      const guard = listeners[0]!.defaultAuthGuard!;
      expect(guard.label).toBe('authenticate-cognito (unresolved)');
      expect(guard.issuer).not.toContain('evil');
      expect(warnings.join('\n')).toMatch(/is not in the expected/);
    }
  });

  it('fails closed on a default action whose Type is not a literal string (the listener default is not served)', () => {
    const fnIfType = {
      Type: { 'Fn::If': ['UseAuth', 'authenticate-cognito', 'fixed-response'] },
      AuthenticateCognitoConfig: { UserPoolArn: COGNITO_ARN, UserPoolClientId: 'c' },
    };
    const wrappedAction = {
      'Fn::If': [
        'UseAuth',
        {
          Type: 'authenticate-cognito',
          AuthenticateCognitoConfig: { UserPoolArn: COGNITO_ARN, UserPoolClientId: 'c' },
        },
        { Ref: 'AWS::NoValue' },
      ],
    };
    for (const action of [fnIfType, wrappedAction]) {
      const { listeners, warnings } = resolveAlbFrontDoor(listenerWith(action), ALB);
      // Without the fail-closed check, the trailing forward is served unguarded.
      expect(listeners).toEqual([]);
      expect(warnings.join('\n')).toMatch(/Type is not a literal string.*fail closed/s);
    }
  });

  it('fails closed on a rule action whose Type is not a literal string (the rule stays at its priority as a 503 deny, the default still served)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
          Actions: [
            { Type: { 'Fn::If': ['UseAuth', 'authenticate-oidc', 'forward'] } },
            { Type: 'forward', TargetGroupArn: { Ref: API_TG } },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners).toHaveLength(1);
    // Dropping the rule would let `/api/*` fall through to the unguarded
    // default; it must keep claiming its path with a guard-less 503 deny.
    expect(listeners[0]!.rules).toHaveLength(1);
    const rule = listeners[0]!.rules[0]!;
    expect(rule.priority).toBe(10);
    expect(rule.pathPatterns).toEqual(['/api/*']);
    expect(rule.authGuard).toBeUndefined();
    expect(rule.action).toEqual({
      kind: 'fixed-response',
      statusCode: 503,
      contentType: 'text/plain',
      messageBody: expect.stringMatching(/denied locally because an action Type is not a literal string/),
    });
    expect(forwardTarget(listeners[0]!.defaultAction).serviceLogicalId).toBe(SERVICE);
    expect(listeners[0]!.defaultAuthGuard).toBeUndefined();
    expect(warnings.join('\n')).toMatch(
      /ApiRule.*Type is not a literal string.*kept at its priority as a local 503 deny/s
    );
  });

  it('keeps a guarded rule whose terminal is not servable as a 503 deny (no fallthrough to the default)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/admin/*'] } }],
          Actions: [
            {
              Type: 'authenticate-cognito',
              AuthenticateCognitoConfig: { UserPoolArn: COGNITO_ARN, UserPoolClientId: 'c' },
            },
            { Type: 'forward', TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/x/y' },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    const rule = listeners[0]!.rules[0]!;
    expect(rule.pathPatterns).toEqual(['/admin/*']);
    expect(rule.authGuard).toBeUndefined();
    expect(rule.action).toMatchObject({ kind: 'fixed-response', statusCode: 503 });
    expect(warnings.join('\n')).toMatch(
      /ApiRule.*no local-servable terminal action, so the rule is kept at its priority as a local 503 deny/s
    );
  });

  it('keeps a guarded rule with an unsupported condition as a 503 deny over its supported conditions', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [
            { Field: 'path-pattern', PathPatternConfig: { Values: ['/admin/*'] } },
            { Field: 'host-header', HostHeaderConfig: { Values: [{ Ref: 'DomainParam' }] } },
          ],
          Actions: [
            {
              Type: 'authenticate-cognito',
              AuthenticateCognitoConfig: { UserPoolArn: COGNITO_ARN, UserPoolClientId: 'c' },
            },
            { Type: 'forward', TargetGroupArn: { Ref: API_TG } },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    const rule = listeners[0]!.rules[0]!;
    // The host-header field is dropped whole: the deny covers /admin/* on any host.
    expect(rule.pathPatterns).toEqual(['/admin/*']);
    expect(rule.hostPatterns).toEqual([]);
    expect(rule.authGuard).toBeUndefined();
    expect(rule.action).toMatchObject({ kind: 'fixed-response', statusCode: 503 });
    const text = warnings.join('\n');
    expect(text).toMatch(/host-header condition value that is not a literal string.*kept as a local 503 deny instead/s);
    expect(text).toMatch(/over its remaining supported conditions/);
  });

  it('denies every request at its priority when a guarded rule has no supported condition left', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: [{ Ref: 'PathParam' }] } }],
          Actions: [
            { Type: { 'Fn::If': ['UseAuth', 'authenticate-oidc', 'forward'] } },
            { Type: 'forward', TargetGroupArn: { Ref: API_TG } },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    const rule = listeners[0]!.rules[0]!;
    expect(rule.pathPatterns).toEqual([]);
    expect(rule.action).toMatchObject({ kind: 'fixed-response', statusCode: 503 });
    expect(warnings.join('\n')).toMatch(/over every request that reaches its priority/);
  });

  it('still skips an unguarded rule with an unsupported condition (no guard to lose)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: [{ Ref: 'PathParam' }] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules).toEqual([]);
    expect(warnings.join('\n')).toMatch(/not a literal string.*skipping the rule\./s);
  });

  it('keeps a rule whose whole Actions value is not an array as a 503 deny at its priority', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
          Actions: {
            'Fn::If': [
              'UseAuth',
              [{ Type: 'authenticate-oidc' }, { Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
              [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
            ],
          },
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    const rule = listeners[0]!.rules[0]!;
    expect(rule.priority).toBe(10);
    expect(rule.pathPatterns).toEqual(['/api/*']);
    expect(rule.authGuard).toBeUndefined();
    expect(rule.action).toMatchObject({
      kind: 'fixed-response',
      statusCode: 503,
      messageBody: expect.stringMatching(/its Actions value is not a literal array/),
    });
    expect(forwardTarget(listeners[0]!.defaultAction).serviceLogicalId).toBe(SERVICE);
    expect(warnings.join('\n')).toMatch(
      /ApiRule.*action is not a literal array.*kept at its priority as a local 503 deny/s
    );
  });

  it('denies every request at its priority when a guarded rule has a whole Conditions value that is not an array', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: {
            'Fn::If': ['Prod', [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/a/*'] } }], []],
          },
          Actions: [
            {
              Type: 'authenticate-cognito',
              AuthenticateCognitoConfig: { UserPoolArn: COGNITO_ARN, UserPoolClientId: 'c' },
            },
            { Type: 'forward', TargetGroupArn: { Ref: API_TG } },
          ],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    const rule = listeners[0]!.rules[0]!;
    expect(rule.priority).toBe(10);
    expect(rule.pathPatterns).toEqual([]);
    expect(rule.hostPatterns).toEqual([]);
    expect(rule.authGuard).toBeUndefined();
    expect(rule.action).toMatchObject({ kind: 'fixed-response', statusCode: 503 });
    const text = warnings.join('\n');
    expect(text).toMatch(/ApiRule.*Conditions value that is not a literal array.*kept as a local 503 deny instead/s);
    expect(text).toMatch(/over every request that reaches its priority/);
  });

  it('denies every request at its priority when both the whole Actions and Conditions values are not arrays', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: { 'Fn::If': ['Prod', [], []] },
          Actions: { 'Fn::If': ['UseAuth', [], []] },
        },
      },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    const rule = listeners[0]!.rules[0]!;
    expect(rule.pathPatterns).toEqual([]);
    expect(rule.action).toMatchObject({ kind: 'fixed-response', statusCode: 503 });
  });

  it('still skips (warned) an unguarded rule whose whole Conditions value is not an array', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 10,
          Conditions: { 'Fn::If': ['Prod', [], []] },
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules).toEqual([]);
    expect(warnings.join('\n')).toMatch(/ApiRule.*Conditions value that is not a literal array.*skipping the rule\./s);
  });

  it('sorts a guarded rule with an intrinsic Priority before every literal-priority rule (warned)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: { Ref: 'AdminPriority' },
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/admin/*'] } }],
          Actions: [
            {
              Type: 'authenticate-cognito',
              AuthenticateCognitoConfig: { UserPoolArn: COGNITO_ARN, UserPoolClientId: 'c' },
            },
            { Type: 'forward', TargetGroupArn: { Ref: API_TG } },
          ],
        },
      },
      OpenRule: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: 1,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/*'] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    const ordered = [...listeners[0]!.rules].sort((a, b) => a.priority - b.priority);
    expect(ordered).toHaveLength(2);
    expect(ordered[0]!.pathPatterns).toEqual(['/admin/*']);
    expect(ordered[0]!.authGuard?.kind).toBe('authenticate-cognito');
    expect(ordered[0]!.priority).toBeLessThan(1);
    expect(ordered[1]!.priority).toBe(1);
    expect(warnings.join('\n')).toMatch(
      /ApiRule \(Priority not a literal number\) carries \(or may carry\) an authenticate-\* action, so it is evaluated before every other rule/
    );
  });

  it('sorts a deny rule (whole Actions intrinsic) with an intrinsic Priority first', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: { Ref: 'AdminPriority' },
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/admin/*'] } }],
          Actions: { 'Fn::If': ['UseAuth', [], []] },
        },
      },
    });
    const { listeners } = resolveAlbFrontDoor(stack, ALB);
    const rule = listeners[0]!.rules[0]!;
    expect(rule.priority).toBeLessThan(1);
    expect(rule.action).toMatchObject({ kind: 'fixed-response', statusCode: 503 });
  });

  it('still sorts an unguarded rule with an intrinsic Priority last (no promotion warning)', () => {
    const stack = stackWith({
      ...apiServiceResources,
      [RULE]: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: { Ref: LISTENER },
          Priority: { Ref: 'ApiPriority' },
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: API_TG } }],
        },
      },
    });
    const { listeners, warnings } = resolveAlbFrontDoor(stack, ALB);
    expect(listeners[0]!.rules[0]!.priority).toBe(Number.MAX_SAFE_INTEGER);
    expect(warnings.join('\n')).not.toMatch(/evaluated before every other rule/);
  });

  it('keeps the real guard with the audience unchecked (warned) when the literal client id is empty', () => {
    const { listeners, warnings } = resolveAlbFrontDoor(
      listenerWith({
        Type: 'authenticate-cognito',
        AuthenticateCognitoConfig: { UserPoolArn: COGNITO_ARN, UserPoolClientId: '' },
      }),
      ALB
    );
    const guard = listeners[0]!.defaultAuthGuard!;
    expect(guard.userPoolId).toBe('us-east-1_abcDEF123');
    expect(guard.audience).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/UserPoolClientId could not be resolved/);
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
