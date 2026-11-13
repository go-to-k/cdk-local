/**
 * go-to-k/cdk-local#908 — the sites the inversion added or changed outside the
 * core module: the state-source hint (Plan A) and its ECS call site, the
 * deploy-artifact config, the `${AWS::AccountId}` lookup, the start-cloudfront
 * clients (no caller credential over the emulator's keys), and the value rows
 * the core tests do not cover.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const { cfConfigs } = vi.hoisted(() => ({ cfConfigs: [] as Array<Record<string, unknown>> }));
vi.mock('@aws-sdk/client-cloudfront', async (orig) => ({
  ...(await orig<object>()),
  CloudFrontClient: class {
    constructor(config: Record<string, unknown>) {
      cfConfigs.push(config);
    }
    async send(): Promise<unknown> {
      return {
        DistributionConfig: { Origins: { Items: [{ Id: 'o', DomainName: 'b.s3.us-east-1.amazonaws.com' }] } },
      };
    }
    destroy(): void {}
  },
}));

const {
  applyWorkloadAwsWiringToEnv,
  workloadGetsEmulatorKeysOnly,
  resetAwsEmulatorStateSourceHintForTest,
  resetWorkloadAwsWiringForTest,
  resolveWorkloadAwsWiring,
  setActiveWorkloadAwsWiring,
  takeAwsEmulatorStateSourceHint,
} = await import('../../../src/local/workload-aws-wiring.js');
const { findRealAwsExceptions, realAwsEndpointFor } = await import(
  '../../../src/local/aws-emulator-mixed-mode.js'
);
const { deployArtifactClientConfig, deployArtifactsReadEmulator, setAwsEmulatorServiceRouting } =
  await import('../../../src/utils/aws-proxy.js');
const { accountLookupStsClientConfig } = await import('../../../src/utils/workload-identity.js');
const { resetEmbedConfig, setEmbedConfig } = await import('../../../src/local/embed-config.js');
const { resolveEcsTaskTarget } = await import('../../../src/local/ecs-task-resolver.js');
const { withWorkloadAwsWiring } = await import('../../../src/local/docker-runner.js');
const { buildDockerRunArgs } = await import('../../../src/local/ecs-task-runner.js');
const { resolveSharedSidecarCredentials } = await import('../../../src/cli/commands/ecs-service-emulator.js');
const { resolveDeployedOriginBucket } = await import(
  '../../../src/local/cloudfront-distribution-config.js'
);

const EMU = 'https://127.0.0.1:9395';
const EMU_KEY = { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'A'.repeat(40) };
const REAL = { AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'real-secret' };

let home: string;

function writeEmulatorRun(port: number): void {
  const dir = path.join(home, '.aws', 'emulator', String(port));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'emulator_credentials'),
    `[default]\naws_access_key_id = ${EMU_KEY.accessKeyId}\naws_secret_access_key = ${EMU_KEY.secretAccessKey}\n`
  );
}

async function wiring(exceptions: Record<string, unknown> | undefined, port = 9395) {
  writeEmulatorRun(port);
  return resolveWorkloadAwsWiring({
    awsEmulator: `http://127.0.0.1:${port}`,
    homeDir: home,
    env: {},
    probeHealth: async () => undefined,
    ...(exceptions && { realAwsExceptions: findRealAwsExceptions(exceptions) }),
  });
}

function routeMixed(envOverrides: Record<string, unknown>): void {
  setAwsEmulatorServiceRouting({
    realServices: [],
    override: { endpoint: EMU, credentials: EMU_KEY },
    envOverrides,
  });
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'mixed-sites-'));
  resetWorkloadAwsWiringForTest();
  resetAwsEmulatorStateSourceHintForTest();
  cfConfigs.length = 0;
});

afterEach(() => {
  resetWorkloadAwsWiringForTest();
  resetAwsEmulatorStateSourceHintForTest();
  resetEmbedConfig();
  rmSync(home, { recursive: true, force: true });
});

describe('takeAwsEmulatorStateSourceHint guard', () => {
  it('is silent under a forward wiring (no --aws-emulator)', async () => {
    setActiveWorkloadAwsWiring(await resolveWorkloadAwsWiring({ env: {}, homeDir: home }));
    expect(takeAwsEmulatorStateSourceHint()).toBeUndefined();
  });

  it('answers in mixed mode, and names the host deploy under a host embed config', async () => {
    setEmbedConfig({ cliName: 'cdkd', binaryName: 'cdkd', productName: 'cdkd', envPrefix: 'CDKD' });
    setActiveWorkloadAwsWiring(await wiring({ Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' } }));
    expect(takeAwsEmulatorStateSourceHint()).toMatch(
      /--from-state \(the stack deployed into AWS Emulator with `cdkd deploy --aws-emulator`\)/
    );
  });
});

describe('ECS task resolver prints the hint once, after the per-variable warnings', () => {
  const stack = (): StackInfo =>
    ({
      stackName: 'S',
      region: 'us-east-1',
      template: {
        Resources: {
          Table: { Type: 'AWS::DynamoDB::Table', Properties: {} },
          TaskDef: {
            Type: 'AWS::ECS::TaskDefinition',
            Properties: {
              ContainerDefinitions: ['app', 'worker'].map((name) => ({
                Name: name,
                Image: 'public.ecr.aws/docker/library/busybox:latest',
                Environment: [{ Name: 'TABLE', Value: { Ref: 'Table' } }],
              })),
            },
          },
        },
      },
    }) as unknown as StackInfo;

  it('under --aws-emulator with no state source', async () => {
    setActiveWorkloadAwsWiring(await wiring(undefined));
    const task = resolveEcsTaskTarget('S:TaskDef', [stack()]);
    const hints = task.warnings.filter((w) => w.startsWith('Under --aws-emulator'));
    expect(hints).toHaveLength(1);
    expect(task.warnings.indexOf(hints[0]!)).toBe(task.warnings.length - 1);
    expect(task.warnings.filter((w) => /TABLE.* dropped/.test(w))).toHaveLength(2);
  });

  it('not without --aws-emulator', async () => {
    setActiveWorkloadAwsWiring(await resolveWorkloadAwsWiring({ env: {}, homeDir: home }));
    const task = resolveEcsTaskTarget('S:TaskDef', [stack()]);
    expect(task.warnings.some((w) => w.startsWith('Under --aws-emulator'))).toBe(false);
  });
});

describe('deployArtifactClientConfig', () => {
  it('reads the emulator in mixed mode whatever the exceptions', async () => {
    routeMixed({ Parameters: { AWS_ENDPOINT_URL_S3: 'real-aws', AWS_ENDPOINT_URL_ECR: 'real-aws' } });
    expect(deployArtifactsReadEmulator()).toBe(true);
    const cfg = deployArtifactClientConfig({ profile: 'prod' });
    expect(cfg.endpoint).toBe(EMU);
    expect(await cfg.credentials!({})).toMatchObject({ accessKeyId: EMU_KEY.accessKeyId });
  });

  it('is the plain proxy config without --aws-emulator', () => {
    setAwsEmulatorServiceRouting(undefined);
    expect(deployArtifactsReadEmulator()).toBe(false);
    expect(deployArtifactClientConfig().endpoint).toBeUndefined();
  });
});

describe('accountLookupStsClientConfig in mixed mode', () => {
  it('reads the emulator, with no profile, unless Parameters excepts STS', () => {
    routeMixed({ Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } });
    const emu = accountLookupStsClientConfig({ region: 'us-east-1', profile: 'prod' });
    expect(emu.endpoint).toBe(EMU);
    expect(emu.profile).toBeUndefined();
    expect(emu.region).toBe('us-east-1');

    routeMixed({ Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' } });
    const real = accountLookupStsClientConfig({ region: 'us-east-1', profile: 'prod' });
    expect(real.endpoint).toBeUndefined();
    expect(real.profile).toBe('prod');

    // A per-section STS exception does not make the run-wide lookup real.
    routeMixed({ Fn: { AWS_ENDPOINT_URL_STS: 'real-aws' } });
    expect(accountLookupStsClientConfig({ region: 'us-east-1' }).endpoint).toBe(EMU);
  });
});

describe('start-cloudfront clients never spread a caller credential over the emulator keys', () => {
  const creds = { accessKeyId: 'AKIACALLER', secretAccessKey: 's' };

  it('CloudFront routed to the emulator keeps the emulator keys', async () => {
    routeMixed({ Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } });
    await resolveDeployedOriginBucket({ distributionId: 'D', originId: 'o', credentials: creds });
    expect(cfConfigs[0]!['endpoint']).toBe(EMU);
    const c = await (cfConfigs[0]!['credentials'] as () => Promise<{ accessKeyId: string }>)();
    expect(c.accessKeyId).toBe(EMU_KEY.accessKeyId);
  });

  it('CloudFront excepted to real AWS takes the caller credential', async () => {
    routeMixed({ Parameters: { AWS_ENDPOINT_URL_CLOUDFRONT: 'real-aws' } });
    await resolveDeployedOriginBucket({ distributionId: 'D', originId: 'o', credentials: creds });
    expect(cfConfigs[0]!['endpoint']).toBeUndefined();
    expect(cfConfigs[0]!['credentials']).toMatchObject({ accessKeyId: 'AKIACALLER' });
  });
});

describe('value rows the core tests leave out', () => {
  it('full emulator mode passes a literal URL through, signed with the emulator keys', async () => {
    const w = await wiring(undefined);
    try {
      const env = applyWorkloadAwsWiringToEnv(
        { ...REAL, AWS_ENDPOINT_URL_SQS: 'https://sqs.example.test', AWS_REGION: 'us-east-1' },
        w
      );
      expect(w.mode).toBe('emulator');
      expect(env['AWS_ENDPOINT_URL_SQS']).toBe('https://sqs.example.test');
      expect(env['AWS_ACCESS_KEY_ID']).toBe(EMU_KEY.accessKeyId);
    } finally {
      w.dispose();
    }
  });

  it('a non-endpoint variable set to "real-aws" is an ordinary value in every mode', async () => {
    expect(findRealAwsExceptions({ Parameters: { FOO: 'real-aws' } })).toEqual([]);
    const forward = await resolveWorkloadAwsWiring({ env: {}, homeDir: home });
    expect(applyWorkloadAwsWiringToEnv({ FOO: 'real-aws' }, forward)['FOO']).toBe('real-aws');
    const mixed = await wiring({ Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' } }, 9396);
    try {
      expect(
        applyWorkloadAwsWiringToEnv({ FOO: 'real-aws', AWS_REGION: 'us-east-1' }, mixed)['FOO']
      ).toBe('real-aws');
    } finally {
      mixed.dispose();
    }
  });

  it('a global service is refused in GovCloud', () => {
    expect(() => realAwsEndpointFor('IAM', 'us-gov-west-1')).toThrow(/has no known real IAM endpoint/);
    expect(realAwsEndpointFor('SQS', 'us-gov-west-1')).toBe('https://sqs.us-gov-west-1.amazonaws.com');
  });
});

describe('a mixed-mode container keeping no exception reaches no real credential', () => {
  it('drops the --profile credentials file mount and the task-role URI; keeps them with an exception', async () => {
    const w = await wiring({ Fn: { AWS_ENDPOINT_URL_STS: 'real-aws' } });
    try {
      const credsMount = { hostPath: '/tmp/creds', containerPath: '/cdk-local-aws/credentials' };
      const base = {
        image: 'x',
        mounts: [],
        extraMounts: [credsMount],
      } as unknown as Parameters<typeof withWorkloadAwsWiring>[0];
      const none = await withWorkloadAwsWiring(
        {
          ...base,
          env: {
            ...REAL,
            AWS_REGION: 'us-east-1',
            AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/creds',
            AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
          },
        },
        w
      );
      expect(none.extraMounts!.some((m) => m.containerPath === credsMount.containerPath)).toBe(false);
      expect(none.env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI']).toBeUndefined();
      expect(none.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS']).toBe('false');
      expect(none.env['AWS_ACCESS_KEY_ID']).toBe(EMU_KEY.accessKeyId);

      const kept = await withWorkloadAwsWiring(
        {
          ...base,
          env: {
            ...REAL,
            AWS_REGION: 'us-east-1',
            AWS_ENDPOINT_URL_STS: 'real-aws',
            AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
          },
        },
        w
      );
      expect(kept.extraMounts!.some((m) => m.containerPath === credsMount.containerPath)).toBe(true);
      expect(kept.env['AWS_ACCESS_KEY_ID']).toBe('AKIAREAL');
      // The real identity must not meet an SDK told to ignore the endpoint variables.
      expect(kept.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS']).toBe('false');
    } finally {
      w.dispose();
    }
  });

  it('workloadGetsEmulatorKeysOnly: full mode always, mixed mode only without an exception', async () => {
    const forward = await resolveWorkloadAwsWiring({ env: {}, homeDir: home });
    expect(workloadGetsEmulatorKeysOnly({}, forward)).toBe(false);
    expect(workloadGetsEmulatorKeysOnly({}, undefined)).toBe(false);
    const full = await wiring(undefined, 9397);
    const mixed = await wiring({ Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' } }, 9398);
    try {
      expect(workloadGetsEmulatorKeysOnly({}, full)).toBe(true);
      expect(workloadGetsEmulatorKeysOnly({}, mixed)).toBe(true);
      expect(workloadGetsEmulatorKeysOnly({ AWS_ENDPOINT_URL_STS: 'real-aws' }, mixed)).toBe(false);
    } finally {
      full.dispose();
      mixed.dispose();
    }
  });

  it('ECS with a task role: only a container keeping an exception gets the real role, as env; others get the emulator keys and no role URI', async () => {
    const w = await wiring({ app: { AWS_ENDPOINT_URL_STS: 'real-aws' } });
    setActiveWorkloadAwsWiring(w);
    const role = { accessKeyId: 'ASIAROLE', secretAccessKey: 'role-secret', sessionToken: 'role-tok' };
    const container = (name: string) =>
      ({
        name,
        image: { kind: 'public', uri: 'busybox' },
        environment: { AWS_REGION: 'us-east-1' },
        sensitiveEnvKeys: [],
        secrets: [],
        portMappings: [],
        mountPoints: [],
        dependsOn: [],
        links: [],
        essential: true,
        ulimits: [],
        warnings: [],
      }) as never;
    const build = (name: string) =>
      buildDockerRunArgs({
        task: { family: 'fam' } as never,
        container: container(name),
        image: 'busybox',
        network: 'net',
        volumeByName: new Map(),
        secrets: [],
        envOverrides: { app: { AWS_ENDPOINT_URL_STS: 'real-aws' } },
        containerHost: '127.0.0.1',
        roleArn: 'arn:aws:iam::111111111111:role/task',
        platformOverride: undefined,
        region: 'us-east-1',
        mixedModeRoleCredentials: role,
      });
    const all = (r: ReturnType<typeof build>) => [
      ...r.args,
      ...Object.entries(r.sensitiveEnv).map(([k, v]) => `${k}=${v}`),
    ];
    const app = all(build('app'));
    expect(app).toContain('AWS_ACCESS_KEY_ID=ASIAROLE');
    expect(app).toContain('AWS_SESSION_TOKEN=role-tok');
    expect(app.some((a) => a.startsWith('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI='))).toBe(false);
    expect(app).toContain('AWS_ENDPOINT_URL_STS=https://sts.us-east-1.amazonaws.com');
    const worker = all(build('worker'));
    expect(worker).toContain(`AWS_ACCESS_KEY_ID=${EMU_KEY.accessKeyId}`);
    expect(worker.some((a) => a.includes('ASIAROLE') || a.includes('role-secret'))).toBe(false);
    expect(worker.some((a) => a.startsWith('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI='))).toBe(false);
    w.dispose();
  });

  it('the shared ECS metadata sidecar serves the emulator keys in mixed mode', async () => {
    const w = await wiring({ app: { AWS_ENDPOINT_URL_STS: 'real-aws' } }, 9393);
    setActiveWorkloadAwsWiring(w);
    expect(await resolveSharedSidecarCredentials({ profile: 'prod' })).toEqual(EMU_KEY);
    w.dispose();
  });

  it('forces AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=false in every --aws-emulator container', async () => {
    const full = await wiring(undefined, 9391);
    const mixed = await wiring({ Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' } }, 9392);
    try {
      for (const [w, env] of [
        [full, {}],
        [mixed, {}],
        [mixed, { AWS_ENDPOINT_URL_STS: 'real-aws' }],
      ] as const) {
        const out = applyWorkloadAwsWiringToEnv(
          { ...env, AWS_REGION: 'us-east-1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
          w
        );
        expect(out['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS']).toBe('false');
      }
    } finally {
      full.dispose();
      mixed.dispose();
    }
  });
});
