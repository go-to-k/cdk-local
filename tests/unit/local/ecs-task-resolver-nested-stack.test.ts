import { describe, it, expect } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';

const taskDef = {
  Type: 'AWS::ECS::TaskDefinition',
  Properties: {
    ContainerDefinitions: [
      { Name: 'app', Image: 'public.ecr.aws/docker/library/busybox:latest' },
    ],
  },
};

const App = {
  stackName: 'App',
  displayName: 'App',
  region: 'us-east-1',
  template: { Resources: { Bucket: { Type: 'AWS::S3::Bucket' } } },
} as unknown as StackInfo;

const Inner = {
  stackName: 'App~InnerNS',
  displayName: 'App/Inner',
  region: 'us-east-1',
  template: { Resources: { NestedTask: taskDef } },
  nestedStack: {
    parentStackName: 'App',
    rootStackName: 'App',
    logicalId: 'InnerNS',
    parameters: {},
  },
} as unknown as StackInfo;

describe('resolveEcsTaskTarget with a CDK nested stack (#986)', () => {
  it("resolves 'App:<task definition id only in the nested stack>' into the nested stack", () => {
    const task = resolveEcsTaskTarget('App:NestedTask', [App, Inner]);
    expect(task.stack).toBe(Inner);
    expect(task.taskDefinitionLogicalId).toBe('NestedTask');
    expect(task.containers.map((c) => c.name)).toEqual(['app']);
  });

  it('the not-found message lists a nested stack task definition', () => {
    expect(() => resolveEcsTaskTarget('App:Nope', [App, Inner])).toThrow(/NestedTask/);
  });
});
