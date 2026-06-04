import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedDistribution, ResolvedOrigin } from '../../../src/local/cloudfront-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// Mock the two external boundaries `bootLambdaUrlOrigins` drives: the Lambda
// resolver and the RIE runner factory. We assert the orchestration (dedup,
// pure-S3 short-circuit, partial-boot rollback) without any Docker.
const { resolveLambdaTargetMock, createRunnerMock, runners } = vi.hoisted(() => ({
  resolveLambdaTargetMock: vi.fn(),
  createRunnerMock: vi.fn(),
  runners: [] as Array<{ logicalId: string; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn> }>,
}));

vi.mock('../../../src/local/lambda-resolver.js', () => ({
  resolveLambdaTarget: resolveLambdaTargetMock,
}));
vi.mock('../../../src/local/front-door-lambda-runner.js', () => ({
  createFrontDoorLambdaRunner: createRunnerMock,
}));

const { bootLambdaUrlOrigins } = await import(
  '../../../src/cli/commands/local-start-cloudfront.js'
);

function distributionWith(origins: ResolvedOrigin[]): ResolvedDistribution {
  return {
    logicalId: 'Dist',
    stackName: 'Stack',
    behaviors: [],
    origins: new Map(origins.map((o) => [o.originId, o])),
    customErrorResponses: [],
  };
}

const stacks: StackInfo[] = [
  { stackName: 'Stack', displayName: 'Stack', artifactId: 'Stack', template: {}, dependencyNames: [] },
];
const bootOpts = { containerHost: '127.0.0.1', skipPull: false };

beforeEach(() => {
  resolveLambdaTargetMock.mockReset();
  createRunnerMock.mockReset();
  runners.length = 0;
  resolveLambdaTargetMock.mockImplementation((id: string) => ({ logicalId: id }));
  createRunnerMock.mockImplementation((lambda: { logicalId: string }) => {
    const runner = {
      logicalId: lambda.logicalId,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      invoke: vi.fn().mockResolvedValue({ statusCode: 200, body: '' }),
    };
    runners.push(runner);
    return runner;
  });
});

describe('bootLambdaUrlOrigins', () => {
  it('boots no container for a pure-S3 distribution (stays Docker-free)', async () => {
    const dist = distributionWith([{ kind: 's3', originId: 'o1', localDirs: ['/tmp/x'] }]);
    const { invokers, runners: r } = await bootLambdaUrlOrigins(dist, stacks, bootOpts);
    expect(invokers.size).toBe(0);
    expect(r).toHaveLength(0);
    expect(createRunnerMock).not.toHaveBeenCalled();
    expect(resolveLambdaTargetMock).not.toHaveBeenCalled();
  });

  it('boots one runner per UNIQUE backing function (dedups shared functions)', async () => {
    const dist = distributionWith([
      { kind: 'lambda-url', originId: 'a', functionLogicalId: 'Fn', functionUrlLogicalId: 'FnUrlA' },
      { kind: 'lambda-url', originId: 'b', functionLogicalId: 'Fn', functionUrlLogicalId: 'FnUrlB' },
      { kind: 'lambda-url', originId: 'c', functionLogicalId: 'Other', functionUrlLogicalId: 'OtherUrl' },
    ]);
    const { invokers, runners: r } = await bootLambdaUrlOrigins(dist, stacks, bootOpts);
    expect(r).toHaveLength(2); // Fn + Other, NOT three
    expect(invokers.has('Fn')).toBe(true);
    expect(invokers.has('Other')).toBe(true);
    for (const runner of r) expect(runner.start).toHaveBeenCalledOnce();
  });

  it('stops already-started runners and throws when a later boot fails (partial-boot rollback)', async () => {
    let call = 0;
    createRunnerMock.mockImplementation((lambda: { logicalId: string }) => {
      call += 1;
      const willFail = call === 2;
      const runner = {
        logicalId: lambda.logicalId,
        start: willFail
          ? vi.fn().mockRejectedValue(new Error('docker daemon not running'))
          : vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        invoke: vi.fn(),
      };
      runners.push(runner);
      return runner;
    });
    const dist = distributionWith([
      { kind: 'lambda-url', originId: 'a', functionLogicalId: 'First', functionUrlLogicalId: 'U1' },
      { kind: 'lambda-url', originId: 'b', functionLogicalId: 'Second', functionUrlLogicalId: 'U2' },
    ]);
    // Wraps the underlying failure (the cause's message is surfaced) in a
    // LocalStartCloudFrontError naming the function that failed to boot.
    await expect(bootLambdaUrlOrigins(dist, stacks, bootOpts)).rejects.toThrow(
      /Failed to boot the Lambda Function URL origin's backing function 'Second'.*docker daemon not running/
    );
    // The first (successfully started) runner is torn down on the rollback.
    expect(runners[0]!.stop).toHaveBeenCalledOnce();
  });
});
