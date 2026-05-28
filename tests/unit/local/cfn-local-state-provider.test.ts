import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import {
  fetchAllStackResources,
  buildResourceStateMap,
} from '../../../src/local/cfn-local-state-provider.js';

/**
 * Helper: a fake `CloudFormationClient` whose `send` returns the supplied
 * `ListStackResources` responses in order. Only `send` is exercised by the
 * code under test, so the cast through `unknown` is safe.
 */
function fakeClient(responses: unknown[]): { client: CloudFormationClient; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  for (const r of responses) send.mockResolvedValueOnce(r);
  return { client: { send } as unknown as CloudFormationClient, send };
}

function summary(i: number) {
  return {
    LogicalResourceId: `Resource${i}`,
    PhysicalResourceId: `physical-${i}`,
    ResourceType: 'AWS::SSM::Parameter',
  };
}

describe('fetchAllStackResources', () => {
  it('walks every page so a >100-resource stack is mapped completely', async () => {
    // The bug this guards: DescribeStackResources caps at the first 100
    // resources. ListStackResources paginates — page 1 has 100, page 2 has
    // the 5 that DescribeStackResources would have silently dropped.
    const page1 = Array.from({ length: 100 }, (_, i) => summary(i));
    const page2 = Array.from({ length: 5 }, (_, i) => summary(100 + i));
    const { client, send } = fakeClient([
      { StackResourceSummaries: page1, NextToken: 'page-2' },
      { StackResourceSummaries: page2 },
    ]);

    const all = await fetchAllStackResources(client, 'MyStack');

    expect(all).toHaveLength(105);
    expect(send).toHaveBeenCalledTimes(2);
    // Second call must carry the NextToken from page 1.
    const secondInput = (send.mock.calls[1]![0] as { input: { NextToken?: string } }).input;
    expect(secondInput.NextToken).toBe('page-2');

    // The resource at index 104 — beyond the DescribeStackResources cap —
    // must be present and resolvable via the resource map.
    const map = buildResourceStateMap(all);
    expect(Object.keys(map)).toHaveLength(105);
    expect(map['Resource104']?.physicalId).toBe('physical-104');
  });

  it('single page (no NextToken) issues exactly one call', async () => {
    const { client, send } = fakeClient([
      { StackResourceSummaries: [summary(0), summary(1)] },
    ]);
    const all = await fetchAllStackResources(client, 'MyStack');
    expect(all).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('treats an empty-string NextToken as terminal', async () => {
    const { client, send } = fakeClient([
      { StackResourceSummaries: [summary(0)], NextToken: '' },
    ]);
    const all = await fetchAllStackResources(client, 'MyStack');
    expect(all).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throws on a runaway NextToken loop instead of paging forever', async () => {
    const send = vi.fn().mockResolvedValue({ StackResourceSummaries: [], NextToken: 'never-ends' });
    const client = { send } as unknown as CloudFormationClient;
    await expect(fetchAllStackResources(client, 'MyStack')).rejects.toThrow(/exceeded 100 pages/);
  });
});

describe('buildResourceStateMap', () => {
  it('skips half-populated entries (mid-create resources, CDK metadata sentinels)', () => {
    const map = buildResourceStateMap([
      { LogicalResourceId: 'Good', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      { LogicalResourceId: 'NoPhysical', ResourceType: 'AWS::S3::Bucket' },
      { PhysicalResourceId: 'p2', ResourceType: 'AWS::S3::Bucket' },
      { LogicalResourceId: 'NoType', PhysicalResourceId: 'p3' },
    ]);
    expect(Object.keys(map)).toEqual(['Good']);
    expect(map['Good']).toEqual({
      physicalId: 'p',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      attributes: {},
      dependencies: [],
    });
  });
});
