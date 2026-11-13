import { describe, expect, it } from 'vite-plus/test';
import {
  REAL_SQS_QUEUE_URL,
  SQS_BLOCKED_REGIONS,
  isRealAwsHost,
  realSqsHostnames,
  repointLocalSqsQueueUrlsInEnv,
  rewriteSqsQueueUrlsInEnv,
  sqsBlockedRegionsFor,
  sqsEmulatorOriginOf,
} from '../../../src/local/aws-emulator-sqs-routing.js';
import {
  applyWorkloadAwsWiringToEnv,
  awsEmulatorSqsHostBlocks,
  type MixedModeWiring,
  type WorkloadAwsWiring,
} from '../../../src/local/workload-aws-wiring.js';
import { RESIGN_SIDECAR_CORE } from '../../../src/local/emulator-resign-sidecar.js';

// go-to-k/cdk-local#947: a real-shaped SQS queue URL in a workload's env sent
// an unexcepted SQS call to real AWS (the JS SDK v3 follows the queue URL's
// host), signed with the real identity in mixed mode and with the emulator's
// key ID under --aws-emulator alone.

const EMU_KEYS = { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'EMUSECRET' };
const REAL_KEYS = { AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'real-secret' };
const Q = 'https://sqs.us-east-1.amazonaws.com/000000000000/Stack-Queue4A7E3555-abc';
const RESIGN = 'https://127.0.0.1:47297';

function emulator(sqsSidecar: boolean): WorkloadAwsWiring {
  return {
    mode: 'emulator',
    emulatorEndpoint: { url: 'https://127.0.0.1:9501', hostname: '127.0.0.1', port: 9501, loopback: true },
    env: {
      AWS_ENDPOINT_URL: 'https://127.0.0.1:9501',
      ...(sqsSidecar ? { AWS_ENDPOINT_URL_SQS: RESIGN } : {}),
    },
    scrubEnvKeys: ['AWS_PROFILE'],
    mounts: [],
    loopbackPorts: [9501],
    probeHealth: true,
    emulatorCredentials: EMU_KEYS,
    dispose: () => undefined,
  };
}

function mixed(realServices: string[]): WorkloadAwsWiring {
  const m = {
    realServices,
    emulatorEndpoint: { url: 'https://127.0.0.1:9501', hostname: '127.0.0.1', port: 9501, loopback: true },
    resignPort: 47297,
    resignEndpoint: RESIGN,
    emulatorCredentials: EMU_KEYS,
    region: 'us-east-1',
    resignConfigHostPath: '/tmp/resign.json',
    emulatorClientOverride: { endpoint: 'https://127.0.0.1:9501' },
  } as MixedModeWiring;
  return {
    mode: 'forward',
    mixed: m,
    env: { AWS_ENDPOINT_URL: RESIGN },
    scrubEnvKeys: [],
    mounts: [],
    loopbackPorts: [9501, 47297],
    probeHealth: true,
    dispose: () => undefined,
  };
}

const forward: WorkloadAwsWiring = {
  mode: 'forward',
  env: {},
  scrubEnvKeys: [],
  mounts: [],
  loopbackPorts: [],
  probeHealth: false,
  dispose: () => undefined,
};

