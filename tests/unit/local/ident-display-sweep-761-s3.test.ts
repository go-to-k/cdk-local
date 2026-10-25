import { describe, it, expect } from 'vite-plus/test';
import { resolveLambdaTarget, resolveLambdaLayers } from '../../../src/local/lambda-resolver.js';
import { formatTargetListing } from '../../../src/cli/commands/local-list.js';

// go-to-k/cdk-local#761 (S3): an assembly-chosen identifier renders bare when
// plain and as ONE JSON string literal when it could forge a boundary. Expected
// strings are computed by hand, never by calling the display helper.

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a throw');
}

function stackWith(stackName: string, resources: Record<string, unknown>) {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: resources },
    dependencyNames: [],
  } as never;
}

describe('lambda-resolver renders logical id, stack name and resource type (#761)', () => {
  it('prints plain values bare', () => {
    const stack = stackWith('MyStack', { Tbl: { Type: 'AWS::DynamoDB::Table' } });
    const msg = messageOf(() => resolveLambdaTarget('MyStack:Tbl', [stack]));
    expect(msg).toContain('Resource Tbl in MyStack is AWS::DynamoDB::Table, not a Lambda function.');
  });

  it('prints forging values as JSON literals', () => {
    const stack = stackWith('S\u001b[2Kx', { "a' b": { Type: 'AWS::DynamoDB::Table' } });
    const msg = messageOf(() => resolveLambdaTarget("S\u001b[2Kx:a' b", [stack]));
    expect(msg).toContain(
      `Resource "a' b" in "S [2Kx" is AWS::DynamoDB::Table, not a Lambda function.`
    );
  });

  it('renders the not-found listing rows', () => {
    const stack = stackWith("S' x", {
      "F' g": {
        Type: 'AWS::Lambda::Function',
        Metadata: { 'aws:cdk:path': 'P/F' },
      },
    });
    const msg = messageOf(() => resolveLambdaTarget("S' x:nope", [stack]));
    expect(msg).toContain(`Available Lambda functions in "S' x":`);
    expect(msg).toContain(`  P/F  ("F' g")`);
  });

  it('renders the layer message', () => {
    const props = { Runtime: 'nodejs20.x', Handler: 'i.h', Layers: [{ Ref: "L' x" }] };
    const stack = stackWith('TestStack', { "F' g": { Type: 'AWS::Lambda::Function', Properties: props } });
    const msg = messageOf(() => resolveLambdaLayers(stack, "F' g", props));
    expect(msg).toContain(`Lambda "F' g" Layers entry [0] references "L' x",`);
    expect(msg).toContain('exists in stack TestStack.');
  });
});

describe('cdkl list renders the display path and qualified id (#761)', () => {
  function listing(displayPath: string, qualifiedId: string) {
    const entry = { logicalId: 'F', stackName: 'S', qualifiedId, displayPath };
    return {
      lambdas: [entry],
      apis: [],
      ecsServices: [],
      ecsTaskDefinitions: [],
      agentCoreRuntimes: [],
      loadBalancers: [],
      cloudFrontDistributions: [],
      webFunctions: [],
    } as never;
  }

  it('prints plain ids byte-identically', () => {
    const out = formatTargetListing(listing('S/F', 'S:F'), 'cdkl', { long: true });
    expect(out).toContain('\n  S/F\n      S:F');
  });

  it('prints a forging path as a JSON literal', () => {
    const out = formatTargetListing(listing('S/a\nfake', "S:a' b"), 'cdkl', { long: true });
    expect(out).toContain('  "S/a fake"\n      "S:a\' b"');
  });
});
