import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

describe('resolveEcsSecrets — --profile threading', () => {
  beforeEach(() => {
    smCtorArgs.length = 0;
    ssmCtorArgs.length = 0;
    smSend.mockReset();
    ssmSend.mockReset();
    smSend.mockResolvedValue({ SecretString: 'resolved-value' });
  });

  it('threads --profile into both the Secrets Manager and SSM clients', async () => {
    const out = await resolveEcsSecrets(
      [{ containerName: 'App', name: 'HASH_SALT', valueFrom: SM_ARN }],
      { region: 'ap-northeast-1', profile: 'mates_dev' }
    );

    expect(out).toEqual([
      { containerName: 'App', name: 'HASH_SALT', valueFrom: SM_ARN, value: 'resolved-value' },
    ]);
    expect(smCtorArgs).toEqual([{ region: 'ap-northeast-1', profile: 'mates_dev' }]);
    expect(ssmCtorArgs).toEqual([{ region: 'ap-northeast-1', profile: 'mates_dev' }]);
  });

  it('omits the profile key when --profile is unset', async () => {
    await resolveEcsSecrets([{ containerName: 'App', name: 'HASH_SALT', valueFrom: SM_ARN }], {
      region: 'ap-northeast-1',
    });

    expect(smCtorArgs[0]!).not.toHaveProperty('profile');
    expect(ssmCtorArgs[0]!).not.toHaveProperty('profile');
  });
});
