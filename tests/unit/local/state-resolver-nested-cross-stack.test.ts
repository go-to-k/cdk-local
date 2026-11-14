import { describe, it, expect } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import {
  containsCrossStackIntrinsic,
  resolveWithSensitivityAsync,
  substituteAgainstStateAsync,
  type CrossStackResolver,
} from '../../../src/local/state-resolver.js';
import {
  applyCrossStackResolverToTask,
  assertEcsTaskCommandsResolved,
  detectEcsImageResolutionNeeds,
  resolveEcsTaskTarget,
} from '../../../src/local/ecs-task-resolver.js';
import { envHasCrossStackIntrinsic } from '../../../src/cli/commands/local-invoke.js';

// Issue #962: `substituteAgainstStateAsync` resolved `Fn::ImportValue` /
// `Fn::GetStackOutput` only at the TOP level. CDK synthesizes `Fn::Join` over
// an `Fn::ImportValue` whenever a cross-stack token is embedded in a longer
// string (`s3://${otherStack.bucket.bucketName}`), which was reported as an
// unsupported intrinsic even with a resolver that could answer.

const IMPORTED = 'producer-bucket';
const OUTPUT = 'https://producer.example.com';

const crossStackResolver: CrossStackResolver = {
  resolveImport: async (name) => (name === 'P-B' ? IMPORTED : undefined),
  resolveGetStackOutput: async (stack, region, output) =>
    stack === 'Producer' && region === 'us-east-1' && output === 'Url' ? OUTPUT : undefined,
};

describe('substituteAgainstStateAsync nested cross-stack intrinsics (issue #962)', () => {
  const context = { resources: {}, crossStackResolver, consumerRegion: 'us-east-1' };

  it('resolves Fn::ImportValue nested in Fn::Join', async () => {
    const r = await substituteAgainstStateAsync(
      { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'P-B' }, '/in']] },
      context
    );
    expect(r).toEqual({ kind: 'literal', value: `s3://${IMPORTED}/in` });
  });

  it('resolves Fn::GetStackOutput bound in an Fn::Sub variable map', async () => {
    const r = await substituteAgainstStateAsync(
      {
        'Fn::Sub': [
          '${Url}/health',
          { Url: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Url' } } },
        ],
      },
      context
    );
    expect(r).toEqual({ kind: 'literal', value: `${OUTPUT}/health` });
  });

  it('resolves a cross-stack intrinsic nested two levels deep (Fn::Select over Fn::Split)', async () => {
    const r = await substituteAgainstStateAsync(
      {
        'Fn::Select': [1, { 'Fn::Split': ['-', { 'Fn::ImportValue': 'P-B' }] }],
      },
      context
    );
    expect(r).toEqual({ kind: 'literal', value: 'bucket' });
  });

  it('reports the nested lookup failure, not an unsupported intrinsic', async () => {
    const r = await substituteAgainstStateAsync(
      { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'Nope' }]] },
      context
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain('export not found');
      expect(r.reason).not.toContain('unsupported intrinsic');
    }
  });

  it('reports a missing resolver with its remedy', async () => {
    const r = await substituteAgainstStateAsync(
      { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'P-B' }]] },
      { resources: {} }
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') expect(r.reason).toContain('no cross-stack resolver supplied');
  });

  it('marks the value sensitive when a nested cross-stack value was a dynamic reference', async () => {
    const { result, consumedSensitive } = await resolveWithSensitivityAsync(
      { 'Fn::Join': ['', ['pw=', { 'Fn::ImportValue': 'P-B' }]] },
      {
        resources: {},
        consumerRegion: 'us-east-1',
        crossStackResolver: {
          resolveImport: async () => '{{resolve:secretsmanager:S}}',
          resolveGetStackOutput: async () => undefined,
        },
        resolveDynamicReferences: async () => 'plain',
      }
    );
    expect(result).toEqual({ kind: 'literal', value: 'pw=plain' });
    expect(consumedSensitive).toBe(true);
  });

  it('containsCrossStackIntrinsic sees a nested one and ignores same-stack intrinsics', () => {
    expect(containsCrossStackIntrinsic({ 'Fn::ImportValue': 'X' })).toBe(true);
    expect(containsCrossStackIntrinsic({ 'Fn::Join': ['', [{ 'Fn::ImportValue': 'X' }]] })).toBe(
      true
    );
    expect(containsCrossStackIntrinsic({ 'Fn::Join': ['', [{ Ref: 'B' }, 'x']] })).toBe(false);
    expect(containsCrossStackIntrinsic('Fn::ImportValue')).toBe(false);
  });

  it('local invoke builds the cross-stack resolver for a nested env value', () => {
    expect(
      envHasCrossStackIntrinsic({ URL: { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'X' }]] } })
    ).toBe(true);
    expect(envHasCrossStackIntrinsic({ URL: { 'Fn::Join': ['', [{ Ref: 'B' }]] } })).toBe(false);
  });
});

describe('ECS engine nested cross-stack intrinsics (issue #962)', () => {
  const joined = { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'P-B' }]] };
  const stack = {
    stackName: 'Consumer',
    region: 'us-east-1',
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: 'public.ecr.aws/docker/library/busybox:latest',
                Command: ['--source', joined],
                Environment: [{ Name: 'SOURCE', Value: joined }],
              },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;

  it('flags the stack as needing the cross-stack resolver', () => {
    expect(detectEcsImageResolutionNeeds(stack).needsCrossStackResolver).toBe(true);
  });

  it('resolves a nested env value and argv element in the post-pass', async () => {
    const task = resolveEcsTaskTarget('Consumer:TaskDef', [stack], { stateResources: {} });
    const container = task.containers[0]!;
    expect(container.environment['SOURCE']).toBeUndefined();
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Command\[1\]/);

    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver,
      consumerRegion: 'us-east-1',
    });
    expect(container.environment['SOURCE']).toBe(`s3://${IMPORTED}`);
    expect(container.warnings.some((w) => w.includes('SOURCE'))).toBe(false);
    expect(container.command).toEqual(['--source', `s3://${IMPORTED}`]);
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });
});
