import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-cloudformation', () => {
  const cmd = (name: string) =>
    class {
      readonly commandName = name;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    CloudFormationClient: class {
      send = sendMock;
      destroy(): void {}
    },
    ListStackResourcesCommand: cmd('ListStackResources'),
    DescribeStacksCommand: cmd('DescribeStacks'),
    DescribeStackResourceCommand: cmd('DescribeStackResource'),
    ListExportsCommand: cmd('ListExports'),
  };
});

const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');

const ARN_A = 'arn:aws:cloudformation:us-east-1:1:stack/App-A/aaa';
const ARN_B = 'arn:aws:cloudformation:us-east-1:1:stack/App-A-B/bbb';

type Cmd = { commandName: string; input: Record<string, string> };

function script(opts: { failDescribe?: () => boolean } = {}): void {
  sendMock.mockImplementation(async (c: Cmd | undefined) => {
    // tests/setup.ts probes a mock implementation with no arguments.
    if (!c) return undefined;
    switch (c.commandName) {
      case 'DescribeStackResource':
        if (opts.failDescribe?.()) throw new Error('AccessDenied');
        if (c.input['StackName'] === 'App' && c.input['LogicalResourceId'] === 'A') {
          return { StackResourceDetail: { PhysicalResourceId: ARN_A } };
        }
        if (c.input['StackName'] === ARN_A && c.input['LogicalResourceId'] === 'B') {
          return { StackResourceDetail: { PhysicalResourceId: ARN_B } };
        }
        throw new Error('unexpected DescribeStackResource');
      case 'ListStackResources':
        return {
          StackResourceSummaries: [
            { LogicalResourceId: 'Q', PhysicalResourceId: 'q-1', ResourceType: 'AWS::SQS::Queue' },
          ],
        };
      case 'DescribeStacks':
        return { Stacks: [{ Outputs: [] }] };
      default:
        throw new Error(`unexpected ${c.commandName}`);
    }
  });
}

const calls = (name: string): Cmd[] =>
  sendMock.mock.calls.map((c) => c[0] as Cmd).filter((c) => c?.commandName === name);

describe('CfnLocalStateProvider nestedPath', () => {
  beforeEach(() => sendMock.mockReset());

  it('walks the chain with DescribeStackResource and targets the nested stack', async () => {
    script();
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'App',
      nestedPath: ['A', 'B'],
      region: 'us-east-1',
    });
    const rec = await provider.load('App~A~B', undefined);
    expect(rec?.resources['Q']?.physicalId).toBe('q-1');
    expect(calls('DescribeStackResource').map((c) => c.input)).toEqual([
      { StackName: 'App', LogicalResourceId: 'A' },
      { StackName: ARN_A, LogicalResourceId: 'B' },
    ]);
    expect(calls('ListStackResources')[0]!.input['StackName']).toBe(ARN_B);
    expect(calls('DescribeStacks')[0]!.input['StackName']).toBe(ARN_B);

    await provider.load('App~A~B', undefined);
    expect(calls('DescribeStackResource')).toHaveLength(2);
    provider.dispose();
  });

  it('returns undefined with a DescribeStackResource error, then retries on the next load', async () => {
    let fail = true;
    script({ failDescribe: () => fail });
    const provider = new CfnLocalStateProvider({
      cfnStackName: 'App',
      nestedPath: ['A', 'B'],
      region: 'us-east-1',
    });
    expect(await provider.load('App~A~B', undefined)).toBeUndefined();
    expect(provider.getLastLoadError()).toMatch(/DescribeStackResource/);

    fail = false;
    const rec = await provider.load('App~A~B', undefined);
    expect(rec?.resources['Q']?.physicalId).toBe('q-1');
    expect(provider.getLastLoadError()).toBeUndefined();
    provider.dispose();
  });

  it('does not call DescribeStackResource without nestedPath', async () => {
    script();
    const provider = new CfnLocalStateProvider({ cfnStackName: 'App', region: 'us-east-1' });
    await provider.load('App', undefined);
    expect(calls('DescribeStackResource')).toHaveLength(0);
    expect(calls('ListStackResources')[0]!.input['StackName']).toBe('App');
    provider.dispose();
  });
});
