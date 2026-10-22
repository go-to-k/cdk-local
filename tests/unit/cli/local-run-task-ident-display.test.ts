/**
 * go-to-k/cdk-local#761 (S3): `cdkl run-task` renders the assembly-chosen stack
 * name, task logical id, family and essential container name bare when plain and
 * as ONE JSON string literal when they could forge a boundary. Expected strings
 * are hand-written. The command body is driven with docker, synth and the runner
 * mocked (same seams as local-run-task-stage-target-wiring.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const h = vi.hoisted(() => ({
  stackName: 'S',
  logicalId: 'TD',
  family: 'fam',
  runEcsTask: vi.fn(),
}));

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
vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(async () => ({
      stacks: [
        {
          stackName: h.stackName,
          displayName: h.stackName,
          artifactId: h.stackName,
          dependencyNames: [],
          region: 'us-east-1',
          template: {
            Resources: {
              [h.logicalId]: {
                Type: 'AWS::ECS::TaskDefinition',
                Properties: {
                  Family: h.family,
                  ContainerDefinitions: [{ Name: 'app', Image: 'nginx' }],
                },
              },
            },
          },
        },
      ],
    })),
  })),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../../src/local/ecs-task-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEcsRunState: vi.fn().mockReturnValue({ containers: [], entries: new Map() }),
  cleanupEcsRun: vi.fn().mockResolvedValue(undefined),
  runEcsTask: h.runEcsTask,
}));

const { createLocalRunTaskCommand } = await import('../../../src/cli/commands/local-run-task.js');

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

async function runTask(target: string, essential: string): Promise<string[]> {
  h.runEcsTask.mockResolvedValue({
    state: { network: { networkName: 'cdkl-unit-net' } },
    exitCode: 0,
    essentialContainerName: essential,
  });
  const lines: string[] = [];
  const sink = (...a: unknown[]): void => {
    lines.push(
      a
        .map(String)
        .join(' ')
        .replace(ANSI, '')
        .replace(/^(WARN|ERROR): /, '')
    );
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation(sink);
  }
  const cmd = createLocalRunTaskCommand();
  cmd.exitOverride();
  await cmd.parseAsync([target, '--no-pull'], { from: 'user' });
  return lines;
}

describe('run-task renders Target / family / essential container (#761)', () => {
  const savedApp = process.env['CDKL_APP'];
  beforeEach(() => {
    process.env['CDKL_APP'] = 'node app.js';
    h.stackName = 'S';
    h.logicalId = 'TD';
    h.family = 'fam';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedApp === undefined) delete process.env['CDKL_APP'];
    else process.env['CDKL_APP'] = savedApp;
  });

  it('prints plain values bare', async () => {
    const lines = await runTask('S:TD', 'app');
    expect(lines).toContain('Target: S/TD (family=fam, containers=1)');
    expect(lines).toContain('Essential container app exited with code 0.');
  });

  it('prints forging values as JSON literals', async () => {
    h.stackName = 'S\u001b[2Kx';
    h.logicalId = "T' D";
    h.family = "fam' x";
    const lines = await runTask("S\u001b[2Kx:T' D", "ap' p");
    expect(lines).toContain(`Target: "S [2Kx/T' D" (family="fam' x", containers=1)`);
    expect(lines).toContain(`Essential container "ap' p" exited with code 0.`);
  });
});
