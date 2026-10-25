import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Capture the execFile invocation to assert the published `-p host:hostPort:containerPort`.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    options: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    execFileMock(cmd, args, options);
    cb(null, { stdout: 'cid\n', stderr: '' });
  },
  spawn: vi.fn(),
}));

const { runDetached } = await import('../../../src/local/docker-runner.js');

function publishArg(): string {
  const [, args] = execFileMock.mock.calls[0] as [string, string[], unknown];
  const i = args.indexOf('-p');
  return args[i + 1] as string;
}

describe('runDetached container-port publishing', () => {
  beforeEach(() => execFileMock.mockReset());

  it('defaults the container port to 8080 (Lambda RIE / AgentCore HTTP)', async () => {
    await runDetached({
      image: 'img',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 9100,
      host: '127.0.0.1',
    });
    expect(publishArg()).toBe('127.0.0.1:9100:8080');
  });

  it('publishes to the given container port (8000 for an MCP runtime)', async () => {
    await runDetached({
      image: 'img',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 9200,
      host: '127.0.0.1',
      containerPort: 8000,
    });
    expect(publishArg()).toBe('127.0.0.1:9200:8000');
  });

  const argv = (): string[] => (execFileMock.mock.calls[0] as [string, string[], unknown])[1];

  it('runs with --rm by default', async () => {
    await runDetached({ image: 'img', mounts: [], env: {}, cmd: [], hostPort: 1 });
    expect(argv().slice(0, 3)).toEqual(['run', '-d', '--rm']);
  });

  it('omits --rm when autoRemove is false (start-web-function keeps boot-crash logs)', async () => {
    await runDetached({ image: 'img', mounts: [], env: {}, cmd: [], hostPort: 1, autoRemove: false });
    expect(argv().slice(0, 2)).toEqual(['run', '-d']);
    expect(argv()).not.toContain('--rm');
  });
});
