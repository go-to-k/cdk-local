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

const { collectSsmParameterRefs, resolveSsmParameters } = await import(
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

  it('collects Value<AWS-specific type> as scalar and every list form as a list (issue #976)', () => {
    const scalarTypes = [
      'AWS::EC2::AvailabilityZone::Name',
      'AWS::EC2::Image::Id',
      'AWS::EC2::Instance::Id',
      'AWS::EC2::KeyPair::KeyName',
      'AWS::EC2::SecurityGroup::GroupName',
      'AWS::EC2::SecurityGroup::Id',
      'AWS::EC2::Subnet::Id',
      'AWS::EC2::Volume::Id',
      'AWS::EC2::VPC::Id',
      'AWS::Route53::HostedZone::Id',
    ];
    const Parameters: Record<string, { Type: string; Default: string }> = {};
    const expected: Array<{ logicalId: string; ssmName: string; isList: boolean }> = [];
    scalarTypes.forEach((t, i) => {
      Parameters[`S${i}`] = { Type: `AWS::SSM::Parameter::Value<${t}>`, Default: `/s/${i}` };
      expected.push({ logicalId: `S${i}`, ssmName: `/s/${i}`, isList: false });
      Parameters[`L${i}`] = { Type: `AWS::SSM::Parameter::Value<List<${t}>>`, Default: `/l/${i}` };
      expected.push({ logicalId: `L${i}`, ssmName: `/l/${i}`, isList: true });
    });
    Parameters['Csv'] = { Type: 'AWS::SSM::Parameter::Value<CommaDelimitedList>', Default: '/csv' };
    expected.push({ logicalId: 'Csv', ssmName: '/csv', isList: true });
    expect(collectSsmParameterRefs({ Parameters })).toEqual(expected);
  });

  it('skips SSM-shaped types CloudFormation does not resolve to a value', () => {
    const refs = collectSsmParameterRefs({
      Parameters: {
        // `Ref` to a Name parameter is the parameter NAME, not its value.
        Name: { Type: 'AWS::SSM::Parameter::Name', Default: '/n' },
        Unknown: { Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Nope::Id>', Default: '/u' },
        Nested: { Type: 'AWS::SSM::Parameter::Value<List<List<String>>>', Default: '/x' },
        ListOfValues: { Type: 'List<AWS::SSM::Parameter::Value<String>>', Default: '/y' },
        Unclosed: { Type: 'AWS::SSM::Parameter::Value<String', Default: '/z' },
      },
    });
    expect(refs).toEqual([]);
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
    expect(out.values).toEqual({ SsmStr: 'db.internal' });
    // A plain String parameter is not flagged sensitive.
    expect(out.secureStringLogicalIds).toEqual([]);
    // WithDecryption must be set so SecureString parameters resolve.
    const cmd = sendMock.mock.calls[0]![0] as { input: { Names: string[]; WithDecryption: boolean } };
    expect(cmd.input).toEqual({ Names: ['/app/db-host'], WithDecryption: true });
  });

  it('flags a SecureString parameter via secureStringLogicalIds (issue #99)', async () => {
    sendMock.mockResolvedValueOnce({
      Parameters: [
        { Name: '/app/db-host', Value: 'db.internal', Type: 'String' },
        { Name: '/app/api-key', Value: 's3cr3t', Type: 'SecureString' },
      ],
      InvalidParameters: [],
    });
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(
      client,
      [
        { logicalId: 'SsmStr', ssmName: '/app/db-host', isList: false },
        { logicalId: 'SsmSecret', ssmName: '/app/api-key', isList: false },
      ],
      '--from-cfn-stack'
    );
    expect(out.values).toEqual({ SsmStr: 'db.internal', SsmSecret: 's3cr3t' });
    // Only the SecureString logical ID is flagged.
    expect(out.secureStringLogicalIds).toEqual(['SsmSecret']);
  });

  it('flags every logical ID that shares one SecureString SSM name', async () => {
    sendMock.mockResolvedValueOnce({
      Parameters: [{ Name: '/shared/secret', Value: 'x', Type: 'SecureString' }],
      InvalidParameters: [],
    });
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(
      client,
      [
        { logicalId: 'A', ssmName: '/shared/secret', isList: false },
        { logicalId: 'B', ssmName: '/shared/secret', isList: false },
      ],
      '--from-cfn-stack'
    );
    expect(out.values).toEqual({ A: 'x', B: 'x' });
    expect(out.secureStringLogicalIds).toEqual(['A', 'B']);
  });

  it('splits a list parameter value on "," and leaves a scalar one whole (issue #976)', async () => {
    sendMock.mockResolvedValueOnce({
      Parameters: [
        { Name: '/app/subnets', Value: 'subnet-a,subnet-b' },
        { Name: '/app/csv', Value: 'x,y' },
      ],
      InvalidParameters: [],
    });
    const client = new SSMClient({ region: 'us-east-1' });
    const out = await resolveSsmParameters(
      client,
      [
        { logicalId: 'SsmList', ssmName: '/app/subnets', isList: true },
        { logicalId: 'SsmScalar', ssmName: '/app/csv', isList: false },
      ],
      '--from-cfn-stack'
    );
    expect(out.values).toEqual({ SsmList: ['subnet-a', 'subnet-b'], SsmScalar: 'x,y' });
    expect(out.secureStringLogicalIds).toEqual([]);
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
    expect(out.values).toEqual({ A: 'one', B: 'one' });
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
    expect(Object.keys(out.values)).toHaveLength(12);
    expect(out.values['P11']).toBe('vP11');
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
    expect(out.values).toEqual({ Ok: 'good' });
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
    expect(out.values).toEqual({});
    expect(out.secureStringLogicalIds).toEqual([]);
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
    expect(out.values).toEqual({ P10: 'late' });
  });

  it('returns an empty result without calling SSM when there are no refs', async () => {
    const client = new SSMClient({ region: 'us-east-1' });
    expect(await resolveSsmParameters(client, [], '--from-cfn-stack')).toEqual({
      values: {},
      secureStringLogicalIds: [],
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// `formatSsmError` was DELETED by issue #579 rather than fixed: it was a second
// spelling of `cfn-local-state-provider`'s `formatAwsErrorForWarn`, and both
// interpolated an UNCLAMPED wire-derived `err.name`. The one call site now
// routes through `credential-error`'s `describeAwsFailureForWarn`, and the
// per-occurrence coverage for it lives in
// `tests/unit/local/aws-error-relay-sites.test.ts`.
