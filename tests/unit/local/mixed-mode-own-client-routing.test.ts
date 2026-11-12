import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdk-local#898: in AWS Emulator mixed mode, cdk-local's OWN pre-start
// AWS calls route per service exactly like the workload's runtime calls — every
// service reads the emulator (its endpoint, CA and keys) from the host, except
// one a `"real-aws"` exception names, which stays on real AWS with the real
// identity. The matrix: each own call site × {service excepted, not excepted},
// plus the two modes that must not change (no emulator; `--aws-emulator` alone).

const { ctorArgs, respond } = vi.hoisted(() => {
  const ctorArgs: Array<{ cls: string; cfg: Record<string, unknown> }> = [];
  const respond = (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
    switch (cmd.constructor.name) {
      case 'GetSecretValueCommand':
        return { SecretString: 'secret-value' };
      case 'GetParameterCommand':
        return { Parameter: { Value: 'param-value' } };
      case 'GetParametersCommand':
        return {
          Parameters: ((cmd.input?.['Names'] as string[]) ?? []).map((n) => ({
            Name: n,
            Value: 'param-value',
            Type: 'String',
          })),
          InvalidParameters: [],
        };
      case 'GetKeyCommand':
        return { Value: 'kvs-value' };
      default:
        return {};
    }
  };
  return { ctorArgs, respond };
});

function fakeClient(cls: string) {
  return class {
    readonly config: Record<string, unknown>;
    constructor(cfg: Record<string, unknown>) {
      this.config = cfg;
      ctorArgs.push({ cls, cfg });
    }
    async send(cmd: { constructor: { name: string }; input?: Record<string, unknown> }) {
      return respond(cmd);
    }
    destroy(): void {}
  };
}

vi.mock('@aws-sdk/client-secrets-manager', async (orig) => ({
  ...(await orig<object>()),
  SecretsManagerClient: fakeClient('SecretsManagerClient'),
}));
vi.mock('@aws-sdk/client-ssm', async (orig) => ({
  ...(await orig<object>()),
  SSMClient: fakeClient('SSMClient'),
}));
vi.mock('@aws-sdk/client-cloudformation', async (orig) => ({
  ...(await orig<object>()),
  CloudFormationClient: fakeClient('CloudFormationClient'),
}));
vi.mock('@aws-sdk/client-lambda', async (orig) => ({
  ...(await orig<object>()),
  LambdaClient: fakeClient('LambdaClient'),
}));
vi.mock('@aws-sdk/client-cloudfront-keyvaluestore', async (orig) => ({
  ...(await orig<object>()),
  CloudFrontKeyValueStoreClient: fakeClient('CloudFrontKeyValueStoreClient'),
}));

const { DynamicReferenceResolver } = await import('../../../src/local/dynamic-reference-resolver.js');
const { resolveEcsSecrets } = await import('../../../src/local/ecs-secrets-resolver.js');
const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');
const { createDeployedKvsDataSource } = await import('../../../src/local/cloudfront-kvs-client.js');
const { setAwsEmulatorServiceRouting, setAwsEndpointOverride, awsClientConfigForService } =
  await import('../../../src/utils/aws-proxy.js');
const { recordAssumedRole, resetWorkloadIdentity } = await import(
  '../../../src/utils/workload-identity.js'
);
const { resetEmbedConfig, setEmbedConfig } = await import('../../../src/local/embed-config.js');

const EMU_URL = 'https://127.0.0.1:9391';
const EMU_KEY = { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'e'.repeat(40) };
const REAL_KEY = { accessKeyId: 'real-caller-key-id', secretAccessKey: 'r'.repeat(40) };
const OVERRIDE = { endpoint: EMU_URL, credentials: EMU_KEY };
const REGION = 'us-east-1';

type Side = 'real' | 'emulator';

/** Which side one captured client config talks to, checking it is coherent. */
async function sideOf(cfg: Record<string, unknown>): Promise<Side> {
  if (cfg['endpoint'] === undefined) {
    // Real AWS: no endpoint and no injected identity, so the SDK default chain
    // (the developer's real credentials) signs.
    expect(cfg['credentials']).toBeUndefined();
    return 'real';
  }
  expect(cfg['endpoint']).toBe(EMU_URL);
  expect(cfg['requestHandler']).toBeDefined();
  const creds = await (cfg['credentials'] as () => Promise<{ accessKeyId: string }>)();
  // The emulator's keys, never a real one.
  expect(creds.accessKeyId).toBe(EMU_KEY.accessKeyId);
  return 'emulator';
}

