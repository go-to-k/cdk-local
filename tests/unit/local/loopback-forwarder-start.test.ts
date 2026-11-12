import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (e: Error | null, r: { stdout: string; stderr: string }) => void;
    const out = execFileMock(cmd, args) as { stdout?: string; error?: Error } | undefined;
    if (out?.error) cb(Object.assign(out.error, { stderr: out.error.message }), { stdout: '', stderr: '' });
    else cb(null, { stdout: out?.stdout ?? '', stderr: '' });
  },
  spawn: vi.fn(),
}));

const { pullImageMock } = vi.hoisted(() => ({ pullImageMock: vi.fn(async () => undefined) }));
vi.mock('../../../src/local/docker-runner.js', () => ({ pullImage: pullImageMock }));

const { startLoopbackForwarder, awaitLoopbackForwarderStatus, resetLoopbackForwarderForTest } = await import(
  '../../../src/local/loopback-forwarder.js'
);

const opts = { workloadContainer: 'wl', ports: [9297], probe: 'tcp' as const };

beforeEach(() => {
  execFileMock.mockReset();
  pullImageMock.mockClear();
  resetLoopbackForwarderForTest();
});

describe('startLoopbackForwarder', () => {
  it('returns the parsed READY result', async () => {
    execFileMock.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'logs' ? { stdout: 'CDKL-FWD READY 192.168.65.254\n' } : { stdout: '' }
    );
    await expect(startLoopbackForwarder(opts)).resolves.toMatchObject({ ok: true, upstream: '192.168.65.254' });
  });

  it('pulls the image once when it is missing locally', async () => {
    execFileMock.mockImplementation((_c: string, a: string[]) => {
      if (a[0] === 'image') return { error: new Error('No such image') };
      if (a[0] === 'logs') return { stdout: 'CDKL-FWD READY x\n' };
      return { stdout: '' };
    });
    await startLoopbackForwarder(opts);
    await startLoopbackForwarder(opts);
    expect(pullImageMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the forwarder exits before reporting', async () => {
    execFileMock.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'logs' ? { error: new Error('No such container') } : { stdout: '' }
    );
    await expect(startLoopbackForwarder(opts)).rejects.toThrow(/exited before reporting/);
  });

  it('removes the forwarder and rejects when it never reports', async () => {
    execFileMock.mockImplementation(() => ({ stdout: '' }));
    await expect(startLoopbackForwarder({ ...opts, timeoutMs: 0 })).rejects.toThrow(/did not report/);
    expect(execFileMock.mock.calls.some((c) => c[1][0] === 'rm' && c[1][1] === '-f')).toBe(true);
  });

  it('rejects with docker stderr when the run fails', async () => {
    execFileMock.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'run' ? { error: new Error('conflicting options') } : { stdout: '' }
    );
    await expect(startLoopbackForwarder(opts)).rejects.toThrow(/Could not start the loopback forwarder container: conflicting options/);
  });
});

describe('awaitLoopbackForwarderStatus', () => {
  it('resolves with a FAIL result naming the forwarder, without removing it', async () => {
    execFileMock.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'logs' ? { stdout: 'CDKL-FWD FAIL 9297 ECONNREFUSED 172.18.0.1\n' } : { stdout: '' }
    );
    await expect(awaitLoopbackForwarderStatus('fwd')).resolves.toEqual({
      name: 'fwd',
      ok: false,
      failedPort: 9297,
      reason: 'ECONNREFUSED',
      upstream: '172.18.0.1',
    });
    expect(execFileMock.mock.calls.map((c) => c[1][0])).toEqual(['logs']);
  });

  it('polls until the status line appears', async () => {
    let n = 0;
    execFileMock.mockImplementation((_c: string, a: string[]) =>
      a[0] === 'logs' ? { stdout: ++n < 3 ? '' : 'CDKL-FWD READY x\n' } : { stdout: '' }
    );
    await expect(awaitLoopbackForwarderStatus('fwd')).resolves.toMatchObject({ ok: true });
    expect(n).toBe(3);
  });

  it('removes the forwarder by name and rejects on timeout', async () => {
    execFileMock.mockImplementation(() => ({ stdout: '' }));
    await expect(awaitLoopbackForwarderStatus('fwd', 0)).rejects.toThrow(/did not report/);
    expect(execFileMock.mock.calls.some((c) => c[1].join(' ') === 'rm -f fwd')).toBe(true);
  });
});
