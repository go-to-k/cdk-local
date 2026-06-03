import { describe, it, expect } from 'vitest';
import {
  isCustomResourceLambdaTarget,
  filterStudioCustomResources,
} from '../../../src/local/studio-custom-resource-filter.js';
import type { StudioTarget, StudioTargetGroup } from '../../../src/local/studio-server.js';

const lambda = (id: string, qualifiedId = `Stack:${id.replace(/\//g, '')}`): StudioTarget => ({
  id,
  qualifiedId,
});

describe('isCustomResourceLambdaTarget', () => {
  // Each well-known CDK-generated construct must be classified as a
  // custom-resource Lambda (matched against id / qualifiedId, case-insensitive).
  it.each([
    'MyStack/Provider/framework-onEvent',
    'MyStack/Provider/framework-onTimeout',
    'MyStack/Provider/framework-isComplete',
    'MyStack/MyResource/Provider/Handler',
    'MyStack/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a',
    'MyStack/BucketNotificationsHandler050a0587b7544547bf325f094a3db834',
    'MyStack/AwsCustomResource',
    'MyStack/CustomResourceProvider',
    'MyStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C',
  ])('matches %s', (id) => {
    expect(isCustomResourceLambdaTarget(lambda(id))).toBe(true);
  });

  it('matches the singleton AwsCustomResource provider logical id via qualifiedId', () => {
    expect(
      isCustomResourceLambdaTarget({
        id: 'MyStack/AWS679f53fac002430cb0da5b7982bd2287',
        qualifiedId: 'MyStack:AWS679f53fac002430cb0da5b7982bd2287',
      })
    ).toBe(true);
  });

  it('matches CDKMetadata', () => {
    expect(isCustomResourceLambdaTarget(lambda('MyStack/CDKMetadata'))).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isCustomResourceLambdaTarget(lambda('MyStack/Provider/FRAMEWORK-ONEVENT'))).toBe(true);
  });

  it('does NOT match a normal app Lambda', () => {
    expect(isCustomResourceLambdaTarget(lambda('MyStack/EchoHandler'))).toBe(false);
  });

  it('does NOT match another normal app Lambda whose name resembles nothing', () => {
    expect(isCustomResourceLambdaTarget(lambda('OrdersStack/CreateOrderFn'))).toBe(false);
  });
});

const groups = (): StudioTargetGroup[] => [
  {
    kind: 'lambda',
    title: 'Lambda Functions',
    entries: [
      lambda('MyStack/EchoHandler'),
      lambda('MyStack/Provider/framework-onEvent'),
      lambda('MyStack/LogRetentionaae0aa3c'),
      lambda('MyStack/CreateOrderFn'),
    ],
  },
  {
    kind: 'api',
    title: 'APIs',
    entries: [lambda('MyStack/Api')],
  },
  {
    kind: 'ecs',
    title: 'ECS Services',
    entries: [lambda('MyStack/Service')],
  },
  {
    kind: 'alb',
    title: 'Load Balancers',
    entries: [lambda('MyStack/Alb')],
  },
  {
    kind: 'agentcore',
    title: 'AgentCore Runtimes',
    entries: [lambda('MyStack/Agent')],
  },
];

describe('filterStudioCustomResources', () => {
  it('drops custom-resource / provider Lambdas from the lambda group by default', () => {
    const result = filterStudioCustomResources(groups());
    const lambdaGroup = result.find((g) => g.kind === 'lambda');
    expect(lambdaGroup?.entries.map((e) => e.id)).toEqual([
      'MyStack/EchoHandler',
      'MyStack/CreateOrderFn',
    ]);
  });

  it('keeps custom-resource Lambdas when include:true', () => {
    const result = filterStudioCustomResources(groups(), { include: true });
    const lambdaGroup = result.find((g) => g.kind === 'lambda');
    expect(lambdaGroup?.entries).toHaveLength(4);
  });

  it('returns the same array reference when include:true (no-op)', () => {
    const input = groups();
    expect(filterStudioCustomResources(input, { include: true })).toBe(input);
  });

  it('leaves non-lambda groups (api / ecs / alb / agentcore) untouched', () => {
    const result = filterStudioCustomResources(groups());
    for (const kind of ['api', 'ecs', 'alb', 'agentcore'] as const) {
      const before = groups().find((g) => g.kind === kind)?.entries;
      const after = result.find((g) => g.kind === kind)?.entries;
      expect(after).toEqual(before);
    }
  });

  it('does not mutate the input groups', () => {
    const input = groups();
    filterStudioCustomResources(input);
    expect(input.find((g) => g.kind === 'lambda')?.entries).toHaveLength(4);
  });
});
