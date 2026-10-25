import { describe, expect, it, vi } from 'vite-plus/test';

const runDetached = vi.hoisted(() => vi.fn(async (_opts: Record<string, unknown>) => 'cid-1'));
vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  runDetached,
}));

const {
  RecentOutput,
  containerFailure,
  planWebFunctionContainer,
  startWebFunctionContainer,
  waitForWebFunctionReady,
  WEB_FUNCTION_CONTAINER_PORT,
  MAX_PROBE_TIMEOUT_MS,
} = await import('../../../src/local/web-function-runner.js');
const { resolveWebFunctionRuntime } = await import('../../../src/local/web-function-runtime.js');
type Spec = import('../../../src/local/web-function-runtime.js').WebFunctionRuntimeSpec;

const node = resolveWebFunctionRuntime('nodejs24.x');
const zip = { kind: 'zip' as const, runtime: 'nodejs24.x', codeDir: '/code', assetHash: 'h' };

describe('planWebFunctionContainer', () => {
  it('mounts a zip bundle read-only and takes the start command from the row', () => {
    expect(planWebFunctionContainer(zip, node, {}, { fileExists: () => true })).toEqual({
      image: 'public.ecr.aws/lambda/nodejs:24',
      mounts: [{ hostPath: '/code', containerPath: '/var/task', readOnly: true }],
      entryPoint: ['/var/lang/bin/node'],
      cmd: ['/var/task/index.js'],
      workingDir: '/var/task',
      label: 'index.js',
    });
  });

  it('refuses the reserved image artifact', () => {
    expect(() =>
      planWebFunctionContainer({ kind: 'image', imageUri: 'repo:tag' }, node, {})
    ).toThrow(/container-image web function source is not supported yet/);
  });

  it('runs a command-style row unchanged: a row is all a new runtime needs', async () => {
    const python: Spec = {
      runtime: 'python3.13',
      baseImage: 'public.ecr.aws/lambda/python:3.13',
      codeMountPath: '/var/task',
      architectures: ['arm64'],
      buildStart: () => ({
        entryPoint: ['/var/lang/bin/python3', '-m'],
        cmd: ['uvicorn', 'app:app', '--port', '8080'],
        label: 'uvicorn app:app',
      }),
    };
    const plan = planWebFunctionContainer(zip, python, {});
    runDetached.mockClear();
    await startWebFunctionContainer({
      plan,
      env: {},
      sensitiveEnvKeys: new Set(),
      host: '127.0.0.1',
      hostPort: 1,
      platform: 'linux/arm64',
      name: 'cdkl-webfn-x',
    });
    expect(runDetached.mock.calls[0]![0]).toMatchObject({
      image: 'public.ecr.aws/lambda/python:3.13',
      entryPoint: ['/var/lang/bin/python3', '-m'],
      cmd: ['uvicorn', 'app:app', '--port', '8080'],
    });
  });
});

describe('startWebFunctionContainer', () => {
  it('omits sensitiveEnvKeys when there are none', async () => {
    runDetached.mockClear();
    const plan = planWebFunctionContainer(zip, node, {}, { fileExists: () => true });
    await startWebFunctionContainer({
      plan,
      env: {},
      sensitiveEnvKeys: new Set(),
      host: '127.0.0.1',
      hostPort: 1,
      platform: 'linux/arm64',
      name: 'cdkl-webfn-y',
    });
    expect(runDetached.mock.calls[0]![0]).not.toHaveProperty('sensitiveEnvKeys');
  });

  it('publishes the plan WITHOUT --rm, so a boot crash keeps its logs', async () => {
    runDetached.mockClear();
    const plan = planWebFunctionContainer(zip, node, {}, { fileExists: () => true });
    const id = await startWebFunctionContainer({
      plan,
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
      autoRemove: false,
    });
  });
});

