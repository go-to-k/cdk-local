import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock the SSM SDK so `resolveTemplateSsmParameters()` (which constructs
// its own SSMClient via the lazy getSsmClient()) can be exercised without
// real AWS. Capture the constructor config so we can assert that the
// CLI's --profile / --region thread through to the client.
const { ssmSendMock, ssmDestroyMock, ssmCtorMock } = vi.hoisted(() => ({
  ssmSendMock: vi.fn(),
  ssmDestroyMock: vi.fn(),
  ssmCtorMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = ssmSendMock;
    destroy = ssmDestroyMock;
    constructor(config: unknown) {
      ssmCtorMock(config);
    }
  },
  GetParametersCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

// The CFn / Lambda clients are unused by these tests but the provider
// imports them at load time, so provide no-op stubs.
vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = vi.fn();
    destroy(): void {}
  },
  ListStackResourcesCommand: class {},
  DescribeStacksCommand: class {},
  ListExportsCommand: class {},
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = vi.fn();
    destroy(): void {}
  },
  GetFunctionConfigurationCommand: class {},
}));

const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');

type Tmpl = Parameters<
  NonNullable<
    InstanceType<typeof CfnLocalStateProvider>['resolveTemplateSsmParameters']
  >
>[0];

function templateWithSsmString(): Tmpl {
  return {
    Resources: {},
    Parameters: {
      SsmDbHost: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/db-host' },
    },
  } as Tmpl;
}

describe('CfnLocalStateProvider.resolveTemplateSsmParameters', () => {
  beforeEach(() => {
    ssmSendMock.mockReset();
    ssmDestroyMock.mockReset();
    ssmCtorMock.mockReset();
  });

  it('resolves an SSM::Parameter::Value<String> param into the value map', async () => {
    ssmSendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/app/db-host', Value: 'db.internal' }],
      InvalidParameters: [],
    });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const out = await provider.resolveTemplateSsmParameters(templateWithSsmString());

    expect(out).toEqual({ values: { SsmDbHost: 'db.internal' }, secureStringLogicalIds: [] });
    expect(ssmSendMock).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('flags a SecureString param via secureStringLogicalIds (issue #99)', async () => {
    ssmSendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/app/db-host', Value: 's3cr3t', Type: 'SecureString' }],
      InvalidParameters: [],
    });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const out = await provider.resolveTemplateSsmParameters(templateWithSsmString());

    expect(out).toEqual({
      values: { SsmDbHost: 's3cr3t' },
      secureStringLogicalIds: ['SsmDbHost'],
    });
    provider.dispose();
  });

  it('comma-joins the List<String> variant (passed through from SSM)', async () => {
    ssmSendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/app/subnets', Value: 'subnet-a,subnet-b' }],
      InvalidParameters: [],
    });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const out = await provider.resolveTemplateSsmParameters({
      Resources: {},
      Parameters: {
        SsmSubnets: { Type: 'AWS::SSM::Parameter::Value<List<String>>', Default: '/app/subnets' },
      },
    } as Tmpl);

    expect(out).toEqual({
      values: { SsmSubnets: 'subnet-a,subnet-b' },
      secureStringLogicalIds: [],
    });
    provider.dispose();
  });

  it('returns {} and opens no SSM client when the template has no SSM params', async () => {
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    const out = await provider.resolveTemplateSsmParameters({
      Resources: {},
      Parameters: { Plain: { Type: 'String', Default: 'x' } },
    } as Tmpl);

    expect(out).toEqual({ values: {}, secureStringLogicalIds: [] });
    expect(ssmCtorMock).not.toHaveBeenCalled();
    expect(ssmSendMock).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('falls back to {} (no throw) when GetParameters fails', async () => {
    ssmSendMock.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    );
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    expect(await provider.resolveTemplateSsmParameters(templateWithSsmString())).toEqual({
      values: {},
      secureStringLogicalIds: [],
    });
    provider.dispose();
  });

  it('threads --region and --profile into the SSM client and destroys it on dispose', async () => {
    ssmSendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/app/db-host', Value: 'db.internal' }],
      InvalidParameters: [],
    });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'S',
      region: 'ap-northeast-1',
      profile: 'mates_dev',
    });

    await provider.resolveTemplateSsmParameters(templateWithSsmString());
    expect(ssmCtorMock).toHaveBeenCalledTimes(1);
    expect(ssmCtorMock.mock.calls[0]![0]).toEqual({
      region: 'ap-northeast-1',
      profile: 'mates_dev',
    });

    provider.dispose();
    expect(ssmDestroyMock).toHaveBeenCalledTimes(1);
  });

  it('omits the profile from the SSM client config when --profile is unset', async () => {
    ssmSendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/app/db-host', Value: 'db.internal' }],
      InvalidParameters: [],
    });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });

    await provider.resolveTemplateSsmParameters(templateWithSsmString());
    expect(ssmCtorMock.mock.calls[0]![0]).toEqual({ region: 'us-east-1' });
    provider.dispose();
  });

  it('throws on use after dispose()', async () => {
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    provider.dispose();
    await expect(provider.resolveTemplateSsmParameters(templateWithSsmString())).rejects.toThrow(
      /after dispose/
    );
  });
});
