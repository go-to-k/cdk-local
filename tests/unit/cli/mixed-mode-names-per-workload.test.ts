/**
 * go-to-k/cdk-local#905 — AWS Emulator mixed mode in a command serving several
 * workloads (`start-api`, `run-task`, `start-service` / `start-alb`): each
 * function or container reads the names of ITS excepted services (`Parameters`
 * plus its own `--env-vars` section, marked `"real-aws"`) from real AWS, every
 * other name from the emulator. Workload A excepts DynamoDB in its own
 * section, B does not: B must get the EMULATOR table name.
 *
 * The state source is a host-registered provider (`--from-state`), built by
 * the real `createLocalStateProvider` dispatch: its factory resolves per
 * service for `behavior.workload`, as a host provider in mixed mode does.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';
import type { ResourceState } from '../../../src/types/state.js';

const { stsSendMock } = vi.hoisted(() => ({ stsSendMock: vi.fn() }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSendMock;
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
}));

const { setAwsEmulatorServiceRouting, awsEmulatorRealServices } = await import(
  '../../../src/utils/aws-proxy.js'
);
const { createMixedModeStateProvider } = await import(
  '../../../src/local/aws-emulator-mixed-mode.js'
);
const { groupWorkloadsRoutedApart, UNNAMED_WORKLOAD } = await import(
  '../../../src/cli/commands/local-state-source.js'
);
const { loadStateForRoutedStacks, buildContainerSpec } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { buildEcsImageResolutionContext: buildRunTaskContext } = await import(
  '../../../src/cli/commands/local-run-task.js'
);
const { buildEcsImageResolutionContext: buildServiceContext, createTargetStateProviders } =
  await import('../../../src/cli/commands/ecs-service-emulator.js');
const { resolveEcsTaskTarget, applyCrossStackValuesToTask } = await import(
  '../../../src/local/ecs-task-resolver.js'
);
const { resolveEcsServiceTarget } = await import('../../../src/local/ecs-service-resolver.js');

const EMU = 'https://127.0.0.1:9397';
const REAL_TABLE = 'real-orders';
const EMU_TABLE = 'emu-orders';

function stateRecord(table: string): {
  resources: Record<string, ResourceState>;
  outputs: Record<string, string>;
  region: string;
} {
  return {
    resources: {
      Orders: { physicalId: table, resourceType: 'AWS::DynamoDB::Table', attributes: {} },
    } as unknown as Record<string, ResourceState>,
    outputs: {},
    region: 'us-east-1',
  };
}

let realStackMissing = false;
let emulatorStackMissing = false;

function fakeProvider(table: string): LocalStateProvider {
  return {
    label: table,
    load: async () =>
      (table === REAL_TABLE && realStackMissing) || (table === EMU_TABLE && emulatorStackMissing)
        ? undefined
        : stateRecord(table),
    buildCrossStackResolver: async () => undefined,
    // A SecureString template parameter, decrypted on the side this provider reads.
    resolveTemplateSsmParameters: async () => ({
      values: { DbPassword: `${table}-pw` },
      secureStringLogicalIds: ['DbPassword'],
    }),
    dispose: () => {},
  };
}

/** The host factory: per service, for the workload it is asked for. */
const workloads: Array<unknown> = [];
const extraStateProviders = {
  fromState: (_opts: unknown, behavior: { workload?: unknown }): LocalStateProvider => {
    workloads.push(behavior.workload);
    const realServices = awsEmulatorRealServices(
      behavior.workload as Parameters<typeof awsEmulatorRealServices>[0]
    );
    // A workload with no exception reads every name from the emulator.
    if (!realServices || realServices.length === 0) return fakeProvider(EMU_TABLE);
    return createMixedModeStateProvider({
      emulator: fakeProvider(EMU_TABLE),
      real: fakeProvider(REAL_TABLE),
      realServices,
    });
  },
};

function route(envOverrides: Record<string, unknown>): void {
  setAwsEmulatorServiceRouting({
    realServices: [],
    override: { endpoint: EMU, credentials: { accessKeyId: 'EMU', secretAccessKey: 'e' } },
    envOverrides,
  });
}