interface Site {
  name: string;
  /** The `AWS_ENDPOINT_URL_<ID>` service the site's client belongs to. */
  service: string;
  cls: string;
  run: () => Promise<void>;
}

const SITES: Site[] = [
  {
    name: '{{resolve:secretsmanager:...}}',
    service: 'SECRETS_MANAGER',
    cls: 'SecretsManagerClient',
    run: async () => {
      const r = new DynamicReferenceResolver();
      await r.resolveString('{{resolve:secretsmanager:probe}}', { region: REGION, consumer: 'test' });
      r.dispose();
    },
  },
  {
    name: '{{resolve:ssm:...}}',
    service: 'SSM',
    cls: 'SSMClient',
    run: async () => {
      const r = new DynamicReferenceResolver();
      await r.resolveString('{{resolve:ssm:/probe}}', { region: REGION, consumer: 'test' });
      r.dispose();
    },
  },
  {
    name: '{{resolve:ssm-secure:...}}',
    service: 'SSM',
    cls: 'SSMClient',
    run: async () => {
      const r = new DynamicReferenceResolver();
      await r.resolveString('{{resolve:ssm-secure:/probe}}', { region: REGION, consumer: 'test' });
      r.dispose();
    },
  },
  {
    name: 'ECS task Secrets (Secrets Manager ValueFrom)',
    service: 'SECRETS_MANAGER',
    cls: 'SecretsManagerClient',
    run: async () => {
      await resolveEcsSecrets(
        [
          {
            containerName: 'app',
            name: 'TOKEN',
            valueFrom: `arn:aws:secretsmanager:${REGION}:123456789012:secret:probe-AbCdEf`,
          },
        ],
        { region: REGION }
      );
    },
  },
  {
    name: 'ECS task Secrets (SSM ValueFrom)',
    service: 'SSM',
    cls: 'SSMClient',
    run: async () => {
      await resolveEcsSecrets(
        [
          {
            containerName: 'app',
            name: 'PARAM',
            valueFrom: `arn:aws:ssm:${REGION}:123456789012:parameter/probe`,
          },
        ],
        { region: REGION }
      );
    },
  },
  {
    name: '--from-cfn-stack SSM-backed template parameter',
    service: 'SSM',
    cls: 'SSMClient',
    run: async () => {
      const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: REGION });
      await p.resolveTemplateSsmParameters({
        Parameters: { P: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/probe' } },
        Resources: {},
      } as never);
      p.dispose();
    },
  },
];

async function sideUsedBy(site: Site): Promise<Side> {
  ctorArgs.length = 0;
  await site.run();
  const built = ctorArgs.filter((c) => c.cls === site.cls);
  expect(built.length).toBeGreaterThan(0);
  const sides = new Set<Side>();
  for (const b of built) sides.add(await sideOf(b.cfg));
  expect(sides.size).toBe(1);
  return [...sides][0]!;
}

beforeEach(() => {
  setAwsEndpointOverride(undefined);
  setAwsEmulatorServiceRouting(undefined);
});

afterEach(() => {
  setAwsEndpointOverride(undefined);
  setAwsEmulatorServiceRouting(undefined);
  resetWorkloadIdentity();
  resetEmbedConfig();
});

