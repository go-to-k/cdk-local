/**
 * go-to-k/cdk-local#963 — the command-body `consumerRegion` sites in
 * `cdkl run-task` and `cdkl start-service`: the region the cross-stack
 * resolver (`Fn::ImportValue` / `Fn::GetStackOutput` in container env) reads
 * the producer's outputs in. A host's ambient default region
 * (`setAmbientDefaultRegion`) must rank below the stack's `env.region`, and
 * the host `AWS_REGION` must still win without one. The other chains are in
 * `ambient-default-region-sites.test.ts`.
 *
 * REAL: target resolution, the cross-stack need detection. MOCKED: docker,
 * synth, the state provider (`buildCrossStackResolver` is the capture point),
 * STS, the shared network and the runners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setAmbientDefaultRegion } from '../../../src/utils/ambient-default-region.js';

const { buildCrossStackResolverMock, startEcsServiceMock, runEcsTaskMock, stackRegion } =
  vi.hoisted(() => ({
    buildCrossStackResolverMock: vi.fn(),
    startEcsServiceMock: vi.fn(),
    runEcsTaskMock: vi.fn(),
    stackRegion: { value: undefined as string | undefined },
  }));

/** Thrown by the mocked service runner so the command stops after the capture. */
class CapturedError extends Error {}

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/local/docker-version.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveHostGatewayExtraHosts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/utils/role-arn.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyRoleArnIfSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveApp: vi.fn().mockReturnValue('node app.js'),
}));
vi.mock('../../../src/local/workload-aws-wiring.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveHostDefaultCredentials: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  STSClient: class {
    config = { region: async () => 'ap-east-1' };
    send = vi.fn().mockResolvedValue({ Account: '111111111111' });
    destroy(): void {}
  },
}));

function stacks(): unknown[] {
  return [
    {
      stackName: 'S',
      displayName: 'S',
      artifactId: 'S',
      dependencyNames: [],
      ...(stackRegion.value !== undefined && { region: stackRegion.value }),
      template: {
        Resources: {
          TD: {
            Type: 'AWS::ECS::TaskDefinition',
            Properties: {
              Family: 'fam',
              ContainerDefinitions: [
                {
                  Name: 'app',
                  Image: 'nginx',
                  Essential: true,
                  Environment: [{ Name: 'SHARED', Value: { 'Fn::ImportValue': 'SharedName' } }],
                },
              ],
            },
            Metadata: { 'aws:cdk:path': 'S/TD/Resource' },
          },
          Svc: {
            Type: 'AWS::ECS::Service',
            Properties: { TaskDefinition: { Ref: 'TD' }, DesiredCount: 1 },
            Metadata: { 'aws:cdk:path': 'S/Svc/Service' },
          },
        },
      },
    },
  ];
}

vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(async () => ({ stacks: stacks() })),
  })),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: vi.fn().mockImplementation(() => ({
    label: '--from-state',
    load: vi.fn().mockResolvedValue(undefined),
    buildCrossStackResolver: buildCrossStackResolverMock,
    dispose: vi.fn(),
  })),
}));
vi.mock('../../../src/local/ecs-task-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEcsRunState: vi.fn().mockReturnValue({ containers: [], entries: new Map() }),
  cleanupEcsRun: vi.fn().mockResolvedValue(undefined),
  runEcsTask: runEcsTaskMock,
}));
vi.mock('../../../src/local/ecs-network.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createSharedSvcNetwork: vi
    .fn()
    .mockResolvedValue({ networkName: 'cdkl-svc-net', sidecarContainerId: 'sc' }),
  destroyTaskNetwork: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/local/ecs-service-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startEcsService: startEcsServiceMock,
}));

const { createLocalRunTaskCommand } = await import('../../../src/cli/commands/local-run-task.js');
const { createLocalStartServiceCommand } = await import(
  '../../../src/cli/commands/local-start-service.js'
);

const commands = [
  {
    name: 'cdkl run-task',
    run: async (): Promise<void> => {
      const cmd = createLocalRunTaskCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['S/TD', '--no-pull'], { from: 'user' }).catch((e: unknown) => e);
    },
  },
  {
    name: 'cdkl start-service',
    run: async (): Promise<void> => {
      const cmd = createLocalStartServiceCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['S/Svc', '--no-pull'], { from: 'user' }).catch((e: unknown) => e);
    },
  },
];

describe('the cross-stack consumer region ranks a host default below the stack region (go-to-k/cdk-local#963)', () => {
  const saved = {
    CDKL_APP: process.env['CDKL_APP'],
    AWS_REGION: process.env['AWS_REGION'],
    AWS_DEFAULT_REGION: process.env['AWS_DEFAULT_REGION'],
  };

  beforeEach(() => {
    process.env['CDKL_APP'] = 'node app.js';
    process.env['AWS_REGION'] = 'eu-south-1';
    delete process.env['AWS_DEFAULT_REGION'];
    stackRegion.value = undefined;
    buildCrossStackResolverMock.mockReset().mockResolvedValue(undefined);
    runEcsTaskMock.mockReset().mockResolvedValue({
      state: { network: { networkName: 'cdkl-unit-net' } },
      exitCode: 0,
      essentialContainerName: undefined,
    });
    startEcsServiceMock.mockReset().mockImplementation(async () => {
      throw new CapturedError('captured');
    });
  });

  afterEach(() => {
    setAmbientDefaultRegion(undefined);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function consumerRegion(): unknown {
    expect(buildCrossStackResolverMock).toHaveBeenCalledTimes(1);
    return buildCrossStackResolverMock.mock.calls[0]![0];
  }

  describe.each(commands)('$name', (command) => {
    it('a stack pinned to us-west-2 reads us-west-2 when AWS_REGION holds the default', async () => {
      setAmbientDefaultRegion('eu-south-1');
      stackRegion.value = 'us-west-2';
      await command.run();
      expect(consumerRegion()).toBe('us-west-2');
    });

    it('an environment-agnostic stack reads the default, not us-east-1', async () => {
      setAmbientDefaultRegion('eu-south-1');
      stackRegion.value = 'unknown-region';
      await command.run();
      expect(consumerRegion()).toBe('eu-south-1');
    });

    it('without a recorded default (standalone cdkl) the host AWS_REGION still wins', async () => {
      stackRegion.value = 'us-west-2';
      await command.run();
      expect(consumerRegion()).toBe('eu-south-1');
    });
  });
});
