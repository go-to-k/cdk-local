import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  AWS_EMULATOR_SENTINEL,
  createMixedModeStateProvider,
  emulatedServicesForWorkload,
  emulatedServicesOf,
  findAwsEmulatorSentinels,
  readAwsEmulatorEnvVarsFile,
  readAwsEmulatorSentinelsFromFile,
  resourceTypeMatchesEmulatedService,
  validateAwsEmulatorSentinels,
} from '../../../src/local/aws-emulator-mixed-mode.js';
import type { LocalStateProvider, LocalStateRecord } from '../../../src/local/local-state-provider.js';
import {
  readEnvVarsFileText,
  resetEnvVarsFileTextsForTest,
} from '../../../src/local/env-resolver.js';
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

  // go-to-k/cdk-local#902: the SDKs never read a misspelled variable, so the
  // workload's calls would go to real AWS while names resolved from the emulator.
  it('refuses a sentinel on a variable the AWS SDKs do not read, naming the SDK spelling', () => {
    const typo = findAwsEmulatorSentinels({
      Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' },
      Fn: { AWS_ENDPOINT_URL_SECRETSMANAGER: 'aws-emulator' },
    });
    expect(() => validateAwsEmulatorSentinels(typo, true)).toThrow(
      /AWS_ENDPOINT_URL_SECRETSMANAGER under "?Fn"?.*the AWS SDKs do not read AWS_ENDPOINT_URL_SECRETSMANAGER.*Use AWS_ENDPOINT_URL_SECRETS_MANAGER\./
    );
    // Refused before the missing-flag error, which would not name the real problem.
    expect(() => validateAwsEmulatorSentinels(typo, false)).toThrow(/Use AWS_ENDPOINT_URL_SECRETS_MANAGER/);
    for (const [bad, good] of [
      ['STEPFUNCTIONS', undefined],
      ['CLOUDWATCHLOGS', 'CLOUDWATCH_LOGS'],
      ['EVENT_BRIDGE', 'EVENTBRIDGE'],
      ['NOT_A_SERVICE', undefined],
    ] as const) {
      const one = findAwsEmulatorSentinels({ Parameters: { [`AWS_ENDPOINT_URL_${bad}`]: 'aws-emulator' } });
      expect(() => validateAwsEmulatorSentinels(one, true)).toThrow(
        good ? new RegExp(`Use AWS_ENDPOINT_URL_${good}\\.`) : /must be the service's SDK endpoint id/
      );
    }
  });

  it('accepts the SDK spellings of the services mixed mode is used with', () => {
    for (const id of ['DYNAMODB', 'S3', 'SQS', 'SNS', 'SSM', 'SECRETS_MANAGER', 'SFN', 'EVENTBRIDGE', 'KINESIS', 'CLOUDWATCH_LOGS', 'BEDROCK_RUNTIME']) {
      const one = findAwsEmulatorSentinels({ Parameters: { [`AWS_ENDPOINT_URL_${id}`]: 'aws-emulator' } });
      expect(() => validateAwsEmulatorSentinels(one, true), id).not.toThrow();
    }
  });
});

describe('emulatedServicesForWorkload', () => {
  const file = {
    Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator', AWS_ENDPOINT_URL_S3: 'aws-emulator' },
    'MyStack/FnA': { AWS_ENDPOINT_URL_SSM: 'aws-emulator' },
    FnA1234: { AWS_ENDPOINT_URL_S3: null },
    FnB5678: { AWS_ENDPOINT_URL_DYNAMODB: 'https://127.0.0.1:4566' },
    web: { AWS_ENDPOINT_URL_SQS: ' aws-emulator ' },
  };

  it("is Parameters plus the workload's own sections, cleared by null or a literal, in file order", () => {
    expect(
      emulatedServicesForWorkload(file, { logicalId: 'FnA1234', cdkPath: 'MyStack/FnA/Resource' })
    ).toEqual(['DYNAMODB', 'SSM']);
    expect(emulatedServicesForWorkload(file, { logicalId: 'FnB5678' })).toEqual(['S3']);
    expect(emulatedServicesForWorkload(file, { containerName: 'web' })).toEqual(['DYNAMODB', 'S3', 'SQS']);
    expect(emulatedServicesForWorkload(file, { logicalId: 'Other' })).toEqual(['DYNAMODB', 'S3']);
    // A path section matches only at a `/` boundary.
    expect(emulatedServicesForWorkload(file, { cdkPath: 'MyStack/FnAx/Resource' })).toEqual(['DYNAMODB', 'S3']);
    expect(emulatedServicesForWorkload(undefined, { logicalId: 'FnA1234' })).toEqual([]);
  });

  it('a value the env merge skips (object, array) leaves a Parameters sentinel in place', () => {
    expect(
      emulatedServicesForWorkload(
        {
          Parameters: { AWS_ENDPOINT_URL_SSM: 'aws-emulator', AWS_ENDPOINT_URL_S3: 'aws-emulator' },
          FnA1234: { AWS_ENDPOINT_URL_SSM: { x: 1 }, AWS_ENDPOINT_URL_S3: 42 },
        },
        { logicalId: 'FnA1234' }
      )
    ).toEqual(['SSM']);
  });

  it('a later section re-adds what an earlier one cleared', () => {
    expect(
      emulatedServicesForWorkload(
        {
          FnA1234: { AWS_ENDPOINT_URL_SSM: null },
          'MyStack/FnA': { AWS_ENDPOINT_URL_SSM: 'aws-emulator' },
        },
        { logicalId: 'FnA1234', cdkPath: 'MyStack/FnA/Resource' }
      )
    ).toEqual(['SSM']);
  });
});

