import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// Mock the docker / RIE boundary so the runner can be exercised without Docker.
const {
  runDetachedMock,
  pickFreePortMock,
  removeContainerMock,
  pullImageMock,
  streamLogsMock,
  waitForRieReadyMock,
  invokeRieMock,
} = vi.hoisted(() => ({
  runDetachedMock: vi.fn(),
  pickFreePortMock: vi.fn(),
  removeContainerMock: vi.fn(),
  pullImageMock: vi.fn(),
  streamLogsMock: vi.fn(() => () => undefined),
  waitForRieReadyMock: vi.fn(),
  invokeRieMock: vi.fn(),
}));

vi.mock('../../../src/local/docker-runner.js', () => ({
  runDetached: runDetachedMock,
  pickFreePort: pickFreePortMock,
  removeContainer: removeContainerMock,
  pullImage: pullImageMock,
  streamLogs: streamLogsMock,
}));

vi.mock('../../../src/local/rie-client.js', () => ({
  waitForRieReady: waitForRieReadyMock,
  invokeRie: invokeRieMock,
}));

vi.mock('../../../src/local/runtime-image.js', () => ({
  resolveRuntimeImage: vi.fn(() => 'public.ecr.aws/lambda/nodejs:20'),
  resolveRuntimeCodeMountPath: vi.fn(() => '/var/task'),
  resolveRuntimeFileExtension: vi.fn(() => '.js'),
}));

const { createFrontDoorLambdaRunner } = await import(
  '../../../src/local/front-door-lambda-runner.js'
);
const { resetEmbedConfig, setEmbedConfig } = await import('../../../src/local/embed-config.js');
const { recordAssumedRole, resetWorkloadIdentity } = await import(
  '../../../src/utils/workload-identity.js'
);
const { getLogger } = await import('../../../src/utils/logger.js');

// A real on-disk asset directory: resolveZipImagePlan now stats codePath (to
// distinguish an unzipped dir from a `.zip` file via materializeAssetCodeDir),
// so the fixture must exist on disk like a real resolved CDK asset.
let codeDir: string;

function zipLambda(overrides: Partial<ResolvedZipLambda> = {}): ResolvedZipLambda {
  return {
    kind: 'zip',
    stack: { stackName: 'S' } as unknown as StackInfo,
    logicalId: 'EchoFn',
    resource: { Type: 'AWS::Lambda::Function', Properties: {} },
    memoryMb: 128,
    timeoutSec: 10,
    layers: [],
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    codePath: codeDir,
    architecture: 'x86_64',
    ...overrides,
  } as ResolvedZipLambda;
}

beforeEach(() => {
  codeDir = mkdtempSync(join(tmpdir(), 'cdkl-fd-code-'));
  writeFileSync(join(codeDir, 'index.js'), 'exports.handler = () => {};');
  runDetachedMock.mockReset().mockResolvedValue('container-abc');
  pickFreePortMock.mockReset().mockResolvedValue(54321);
  removeContainerMock.mockReset().mockResolvedValue(undefined);
  pullImageMock.mockReset().mockResolvedValue(undefined);
  waitForRieReadyMock.mockReset().mockResolvedValue(undefined);
  invokeRieMock.mockReset().mockResolvedValue({ payload: { statusCode: 200 }, raw: '{}' });
});

afterEach(() => {
  if (codeDir) rmSync(codeDir, { recursive: true, force: true });
});