describe('mixed mode: own pre-start calls route per service (#898)', () => {
  for (const site of SITES) {
    it(`${site.name}: real AWS when ${site.service} is excepted`, async () => {
      setAwsEmulatorServiceRouting({ realServices: ['DYNAMODB', site.service], override: OVERRIDE });
      expect(await sideUsedBy(site)).toBe('real');
    });

    it(`${site.name}: emulator when only another service is excepted`, async () => {
      setAwsEmulatorServiceRouting({ realServices: ['DYNAMODB'], override: OVERRIDE });
      expect(await sideUsedBy(site)).toBe('emulator');
    });

    it(`${site.name}: unchanged without the emulator (real) and under --aws-emulator alone (emulator)`, async () => {
      expect(await sideUsedBy(site)).toBe('real');
      setAwsEndpointOverride(OVERRIDE);
      expect(await sideUsedBy(site)).toBe('emulator');
    });
  }

  it("--from-cfn-stack's own CloudFormation / Lambda clients (no service) stay on real AWS, whatever is excepted", async () => {
    setAwsEmulatorServiceRouting({ realServices: [], override: OVERRIDE });
    const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: REGION });
    ctorArgs.length = 0;
    await p.resolveDeployedFunctionEnv('fn');
    await p.load('S', REGION).catch(() => undefined);
    p.dispose();
    const cfn = ctorArgs.filter((c) => c.cls === 'CloudFormationClient' || c.cls === 'LambdaClient');
    expect(cfn.map((c) => c.cls).sort()).toEqual(['CloudFormationClient', 'LambdaClient']);
    for (const c of cfn) expect(await sideOf(c.cfg)).toBe('real');
  });

  it("caller mode with a recorded role, and --profile: a service sent to the emulator still signs only with the emulator's keys", async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(REAL_KEY, { accessKeyId: 'assumed-role-key-id', secretAccessKey: 'x'.repeat(40) });
    setAwsEmulatorServiceRouting({ realServices: ['SSM'], override: OVERRIDE });
    ctorArgs.length = 0;
    const r = new DynamicReferenceResolver({ profile: 'dev' });
    await r.resolveString('{{resolve:secretsmanager:probe}}', { region: REGION, consumer: 'test' });
    await r.resolveString('{{resolve:ssm:/probe}}', { region: REGION, consumer: 'test' });
    r.dispose();
    const sm = ctorArgs.find((c) => c.cls === 'SecretsManagerClient')!.cfg;
    expect(await sideOf(sm)).toBe('emulator');
    // Excepted (SSM): real AWS, the profile's chain (no injected caller triple under a profile).
    const ssm = ctorArgs.find((c) => c.cls === 'SSMClient')!.cfg;
    expect(ssm['endpoint']).toBeUndefined();
    expect(ssm['profile']).toBe('dev');
    // Without a profile, the excepted client gets the caller's pre-assume triple.
    ctorArgs.length = 0;
    const r2 = new DynamicReferenceResolver();
    await r2.resolveString('{{resolve:ssm:/probe}}', { region: REGION, consumer: 'test' });
    await r2.resolveString('{{resolve:secretsmanager:probe}}', { region: REGION, consumer: 'test' });
    r2.dispose();
    const ssm2 = ctorArgs.find((c) => c.cls === 'SSMClient')!.cfg;
    expect(ssm2['endpoint']).toBeUndefined();
    const callerCreds = await (ssm2['credentials'] as () => Promise<{ accessKeyId: string }>)();
    expect(callerCreds.accessKeyId).toBe(REAL_KEY.accessKeyId);
    expect(await sideOf(ctorArgs.find((c) => c.cls === 'SecretsManagerClient')!.cfg)).toBe('emulator');
  });

  it('start-cloudfront routes its KeyValueStore read per service: the emulator unless CLOUDFRONT_KEYVALUESTORE is excepted', async () => {
    const kvs = {
      kvsArn: 'arn:aws:cloudfront::123456789012:key-value-store/x',
      credentials: REAL_KEY,
    };
    setAwsEmulatorServiceRouting({ realServices: ['CLOUDFRONT_KEYVALUESTORE'], override: OVERRIDE });
    ctorArgs.length = 0;
    createDeployedKvsDataSource(kvs);
    expect(ctorArgs[0]!.cfg['endpoint']).toBeUndefined();
    expect(ctorArgs[0]!.cfg['credentials']).toEqual(REAL_KEY);
    // Not excepted: the emulator, signed with its keys only (the caller's keys are not injected).
    setAwsEmulatorServiceRouting({ realServices: [], override: OVERRIDE });
    ctorArgs.length = 0;
    createDeployedKvsDataSource(kvs);
    expect(await sideOf(ctorArgs[0]!.cfg)).toBe('emulator');
  });

  it('the service id matches the SDK spelling exactly, as the workload SDK reads it', async () => {
    setAwsEmulatorServiceRouting({ realServices: ['SECRETS_MANAGER'], override: OVERRIDE });
    expect(awsClientConfigForService('SECRETS_MANAGER').endpoint).toBeUndefined();
    expect(awsClientConfigForService('Secrets Manager').endpoint).toBeUndefined();
    expect(awsClientConfigForService('secrets_manager').endpoint).toBeUndefined();
    // A spelling no SDK reads is not the exception: it goes to the emulator, like every other service.
    expect(awsClientConfigForService('SECRETSMANAGER').endpoint).toBe(EMU_URL);
    expect(awsClientConfigForService('SSM').endpoint).toBe(EMU_URL);
  });
});

