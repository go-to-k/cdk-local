import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { stsSend, ecrSend, runFg, runStream } = vi.hoisted(() => ({
  stsSend: vi.fn(),
  ecrSend: vi.fn(),
  runFg: vi.fn(),
  runStream: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSend;
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
  AssumeRoleCommand: class {},
}));

vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: class {
    send = ecrSend;
    destroy(): void {}
  },
  GetAuthorizationTokenCommand: class {},
}));

vi.mock('../../../src/utils/docker-cmd.js', () => ({
  runDockerForeground: runFg,
  runDockerStreaming: runStream,
  formatDockerLoginError: (s: string) => s,
}));

const { pullEcrImage, parseEcrUri, __resetStsCachesForTesting } = await import(
  '../../../src/local/ecr-puller.js'
);

const ACCT = '123456789012';
/** U+212A KELVIN SIGN: `toLowerCase` folds it onto ASCII `k`. */
const KELVIN = String.fromCodePoint(0x212a);
const PASSWORD = 'ecr-token-password-760';

function authData(proxyEndpoint: string | undefined): unknown {
  return {
    authorizationData: [
      {
        authorizationToken: Buffer.from(`AWS:${PASSWORD}`).toString('base64'),
        ...(proxyEndpoint !== undefined && { proxyEndpoint }),
      },
    ],
  };
}

/** The `docker login` argv cdk-local issued, and the stdin it fed. */
function loginCall(): { args: string[]; input: unknown } {
  const calls = runStream.mock.calls.filter((c) => (c[0] as string[])[0] === 'login');
  expect(calls).toHaveLength(1);
  return { args: calls[0]![0] as string[], input: (calls[0]![1] as { input?: unknown })?.input };
}

beforeEach(() => {
  stsSend.mockReset();
  ecrSend.mockReset();
  runFg.mockReset();
  runStream.mockReset();
  __resetStsCachesForTesting();
  stsSend.mockResolvedValue({ Account: ACCT });
  runFg.mockResolvedValue(undefined);
  runStream.mockResolvedValue(undefined);
});

