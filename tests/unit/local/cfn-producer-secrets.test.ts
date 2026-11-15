import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6339: `--from-cfn-stack`'s cross-stack resolver judges an
// exported value against its PRODUCER stack, read from CloudFormation. The
// SDK is mocked: `send` dispatches on the command class, and each stack's
// resources / outputs / template come from the fixture below.

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-cloudformation', () => {
  class Command {
    public readonly input: Record<string, unknown>;
    public constructor(input: Record<string, unknown> = {}) {
      this.input = input;
    }
  }
  return {
    CloudFormationClient: class {
      send = sendMock;
      destroy(): void {}
    },
    ListStackResourcesCommand: class ListStackResourcesCommand extends Command {},
    DescribeStacksCommand: class DescribeStacksCommand extends Command {},
    ListExportsCommand: class ListExportsCommand extends Command {},
    GetTemplateCommand: class GetTemplateCommand extends Command {},
  };
});

const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');
const { secretPhysicalIdSegment } = await import('../../../src/local/cfn-producer-secrets.js');

const KEY = 'da2-abcdefghijklmnopqrstuvwxyz';
const NESTED_KEY = 'da2-nestednestednestednested';
const PRODUCER = 'arn:aws:cloudformation:us-east-1:123456789012:stack/Producer/p-1';
const NESTED = 'arn:aws:cloudformation:us-east-1:123456789012:stack/Producer-Nested/n-1';
const REEXPORTER = 'arn:aws:cloudformation:us-east-1:123456789012:stack/ReExporter/r-1';

interface StackFixture {
  resources: { LogicalResourceId: string; PhysicalResourceId: string; ResourceType: string }[];
  outputs: { OutputKey: string; OutputValue: string; ExportName?: string }[];
  template: Record<string, unknown> | string;
}

let stacks: Record<string, StackFixture>;
let exportsList: { Name: string; Value: string; ExportingStackId?: string }[];
let failing: Set<string>;