const A_EXCEPTS_DYNAMODB = { A: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } };

beforeEach(() => {
  stsSendMock.mockReset();
  stsSendMock.mockResolvedValue({ Account: '111111111111' });
});

afterEach(() => {
  setAwsEmulatorServiceRouting(undefined);
  workloads.length = 0;
  realStackMissing = false;
  emulatorStackMissing = false;
});

describe('groupWorkloadsRoutedApart', () => {
  it('returns the workloads whose own section changes the excepted set, grouped by it', () => {
    route({
      Parameters: { AWS_ENDPOINT_URL_SQS: 'real-aws' },
      A: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
      C: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
      D: { AWS_ENDPOINT_URL_SQS: null },
    });
    const groups = groupWorkloadsRoutedApart(['A', 'B', 'C', 'D'], (containerName) => ({
      containerName,
    }));
    expect(groups.map((g) => [g.realServices, g.items])).toEqual([
      [['DYNAMODB', 'SQS'], ['A', 'C']],
      [[], ['D']],
    ]);
  });

  it('returns nothing outside mixed mode, or with only Parameters exceptions', () => {
    expect(groupWorkloadsRoutedApart(['A'], (containerName) => ({ containerName }))).toEqual([]);
    route({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } });
    expect(groupWorkloadsRoutedApart(['A'], (containerName) => ({ containerName }))).toEqual([]);
    expect(awsEmulatorRealServices(UNNAMED_WORKLOAD)).toEqual(['DYNAMODB']);
  });
});

describe('start-api — names per function', () => {
  const fn = (name: string): Record<string, unknown> => ({
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { ZipFile: 'exports.handler = () => {};' },
      Environment: { Variables: { TABLE: { Ref: 'Orders' } } },
    },
    Metadata: { 'aws:cdk:path': `S/${name}/Resource` },
  });
  const stack = {
    stackName: 'S',
    region: 'us-east-1',
    template: {
      Resources: { A: fn('A'), B: fn('B'), Orders: { Type: 'AWS::DynamoDB::Table' } },
    },
  } as unknown as StackInfo;
  const routeTo = (lambdaLogicalId: string): DiscoveredRoute =>
    ({
      method: 'GET',
      pathPattern: `/${lambdaLogicalId}`,
      lambdaLogicalId,
      source: 'http-api',
      apiVersion: 'v2',
      stage: '$default',
      unsupported: false,
      mockCors: false,
      serviceIntegration: false,
    }) as unknown as DiscoveredRoute;

  const envOf = async (
    envOverrides: Record<string, unknown>,
    logicalId: string,
    opts: { webSocketB?: boolean } = {}
  ): Promise<Record<string, string>> => {
    route(envOverrides);
    const stateByStack = await loadStateForRoutedStacks(
      [stack],
      opts.webSocketB ? [routeTo('A')] : [routeTo('A'), routeTo('B')],
      [],
      { fromState: true } as never,
      extraStateProviders,
      opts.webSocketB
        ? ([{ routes: [{ targetLambdaLogicalId: 'B' }] }] as unknown as Parameters<
            typeof loadStateForRoutedStacks
          >[5])
        : []
    );
    const inlineTmpDirs = new Set<string>();
    try {
      const spec = await buildContainerSpec({
        logicalId,
        stacks: [stack],
        overrides: undefined,
        assumeRole: undefined,
        containerHost: '127.0.0.1',
        stsRegion: undefined,
        inlineTmpDirs,
        layerTmpDirs: new Set(),
        stateByStack,
        skipPull: true,
      });
      return spec.env;
    } finally {
      for (const d of inlineTmpDirs) rmSync(d, { recursive: true, force: true });
    }
  };

  it('A (excepted in its own section) reads the REAL name, B the emulator one', async () => {
    expect((await envOf(A_EXCEPTS_DYNAMODB, 'A'))['TABLE']).toBe(REAL_TABLE);
    expect((await envOf(A_EXCEPTS_DYNAMODB, 'B'))['TABLE']).toBe(EMU_TABLE);
  });

  it('a WebSocket route Lambda reads its own names too', async () => {
    const bExcepts = { B: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } };
    expect((await envOf(bExcepts, 'B', { webSocketB: true }))['TABLE']).toBe(REAL_TABLE);
    expect((await envOf(bExcepts, 'A', { webSocketB: true }))['TABLE']).toBe(EMU_TABLE);
  });

  it('a stack only the emulator has: A (excepted) keeps the emulator name, B reads it too', async () => {
    realStackMissing = true;
    expect((await envOf(A_EXCEPTS_DYNAMODB, 'A'))['TABLE']).toBe(EMU_TABLE);
    expect((await envOf(A_EXCEPTS_DYNAMODB, 'B'))['TABLE']).toBe(EMU_TABLE);
  });

  it('a stack only real AWS has: A reads the real name, B none', async () => {
    emulatorStackMissing = true;
    expect((await envOf(A_EXCEPTS_DYNAMODB, 'A'))['TABLE']).toBe(REAL_TABLE);
    expect((await envOf(A_EXCEPTS_DYNAMODB, 'B'))['TABLE']).toBeUndefined();
  });

  it('a section by CDK path excepts the function too', async () => {
    const byPath = { 'S/A': { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } };
    expect((await envOf(byPath, 'A'))['TABLE']).toBe(REAL_TABLE);
    expect((await envOf(byPath, 'B'))['TABLE']).toBe(EMU_TABLE);
  });

  it('Parameters exceptions alone: every function reads the real name, one provider', async () => {
    const params = { Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } };
    expect((await envOf(params, 'A'))['TABLE']).toBe(REAL_TABLE);
    expect((await envOf(params, 'B'))['TABLE']).toBe(REAL_TABLE);
    expect(workloads).toEqual([UNNAMED_WORKLOAD, UNNAMED_WORKLOAD]);
  });
});

