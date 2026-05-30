import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock the SDK so `load()` (which constructs its own CloudFormationClient
// via the lazy getClient()) can be exercised without real AWS. `load()`
// always calls ListStackResources first, then DescribeStacks, so the tests
// script the shared `send` mock in that fixed order with mockResolvedValueOnce.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = sendMock;
    destroy(): void {}
  },
  ListStackResourcesCommand: class {},
  DescribeStacksCommand: class {},
  ListExportsCommand: class {},
}));

const { CfnLocalStateProvider, buildOutputsMap, formatAwsErrorForWarn } = await import(
  '../../../src/local/cfn-local-state-provider.js'
);

describe('CfnLocalStateProvider.load', () => {
  beforeEach(() => sendMock.mockReset());

  it('returns resources + outputs on the happy path', async () => {
    sendMock
      .mockResolvedValueOnce({
        StackResourceSummaries: [
          { LogicalResourceId: 'Table', PhysicalResourceId: 'tbl-1', ResourceType: 'AWS::DynamoDB::Table' },
        ],
      })
      .mockResolvedValueOnce({ Stacks: [{ Outputs: [{ OutputKey: 'Url', OutputValue: 'https://x' }] }] });

    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    const rec = await provider.load('S', undefined);

    expect(rec).toBeDefined();
    expect(rec!.resources['Table']?.physicalId).toBe('tbl-1');
    expect(rec!.outputs['Url']).toBe('https://x');
    expect(rec!.region).toBe('us-east-1');
    provider.dispose();
  });

  it('returns undefined (warn-and-fallback) when ListStackResources fails', async () => {
    sendMock.mockRejectedValueOnce(new Error('AccessDenied'));
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    expect(await provider.load('S', undefined)).toBeUndefined();
    provider.dispose();
  });

  it('records the ListStackResources failure detail in getLastLoadError() for downstream remedies', async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error('Stack with id Wrong does not exist'), {
        name: 'ValidationError',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const provider = new CfnLocalStateProvider({ cfnStackName: 'Wrong', region: 'ap-northeast-1' });
    expect(await provider.load('Wrong', undefined)).toBeUndefined();
    const detail = provider.getLastLoadError();
    expect(detail).toBeDefined();
    expect(detail).toContain('ListStackResources(Wrong) failed:');
    expect(detail).toContain('ValidationError HTTP 400: Stack with id Wrong does not exist');
    expect(detail).toContain("region='ap-northeast-1'");
    // Should NOT include the `--from-cfn-stack:` label prefix the
    // warn-logger adds — the downstream resolver wraps it in its own framing.
    expect(detail).not.toMatch(/^--from-cfn-stack:/);
    provider.dispose();
  });

  it('clears getLastLoadError() on a subsequent successful load', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('first-fail'))
      .mockResolvedValueOnce({
        StackResourceSummaries: [
          { LogicalResourceId: 'X', PhysicalResourceId: 'x', ResourceType: 'AWS::SNS::Topic' },
        ],
      })
      .mockResolvedValueOnce({ Stacks: [{ Outputs: [] }] });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    expect(await provider.load('S', undefined)).toBeUndefined();
    expect(provider.getLastLoadError()).toContain('ListStackResources(S) failed:');
    const second = await provider.load('S', undefined);
    expect(second).toBeDefined();
    expect(provider.getLastLoadError()).toBeUndefined();
    provider.dispose();
  });

  it('returns undefined from getLastLoadError() before any load() call', () => {
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    expect(provider.getLastLoadError()).toBeUndefined();
    provider.dispose();
  });

  it('throws from getLastLoadError() after dispose() (parity with load() / buildCrossStackResolver())', () => {
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    provider.dispose();
    expect(() => provider.getLastLoadError()).toThrow(/used after dispose/);
  });

  it('keeps resources but empties outputs when DescribeStacks returns no stack', async () => {
    sendMock
      .mockResolvedValueOnce({
        StackResourceSummaries: [
          { LogicalResourceId: 'Q', PhysicalResourceId: 'q-url', ResourceType: 'AWS::SQS::Queue' },
        ],
      })
      .mockResolvedValueOnce({ Stacks: [] });
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    const rec = await provider.load('S', undefined);
    expect(rec!.resources['Q']?.physicalId).toBe('q-url');
    expect(rec!.outputs).toEqual({});
    provider.dispose();
  });

  it('keeps resources but empties outputs when DescribeStacks throws', async () => {
    sendMock
      .mockResolvedValueOnce({
        StackResourceSummaries: [
          { LogicalResourceId: 'Q', PhysicalResourceId: 'q-url', ResourceType: 'AWS::SQS::Queue' },
        ],
      })
      .mockRejectedValueOnce(new Error('Throttling'));
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    const rec = await provider.load('S', undefined);
    expect(rec!.resources['Q']?.physicalId).toBe('q-url');
    expect(rec!.outputs).toEqual({});
    provider.dispose();
  });

  it('throws on use after dispose()', async () => {
    const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
    provider.dispose();
    await expect(provider.load('S', undefined)).rejects.toThrow(/after dispose/);
  });
});

describe('buildOutputsMap', () => {
  it('maps OutputKey -> OutputValue and skips undefined entries', () => {
    expect(
      buildOutputsMap([{ OutputKey: 'A', OutputValue: '1' }, { OutputKey: 'B' }, { OutputValue: '2' }])
    ).toEqual({ A: '1' });
  });
});

describe('formatAwsErrorForWarn', () => {
  it('prefixes the error name and HTTP status', () => {
    const err = Object.assign(new Error('boom'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    });
    expect(formatAwsErrorForWarn(err)).toBe('ThrottlingException HTTP 400: boom');
  });

  it('falls back to the bare message for a generic Error', () => {
    expect(formatAwsErrorForWarn(new Error('plain'))).toBe('plain');
  });

  it('stringifies non-Error values', () => {
    expect(formatAwsErrorForWarn('weird')).toBe('weird');
  });
});