function fixture(): void {
  failing = new Set();
  stacks = {
    [PRODUCER]: {
      resources: [
        {
          LogicalResourceId: 'ApiKey',
          PhysicalResourceId: `arn:aws:appsync:us-east-1:123456789012:apis/api1/apikeys/${KEY}`,
          ResourceType: 'AWS::AppSync::ApiKey',
        },
        { LogicalResourceId: 'Bucket', PhysicalResourceId: 'my-bucket', ResourceType: 'AWS::S3::Bucket' },
        { LogicalResourceId: 'Key', PhysicalResourceId: 'AKIAEXAMPLE', ResourceType: 'AWS::IAM::AccessKey' },
        { LogicalResourceId: 'Nested', PhysicalResourceId: NESTED, ResourceType: 'AWS::CloudFormation::Stack' },
      ],
      outputs: [
        { OutputKey: 'KeyOut', OutputValue: KEY, ExportName: 'P-Key' },
        { OutputKey: 'KeyIdOut', OutputValue: KEY, ExportName: 'P-KeyId' },
        {
          OutputKey: 'KeyArnOut',
          OutputValue: `arn:aws:appsync:us-east-1:123456789012:apis/api1/apikeys/${KEY}`,
          ExportName: 'P-KeyRef',
        },
        { OutputKey: 'BucketOut', OutputValue: 'my-bucket', ExportName: 'P-Bucket' },
        { OutputKey: 'PwOut', OutputValue: 'noecho-plaintext', ExportName: 'P-Pw' },
        { OutputKey: 'PlainParamOut', OutputValue: 'plain-param-value', ExportName: 'P-PlainParam' },
        { OutputKey: 'SecretOut', OutputValue: 'wJalrXUtnFEMIK7MDENG', ExportName: 'P-Secret' },
        { OutputKey: 'ShortSecretOut', OutputValue: 'strict', ExportName: 'P-ShortSecret' },
        { OutputKey: 'NestedOut', OutputValue: 'stream-key-plaintext', ExportName: 'P-Nested' },
        { OutputKey: 'NestedKeyOut', OutputValue: NESTED_KEY, ExportName: 'P-NestedKey' },
        { OutputKey: 'SubOut', OutputValue: 'pw=noecho-plaintext', ExportName: 'P-Sub' },
        { OutputKey: 'SubShadowOut', OutputValue: 'pw=literal', ExportName: 'P-SubShadow' },
        { OutputKey: 'StaleOut', OutputValue: 'moved-on', ExportName: 'P-Stale' },
      ],
      template: {
        Parameters: {
          Pw: { Type: 'String', NoEcho: true },
          Plain: { Type: 'String' },
        },
        Resources: {
          ApiKey: { Type: 'AWS::AppSync::ApiKey' },
          Bucket: { Type: 'AWS::S3::Bucket' },
          Key: { Type: 'AWS::IAM::AccessKey' },
          Nested: { Type: 'AWS::CloudFormation::Stack' },
        },
        Outputs: {
          KeyOut: { Value: { 'Fn::GetAtt': ['ApiKey', 'ApiKey'] } },
          KeyIdOut: { Value: { 'Fn::GetAtt': 'ApiKey.ApiKeyId' } },
          KeyArnOut: { Value: { Ref: 'ApiKey' } },
          BucketOut: { Value: { Ref: 'Bucket' } },
          PwOut: { Value: { Ref: 'Pw' } },
          PlainParamOut: { Value: { Ref: 'Plain' } },
          SecretOut: { Value: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] } },
          ShortSecretOut: { Value: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] } },
          NestedOut: { Value: { 'Fn::GetAtt': ['Nested', 'Outputs.Stream'] } },
          NestedKeyOut: { Value: { 'Fn::GetAtt': ['Nested', 'Outputs.Opaque'] } },
          SubOut: { Value: { 'Fn::Sub': 'pw=${Pw}' } },
          SubShadowOut: { Value: { 'Fn::Sub': ['pw=${Pw}', { Pw: 'literal' }] } },
          StaleOut: { Value: 'moved-on' },
        },
      },
    },
    [NESTED]: {
      resources: [
        { LogicalResourceId: 'Stream', PhysicalResourceId: 'arn:aws:ivs:stream', ResourceType: 'AWS::IVS::StreamKey' },
        {
          LogicalResourceId: 'NestedApiKey',
          PhysicalResourceId: `api2|${NESTED_KEY}`,
          ResourceType: 'AWS::AppSync::ApiKey',
        },
        { LogicalResourceId: 'Cr', PhysicalResourceId: 'cr-1', ResourceType: 'Custom::Thing' },
      ],
      outputs: [
        { OutputKey: 'Stream', OutputValue: 'stream-key-plaintext' },
        { OutputKey: 'Opaque', OutputValue: NESTED_KEY },
      ],
      template: {
        Resources: {
          Stream: { Type: 'AWS::IVS::StreamKey' },
          NestedApiKey: { Type: 'AWS::AppSync::ApiKey' },
          Cr: { Type: 'Custom::Thing' },
        },
        Outputs: {
          Stream: { Value: { 'Fn::GetAtt': ['Stream', 'Value'] } },
          // A custom resource's attribute is not judged by its name: only the
          // nested tree's ApiKey physical id can tell this one is the key.
          Opaque: { Value: { 'Fn::GetAtt': ['Cr', 'Result'] } },
        },
      },
    },
    [REEXPORTER]: {
      resources: [],
      outputs: [
        { OutputKey: 'Joined', OutputValue: `x-api-key=${KEY}`, ExportName: 'R-Key' },
        { OutputKey: 'JoinedBucket', OutputValue: 's3://my-bucket', ExportName: 'R-Bucket' },
        { OutputKey: 'Computed', OutputValue: 'whatever', ExportName: 'R-Computed' },
      ],
      template: {
        Outputs: {
          Joined: { Value: { 'Fn::Join': ['', ['x-api-key=', { 'Fn::ImportValue': 'P-Key' }]] } },
          JoinedBucket: { Value: { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'P-Bucket' }]] } },
          Computed: { Value: { 'Fn::ImportValue': { 'Fn::Sub': '${AWS::StackName}-X' } } },
        },
      },
    },
  };
  exportsList = [];
  for (const [id, s] of Object.entries(stacks)) {
    for (const o of s.outputs) {
      if (o.ExportName) exportsList.push({ Name: o.ExportName, Value: o.OutputValue, ExportingStackId: id });
    }
  }
  // The index ListExports serves outlived the producer's own output value.
  exportsList.find((e) => e.Name === 'P-Stale')!.Value = 'old-value';
}

