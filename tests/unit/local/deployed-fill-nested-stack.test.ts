import { describe, it, expect, afterEach } from 'vite-plus/test';
import { deployedFillMayBeSecret } from '../../../src/local/dynamic-reference-resolver.js';
import { registerNestedStacks, resetNestedStackRegistry } from '../../../src/synthesis/nested-stacks.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function stack(
  name: string,
  resources: Record<string, unknown>,
  nested?: { parent: StackInfo; logicalId: string; parameters: Record<string, unknown> }
): StackInfo {
  return {
    stackName: name,
    displayName: name,
    template: {
      Parameters: { referencetoX: { Type: 'String' } },
      Resources: resources,
    },
    ...(nested && {
      nestedStack: {
        parentStackName: nested.parent.stackName,
        rootStackName: nested.parent.nestedStack?.rootStackName ?? nested.parent.stackName,
        logicalId: nested.logicalId,
        parameters: nested.parameters,
      },
    }),
  } as unknown as StackInfo;
}

describe('deployedFillMayBeSecret across a nested-stack boundary (#986)', () => {
  afterEach(() => resetNestedStackRegistry());

  const parentResources = {
    Key: { Type: 'AWS::IAM::AccessKey' },
    Queue: { Type: 'AWS::SQS::Queue' },
  };

  it('is true when the parent passes a secret attribute through the parameter', () => {
    const app = stack('App', parentResources);
    const child = stack('App~I', {}, {
      parent: app,
      logicalId: 'I',
      parameters: { referencetoX: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] } },
    });
    registerNestedStacks([app, child]);
    expect(deployedFillMayBeSecret({ Ref: 'referencetoX' }, child.template)).toBe(true);
  });

  it('is false when the parent passes a plain Ref', () => {
    const app = stack('App', parentResources);
    const child = stack('App~I', {}, {
      parent: app,
      logicalId: 'I',
      parameters: { referencetoX: { Ref: 'Queue' } },
    });
    registerNestedStacks([app, child]);
    expect(deployedFillMayBeSecret({ Ref: 'referencetoX' }, child.template)).toBe(false);
  });

  it('follows a 2-level chain (grandchild -> child parameter -> parent secret)', () => {
    const app = stack('App', parentResources);
    const child = stack('App~I', {}, {
      parent: app,
      logicalId: 'I',
      parameters: { referencetoX: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] } },
    });
    const grand = stack('App~I~J', {}, {
      parent: child,
      logicalId: 'J',
      parameters: { referencetoX: { Ref: 'referencetoX' } },
    });
    registerNestedStacks([app, child, grand]);
    expect(deployedFillMayBeSecret({ Ref: 'referencetoX' }, grand.template)).toBe(true);
  });

  it('judges the Fn::Sub ${param} form the same way', () => {
    const app = stack('App', parentResources);
    const child = stack('App~I', {}, {
      parent: app,
      logicalId: 'I',
      parameters: { referencetoX: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] } },
    });
    registerNestedStacks([app, child]);
    expect(deployedFillMayBeSecret({ 'Fn::Sub': 'prefix-${referencetoX}' }, child.template)).toBe(true);
  });

  it('is false for the same template when it is not a registered nested stack', () => {
    const lone = stack('Lone', {});
    expect(deployedFillMayBeSecret({ Ref: 'referencetoX' }, lone.template)).toBe(false);
  });
});
