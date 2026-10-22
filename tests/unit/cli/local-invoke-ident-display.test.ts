import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  resolveAssumeRoleArnForLambda,
  resolveContainerImagePlan,
  resolveExecutionRoleArnFromState,
} from '../../../src/cli/commands/local-invoke.js';
import type { StackState } from '../../../src/types/state.js';

// go-to-k/cdk-local#761 (S3): an assembly-chosen identifier renders bare when
// plain and as ONE JSON string literal when it could forge a boundary. Expected
// strings are hand-written, never computed through the display helper.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function captureWarns(): string[] {
  const out: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' ').replace(ANSI, '').replace(/^WARN: /, ''));
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return out;
}

function stateWith(logicalId: string, properties: Record<string, unknown>): StackState {
  return {
    version: 1,
    stackName: 'Stack',
    resources: {
      [logicalId]: {
        physicalId: 'phys',
        resourceType: 'AWS::Lambda::Function',
        properties,
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

describe('local-invoke renders the Lambda logical id (#761)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('container Lambda with no asset and a non-ECR URI: plain and forging', async () => {
    const mk = (logicalId: string) =>
      ({
        logicalId,
        kind: 'image',
        architecture: 'x86_64',
        imageUri: 'example.com/not-ecr:1',
        imageConfig: {},
        stack: { stackName: 'S', assetManifestPath: undefined },
      }) as unknown as Parameters<typeof resolveContainerImagePlan>[0];
    await expect(resolveContainerImagePlan(mk('ImgFn'), {} as never)).rejects.toThrow(
      /^Container Lambda ImgFn has no matching asset in cdk\.out, and Code\.ImageUri example\.com\/not-ecr:1 is not an ECR URI /
    );
    await expect(resolveContainerImagePlan(mk("Img' Fn"), {} as never)).rejects.toThrow(
      /^Container Lambda "Img' Fn" has no matching asset in cdk\.out, and Code\.ImageUri example\.com\/not-ecr:1 is not an ECR URI /
    );
  });

  it('--assume-role cannot resolve the role: plain and forging', async () => {
    const warns = captureWarns();
    await resolveAssumeRoleArnForLambda(true, stateWith('Fn', {}), undefined, 'Fn');
    await resolveAssumeRoleArnForLambda(true, stateWith("F' n", {}), undefined, "F' n");
    expect(warns[0]).toMatch(
      /^--assume-role: could not resolve the execution role ARN for Fn\. Pass the ARN explicitly/
    );
    expect(warns[1]).toMatch(
      /^--assume-role: could not resolve the execution role ARN for "F' n"\. Pass the ARN explicitly/
    );
  });

  it('live GetFunctionConfiguration returns a malformed role: plain and forging', async () => {
    const warns = captureWarns();
    const provider = { resolveLambdaExecutionRoleArn: async () => 'not-an-arn' };
    await resolveAssumeRoleArnForLambda(true, stateWith('Fn', {}), provider, 'Fn');
    await resolveAssumeRoleArnForLambda(true, stateWith("F' n", {}), provider, "F' n");
    expect(warns[0]).toMatch(
      /^--assume-role: GetFunctionConfiguration for Fn produced a value that is not a well-formed IAM role ARN: /
    );
    // Each call also ends with the could-not-resolve warn, so the second call's is [2].
    expect(warns[2]).toMatch(
      /^--assume-role: GetFunctionConfiguration for "F' n" produced a value that is not a well-formed IAM role ARN: /
    );
  });

  it('state carries a malformed role property: logical id and property name', () => {
    const warns = captureWarns();
    resolveExecutionRoleArnFromState(stateWith('Fn', { Role: 'bad' }), 'Fn');
    resolveExecutionRoleArnFromState(stateWith("F' n", { "Ro' le": 'bad' }), "F' n", "Ro' le");
    expect(warns[0]).toMatch(
      /^Deployed state for Fn carries a Role that is not a well-formed IAM role ARN: /
    );
    expect(warns[1]).toMatch(
      /^Deployed state for "F' n" carries a "Ro' le" that is not a well-formed IAM role ARN: /
    );
  });
});