// go-to-k/cdk-local#902: a call made FOR one workload routes by that
// workload's own `"real-aws"` exceptions (`Parameters` plus its own sections, a
// section's `null` / literal clearing a `Parameters` exception), exactly as its
// runtime calls go; a call with no workload context uses the `Parameters`
// exceptions alone (a per-section exception does not make it real).
describe('mixed mode: own pre-start calls route per workload (#902)', () => {
  const FN_A = { logicalId: 'FnA1234', cdkPath: 'Stack/FnA/Resource' };
  const FN_B = { logicalId: 'FnB5678', cdkPath: 'Stack/FnB/Resource' };
  const ENV_OVERRIDES = {
    Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
    // A's section by its L2 path (prefix of the L1 path, as the env merge matches).
    'Stack/FnA': {
      AWS_ENDPOINT_URL_SSM: 'real-aws',
      AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws',
    },
    // B by logical ID: clears the Parameters exception for itself.
    FnB5678: { AWS_ENDPOINT_URL_DYNAMODB: null, OTHER: 'x' },
    app: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' },
    sidecar: { AWS_ENDPOINT_URL_DYNAMODB: 'http://localhost:8000' },
  };
  const install = (envOverrides?: Record<string, unknown>): void =>
    setAwsEmulatorServiceRouting({
      realServices: ['DYNAMODB', 'SECRETS_MANAGER', 'SSM'],
      override: OVERRIDE,
      ...(envOverrides && { envOverrides }),
    });

  async function sideOfResolve(
    token: string,
    cls: string,
    workload?: Record<string, string>
  ): Promise<Side> {
    ctorArgs.length = 0;
    const r = new DynamicReferenceResolver(workload ? { workload } : {});
    await r.resolveString(token, { region: REGION, consumer: 'test' });
    r.dispose();
    const built = ctorArgs.filter((c) => c.cls === cls);
    expect(built).toHaveLength(1);
    return sideOf(built[0]!.cfg);
  }

  const MATRIX: Array<{
    what: string;
    service: string;
    workload: Record<string, string> | undefined;
    side: Side;
  }> = [
    { what: 'A (own SSM exception)', service: 'SSM', workload: FN_A, side: 'real' },
    { what: 'B (no SSM exception)', service: 'SSM', workload: FN_B, side: 'emulator' },
    { what: 'A (own Secrets Manager exception)', service: 'SECRETS_MANAGER', workload: FN_A, side: 'real' },
    { what: 'B (no Secrets Manager exception)', service: 'SECRETS_MANAGER', workload: FN_B, side: 'emulator' },
    { what: 'A (Parameters DynamoDB exception)', service: 'DYNAMODB', workload: FN_A, side: 'real' },
    { what: 'B (clears the Parameters exception with null)', service: 'DYNAMODB', workload: FN_B, side: 'emulator' },
    { what: 'container app (own exception)', service: 'SECRETS_MANAGER', workload: { containerName: 'app' }, side: 'real' },
    { what: 'container sidecar (literal URL replaces the Parameters exception)', service: 'DYNAMODB', workload: { containerName: 'sidecar' }, side: 'emulator' },
    { what: 'container other (Parameters only)', service: 'DYNAMODB', workload: { containerName: 'other' }, side: 'real' },
    { what: 'container other (no own exception)', service: 'SSM', workload: { containerName: 'other' }, side: 'emulator' },
    { what: 'no workload context (Parameters exceptions only): Parameters exception', service: 'DYNAMODB', workload: undefined, side: 'real' },
    { what: 'no workload context (a per-section exception does not make it real)', service: 'SSM', workload: undefined, side: 'emulator' },
  ];
  for (const row of MATRIX) {
    it(`awsClientConfigForService(${row.service}) for ${row.what}: ${row.side}`, async () => {
      install(ENV_OVERRIDES);
      const cfg = awsClientConfigForService(row.service, row.workload ? { workload: row.workload } : {});
      expect(await sideOf(cfg as Record<string, unknown>)).toBe(row.side);
    });
  }

  it('{{resolve:ssm}} / {{resolve:secretsmanager}}: A reads real AWS, B the emulator', async () => {
    install(ENV_OVERRIDES);
    expect(await sideOfResolve('{{resolve:ssm:/p}}', 'SSMClient', FN_A)).toBe('real');
    expect(await sideOfResolve('{{resolve:ssm:/p}}', 'SSMClient', FN_B)).toBe('emulator');
    expect(await sideOfResolve('{{resolve:secretsmanager:s}}', 'SecretsManagerClient', FN_A)).toBe('real');
    expect(await sideOfResolve('{{resolve:secretsmanager:s}}', 'SecretsManagerClient', FN_B)).toBe('emulator');
    // No workload: the Parameters exceptions alone (A's SSM exception is its own section's).
    expect(await sideOfResolve('{{resolve:ssm:/p}}', 'SSMClient')).toBe('emulator');
  });

  it('a shared resolver fetches the same reference once per route, never reusing A\'s value for B', async () => {
    install(ENV_OVERRIDES);
    ctorArgs.length = 0;
    const r = new DynamicReferenceResolver();
    await r.resolveString('{{resolve:ssm:/p}}', { region: REGION, consumer: 'a', workload: FN_A });
    await r.resolveString('{{resolve:ssm:/p}}', { region: REGION, consumer: 'b', workload: FN_B });
    await r.resolveString('{{resolve:ssm:/p}}', { region: REGION, consumer: 'a2', workload: FN_A });
    r.dispose();
    const built = ctorArgs.filter((c) => c.cls === 'SSMClient');
    expect(built).toHaveLength(2);
    expect((await Promise.all(built.map((b) => sideOf(b.cfg)))).sort()).toEqual(['emulator', 'real']);
  });

  it('ECS task Secrets: each container reads where its own runtime calls go', async () => {
    install(ENV_OVERRIDES);
    ctorArgs.length = 0;
    const arn = `arn:aws:secretsmanager:${REGION}:123456789012:secret:probe-AbCdEf`;
    await resolveEcsSecrets(
      [
        { containerName: 'app', name: 'A', valueFrom: arn },
        { containerName: 'other', name: 'B', valueFrom: arn },
      ],
      { region: REGION }
    );
    const built = ctorArgs.filter((c) => c.cls === 'SecretsManagerClient');
    expect(built).toHaveLength(2);
    expect((await Promise.all(built.map((b) => sideOf(b.cfg)))).sort()).toEqual(['emulator', 'real']);
  });

  it('--from-cfn-stack SSM-backed template parameter follows the provider workload', async () => {
    install(ENV_OVERRIDES);
    const sideFor = async (workload?: Record<string, string>): Promise<Side> => {
      ctorArgs.length = 0;
      const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: REGION, workload });
      await p.resolveTemplateSsmParameters({
        Parameters: { P: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/probe' } },
        Resources: {},
      } as never);
      p.dispose();
      return sideOf(ctorArgs.find((c) => c.cls === 'SSMClient')!.cfg);
    };
    expect(await sideFor(FN_A)).toBe('real');
    expect(await sideFor(FN_B)).toBe('emulator');
    expect(await sideFor()).toBe('emulator');
  });

  it('resolveDynamicReferencesInEnv passes the env\'s workload to a SHARED resolver', async () => {
    install(ENV_OVERRIDES);
    const { resolveDynamicReferencesInEnv } = await import(
      '../../../src/local/dynamic-reference-resolver.js'
    );
    ctorArgs.length = 0;
    const shared = new DynamicReferenceResolver();
    for (const workload of [FN_A, FN_B]) {
      await resolveDynamicReferencesInEnv(
        { P: '{{resolve:ssm:/p}}' },
        { region: REGION, label: 'x', resolver: shared, workload }
      );
    }
    shared.dispose();
    const built = ctorArgs.filter((c) => c.cls === 'SSMClient');
    expect((await Promise.all(built.map((b) => sideOf(b.cfg)))).sort()).toEqual(['emulator', 'real']);
  });

  it('a client factory receives the route its client must take', async () => {
    install(ENV_OVERRIDES);
    const routes: unknown[] = [];
    const r = new DynamicReferenceResolver({
      ssmClientFactory: (_region, route) => {
        routes.push(route);
        return { send: async () => ({ Parameter: { Value: 'v' } }), destroy: () => undefined } as never;
      },
    });
    await r.resolveString('{{resolve:ssm:/p}}', { region: REGION, consumer: 'a', workload: FN_A });
    await r.resolveString('{{resolve:ssm:/p}}', { region: REGION, consumer: 'b', workload: FN_B });
    r.dispose();
    expect(routes).toEqual([
      { workload: FN_A, emulator: false },
      { workload: FN_B, emulator: true },
    ]);
  });

  it('awsEmulatorRealServices: per workload with the --env-vars file, Parameters-only without a workload', async () => {
    const { awsEmulatorRealServices } = await import('../../../src/utils/aws-proxy.js');
    expect(awsEmulatorRealServices(FN_A)).toBeUndefined();
    install(ENV_OVERRIDES);
    expect(awsEmulatorRealServices(FN_A)).toEqual(['DYNAMODB', 'SECRETS_MANAGER', 'SSM']);
    expect(awsEmulatorRealServices(FN_B)).toEqual([]);
    // No workload: the Parameters exceptions; A's per-section exceptions do not count.
    expect(awsEmulatorRealServices()).toEqual(['DYNAMODB']);
    // A host that installs routing without the file keeps the run-wide list.
    install();
    expect(awsEmulatorRealServices(FN_B)).toEqual(['DYNAMODB', 'SECRETS_MANAGER', 'SSM']);
    expect(await sideOf(awsClientConfigForService('SSM', { workload: FN_B }) as never)).toBe('real');
  });
});
