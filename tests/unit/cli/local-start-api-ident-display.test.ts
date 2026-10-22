import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  resolveLambdaByLogicalId,
  resolveStartApiAssumeRoleArn,
} from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// go-to-k/cdk-local#761 (S3): an assembly-chosen identifier renders bare when
// plain and as ONE JSON string literal when it could forge a boundary. Expected
// strings are hand-written, never computed through the display helper.

function stackWith(resources: Record<string, unknown>): StackInfo {
  return {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    template: { Resources: resources },
    dependencyNames: [],
  } as unknown as StackInfo;
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a throw');
}

describe('start-api resolveLambdaByLogicalId renders the logical id (#761)', () => {
  it('no Handler: plain bare, forging as a JSON literal', () => {
    const mk = (id: string) =>
      stackWith({ [id]: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs20.x' } } });
    expect(messageOf(() => resolveLambdaByLogicalId('Fn', [mk('Fn')]))).toBe(
      'Lambda Fn has no Handler property.'
    );
    expect(messageOf(() => resolveLambdaByLogicalId("F' n", [mk("F' n")]))).toBe(
      `Lambda "F' n" has no Handler property.`
    );
  });

  it('no Runtime: plain and forging', () => {
    const mk = (id: string) =>
      stackWith({ [id]: { Type: 'AWS::Lambda::Function', Properties: { Handler: 'i.h' } } });
    expect(messageOf(() => resolveLambdaByLogicalId('Fn', [mk('Fn')]))).toMatch(
      /^Lambda Fn has no Runtime property and no Code\.ImageUri\. /
    );
    expect(messageOf(() => resolveLambdaByLogicalId("F' n", [mk("F' n")]))).toMatch(
      /^Lambda "F' n" has no Runtime property and no Code\.ImageUri\. /
    );
  });

  it('not found: plain and forging', () => {
    const stack = stackWith({});
    expect(messageOf(() => resolveLambdaByLogicalId('Fn', [stack]))).toMatch(
      /^No AWS::Lambda::Function resource named Fn found in target stacks\. /
    );
    expect(messageOf(() => resolveLambdaByLogicalId('F\u001b[2Kn', [stack]))).toMatch(
      /^No AWS::Lambda::Function resource named "F \[2Kn" found in target stacks\. /
    );
  });

  it('unsupported Architectures on a container Lambda: plain and forging', () => {
    const mk = (id: string, arch: string) =>
      stackWith({
        [id]: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: { ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/r:t' },
            Architectures: [arch],
          },
        },
      });
    expect(messageOf(() => resolveLambdaByLogicalId('Fn', [mk('Fn', 'mips')]))).toMatch(
      /^Lambda Fn has unsupported Architectures value mips\. /
    );
    expect(messageOf(() => resolveLambdaByLogicalId("F' n", [mk("F' n", "m' ips")]))).toMatch(
      /^Lambda "F' n" has unsupported Architectures value "m' ips"\. /
    );
  });
});

describe('start-api --assume-role warns render the logical id (#761)', () => {
  afterEach(() => vi.restoreAllMocks());

  function warnsFor(logicalId: string, role: unknown): string[] {
    const out: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      out.push(
        // eslint-disable-next-line no-control-regex
        a.map(String).join(' ').replace(/\u001b\[[0-9;]*m/g, '').replace(/^WARN: /, '')
      );
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    resolveStartApiAssumeRoleArn({
      logicalId,
      assumeRole: { perLambda: {}, bareAutoResolve: true },
      lambdaResource: { Type: 'AWS::Lambda::Function', Properties: { Role: role } } as never,
      stateBundle: undefined,
    });
    return out;
  }

  it('could-not-auto-resolve: plain and forging', () => {
    expect(warnsFor('Fn', { 'Fn::GetAtt': ['R', 'Arn'] })[0]).toMatch(
      /^--assume-role: could not auto-resolve the execution role ARN for Fn\. /
    );
    expect(warnsFor("F' n", { 'Fn::GetAtt': ['R', 'Arn'] })[0]).toMatch(
      /^--assume-role: could not auto-resolve the execution role ARN for "F' n"\. /
    );
  });

  it('malformed template Role: plain and forging', () => {
    expect(warnsFor('Fn', 'not-an-arn')[0]).toMatch(
      /^--assume-role: the template Role for Fn is not a well-formed IAM role ARN: /
    );
    expect(warnsFor("F' n", 'not-an-arn')[0]).toMatch(
      /^--assume-role: the template Role for "F' n" is not a well-formed IAM role ARN: /
    );
  });
});
