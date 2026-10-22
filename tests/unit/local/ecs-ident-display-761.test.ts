import { describe, it, expect } from 'vite-plus/test';

// go-to-k/cdk-local#761 (S3): identifiers the assembly chose render bare when
// plain and as ONE JSON string literal when they could forge a boundary.
// Expected strings are computed by hand, never by calling the display helper.

import { resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';
import { resolveEcsServiceTarget } from '../../../src/local/ecs-service-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function stackOf(resources: Record<string, unknown>, stackName = 'S'): StackInfo {
  return { stackName, displayName: stackName, template: { Resources: resources } } as never;
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a throw');
}

function taskStack(containers: unknown[], extraProps: Record<string, unknown> = {}): StackInfo {
  return stackOf({
    Task: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: { ContainerDefinitions: containers, ...extraProps },
    },
  });
}

describe('ecs-task-resolver renders container / task identifiers (#761)', () => {
  it('prints plain container names bare in a dependsOn error', () => {
    const stack = taskStack([
      { Name: 'web', Image: 'nginx', DependsOn: [{ ContainerName: 'db', Condition: 'START' }] },
    ]);
    const msg = messageOf(() => resolveEcsTaskTarget('S:Task', [stack]));
    expect(msg).toBe('Container web depends on db, which is not defined in task Task.');
  });

  it('prints a forging container name and dependency as JSON literals', () => {
    const stack = taskStack([
      {
        Name: "a' b",
        Image: 'nginx',
        DependsOn: [{ ContainerName: 'x\u001b[2Kforged', Condition: 'START' }],
      },
    ]);
    const msg = messageOf(() => resolveEcsTaskTarget('S:Task', [stack]));
    expect(msg).toBe(
      'Container "a\' b" depends on "x [2Kforged", which is not defined in task Task.'
    );
  });

  it('prints an unsupported NetworkMode as a JSON literal when it could forge', () => {
    const stack = taskStack([{ Name: 'web', Image: 'nginx' }], { NetworkMode: "a' b" });
    const msg = messageOf(() => resolveEcsTaskTarget('S:Task', [stack]));
    expect(msg).toContain(`Task definition Task has unsupported NetworkMode "a' b". `);
  });

  it('prefixes per-container warnings with the rendered container name', () => {
    const mk = (name: string) =>
      resolveEcsTaskTarget('S:Task', [
        taskStack([{ Name: name, Image: 'nginx', Environment: [{ Name: 'K', Value: { Ref: 'P' } }] }]),
      ]).warnings;
    expect(mk('web').some((w) => w.startsWith('Container web: Environment K dropped:'))).toBe(true);
    expect(mk("a' b").some((w) => w.startsWith(`Container "a' b": Environment K dropped:`))).toBe(
      true
    );
  });
});

describe('ecs-service-resolver renders service identifiers (#761)', () => {
  function serviceStack(logicalId: string, type: string): StackInfo {
    return stackOf({ [logicalId]: { Type: type, Properties: {} } });
  }

  it('prints a plain logical id bare', () => {
    const msg = messageOf(() =>
      resolveEcsServiceTarget('S:Svc', [serviceStack('Svc', 'AWS::ECS::TaskDefinition')])
    );
    expect(msg).toContain('Resource Svc in S is an ECS TaskDefinition, not a Service.');
  });

  it('prints a forging logical id as a JSON literal', () => {
    const msg = messageOf(() =>
      resolveEcsServiceTarget("S:a' b", [serviceStack("a' b", 'AWS::ECS::TaskDefinition')])
    );
    expect(msg).toContain(`Resource "a' b" in S is an ECS TaskDefinition, not a Service.`);
  });

  it('prints a missing TaskDefinition Ref bare, or as a JSON literal when forging', () => {
    const mk = (ref: string) =>
      messageOf(() =>
        resolveEcsServiceTarget('S:Svc', [
          stackOf({
            Svc: { Type: 'AWS::ECS::Service', Properties: { TaskDefinition: { Ref: ref } } },
          }),
        ])
      );
    expect(mk('Td')).toContain('ECS Service Svc references TaskDefinition Td but no such resource');
    expect(mk('x\u001b[2Kforged')).toContain(
      'ECS Service Svc references TaskDefinition "x [2Kforged" but no such resource'
    );
  });
});
