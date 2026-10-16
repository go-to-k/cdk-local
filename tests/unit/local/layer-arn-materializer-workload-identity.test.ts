import { rmSync } from 'node:fs';
import { deflateRaw } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// The DEFAULT sts factory (no `stsClientFactory` injected) must sign the
// --layer-role-arn hop with the workload identity (go-to-k/cdk-local#783).
const { stsConfigs, lambdaConfigs } = vi.hoisted(() => ({
  stsConfigs: [] as Array<Record<string, unknown>>,
  lambdaConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(config: Record<string, unknown>) {
      stsConfigs.push(config);
    }
    async send(): Promise<unknown> {
      return {
        Credentials: { AccessKeyId: 'AKIAHOP', SecretAccessKey: 'hopSecret', SessionToken: 'tok' },
      };
    }
    destroy(): void {}
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    constructor(config: Record<string, unknown>) {
      lambdaConfigs.push(config);
    }
    async send(): Promise<unknown> {
      return { Content: { Location: 'https://presigned.example/zip' } };
    }
    destroy(): void {}
  },
  GetLayerVersionCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { materializeLayerFromArn } from '../../../src/local/layer-arn-materializer.js';
import type { ResolvedArnLambdaLayer } from '../../../src/local/lambda-resolver.js';
import { resetEmbedConfig, setEmbedConfig } from '../../../src/local/embed-config.js';
import {
  recordAssumedRole,
  resetWorkloadIdentity,
} from '../../../src/utils/workload-identity.js';

async function tinyZip(): Promise<Uint8Array> {
  const data = Buffer.from('x');
  const compressed = await new Promise<Buffer>((res, rej) =>
    deflateRaw(data, (e, o) => (e ? rej(e) : res(o)))
  );
  const name = Buffer.from('a.txt');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localPart = Buffer.concat([local, name, compressed]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralPart = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return new Uint8Array(Buffer.concat([localPart, centralPart, eocd]));
}

const LAYER: ResolvedArnLambdaLayer = {
  kind: 'arn',
  logicalId: 'arn:aws:lambda:us-west-2:111122223333:layer:shared:1',
  arn: 'arn:aws:lambda:us-west-2:111122223333:layer:shared:1',
  region: 'us-west-2',
  accountId: '111122223333',
  name: 'shared',
  version: '1',
};

describe('layer ARN materializer — default clients under workloadIdentity (go-to-k/cdk-local#783)', () => {
  const dirs: string[] = [];
  // workloadClientConfig injects nothing when AWS_PROFILE is set, so an
  // exported profile in the shell running the suite would flip these cases.
  let savedAwsProfile: string | undefined;
  beforeEach(() => {
    savedAwsProfile = process.env['AWS_PROFILE'];
    delete process.env['AWS_PROFILE'];
    stsConfigs.length = 0;
    lambdaConfigs.length = 0;
    resetWorkloadIdentity();
    resetEmbedConfig();
  });
  afterEach(() => {
    if (savedAwsProfile === undefined) delete process.env['AWS_PROFILE'];
    else process.env['AWS_PROFILE'] = savedAwsProfile;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  async function run(): Promise<void> {
    const dir = await materializeLayerFromArn(LAYER, {
      roleArn: 'arn:aws:iam::111122223333:role/LayerRead',
      fetchZip: tinyZip,
    });
    dirs.push(dir);
  }

  it('caller mode: the default STS client signs the hop with the caller triple', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    await run();
    const creds = stsConfigs[0]!['credentials'] as () => Promise<unknown>;
    expect(await creds()).toEqual({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    // The Lambda client carries the hop's returned credentials, not the caller's.
    expect(lambdaConfigs[0]!['credentials']).toMatchObject({ accessKeyId: 'AKIAHOP' });
  });

  it('role mode: the default STS client injects no credentials', async () => {
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    await run();
    expect(stsConfigs[0]).not.toHaveProperty('credentials');
  });
});
