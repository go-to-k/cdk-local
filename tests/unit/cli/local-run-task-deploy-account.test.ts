import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#5001: under `workloadIdentity: 'caller'` the placeholder
// task-role ARN's account (and `${AWS::AccountId}`) is the DEPLOY account, so
// the GetCallerIdentity client must run as the recorded `--role-arn` role, not
// the caller and not the profile.

const stsCtorMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(config: unknown) {
      stsCtorMock(config);
    }
    send = async () => ({ Account: '222222222222' });
    destroy = () => {};
  },
  GetCallerIdentityCommand: class {},
}));

import { resolvePlaceholderAccountForTest } from '../../../src/cli/commands/local-run-task.js';
import { resetEmbedConfig, setEmbedConfig } from '../../../src/local/embed-config.js';
import {
  recordAssumedRole,
  resetWorkloadIdentity,
} from '../../../src/utils/workload-identity.js';
import { TASK_ROLE_ACCOUNT_PLACEHOLDER } from '../../../src/local/ecs-task-resolver.js';

const ROLE = { accessKeyId: 'AKIAROLE', secretAccessKey: 'roleSecret', sessionToken: 'roleTok' };
const CALLER = { accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' };
const ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'AWS_PROFILE',
] as const;

describe('resolvePlaceholderAccount runs as the deploy role in caller mode', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    stsCtorMock.mockReset();
    resetWorkloadIdentity();
    resetEmbedConfig();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  it('constructs the STS client with the role credentials and keeps the profile for region', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(CALLER, ROLE);
    const arn = `arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/r`;
    const out = await resolvePlaceholderAccountForTest(arn, 'us-east-1', 'dev');
    expect(out).toBe('arn:aws:iam::222222222222:role/r');
    const cfg = stsCtorMock.mock.calls[0]![0] as { credentials?: () => Promise<unknown> };
    expect(cfg).toHaveProperty('profile', 'dev');
    expect(await cfg.credentials!()).toEqual(ROLE);
  });

  it('role mode threads the profile and injects no credentials', async () => {
    const arn = `arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/r`;
    await resolvePlaceholderAccountForTest(arn, 'us-east-1', 'dev');
    const cfg = stsCtorMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(cfg['profile']).toBe('dev');
    expect(cfg).not.toHaveProperty('credentials');
  });
});
