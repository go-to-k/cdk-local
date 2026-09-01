import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Issue #634 site-level binding: `resolveEcsSecrets` must SPREAD
// `buildProxyClientConfig` into BOTH client constructors — the static-import
// construction shape. The helper contract alone cannot prove the site
// actually threads it (the classic half-wired failure), so this locks the
// binding with the SDK boundary mocked.

const { smCtorArgs, ssmCtorArgs, smSend, ssmSend } = vi.hoisted(() => ({
  smCtorArgs: [] as Array<Record<string, unknown>>,
  ssmCtorArgs: [] as Array<Record<string, unknown>>,
  smSend: vi.fn(),
  ssmSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    constructor(cfg: Record<string, unknown>) {
      smCtorArgs.push(cfg);
    }
    send = smSend;
    destroy(): void {}
  },
  GetSecretValueCommand: class {},
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    constructor(cfg: Record<string, unknown>) {
      ssmCtorArgs.push(cfg);
    }
    send = ssmSend;
    destroy(): void {}
  },
  GetParameterCommand: class {},
}));

const { resolveEcsSecrets } = await import('../../../src/local/ecs-secrets-resolver.js');

const SM_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:my-secret';

describe('resolveEcsSecrets — proxy environment threading (issue #634)', () => {
  const saved = new Map<string, string | undefined>();
  const KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'] as const;

  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    smCtorArgs.length = 0;
    ssmCtorArgs.length = 0;
    smSend.mockReset();
    ssmSend.mockReset();
    smSend.mockResolvedValue({ SecretString: 'resolved-value' });
    ssmSend.mockResolvedValue({ Parameter: { Value: 'param-value' } });
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('threads requestHandler + credentials into both clients when HTTPS_PROXY is set', async () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
    await resolveEcsSecrets([{ containerName: 'App', name: 'HASH_SALT', valueFrom: SM_ARN }], {
      region: 'ap-northeast-1',
      profile: 'corp',
    });
    expect(smCtorArgs).toHaveLength(1);
    expect(ssmCtorArgs).toHaveLength(1);
    for (const cfg of [smCtorArgs[0]!, ssmCtorArgs[0]!]) {
      expect(cfg['requestHandler']).toBeDefined();
      expect(typeof cfg['credentials']).toBe('function');
      // The site's own fields still land AFTER the spread.
      expect(cfg['region']).toBe('ap-northeast-1');
      expect(cfg['profile']).toBe('corp');
    }
  });

  it('passes NO proxy fields when the environment is clean — zero behavior change', async () => {
    await resolveEcsSecrets([{ containerName: 'App', name: 'HASH_SALT', valueFrom: SM_ARN }], {
      region: 'ap-northeast-1',
    });
    expect(smCtorArgs).toHaveLength(1);
    expect('requestHandler' in smCtorArgs[0]!).toBe(false);
    expect('credentials' in smCtorArgs[0]!).toBe(false);
  });
});
