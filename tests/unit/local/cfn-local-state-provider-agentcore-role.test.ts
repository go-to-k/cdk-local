import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock the AgentCore control SDK so `resolveAgentCoreRuntimeRoleArn()`
// (which constructs its own BedrockAgentCoreControlClient via the lazy
// getAgentCoreControlClient()) can be exercised without real AWS.
const { acSendMock, acDestroyMock } = vi.hoisted(() => ({
  acSendMock: vi.fn(),
  acDestroyMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class {
    send = acSendMock;
    destroy = acDestroyMock;
  },
  GetAgentRuntimeCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

// Lambda client is unused by these tests but the module imports it at load.
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = vi.fn();
    destroy(): void {}
  },
  GetFunctionConfigurationCommand: class {},
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

describe('CfnLocalStateProvider.resolveAgentCoreRuntimeRoleArn', () => {
  beforeEach(() => {
    acSendMock.mockReset();
    acDestroyMock.mockReset();
  });

  it("returns the deployed runtime's roleArn", async () => {
    acSendMock.mockResolvedValueOnce({
      roleArn: 'arn:aws:iam::111:role/Stack-AgentRuntimeExecRole-AAA',
    });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const arn = await provider.resolveAgentCoreRuntimeRoleArn('agent-runtime-abc123');

    expect(arn).toBe('arn:aws:iam::111:role/Stack-AgentRuntimeExecRole-AAA');
    expect(acSendMock).toHaveBeenCalledTimes(1);
    const cmd = acSendMock.mock.calls[0]?.[0] as { input: { agentRuntimeId: string } };
    expect(cmd.input.agentRuntimeId).toBe('agent-runtime-abc123');
  });

  it('returns undefined when the response roleArn is missing', async () => {
    acSendMock.mockResolvedValueOnce({});
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const arn = await provider.resolveAgentCoreRuntimeRoleArn('agent-runtime-abc123');

    expect(arn).toBeUndefined();
  });

  it('returns undefined when the response roleArn is not an ARN', async () => {
    acSendMock.mockResolvedValueOnce({ roleArn: 'not-an-arn' });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const arn = await provider.resolveAgentCoreRuntimeRoleArn('agent-runtime-abc123');

    expect(arn).toBeUndefined();
  });

  it('warns and returns undefined on SDK error (access denied / throttling / not found)', async () => {
    acSendMock.mockRejectedValueOnce(
      Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' })
    );
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const arn = await provider.resolveAgentCoreRuntimeRoleArn('agent-runtime-abc123');

    expect(arn).toBeUndefined();
  });

  it('throws when called after dispose() (use-after-free guard)', async () => {
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    provider.dispose();

    await expect(provider.resolveAgentCoreRuntimeRoleArn('agent-runtime-abc123')).rejects.toThrow(
      /used after dispose/
    );
  });
});
