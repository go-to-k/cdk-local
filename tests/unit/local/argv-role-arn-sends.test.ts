import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #607 review round 3 — the FOURTH and FIFTH guarded sends.
 *
 * `grep -rn "new AssumeRoleCommand({" src/` finds five. Three were guarded in
 * earlier rounds (`utils/role-arn.ts` x2, `local-invoke-agentcore.ts`). These
 * two are the remainder: `ecr-puller.ts`'s `--ecr-role-arn` and
 * `layer-arn-materializer.ts`'s `--layer-role-arn`.
 *
 * The reason they are guarded is CONSISTENCY and the LENGTH BOUND, NOT the
 * #607 threat model — both take their ARN only from the user's own argv, never
 * from a wire source, so a hostile endpoint cannot reach them. An earlier
 * review round justified leaving them unguarded on the grounds that their
 * values "already passed `parseAssumeRoleToken`"; they do not. Both flags are
 * declared as plain `new Option('<flag> <arn>', ...)` with NO `argParser`, and
 * `local-start-api.ts` holds the repo's only `parseAssumeRoleToken` wiring —
 * so before this nothing validated them at all.
 *
 * What each test pins is that the refusal (a) happens, (b) happens BEFORE any
 * STS client is built, and (c) renders its own bounded sentence rather than
 * being swallowed by the module's withholding policy.
 */

const { stsCtorArgs, stsSend, ecrSend, runFg, runStream } = vi.hoisted(() => ({
  stsCtorArgs: [] as Array<Record<string, unknown>>,
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
    constructor() {}
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
const { materializeLayerFromArn } = await import('../../../src/local/layer-arn-materializer.js');
const { refusedRoleArnMessage } = await import('../../../src/utils/role-arn.js');

/** Cross-account image, so the `--ecr-role-arn` branch is the one taken. */
const IMAGE = '111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/my-repo:latest';
const GOOD = 'arn:aws:iam::999988887777:role/CrossAccountRead';
/** Passes `startsWith('arn:')`, which is the check #607 replaced. */
const OVERLONG = `arn:aws:iam::999988887777:role/${'A'.repeat(100_000)}`;
const FORGED = 'arn:aws:iam::999988887777:role/R\nWARN: forged line';

describe('#607 — ecr-puller: the --ecr-role-arn send', () => {
  beforeEach(() => {
    stsCtorArgs.length = 0;
    stsSend.mockReset();
    ecrSend.mockReset();
    runFg.mockReset();
    runStream.mockReset();
    __resetStsCachesForTesting();
    // Caller identity is a DIFFERENT account than the image, so the pull is
    // cross-account and the role branch fires.
    stsSend.mockImplementation((cmd: { kind?: string }) => {
      if (cmd?.kind === 'assume') {
        return Promise.resolve({
          Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 's', SessionToken: 't' },
        });
      }
      return Promise.resolve({ Account: '583942117338' });
    });
    ecrSend.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:pw').toString('base64'),
          proxyEndpoint: 'https://111122223333.dkr.ecr.ap-northeast-1.amazonaws.com',
        },
      ],
    });
    runFg.mockResolvedValue(undefined);
    runStream.mockResolvedValue(undefined);
  });

  async function drive(ecrRoleArn: string): Promise<string> {
    return pullEcrImage(IMAGE, {
      skipPull: false,
      region: 'ap-northeast-1',
      ecrRoleArn,
    } as never).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
  }

  it('premise: the rejected fixtures pass the check #607 replaced', () => {
    expect(OVERLONG.startsWith('arn:')).toBe(true);
    expect(FORGED.startsWith('arn:')).toBe(true);
  });

  it('guard-the-guard: a WELL-FORMED --ecr-role-arn still assumes', async () => {
    // Without this, every refusal below would pass over a branch that had
    // simply stopped assuming anything.
    expect(await drive(GOOD)).toBe('');
    expect(stsSend.mock.calls.some((c) => (c[0] as { kind?: string })?.kind === 'assume')).toBe(
      true
    );
  });

  it('REFUSES an over-long value and never sends', async () => {
    const message = await drive(OVERLONG);
    expect(message).toContain('AssumeRole refused');
    expect(message).toContain('Nothing was sent to STS');
    expect(stsSend.mock.calls.some((c) => (c[0] as { kind?: string })?.kind === 'assume')).toBe(
      false
    );
  });

  it('REFUSES a forged newline, and the refusal is single-line', async () => {
    const message = await drive(FORGED);
    expect(message).toContain('AssumeRole refused');
    expect(message).not.toContain('\n');
  });

  it('the refusal is BOUNDED and names the true length', async () => {
    const message = await drive(OVERLONG);
    expect(message).toContain(`(${OVERLONG.length} characters)`);
    expect(message.length).toBeLessThan(500);
  });

  it('renders VERBATIM — the catch cannot withhold cdk-local’s own sentence', async () => {
    // Thrown OUTSIDE the `try`, so it never meets `describeAwsFailureForWarn`,
    // whose non-service branch would render it as
    // `LocalInvokeBuildError; NNN-character message withheld`.
    const message = await drive('not-an-arn');
    expect(message).not.toContain('message withheld');
    expect(message).toBe(refusedRoleArnMessage('not-an-arn'));
  });
});

describe('#607 — layer-arn-materializer: the --layer-role-arn send', () => {
  const layer = {
    arn: 'arn:aws:lambda:us-west-2:999988887777:layer:Shared:3',
    region: 'us-west-2',
    versionNumber: 3,
  } as never;

  async function drive(roleArn: string, stsClientFactory?: unknown): Promise<string> {
    return materializeLayerFromArn(layer, {
      roleArn,
      ...(stsClientFactory !== undefined && { stsClientFactory: stsClientFactory as never }),
    }).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
  }

  it('guard-the-guard: a WELL-FORMED --layer-role-arn still reaches the STS factory', async () => {
    let factoryCalled = false;
    await drive(GOOD, () => {
      factoryCalled = true;
      return {
        send: async () => ({ Credentials: { AccessKeyId: 'A', SecretAccessKey: 'S' } }),
        destroy: () => {},
      };
    });
    expect(factoryCalled).toBe(true);
  });

  it('REFUSES an over-long value before the STS factory is even built', async () => {
    let factoryCalled = false;
    const message = await drive(OVERLONG, () => {
      factoryCalled = true;
      return { send: async () => ({}), destroy: () => {} };
    });
    expect(message).toContain('AssumeRole refused');
    expect(factoryCalled).toBe(false);
  });

  it('REFUSES a forged newline, and the refusal is single-line', async () => {
    const message = await drive(FORGED);
    expect(message).toContain('AssumeRole refused');
    expect(message).not.toContain('\n');
  });

  it('the refusal is BOUNDED and names the true length', async () => {
    const message = await drive(OVERLONG);
    expect(message).toContain(`(${OVERLONG.length} characters)`);
    expect(message.length).toBeLessThan(500);
  });

  it('is SELF-FRAMED, so the caller cannot re-interpolate the raw ARN', async () => {
    // The caller wraps an UNframed error in
    // `Layer <arn>: STS AssumeRole(${flattenToOneLine(roleArn)}) failed: ...`,
    // which has no length cap — so framing the refusal there would put the
    // very value being refused FOR ITS LENGTH onto the line. Throwing the
    // already-framed `LayerMaterializationError` keeps the whole message
    // bounded, and the assertion below is what pins that choice.
    const message = await drive(OVERLONG);
    expect(message).toBe(refusedRoleArnMessage(OVERLONG));
    expect(message).not.toContain('STS AssumeRole(');
    expect(message).not.toContain('message withheld');
  });
});
