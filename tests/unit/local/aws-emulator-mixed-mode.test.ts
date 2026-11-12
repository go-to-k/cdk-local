import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  AWS_EMULATOR_SENTINEL,
  createMixedModeStateProvider,
  emulatedServicesOf,
  findAwsEmulatorSentinels,
  readAwsEmulatorSentinelsFromFile,
  resourceTypeMatchesEmulatedService,
  validateAwsEmulatorSentinels,
} from '../../../src/local/aws-emulator-mixed-mode.js';
import type { LocalStateProvider, LocalStateRecord } from '../../../src/local/local-state-provider.js';
import { getLogger } from '../../../src/utils/logger.js';

describe('findAwsEmulatorSentinels', () => {
  it('finds the sentinel on AWS_ENDPOINT_URL_<SERVICE> under Parameters and per-resource sections', () => {
    const found = findAwsEmulatorSentinels({
      Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator', OTHER: 'aws-emulator' },
      'MyStack/AgentHandler': {
        AWS_ENDPOINT_URL_S3: ' aws-emulator ',
        AWS_ENDPOINT_URL_SQS: 'https://127.0.0.1:9297',
      },
      MyFnLogicalId: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'aws-emulator', X: null },
    });
    expect(found).toEqual([
      { section: 'Parameters', key: 'AWS_ENDPOINT_URL_DYNAMODB', service: 'DYNAMODB' },
      { section: 'MyStack/AgentHandler', key: 'AWS_ENDPOINT_URL_S3', service: 'S3' },
      { section: 'MyFnLogicalId', key: 'AWS_ENDPOINT_URL_SECRETS_MANAGER', service: 'SECRETS_MANAGER' },
    ]);
    expect(emulatedServicesOf(found)).toEqual(['DYNAMODB', 'S3', 'SECRETS_MANAGER']);
  });

  it('ignores a literal URL, other spellings and lowercase keys', () => {
    expect(
      findAwsEmulatorSentinels({
        Parameters: {
          AWS_ENDPOINT_URL_DYNAMODB: 'https://127.0.0.1:9297',
          AWS_ENDPOINT_URL_SQS: 'AWS-EMULATOR',
          aws_endpoint_url_s3: 'aws-emulator',
        },
      })
    ).toEqual([]);
    expect(findAwsEmulatorSentinels(undefined)).toEqual([]);
  });

  it('reads a file, and yields none for a missing or invalid one (the command reports those)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sentinel-'));
    try {
      const f = path.join(dir, 'env.json');
      writeFileSync(f, JSON.stringify({ Parameters: { AWS_ENDPOINT_URL_SQS: AWS_EMULATOR_SENTINEL } }));
      expect(readAwsEmulatorSentinelsFromFile(f)).toHaveLength(1);
      writeFileSync(f, '{not json');
      expect(readAwsEmulatorSentinelsFromFile(f)).toEqual([]);
      expect(readAwsEmulatorSentinelsFromFile(path.join(dir, 'missing.json'))).toEqual([]);
      expect(readAwsEmulatorSentinelsFromFile(undefined)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validateAwsEmulatorSentinels', () => {
  const s = findAwsEmulatorSentinels({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } });

  it('passes with --aws-emulator, and with no sentinel at all', () => {
    expect(() => validateAwsEmulatorSentinels(s, true)).not.toThrow();
    expect(() => validateAwsEmulatorSentinels([], false)).not.toThrow();
  });

  it('without --aws-emulator, names the flag and the env var', () => {
    expect(() => validateAwsEmulatorSentinels(s, false, 'CDKD_AWS_EMULATOR')).toThrow(
      /AWS_ENDPOINT_URL_DYNAMODB under "?Parameters"?.*needs --aws-emulator \[url\] \(or CDKD_AWS_EMULATOR\)/
    );
  });

  it('refuses the sentinel on the bare AWS_ENDPOINT_URL (that is plain --aws-emulator)', () => {
    const bare = findAwsEmulatorSentinels({ Fn: { AWS_ENDPOINT_URL: 'aws-emulator' } });
    expect(() => validateAwsEmulatorSentinels(bare, true)).toThrow(/routes ONE service/);
  });
});

describe('resourceTypeMatchesEmulatedService', () => {
  it.each([
    ['AWS::DynamoDB::Table', ['DYNAMODB'], true],
    ['AWS::DynamoDB::GlobalTable', ['DYNAMODB'], true],
    ['AWS::S3::Bucket', ['S3'], true],
    ['AWS::SQS::Queue', ['DYNAMODB', 'SQS'], true],
    ['AWS::SecretsManager::Secret', ['SECRETS_MANAGER'], true],
    ['AWS::Events::EventBus', ['EVENTBRIDGE'], true],
    ['AWS::StepFunctions::StateMachine', ['SFN'], true],
    ['AWS::Logs::LogGroup', ['CLOUDWATCH_LOGS'], true],
    ['AWS::ApiGateway::RestApi', ['API_GATEWAY'], true],
    ['AWS::Lambda::Function', ['DYNAMODB'], false],
    ['AWS::S3::Bucket', ['S3_CONTROL'], false],
    ['Custom::Thing', ['S3'], false],
  ])('%s with %j -> %s', (type, services, expected) => {
    expect(resourceTypeMatchesEmulatedService(type, services)).toBe(expected);
  });
});

