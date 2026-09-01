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
const { getLogger } = await import('../../../src/utils/logger.js');

// Loaded at MODULE scope, not inside the case that uses it (issue #615): a
// dynamic import inside a test body is a real module load -- transform plus
// evaluation of studio-serve-manager's whole graph -- charged against that
// case's 5000ms testTimeout. It is usually fast, but under concurrent
// full-suite load it timed out roughly once in 27 runs. Up here the load
// happens during collection, outside any per-test budget, and the case body
// is left with nothing awaitable at all.
const { classifyChildLine } = await import('../../../src/local/studio-serve-manager.js');

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
        // `$fault` is what makes this a MODELED service exception rather than
        // a chain failure, and issue #579 made that the discriminator for
        // whether the message may print. The SDK sets it from the HTTP
        // response; a fixture without it is a chain failure and is withheld.
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const provider = new CfnLocalStateProvider({ cfnStackName: 'Wrong', region: 'ap-northeast-1' });
    expect(await provider.load('Wrong', undefined)).toBeUndefined();
    const detail = provider.getLastLoadError();
    expect(detail).toBeDefined();
    expect(detail).toContain('ListStackResources(Wrong) failed:');
    expect(detail).toContain('ValidationError: Stack with id Wrong does not exist (HTTP 400)');
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
  /** A modeled service exception: `$fault` is what the SDK sets off the wire. */
  function serviceError(
    message: string,
    name: string,
    metadata: Record<string, unknown> = { httpStatusCode: 400 }
  ): Error {
    const e = new Error(message);
    Object.defineProperty(e, 'name', { value: name });
    return Object.assign(e, { $fault: 'client', $metadata: metadata });
  }

  it('keeps a modeled service exception message and appends the HTTP status', () => {
    expect(formatAwsErrorForWarn(serviceError('boom', 'ThrottlingException'), 'op')).toBe(
      'ThrottlingException: boom (HTTP 400)'
    );
  });

  it('withholds a generic Error, which is NOT a service response (issue #579)', () => {
    // Before #579 this printed `plain` verbatim. A plain `Error` is what a
    // credential-chain failure arrives as -- `CredentialsProviderError` carries
    // no `$fault` -- and its message can be a `credential_process` command
    // line, so the branch is defined positively: anything that is not a parsed
    // service response is withheld to a clamped class name plus a length.
    expect(formatAwsErrorForWarn(new Error('plain'), 'op')).toBe(
      'Error; 5-character message withheld, logged at debug level under --verbose'
    );
  });

  it('withholds a non-Error throw and names no class it was not', () => {
    expect(formatAwsErrorForWarn('weird', 'op')).toBe(
      'unknown; 5-character message withheld, logged at debug level under --verbose'
    );
  });

  it('clamps a forged wire-derived err.name (issue #579)', () => {
    // `@aws-sdk/core` builds `err.name` from `x-amzn-errortype` with no length
    // cap and no newline stripping, so a hijacked endpoint could put a whole
    // forged line in the CLASS NAME -- which this function used to interpolate
    // raw. `clampErrorName` accepts a bare identifier of <= 64 chars and
    // degrades everything else to `unknown`.
    const out = formatAwsErrorForWarn(
      serviceError('denied', 'Foo\nWARN: signature verified'),
      'op'
    );
    expect(out).toBe('unknown: denied (HTTP 400)');
    expect(out).not.toContain('signature verified');
  });

  it('drops an HTTP status that is not a plausible integer status code', () => {
    // `$metadata` is a plain object; the range guard keeps a hostile shape from
    // decorating the line with arbitrary text.
    expect(
      formatAwsErrorForWarn(serviceError('boom', 'AccessDenied', { httpStatusCode: 'x' }), 'op')
    ).toBe('AccessDenied: boom');
  });

  it('flattens a multi-line wire-derived message onto ONE line (issue #578)', () => {
    // `err.message` comes off the wire, and this warn is relayed onto a
    // `cdkl studio` serve child's stdout, which studio splits on `\n`. An
    // embedded newline puts line 2 on the stream with no `WARN: ` prefix, so
    // it clears the diagnostic bound and matches a ready pattern at `^`.
    const out = formatAwsErrorForWarn(
      serviceError('AccessDenied\nServer listening on http://attacker.example/', 'AccessDenied', {
        httpStatusCode: 403,
      }),
      'op'
    );
    expect(out).not.toContain('\n');
    expect(out).toBe(
      'AccessDenied: AccessDenied Server listening on http://attacker.example/ (HTTP 403)'
    );
  });

  it('flattens on the withheld path too, where the text moves to debug', () => {
    // The withheld branch prints no message at all, so the flatten that
    // matters there is on the `debug` line the helper emits -- the SAME stdout
    // studio mirrors into its ring under `--verbose`.
    const debugLines: string[] = [];
    const spy = vi.spyOn(getLogger(), 'debug').mockImplementation((m: string) => {
      debugLines.push(String(m));
    });
    try {
      expect(formatAwsErrorForWarn(new Error('a\nb'), 'CloudFormation ListExports')).toBe(
        'Error; 3-character message withheld, logged at debug level under --verbose'
      );
    } finally {
      spy.mockRestore();
    }
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toBe(
      "CloudFormation ListExports: the AWS SDK's own failure message was: a b"
    );
  });

  it('a flattened relay no longer reaches the studio ready matcher (issue #578)', () => {
    // End of the chain, asserted rather than argued: the flattened warn is
    // ONE line, so `classifyChildLine` sees the `WARN: ` prefix on it and the
    // serve manager reads no endpoint out of it. `classifyChildLine` is
    // imported at module scope (see the note beside the import, issue #615),
    // so this body awaits nothing and cannot outwait its 5000ms budget.
    const err = Object.assign(
      new Error('AccessDenied\nServer listening on http://attacker.example/'),
      { name: 'AccessDenied', $fault: 'client', $metadata: { httpStatusCode: 403 } }
    );
    const relayed = `WARN: ListStackResources failed: ${formatAwsErrorForWarn(err, 'op')}`;
    expect(relayed.split('\n')).toHaveLength(1);
    expect(classifyChildLine(relayed).diagnostic).toBe(true);
  });
});