describe('applyWorkloadAwsWiringToEnv: SQS queue URLs in the env (#947)', () => {
  it('--aws-emulator with the SQS sidecar: a queue URL points at the sidecar', () => {
    const out = applyWorkloadAwsWiringToEnv({ QUEUE_URL: Q, AWS_REGION: 'us-east-1' }, emulator(true));
    expect(out['QUEUE_URL']).toBe(`${RESIGN}/000000000000/Stack-Queue4A7E3555-abc`);
  });

  it('--aws-emulator without a sidecar: a queue URL points at the emulator itself', () => {
    const out = applyWorkloadAwsWiringToEnv({ QUEUE_URL: ` ${Q} ` }, emulator(false));
    expect(out['QUEUE_URL']).toBe('https://127.0.0.1:9501/000000000000/Stack-Queue4A7E3555-abc');
  });

  it('mixed mode with SQS not excepted: the queue URL goes through the re-signing sidecar, any account', () => {
    const real = 'https://sqs.eu-west-1.amazonaws.com/123456789012/orders.fifo';
    const legacy = 'https://queue.amazonaws.com/123456789012/old';
    const out = applyWorkloadAwsWiringToEnv(
      { QUEUE_URL: Q, REAL_QUEUE: real, LEGACY: legacy, AWS_ENDPOINT_URL_DYNAMODB: 'real-aws', ...REAL_KEYS },
      mixed(['DYNAMODB'])
    );
    expect(out['AWS_ENDPOINT_URL_DYNAMODB']).toBe('https://dynamodb.us-east-1.amazonaws.com');
    expect(out['AWS_ACCESS_KEY_ID']).toBe('AKIAREAL');
    expect(out['QUEUE_URL']).toBe(`${RESIGN}/000000000000/Stack-Queue4A7E3555-abc`);
    expect(out['REAL_QUEUE']).toBe(`${RESIGN}/123456789012/orders.fifo`);
    expect(out['LEGACY']).toBe(`${RESIGN}/123456789012/old`);
  });

  it('mixed mode with SQS excepted: the queue URL stays on real SQS', () => {
    const out = applyWorkloadAwsWiringToEnv(
      { QUEUE_URL: Q, AWS_ENDPOINT_URL_SQS: 'real-aws', ...REAL_KEYS },
      mixed(['SQS'])
    );
    expect(out['AWS_ENDPOINT_URL_SQS']).toBe('https://sqs.us-east-1.amazonaws.com');
    expect(out['QUEUE_URL']).toBe(Q);
  });

  it('an empty AWS_ENDPOINT_URL_SQS falls back to the global endpoint, as in the SDKs', () => {
    const out = applyWorkloadAwsWiringToEnv(
      { QUEUE_URL: Q, AWS_ENDPOINT_URL_SQS: '', AWS_ENDPOINT_URL_DYNAMODB: 'real-aws', ...REAL_KEYS },
      mixed(['DYNAMODB'])
    );
    expect(out['QUEUE_URL']).toBe(`${RESIGN}/000000000000/Stack-Queue4A7E3555-abc`);
    expect(awsEmulatorSqsHostBlocks(out, mixed(['DYNAMODB'])).length).toBeGreaterThan(0);
  });

  it('without --aws-emulator nothing is rewritten', () => {
    expect(applyWorkloadAwsWiringToEnv({ QUEUE_URL: Q }, forward)['QUEUE_URL']).toBe(Q);
  });

  it('a queue URL inside a larger value, or another URL, is left alone', () => {
    const json = JSON.stringify({ q: Q });
    const out = applyWorkloadAwsWiringToEnv(
      {
        CONFIG: json,
        API: 'https://example.com/000000000000/x',
        PORTED: 'https://sqs.us-east-1.amazonaws.com:443/000000000000/x',
      },
      emulator(true)
    );
    expect(out['CONFIG']).toBe(json);
    expect(out['API']).toBe('https://example.com/000000000000/x');
    expect(out['PORTED']).toBe('https://sqs.us-east-1.amazonaws.com:443/000000000000/x');
  });
});

