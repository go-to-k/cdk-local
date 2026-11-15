import { describe, it, expect } from 'vite-plus/test';
import {
  resolveLambdaTarget,
  LocalInvokeResolutionError,
} from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function lambda(cdkPath: string) {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler', Code: { ZipFile: 'exports.handler=()=>1' } },
    Metadata: { 'aws:cdk:path': cdkPath },
  };
}

const App = {
  stackName: 'App',
  displayName: 'App',
  artifactId: 'App',
  template: { Resources: { ParentFn: lambda('App/ParentFn/Resource') } },
  dependencyNames: [],
} as unknown as StackInfo;

const Inner = {
  stackName: 'App~InnerNS',
  displayName: 'App/Inner',
  artifactId: 'App',
  template: { Resources: { ChildFnABC123: lambda('App/Inner/Fn/Resource') } },
  dependencyNames: [],
  nestedStack: { parentStackName: 'App', rootStackName: 'App', logicalId: 'InnerNS', parameters: {} },
} as unknown as StackInfo;

describe('resolveLambdaTarget with nested stacks', () => {
  const stacks = [App, Inner];

  it("path form 'App/Inner/Fn' resolves into the nested child", () => {
    const r = resolveLambdaTarget('App/Inner/Fn', stacks);
    expect(r.stack).toBe(Inner);
    expect(r.logicalId).toBe('ChildFnABC123');
  });

  it("'App:<childLogicalId>' resolves into the child", () => {
    const r = resolveLambdaTarget('App:ChildFnABC123', stacks);
    expect(r.stack).toBe(Inner);
  });

  it('bare child logical id resolves in a single-top-level-stack app', () => {
    const r = resolveLambdaTarget('ChildFnABC123', stacks);
    expect(r.stack).toBe(Inner);
  });

  it("parent's own function still resolves to the parent", () => {
    expect(resolveLambdaTarget('App:ParentFn', stacks).stack).toBe(App);
  });

  it("a miss 'App/Nope' lists the nested child's function", () => {
    let err: unknown;
    try {
      resolveLambdaTarget('App/Nope', stacks);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LocalInvokeResolutionError);
    expect((err as Error).message).toContain('App/Inner/Fn/Resource');
    expect((err as Error).message).toContain('ChildFnABC123');
  });
});
