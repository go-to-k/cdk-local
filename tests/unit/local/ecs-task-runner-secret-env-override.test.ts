/**
 * Issue #848 — a container secret whose env key `--env-vars` gives for that
 * container (or under `Parameters`) is never fetched from AWS: the override
 * wins, as it does for an environment variable. Keys the file does not cover
 * are still resolved, and an overridden secret's value stays off the
 * `docker run` argv.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

const { execFileMock, smSend } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  smSend: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: (...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const out = execFileMock(rest[0], rest[1], rest.length > 3 ? rest[2] : undefined) as
      | string
      | undefined;
    cb(null, { stdout: out ?? '', stderr: '' });
  },
  spawn: vi.fn(),
}));

// The REAL secrets resolver runs; only the SDK boundary is stubbed, so a
// fetch that should not happen shows up as a `send` call.
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = smSend;
    destroy(): void {}
  },
  GetSecretValueCommand: class {
    constructor(public input: { SecretId: string }) {}
  },
}));

const { runEcsTask, createEcsRunState } = await import('../../../src/local/ecs-task-runner.js');

const USER_ARN = 'arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:mew-aurora-000000';
const HOST_ARN = 'arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:mew-host-000000';

function makeContainer(name: string, secrets: ResolvedEcsContainer['secrets']): ResolvedEcsContainer {
  return {
    name,
    image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
    environment: { LOG: 'info' },
    sensitiveEnvKeys: [],
    secrets,
    portMappings: [],
    mountPoints: [],
    dependsOn: [],
    links: [],
    essential: true,
    ulimits: [],
    warnings: [],
  } as ResolvedEcsContainer;
}

function makeTask(containers: ResolvedEcsContainer[]): ResolvedEcsTask {
  return {
    taskDefinitionLogicalId: 'TaskDef',
    family: 'fam',
    networkMode: 'bridge',
    containers,
    stack: { stackName: 'S', region: 'ap-northeast-1' },
    volumes: [],
    warnings: [],
  } as unknown as ResolvedEcsTask;
}

const network = {
  networkName: 'cdkl-task-x',
  sidecarContainerId: 'sidecar',
  sidecarIp: '169.254.170.2',
} as never;

function runnableOptions(task: ResolvedEcsTask) {
  return {
    cluster: 'cdkl',
    containerHost: '127.0.0.1',
    skipPull: true,
    keepRunning: false,
    detach: true,
    skipHostPortPublish: true,
    existingNetwork: network,
    imagePlanByContainer: new Map(task.containers.map((c) => [c.name, 'busybox:latest'])),
  };
}

function dockerRuns(): Array<{ argv: string[]; env: Record<string, string> | undefined }> {
  return execFileMock.mock.calls
    .filter((c) => (c[1] as string[])[0] === 'run')
    .map((c) => ({
      argv: c[1] as string[],
      env: (c[2] as { env?: Record<string, string> } | undefined)?.env,
    }));
}

function fetchedSecretIds(): string[] {
  return smSend.mock.calls.map((c) => (c[0] as { input: { SecretId: string } }).input.SecretId);
}

describe('runEcsTask — --env-vars override of a Secrets entry (#848)', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'run' ? 'cid\n' : ''
    );
    smSend.mockReset();
    // An AWS call for the overridden key is exactly the reported failure.
    smSend.mockImplementation(async (cmd: { input: { SecretId: string } }) => {
      if (cmd.input.SecretId === USER_ARN) {
        throw Object.assign(new Error('Access to account 000000000000 not allowed'), {
          name: 'AccessDeniedException',
          $fault: 'client',
          $metadata: {},
        });
      }
      return { SecretString: JSON.stringify({ host: 'db.internal' }) };
    });
  });

  it('does not fetch a literal-ARN secret the container override names, and boots with the override', async () => {
    const task = makeTask([
      makeContainer('learning-api', [{ name: 'DB_USER', valueFrom: `${USER_ARN}:username::` }]),
    ]);
    await runEcsTask(
      task,
      { ...runnableOptions(task), envOverrides: { 'learning-api': { DB_USER: 'mew' } } },
      createEcsRunState()
    );
    expect(smSend).not.toHaveBeenCalled();
    const runs = dockerRuns();
    expect(runs).toHaveLength(1);
    // Still a secret: value-less `-e DB_USER`, the value via the process env.
    const argv = runs[0]!.argv;
    const i = argv.indexOf('DB_USER');
    expect(i).toBeGreaterThan(0);
    expect(argv[i - 1]).toBe('-e');
    expect(argv.some((a) => a.startsWith('DB_USER='))).toBe(false);
    expect(runs[0]!.env?.['DB_USER']).toBe('mew');
  });

  it('a Parameters (global) override skips the fetch too', async () => {
    const task = makeTask([
      makeContainer('learning-api', [{ name: 'DB_USER', valueFrom: `${USER_ARN}:username::` }]),
    ]);
    await runEcsTask(
      task,
      { ...runnableOptions(task), envOverrides: { Parameters: { DB_USER: 'global' } } },
      createEcsRunState()
    );
    expect(smSend).not.toHaveBeenCalled();
    expect(dockerRuns()[0]!.env?.['DB_USER']).toBe('global');
  });

  it('still resolves a secret key the file does not cover', async () => {
    const task = makeTask([
      makeContainer('learning-api', [
        { name: 'DB_USER', valueFrom: `${USER_ARN}:username::` },
        { name: 'DB_HOST', valueFrom: `${HOST_ARN}:host::` },
      ]),
    ]);
    await runEcsTask(
      task,
      { ...runnableOptions(task), envOverrides: { 'learning-api': { DB_USER: 'mew' } } },
      createEcsRunState()
    );
    expect(fetchedSecretIds()).toEqual([HOST_ARN]);
    const env = dockerRuns()[0]!.env;
    expect(env?.['DB_USER']).toBe('mew');
    expect(env?.['DB_HOST']).toBe('db.internal');
  });

  it("an override for ANOTHER container's key does not skip this container's fetch", async () => {
    const task = makeTask([
      makeContainer('learning-api', [{ name: 'DB_USER', valueFrom: `${USER_ARN}:username::` }]),
    ]);
    const err = await runEcsTask(
      task,
      { ...runnableOptions(task), envOverrides: { 'other-container': { DB_USER: 'mew' } } },
      createEcsRunState()
    ).catch((e: unknown) => e as Error);
    expect(fetchedSecretIds()).toEqual([USER_ARN]);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('AccessDeniedException');
    expect(dockerRuns()).toHaveLength(0);
  });

  it('keeps an override for a DROPPED (intrinsic, no state) secret off the argv', async () => {
    const c = makeContainer('learning-api', []);
    c.droppedSecretNames = ['DB_PASSWORD'];
    const task = makeTask([c]);
    await runEcsTask(
      task,
      { ...runnableOptions(task), envOverrides: { 'learning-api': { DB_PASSWORD: 'pw-848' } } },
      createEcsRunState()
    );
    expect(smSend).not.toHaveBeenCalled();
    const run = dockerRuns()[0]!;
    expect(run.argv.join(' ')).not.toContain('pw-848');
    expect(run.argv[run.argv.indexOf('DB_PASSWORD') - 1]).toBe('-e');
    expect(run.env?.['DB_PASSWORD']).toBe('pw-848');
  });
});
