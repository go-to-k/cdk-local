import { afterEach, describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const {
  stsCtorArgs,
  ecrCtorArgs,
  stsSend,
  ecrSend,
  runFg,
  runStream,
  defaultProviderMock,
  chainMock,
} = vi.hoisted(() => {
  const chainMock = vi.fn();
  return {
    stsCtorArgs: [] as Array<Record<string, unknown>>,
    ecrCtorArgs: [] as Array<Record<string, unknown>>,
    stsSend: vi.fn(),
    ecrSend: vi.fn(),
    runFg: vi.fn(),
    runStream: vi.fn(),
    chainMock,
    defaultProviderMock: vi.fn(() => chainMock),
  };
});

// Only reached through the proxy fragment's `credentials` provider, which is
// what the issue go-to-k/cdk-local#648 cases below invoke; the rest of the
// file never resolves credentials at all.
vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: defaultProviderMock,
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
const { setAwsEmulatorServiceRouting, setAwsEndpointOverride } = await import(
  '../../../src/utils/aws-proxy.js'
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
    expect(runFg).toHaveBeenCalledWith(['pull', IMAGE], {
      env: { DOCKER_CONFIG: process.env['DOCKER_CONFIG'], DOCKER_AUTH_CONFIG: process.env['DOCKER_AUTH_CONFIG'], REGISTRY_AUTH_FILE: process.env['REGISTRY_AUTH_FILE'] },
    });
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

  /**
   * Issue go-to-k/cdk-local#648. Both failures below exist ONLY when a proxy
   * variable is set: with a clean environment `buildProxyClientConfig()`
   * returns `{}`, so neither the profile it carries nor its position in the
   * config object can change anything — which is exactly why the cases above
   * stayed green through both mutations (measured on origin/main: the full
   * 4497-test suite passed with the profile dropped at all nine fragment call
   * sites, and again with this site's spread moved last).
   */
  describe('under a proxy (issue #648)', () => {
    const PROXY_KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'] as const;
    const saved = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const key of PROXY_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
      }
      defaultProviderMock.mockClear();
      chainMock.mockReset();
      chainMock.mockResolvedValue({ accessKeyId: 'AKIA-CHAIN', secretAccessKey: 'chain' });
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
    });

    // No teardown of the `NodeHttpHandler`s the fragment builds, deliberately.
    // A round of this review added one, and it was measured to do NOTHING:
    // `NodeHttpHandler.destroy()` is `this.config?.httpAgent?.destroy()`, and
    // `config` is assigned only inside `handle()` — which no case here calls,
    // because the SDK clients are mocked. So the loop reached no agent, could
    // not reach the second handler `credentials()` builds either, and its
    // comment claimed a discipline it was not performing. Nothing leaks (no
    // socket is ever opened); an assertion-free loop that reads as cleanup is
    // worse than the absence it replaced.
    afterEach(() => {
      for (const key of PROXY_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('threads --profile INTO the proxy fragment, so the chain resolves the NAMED profile and not the default account', async () => {
      await pullEcrImage(IMAGE, {
        skipPull: false,
        region: 'ap-northeast-1',
        profile: 'mates_dev',
      });

      const cfg = ecrCtorArgs[0]!;
      expect(cfg['requestHandler']).toBeDefined();
      // The site ALSO passes `profile`, but under a proxy that key is inert:
      // the fragment supplies explicit `credentials`, and explicit
      // credentials beat a profile key in the AWS SDK. So the profile only
      // takes effect if it reached the credential chain — assert that, not
      // the decorative key.
      expect(cfg['profile']).toBe('mates_dev');
      expect(typeof cfg['credentials']).toBe('function');
      await (cfg['credentials'] as () => Promise<unknown>)();
      expect(defaultProviderMock).toHaveBeenCalledTimes(1);
      expect(defaultProviderMock.mock.calls[0]![0]).toMatchObject({ profile: 'mates_dev' });
    });

    it('keeps the site’s assumed-role credentials — the fragment is spread FIRST, so it never replaces them', async () => {
      await pullEcrImage(IMAGE, {
        skipPull: false,
        region: 'ap-northeast-1',
        profile: 'mates_dev',
        ecrRoleArn: 'arn:aws:iam::583942117338:role/EcrPull',
      });

      const cfg = ecrCtorArgs[0]!;
      // Spread LAST and this is the fragment's default-chain PROVIDER
      // (a function), silently authenticating as whoever the chain resolves
      // instead of as the assumed role.
      expect(typeof cfg['credentials']).toBe('object');
      expect(cfg['credentials']).toMatchObject({ accessKeyId: 'AKIA' });
      // ...while the proxy plumbing itself still survives the override.
      expect(cfg['requestHandler']).toBeDefined();
    });
  });
});