function fakeProvider(record: LocalStateRecord | undefined, extra: Partial<LocalStateProvider> = {}) {
  return {
    label: '--from-cfn-stack',
    load: vi.fn(async () => record),
    buildCrossStackResolver: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...extra,
  } satisfies LocalStateProvider;
}

const res = (resourceType: string, physicalId: string) => ({ resourceType, physicalId, properties: {} });

describe('createMixedModeStateProvider', () => {
  const realRecord: LocalStateRecord = {
    resources: {
      Table: res('AWS::DynamoDB::Table', 'real-table'),
      Bucket: res('AWS::S3::Bucket', 'real-bucket'),
      Fn: res('AWS::Lambda::Function', 'real-fn'),
    },
    outputs: { TableName: 'real-table', BucketName: 'real-bucket' },
    region: 'us-east-1',
  };
  const emuRecord: LocalStateRecord = {
    resources: {
      Table: res('AWS::DynamoDB::Table', 'emu-table'),
      Bucket: res('AWS::S3::Bucket', 'emu-bucket'),
      Fn: res('AWS::Lambda::Function', 'emu-fn'),
    },
    outputs: { TableName: 'emu-table', EmuOnly: 'x' },
    region: 'us-east-1',
  };

  it('takes emulated services from the emulator and the rest from real AWS', async () => {
    const p = createMixedModeStateProvider({
      real: fakeProvider(realRecord),
      emulator: fakeProvider(emuRecord),
      emulatedServices: ['DYNAMODB'],
    });
    const r = (await p.load('S', 'us-east-1'))!;
    expect(r.resources['Table']!.physicalId).toBe('emu-table');
    expect(r.resources['Bucket']!.physicalId).toBe('real-bucket');
    expect(r.resources['Fn']!.physicalId).toBe('real-fn');
    // An output naming an emulated resource's real ID follows the swap.
    expect(r.outputs).toEqual({ TableName: 'emu-table', BucketName: 'real-bucket', EmuOnly: 'x' });
  });

  it('swaps the deployed-function env values that name an emulated resource, and delegates the rest to real', async () => {
    const real = fakeProvider(realRecord, {
      resolveDeployedFunctionEnv: vi.fn(async () => ({ TABLE: 'real-table', BUCKET: 'real-bucket' })),
      resolveLambdaExecutionRoleArn: vi.fn(async () => 'arn:role'),
      getLastLoadError: () => 'real-err',
    });
    const emulator = fakeProvider(emuRecord);
    const p = createMixedModeStateProvider({ real, emulator, emulatedServices: ['DYNAMODB'] });
    await p.load('S', undefined);
    expect(await p.resolveDeployedFunctionEnv!('real-fn')).toEqual({
      TABLE: 'emu-table',
      BUCKET: 'real-bucket',
    });
    expect(await p.resolveLambdaExecutionRoleArn!('real-fn')).toBe('arn:role');
    expect(p.getLastLoadError!()).toBe('real-err');
    expect(p.resolveTemplateSsmParameters).toBeUndefined();
    await p.buildCrossStackResolver('us-east-1');
    expect(real.buildCrossStackResolver).toHaveBeenCalled();
    expect(emulator.buildCrossStackResolver).not.toHaveBeenCalled();
    p.dispose();
    expect(real.dispose).toHaveBeenCalled();
    expect(emulator.dispose).toHaveBeenCalled();
  });

  it('keeps real names with one warning when the emulator has no such stack', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      const p = createMixedModeStateProvider({
        real: fakeProvider(realRecord),
        emulator: fakeProvider(undefined, { getLastLoadError: () => 'Stack S does not exist' }),
        emulatedServices: ['DYNAMODB'],
      });
      expect((await p.load('S', undefined))!.resources['Table']!.physicalId).toBe('real-table');
      await p.load('S', undefined);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(
        /could not be read from AWS Emulator \(Stack S does not exist\).*\(DYNAMODB\) keep their real AWS names/
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('with only the emulator copy, returns just the emulated resources', async () => {
    const p = createMixedModeStateProvider({
      real: fakeProvider(undefined),
      emulator: fakeProvider(emuRecord),
      emulatedServices: ['S3'],
    });
    const r = (await p.load('S', undefined))!;
    expect(Object.keys(r.resources)).toEqual(['Bucket']);
  });
});

describe('CfnLocalStateProvider endpointOverride (the emulator side of mixed mode)', () => {
  it('builds its clients against the override endpoint with its keys, ignoring the profile', async () => {
    const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');
    const p = new CfnLocalStateProvider({
      cfnStackName: 'S',
      region: 'us-east-1',
      profile: 'real-profile',
      endpointOverride: {
        endpoint: 'https://127.0.0.1:9361',
        credentials: { accessKeyId: 'EMUKEY', secretAccessKey: 'emusecret' },
      },
    });
    const client = (p as unknown as { getClient(): { config: Record<string, unknown> } }).getClient();
    const ep = await (client.config['endpoint'] as () => Promise<{ hostname: string; port: number }>)();
    expect(ep).toMatchObject({ hostname: '127.0.0.1', port: 9361 });
    const creds = await (client.config['credentials'] as () => Promise<{ accessKeyId: string }>)();
    expect(creds.accessKeyId).toBe('EMUKEY');
    expect(client.config['profile']).toBeUndefined();
    p.dispose();
  });
});