describe('awsEmulatorSqsHostBlocks (#947)', () => {
  const hosts = (env: Record<string, string>, w: WorkloadAwsWiring | undefined) =>
    awsEmulatorSqsHostBlocks(env, w).map((h) => `${h.host}:${h.ip}`);

  it('an emulator-side container cannot resolve real SQS hosts', () => {
    const env = applyWorkloadAwsWiringToEnv({ AWS_REGION: 'us-east-1' }, emulator(false));
    const out = hosts(env, emulator(false));
    expect(out).toContain('sqs.us-east-1.amazonaws.com:127.0.0.1');
    expect(out).toContain('us-east-1.queue.amazonaws.com:127.0.0.1');
    expect(out).toContain('queue.amazonaws.com:127.0.0.1');
    expect(out).toContain('sqs.cn-north-1.amazonaws.com.cn:127.0.0.1');
  });

  it('blocks every region of the aws, aws-cn and aws-us-gov partitions, with no region in the env', () => {
    const env = applyWorkloadAwsWiringToEnv({}, emulator(false));
    const out = hosts(env, emulator(false));
    for (const r of ['me-west-1', 'sa-west-1', 'ap-southeast-7', 'mx-central-1']) {
      expect(out).toContain(`sqs.${r}.amazonaws.com:127.0.0.1`);
      expect(out).toContain(`${r}.queue.amazonaws.com:127.0.0.1`);
    }
    for (const r of ['cn-north-1', 'cn-northwest-1']) {
      expect(out).toContain(`sqs.${r}.amazonaws.com.cn:127.0.0.1`);
    }
    expect(out).toContain('sqs.us-gov-west-1.amazonaws.com:127.0.0.1');
    expect(out).toContain('sqs.us-gov-east-1.amazonaws.com:127.0.0.1');
    expect(SQS_BLOCKED_REGIONS).toHaveLength(40);
  });

  it('mixed mode: blocked unless the container excepts SQS', () => {
    const notExcepted = applyWorkloadAwsWiringToEnv(
      { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws', ...REAL_KEYS },
      mixed(['DYNAMODB'])
    );
    expect(hosts(notExcepted, mixed(['DYNAMODB']))).toContain('sqs.us-east-1.amazonaws.com:127.0.0.1');
    const excepted = applyWorkloadAwsWiringToEnv(
      { AWS_ENDPOINT_URL_SQS: 'real-aws', ...REAL_KEYS },
      mixed(['SQS'])
    );
    expect(hosts(excepted, mixed(['SQS']))).toEqual([]);
  });

  it('nothing without --aws-emulator or without a wiring', () => {
    expect(hosts({ AWS_ENDPOINT_URL: 'http://127.0.0.1:4566' }, forward)).toEqual([]);
    expect(hosts({}, undefined)).toEqual([]);
  });

  it("covers a region newer than the pinned list: the env's own, and a queue URL's", () => {
    const env = {
      AWS_ENDPOINT_URL: 'https://127.0.0.1:9501',
      AWS_REGION: 'xx-future-1',
      CONFIG: '{"q":"https://sqs.yy-future-2.amazonaws.com/123456789012/q"}',
    };
    const out = hosts(env, emulator(false));
    expect(out).toContain('sqs.xx-future-1.amazonaws.com:127.0.0.1');
    expect(out).toContain('sqs.yy-future-2.amazonaws.com:127.0.0.1');
  });
});

describe('aws-emulator-sqs-routing helpers', () => {
  it('sqsEmulatorOriginOf: SQS endpoint first, then the global one; real hosts and non-URLs are not the emulator', () => {
    expect(sqsEmulatorOriginOf({ AWS_ENDPOINT_URL: 'https://127.0.0.1:9501/' })).toBe('https://127.0.0.1:9501');
    expect(
      sqsEmulatorOriginOf({ AWS_ENDPOINT_URL: 'https://127.0.0.1:9501', AWS_ENDPOINT_URL_SQS: RESIGN })
    ).toBe(RESIGN);
    expect(
      sqsEmulatorOriginOf({ AWS_ENDPOINT_URL: RESIGN, AWS_ENDPOINT_URL_SQS: 'https://sqs.us-east-1.amazonaws.com' })
    ).toBeUndefined();
    expect(sqsEmulatorOriginOf({ AWS_ENDPOINT_URL_SQS: 'https://sqs.us-east-1.api.aws' })).toBeUndefined();
    expect(sqsEmulatorOriginOf({ AWS_ENDPOINT_URL_SQS: 'REAL-AWS' })).toBeUndefined();
    expect(sqsEmulatorOriginOf({})).toBeUndefined();
    expect(sqsEmulatorOriginOf({ AWS_ENDPOINT_URL_SQS: 'ftp://127.0.0.1:1' })).toBeUndefined();
    expect(sqsEmulatorOriginOf({ AWS_ENDPOINT_URL_SQS: 'file:///x' })).toBeUndefined();
  });

  it('isRealAwsHost', () => {
    expect(isRealAwsHost('sqs.us-east-1.amazonaws.com')).toBe(true);
    expect(isRealAwsHost('SQS.CN-NORTH-1.AMAZONAWS.COM.CN.')).toBe(true);
    expect(isRealAwsHost('sqs.us-east-1.api.aws')).toBe(true);
    expect(isRealAwsHost('127.0.0.1')).toBe(false);
    expect(isRealAwsHost('notamazonaws.com')).toBe(false);
  });

  it('rewriteSqsQueueUrlsInEnv returns the keys only', () => {
    const env = { A: Q, B: 'x' };
    expect(rewriteSqsQueueUrlsInEnv(env, 'http://h:1')).toEqual(['A']);
    expect(env.A).toBe('http://h:1/000000000000/Stack-Queue4A7E3555-abc');
  });

  it('repointLocalSqsQueueUrlsInEnv moves only queue URLs on that origin', () => {
    const env = {
      A: `${RESIGN}/000000000000/q`,
      B: `${RESIGN}/health`,
      C: 'https://127.0.0.1:9501/000000000000/q',
    };
    repointLocalSqsQueueUrlsInEnv(env, `${RESIGN}/`, 'https://127.0.0.1:9501');
    expect(env).toEqual({
      A: 'https://127.0.0.1:9501/000000000000/q',
      B: `${RESIGN}/health`,
      C: 'https://127.0.0.1:9501/000000000000/q',
    });
  });

  it('realSqsHostnames / sqsBlockedRegionsFor', () => {
    expect(realSqsHostnames(['eu-west-1', 'not a region'])).toEqual([
      'eu-west-1.queue.amazonaws.com',
      'queue.amazonaws.com',
      'sqs.eu-west-1.amazonaws.com',
    ]);
    expect(sqsBlockedRegionsFor({})).toEqual([...SQS_BLOCKED_REGIONS]);
  });

  it("the sidecar's response rewrite uses the same queue URL pattern", () => {
    expect(RESIGN_SIDECAR_CORE).toContain(`var SQS_QUEUE_URL=/${REAL_SQS_QUEUE_URL.source}/;`);
  });
});
