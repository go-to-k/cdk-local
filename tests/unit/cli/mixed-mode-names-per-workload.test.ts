/**
 * go-to-k/cdk-local#905 — AWS Emulator mixed mode in a command serving several
 * workloads (`start-api`, `run-task`, `start-service` / `start-alb`): each
 * function or container reads the names of ITS routed services (`Parameters`
 * plus its own `--env-vars` section) from the emulator, every other name from
 * real AWS. Workload A routes DynamoDB in its own section, B does not: B must
 * get the REAL table name.
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

const { setAwsEmulatorServiceRouting, awsEmulatorRoutedServices } = await import(
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

function fakeProvider(table: string): LocalStateProvider {
  return {
    label: table,
    load: async () => stateRecord(table),
    buildCrossStackResolver: async () => undefined,
    dispose: () => {},
  };
}

/** The host factory: per service, for the workload it is asked for. */
const workloads: Array<unknown> = [];
const extraStateProviders = {
  fromState: (_opts: unknown, behavior: { workload?: unknown }): LocalStateProvider => {
    workloads.push(behavior.workload);
    const services = awsEmulatorRoutedServices(
      behavior.workload as Parameters<typeof awsEmulatorRoutedServices>[0]
    );
    if (!services || services.length === 0) return fakeProvider(REAL_TABLE);
    return createMixedModeStateProvider({
      real: fakeProvider(REAL_TABLE),
      emulator: fakeProvider(EMU_TABLE),
      emulatedServices: services,
    });
  },
};

function route(envOverrides: Record<string, unknown>): void {
  setAwsEmulatorServiceRouting({
    services: ['DYNAMODB'],
    override: { endpoint: EMU, credentials: { accessKeyId: 'EMU', secretAccessKey: 'e' } },
    envOverrides,
  });
}

const A_ROUTES_DYNAMODB = { A: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } };

beforeEach(() => {
  stsSendMock.mockReset();
  stsSendMock.mockResolvedValue({ Account: '111111111111' });
});

afterEach(() => {
  setAwsEmulatorServiceRouting(undefined);
  workloads.length = 0;
});

describe('groupWorkloadsRoutedApart', () => {
  it('returns the workloads whose own section changes the routed set, grouped by it', () => {
    route({
      Parameters: { AWS_ENDPOINT_URL_SQS: 'aws-emulator' },
      A: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' },
      C: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' },
      D: { AWS_ENDPOINT_URL_SQS: null },
    });
    const groups = groupWorkloadsRoutedApart(['A', 'B', 'C', 'D'], (containerName) => ({
      containerName,
    }));
    expect(groups.map((g) => [g.services, g.items])).toEqual([
      [['DYNAMODB', 'SQS'], ['A', 'C']],
      [[], ['D']],
    ]);
  });

  it('returns nothing outside mixed mode, or with only Parameters sentinels', () => {
    expect(groupWorkloadsRoutedApart(['A'], (containerName) => ({ containerName }))).toEqual([]);
    route({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } });
    expect(groupWorkloadsRoutedApart(['A'], (containerName) => ({ containerName }))).toEqual([]);
    expect(awsEmulatorRoutedServices(UNNAMED_WORKLOAD)).toEqual(['DYNAMODB']);
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
    logicalId: string
  ): Promise<Record<string, string>> => {
    route(envOverrides);
    const stateByStack = await loadStateForRoutedStacks(
      [stack],
      [routeTo('A'), routeTo('B')],
      [],
      { fromState: true } as never,
      extraStateProviders
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

  it('A (routed in its own section) reads the emulator name, B the REAL one', async () => {
    expect((await envOf(A_ROUTES_DYNAMODB, 'A'))['TABLE']).toBe(EMU_TABLE);
    expect((await envOf(A_ROUTES_DYNAMODB, 'B'))['TABLE']).toBe(REAL_TABLE);
  });

  it('a section by CDK path routes the function too', async () => {
    const byPath = { 'S/A': { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } };
    expect((await envOf(byPath, 'A'))['TABLE']).toBe(EMU_TABLE);
    expect((await envOf(byPath, 'B'))['TABLE']).toBe(REAL_TABLE);
  });

  it('Parameters sentinels alone: every function reads the emulator name, one provider', async () => {
    const params = { Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } };
    expect((await envOf(params, 'A'))['TABLE']).toBe(EMU_TABLE);
    expect((await envOf(params, 'B'))['TABLE']).toBe(EMU_TABLE);
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

  it('run-task: A reads the emulator name, B the REAL one', async () => {
    route(A_ROUTES_DYNAMODB);
    const stack = taskStack();
    const { stateProvider, stateProviderFor } = await createTargetStateProviders(
      'S:TaskDef',
      [stack],
      { fromState: true } as never,
      extraStateProviders as never
    );
    const ctx = await buildRunTaskContext(stack, stateProvider, {} as never, stateProviderFor);
    const task = resolveEcsTaskTarget('S:TaskDef', [stack], ctx);
    expect(envByContainer(task.containers)).toEqual({ A: EMU_TABLE, B: REAL_TABLE });
  });

  it('start-service: A reads the emulator name, B the REAL one', async () => {
    route(A_ROUTES_DYNAMODB);
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
    expect(envByContainer(service.task.containers)).toEqual({ A: EMU_TABLE, B: REAL_TABLE });
  });

  it('the cross-stack post-pass resolves same-stack names per container too', async () => {
    route(A_ROUTES_DYNAMODB);
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
      { A: `value-of-${EMU_TABLE}-arn`, B: `value-of-${REAL_TABLE}-arn` }
    );
  });

  it('no section sentinel: every container shares one Parameters-only provider (unchanged)', async () => {
    route({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } });
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
    expect(envByContainer(task.containers)).toEqual({ A: EMU_TABLE, B: EMU_TABLE });
    expect(workloads).toEqual([UNNAMED_WORKLOAD]);
  });
});
