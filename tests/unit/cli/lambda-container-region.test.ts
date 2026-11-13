/**
 * go-to-k/cdk-local#926: the region a Lambda-shaped container gets, on both
 * credential arms, for every env builder -- `cdkl invoke`'s
 * `resolveLambdaContainerEnv` (also `start-cloudfront` / `start-alb` Lambda
 * targets, `start-microvm`, `start-web-function`), `start-api`'s
 * `buildContainerSpec`, and `invoke-agentcore` / `start-agentcore`'s
 * `buildContainerEnv`. Before: the default profile's region never reached the
 * container without `--profile`, a shell `AWS_REGION` outranked `--region`
 * off the `--assume-role` arm, and the state record's region was no source.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const sts = vi.hoisted(() => ({
  profileRegion: undefined as string | undefined,
  assumeRegions: [] as (string | undefined)[],
  stateRegion: undefined as string | undefined,
}));

// The SDK's region provider is the profile / `~/.aws/config` region; an
// `AssumeRole` records the region its STS client was built for.
vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  STSClient: class {
    region: string | undefined;
    config: { region: () => Promise<string | undefined> };
    constructor(cfg: { region?: string }) {
      this.region = cfg.region;
      this.config = {
        region: async () => {
          if (sts.profileRegion === undefined) throw new Error('Region is missing');
          return sts.profileRegion;
        },
      };
    }
    async send(): Promise<unknown> {
      sts.assumeRegions.push(this.region);
      return {
        Account: '123456789012',
        Credentials: { AccessKeyId: 'AKIAT', SecretAccessKey: 's', SessionToken: 't' },
      };
    }
    destroy(): void {}
  },
}));

// `cdkl invoke`'s state source: a record loaded from `sts.stateRegion`.
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: vi.fn().mockImplementation(() =>
    sts.stateRegion === undefined
      ? undefined
      : {
          label: '--from-state',
          load: vi.fn(async () => ({ resources: {}, outputs: {}, region: sts.stateRegion })),
          buildCrossStackResolver: vi.fn(async () => undefined),
          dispose: vi.fn(),
        }
  ),
}));

const { resolveLambdaContainerEnv } = await import('../../../src/cli/commands/local-invoke.js');
const { buildContainerSpec } = await import('../../../src/cli/commands/local-start-api.js');
const { buildContainerEnv } = await import('../../../src/cli/commands/local-invoke-agentcore.js');

const ROLE = 'arn:aws:iam::123456789012:role/Exec';

interface Case {
  /** `--region` */
  region?: string;
  /** The stack's own `env.region` (undefined: env-agnostic). */
  stackRegion?: string;
  /** The loaded state record's region (undefined: no state source). */
  stateRegion?: string;
  assumeRole?: boolean;
}

function lambdaStack(stackRegion: string | undefined): StackInfo {
  return {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    dependencyNames: [],
    ...(stackRegion !== undefined && { region: stackRegion }),
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Code: { ZipFile: 'exports.handler = () => {};' },
          },
        },
      },
    },
  } as unknown as StackInfo;
}

const inlineTmpDirs = new Set<string>();

