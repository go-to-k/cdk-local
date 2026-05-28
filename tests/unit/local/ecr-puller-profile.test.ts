import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { stsCtorArgs, ecrCtorArgs, stsSend, ecrSend, runFg, runStream } = vi.hoisted(() => ({
  stsCtorArgs: [] as Array<Record<string, unknown>>,
  ecrCtorArgs: [] as Array<Record<string, unknown>>,
  stsSend: vi.fn(),
  ecrSend: vi.fn(),
  runFg: vi.fn(),
  runStream: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(cfg: Record<string, unknown>) {
      stsCtorArgs.push(cfg);
    }
    send = stsSend;
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {
    kind = 'gci';
  },
  AssumeRoleCommand: class {
    kind = 'assume';
  },
}));

vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: class {
    constructor(cfg: Record<string, unknown>) {
      ecrCtorArgs.push(cfg);
    }
    send = ecrSend;
    destroy(): void {}
  },
  GetAuthorizationTokenCommand: class {
    kind = 'gat';
  },
}));

vi.mock('../../../src/utils/docker-cmd.js', () => ({
  runDockerForeground: runFg,
  runDockerStreaming: runStream,
  formatDockerLoginError: (s: string) => s,
}));

const { pullEcrImage, __resetStsCachesForTesting } = await import(
  '../../../src/local/ecr-puller.js'
);

const IMAGE = '583942117338.dkr.ecr.ap-northeast-1.amazonaws.com/my-repo:latest';

describe('pullEcrImage — --profile threading', () => {
  beforeEach(() => {
    stsCtorArgs.length = 0;
    ecrCtorArgs.length = 0;
    stsSend.mockReset();
    ecrSend.mockReset();
    runFg.mockReset();
    runStream.mockReset();
    __resetStsCachesForTesting();
    // GetCallerIdentity -> same account as the image (no cross-account);
    // AssumeRole -> usable temp creds.
    stsSend.mockImplementation((cmd: { kind?: string }) => {
      if (cmd?.kind === 'assume') {
        return Promise.resolve({
          Credentials: {
            AccessKeyId: 'AKIA',
            SecretAccessKey: 'secret',
            SessionToken: 'token',
            Expiration: new Date(Date.now() + 3600_000),
          },
        });
      }
      return Promise.resolve({ Account: '583942117338' });
    });
    ecrSend.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:pw').toString('base64'),
          proxyEndpoint: 'https://583942117338.dkr.ecr.ap-northeast-1.amazonaws.com',
        },
      ],
    });
    runFg.mockResolvedValue(undefined);
    runStream.mockResolvedValue(undefined);
  });

  it('threads --profile into both the STS caller-identity and the ECR auth client', async () => {
    await pullEcrImage(IMAGE, { skipPull: false, region: 'ap-northeast-1', profile: 'mates_dev' });

    expect(stsCtorArgs.some((c) => c['profile'] === 'mates_dev')).toBe(true);
    expect(ecrCtorArgs).toHaveLength(1);
    expect(ecrCtorArgs[0]!['profile']).toBe('mates_dev');
    // No assumed-role credentials on the same-account, no-ecrRoleArn path.
    expect(ecrCtorArgs[0]!['credentials']).toBeUndefined();
    expect(runFg).toHaveBeenCalledWith(['pull', IMAGE]);
  });

  it('constructs the clients WITHOUT a profile key when --profile is unset', async () => {
    await pullEcrImage(IMAGE, { skipPull: false, region: 'ap-northeast-1' });

    expect(stsCtorArgs.every((c) => !('profile' in c))).toBe(true);
    expect(ecrCtorArgs[0]!).not.toHaveProperty('profile');
  });

  it('uses assumed-role credentials (not profile) on the ECR client when --ecr-role-arn is set, but still threads profile into the AssumeRole STS client', async () => {
    await pullEcrImage(IMAGE, {
      skipPull: false,
      region: 'ap-northeast-1',
      profile: 'mates_dev',
      ecrRoleArn: 'arn:aws:iam::583942117338:role/EcrPull',
    });

    // The AssumeRole source identity honors the profile.
    expect(stsCtorArgs.some((c) => c['profile'] === 'mates_dev')).toBe(true);
    // The ECR client authenticates with the assumed creds, not the profile.
    expect(ecrCtorArgs[0]!['credentials']).toMatchObject({ accessKeyId: 'AKIA' });
    expect(ecrCtorArgs[0]!).not.toHaveProperty('profile');
  });
});
