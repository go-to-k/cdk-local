import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { s3Configs } = vi.hoisted(() => ({ s3Configs: [] as Array<Record<string, unknown>> }));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: Record<string, unknown>) {
      s3Configs.push(config);
    }
    async send(): Promise<unknown> {
      return { Body: { transformToByteArray: async () => new Uint8Array([104, 105]) } };
    }
    destroy(): void {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { createS3OriginReader } from '../../../src/local/cloudfront-s3-origin.js';
import { resetEmbedConfig, setEmbedConfig } from '../../../src/local/embed-config.js';
import {
  recordAssumedRole,
  resetWorkloadIdentity,
} from '../../../src/utils/workload-identity.js';

describe('CloudFront S3 origin — workloadIdentity (go-to-k/cdk-local#783)', () => {
  beforeEach(() => {
    s3Configs.length = 0;
    resetWorkloadIdentity();
    resetEmbedConfig();
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
  });
  afterEach(() => {
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  it('caller mode without explicit credentials: the client signs as the caller', async () => {
    const reader = createS3OriginReader('b', {});
    await reader({ uri: '/a.txt' });
    const creds = s3Configs[0]!['credentials'] as () => Promise<unknown>;
    expect(await creds()).toEqual({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
  });

  it('caller mode with an explicit credentials option: the explicit credentials win', async () => {
    const reader = createS3OriginReader('b', {
      credentials: { accessKeyId: 'AKIAEXPLICIT', secretAccessKey: 'explicitSecret' },
    });
    await reader({ uri: '/a.txt' });
    expect(s3Configs[0]!['credentials']).toEqual({
      accessKeyId: 'AKIAEXPLICIT',
      secretAccessKey: 'explicitSecret',
    });
  });
});
