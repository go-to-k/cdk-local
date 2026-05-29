import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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
    codePath: '/tmp/code',
    ...overrides,
  } as ResolvedZipLambda;
}

beforeEach(() => {
  runDetachedMock.mockReset().mockResolvedValue('container-abc');
  pickFreePortMock.mockReset().mockResolvedValue(54321);
  removeContainerMock.mockReset().mockResolvedValue(undefined);
  pullImageMock.mockReset().mockResolvedValue(undefined);
  waitForRieReadyMock.mockReset().mockResolvedValue(undefined);
  invokeRieMock.mockReset().mockResolvedValue({ payload: { statusCode: 200 }, raw: '{}' });
});

describe('createFrontDoorLambdaRunner', () => {
  it('boots a ZIP Lambda container (pull + run + wait for RIE) on start()', async () => {
    const runner = createFrontDoorLambdaRunner(zipLambda(), { containerHost: '127.0.0.1' });
    await runner.start();

    expect(pullImageMock).toHaveBeenCalledWith('public.ecr.aws/lambda/nodejs:20', false);
    expect(runDetachedMock).toHaveBeenCalledTimes(1);
    const runArgs = runDetachedMock.mock.calls[0]![0];
    expect(runArgs.image).toBe('public.ecr.aws/lambda/nodejs:20');
    expect(runArgs.cmd).toEqual(['index.handler']);
    expect(runArgs.mounts).toEqual([
      { hostPath: '/tmp/code', containerPath: '/var/task', readOnly: true },
    ]);
    expect(runArgs.hostPort).toBe(54321);
    expect(runArgs.env.AWS_LAMBDA_FUNCTION_NAME).toBe('EchoFn');
    expect(waitForRieReadyMock).toHaveBeenCalledWith('127.0.0.1', 54321, 30_000);
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
    expect(pullImageMock).toHaveBeenCalledWith('public.ecr.aws/lambda/nodejs:20', true);
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
