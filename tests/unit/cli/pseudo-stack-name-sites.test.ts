/**
 * go-to-k/cdk-local#979: `Ref: AWS::StackName` (and `${AWS::StackName}` inside
 * `Fn::Sub`) resolves, under a state source, to the DEPLOYED name of the stack
 * that owns the value -- the name the state source read. Every builder of a
 * pseudo-parameter bag that feeds state substitution is driven here with the
 * bare `--from-cfn-stack` (the synthesized physical name) and an explicit
 * `--from-cfn-stack <name>` (that name), so a builder that drops the field, or
 * fills it with the synthesized name regardless of the flag, goes red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

const hoisted = vi.hoisted(() => ({ provider: undefined as unknown }));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = async () => ({ Account: '123456789012' });
    destroy = () => {};
  },
  GetCallerIdentityCommand: class {},
}));

vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: vi.fn(() => hoisted.provider),
  resolveCfnFallbackRegion: vi.fn(async () => 'us-east-1'),
}));

const runTask = await import('../../../src/cli/commands/local-run-task.js');
const service = await import('../../../src/cli/commands/ecs-service-emulator.js');
const agentcore = await import('../../../src/cli/commands/local-invoke-agentcore.js');
const invoke = await import('../../../src/cli/commands/local-invoke.js');
const startApi = await import('../../../src/cli/commands/local-start-api.js');

/** The synthesized physical stack name; distinct from every explicit name below. */
const PHYSICAL = 'MyStack';
const EXPLICIT = 'DeployedUnderAnotherName';

const ARMS = [
  { name: 'bare --from-cfn-stack', fromCfnStack: true as const, expected: PHYSICAL },
  { name: 'explicit --from-cfn-stack <name>', fromCfnStack: EXPLICIT, expected: EXPLICIT },
];

const ENV = {
  STACK: { Ref: 'AWS::StackName' },
  SUBBED: { 'Fn::Sub': 'prefix-${AWS::StackName}-suffix' },
};

function provider(): LocalStateProvider {
  return {
    label: '--from-cfn-stack',
    load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
    buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
    resolveTemplateSsmParameters: vi
      .fn()
      .mockResolvedValue({ values: {}, secureStringLogicalIds: [] }),
    dispose: vi.fn(),
  } as unknown as LocalStateProvider;
}

function ecsStack(): StackInfo {
  return {
    stackName: PHYSICAL,
    region: 'us-east-1',
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              { Name: 'app', Environment: [{ Name: 'STACK', Value: ENV.STACK }] },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

function lambdaStack(): StackInfo {
  return {
    stackName: PHYSICAL,
    displayName: PHYSICAL,
    artifactId: PHYSICAL,
    region: 'us-east-1',
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Code: { ZipFile: 'exports.handler = () => {};' },
            Environment: { Variables: ENV },
          },
        },
      },
    },
  } as unknown as StackInfo;
}

const ENV_KEYS = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE'] as const;

describe.each(ARMS)('AWS::StackName under $name (#979)', ({ fromCfnStack, expected }) => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    hoisted.provider = provider();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('cdkl invoke resolves the env var (resolveLambdaContainerEnv)', async () => {
    const stack = lambdaStack();
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
    const { env } = await invoke.resolveLambdaContainerEnv(
      lambda,
      { fromCfnStack, region: 'us-east-1', deployedFunctionLookups: false } as never,
      undefined
    );
    expect(env['STACK']).toBe(expected);
    expect(env['SUBBED']).toBe(`prefix-${expected}-suffix`);
  });

  it('cdkl start-api loads the bag with it (loadStateForRoutedStacks)', async () => {
    const route = {
      method: 'GET',
      pathPattern: '/x',
      lambdaLogicalId: 'Fn',
      source: 'http-api',
      apiVersion: 'v2',
      stage: '$default',
      unsupported: false,
      mockCors: false,
      serviceIntegration: false,
    } as unknown as DiscoveredRoute;
    const out = await startApi.loadStateForRoutedStacks(
      [lambdaStack()],
      [route],
      [],
      { fromCfnStack, region: 'us-east-1' } as never,
      undefined
    );
    expect(out.get(PHYSICAL)?.pseudoParameters?.stackName).toBe(expected);
  });

  it('cdkl run-task (buildEcsImageResolutionContext)', async () => {
    const ctx = await runTask.buildEcsImageResolutionContext(ecsStack(), provider(), {
      fromCfnStack,
      region: 'us-east-1',
    } as never);
    expect(ctx?.pseudoParameters?.stackName).toBe(expected);
  });

  it('cdkl start-service / start-alb (buildEcsImageResolutionContext)', async () => {
    const ctx = await service.buildEcsImageResolutionContext(
      `${PHYSICAL}/TaskDef`,
      [ecsStack()],
      { fromCfnStack, region: 'us-east-1' } as never,
      provider()
    );
    expect(ctx?.pseudoParameters?.stackName).toBe(expected);
  });

  it('cdkl invoke-agentcore (buildAgentCoreImageContext)', async () => {
    const { context } = await agentcore.buildAgentCoreImageContext(
      { stackName: PHYSICAL, template: { Resources: {} }, region: 'us-east-1' } as never,
      provider(),
      { fromCfnStack, region: 'us-east-1' } as never
    );
    expect(context?.pseudoParameters?.stackName).toBe(expected);
  });

  const runtime = (): ResolvedAgentCoreRuntime =>
    ({
      stack: { stackName: PHYSICAL, region: 'us-east-1' },
      logicalId: 'Agent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      containerUri: 'repo:tag',
      environmentVariables: ENV,
      protocol: 'HTTP',
    }) as unknown as ResolvedAgentCoreRuntime;

  it('cdkl invoke-agentcore env without an image context (buildContainerEnv)', async () => {
    const { env } = await agentcore.buildContainerEnv(
      runtime(),
      { fromCfnStack, platform: 'linux/arm64', pull: true, build: true } as never,
      undefined,
      undefined,
      provider(),
      { resources: {}, outputs: {}, region: 'us-east-1' } as never,
      undefined
    );
    expect(env['STACK']).toBe(expected);
    expect(env['SUBBED']).toBe(`prefix-${expected}-suffix`);
  });

  it('cdkl invoke-agentcore fromS3 bucket without an image context (resolveFromS3BucketIntrinsic)', async () => {
    const r = {
      ...runtime(),
      codeArtifact: {
        runtime: 'PYTHON_3_12',
        entryPoint: ['app.py'],
        codeAssetHash: 'agent',
        s3Source: { bucketIntrinsic: { 'Fn::Sub': '${AWS::StackName}-bundles' }, key: 'a.zip' },
      },
    } as unknown as ResolvedAgentCoreRuntime;
    await agentcore.resolveFromS3BucketIntrinsic(
      r,
      provider(),
      { resources: {}, outputs: {}, region: 'us-east-1' } as never,
      undefined,
      { fromCfnStack }
    );
    expect(r.codeArtifact?.s3Source?.bucket).toBe(`${expected}-bundles`);
  });
});
