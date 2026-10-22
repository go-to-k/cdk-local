/**
 * go-to-k/cdk-local#761: the --from-cfn-stack provider's ListStackResources /
 * DescribeStacks / region warnings. The stack name and region come from the
 * command line / assembly, so a forging value renders as ONE JSON literal while
 * a plain one prints bare. Expected strings are written by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/** The logger line without colour or the severity prefix, which depend on the TTY / env the suite runs under. */
function plainLogLine(m: unknown): string {
  // eslint-disable-next-line no-control-regex -- ANSI SGR sequences are what is stripped.
  return String(m).replace(/\u001b\[[0-9;]*m/g, '').replace(/^(?:WARN|ERROR): /, '');
}

const { cfnSend } = vi.hoisted(() => ({ cfnSend: vi.fn() }));

class AnyCommand {
  constructor(public input?: unknown) {}
}
vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = cfnSend;
    destroy(): void {}
  },
  ListStackResourcesCommand: AnyCommand,
  DescribeStacksCommand: AnyCommand,
  ListExportsCommand: AnyCommand,
}));

const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');

let lines: string[] = [];

beforeEach(() => {
  cfnSend.mockReset();
  lines = [];
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
    lines.push(plainLogLine(m));
  });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function warnAfterLoad(stack: string, region: string, needle: string): Promise<string> {
  const p = new CfnLocalStateProvider({ cfnStackName: stack, region });
  await p.load('S', undefined);
  p.dispose();
  const l = lines.find((x) => x.includes(needle));
  expect(l, `no warn contained ${needle}`).toBeDefined();
  return l!.replace(/^.*?WARN: /, '');
}

describe('cfn-local-state-provider ListStackResources warn (#761)', () => {
  beforeEach(() => {
    cfnSend.mockRejectedValue(new Error('boom'));
  });

  it('plain stack name and region print bare', async () => {
    const line = await warnAfterLoad('MyStack', 'us-east-1', 'ListStackResources(');
    expect(line.startsWith('--from-cfn-stack: ListStackResources(MyStack) failed: ')).toBe(true);
    expect(line.endsWith('. Was the stack deployed in region us-east-1? Falling back.')).toBe(true);
  });

  it('forging stack name and region print as JSON literals', async () => {
    const line = await warnAfterLoad("a' b", 'us\u001b[2Kforged', 'ListStackResources(');
    expect(line.startsWith(`--from-cfn-stack: ListStackResources("a' b") failed: `)).toBe(true);
    expect(line.endsWith('. Was the stack deployed in region "us [2Kforged"? Falling back.')).toBe(
      true
    );
  });
});

describe('cfn-local-state-provider DescribeStacks warns (#761)', () => {
  it('returned no stack: plain bare, forging quoted', async () => {
    cfnSend.mockResolvedValueOnce({ StackResourceSummaries: [] }).mockResolvedValueOnce({ Stacks: [] });
    expect(await warnAfterLoad('MyStack', 'us-east-1', 'DescribeStacks(')).toBe(
      '--from-cfn-stack: DescribeStacks(MyStack) returned no stack; outputs will be empty.'
    );
    lines = [];
    cfnSend.mockResolvedValueOnce({ StackResourceSummaries: [] }).mockResolvedValueOnce({ Stacks: [] });
    expect(await warnAfterLoad("a' b", 'us-east-1', 'DescribeStacks(')).toBe(
      `--from-cfn-stack: DescribeStacks("a' b") returned no stack; outputs will be empty.`
    );
  });

  it('failed: plain bare, forging quoted', async () => {
    cfnSend.mockResolvedValueOnce({ StackResourceSummaries: [] }).mockRejectedValueOnce(new Error('x'));
    const plain = await warnAfterLoad('MyStack', 'us-east-1', 'DescribeStacks(');
    expect(plain.startsWith('--from-cfn-stack: DescribeStacks(MyStack) failed: ')).toBe(true);
    lines = [];
    cfnSend.mockResolvedValueOnce({ StackResourceSummaries: [] }).mockRejectedValueOnce(new Error('x'));
    const forged = await warnAfterLoad('x\u001b[2Kforged', 'us-east-1', 'DescribeStacks(');
    expect(forged.startsWith('--from-cfn-stack: DescribeStacks("x [2Kforged") failed: ')).toBe(true);
  });
});
