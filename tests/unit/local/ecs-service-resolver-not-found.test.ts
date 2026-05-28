import { describe, it, expect } from 'vite-plus/test';
import { resolveEcsServiceTarget } from '../../../src/local/ecs-service-resolver.js';
import { EcsTaskResolutionError } from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function stackWithService(): StackInfo {
  return {
    stackName: 'MyStack',
    template: {
      Resources: {
        BackendServiceABC123: {
          Type: 'AWS::ECS::Service',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'MyStack/Backend/Service/Service/Service' },
        },
      },
    },
  } as unknown as StackInfo;
}

function call(target: string): EcsTaskResolutionError {
  try {
    resolveEcsServiceTarget(target, [stackWithService()]);
  } catch (e) {
    return e as EcsTaskResolutionError;
  }
  throw new Error('expected resolveEcsServiceTarget to throw');
}

describe('resolveEcsServiceTarget not-found message', () => {
  it('lists each service by CDK display path AND logical ID', () => {
    const err = call('MyStack/does/not/exist');
    expect(err).toBeInstanceOf(EcsTaskResolutionError);
    expect(err.message).toContain('Available services in MyStack');
    expect(err.message).toContain('MyStack/Backend/Service/Service/Service');
    expect(err.message).toContain('(BackendServiceABC123)');
  });

  it('hints the colon form when a Stack/Path target is actually a logical ID', () => {
    const err = call('MyStack/BackendServiceABC123');
    expect(err.message).toContain("'BackendServiceABC123' is a logical ID");
    expect(err.message).toContain("use the colon form: 'MyStack:BackendServiceABC123'");
  });

  it('does NOT add the colon hint for a genuine path miss (tail is not a logical ID)', () => {
    const err = call('MyStack/Backend/Nope');
    expect(err.message).toContain('Available services in MyStack');
    expect(err.message).not.toContain('is a logical ID');
  });

  it('does NOT add the colon hint for the colon form (logical ID typo)', () => {
    const err = call('MyStack:BackendServiceXYZ');
    expect(err.message).toContain('Available services in MyStack');
    expect(err.message).not.toContain('is a logical ID');
  });

  it('reports the no-services-at-all case distinctly', () => {
    const empty = {
      stackName: 'MyStack',
      template: { Resources: { SomeBucket: { Type: 'AWS::S3::Bucket', Properties: {} } } },
    } as unknown as StackInfo;
    let err: EcsTaskResolutionError | undefined;
    try {
      resolveEcsServiceTarget('MyStack:Whatever', [empty]);
    } catch (e) {
      err = e as EcsTaskResolutionError;
    }
    expect(err?.message).toContain('declares no AWS::ECS::Service resources at all');
  });
});
