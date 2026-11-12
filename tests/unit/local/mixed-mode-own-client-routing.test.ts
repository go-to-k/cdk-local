import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdk-local#898: in AWS Emulator mixed mode, cdk-local's OWN pre-start
// AWS calls route per service exactly like the workload's runtime calls — a
// sentinel-routed service reads the emulator (its endpoint, CA and keys) from
// the host, every other service stays on real AWS with the real identity.
// The matrix: each own call site × {service emulated, not emulated}, plus the
// two modes that must not change (no emulator; `--aws-emulator` alone).

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
});

describe('mixed mode: own pre-start calls route per service (#898)', () => {
  for (const site of SITES) {
    it(`${site.name}: emulator when ${site.service} is routed`, async () => {
      setAwsEmulatorServiceRouting({ services: ['DYNAMODB', site.service], override: OVERRIDE });
      expect(await sideUsedBy(site)).toBe('emulator');
    });

    it(`${site.name}: real AWS when only another service is routed`, async () => {
      setAwsEmulatorServiceRouting({ services: ['DYNAMODB'], override: OVERRIDE });
      expect(await sideUsedBy(site)).toBe('real');
    });

    it(`${site.name}: unchanged without the emulator (real) and under --aws-emulator alone (emulator)`, async () => {
      expect(await sideUsedBy(site)).toBe('real');
      setAwsEndpointOverride(OVERRIDE);
      expect(await sideUsedBy(site)).toBe('emulator');
    });
  }

  it("--from-cfn-stack's real side keeps reading the real stack even when CLOUDFORMATION / LAMBDA are routed", async () => {
    setAwsEmulatorServiceRouting({
      services: ['CLOUDFORMATION', 'LAMBDA', 'BEDROCK_AGENTCORE_CONTROL'],
      override: OVERRIDE,
    });
    const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: REGION });
    ctorArgs.length = 0;
    await p.resolveDeployedFunctionEnv('fn');
    await p.load('S', REGION).catch(() => undefined);
    p.dispose();
    const cfn = ctorArgs.filter((c) => c.cls === 'CloudFormationClient' || c.cls === 'LambdaClient');
    expect(cfn.map((c) => c.cls).sort()).toEqual(['CloudFormationClient', 'LambdaClient']);
    for (const c of cfn) expect(await sideOf(c.cfg)).toBe('real');
  });

  it('start-cloudfront keeps its KeyValueStore read on real AWS (real names, realAwsOnly state)', async () => {
    setAwsEmulatorServiceRouting({ services: ['CLOUDFRONT_KEYVALUESTORE'], override: OVERRIDE });
    ctorArgs.length = 0;
    createDeployedKvsDataSource({
      kvsArn: 'arn:aws:cloudfront::123456789012:key-value-store/x',
      credentials: REAL_KEY,
    });
    expect(ctorArgs[0]!.cfg['endpoint']).toBeUndefined();
    expect(ctorArgs[0]!.cfg['credentials']).toEqual(REAL_KEY);
  });

  it('the service id matches the SDK spelling exactly, as the workload SDK reads it', async () => {
    setAwsEmulatorServiceRouting({ services: ['SECRETS_MANAGER'], override: OVERRIDE });
    expect(awsClientConfigForService('SECRETS_MANAGER').endpoint).toBe(EMU_URL);
    expect(awsClientConfigForService('Secrets Manager').endpoint).toBe(EMU_URL);
    expect(awsClientConfigForService('secrets_manager').endpoint).toBe(EMU_URL);
    // A spelling no SDK reads routes nothing.
    expect(awsClientConfigForService('SECRETSMANAGER').endpoint).toBeUndefined();
    expect(awsClientConfigForService('SSM').endpoint).toBeUndefined();
  });
});