describe('createFrontDoorLambdaRunner', () => {
  it('boots a ZIP Lambda container (pull + run + wait for RIE) on start()', async () => {
    const runner = createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' });
    await runner.start();

    // Pull + run pin the platform to the Lambda's declared architecture so a
    // provided.* bootstrap does not hit an "exec format error" on a host whose
    // native arch differs.
    expect(pullImageMock).toHaveBeenCalledWith(
      'public.ecr.aws/lambda/nodejs:20',
      false,
      'linux/amd64'
    );
    expect(runDetachedMock).toHaveBeenCalledTimes(1);
    const runArgs = runDetachedMock.mock.calls[0]![0];
    expect(runArgs.image).toBe('public.ecr.aws/lambda/nodejs:20');
    expect(runArgs.platform).toBe('linux/amd64');
    expect(runArgs.cmd).toEqual(['index.handler']);
    expect(runArgs.mounts).toEqual([
      { hostPath: codeDir, containerPath: '/var/task', readOnly: true },
    ]);
    expect(runArgs.hostPort).toBe(54321);
    expect(runArgs.env.AWS_LAMBDA_FUNCTION_NAME).toBe('EchoFn');
    expect(waitForRieReadyMock).toHaveBeenCalledWith('127.0.0.1', 54321, 30_000);
  });

  it('pins --platform to the declared arm64 architecture for a ZIP Lambda', async () => {
    const runner = createFrontDoorLambdaRunner(zipLambda({ architecture: 'arm64' }), {
      containerHost: '127.0.0.1',
    });
    await runner.start();
    expect(pullImageMock).toHaveBeenCalledWith(
      'public.ecr.aws/lambda/nodejs:20',
      false,
      'linux/arm64'
    );
    expect(runDetachedMock.mock.calls[0]![0].platform).toBe('linux/arm64');
  });

  it('extracts a .zip-packaged asset and mounts the extracted dir, cleaning it up on stop()', async () => {
    // A `Code.fromAsset('bundle.zip')` Lambda: codePath points at the zip FILE,
    // which must be extracted before the bind-mount (a zip cannot be mounted as
    // a dir). The extracted temp dir is removed on stop().
    const zipPath = join(codeDir, 'asset.deadbeef.zip');
    writeFileSync(zipPath, zipSync({ 'index.js': strToU8('exports.handler = () => {};') }));

    const runner = createFrontDoorLambdaRunner(zipLambda({ codePath: zipPath }), {
      containerHost: '127.0.0.1',
    });
    await runner.start();

    const mount = runDetachedMock.mock.calls[0]![0].mounts[0];
    expect(mount.containerPath).toBe('/var/task');
    // The mount is a freshly-extracted dir, NOT the zip file itself.
    expect(mount.hostPath).not.toBe(zipPath);
    expect(existsSync(join(mount.hostPath, 'index.js'))).toBe(true);

    const extracted = mount.hostPath;
    await runner.stop();
    expect(existsSync(extracted)).toBe(false);
  });

  it('uses a caller-provided containerEnv overlay + forwards sensitiveEnvKeys (issue #380)', async () => {
    const containerEnv = {
      AWS_LAMBDA_FUNCTION_NAME: 'EchoFn',
      TABLE_NAME: 'deployed-table',
      AWS_ACCESS_KEY_ID: 'AKIA',
      SECRET_VALUE: 'shh',
    };
    const runner = createFrontDoorLambdaRunner(zipLambda(), {
      containerHost: '127.0.0.1',
      containerEnv,
      sensitiveEnvKeys: new Set(['SECRET_VALUE']),
    });
    await runner.start();

    const runArgs = runDetachedMock.mock.calls[0]![0];
    // The overlay REPLACES the runner's default base (it already carries the
    // AWS_LAMBDA_* identity vars from resolveLambdaContainerEnv).
    expect(runArgs.env).toEqual(containerEnv);
    expect(runArgs.env.TABLE_NAME).toBe('deployed-table');
    // Sensitive keys are forwarded so they stay off the docker run argv.
    expect(runArgs.sensitiveEnvKeys).toEqual(new Set(['SECRET_VALUE']));
  });

  it('is idempotent — a second start() does not boot a second container', async () => {
    const runner = createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' });
    await runner.start();
    await runner.start();
    expect(runDetachedMock).toHaveBeenCalledTimes(1);
  });

  it('passes skipPull through when --no-pull is set', async () => {
    const runner = createFrontDoorLambdaRunner(zipLambda(), {
      containerHost: '127.0.0.1',
      skipPull: true,
    });
    await runner.start();
    expect(pullImageMock).toHaveBeenCalledWith('public.ecr.aws/lambda/nodejs:20', true, 'linux/amd64');
  });

  it('invoke() POSTs the event to RIE and returns the parsed payload', async () => {
    invokeRieMock.mockResolvedValue({ payload: { statusCode: 201, body: 'hi' }, raw: '{}' });
    const runner = createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' });
    await runner.start();
    const payload = await runner.invoke({ path: '/' });
    expect(invokeRieMock).toHaveBeenCalledTimes(1);
    const [host, port, event, timeoutMs] = invokeRieMock.mock.calls[0]!;
    expect(host).toBe('127.0.0.1');
    expect(port).toBe(54321);
    expect(event).toEqual({ path: '/' });
    // default timeout = max(30s, timeoutSec*2*1000) = 30s for timeoutSec=10.
    expect(timeoutMs).toBe(30_000);
    expect(payload).toEqual({ statusCode: 201, body: 'hi' });
  });

  it('renders the logical id bare when plain and as a JSON literal when forging (#761)', async () => {
    const plain = createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' });
    await expect(plain.invoke({})).rejects.toThrow(
      'FrontDoorLambdaRunner(EchoFn).invoke called before start() completed.'
    );
    const forged = createFrontDoorLambdaRunner(zipLambda({ logicalId: "a' b" }), {
      containerHost: '127.0.0.1',
    });
    await expect(forged.invoke({})).rejects.toThrow(
      `FrontDoorLambdaRunner("a' b").invoke called before start() completed.`
    );
  });

  it('invoke() before start() throws (rather than hitting an undefined port)', async () => {
    const runner = createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' });
    await expect(runner.invoke({})).rejects.toThrow(/before start/);
  });

  it('cleans up the container when RIE never becomes ready', async () => {
    waitForRieReadyMock.mockRejectedValue(new Error('RIE timeout'));
    const runner = createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' });
    await expect(runner.start()).rejects.toThrow(/RIE timeout/);
    expect(removeContainerMock).toHaveBeenCalledWith('container-abc');
  });

  it('stop() removes the container and is idempotent', async () => {
    const runner = createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' });
    await runner.start();
    await runner.stop();
    await runner.stop();
    expect(removeContainerMock).toHaveBeenCalledTimes(1);
    expect(removeContainerMock).toHaveBeenCalledWith('container-abc');
  });

  it('rejects start() after stop()', async () => {
    const runner = createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' });
    await runner.stop();
    await expect(runner.start()).rejects.toThrow(/after stop/);
  });
});

describe('createFrontDoorLambdaRunner — caller workload identity (go-to-k/cdk-local#783)', () => {
  const KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAROLE';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'roleSecret';
    process.env['AWS_SESSION_TOKEN'] = 'roleToken';
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetWorkloadIdentity();
    resetEmbedConfig();
    vi.restoreAllMocks();
  });

  it('caller mode restores the caller triple in the forwarded env (not the role)', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    await createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' }).start();
    const env = runDetachedMock.mock.calls[0]![0].env;
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIACALLER');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('callerSecret');
    expect('AWS_SESSION_TOKEN' in env).toBe(false);
  });

  it('caller mode with no static caller triple strips the triple and warns once', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(undefined);
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    await createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' }).start();
    const env = runDetachedMock.mock.calls[0]![0].env;
    expect('AWS_ACCESS_KEY_ID' in env).toBe(false);
    expect('AWS_SECRET_ACCESS_KEY' in env).toBe(false);
    expect('AWS_SESSION_TOKEN' in env).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('role mode forwards the process env as before', async () => {
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    await createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' }).start();
    const env = runDetachedMock.mock.calls[0]![0].env;
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIAROLE');
    expect(env.AWS_SESSION_TOKEN).toBe('roleToken');
  });
});
