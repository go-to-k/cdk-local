/**
 * go-to-k/cdk-local#761: elb-front-door-resolver's action-type and target-group
 * warnings. An assembly-chosen identifier prints bare when plain and as ONE
 * JSON literal when it could forge a boundary. Expected strings are written by
 * hand.
 */
import { describe, expect, it } from 'vite-plus/test';
import { resolveAlbFrontDoor } from '../../../src/local/elb-front-door-resolver.js';

const TG_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';

function warningsFor(opts: {
  stackName?: string;
  ruleId?: string;
  ruleActions: unknown[];
  extraTg?: string;
}): string {
  const resources: Record<string, unknown> = {
    Lb: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application' } },
    Tg: { Type: TG_TYPE, Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' } },
    L: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'Lb' },
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Tg' } }],
      },
    },
    Svc: {
      Type: 'AWS::ECS::Service',
      Properties: {
        LoadBalancers: [{ ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: 'Tg' } }],
      },
    },
    [opts.ruleId ?? 'R']: {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        ListenerArn: { Ref: 'L' },
        Priority: 10,
        Conditions: [{ Field: 'path-pattern', Values: ['/x'] }],
        Actions: opts.ruleActions,
      },
    },
  };
  if (opts.extraTg !== undefined) {
    resources[opts.extraTg] = {
      Type: TG_TYPE,
      Properties: { Port: 81, Protocol: 'HTTP', TargetType: 'ip' },
    };
  }
  const stack = { stackName: opts.stackName ?? 'AlbStack', template: { Resources: resources } } as never;
  return resolveAlbFrontDoor(stack, 'Lb').warnings.join('\n');
}

describe('elb-front-door-resolver action / target-group warnings (#761)', () => {
  it('unsupported action type: plain bare, forging quoted', () => {
    expect(warningsFor({ ruleActions: [{ Type: 'weird' }] })).toContain(
      'Listener rule R (priority 10) action uses an unsupported action type weird. The local ALB front-door supports forward / redirect / fixed-response actions only. Skipping it.'
    );
    expect(warningsFor({ ruleId: "r' x", ruleActions: [{ Type: "a' b" }] })).toContain(
      `Listener rule "r' x" (priority 10) action uses an unsupported action type "a' b". The local ALB front-door supports`
    );
  });

  it('forward to a missing target group: plain bare, forging quoted', () => {
    const fwd = (ref: string): unknown[] => [{ Type: 'forward', TargetGroupArn: { Ref: ref } }];
    expect(warningsFor({ ruleActions: fwd('Ghost') })).toContain(
      'Listener rule R (priority 10) action forwards to target group Ghost, but no AWS::ElasticLoadBalancingV2::TargetGroup with that logical id exists in AlbStack. Skipping that target group.'
    );
    expect(warningsFor({ stackName: 'x\u001b[2Kforged', ruleActions: fwd("a' b") })).toContain(
      `Listener rule R (priority 10) action forwards to target group "a' b", but no AWS::ElasticLoadBalancingV2::TargetGroup with that logical id exists in "x [2Kforged". Skipping that target group.`
    );
  });

  it('forward to a target group no ECS service references: plain bare, forging quoted', () => {
    const fwd = (ref: string): unknown[] => [{ Type: 'forward', TargetGroupArn: { Ref: ref } }];
    expect(warningsFor({ ruleActions: fwd('Orphan'), extraTg: 'Orphan' })).toContain(
      'Listener rule R (priority 10) action forwards to target group Orphan, which is not referenced by any AWS::ECS::Service.LoadBalancers[] in AlbStack; cdk-local has no ECS service to front behind it. Skipping that target group.'
    );
    expect(
      warningsFor({ stackName: "s' t", ruleActions: fwd("a' b"), extraTg: "a' b" })
    ).toContain(
      `Listener rule R (priority 10) action forwards to target group "a' b", which is not referenced by any AWS::ECS::Service.LoadBalancers[] in "s' t"; cdk-local has no ECS service to front behind it. Skipping that target group.`
    );
  });
});