// go-to-k/cdk-local#894: the scan must not consume a pipe-backed --env-vars
// before the command's own reader runs.
describe('pipe-backed --env-vars (FIFO)', () => {
  it('the sentinel scan and the command read see the same text, read once', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fifo-'));
    let empty: ReturnType<typeof spawn> | undefined;
    try {
      const fifo = path.join(dir, 'env.fifo');
      execFileSync('mkfifo', [fifo]);
      const body = JSON.stringify({ Parameters: { AWS_ENDPOINT_URL_SQS: AWS_EMULATOR_SENTINEL } });
      // One writer: a second read of the FIFO itself would block forever.
      const writer = spawn('sh', ['-c', 'printf "%s" "$1" > "$2"', 'sh', body, fifo]);
      const done = new Promise((r) => writer.on('exit', r));
      expect(readAwsEmulatorSentinelsFromFile(fifo)).toHaveLength(1);
      await done;
      // An empty second writer: a regression's second open reads "" and fails
      // instead of blocking the worker forever. Killed unused when kept.
      empty = spawn('sh', ['-c', ': > "$1"', 'sh', fifo]);
      expect(readEnvVarsFileText(fifo)).toBe(body);
      expect(readAwsEmulatorEnvVarsFile(fifo).overrides).toEqual(JSON.parse(body));
    } finally {
      // Reap it: the suite refuses a test file that leaves a child running.
      if (empty && empty.exitCode === null && empty.signalCode === null) {
        const exited = new Promise((r) => empty!.once('exit', r));
        empty.kill();
        await exited;
      }
      resetEnvVarsFileTextsForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a descriptor path naming a regular file (/dev/stdin < env.json) is read once and kept (#894)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stdin-'));
    try {
      const f = path.join(dir, 'env.json');
      const body = JSON.stringify({ Parameters: { AWS_ENDPOINT_URL_SQS: AWS_EMULATOR_SENTINEL } });
      writeFileSync(f, body);
      // `/dev/stdin < env.json` is a descriptor path naming a regular file;
      // `/dev/fd/<fd>` of an open file is the same case in-process. On macOS a
      // reopen shares the offset, so an unkept second read would be empty.
      const fd = openSync(f, 'r');
      try {
        const p = `/dev/fd/${fd}`;
        expect([readEnvVarsFileText(p), readEnvVarsFileText(p)]).toEqual([body, body]);
      } finally {
        closeSync(fd);
        resetEnvVarsFileTextsForTest();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a regular file is read afresh each time (a --watch re-read sees an edit)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'envfile-'));
    try {
      const f = path.join(dir, 'env.json');
      writeFileSync(f, '{"a":{}}');
      expect(readEnvVarsFileText(f)).toBe('{"a":{}}');
      writeFileSync(f, '{"b":{}}');
      expect(readEnvVarsFileText(f)).toBe('{"b":{}}');
      expect(() => readEnvVarsFileText(path.join(dir, 'missing.json'))).toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      resolveDeployedFunctionEnv: vi.fn(async () => ({
        TABLE: 'real-table',
        BUCKET: 'real-bucket',
        TABLE_ARN: 'arn:aws:dynamodb:us-east-1:111111111111:table/real-table',
      })),
      resolveLambdaExecutionRoleArn: vi.fn(async () => 'arn:role'),
      getLastLoadError: () => 'real-err',
    });
    const emulator = fakeProvider(emuRecord);
    const p = createMixedModeStateProvider({ real, emulator, emulatedServices: ['DYNAMODB'] });
    await p.load('S', undefined);
    expect(await p.resolveDeployedFunctionEnv!('real-fn')).toEqual({
      TABLE: 'emu-table',
      BUCKET: 'real-bucket',
      // Only exact physical IDs are swapped; an ARN keeps naming the real table (documented).
      TABLE_ARN: 'arn:aws:dynamodb:us-east-1:111111111111:table/real-table',
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