describe('pullEcrImage — docker login targets the host the pull targets (issue #760)', () => {
  // `GetAuthorizationToken` reports the CALLER's default registry on the PLAIN
  // host as proxyEndpoint whatever the pull targets; the login must follow the
  // PULL host instead.
  const PLAIN_PROXY = `https://${ACCT}.dkr.ecr.us-east-1.amazonaws.com`;

  it.each([
    `${ACCT}.dkr.ecr.us-east-1.amazonaws.com`,
    `${ACCT}.dkr.ecr-fips.us-east-1.amazonaws.com`,
    `${ACCT}.dkr-ecr.us-east-1.on.aws`,
    `${ACCT}.dkr-ecr-fips.us-east-1.on.aws`,
  ])('%s: logs in to and pulls from that same host', async (host) => {
    ecrSend.mockResolvedValue(authData(PLAIN_PROXY));
    const uri = `${host}/my-repo:v1`;

    const ref = await pullEcrImage(uri, { skipPull: false, region: 'us-east-1' });

    const login = loginCall();
    expect(login.args).toStrictEqual([
      'login',
      '--username',
      'AWS',
      '--password-stdin',
      `https://${host}`,
    ]);
    expect(runFg).toHaveBeenCalledWith(['pull', uri]);
    expect(ref).toBe(uri);
  });

  it.each([
    ['a VPC-endpoint host', 'https://vpce-0abc-xyz.dkr.ecr.us-east-1.vpce.amazonaws.com'],
    ["the CALLER's registry (cross-account pull)", 'https://999999999999.dkr.ecr.us-east-1.amazonaws.com'],
  ])(
    'ignores a proxyEndpoint naming %s even on the PLAIN form',
    async (_label, proxyEndpoint) => {
      ecrSend.mockResolvedValue(authData(proxyEndpoint));

      await pullEcrImage(`${ACCT}.dkr.ecr.us-east-1.amazonaws.com/r:t`, {
        skipPull: false,
        region: 'us-east-1',
      });

      expect(loginCall().args.at(-1)).toBe(`https://${ACCT}.dkr.ecr.us-east-1.amazonaws.com`);
    }
  );

  it.each([
    ['us-iso-east-1', 'c2s.ic.gov'],
    ['cn-north-1', 'amazonaws.com.cn'],
    ['eu-isoe-west-1', 'cloud.adc-e.uk'],
  ])('logs in to the partition host in %s whether or not AWS reports a proxyEndpoint', async (region, suffix) => {
    const host = `${ACCT}.dkr.ecr.${region}.${suffix}`;
    for (const proxy of [undefined, PLAIN_PROXY]) {
      runStream.mockClear();
      ecrSend.mockResolvedValue(authData(proxy));

      await pullEcrImage(`${host}/r:t`, { skipPull: false, region });

      expect(loginCall().args.at(-1)).toBe(`https://${host}`);
    }
    expect(runFg).toHaveBeenCalledWith(['pull', `${host}/r:t`]);
  });

  it('logs in, pulls and returns the ASCII-lower-cased host for an upper-cased reference', async () => {
    ecrSend.mockResolvedValue(authData(PLAIN_PROXY));

    const ref = await pullEcrImage(`${ACCT}.DKR-ECR.US-EAST-1.ON.AWS/my-repo:V1`, {
      skipPull: false,
      region: 'us-east-1',
    });

    const canonical = `${ACCT}.dkr-ecr.us-east-1.on.aws/my-repo:V1`;
    expect(loginCall().args.at(-1)).toBe(`https://${ACCT}.dkr-ecr.us-east-1.on.aws`);
    expect(runFg).toHaveBeenCalledWith(['pull', canonical]);
    expect(ref).toBe(canonical);
  });

  it('passes the token only over stdin, never in argv', async () => {
    ecrSend.mockResolvedValue(authData(PLAIN_PROXY));

    await pullEcrImage(`${ACCT}.dkr-ecr-fips.us-east-1.on.aws/r:t`, {
      skipPull: false,
      region: 'us-east-1',
    });

    const login = loginCall();
    expect(login.input).toBe(PASSWORD);
    expect(login.args).toContain('--password-stdin');
    for (const call of [...runStream.mock.calls, ...runFg.mock.calls]) {
      expect((call[0] as string[]).join(' ')).not.toContain(PASSWORD);
    }
  });

  it.each([
    `${ACCT}.dkr-ecr.us-east-1.on.aws.evil.example/r:t`,
    `${ACCT}.dkr.ecr-fips.us-east-1.example.com/r:t`,
    `${ACCT}.dkr.ecr.us-east-1.amazonaws.com:5000/r:t`,
    `${ACCT}.dkr.ecr-fips.us-${KELVIN}east-1.amazonaws.com/r:t`,
  ])('refuses %s before any AWS call or docker login', async (uri) => {
    expect(parseEcrUri(uri)).toBeUndefined();
    await expect(pullEcrImage(uri, { skipPull: false, region: 'us-east-1' })).rejects.toThrow(
      /is not an ECR URI/
    );
    expect(stsSend).not.toHaveBeenCalled();
    expect(ecrSend).not.toHaveBeenCalled();
    expect(runStream).not.toHaveBeenCalled();
  });
});

describe('parseEcrUri', () => {
  it('returns the canonical reference and registry host for a dual-stack FIPS image', () => {
    expect(parseEcrUri(`${ACCT}.dkr-ecr-fips.us-west-2.on.aws/team/app:1.2`)).toStrictEqual({
      accountId: ACCT,
      region: 'us-west-2',
      repository: 'team/app',
      tag: '1.2',
      canonicalUri: `${ACCT}.dkr-ecr-fips.us-west-2.on.aws/team/app:1.2`,
      registryHost: `${ACCT}.dkr-ecr-fips.us-west-2.on.aws`,
    });
  });
});
