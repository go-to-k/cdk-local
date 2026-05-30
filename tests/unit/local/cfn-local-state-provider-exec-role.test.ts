import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock the Lambda SDK so `resolveLambdaExecutionRoleArn()` (which
// constructs its own LambdaClient via the lazy getLambdaClient()) can be
// exercised without real AWS.
const { lambdaSendMock, lambdaDestroyMock } = vi.hoisted(() => ({
  lambdaSendMock: vi.fn(),
  lambdaDestroyMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = lambdaSendMock;
    destroy = lambdaDestroyMock;
  },
  GetFunctionConfigurationCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

// CFn client is unused by these tests but the module imports it at load.
vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = vi.fn();
    destroy(): void {}
  },
  ListStackResourcesCommand: class {},
  DescribeStacksCommand: class {},
  ListExportsCommand: class {},
}));

const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');

describe('CfnLocalStateProvider.resolveLambdaExecutionRoleArn', () => {
  beforeEach(() => {
    lambdaSendMock.mockReset();
    lambdaDestroyMock.mockReset();
  });

  it("returns the deployed function's Configuration.Role ARN", async () => {
    lambdaSendMock.mockResolvedValueOnce({
      Role: 'arn:aws:iam::111:role/Stack-AssumableExecRole-AAA',
    });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const arn = await provider.resolveLambdaExecutionRoleArn('Scoring');

    expect(arn).toBe('arn:aws:iam::111:role/Stack-AssumableExecRole-AAA');
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    const cmd = lambdaSendMock.mock.calls[0]?.[0] as { input: { FunctionName: string } };
    expect(cmd.input.FunctionName).toBe('Scoring');
  });

  it('returns undefined when the response Role is missing', async () => {
    lambdaSendMock.mockResolvedValueOnce({});
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const arn = await provider.resolveLambdaExecutionRoleArn('Scoring');

    expect(arn).toBeUndefined();
  });

  it('returns undefined when the response Role is not an ARN', async () => {
    lambdaSendMock.mockResolvedValueOnce({ Role: 'not-an-arn' });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const arn = await provider.resolveLambdaExecutionRoleArn('Scoring');

    expect(arn).toBeUndefined();
  });

  it('warns and returns undefined on SDK error (access denied / throttling / not found)', async () => {
    lambdaSendMock.mockRejectedValueOnce(
      Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' })
    );
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const arn = await provider.resolveLambdaExecutionRoleArn('Scoring');

    expect(arn).toBeUndefined();
  });

  it('throws when called after dispose() (use-after-free guard)', async () => {
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    provider.dispose();

    await expect(provider.resolveLambdaExecutionRoleArn('Scoring')).rejects.toThrow(
      /used after dispose/
    );
  });
});