function send(cmd: { constructor: { name: string }; input: Record<string, unknown> }): unknown {
  const name = cmd.constructor.name;
  const stackName = cmd.input['StackName'] as string;
  if (failing.has(`${name}:${stackName}`)) {
    const err = new Error('User is not authorized to perform cloudformation:x');
    err.name = 'AccessDenied';
    return Promise.reject(err);
  }
  if (name === 'ListExportsCommand') return Promise.resolve({ Exports: exportsList });
  const stack = stacks[stackName];
  if (!stack) return Promise.reject(new Error(`Stack ${stackName} does not exist`));
  if (name === 'ListStackResourcesCommand') {
    return Promise.resolve({ StackResourceSummaries: stack.resources });
  }
  if (name === 'DescribeStacksCommand') return Promise.resolve({ Stacks: [{ Outputs: stack.outputs }] });
  if (name === 'GetTemplateCommand') {
    return Promise.resolve({
      TemplateBody: typeof stack.template === 'string' ? stack.template : JSON.stringify(stack.template),
    });
  }
  return Promise.reject(new Error(`unexpected ${name}`));
}

async function resolver() {
  const provider = new CfnLocalStateProvider({ cfnStackName: 'Consumer', region: 'us-east-1' });
  const r = (await provider.buildCrossStackResolver('us-east-1'))!;
  return { provider, r };
}

const calls = (name: string): number =>
  sendMock.mock.calls.filter(([c]) => (c as { constructor: { name: string } }).constructor.name === name)
    .length;

