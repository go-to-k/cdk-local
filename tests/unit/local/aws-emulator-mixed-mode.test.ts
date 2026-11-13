import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  REAL_AWS_SENTINEL,
  createMixedModeStateProvider,
  describeRealAwsExceptions,
  findLegacyAwsEmulatorSentinels,
  findRealAwsExceptions,
  readAwsEmulatorEnvVarsFile,
  realAwsEndpointFor,
  realAwsServicesForWorkload,
  realAwsServicesOf,
  resourceTypeMatchesService,
  validateAwsEmulatorEnvVars,
} from '../../../src/local/aws-emulator-mixed-mode.js';
import type { LocalStateProvider, LocalStateRecord } from '../../../src/local/local-state-provider.js';
import {
  readEnvVarsFileText,
  resetEnvVarsFileTextsForTest,
} from '../../../src/local/env-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';
import { normalizeAwsEndpointServiceId } from '../../../src/utils/aws-proxy.js';

const scanOf = (file: Record<string, unknown>) => ({
  exceptions: findRealAwsExceptions(file),
  legacySentinels: findLegacyAwsEmulatorSentinels(file),
});

describe('findRealAwsExceptions', () => {
  it('finds "real-aws" on AWS_ENDPOINT_URL_<SERVICE> under Parameters and per-resource sections', () => {
    const found = findRealAwsExceptions({
      Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws', OTHER: 'real-aws' },
      'MyStack/AgentHandler': {
        AWS_ENDPOINT_URL_STS: ' real-aws ',
        AWS_ENDPOINT_URL_SQS: 'https://127.0.0.1:9297',
      },
      MyFnLogicalId: { AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER: 'real-aws', X: null },
    });
    expect(found).toEqual([
      { section: 'Parameters', key: 'AWS_ENDPOINT_URL_SECRETS_MANAGER', service: 'SECRETS_MANAGER' },
      { section: 'MyStack/AgentHandler', key: 'AWS_ENDPOINT_URL_STS', service: 'STS' },
      {
        section: 'MyFnLogicalId',
        key: 'AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER',
        service: 'COGNITO_IDENTITY_PROVIDER',
      },
    ]);
    expect(realAwsServicesOf(found)).toEqual(['COGNITO_IDENTITY_PROVIDER', 'SECRETS_MANAGER', 'STS']);
  });

  it('ignores a literal URL, other spellings and lowercase keys; the old sentinel is found separately', () => {
    const file = {
      Parameters: {
        AWS_ENDPOINT_URL_DYNAMODB: 'https://127.0.0.1:9297',
        AWS_ENDPOINT_URL_SQS: 'REAL-AWS',
        aws_endpoint_url_s3: 'real-aws',
        AWS_ENDPOINT_URL_SNS: 'aws-emulator',
      },
    };
    expect(findRealAwsExceptions(file)).toEqual([]);
    expect(findLegacyAwsEmulatorSentinels(file)).toEqual([
      { section: 'Parameters', key: 'AWS_ENDPOINT_URL_SNS', service: 'SNS' },
    ]);
    expect(findRealAwsExceptions(undefined)).toEqual([]);
  });

  it('reads a file, and yields none for a missing or invalid one (the command reports those)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sentinel-'));
    try {
      const f = path.join(dir, 'env.json');
      writeFileSync(
        f,
        JSON.stringify({
          Parameters: { AWS_ENDPOINT_URL_STS: REAL_AWS_SENTINEL, AWS_ENDPOINT_URL_SQS: 'aws-emulator' },
        })
      );
      const scan = readAwsEmulatorEnvVarsFile(f);
      expect(scan.exceptions).toHaveLength(1);
      expect(scan.legacySentinels).toHaveLength(1);
      writeFileSync(f, '{not json');
      expect(readAwsEmulatorEnvVarsFile(f)).toEqual({
        overrides: undefined,
        exceptions: [],
        legacySentinels: [],
      });
      expect(readAwsEmulatorEnvVarsFile(path.join(dir, 'missing.json')).exceptions).toEqual([]);
      expect(readAwsEmulatorEnvVarsFile(undefined).exceptions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validateAwsEmulatorEnvVars', () => {
  const one = scanOf({ Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } });

  it('passes with --aws-emulator, and with no exception at all', () => {
    expect(() => validateAwsEmulatorEnvVars(one, true)).not.toThrow();
    expect(() => validateAwsEmulatorEnvVars(scanOf({}), true)).not.toThrow();
    expect(() => validateAwsEmulatorEnvVars(scanOf({}), false)).not.toThrow();
  });

  // go-to-k/cdk-local#914: the deploy-artifact exceptions use the ECR / S3 /
  // Lambda clients' own endpoint ids; a guess from the API host is refused.
  it('accepts the ECR, S3 and LAMBDA exceptions the artifact reads route by, and refuses ECR_API', async () => {
    const ok = scanOf({
      Parameters: {
        AWS_ENDPOINT_URL_ECR: 'real-aws',
        AWS_ENDPOINT_URL_S3: 'real-aws',
        AWS_ENDPOINT_URL_LAMBDA: 'real-aws',
      },
    });
    expect(() => validateAwsEmulatorEnvVars(ok, true)).not.toThrow();
    for (const key of ['AWS_ENDPOINT_URL_ECR_API', 'AWS_ENDPOINT_URL_ECRAPI']) {
      expect(() => validateAwsEmulatorEnvVars(scanOf({ web: { [key]: 'real-aws' } }), true)).toThrow(
        `but the AWS SDKs do not read ${key}`
      );
    }
    const { ECRClient } = await import('@aws-sdk/client-ecr');
    const ecr = new ECRClient({ region: 'us-east-1' });
    expect(normalizeAwsEndpointServiceId(ecr.config.serviceId!)).toBe('ECR');
    ecr.destroy();
  });

  it('without --aws-emulator every "real-aws" is accepted (a no-op): one file serves both runs', () => {
    const file = {
      Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws', AWS_ENDPOINT_URL: 'real-aws' },
      Fn: { AWS_ENDPOINT_URL_SECRETSMANAGER: 'real-aws' },
    };
    expect(() => validateAwsEmulatorEnvVars(scanOf(file), false)).not.toThrow();
  });

  it('refuses the old "aws-emulator" sentinel in both modes, with the migration', () => {
    const old = scanOf({ Fn: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } });
    for (const on of [true, false]) {
      expect(() => validateAwsEmulatorEnvVars(old, on)).toThrow(
        /AWS_ENDPOINT_URL_DYNAMODB under "?Fn"? to "aws-emulator", which is no longer supported: --aws-emulator now sends EVERY service to AWS Emulator.*"AWS_ENDPOINT_URL_SECRETS_MANAGER": "real-aws"/
      );
    }
  });

  it('refuses "real-aws" on the bare AWS_ENDPOINT_URL under --aws-emulator, naming the remedy', () => {
    const bare = scanOf({ Fn: { AWS_ENDPOINT_URL: 'real-aws' } });
    expect(() => validateAwsEmulatorEnvVars(bare, true)).toThrow(
      '--env-vars: "AWS_ENDPOINT_URL": "real-aws" would send every AWS call to real AWS, which is what ' +
        'running without --aws-emulator does. Remove --aws-emulator to run against real AWS, or keep it and ' +
        'mark only the services that must reach real AWS, e.g. "AWS_ENDPOINT_URL_SECRETS_MANAGER": "real-aws".'
    );
  });

  // A misspelled variable is never read by the SDKs, so the service would
  // silently stay on the emulator (fails closed, but not what was asked).
  it('refuses an exception on a variable the AWS SDKs do not read, naming the SDK spelling', () => {
    const typo = scanOf({
      Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' },
      Fn: { AWS_ENDPOINT_URL_SECRETSMANAGER: 'real-aws' },
    });
    expect(() => validateAwsEmulatorEnvVars(typo, true)).toThrow(
      /AWS_ENDPOINT_URL_SECRETSMANAGER under "?Fn"?.*the AWS SDKs do not read AWS_ENDPOINT_URL_SECRETSMANAGER, so the workload's calls would still go to AWS Emulator\. Use AWS_ENDPOINT_URL_SECRETS_MANAGER\./
    );
    for (const [bad, good] of [
      ['STEPFUNCTIONS', undefined],
      ['CLOUDWATCHLOGS', 'CLOUDWATCH_LOGS'],
      ['EVENT_BRIDGE', 'EVENTBRIDGE'],
      ['NOT_A_SERVICE', undefined],
    ] as const) {
      const s = scanOf({ Parameters: { [`AWS_ENDPOINT_URL_${bad}`]: 'real-aws' } });
      expect(() => validateAwsEmulatorEnvVars(s, true)).toThrow(
        good ? new RegExp(`Use AWS_ENDPOINT_URL_${good}\\.`) : /must be the service's SDK endpoint id/
      );
    }
  });

  // go-to-k/cdk-local#949: a case variant reached the container as a literal endpoint.
  it('refuses a case variant of a sentinel in both modes, naming the exact spelling', () => {
    for (const on of [true, false]) {
      for (const v of ['REAL-AWS', 'Real-AWS', ' real-AWS ']) {
        const s = { ...scanOf({ Fn: { AWS_ENDPOINT_URL_DYNAMODB: v } }), overrides: { Fn: { AWS_ENDPOINT_URL_DYNAMODB: v } } };
        expect(() => validateAwsEmulatorEnvVars(s, on), v).toThrow(
          `to "${v.trim()}", which is not the exception value "real-aws": it is matched exactly, in lowercase, ` +
            `so the SDKs would read "${v.trim()}" as the endpoint URL. Write "real-aws".`
        );
      }
      const legacy = { Fn: { AWS_ENDPOINT_URL_DYNAMODB: 'AWS-Emulator' } };
      expect(() => validateAwsEmulatorEnvVars({ ...scanOf(legacy), overrides: legacy }, on)).toThrow(
        /no longer supported/
      );
    }
    // The scan readAwsEmulatorEnvVarsFile returns carries the file, so activation refuses it too.
    const dir = mkdtempSync(path.join(tmpdir(), 'cdkl-949-'));
    try {
      const f = path.join(dir, 'a.json');
      writeFileSync(f, JSON.stringify({ 'Stack/NodeFn': { AWS_ENDPOINT_URL_DYNAMODB: 'REAL-AWS' } }));
      expect(() => validateAwsEmulatorEnvVars(readAwsEmulatorEnvVarsFile(f), true)).toThrow(/Write "real-aws"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('under --aws-emulator refuses any other endpoint value that is not an http(s) URL, without quoting it', () => {
    const file = { Parameters: { AWS_ENDPOINT_URL_SQS: 'localhost:4566' } };
    expect(() => validateAwsEmulatorEnvVars({ ...scanOf(file), overrides: file }, true)).toThrow(
      /AWS_ENDPOINT_URL_SQS under "?Parameters"? to a value that is neither "real-aws" nor an http\(s\) URL/
    );
    expect(() => validateAwsEmulatorEnvVars({ ...scanOf(file), overrides: file }, true)).not.toThrow(/localhost/);
    // Without --aws-emulator a literal value is the user's own endpoint, as before.
    expect(() => validateAwsEmulatorEnvVars({ ...scanOf(file), overrides: file }, false)).not.toThrow();
    for (const bad of ['  ', 'http://', 'https:///x', 'http:localhost', ' https://127.0.0.1:1', 'https://h/ x']) {
      const f = { Parameters: { AWS_ENDPOINT_URL_SQS: bad } };
      expect(() => validateAwsEmulatorEnvVars({ ...scanOf(f), overrides: f }, true), bad).toThrow(
        /nor an http\(s\) URL/
      );
    }
    const fine = {
      Parameters: { AWS_ENDPOINT_URL_SQS: 'http://127.0.0.1:4566', AWS_ENDPOINT_URL_S3: ' real-aws' },
      Fn: { AWS_ENDPOINT_URL_KMS: '', AWS_ENDPOINT_URL_SSM: null, OTHER: 'REAL-AWS' },
    };
    expect(() => validateAwsEmulatorEnvVars({ ...scanOf(fine), overrides: fine }, true)).not.toThrow();
  });

  it('accepts the SDK spellings of the services commonly excepted', () => {
    for (const id of ['SECRETS_MANAGER', 'STS', 'SSM', 'COGNITO_IDENTITY_PROVIDER', 'BEDROCK_RUNTIME', 'S3', 'KMS']) {
      const s = scanOf({ Parameters: { [`AWS_ENDPOINT_URL_${id}`]: 'real-aws' } });
      expect(() => validateAwsEmulatorEnvVars(s, true), id).not.toThrow();
    }
  });
});

describe('describeRealAwsExceptions (#949)', () => {
  it('names each service with the sections that mark it', () => {
    const ex = findRealAwsExceptions({
      Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
      'Stack/PyFn': { AWS_ENDPOINT_URL_S3: 'real-aws', AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
      Other: { AWS_ENDPOINT_URL_S3: 'real-aws' },
    });
    // A section repeated for one service, and the bare variable, add nothing.
    ex.push({ section: 'Other', key: 'AWS_ENDPOINT_URL_S3', service: 'S3' });
    ex.push({ section: 'Fn', key: 'AWS_ENDPOINT_URL', service: '' });
    expect(describeRealAwsExceptions(ex)).toBe(
      'DYNAMODB under Parameters (every workload), Stack/PyFn; S3 under Stack/PyFn, Other'
    );
  });
});

describe('realAwsServicesForWorkload', () => {
  const file = {
    Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws', AWS_ENDPOINT_URL_S3: 'real-aws' },
    'MyStack/FnA': { AWS_ENDPOINT_URL_SSM: 'real-aws' },
    FnA1234: { AWS_ENDPOINT_URL_S3: null },
    FnB5678: { AWS_ENDPOINT_URL_STS: 'https://sts.example.test' },
    web: { AWS_ENDPOINT_URL_SECRETS_MANAGER: ' real-aws ' },
  };

  it("is Parameters plus the workload's own sections, cleared by null or a literal, in file order", () => {
    expect(
      realAwsServicesForWorkload(file, { logicalId: 'FnA1234', cdkPath: 'MyStack/FnA/Resource' })
    ).toEqual(['SSM', 'STS']);
    expect(realAwsServicesForWorkload(file, { logicalId: 'FnB5678' })).toEqual(['S3']);
    expect(realAwsServicesForWorkload(file, { containerName: 'web' })).toEqual([
      'S3',
      'SECRETS_MANAGER',
      'STS',
    ]);
    expect(realAwsServicesForWorkload(file, { logicalId: 'Other' })).toEqual(['S3', 'STS']);
    // The empty workload: Parameters alone.
    expect(realAwsServicesForWorkload(file, {})).toEqual(['S3', 'STS']);
    // A path section matches only at a `/` boundary.
    expect(realAwsServicesForWorkload(file, { cdkPath: 'MyStack/FnAx/Resource' })).toEqual(['S3', 'STS']);
    expect(realAwsServicesForWorkload(undefined, { logicalId: 'FnA1234' })).toEqual([]);
  });

  it('a value the env merge skips (object, array) leaves a Parameters exception in place', () => {
    expect(
      realAwsServicesForWorkload(
        {
          Parameters: { AWS_ENDPOINT_URL_SSM: 'real-aws', AWS_ENDPOINT_URL_S3: 'real-aws' },
          FnA1234: { AWS_ENDPOINT_URL_SSM: { x: 1 }, AWS_ENDPOINT_URL_S3: 42 },
        },
        { logicalId: 'FnA1234' }
      )
    ).toEqual(['SSM']);
  });

  it('a later section re-adds what an earlier one cleared', () => {
    expect(
      realAwsServicesForWorkload(
        {
          FnA1234: { AWS_ENDPOINT_URL_SSM: null },
          'MyStack/FnA': { AWS_ENDPOINT_URL_SSM: 'real-aws' },
        },
        { logicalId: 'FnA1234', cdkPath: 'MyStack/FnA/Resource' }
      )
    ).toEqual(['SSM']);
  });
});

describe('realAwsEndpointFor', () => {
  it('names the regional endpoint by endpoint prefix, not by service id', () => {
    expect(realAwsEndpointFor('SECRETS_MANAGER', 'us-east-1')).toBe(
      'https://secretsmanager.us-east-1.amazonaws.com'
    );
    expect(realAwsEndpointFor('STS', 'ap-northeast-1')).toBe('https://sts.ap-northeast-1.amazonaws.com');
    expect(realAwsEndpointFor('S3', 'eu-west-1')).toBe('https://s3.eu-west-1.amazonaws.com');
    expect(realAwsEndpointFor('S3', 'us-east-1')).toBe('https://s3.us-east-1.amazonaws.com');
    expect(realAwsEndpointFor('SFN', 'us-west-2')).toBe('https://states.us-west-2.amazonaws.com');
    expect(realAwsEndpointFor('CLOUDWATCH_LOGS', 'us-west-2')).toBe('https://logs.us-west-2.amazonaws.com');
    expect(realAwsEndpointFor('COGNITO_IDENTITY_PROVIDER', 'eu-central-1')).toBe(
      'https://cognito-idp.eu-central-1.amazonaws.com'
    );
    expect(realAwsEndpointFor('ECR', 'us-east-1')).toBe('https://api.ecr.us-east-1.amazonaws.com');
    expect(realAwsEndpointFor('BEDROCK_RUNTIME', 'us-east-1')).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com'
    );
    expect(realAwsEndpointFor('API_GATEWAY', 'us-east-1')).toBe('https://apigateway.us-east-1.amazonaws.com');
  });

  it('uses the China DNS suffix in the China regions', () => {
    expect(realAwsEndpointFor('DYNAMODB', 'cn-north-1')).toBe('https://dynamodb.cn-north-1.amazonaws.com.cn');
  });

  it('gives a global service its one endpoint only in its signing region', () => {
    expect(realAwsEndpointFor('IAM', 'us-east-1')).toBe('https://iam.amazonaws.com');
    expect(realAwsEndpointFor('ROUTE_53', 'us-east-1')).toBe('https://route53.amazonaws.com');
    expect(realAwsEndpointFor('ORGANIZATIONS', 'us-east-1')).toBe(
      'https://organizations.us-east-1.amazonaws.com'
    );
    // The SDK would sign for ap-northeast-1; the global endpoint refuses that.
    expect(() => realAwsEndpointFor('IAM', 'ap-northeast-1')).toThrow(
      /IAM is served by one global endpoint \(https:\/\/iam\.amazonaws\.com\) that accepts only requests signed for us-east-1.*Leave IAM on AWS Emulator, or run the workload in us-east-1\./
    );
    expect(() => realAwsEndpointFor('IAM', 'cn-north-1')).toThrow(/has no known real IAM endpoint/);
    expect(() => realAwsEndpointFor('SQS', 'us-iso-east-1')).toThrow(/has no known real SQS endpoint/);
  });

  it('refuses a region that is not an AWS region name, and services with no regional endpoint', () => {
    expect(() => realAwsEndpointFor('SECRETS_MANAGER', 'us-east-1.evil.test/')).toThrow(
      /is not an AWS region name/
    );
    for (const id of ['APIGATEWAYMANAGEMENTAPI', 'CLOUDFRONT_KEYVALUESTORE']) {
      expect(() => realAwsEndpointFor(id, 'us-east-1')).toThrow(/has no regional endpoint/);
    }
  });
});

// go-to-k/cdk-local#894: the scan must not consume a pipe-backed --env-vars
// before the command's own reader runs.
describe('pipe-backed --env-vars (FIFO)', () => {
  it('the exception scan and the command read see the same text, read once', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fifo-'));
    let empty: ReturnType<typeof spawn> | undefined;
    try {
      const fifo = path.join(dir, 'env.fifo');
      execFileSync('mkfifo', [fifo]);
      const body = JSON.stringify({ Parameters: { AWS_ENDPOINT_URL_SQS: REAL_AWS_SENTINEL } });
      // One writer: a second read of the FIFO itself would block forever.
      const writer = spawn('sh', ['-c', 'printf "%s" "$1" > "$2"', 'sh', body, fifo]);
      const done = new Promise((r) => writer.on('exit', r));
      expect(readAwsEmulatorEnvVarsFile(fifo).exceptions).toHaveLength(1);
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
      const body = JSON.stringify({ Parameters: { AWS_ENDPOINT_URL_SQS: REAL_AWS_SENTINEL } });
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

describe('resourceTypeMatchesService', () => {
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
    expect(resourceTypeMatchesService(type, services)).toBe(expected);
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
      Secret: res('AWS::SecretsManager::Secret', 'real-secret'),
      Table: res('AWS::DynamoDB::Table', 'real-table'),
      Fn: res('AWS::Lambda::Function', 'real-fn'),
    },
    outputs: { SecretName: 'real-secret', TableName: 'real-table', RealOnly: 'r' },
    region: 'us-east-1',
  };
  const emuRecord: LocalStateRecord = {
    resources: {
      Secret: res('AWS::SecretsManager::Secret', 'emu-secret'),
      Table: res('AWS::DynamoDB::Table', 'emu-table'),
      Fn: res('AWS::Lambda::Function', 'emu-fn'),
    },
    outputs: { SecretName: 'emu-secret', TableName: 'emu-table', EmuOnly: 'x' },
    region: 'us-east-1',
  };

  it('takes excepted services from real AWS and everything else from the emulator', async () => {
    const p = createMixedModeStateProvider({
      emulator: fakeProvider(emuRecord),
      real: fakeProvider(realRecord),
      realServices: ['SECRETS_MANAGER'],
    });
    const r = (await p.load('S', 'us-east-1'))!;
    expect(r.resources['Secret']!.physicalId).toBe('real-secret');
    expect(r.resources['Table']!.physicalId).toBe('emu-table');
    expect(r.resources['Fn']!.physicalId).toBe('emu-fn');
    // Outputs come from the emulator; one naming an excepted resource follows the swap.
    expect(r.outputs).toEqual({ SecretName: 'real-secret', TableName: 'emu-table', EmuOnly: 'x' });
  });

  it("swaps the emulator's deployed-function env values that name an excepted resource; roles and SSM from real", async () => {
    const real = fakeProvider(realRecord, {
      resolveLambdaExecutionRoleArn: vi.fn(async () => 'arn:role'),
      resolveTemplateSsmParameters: vi.fn(async () => ({ P: 'v' })),
      getLastLoadError: () => 'real-err',
    });
    const emulator = fakeProvider(emuRecord, {
      resolveDeployedFunctionEnv: vi.fn(async () => ({
        SECRET: 'emu-secret',
        TABLE: 'emu-table',
        SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:emu-secret',
      })),
      getLastLoadError: () => 'emu-err',
    });
    const p = createMixedModeStateProvider({ emulator, real, realServices: ['SECRETS_MANAGER'] });
    await p.load('S', undefined);
    expect(await p.resolveDeployedFunctionEnv!('emu-fn')).toEqual({
      SECRET: 'real-secret',
      TABLE: 'emu-table',
      // Only exact physical IDs are swapped; an ARN keeps naming the emulator's secret (documented).
      SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:emu-secret',
    });
    expect(await p.resolveLambdaExecutionRoleArn!('emu-fn')).toBe('arn:role');
    // The emulator's physical ID is looked up under its real counterpart's.
    expect(real.resolveLambdaExecutionRoleArn).toHaveBeenCalledWith('real-fn');
    expect(await p.resolveTemplateSsmParameters!({} as never)).toEqual({ P: 'v' });
    expect(p.getLastLoadError!()).toBe('emu-err');
    await p.buildCrossStackResolver('us-east-1');
    expect(emulator.buildCrossStackResolver).toHaveBeenCalled();
    expect(real.buildCrossStackResolver).not.toHaveBeenCalled();
    p.dispose();
    expect(real.dispose).toHaveBeenCalled();
    expect(emulator.dispose).toHaveBeenCalled();
  });

  it('keeps emulator names with one warning when real AWS has no such stack', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      const p = createMixedModeStateProvider({
        emulator: fakeProvider(emuRecord),
        real: fakeProvider(undefined, { getLastLoadError: () => 'Stack S does not exist' }),
        realServices: ['SECRETS_MANAGER'],
      });
      expect((await p.load('S', undefined))!.resources['Secret']!.physicalId).toBe('emu-secret');
      await p.load('S', undefined);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(
        /could not be read from real AWS \(Stack S does not exist\); resources of the services marked "real-aws" \(SECRETS_MANAGER\) keep their AWS Emulator names.*deploy the stack to real AWS too/
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when real AWS has no such stack and no resource is excepted', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      const p = createMixedModeStateProvider({
        emulator: fakeProvider(emuRecord),
        real: fakeProvider(undefined),
        realServices: ['STS'],
      });
      expect((await p.load('S', undefined))!.resources['Secret']!.physicalId).toBe('emu-secret');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // Fails closed: with no emulator copy, nothing but the excepted resources is
  // taken from real AWS, and the rest are named as unresolved.
  it('warns once per stack, naming the unresolved resources, when only real AWS has the stack', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      const p = createMixedModeStateProvider({
        emulator: fakeProvider(undefined, { getLastLoadError: () => 'Stack S does not exist' }),
        real: fakeProvider(realRecord),
        realServices: ['SECRETS_MANAGER'],
      });
      const r = (await p.load('S', undefined))!;
      expect(Object.keys(r.resources)).toEqual(['Secret']);
      expect(r.outputs).toEqual({});
      await p.load('S', undefined);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]![0]);
      expect(msg).toMatch(/could not be read from AWS Emulator \(Stack S does not exist\), only from real AWS/);
      expect(msg).toMatch(/services marked "real-aws" \(SECRETS_MANAGER\) stay unresolved: /);
      for (const id of ['Table', 'Fn']) expect(msg).toContain(id);
      expect(msg).toContain('AWS::DynamoDB::Table');
      expect(msg).not.toMatch(/Secret \(/);
      expect(msg).toMatch(/Deploy the stack into AWS Emulator under the same stack name .*-c stage=dev.*--env-vars/);
    } finally {
      warn.mockRestore();
    }
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
