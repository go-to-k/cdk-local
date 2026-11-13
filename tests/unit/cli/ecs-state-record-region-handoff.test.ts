/**
 * `cdkl run-task` and `cdkl start-service` hand the runner the region the
 * state record was loaded from (go-to-k/cdk-local#925), so a container's
 * `AWS_REGION` can fall back to it. The runner's own region order is tested
 * in `tests/unit/local/ecs-task-runner-container-region.test.ts`; this file
 * drives each COMMAND BODY so the hand-off line itself is fenced -- with it
 * missing, the runner still runs and nothing else fails.
 *
 * REAL: target resolution, the image-resolution context build (which loads
 * the record). MOCKED: docker, synth, the state provider (the record's
 * region is the probe value), STS, the shared network and the runners (the
 * capture points).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { RunEcsTaskOptions } from '../../../src/local/ecs-task-runner.js';

const { runEcsTaskMock, startEcsServiceMock, providerLoad } = vi.hoisted(() => ({
  runEcsTaskMock: vi.fn(),
  startEcsServiceMock: vi.fn(),
  providerLoad: vi.fn(),
}));

/** Thrown by the mocked service runner once it has captured its options. */
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
    config = { region: async () => 'us-east-1' };
    send = vi.fn().mockResolvedValue({ Account: '111111111111' });
    destroy(): void {}
  },
}));

// An env-agnostic stack (no `env.region`) whose container env needs the
// deployed state, so the command loads the record.
const stacks = [
  {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    dependencyNames: [],
    template: {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': 'S/Bucket/Resource' } },
        TD: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            Family: 'fam',
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: 'nginx',
                Essential: true,
                Environment: [{ Name: 'BUCKET', Value: { Ref: 'Bucket' } }],
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

vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockResolvedValue({ stacks }),
  })),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: vi.fn().mockImplementation(() => ({
    label: '--from-state',
    load: providerLoad,
    buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
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

describe('the state record region reaches the ECS runner (go-to-k/cdk-local#925)', () => {
  const savedApp = process.env['CDKL_APP'];

  beforeEach(() => {
    process.env['CDKL_APP'] = 'node app.js';
    providerLoad.mockReset().mockResolvedValue({
      resources: { Bucket: { physicalId: 'my-bucket', resourceType: 'AWS::S3::Bucket' } },
      outputs: {},
      region: 'sa-east-1',
    });
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
    if (savedApp === undefined) delete process.env['CDKL_APP'];
    else process.env['CDKL_APP'] = savedApp;
  });

  it('cdkl run-task', async () => {
    const cmd = createLocalRunTaskCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['S/TD', '--no-pull'], { from: 'user' });

    expect(providerLoad).toHaveBeenCalled();
    expect(runEcsTaskMock).toHaveBeenCalledTimes(1);
    const opts = runEcsTaskMock.mock.calls[0]![1] as RunEcsTaskOptions;
    expect(opts.stateRecordRegion).toBe('sa-east-1');
  });

  it('cdkl start-service', async () => {
    const cmd = createLocalStartServiceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['S/Svc', '--no-pull'], { from: 'user' }).catch((e: unknown) => e);

    expect(providerLoad).toHaveBeenCalled();
    expect(startEcsServiceMock).toHaveBeenCalledTimes(1);
    const runnerOpts = startEcsServiceMock.mock.calls[0]![1] as {
      taskOptions: RunEcsTaskOptions;
    };
    expect(runnerOpts.taskOptions.stateRecordRegion).toBe('sa-east-1');
  });
});
