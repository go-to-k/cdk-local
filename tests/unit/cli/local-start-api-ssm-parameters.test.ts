import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

// Site-level binding test for the `--from-cfn-stack` SSM-parameter
// resolution wired into `loadStateForRoutedStacks` (issue #94). The pure
// helper (collectSsmParameterRefs / resolveSsmParameters) and the
// provider method (resolveTemplateSsmParameters) are unit-tested
// elsewhere; this locks the CALL SITE so a future refactor that drops the
// call fails a test: the stack TEMPLATE (carrying Parameters) is passed,
// the resolution happens while the provider is alive (before dispose()),
// the result is stashed on `bundle.ssmParameters`, and a provider that
// does NOT implement the optional method is skipped cleanly.

const { createProviderMock, rejectMock, stsSendMock, fallbackRegionMock } = vi.hoisted(() => ({
  createProviderMock: vi.fn(),
  rejectMock: vi.fn(),
  stsSendMock: vi.fn(),
  fallbackRegionMock: vi.fn(),
}));

vi.mock('../../../src/cli/commands/local-state-source.js', () => ({
  createLocalStateProvider: createProviderMock,
  rejectExplicitCfnStackWithMultipleStacks: rejectMock,
  isCfnFlagPresent: vi.fn(() => false),
  resolveCfnFallbackRegion: fallbackRegionMock,
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSendMock;
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
}));

const { loadStateForRoutedStacks } = await import('../../../src/cli/commands/local-start-api.js');

// A reachable Lambda whose env Refs an SSM-backed CloudFormation
// parameter, plus the matching `Parameters` block CDK synthesizes.
function lambdaStackWithSsmParam(): StackInfo {
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Parameters: {
        SsmDbHost: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/db-host' },
      },
      Resources: {
        EchoFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Environment: { Variables: { DB_HOST: { Ref: 'SsmDbHost' } } },
          },
        },
      },
    },
  } as unknown as StackInfo;
}

function routeTo(logicalId: string): DiscoveredRoute {
  return {
    method: 'GET',
    pathPattern: '/x',
    lambdaLogicalId: logicalId,
    source: 'http-api',
    apiVersion: 'v2',
    stage: '$default',
    unsupported: false,
    mockCors: false,
    serviceIntegration: false,
  } as unknown as DiscoveredRoute;
}

describe('loadStateForRoutedStacks SSM-parameter resolution (site binding)', () => {
  beforeEach(() => {
    createProviderMock.mockReset();
    rejectMock.mockReset();
    stsSendMock.mockReset();
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    fallbackRegionMock.mockReset();
    fallbackRegionMock.mockImplementation(
      async (_options: unknown, synthRegion: string | undefined) => synthRegion
    );
  });

  it('resolves the stack template Parameters via the provider and stashes them on bundle.ssmParameters', async () => {
    const provider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      resolveTemplateSsmParameters: vi
        .fn()
        .mockResolvedValue({ values: { SsmDbHost: 'db.internal' }, secureStringLogicalIds: [] }),
      dispose: vi.fn(),
    };
    createProviderMock.mockReturnValue(provider);

    const result = await loadStateForRoutedStacks(
      [lambdaStackWithSsmParam()],
      [routeTo('EchoFn')],
      [],
      {} as never,
      undefined
    );

    // Bound: the SYNTHESIZED TEMPLATE (with its Parameters block) is what
    // gets passed — not the resource map / stack name.
    expect(provider.resolveTemplateSsmParameters).toHaveBeenCalledTimes(1);
    const passed = provider.resolveTemplateSsmParameters.mock.calls[0]![0] as {
      Parameters?: Record<string, unknown>;
    };
    expect(passed.Parameters?.['SsmDbHost']).toBeDefined();

    // Resolved while the provider (and its AWS client) is still alive.
    expect(provider.resolveTemplateSsmParameters.mock.invocationCallOrder[0]).toBeLessThan(
      provider.dispose.mock.invocationCallOrder[0]!
    );

    // Stashed for buildContainerSpec to feed the substitution context.
    expect(result.get('MyStack')?.ssmParameters).toEqual({ SsmDbHost: 'db.internal' });
    // No SecureString -> no sensitive logical IDs stashed.
    expect(result.get('MyStack')?.ssmSecureStringLogicalIds).toBeUndefined();
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });

  it('stashes secureStringLogicalIds on the bundle for SecureString params (issue #99)', async () => {
    const provider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      resolveTemplateSsmParameters: vi.fn().mockResolvedValue({
        values: { SsmDbHost: 's3cr3t' },
        secureStringLogicalIds: ['SsmDbHost'],
      }),
      dispose: vi.fn(),
    };
    createProviderMock.mockReturnValue(provider);

    const result = await loadStateForRoutedStacks(
      [lambdaStackWithSsmParam()],
      [routeTo('EchoFn')],
      [],
      {} as never,
      undefined
    );

    expect(result.get('MyStack')?.ssmParameters).toEqual({ SsmDbHost: 's3cr3t' });
    expect(result.get('MyStack')?.ssmSecureStringLogicalIds).toEqual(['SsmDbHost']);
  });

  it('leaves ssmParameters absent when the provider resolves nothing', async () => {
    const provider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      resolveTemplateSsmParameters: vi
        .fn()
        .mockResolvedValue({ values: {}, secureStringLogicalIds: [] }),
      dispose: vi.fn(),
    };
    createProviderMock.mockReturnValue(provider);

    const result = await loadStateForRoutedStacks(
      [lambdaStackWithSsmParam()],
      [routeTo('EchoFn')],
      [],
      {} as never,
      undefined
    );

    expect(provider.resolveTemplateSsmParameters).toHaveBeenCalledTimes(1);
    expect(result.get('MyStack')?.ssmParameters).toBeUndefined();
    expect(result.get('MyStack')?.ssmSecureStringLogicalIds).toBeUndefined();
  });

  it('skips the SSM resolution cleanly for a provider without resolveTemplateSsmParameters', async () => {
    const provider = {
      label: '--from-state',
      load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      // no resolveTemplateSsmParameters
    };
    createProviderMock.mockReturnValue(provider);

    const result = await loadStateForRoutedStacks(
      [lambdaStackWithSsmParam()],
      [routeTo('EchoFn')],
      [],
      {} as never,
      undefined
    );

    expect(result.get('MyStack')?.ssmParameters).toBeUndefined();
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });
});
