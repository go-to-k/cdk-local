import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    config: { credentials: () => Promise<unknown> };
    constructor(config: { credentials?: () => Promise<unknown> }) {
      this.config = {
        credentials:
          config.credentials ??
          (async () => ({ accessKeyId: 'AKIADEFAULT', secretAccessKey: 'defaultSecret' })),
      };
    }
    destroy(): void {}
  },
}));

import { defaultCredentialsLoader } from '../../../src/local/sigv4-verify.js';
import { resetEmbedConfig, setEmbedConfig } from '../../../src/local/embed-config.js';
import {
  recordAssumedRole,
  resetWorkloadIdentity,
} from '../../../src/utils/workload-identity.js';

describe('sigv4-verify defaultCredentialsLoader — workloadIdentity (go-to-k/cdk-local#783)', () => {
  // workloadClientConfig injects nothing when AWS_PROFILE is set, so an
  // exported profile in the shell running the suite would flip these cases.
  let savedAwsProfile: string | undefined;
  beforeEach(() => {
    savedAwsProfile = process.env['AWS_PROFILE'];
    delete process.env['AWS_PROFILE'];
    resetWorkloadIdentity();
    resetEmbedConfig();
  });
  afterEach(() => {
    if (savedAwsProfile === undefined) delete process.env['AWS_PROFILE'];
    else process.env['AWS_PROFILE'] = savedAwsProfile;
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  it('caller mode resolves the caller triple', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    expect(await defaultCredentialsLoader()()).toMatchObject({
      accessKeyId: 'AKIACALLER',
      secretAccessKey: 'callerSecret',
    });
  });

  it('role mode resolves through the default chain', async () => {
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    expect(await defaultCredentialsLoader()()).toMatchObject({ accessKeyId: 'AKIADEFAULT' });
  });
});
