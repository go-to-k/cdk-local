import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

// Site-level binding test for the `--from-cfn-stack` deployed-env fetch
// wired into `loadStateForRoutedStacks`. The pure helper
// (applyDeployedEnvFallback) and the provider method
// (resolveDeployedFunctionEnv) are unit-tested elsewhere; this locks the
// CALL SITE: the deployed function's PHYSICAL id (not the logical id) is
// passed, the fetch happens while the provider is alive (before
// dispose()), the result is stashed per-logical-id, and a provider that
// does NOT implement the optional method is skipped cleanly.

const { createProviderMock, rejectMock, stsSendMock } = vi.hoisted(() => ({
  createProviderMock: vi.fn(),
  rejectMock: vi.fn(),
  stsSendMock: vi.fn(),
}));

vi.mock('../../../src/cli/commands/local-state-source.js', () => ({
  createLocalStateProvider: createProviderMock,
  rejectExplicitCfnStackWithMultipleStacks: rejectMock,
  isCfnFlagPresent: vi.fn(() => false),
}));

// `loadStateForRoutedStacks` issues one `sts:GetCallerIdentity` for the
// pseudo-parameter bag when a reachable Lambda has an intrinsic env;
// stub it so the test stays hermetic (no real AWS / credential chain).
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSendMock;
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
}));

const { loadStateForRoutedStacks } = await import('../../../src/cli/commands/local-start-api.js');

function lambdaStack(): StackInfo {
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Resources: {
        EchoFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Environment: {
              Variables: { SIBLING_ARN: { 'Fn::GetAtt': ['SiblingFn', 'Arn'] } },
            },
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

describe('loadStateForRoutedStacks deployed-env fetch (site binding)', () => {
  beforeEach(() => {
    createProviderMock.mockReset();
    rejectMock.mockReset();
    stsSendMock.mockReset();
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
  });

  it('fetches the deployed env by PHYSICAL id, before dispose(), and stashes it per logical id', async () => {
    const provider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({
        resources: {
          EchoFn: {
            physicalId: 'echo-physical-name',
            resourceType: 'AWS::Lambda::Function',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        region: 'us-east-1',
      }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      resolveDeployedFunctionEnv: vi
        .fn()
        .mockResolvedValue({ SIBLING_ARN: 'arn:aws:lambda:us-east-1:111111111111:function:Sib' }),
      dispose: vi.fn(),
    };
    createProviderMock.mockReturnValue(provider);

    const result = await loadStateForRoutedStacks(
      [lambdaStack()],
      [routeTo('EchoFn')],
      [],
      {} as never,
      undefined
    );

    // Bound by PHYSICAL id (regression guard: passing the logical id would
    // be a silent bug — GetFunctionConfiguration would 404).
    expect(provider.resolveDeployedFunctionEnv).toHaveBeenCalledTimes(1);
    expect(provider.resolveDeployedFunctionEnv).toHaveBeenCalledWith('echo-physical-name');

    // Fetched while the provider (and its AWS client) is still alive.
    expect(provider.resolveDeployedFunctionEnv.mock.invocationCallOrder[0]).toBeLessThan(
      provider.dispose.mock.invocationCallOrder[0]!
    );

    // Stashed per logical id for buildContainerSpec to splice in.
    const bundle = result.get('MyStack');
    expect(bundle?.deployedEnvByLambda?.get('EchoFn')).toEqual({
      SIBLING_ARN: 'arn:aws:lambda:us-east-1:111111111111:function:Sib',
    });
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });

  it('skips the fetch cleanly for a provider without resolveDeployedFunctionEnv (e.g. --from-state)', async () => {
    const provider = {
      label: '--from-state',
      load: vi.fn().mockResolvedValue({
        resources: {
          EchoFn: {
            physicalId: 'echo-physical-name',
            resourceType: 'AWS::Lambda::Function',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        region: 'us-east-1',
      }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      // no resolveDeployedFunctionEnv
    };
    createProviderMock.mockReturnValue(provider);

    const result = await loadStateForRoutedStacks(
      [lambdaStack()],
      [routeTo('EchoFn')],
      [],
      {} as never,
      undefined
    );

    expect(result.get('MyStack')?.deployedEnvByLambda).toBeUndefined();
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });
});