describe('RecentOutput', () => {
  it('keeps the last N lines across chunk boundaries', () => {
    const r = new RecentOutput(2);
    r.push('a\nb');
    r.push('c\nd\n');
    expect(r.tail()).toEqual(['bc', 'd']);
  });

  it('strips a trailing carriage return', () => {
    const r = new RecentOutput();
    r.push('crlf line\r\n');
    expect(r.tail()).toEqual(['crlf line']);
  });

  it('flushes an unterminated line once it passes 4096 characters', () => {
    const r = new RecentOutput();
    r.push('x'.repeat(4097));
    r.push('next\n');
    expect(r.tail()).toEqual(['x'.repeat(4097), 'next']);
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
    return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => (t += ms) };
  };
  const base = { containerId: 'c', host: '127.0.0.1', port: 18460, label: 'index.js' };

  it('returns once a probe gets an HTTP response', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValueOnce('refused').mockResolvedValueOnce('answered');
    await waitForWebFunctionReady(
      { ...base, timeoutMs: 5000, recent: new RecentOutput() },
      { probe, isRunning: async () => true, fetchLogs: async () => [], ...clock }
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('gives each probe min(remaining, 10s), so a slow / still comes up', async () => {
    const clock = fakeClock();
    const timeouts: number[] = [];
    const probe = vi.fn(async (_h: string, _p: number, t: number) => {
      timeouts.push(t);
      clock.advance(t);
      return timeouts.length < 2 ? ('timeout' as const) : ('answered' as const);
    });
    await waitForWebFunctionReady(
      { ...base, timeoutMs: 15_000, recent: new RecentOutput() },
      { probe, isRunning: async () => true, fetchLogs: async () => [], ...clock }
    );
    expect(timeouts).toEqual([MAX_PROBE_TIMEOUT_MS, 5000]);
  });

  it('never hands a probe a timeout below 1 ms', async () => {
    // now(): 0 (deadline = 1), then 0.5 (loop check, remaining 0.5), then past it.
    const clock = [0, 0.5, 0.5];
    let calls = 0;
    const timeouts: number[] = [];
    await expect(
      waitForWebFunctionReady(
        { ...base, timeoutMs: 1, recent: new RecentOutput() },
        {
          probe: async (_h, _p, ms) => {
            timeouts.push(ms);
            return 'refused';
          },
          isRunning: async () => true,
          fetchLogs: async () => [],
          now: () => clock[calls++] ?? 5,
          sleep: async () => undefined,
        }
      )
    ).rejects.toThrow(/never accepted/);
    expect(timeouts[0]).toBe(1);
  });

  it('says "listening but slow" when the last probe timed out', async () => {
    const clock = fakeClock();
    await expect(
      waitForWebFunctionReady(
        { ...base, timeoutMs: 2000, recent: new RecentOutput() },
        {
          probe: async (_h, _p, t) => {
            clock.advance(t);
            return 'timeout';
          },
          isRunning: async () => true,
          fetchLogs: async () => [],
          ...clock,
        }
      )
    ).rejects.toThrow(/accepted the connection but did not answer GET \/ within 2000ms — it is listening but slow/);
  });

  it('says "never accepted" when nothing listens', async () => {
    const clock = fakeClock();
    await expect(
      waitForWebFunctionReady(
        { ...base, timeoutMs: 2000, recent: new RecentOutput() },
        { probe: async () => 'refused', isRunning: async () => true, fetchLogs: async () => [], ...clock }
      )
    ).rejects.toThrow(
      /never accepted an HTTP connection on 127\.0\.0\.1:18460 within 2000ms.*AWS_LAMBDA_HTTP_ENDPOINT.*printed nothing/
    );
  });

  it('fails fast with the docker-logs tail when the container exits at boot', async () => {
    const clock = fakeClock();
    const fetchLogs = vi.fn(async () => ['SyntaxError: Unexpected token', '    at index.js:3']);
    await expect(
      waitForWebFunctionReady(
        { ...base, timeoutMs: 60_000, recent: new RecentOutput() },
        { probe: async () => 'refused', isRunning: async () => false, fetchLogs, ...clock }
      )
    ).rejects.toThrow(/exited before its server listened[\s\S]*SyntaxError: Unexpected token[\s\S]*index\.js:3/);
    expect(fetchLogs).toHaveBeenCalledWith('c', 20);
    expect(clock.now()).toBeLessThan(60_000);
  });
});

describe('containerFailure', () => {
  it("prefers Docker's own log tail over the relayed lines", async () => {
    const recent = new RecentOutput();
    recent.push('relayed only\n');
    const err = await containerFailure('boom.', 'c', recent, async () => ['from docker']);
    expect(err.message).toContain('from docker');
    expect(err.message).not.toContain('relayed only');
    expect(err.code).toBe('LOCAL_START_WEB_FUNCTION_NOT_READY');
  });

  it('falls back to the relayed lines when fetchLogs throws synchronously', async () => {
    const recent = new RecentOutput();
    recent.push('relayed\n');
    const err = await containerFailure('boom.', 'c', recent, () => {
      throw new Error('sync');
    });
    expect(err.message).toContain('relayed');
  });

  it('carries the exit-while-serving code when asked', async () => {
    const err = await containerFailure(
      'exited.',
      'c',
      new RecentOutput(),
      async () => [],
      'LOCAL_START_WEB_FUNCTION_EXITED'
    );
    expect(err.code).toBe('LOCAL_START_WEB_FUNCTION_EXITED');
    expect(err.message).toBe('exited. The container printed nothing.');
  });

  it('falls back to the relayed lines when docker logs cannot be read', async () => {
    const recent = new RecentOutput();
    recent.push('relayed line\n');
    const err = await containerFailure('boom.', 'c', recent, async () => {
      throw new Error('gone');
    });
    expect(err.message).toMatch(/boom\. Last 1 line\(s\) of container output:\n {2}relayed line/);
  });
});