describe('ECS — names per container', () => {
  const taskStack = (): StackInfo =>
    ({
      stackName: 'S',
      region: 'us-east-1',
      template: {
        Resources: {
          Orders: { Type: 'AWS::DynamoDB::Table' },
          TaskDef: {
            Type: 'AWS::ECS::TaskDefinition',
            Properties: {
              ContainerDefinitions: ['A', 'B'].map((name) => ({
                Name: name,
                Essential: name === 'A',
                Image: 'public.ecr.aws/docker/library/busybox:latest',
                Environment: [
                  { Name: 'TABLE', Value: { Ref: 'Orders' } },
                  {
                    Name: 'MIXED',
                    // An export named after a same-stack resource.
                    Value: { 'Fn::ImportValue': { 'Fn::Sub': '${Orders}-arn' } },
                  },
                ],
              })),
            },
          },
          Service: {
            Type: 'AWS::ECS::Service',
            Properties: { TaskDefinition: { Ref: 'TaskDef' }, DesiredCount: 1 },
          },
        },
      },
    }) as unknown as StackInfo;

  const envByContainer = (containers: Array<{ name: string; environment: Record<string, string> }>) =>
    Object.fromEntries(containers.map((c) => [c.name, c.environment['TABLE']]));

  it('run-task: A reads the REAL name, B the emulator one', async () => {
    route(A_EXCEPTS_DYNAMODB);
    const stack = taskStack();
    const { stateProvider, stateProviderFor } = await createTargetStateProviders(
      'S:TaskDef',
      [stack],
      { fromState: true } as never,
      extraStateProviders as never
    );
    const ctx = await buildRunTaskContext(stack, stateProvider, {} as never, stateProviderFor);
    const task = resolveEcsTaskTarget('S:TaskDef', [stack], ctx);
    expect(envByContainer(task.containers)).toEqual({ A: REAL_TABLE, B: EMU_TABLE });
  });

  it('start-service: A reads the REAL name, B the emulator one', async () => {
    route(A_EXCEPTS_DYNAMODB);
    const stack = taskStack();
    const { stateProvider, stateProviderFor } = await createTargetStateProviders(
      'S:Service',
      [stack],
      { fromState: true } as never,
      extraStateProviders as never
    );
    const ctx = await buildServiceContext('S:Service', [stack], {} as never, stateProvider, {
      stateProviderFor,
    });
    const service = resolveEcsServiceTarget('S:Service', [stack], ctx);
    expect(envByContainer(service.task.containers)).toEqual({ A: REAL_TABLE, B: EMU_TABLE });
  });

  it('the cross-stack post-pass resolves same-stack names per container too', async () => {
    route(A_EXCEPTS_DYNAMODB);
    const stack = taskStack();
    const { stateProvider, stateProviderFor } = await createTargetStateProviders(
      'S:TaskDef',
      [stack],
      { fromState: true } as never,
      extraStateProviders as never
    );
    const ctx = await buildRunTaskContext(stack, stateProvider, {} as never, stateProviderFor);
    const task = resolveEcsTaskTarget('S:TaskDef', [stack], ctx);
    await applyCrossStackValuesToTask(
      task,
      {
        resolveImport: async (exportName: string) => `value-of-${exportName}`,
        resolveGetStackOutput: async () => undefined,
      },
      { imageContext: ctx, consumerRegion: 'us-east-1' }
    );
    // The export name embeds a same-stack name of the consuming container.
    expect(Object.fromEntries(task.containers.map((c) => [c.name, c.environment['MIXED']]))).toEqual(
      { A: `value-of-${REAL_TABLE}-arn`, B: `value-of-${EMU_TABLE}-arn` }
    );
  });

  it('a SecureString parameter stays off argv for each container, from its own side', async () => {
    route({ A: { AWS_ENDPOINT_URL_SSM: 'real-aws' } });
    const stack = taskStack();
    const tpl = stack.template as { Parameters?: Record<string, unknown>; Resources: Record<string, any> };
    tpl.Parameters = { DbPassword: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/db/pw' } };
    for (const def of tpl.Resources['TaskDef'].Properties.ContainerDefinitions) {
      def.Environment.push({ Name: 'PW', Value: { Ref: 'DbPassword' } });
    }
    const ssmAware = {
      fromState: (_o: unknown, behavior: { workload?: unknown }): LocalStateProvider => {
        const realServices = awsEmulatorRealServices(
          behavior.workload as Parameters<typeof awsEmulatorRealServices>[0]
        );
        return fakeProvider(realServices?.includes('SSM') ? REAL_TABLE : EMU_TABLE);
      },
    };
    const { stateProvider, stateProviderFor } = await createTargetStateProviders(
      'S:TaskDef',
      [stack],
      { fromState: true } as never,
      ssmAware as never
    );
    const ctx = await buildRunTaskContext(stack, stateProvider, {} as never, stateProviderFor);
    const task = resolveEcsTaskTarget('S:TaskDef', [stack], ctx);
    const byName = Object.fromEntries(task.containers.map((c) => [c.name, c]));
    expect(byName['A']!.environment['PW']).toBe(`${REAL_TABLE}-pw`);
    expect(byName['B']!.environment['PW']).toBe(`${EMU_TABLE}-pw`);
    expect(byName['A']!.sensitiveEnvKeys).toContain('PW');
    expect(byName['B']!.sensitiveEnvKeys).toContain('PW');
  });

  it('no section exception: every container shares one Parameters-only provider (unchanged)', async () => {
    route({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } });
    const stack = taskStack();
    const { stateProvider, stateProviderFor } = await createTargetStateProviders(
      'S:TaskDef',
      [stack],
      { fromState: true } as never,
      extraStateProviders as never
    );
    const ctx = await buildRunTaskContext(stack, stateProvider, {} as never, stateProviderFor);
    expect(ctx?.containerStates).toBeUndefined();
    const task = resolveEcsTaskTarget('S:TaskDef', [stack], ctx);
    expect(envByContainer(task.containers)).toEqual({ A: REAL_TABLE, B: REAL_TABLE });
    expect(workloads).toEqual([UNNAMED_WORKLOAD]);
  });
});
