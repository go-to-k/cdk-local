import { describe, it, expect } from 'vite-plus/test';
import {
  extractServiceProperties,
  type ResolveServiceOptions,
} from '../../../src/local/ecs-service-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

function stackWithService(): { stack: StackInfo; resource: TemplateResource } {
  const taskDef: TemplateResource = {
    Type: 'AWS::ECS::TaskDefinition',
    Properties: {
      Family: 'web',
      NetworkMode: 'awsvpc',
      ContainerDefinitions: [
        { Name: 'web', Image: 'public.ecr.aws/docker/library/nginx:1.27' },
      ],
    },
  };
  const service: TemplateResource = {
    Type: 'AWS::ECS::Service',
    Properties: {
      TaskDefinition: { Ref: 'WebTaskDef' },
      DesiredCount: 1,
      LoadBalancers: [{ ContainerName: 'web', ContainerPort: 80, TargetGroupArn: 'arn:tg' }],
    },
  };
  const stack = {
    stackName: 'S',
    template: {
      Resources: {
        WebTaskDef: taskDef,
        WebService: service,
      },
    },
  } as unknown as StackInfo;
  return { stack, resource: service };
}

function extract(options?: ResolveServiceOptions): string[] {
  const { stack, resource } = stackWithService();
  return extractServiceProperties(stack, 'WebService', resource, [stack], undefined, options)
    .warnings;
}

describe('ecs-service-resolver LoadBalancers warning', () => {
  it('emits a current-text hint pointing at `start-alb` under the default (start-service) path', () => {
    const warnings = extract();
    expect(warnings).toHaveLength(1);
    const w = warnings[0]!;
    // The warning must NOT carry the stale "deferred to a follow-up PR" wording.
    expect(w).not.toMatch(/deferred to a follow-up PR/);
    // It must mention the booted service name + the command surface that
    // would emulate the LB locally, so the user has an actionable next step.
    expect(w).toContain("ECS Service 'WebService'");
    expect(w).toMatch(/start-service/);
    expect(w).toMatch(/start-alb/);
  });

  it('suppresses the LB warning when called via the start-alb path (suppressLoadBalancerWarning: true)', () => {
    const warnings = extract({ suppressLoadBalancerWarning: true });
    expect(warnings.filter((w) => w.includes('LoadBalancers'))).toEqual([]);
  });

  it('omits the LB warning entirely when the Service declares no LoadBalancers (no false positive under either mode)', () => {
    const stack = {
      stackName: 'S',
      template: {
        Resources: {
          WebTaskDef: {
            Type: 'AWS::ECS::TaskDefinition',
            Properties: {
              Family: 'web',
              NetworkMode: 'awsvpc',
              ContainerDefinitions: [
                { Name: 'web', Image: 'public.ecr.aws/docker/library/nginx:1.27' },
              ],
            },
          },
          WebService: {
            Type: 'AWS::ECS::Service',
            Properties: { TaskDefinition: { Ref: 'WebTaskDef' }, DesiredCount: 1 },
          },
        },
      },
    } as unknown as StackInfo;
    const noLb = stack.template.Resources!['WebService']!;
    expect(
      extractServiceProperties(stack, 'WebService', noLb, [stack]).warnings.filter((w) =>
        w.includes('LoadBalancers')
      )
    ).toEqual([]);
    expect(
      extractServiceProperties(stack, 'WebService', noLb, [stack], undefined, {
        suppressLoadBalancerWarning: true,
      }).warnings.filter((w) => w.includes('LoadBalancers'))
    ).toEqual([]);
  });
});