describe('--from-cfn-stack producer-secret check (go-to-k/cdkd#6339)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockImplementation(send);
    fixture();
  });

  it('carries both judged variants beside the contract', async () => {
    const { provider, r } = await resolver();
    expect(typeof r.resolveImportJudged).toBe('function');
    expect(typeof r.resolveGetStackOutputJudged).toBe('function');
    provider.dispose();
  });

  it('serves a non-secret export with no verdict, and the plain method reads ListExports only', async () => {
    const { provider, r } = await resolver();
    expect(await r.resolveImport('P-Bucket')).toBe('my-bucket');
    expect(sendMock.mock.calls).toHaveLength(1);
    expect(calls('ListExportsCommand')).toBe(1);
    expect(await r.resolveImportJudged!('P-Bucket')).toEqual({ value: 'my-bucket' });
    // A re-export of a non-secret stays unjudged too.
    expect(await r.resolveImportJudged!('R-Bucket')).toEqual({ value: 's3://my-bucket' });
    provider.dispose();
  });

  it.each([
    ['an ApiKey attribute (typed, by Fn::GetAtt)', 'P-Key'],
    ['an ApiKey attribute (typed, ApiKeyId, dotted Fn::GetAtt)', 'P-KeyId'],
    ['an ApiKey Ref (its ARN ends in the key: physical id)', 'P-KeyRef'],
    ['a NoEcho parameter', 'P-Pw'],
    ['a NoEcho parameter inside Fn::Sub', 'P-Sub'],
    ['a secret-named attribute from 8 characters', 'P-Secret'],
    ['a nested output of a typed attribute', 'P-Nested'],
    ["a nested stack's ApiKey physical id", 'P-NestedKey'],
    ['a re-export of an ApiKey joined into a longer value', 'R-Key'],
  ])('judges %s secret', async (_label, exportName) => {
    const { provider, r } = await resolver();
    const judged = await r.resolveImportJudged!(exportName);
    expect(judged.value).toBe(exportsList.find((e) => e.Name === exportName)!.Value);
    expect(judged.verdict).toBe('secret');
    expect(judged.detail).toBeUndefined();
    provider.dispose();
  });

  it.each([
    ['a plain (not NoEcho) parameter', 'P-PlainParam'],
    ['a secret-named attribute under 8 characters', 'P-ShortSecret'],
    ['a Fn::Sub variable shadowing a NoEcho parameter', 'P-SubShadow'],
  ])('does not judge %s secret', async (_label, exportName) => {
    const { provider, r } = await resolver();
    expect((await r.resolveImportJudged!(exportName)).verdict).toBeUndefined();
    provider.dispose();
  });

  it('applies the 16-character floor to a name-judged value read inside a longer one', async () => {
    stacks[REEXPORTER]!.outputs.push(
      { OutputKey: 'Long', OutputValue: 'k=wJalrXUtnFEMIK7MDENG', ExportName: 'R-Long' },
      { OutputKey: 'Short', OutputValue: 'k=pw-123456', ExportName: 'R-Short' }
    );
    stacks[PRODUCER]!.outputs.push({ OutputKey: 'Pw9', OutputValue: 'pw-123456', ExportName: 'P-Pw9' });
    const t = stacks[REEXPORTER]!.template as { Outputs: Record<string, unknown> };
    t.Outputs['Long'] = { Value: { 'Fn::Join': ['', ['k=', { 'Fn::ImportValue': 'P-Secret' }]] } };
    t.Outputs['Short'] = { Value: { 'Fn::Join': ['', ['k=', { 'Fn::ImportValue': 'P-Pw9' }]] } };
    const p = stacks[PRODUCER]!.template as { Outputs: Record<string, unknown> };
    p.Outputs['Pw9'] = { Value: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] } };
    exportsList.push(
      { Name: 'R-Long', Value: 'k=wJalrXUtnFEMIK7MDENG', ExportingStackId: REEXPORTER },
      { Name: 'R-Short', Value: 'k=pw-123456', ExportingStackId: REEXPORTER },
      { Name: 'P-Pw9', Value: 'pw-123456', ExportingStackId: PRODUCER }
    );
    const { provider, r } = await resolver();
    // 20 characters, inside a longer value: judged.
    expect((await r.resolveImportJudged!('R-Long')).verdict).toBe('secret');
    // 9 characters: judged whole...
    expect((await r.resolveImportJudged!('P-Pw9')).verdict).toBe('secret');
    // ...but not inside a longer value.
    expect((await r.resolveImportJudged!('R-Short')).verdict).toBeUndefined();
    provider.dispose();
  });

  it('applies the 4-character floor to a typed value read inside a longer one', async () => {
    stacks[PRODUCER]!.outputs.push({ OutputKey: 'Tiny', OutputValue: 'abc', ExportName: 'P-Tiny' });
    (stacks[PRODUCER]!.template as { Outputs: Record<string, unknown> }).Outputs['Tiny'] = {
      Value: { Ref: 'Pw' },
    };
    stacks[REEXPORTER]!.outputs.push({ OutputKey: 'T', OutputValue: 'xabcx', ExportName: 'R-Tiny' });
    (stacks[REEXPORTER]!.template as { Outputs: Record<string, unknown> }).Outputs['T'] = {
      Value: { 'Fn::Join': ['', ['x', { 'Fn::ImportValue': 'P-Tiny' }, 'x']] },
    };
    exportsList.push(
      { Name: 'P-Tiny', Value: 'abc', ExportingStackId: PRODUCER },
      { Name: 'R-Tiny', Value: 'xabcx', ExportingStackId: REEXPORTER }
    );
    const { provider, r } = await resolver();
    expect((await r.resolveImportJudged!('P-Tiny')).verdict).toBe('secret');
    expect((await r.resolveImportJudged!('R-Tiny')).verdict).toBeUndefined();
    provider.dispose();
  });

  it.each([
    ['ListStackResources', PRODUCER, 'P-Bucket', /ListStackResources of .*Producer\/p-1 failed/],
    ['DescribeStacks', PRODUCER, 'P-Bucket', /DescribeStacks of .*Producer\/p-1 failed/],
    ['GetTemplate', PRODUCER, 'P-Bucket', /GetTemplate of .*Producer\/p-1 failed/],
    ['ListStackResources', NESTED, 'P-Bucket', /ListStackResources of .*Producer-Nested\/n-1 failed/],
    ['GetTemplate', PRODUCER, 'R-Bucket', /GetTemplate of .*Producer\/p-1 failed/],
  ])(
    'fails closed when %s of a stack the check needs fails',
    async (operation, stackId, exportName, detail) => {
      failing.add(`${operation}Command:${stackId}`);
      const { provider, r } = await resolver();
      const judged = await r.resolveImportJudged!(exportName);
      expect(judged.value).toBe(exportsList.find((e) => e.Name === exportName)!.Value);
      expect(judged.verdict).toBe('unreadable');
      expect(judged.detail).toMatch(detail);
      // The failure's own text stays at debug: the detail names the stack only.
      expect(judged.detail).not.toContain('not authorized');
      provider.dispose();
    }
  );

  it('still judges a secret secret when another part of the tree is unreadable', async () => {
    failing.add(`ListStackResourcesCommand:${NESTED}`);
    const { provider, r } = await resolver();
    expect((await r.resolveImportJudged!('P-Key')).verdict).toBe('secret');
    provider.dispose();
  });

  it('fails closed on a template that is not JSON', async () => {
    stacks[PRODUCER]!.template = 'Outputs:\n  BucketOut:\n    Value: !Ref Bucket\n';
    const { provider, r } = await resolver();
    const judged = await r.resolveImportJudged!('P-Bucket');
    expect(judged).toMatchObject({ value: 'my-bucket', verdict: 'unreadable' });
    expect(judged.detail).toMatch(/GetTemplate of .* failed/);
    provider.dispose();
  });

  it('fails closed on a re-export whose export name is computed', async () => {
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('R-Computed')).toMatchObject({
      value: 'whatever',
      verdict: 'unreadable',
      detail: expect.stringMatching(/name is computed/),
    });
    provider.dispose();
  });

  it('fails closed on an export with no exporting stack named', async () => {
    delete exportsList.find((e) => e.Name === 'P-Bucket')!.ExportingStackId;
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Bucket')).toMatchObject({
      value: 'my-bucket',
      verdict: 'unreadable',
      detail: expect.stringMatching(/no exporting stack/),
    });
    provider.dispose();
  });

  it('calls a value the producer no longer declares stale', async () => {
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Stale')).toEqual({ value: 'old-value', verdict: 'stale' });
    provider.dispose();
  });

  it('fails closed on a re-export of an export its producer no longer declares', async () => {
    stacks[REEXPORTER]!.outputs.push({ OutputKey: 'S', OutputValue: 'old-value!', ExportName: 'R-Stale' });
    (stacks[REEXPORTER]!.template as { Outputs: Record<string, unknown> }).Outputs['S'] = {
      Value: { 'Fn::Join': ['', [{ 'Fn::ImportValue': 'P-Stale' }, '!']] },
    };
    exportsList.push({ Name: 'R-Stale', Value: 'old-value!', ExportingStackId: REEXPORTER });
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('R-Stale')).toMatchObject({
      verdict: 'unreadable',
      detail: expect.stringMatching(/re-exports P-Stale, which .*Producer\/p-1 no longer declares/),
    });
    provider.dispose();
  });

  it('fails closed on an exported Fn::GetAtt that is computed', async () => {
    (stacks[PRODUCER]!.template as { Outputs: Record<string, unknown> }).Outputs['BucketOut'] = {
      Value: { 'Fn::GetAtt': [{ Ref: 'Plain' }, 'Arn'] },
    };
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Bucket')).toMatchObject({
      verdict: 'unreadable',
      detail: 'an exported Fn::GetAtt is computed',
    });
    provider.dispose();
  });

  it('fails closed past the 32-level re-export bound, and judges a chain inside it', async () => {
    // E0 re-exports E1, ..., which re-exports E<n>, the bucket name.
    const chain = (n: number): void => {
      for (let i = 0; i <= n; i += 1) {
        const id = `arn:aws:cloudformation:us-east-1:123456789012:stack/Chain${i}/c`;
        stacks[id] = {
          resources: [],
          outputs: [{ OutputKey: 'O', OutputValue: 'my-bucket', ExportName: `E${i}` }],
          template: {
            Outputs: { O: { Value: i === n ? 'my-bucket' : { 'Fn::ImportValue': `E${i + 1}` } } },
          },
        };
        exportsList.push({ Name: `E${i}`, Value: 'my-bucket', ExportingStackId: id });
      }
    };
    chain(32);
    let { provider, r } = await resolver();
    expect((await r.resolveImportJudged!('E0')).verdict).toBeUndefined();
    provider.dispose();
    fixture();
    chain(33);
    ({ provider, r } = await resolver());
    expect(await r.resolveImportJudged!('E0')).toMatchObject({
      verdict: 'unreadable',
      detail: 'the re-exports go past the 32-level bound',
    });
    provider.dispose();
  });

  it('fails closed past the 32-level nested-stack bound', async () => {
    const id = (i: number): string => `arn:aws:cloudformation:us-east-1:123456789012:stack/N${i}/n`;
    for (let i = 1; i <= 33; i += 1) {
      stacks[id(i)] = {
        resources:
          i < 33
            ? [{ LogicalResourceId: 'Child', PhysicalResourceId: id(i + 1), ResourceType: 'AWS::CloudFormation::Stack' }]
            : [],
        outputs: [],
        template: {},
      };
    }
    stacks[NESTED]!.resources.push({
      LogicalResourceId: 'Deep',
      PhysicalResourceId: id(1),
      ResourceType: 'AWS::CloudFormation::Stack',
    });
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Bucket')).toMatchObject({
      verdict: 'unreadable',
      detail: 'the nested stacks go past the 32-level bound',
    });
    provider.dispose();
  });

  it('ends a nested-output trace that loops back on itself at the bound', async () => {
    // A nested stack listing ITSELF as its child: the tree walk stops at the
    // visited stack, so only the trace's own bound ends the output walk.
    const LOOP = 'arn:aws:cloudformation:us-east-1:123456789012:stack/Loop/l';
    stacks[LOOP] = {
      resources: [{ LogicalResourceId: 'Self', PhysicalResourceId: LOOP, ResourceType: 'AWS::CloudFormation::Stack' }],
      outputs: [{ OutputKey: 'O', OutputValue: 'v', ExportName: 'L-O' }],
      template: {
        Resources: { Self: { Type: 'AWS::CloudFormation::Stack' } },
        Outputs: { O: { Value: { 'Fn::GetAtt': ['Self', 'Outputs.O'] } } },
      },
    };
    exportsList.push({ Name: 'L-O', Value: 'v', ExportingStackId: LOOP });
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('L-O')).toMatchObject({
      verdict: 'unreadable',
      detail: 'the nested stacks go past the 32-level bound',
    });
    provider.dispose();
  });

  it.each([
    ['a Fn::Sub variable map value read from a NoEcho parameter', { 'Fn::Sub': ['pw=${X}', { X: { Ref: 'Pw' } }] }],
    ['a dotted ${Res.Attr} of a typed attribute in Fn::Sub', { 'Fn::Sub': 'k=${ApiKey.ApiKey}' }],
    ['a dotted ${Res.Attr} of a secret-named attribute in Fn::Sub', { 'Fn::Sub': 'k=${Key.SecretAccessKey}' }],
    ["a NoEcho flag spelled as the string 'true'", { Ref: 'PwString' }],
  ])('judges %s secret', async (_label, valueNode) => {
    const t = stacks[PRODUCER]!.template as {
      Outputs: Record<string, unknown>;
      Parameters: Record<string, unknown>;
    };
    t.Parameters['PwString'] = { Type: 'String', NoEcho: 'true' };
    t.Outputs['Extra'] = { Value: valueNode };
    stacks[PRODUCER]!.outputs.push({ OutputKey: 'Extra', OutputValue: 'k=not-a-real-secret-value', ExportName: 'P-Extra' });
    exportsList.push({ Name: 'P-Extra', Value: 'k=not-a-real-secret-value', ExportingStackId: PRODUCER });
    const { provider, r } = await resolver();
    expect((await r.resolveImportJudged!('P-Extra')).verdict).toBe('secret');
    provider.dispose();
  });

  it.each([
    ['DescribeStacks', /DescribeStacks of .*Producer-Nested\/n-1 failed/],
    ['GetTemplate', /GetTemplate of .*Producer-Nested\/n-1 failed/],
  ])('fails closed when %s of a traced nested stack fails', async (operation, detail) => {
    failing.add(`${operation}Command:${NESTED}`);
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Nested')).toMatchObject({
      verdict: 'unreadable',
      detail: expect.stringMatching(detail),
    });
    provider.dispose();
  });

  it('fails closed on a traced nested output the nested stack does not report', async () => {
    stacks[NESTED]!.outputs = stacks[NESTED]!.outputs.filter((o) => o.OutputKey !== 'Stream');
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Nested')).toMatchObject({
      verdict: 'unreadable',
      detail: expect.stringMatching(/Producer-Nested\/n-1 has no output Stream/),
    });
    provider.dispose();
  });

  it('fails closed on a traced nested stack the parent does not list', async () => {
    stacks[PRODUCER]!.resources = stacks[PRODUCER]!.resources.filter((r) => r.LogicalResourceId !== 'Nested');
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Nested')).toMatchObject({
      verdict: 'unreadable',
      detail: expect.stringMatching(/lists no nested stack Nested/),
    });
    provider.dispose();
  });

  it('fails closed on an export whose output the template does not declare', async () => {
    delete (stacks[PRODUCER]!.template as { Outputs: Record<string, unknown> }).Outputs['BucketOut'];
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Bucket')).toMatchObject({
      verdict: 'unreadable',
      detail: expect.stringMatching(/declares no output BucketOut/),
    });
    provider.dispose();
  });

  it('fails closed on a re-export of a name ListExports does not list', async () => {
    (stacks[REEXPORTER]!.template as { Outputs: Record<string, unknown> }).Outputs['JoinedBucket'] = {
      Value: { 'Fn::ImportValue': 'Missing' },
    };
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('R-Bucket')).toMatchObject({
      verdict: 'unreadable',
      detail: expect.stringMatching(/re-exports Missing, which ListExports does not list/),
    });
    provider.dispose();
  });

  it('fails closed when DescribeStacks returns no stack, naming why', async () => {
    const plain = sendMock.getMockImplementation()!;
    sendMock.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'DescribeStacksCommand' ? Promise.resolve({ Stacks: [] }) : plain(cmd)
    );
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Bucket')).toMatchObject({
      verdict: 'unreadable',
      detail: expect.stringMatching(/DescribeStacks of .*Producer\/p-1 failed: it returned no stack/),
    });
    provider.dispose();
  });

  it("names a modeled service exception's own message in the detail", async () => {
    const plain = sendMock.getMockImplementation()!;
    sendMock.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name !== 'GetTemplateCommand') return plain(cmd);
      const err = Object.assign(new Error('User is not authorized to perform: cloudformation:GetTemplate'), {
        name: 'AccessDenied',
        $fault: 'client',
        $metadata: { httpStatusCode: 403 },
      });
      return Promise.reject(err);
    });
    const { provider, r } = await resolver();
    expect((await r.resolveImportJudged!('P-Bucket')).detail).toMatch(
      /GetTemplate of .*Producer\/p-1 failed: AccessDenied: User is not authorized to perform: cloudformation:GetTemplate/
    );
    provider.dispose();
  });

  it('judges a producer tree of exactly 256 stacks', async () => {
    // The producer, its nested stack and 254 more.
    for (let i = 0; i < 254; i += 1) {
      const id = `arn:aws:cloudformation:us-east-1:123456789012:stack/E${i}/e`;
      stacks[id] = { resources: [], outputs: [], template: {} };
      stacks[NESTED]!.resources.push({ LogicalResourceId: `E${i}`, PhysicalResourceId: id, ResourceType: 'AWS::CloudFormation::Stack' });
    }
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Bucket')).toEqual({ value: 'my-bucket' });
    provider.dispose();
  });

  it('fails closed past 256 stacks in one producer tree', async () => {
    const wide = Array.from({ length: 300 }, (_, i) => {
      const id = `arn:aws:cloudformation:us-east-1:123456789012:stack/W${i}/w`;
      stacks[id] = { resources: [], outputs: [], template: {} };
      return { LogicalResourceId: `W${i}`, PhysicalResourceId: id, ResourceType: 'AWS::CloudFormation::Stack' };
    });
    stacks[NESTED]!.resources.push(...wide);
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-Bucket')).toMatchObject({
      verdict: 'unreadable',
      detail: 'the producer tree goes past 256 stacks',
    });
    expect(calls('ListStackResourcesCommand')).toBeLessThanOrEqual(256);
    provider.dispose();
  });

  it("judges a CDK nested-stack re-export by its trace, not its secret-looking name", async () => {
    // CDK's shape for a secret ARN passed out of a nested stack.
    const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:Db-AbCdEf';
    const pwd = 'nested-password-plaintext';
    stacks[NESTED]!.resources.push(
      { LogicalResourceId: 'DbSecret', PhysicalResourceId: secretArn, ResourceType: 'AWS::SecretsManager::Secret' },
      { LogicalResourceId: 'Key2', PhysicalResourceId: 'AKIA2', ResourceType: 'AWS::IAM::AccessKey' }
    );
    stacks[NESTED]!.outputs.push(
      { OutputKey: 'NestedDbSecret1A2B3C4DRef', OutputValue: secretArn },
      { OutputKey: 'NestedKeySecretAccessKey', OutputValue: pwd }
    );
    const nt = stacks[NESTED]!.template as { Outputs: Record<string, unknown>; Resources: Record<string, unknown> };
    nt.Resources['DbSecret'] = { Type: 'AWS::SecretsManager::Secret' };
    nt.Resources['Key2'] = { Type: 'AWS::IAM::AccessKey' };
    nt.Outputs['NestedDbSecret1A2B3C4DRef'] = { Value: { Ref: 'DbSecret' } };
    nt.Outputs['NestedKeySecretAccessKey'] = { Value: { 'Fn::GetAtt': ['Key2', 'SecretAccessKey'] } };
    const pt = stacks[PRODUCER]!.template as { Outputs: Record<string, unknown> };
    pt.Outputs['ArnOut'] = { Value: { 'Fn::GetAtt': ['Nested', 'Outputs.NestedDbSecret1A2B3C4DRef'] } };
    pt.Outputs['PwdOut'] = { Value: { 'Fn::GetAtt': ['Nested', 'Outputs.NestedKeySecretAccessKey'] } };
    stacks[PRODUCER]!.outputs.push(
      { OutputKey: 'ArnOut', OutputValue: secretArn, ExportName: 'P-SecretArn' },
      { OutputKey: 'PwdOut', OutputValue: pwd, ExportName: 'P-NestedPwd' }
    );
    exportsList.push(
      { Name: 'P-SecretArn', Value: secretArn, ExportingStackId: PRODUCER },
      { Name: 'P-NestedPwd', Value: pwd, ExportingStackId: PRODUCER }
    );
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('P-SecretArn')).toEqual({ value: secretArn });
    expect((await r.resolveImportJudged!('P-NestedPwd')).verdict).toBe('secret');
    provider.dispose();
  });

  it.each([['Custom::Thing'], ['AWS::CloudFormation::CustomResource']])(
    'judges an exported %s attribute secret, as the same-stack rule does',
    async (type) => {
      stacks[PRODUCER]!.resources.push({ LogicalResourceId: 'Cr', PhysicalResourceId: 'cr-1', ResourceType: type });
      const t = stacks[PRODUCER]!.template as { Outputs: Record<string, unknown>; Resources: Record<string, unknown> };
      t.Resources['Cr'] = { Type: type };
      t.Outputs['CrOut'] = { Value: { 'Fn::GetAtt': ['Cr', 'Url'] } };
      stacks[PRODUCER]!.outputs.push({ OutputKey: 'CrOut', OutputValue: 'https://x', ExportName: 'P-Cr' });
      exportsList.push({ Name: 'P-Cr', Value: 'https://x', ExportingStackId: PRODUCER });
      const { provider, r } = await resolver();
      expect((await r.resolveImportJudged!('P-Cr')).verdict).toBe('secret');
      provider.dispose();
    }
  );

  it('reads each stack part once per resolver, across exports', async () => {
    const { provider, r } = await resolver();
    await r.resolveImportJudged!('P-Bucket');
    await r.resolveImportJudged!('P-Key');
    await r.resolveImportJudged!('P-Bucket');
    expect(calls('ListExportsCommand')).toBe(1);
    expect(calls('GetTemplateCommand')).toBe(1);
    expect(calls('DescribeStacksCommand')).toBe(1);
    // The producer and its nested stack.
    expect(calls('ListStackResourcesCommand')).toBe(2);
    provider.dispose();
  });

  it('returns an unknown export value-less with no reads beyond ListExports', async () => {
    const { provider, r } = await resolver();
    expect(await r.resolveImportJudged!('Nope')).toEqual({ value: undefined });
    expect(sendMock.mock.calls).toHaveLength(1);
    expect(await r.resolveGetStackOutputJudged!('P', 'us-east-1', 'O')).toEqual({ value: undefined });
    provider.dispose();
  });

  it.each([
    ['ARN form', `arn:aws:appsync:us-east-1:1:apis/a/apikeys/${KEY}`, KEY],
    ['pipe form', `a|${KEY}`, KEY],
    ['an unknown form, secret whole', 'weird-id', 'weird-id'],
  ])('reads an ApiKey physical id segment (%s)', (_label, id, segment) => {
    expect(secretPhysicalIdSegment('AWS::AppSync::ApiKey', id)).toBe(segment);
    expect(secretPhysicalIdSegment('AWS::S3::Bucket', id)).toBeUndefined();
  });
});
