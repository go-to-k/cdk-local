import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdk-local#783: the WORKLOAD-input client sites resolve as the caller
// under `workloadIdentity: 'caller'` once a role was assumed, and are built
// exactly as before in the default 'role' mode. The ECR pull itself stays on the
// role; only the `--ecr-role-arn` hop signer moves.

const { smCtor, ssmCtor, stsCtor, ecrCtor, smSend, ssmSend, stsSend, ecrSend, runFg, runStream } =
  vi.hoisted(() => ({
    smCtor: [] as Array<Record<string, unknown>>,
    ssmCtor: [] as Array<Record<string, unknown>>,
    stsCtor: [] as Array<Record<string, unknown>>,
    ecrCtor: [] as Array<Record<string, unknown>>,
    smSend: vi.fn(),
    ssmSend: vi.fn(),
    stsSend: vi.fn(),
    ecrSend: vi.fn(),
    runFg: vi.fn(),
    runStream: vi.fn(),
  }));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    constructor(cfg: Record<string, unknown>) {
      smCtor.push(cfg);
    }
    send = smSend;
    destroy(): void {}
  },
  GetSecretValueCommand: class {},
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    constructor(cfg: Record<string, unknown>) {
      ssmCtor.push(cfg);
    }
    send = ssmSend;
    destroy(): void {}
  },
  GetParameterCommand: class {},
  GetParametersCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = vi.fn();
    destroy(): void {}
  },
  ListStackResourcesCommand: class {},
  DescribeStacksCommand: class {},
  ListExportsCommand: class {},
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = vi.fn();
    destroy(): void {}
  },
  GetFunctionConfigurationCommand: class {},
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(cfg: Record<string, unknown>) {
      stsCtor.push(cfg);
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
      ecrCtor.push(cfg);
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

const { resolveEcsSecrets } = await import('../../../src/local/ecs-secrets-resolver.js');
const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');
const { pullEcrImage, __resetStsCachesForTesting } = await import(
  '../../../src/local/ecr-puller.js'
);
const { resetEmbedConfig, setEmbedConfig } = await import('../../../src/local/embed-config.js');
const { recordAssumedRole, resetWorkloadIdentity } = await import(
  '../../../src/utils/workload-identity.js'
);

const CALLER = {
  accessKeyId: 'AKIACALLER',
  secretAccessKey: 'callerSecret',
  sessionToken: 'callerToken',
};
const SM_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:my-secret';
const IMAGE = '583942117338.dkr.ecr.ap-northeast-1.amazonaws.com/my-repo:latest';

async function resolveCreds(cfg: Record<string, unknown>): Promise<unknown> {
  return (cfg['credentials'] as () => Promise<unknown>)();
}

describe('workload-input client sites (go-to-k/cdk-local#783)', () => {
  let savedProfile: string | undefined;

  beforeEach(() => {
    for (const a of [smCtor, ssmCtor, stsCtor, ecrCtor]) a.length = 0;
    for (const f of [smSend, ssmSend, stsSend, ecrSend, runFg, runStream]) f.mockReset();
    smSend.mockResolvedValue({ SecretString: 'resolved-value' });
    ssmSend.mockResolvedValue({
      Parameters: [{ Name: '/app/db-host', Value: 'db.internal' }],
      InvalidParameters: [],
    });
    stsSend.mockImplementation((cmd: { kind?: string }) =>
      Promise.resolve(
        cmd?.kind === 'assume'
          ? {
              Credentials: {
                AccessKeyId: 'AKIAHOP',
                SecretAccessKey: 'hopSecret',
                SessionToken: 'hopToken',
                Expiration: new Date(Date.now() + 3600_000),
              },
            }
          : { Account: '583942117338' }
      )
    );
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
    __resetStsCachesForTesting();
    savedProfile = process.env['AWS_PROFILE'];
    delete process.env['AWS_PROFILE'];
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  afterEach(() => {
    if (savedProfile === undefined) delete process.env['AWS_PROFILE'];
    else process.env['AWS_PROFILE'] = savedProfile;
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  describe('ecs-secrets-resolver default clients', () => {
    const secrets = [{ containerName: 'App', name: 'SALT', valueFrom: SM_ARN }];

    it('caller mode after an assume: constructed with the caller credentials', async () => {
      setEmbedConfig({ workloadIdentity: 'caller' });
      recordAssumedRole(CALLER);
      await resolveEcsSecrets(secrets, { region: 'ap-northeast-1' });
      expect(await resolveCreds(smCtor[0]!)).toEqual(CALLER);
    });

    it('role mode: constructed exactly as before (no injected credentials)', async () => {
      recordAssumedRole(CALLER);
      await resolveEcsSecrets(secrets, { region: 'ap-northeast-1' });
      expect(smCtor).toEqual([{ region: 'ap-northeast-1' }]);
    });
  });

  describe('cfn-local-state-provider lazy getters', () => {
    const template = {
      Resources: {},
      Parameters: {
        SsmDbHost: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/db-host' },
      },
    } as unknown as Parameters<
      NonNullable<InstanceType<typeof CfnLocalStateProvider>['resolveTemplateSsmParameters']>
    >[0];

    it('caller mode after an assume: the SSM client carries the caller credentials', async () => {
      setEmbedConfig({ workloadIdentity: 'caller' });
      recordAssumedRole(CALLER);
      const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
      await provider.resolveTemplateSsmParameters(template);
      expect(await resolveCreds(ssmCtor[0]!)).toEqual(CALLER);
      provider.dispose();
    });

    it('role mode: the SSM client is constructed exactly as before', async () => {
      recordAssumedRole(CALLER);
      const provider = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
      await provider.resolveTemplateSsmParameters(template);
      expect(ssmCtor).toEqual([{ region: 'us-east-1' }]);
      provider.dispose();
    });
  });

  describe('ecr-puller: the --ecr-role-arn hop vs the pull', () => {
    const ecrRoleArn = 'arn:aws:iam::583942117338:role/EcrPull';

    it('caller mode: the hop signer is the caller; the GetCallerIdentity and ECR clients stay on the role', async () => {
      setEmbedConfig({ workloadIdentity: 'caller' });
      recordAssumedRole(CALLER);
      await pullEcrImage(IMAGE, { skipPull: false, region: 'ap-northeast-1', ecrRoleArn });

      // Two STS clients: GetCallerIdentity (the pull, role) then the AssumeRole hop (caller).
      expect(stsCtor).toHaveLength(2);
      expect(stsCtor[0]).not.toHaveProperty('credentials');
      expect(await resolveCreds(stsCtor[1]!)).toEqual(CALLER);
      // The ECR client authenticates with the hop's assumed credentials, never the caller.
      expect(ecrCtor).toHaveLength(1);
      expect(ecrCtor[0]!['credentials']).toMatchObject({ accessKeyId: 'AKIAHOP' });
    });

    it('caller mode without --ecr-role-arn: the ECR client keeps the default (role) chain', async () => {
      setEmbedConfig({ workloadIdentity: 'caller' });
      recordAssumedRole(CALLER);
      await pullEcrImage(IMAGE, { skipPull: false, region: 'ap-northeast-1' });
      expect(stsCtor.every((c) => !('credentials' in c))).toBe(true);
      expect(ecrCtor[0]!).not.toHaveProperty('credentials');
    });

    it('role mode: every client is constructed exactly as before', async () => {
      recordAssumedRole(CALLER);
      await pullEcrImage(IMAGE, { skipPull: false, region: 'ap-northeast-1', ecrRoleArn });
      expect(stsCtor.every((c) => !('credentials' in c))).toBe(true);
      expect(ecrCtor[0]!['credentials']).toMatchObject({ accessKeyId: 'AKIAHOP' });
    });
  });
});
