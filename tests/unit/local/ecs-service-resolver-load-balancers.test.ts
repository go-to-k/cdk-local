import { describe, it, expect } from 'vite-plus/test';
import { resolveEcsServiceTarget } from '../../../src/local/ecs-service-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// Locks that the service resolver surfaces LoadBalancers[] as
// ResolvedServiceLoadBalancer[] (Issue #86 v1) — replacing the old
// "LB emulation deferred" warning.

function stackWith(serviceProps: Record<string, unknown>): StackInfo {
  return {
    stackName: 'AlbStack',
    region: 'us-east-1',
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'web',
                Image: 'public.ecr.aws/docker/library/busybox:latest',
                PortMappings: [{ ContainerPort: 80, Protocol: 'tcp' }],
              },
            ],
          },
        },
        WebService: {
          Type: 'AWS::ECS::Service',
          Properties: { TaskDefinition: { Ref: 'TaskDef' }, ...serviceProps },
        },
      },
    },
  } as unknown as StackInfo;
}

describe('resolveEcsServiceTarget LoadBalancers parsing (#86)', () => {
  it('surfaces a canonical LoadBalancers[] entry with the resolved target group logical id', () => {
    const stack = stackWith({
      DesiredCount: 2,
      LoadBalancers: [
        { ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: 'WebTG' } },
      ],
    });
    const service = resolveEcsServiceTarget('AlbStack:WebService', [stack]);
    expect(service.loadBalancers).toEqual([
      { containerName: 'web', containerPort: 80, targetGroupLogicalId: 'WebTG' },
    ]);
    // No more "LB emulation deferred" warning.
    expect(service.warnings.join('\n')).not.toMatch(/load-balancer emulation is deferred/);
  });

  it('leaves targetGroupLogicalId undefined for a non-Ref target group arn', () => {
    const stack = stackWith({
      LoadBalancers: [
        {
          ContainerName: 'web',
          ContainerPort: 80,
          TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:111:targetgroup/x/abc',
        },
      ],
    });
    const service = resolveEcsServiceTarget('AlbStack:WebService', [stack]);
    expect(service.loadBalancers).toEqual([{ containerName: 'web', containerPort: 80 }]);
  });

  it('returns an empty array when the service has no load balancer', () => {
    const service = resolveEcsServiceTarget('AlbStack:WebService', [stackWith({})]);
    expect(service.loadBalancers).toEqual([]);
  });

  it('warns and skips a LoadBalancers[] entry missing ContainerName / ContainerPort', () => {
    const stack = stackWith({
      LoadBalancers: [{ TargetGroupArn: { Ref: 'WebTG' } }],
    });
    const service = resolveEcsServiceTarget('AlbStack:WebService', [stack]);
    expect(service.loadBalancers).toEqual([]);
    expect(service.warnings.join('\n')).toMatch(/without a usable ContainerName/);
  });
});
