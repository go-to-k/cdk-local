import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Capture the SSMClient constructor config + script the shared `send`
// mock so `resolveSsmParameters` can be exercised without real AWS.
const { sendMock, ctorMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  ctorMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = sendMock;
    destroy(): void {}
    constructor(config: unknown) {
      ctorMock(config);
    }
  },
  GetParametersCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

const { collectSsmParameterRefs, resolveSsmParameters, formatSsmError } = await import(
  '../../../src/local/ssm-parameter-resolver.js'
);
const { SSMClient } = await import('@aws-sdk/client-ssm');

describe('collectSsmParameterRefs', () => {
  it('collects AWS::SSM::Parameter::Value<String> entries with a string Default', () => {
    const refs = collectSsmParameterRefs({
      Parameters: {
        SsmStr: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/db-host' },
      },
    });
    expect(refs).toEqual([{ logicalId: 'SsmStr', ssmName: '/app/db-host', isList: false }]);
  });

  it('flags the List<String> variant via isList', () => {
    const refs = collectSsmParameterRefs({
      Parameters: {
        SsmList: { Type: 'AWS::SSM::Parameter::Value<List<String>>', Default: '/app/subnets' },
      },
    });
    expect(refs).toEqual([{ logicalId: 'SsmList', ssmName: '/app/subnets', isList: true }]);
  });

  it('ignores non-SSM parameter types and SSM entries without a string Default', () => {
    const refs = collectSsmParameterRefs({
      Parameters: {
        Plain: { Type: 'String', Default: 'literal' },
        NoDefault: { Type: 'AWS::SSM::Parameter::Value<String>' },
        EmptyDefault: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '' },
      },
    });
    expect(refs).toEqual([]);
  });

  it('returns [] when there is no Parameters block', () => {
    expect(collectSsmParameterRefs({})).toEqual([]);
    expect(collectSsmParameterRefs(undefined)).toEqual([]);
  });
});

describe('resolveSsmParameters', () => {
  beforeEach(() => {
    sendMock.mockReset();
    ctorMock.mockReset();
  });

  it('resolves a String parameter into the logicalId -> value map', async () => {
    sendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/app/db-host', Value: 'db.internal' }],
      InvalidParameters: [],
    });
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(
      client,
      [{ logicalId: 'SsmStr', ssmName: '/app/db-host', isList: false }],
      '--from-cfn-stack'
    );
    expect(out).toEqual({ SsmStr: 'db.internal' });
    // WithDecryption must be set so SecureString parameters resolve.
    const cmd = sendMock.mock.calls[0]![0] as { input: { Names: string[]; WithDecryption: boolean } };
    expect(cmd.input).toEqual({ Names: ['/app/db-host'], WithDecryption: true });
  });

  it('passes the comma-joined List<String> value through verbatim', async () => {
    sendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/app/subnets', Value: 'subnet-a,subnet-b' }],
      InvalidParameters: [],
    });
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(
      client,
      [{ logicalId: 'SsmList', ssmName: '/app/subnets', isList: true }],
      '--from-cfn-stack'
    );
    expect(out).toEqual({ SsmList: 'subnet-a,subnet-b' });
  });

  it('maps multiple logical IDs that share one SSM name', async () => {
    sendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/shared', Value: 'one' }],
      InvalidParameters: [],
    });
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(
      client,
      [
        { logicalId: 'A', ssmName: '/shared', isList: false },
        { logicalId: 'B', ssmName: '/shared', isList: false },
      ],
      '--from-cfn-stack'
    );
    expect(out).toEqual({ A: 'one', B: 'one' });
    // De-duped to one SSM name -> one GetParameters call.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('chunks names into batches of 10', async () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({
      logicalId: `P${i}`,
      ssmName: `/p/${i}`,
      isList: false,
    }));
    sendMock
      .mockResolvedValueOnce({
        Parameters: refs.slice(0, 10).map((r) => ({ Name: r.ssmName, Value: `v${r.logicalId}` })),
        InvalidParameters: [],
      })
      .mockResolvedValueOnce({
        Parameters: refs.slice(10).map((r) => ({ Name: r.ssmName, Value: `v${r.logicalId}` })),
        InvalidParameters: [],
      });
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(client, refs, '--from-cfn-stack');
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(out)).toHaveLength(12);
    expect(out['P11']).toBe('vP11');
  });

  it('omits invalid parameter names from the result (warn-and-drop)', async () => {
    sendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/ok', Value: 'good' }],
      InvalidParameters: ['/missing'],
    });
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(
      client,
      [
        { logicalId: 'Ok', ssmName: '/ok', isList: false },
        { logicalId: 'Missing', ssmName: '/missing', isList: false },
      ],
      '--from-cfn-stack'
    );
    expect(out).toEqual({ Ok: 'good' });
  });

  it('falls back to an empty map (no throw) when GetParameters fails', async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    );
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(
      client,
      [{ logicalId: 'SsmStr', ssmName: '/app/db-host', isList: false }],
      '--from-cfn-stack'
    );
    expect(out).toEqual({});
  });

  it('keeps resolving other chunks when one chunk fails', async () => {
    const refs = Array.from({ length: 11 }, (_, i) => ({
      logicalId: `P${i}`,
      ssmName: `/p/${i}`,
      isList: false,
    }));
    sendMock
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({
        Parameters: refs.slice(10).map((r) => ({ Name: r.ssmName, Value: 'late' })),
        InvalidParameters: [],
      });
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(client, refs, '--from-cfn-stack');
    // First chunk (10) failed; second chunk (1) succeeded.
    expect(out).toEqual({ P10: 'late' });
  });

  it('returns {} without calling SSM when there are no refs', async () => {
    const client = new SSMClient({ region: 'us-east-1' });
    expect(await resolveSsmParameters(client, [], '--from-cfn-stack')).toEqual({});
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('formatSsmError', () => {
  it('prefixes the error name when present', () => {
    expect(formatSsmError(Object.assign(new Error('nope'), { name: 'ThrottlingException' }))).toBe(
      'ThrottlingException: nope'
    );
  });
  it('falls back to the bare message for a plain Error', () => {
    expect(formatSsmError(new Error('boom'))).toBe('boom');
  });
  it('stringifies non-Error throwables', () => {
    expect(formatSsmError('weird')).toBe('weird');
  });
});
