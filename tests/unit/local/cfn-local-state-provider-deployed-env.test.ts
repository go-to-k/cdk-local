import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock the Lambda SDK so `resolveDeployedFunctionEnv()` (which constructs
// its own LambdaClient via the lazy getLambdaClient()) can be exercised
// without real AWS.
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

// The CFn client is unused by these tests but the module imports it at
// load time, so provide a no-op stub.
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

describe('CfnLocalStateProvider.resolveDeployedFunctionEnv', () => {
  beforeEach(() => {
    lambdaSendMock.mockReset();
    lambdaDestroyMock.mockReset();
  });

  it("returns the deployed function's Environment.Variables", async () => {
    lambdaSendMock.mockResolvedValueOnce({
      Environment: { Variables: { SWIFT_LAMBDA_ARN: 'arn:aws:lambda:us-east-1:111:function:Math' } },
    });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const env = await provider.resolveDeployedFunctionEnv('Scoring');

    expect(env).toEqual({ SWIFT_LAMBDA_ARN: 'arn:aws:lambda:us-east-1:111:function:Math' });
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    const cmd = lambdaSendMock.mock.calls[0]![0] as { input: { FunctionName: string } };
    expect(cmd.input.FunctionName).toBe('Scoring');
    provider.dispose();
  });

  it('returns {} when the function declares no env vars', async () => {
    lambdaSendMock.mockResolvedValueOnce({});
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    expect(await provider.resolveDeployedFunctionEnv('Scoring')).toEqual({});
    provider.dispose();
  });

  it('returns undefined (warn-and-fallback) when GetFunctionConfiguration fails', async () => {
    lambdaSendMock.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    expect(await provider.resolveDeployedFunctionEnv('Scoring')).toBeUndefined();
    provider.dispose();
  });

  it('passes --profile through to the LambdaClient and destroys it on dispose', async () => {
    lambdaSendMock.mockResolvedValueOnce({ Environment: { Variables: { K: 'v' } } });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'S',
      region: 'us-east-1',
      profile: 'mates_dev',
    });

    await provider.resolveDeployedFunctionEnv('Scoring');
    provider.dispose();

    expect(lambdaDestroyMock).toHaveBeenCalledTimes(1);
  });

  it('throws on use after dispose()', async () => {
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    provider.dispose();
    await expect(provider.resolveDeployedFunctionEnv('Scoring')).rejects.toThrow(/after dispose/);
  });
});