const builders: Record<string, (c: Case) => Promise<Record<string, string>>> = {
  'cdkl invoke (resolveLambdaContainerEnv)': async (c) => {
    sts.stateRegion = c.stateRegion;
    const stack = lambdaStack(c.stackRegion);
    const lambda = {
      kind: 'zip',
      stack,
      logicalId: 'Fn',
      resource: stack.template.Resources!['Fn'],
      memoryMb: 128,
      timeoutSec: 3,
      layers: [],
      runtime: 'nodejs20.x',
      handler: 'index.handler',
      codePath: '/tmp/code',
    } as unknown as ResolvedLambda;
    const result = await resolveLambdaContainerEnv(
      lambda,
      {
        ...(c.region !== undefined && { region: c.region }),
        ...(c.assumeRole && { assumeRole: ROLE }),
      },
      undefined
    );
    return result.env;
  },
  'cdkl start-api (buildContainerSpec)': async (c) => {
    const stateByStack = new Map();
    if (c.stateRegion !== undefined) {
      stateByStack.set('S', { region: c.stateRegion, state: { resources: {} } });
    }
    const spec = await buildContainerSpec({
      logicalId: 'Fn',
      stacks: [lambdaStack(c.stackRegion)],
      overrides: undefined,
      assumeRole: c.assumeRole ? { globalArn: ROLE, perLambda: {} } : undefined,
      containerHost: '127.0.0.1',
      // The command passes `--region`, then the host variables.
      stsRegion: c.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'],
      inlineTmpDirs,
      layerTmpDirs: new Set(),
      stateByStack,
      skipPull: true,
    } as never);
    return spec.env;
  },
  'cdkl invoke-agentcore (buildContainerEnv)': async (c) => {
    const runtime = {
      stack: { stackName: 'S', ...(c.stackRegion !== undefined && { region: c.stackRegion }) },
      logicalId: 'Agent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      containerUri: 'repo:tag',
      environmentVariables: {},
      protocol: 'HTTP',
    } as unknown as ResolvedAgentCoreRuntime;
    const out = await buildContainerEnv(
      runtime,
      {
        platform: 'linux/arm64',
        pull: true,
        build: true,
        ...(c.region !== undefined && { region: c.region }),
        ...(c.assumeRole && { assumeRole: ROLE }),
      } as never,
      undefined,
      undefined,
      undefined,
      c.stateRegion === undefined
        ? undefined
        : ({ resources: {}, outputs: {}, region: c.stateRegion } as never),
      undefined
    );
    return out.env;
  },
};

const KEYS = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE'] as const;

describe.each(Object.entries(builders))('%s: container region (#926)', (_name, build) => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    sts.profileRegion = undefined;
    sts.assumeRegions = [];
    sts.stateRegion = undefined;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of inlineTmpDirs) rmSync(d, { recursive: true, force: true });
    inlineTmpDirs.clear();
  });

  const regionOf = (env: Record<string, string>) => [env['AWS_REGION'], env['AWS_DEFAULT_REGION']];

  it("the default profile's ~/.aws/config region, with no --profile and an env-agnostic stack", async () => {
    sts.profileRegion = 'us-east-1';
    expect(regionOf(await build({}))).toEqual(['us-east-1', 'us-east-1']);
  });

  it('--region outranks a shell AWS_REGION / AWS_DEFAULT_REGION', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    process.env['AWS_DEFAULT_REGION'] = 'eu-central-1';
    expect(regionOf(await build({ region: 'ap-northeast-1' }))).toEqual([
      'ap-northeast-1',
      'ap-northeast-1',
    ]);
  });

  it('--region outranks a shell AWS_REGION on the --assume-role arm, and is the STS region', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    const env = await build({ region: 'ap-northeast-1', assumeRole: true });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAT');
    expect(regionOf(env)).toEqual(['ap-northeast-1', 'ap-northeast-1']);
    expect(sts.assumeRegions).toContain('ap-northeast-1');
  });

  it('the shell AWS_REGION names AWS_DEFAULT_REGION too', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    process.env['AWS_DEFAULT_REGION'] = 'eu-central-1';
    expect(regionOf(await build({}))).toEqual(['eu-west-1', 'eu-west-1']);
  });

  it("the state record's region sits above the profile's, the stack's own above both", async () => {
    sts.profileRegion = 'us-east-1';
    expect(regionOf(await build({ stateRegion: 'sa-east-1' }))).toEqual([
      'sa-east-1',
      'sa-east-1',
    ]);
    expect(regionOf(await build({ stateRegion: 'sa-east-1', stackRegion: 'us-west-2' }))).toEqual(
      ['us-west-2', 'us-west-2']
    );
  });

  it('the stack region is the STS region on the --assume-role arm too', async () => {
    const env = await build({ stackRegion: 'us-west-2', assumeRole: true });
    expect(regionOf(env)).toEqual(['us-west-2', 'us-west-2']);
    expect(sts.assumeRegions).toContain('us-west-2');
  });

  it('no region anywhere leaves the container region-less', async () => {
    expect(regionOf(await build({}))).toEqual([undefined, undefined]);
  });
});