describe('pullEcrImage — AWS Emulator mixed mode follows "real-aws" on ECR', () => {
  const EMU = 'https://127.0.0.1:9403';
  const route = (envOverrides: Record<string, unknown>): void =>
    setAwsEmulatorServiceRouting({
      realServices: [],
      override: { endpoint: EMU, credentials: { accessKeyId: 'EMUKEY', secretAccessKey: 'x'.repeat(40) } },
      envOverrides,
    });
  const roleArn = 'arn:aws:iam::583942117338:role/EcrPull';

  beforeEach(() => {
    stsCtorArgs.length = 0;
    ecrCtorArgs.length = 0;
    __resetStsCachesForTesting();
    stsSend.mockReset();
    stsSend.mockImplementation((cmd: { kind?: string }) =>
      Promise.resolve(
        cmd?.kind === 'assume'
          ? {
              Credentials: {
                AccessKeyId: 'AKIA',
                SecretAccessKey: 'secret',
                SessionToken: 'token',
                Expiration: new Date(Date.now() + 3600_000),
              },
            }
          : { Account: '583942117338' }
      )
    );
    ecrSend.mockResolvedValue({
      authorizationData: [{ authorizationToken: Buffer.from('AWS:pw').toString('base64') }],
    });
    runFg.mockReset();
    runStream.mockReset();
    runFg.mockResolvedValue(undefined);
    runStream.mockResolvedValue(undefined);
  });
  afterEach(() => {
    setAwsEmulatorServiceRouting(undefined);
    setAwsEndpointOverride(undefined);
  });

  // go-to-k/cdk-local#917: an ECR URI names the REAL registry host, so an
  // unmarked pull is refused before any AWS call or docker spawn — the
  // emulator's token would be sent to real ECR, and the host's docker
  // credential helper would answer the pull with the real identity.
  const expectRefusedWithoutContact = async (p: Promise<unknown>): Promise<void> => {
    await expect(p).rejects.toThrow(/AWS_ENDPOINT_URL_ECR.*real-aws/);
    expect(stsSend).not.toHaveBeenCalled();
    expect(ecrCtorArgs).toHaveLength(0);
    expect(runStream).not.toHaveBeenCalled();
    expect(runFg).not.toHaveBeenCalled();
  };

  it('full --aws-emulator mode (no exception) refuses the pull before any AWS call or docker spawn', async () => {
    setAwsEndpointOverride({ endpoint: EMU, credentials: { accessKeyId: 'EMUKEY', secretAccessKey: 'x'.repeat(40) } });
    await expectRefusedWithoutContact(
      pullEcrImage(IMAGE, {
        skipPull: false,
        region: 'ap-northeast-1',
        profile: 'prod',
        ecrRoleArn: roleArn,
        workload: { containerName: 'web' },
      })
    );
  });

  it('still verifies a cached image under --no-pull in full --aws-emulator mode', async () => {
    setAwsEndpointOverride({ endpoint: EMU, credentials: { accessKeyId: 'EMUKEY', secretAccessKey: 'x'.repeat(40) } });
    await expect(pullEcrImage(IMAGE, { skipPull: true })).resolves.toBe(IMAGE);
    expect(runStream).toHaveBeenCalledWith(['image', 'inspect', IMAGE]);
    expect(stsSend).not.toHaveBeenCalled();
    expect(ecrCtorArgs).toHaveLength(0);
  });

  it('takes the token from real ECR, as the real identity, when ECR is excepted', async () => {
    route({ Parameters: { AWS_ENDPOINT_URL_ECR: 'real-aws' } });
    await pullEcrImage(IMAGE, { skipPull: false, region: 'ap-northeast-1', ecrRoleArn: roleArn });
    expect(ecrCtorArgs).toHaveLength(1);
    expect(ecrCtorArgs[0]!['endpoint']).toBeUndefined();
    // --ecr-role-arn is honored on the real side.
    expect(ecrCtorArgs[0]!['credentials']).toMatchObject({ accessKeyId: 'AKIA' });
    // The login and the pull use the host's own docker config (#917).
    const hostEnv = { env: { DOCKER_CONFIG: process.env['DOCKER_CONFIG'], DOCKER_AUTH_CONFIG: process.env['DOCKER_AUTH_CONFIG'], REGISTRY_AUTH_FILE: process.env['REGISTRY_AUTH_FILE'] } };
    expect(runFg).toHaveBeenCalledWith(['pull', IMAGE], hostEnv);
    expect(runStream).toHaveBeenCalledWith(
      expect.arrayContaining(['login']),
      expect.objectContaining(hostEnv)
    );
  });

  it("follows the workload's own section", async () => {
    route({ Parameters: {}, web: { AWS_ENDPOINT_URL_ECR: 'real-aws' } });
    await pullEcrImage(IMAGE, { skipPull: false, region: 'ap-northeast-1', workload: { containerName: 'web' } });
    expect(ecrCtorArgs.map((c) => c['endpoint'])).toEqual([undefined]);
    await expect(
      pullEcrImage(IMAGE, {
        skipPull: false,
        region: 'ap-northeast-1',
        workload: { containerName: 'worker' },
      })
    ).rejects.toThrow(/AWS_ENDPOINT_URL_ECR.*real-aws/);
    expect(ecrCtorArgs).toHaveLength(1);
  });

  it('refuses an unmarked ECR in mixed mode before any AWS call or docker spawn', async () => {
    route({ Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } });
    await expectRefusedWithoutContact(
      pullEcrImage(IMAGE, {
        skipPull: false,
        region: 'ap-northeast-1',
        profile: 'prod',
        ecrRoleArn: roleArn,
      })
    );
  });
});
