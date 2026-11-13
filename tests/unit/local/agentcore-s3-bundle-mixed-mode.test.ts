import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { strToU8, zipSync } from 'fflate';

// The DEFAULT fromS3 fetcher (no `fetchObject` injected) under AWS Emulator
// mixed mode: real S3 when a "real-aws" exception names S3, the emulator
// otherwise (go-to-k/cdk-local#914).
const { s3Configs } = vi.hoisted(() => ({ s3Configs: [] as Array<Record<string, unknown>> }));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: Record<string, unknown>) {
      s3Configs.push(config);
    }
    async send(): Promise<unknown> {
      const bytes = zipSync({ 'main.py': strToU8('print(1)') });
      return { Body: { transformToByteArray: async () => bytes } };
    }
    destroy(): void {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { downloadAndExtractS3Bundle } = await import('../../../src/local/agentcore-s3-bundle.js');
const { setAwsEmulatorServiceRouting } = await import('../../../src/utils/aws-proxy.js');

const EMU = 'https://127.0.0.1:9403';
const CREDS = { accessKeyId: 'AKIAREAL', secretAccessKey: 'realSecret', sessionToken: 'tok' };

function route(envOverrides: Record<string, unknown>): void {
  setAwsEmulatorServiceRouting({
    realServices: [],
    override: { endpoint: EMU, credentials: { accessKeyId: 'EMUKEY', secretAccessKey: 'x'.repeat(40) } },
    envOverrides,
  });
}

async function download(workload?: { logicalId: string }): Promise<void> {
  const bundle = await downloadAndExtractS3Bundle(
    { bucket: 'b', key: 'k.zip' },
    { region: 'us-east-1', credentials: CREDS, ...(workload && { workload }) }
  );
  await bundle.cleanup();
}

afterEach(() => {
  setAwsEmulatorServiceRouting(undefined);
  s3Configs.length = 0;
});

describe('fromS3 bundle download under AWS Emulator mixed mode', () => {
  it('reads real S3 with the real credentials when S3 is excepted for the runtime', async () => {
    route({ Parameters: {}, Agent: { AWS_ENDPOINT_URL_S3: 'real-aws' } });
    await download({ logicalId: 'Agent' });
    expect(s3Configs[0]!['endpoint']).toBeUndefined();
    expect(s3Configs[0]!['credentials']).toMatchObject({ accessKeyId: 'AKIAREAL' });
  });

  it('keeps an unmarked S3 on the emulator, with its keys only', async () => {
    route({ Parameters: { AWS_ENDPOINT_URL_ECR: 'real-aws' } });
    await download({ logicalId: 'Agent' });
    expect(s3Configs[0]!['endpoint']).toBe(EMU);
    const creds = s3Configs[0]!['credentials'] as () => Promise<unknown>;
    expect(await creds()).toMatchObject({ accessKeyId: 'EMUKEY' });
  });
});
