import { describe, expect, it, vi } from 'vite-plus/test';

const runDetached = vi.hoisted(() => vi.fn(async () => 'cid-1'));
vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  runDetached,
}));

const {
  RecentOutput,
  startWebFunctionContainer,
  waitForWebFunctionReady,
  WEB_FUNCTION_CONTAINER_PORT,
} = await import('../../../src/local/web-function-runner.js');
const { resolveWebFunctionRuntime } = await import('../../../src/local/web-function-runtime.js');

const spec = resolveWebFunctionRuntime('nodejs24.x');
const start = { entryPoint: ['/var/lang/bin/node'], cmd: ['/var/task/index.js'], entryFile: 'index.js' };

describe('startWebFunctionContainer', () => {
  it('mounts the bundle read-only and replaces the RIE entrypoint with the interpreter', async () => {
    const id = await startWebFunctionContainer({
      artifact: { kind: 'zip', runtime: 'nodejs24.x', codeDir: '/code', assetHash: 'h' },
      spec,
      start,
      env: { AWS_LAMBDA_HTTP_ENDPOINT: '0.0.0.0:8080' },
      sensitiveEnvKeys: new Set(['SECRET']),
      host: '127.0.0.1',
      hostPort: 18460,
      platform: 'linux/arm64',
      name: 'cdkl-webfn-1-abc',
    });
    expect(id).toBe('cid-1');
    expect(runDetached).toHaveBeenCalledWith({
      image: 'public.ecr.aws/lambda/nodejs:24',
      mounts: [{ hostPath: '/code', containerPath: '/var/task', readOnly: true }],
      env: { AWS_LAMBDA_HTTP_ENDPOINT: '0.0.0.0:8080' },
      sensitiveEnvKeys: new Set(['SECRET']),
      entryPoint: ['/var/lang/bin/node'],
      cmd: ['/var/task/index.js'],
      workingDir: '/var/task',
      hostPort: 18460,
      containerPort: WEB_FUNCTION_CONTAINER_PORT,
      host: '127.0.0.1',
      platform: 'linux/arm64',
      name: 'cdkl-webfn-1-abc',
    });
  });

  it('refuses the reserved image artifact without touching Docker', async () => {
    runDetached.mockClear();
    await expect(
      startWebFunctionContainer({
        artifact: { kind: 'image', imageUri: 'repo:tag' },
        spec,
        start,
        env: {},
        sensitiveEnvKeys: new Set(),
        host: '127.0.0.1',
        hostPort: 1,
        platform: 'linux/arm64',
        name: 'cdkl-x',
      })
    ).rejects.toThrow(/container-image web function source is not supported yet/);
    expect(runDetached).not.toHaveBeenCalled();
  });
});

describe('RecentOutput', () => {
  it('keeps the last N lines across chunk boundaries', () => {
    const r = new RecentOutput(2);
    r.push('a\nb');
    r.push('c\nd\n');
    expect(r.tail()).toEqual(['bc', 'd']);
  });

  it('includes an unterminated tail', () => {
    const r = new RecentOutput(3);
    r.push(Buffer.from('one\ntwo'));
    expect(r.tail()).toEqual(['one', 'two']);
  });
});

describe('waitForWebFunctionReady', () => {
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('returns once a probe gets an HTTP response', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await waitForWebFunctionReady(
      {
        containerId: 'c',
        host: '127.0.0.1',
        port: 1,
        timeoutMs: 5000,
        recent: new RecentOutput(),
        entryFile: 'index.js',
      },
      { probe, isRunning: async () => true, ...clock }
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('fails fast with the last container lines when the container exits', async () => {
    const clock = fakeClock();
    const recent = new RecentOutput();
    recent.push('Error: Cannot find module express\n');
    await expect(
      waitForWebFunctionReady(
        { containerId: 'c', host: '127.0.0.1', port: 1, timeoutMs: 60_000, recent, entryFile: 'index.js' },
        { probe: async () => false, isRunning: async () => false, ...clock }
      )
    ).rejects.toThrow(
      /exited before its server listened on AWS_LAMBDA_HTTP_ENDPOINT[\s\S]*Cannot find module express/
    );
    expect(clock.now()).toBeLessThan(60_000);
  });

  it('times out naming the endpoint contract when nothing ever answers', async () => {
    const clock = fakeClock();
    await expect(
      waitForWebFunctionReady(
        {
          containerId: 'c',
          host: '127.0.0.1',
          port: 18460,
          timeoutMs: 2000,
          recent: new RecentOutput(),
          entryFile: 'index.js',
        },
        { probe: async () => false, isRunning: async () => true, ...clock }
      )
    ).rejects.toThrow(
      /did not answer HTTP on 127\.0\.0\.1:18460 within 2000ms.*AWS_LAMBDA_HTTP_ENDPOINT.*printed nothing/
    );
  });
});
