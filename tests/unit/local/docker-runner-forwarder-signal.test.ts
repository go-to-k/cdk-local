import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// A SIGINT / SIGTERM during the loopback forwarder's readiness wait: runDetached
// has not returned the workload's id yet, so the caller's own signal cleanup
// cannot remove it. The forwarder attach removes the workload and the
// forwarder itself, synchronously, and keeps Node's exit-on-signal default
// when nothing else listens.
const { execFileMock, execFileSyncMock, gate } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  gate: { reported: false, logsPolled: () => undefined as void },
}));

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      e: Error | null,
      r: { stdout: string; stderr: string }
    ) => void;
    const out = execFileMock(cmd, args) as { stdout?: string } | undefined;
    cb(null, { stdout: out?.stdout ?? '', stderr: '' });
  },
  execFileSync: execFileSyncMock,
  spawn: vi.fn(),
}));

const { attachLoopbackForwarder, runDetached } = await import('../../../src/local/docker-runner.js');
const { resetWorkloadAwsWiringForTest, setActiveWorkloadAwsWiring } = await import(
  '../../../src/local/workload-aws-wiring.js'
);
const { resetLoopbackForwarderForTest } = await import('../../../src/local/loopback-forwarder.js');
type Wiring = import('../../../src/local/workload-aws-wiring.js').WorkloadAwsWiring;

const wiring: Wiring = {
  mode: 'emulator',
  emulatorEndpoint: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
  env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297' },
  scrubEnvKeys: [],
  mounts: [],
  loopbackPorts: [9297],
  probeHealth: false,
  dispose: () => undefined,
};

let polled: Promise<void>;

beforeEach(() => {
  execFileMock.mockReset();
  execFileSyncMock.mockReset();
  resetWorkloadAwsWiringForTest();
  resetLoopbackForwarderForTest();
  gate.reported = false;
  polled = new Promise((resolve) => {
    gate.logsPolled = resolve;
  });
  // `docker run -d` of the workload prints its id; the forwarder's logs stay
  // empty (readiness pending) until the test lets it report.
  execFileMock.mockImplementation((_c: string, a: string[]) => {
    if (a[0] === 'run' && !a.includes('--pid')) return { stdout: 'wl-id\n' };
    if (a[0] === 'logs') {
      gate.logsPolled();
      return { stdout: gate.reported ? 'CDKL-FWD READY 192.168.65.254\n' : '' };
    }
    return { stdout: '' };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetWorkloadAwsWiringForTest();
});

/** Run `fn` with the suite runner's own `signal` listeners hidden. */
async function withoutRunnerListeners(signal: NodeJS.Signals, fn: () => Promise<void>): Promise<void> {
  const saved = process.listeners(signal);
  for (const l of saved) process.off(signal, l);
  try {
    await fn();
  } finally {
    for (const l of saved) process.on(signal, l);
  }
}

function forwarderName(): string {
  const run = execFileMock.mock.calls.find((c) => (c[1] as string[]).includes('--pid'));
  const args = run![1] as string[];
  return args[args.indexOf('--name') + 1]!;
}

describe('signal during the loopback forwarder readiness wait', () => {
  it('SIGINT with no other listener: removes the workload and the forwarder, then exits 130', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await withoutRunnerListeners('SIGINT', async () => {
      setActiveWorkloadAwsWiring(wiring);
      const run = runDetached({
        image: 'img',
        mounts: [],
        env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297' },
        cmd: [],
        hostPort: 9001,
      });
      await polled;
      process.emit('SIGINT');
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      const [, argv] = execFileSyncMock.mock.calls[0] as [string, string[]];
      expect(argv).toEqual(['rm', '-f', 'wl-id', forwarderName()]);
      expect(exit).toHaveBeenCalledWith(130);
      gate.reported = true;
      await run;
      expect(process.listenerCount('SIGINT')).toBe(0);
    });
  });

  it('SIGTERM while the command has its own handler: removes both, leaves the exit to that handler', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const own = vi.fn();
    await withoutRunnerListeners('SIGTERM', async () => {
      process.on('SIGTERM', own);
      try {
        const attach = attachLoopbackForwarder('wl-id', wiring, [9297]);
        await polled;
        process.emit('SIGTERM');
        expect(own).toHaveBeenCalledTimes(1);
        expect((execFileSyncMock.mock.calls[0] as [string, string[]])[1]).toEqual([
          'rm',
          '-f',
          'wl-id',
          forwarderName(),
        ]);
        expect(exit).not.toHaveBeenCalled();
        gate.reported = true;
        await attach;
      } finally {
        process.off('SIGTERM', own);
      }
    });
  });

  it('concurrent waits share one listener: one SIGINT removes every workload and exits 130', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await withoutRunnerListeners('SIGINT', async () => {
      const a = attachLoopbackForwarder('wl-a', wiring, [9297]);
      const b = attachLoopbackForwarder('wl-b', wiring, [9297]);
      await polled;
      expect(process.listenerCount('SIGINT')).toBe(1);
      process.emit('SIGINT');
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      const argv = (execFileSyncMock.mock.calls[0] as [string, string[]])[1];
      expect(argv.slice(0, 2)).toEqual(['rm', '-f']);
      expect(argv).toEqual(expect.arrayContaining(['wl-a', 'wl-b']));
      expect(argv).toHaveLength(6);
      expect(exit).toHaveBeenCalledWith(130);
      gate.reported = true;
      await Promise.all([a, b]);
      expect(process.listenerCount('SIGINT')).toBe(0);
    });
  });

  it('SIGTERM with no other listener exits 143', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await withoutRunnerListeners('SIGTERM', async () => {
      const attach = attachLoopbackForwarder('wl-id', wiring, [9297]);
      await polled;
      process.emit('SIGTERM');
      expect(exit).toHaveBeenCalledWith(143);
      gate.reported = true;
      await attach;
    });
  });

  it('removes its listeners once the forwarder is ready; a later signal removes nothing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await withoutRunnerListeners('SIGINT', async () => {
      gate.reported = true;
      await attachLoopbackForwarder('wl-id', wiring, [9297]);
      expect(process.listenerCount('SIGINT')).toBe(0);
      expect(process.listenerCount('SIGTERM')).toBeLessThanOrEqual(1); // the runner's own
      const probe = vi.fn();
      process.on('SIGINT', probe);
      try {
        process.emit('SIGINT');
      } finally {
        process.off('SIGINT', probe);
      }
      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });
  });

  it('removes its listeners when the forwarder fails to start', async () => {
    await withoutRunnerListeners('SIGINT', async () => {
      execFileMock.mockImplementation((_c: string, a: string[]) =>
        a[0] === 'logs' ? { stdout: 'CDKL-FWD FAIL 9297 ECONNREFUSED 192.168.65.254\n' } : { stdout: '' }
      );
      await expect(attachLoopbackForwarder('wl-id', wiring, [9297])).rejects.toThrow(/9297/);
      expect(process.listenerCount('SIGINT')).toBe(0);
    });
  });
});
