import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import { registerNestedStacks, resetNestedStackRegistry } from '../../../src/synthesis/nested-stacks.js';

// `--from-cfn-stack <name>` names ONE top-level stack; a CDK nested stack is
// part of it, so a nested stack reachable alongside its parent must not count
// as a second routed stack (go-to-k/cdk-local#986).

const { createProviderMock, rejectMock, stsSendMock } = vi.hoisted(() => ({
  createProviderMock: vi.fn(),
  rejectMock: vi.fn(),
  stsSendMock: vi.fn(),
}));

vi.mock('../../../src/cli/commands/local-state-source.js', () => ({
  createLocalStateProvider: createProviderMock,
  rejectExplicitCfnStackWithMultipleStacks: rejectMock,
  isCfnFlagPresent: vi.fn(() => false),
  deployedStackName: (_o: unknown, n: string) => n,
  deployedStackNamePseudo: (_o: unknown, n: string) => ({ stackName: n }),
  resolveCfnFallbackRegion: vi.fn(async (_o: unknown, r: string | undefined) => r),
  UNNAMED_WORKLOAD: {},
  groupWorkloadsRoutedApart: vi.fn(() => []),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSendMock;
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
}));

const { loadStateForRoutedStacks } = await import('../../../src/cli/commands/local-start-api.js');

const fn = { Type: 'AWS::Lambda::Function', Properties: {} };
const mk = (name: string, nestedOf?: string, logicalId?: string): StackInfo =>
  ({
    stackName: name,
    displayName: name,
    region: 'us-east-1',
    template: { Resources: { [name.replace(/\W/g, '') + 'Fn']: fn } },
    ...(nestedOf && {
      nestedStack: { parentStackName: nestedOf, rootStackName: nestedOf, logicalId, parameters: {} },
    }),
  }) as unknown as StackInfo;

const route = (logicalId: string): DiscoveredRoute =>
  ({
    method: 'GET',
    pathPattern: '/x',
    lambdaLogicalId: logicalId,
    source: 'http-api',
    apiVersion: 'v2',
    stage: '$default',
    unsupported: false,
    mockCors: false,
    serviceIntegration: false,
  }) as unknown as DiscoveredRoute;

describe('loadStateForRoutedStacks counts top-level stacks for --from-cfn-stack <name>', () => {
  beforeEach(() => {
    createProviderMock.mockReset();
    createProviderMock.mockReturnValue(undefined);
    rejectMock.mockReset();
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
  });
  afterEach(() => resetNestedStackRegistry());

  it('a stack and its nested stack count as ONE', async () => {
    const App = mk('App');
    const Inner = mk('App~Inner', 'App', 'Inner');
    registerNestedStacks([App, Inner]);
    await loadStateForRoutedStacks(
      [App, Inner],
      [route('AppFn'), route('AppInnerFn')],
      [],
      { fromCfnStack: 'Explicit' } as never,
      undefined
    );
    expect(rejectMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('two top-level stacks still count as two', async () => {
    const A = mk('A');
    const B = mk('B');
    registerNestedStacks([A, B]);
    await loadStateForRoutedStacks(
      [A, B],
      [route('AFn'), route('BFn')],
      [],
      { fromCfnStack: 'Explicit' } as never,
      undefined
    );
    expect(rejectMock).toHaveBeenCalledWith(expect.anything(), 2);
  });
});
