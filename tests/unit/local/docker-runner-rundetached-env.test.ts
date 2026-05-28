import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Capture the execFile invocation so we can assert how runDetached wires
// sensitive env: the credential VALUE must reach docker via the spawned
// process's `options.env` (value-less `-e KEY` in argv), never argv itself.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  // promisify(execFile) calls execFile(cmd, args, options, callback).
  execFile: (
    cmd: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv },
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    execFileMock(cmd, args, options);
    cb(null, { stdout: 'container-id-abc\n', stderr: '' });
  },
  spawn: vi.fn(),
}));

const { runDetached } = await import('../../../src/local/docker-runner.js');

describe('runDetached sensitive-env wiring', () => {
  beforeEach(() => execFileMock.mockReset());

  it('passes AWS credentials via process env, not argv', async () => {
    const id = await runDetached({
      image: 'public.ecr.aws/lambda/nodejs:20',
      mounts: [],
      env: {
        AWS_ACCESS_KEY_ID: 'AKIA-xxx',
        AWS_SECRET_ACCESS_KEY: 'super-secret-value',
        AWS_SESSION_TOKEN: 'sess-tok',
        TABLE_NAME: 'my-table',
      },
      cmd: ['index.handler'],
      hostPort: 9001,
    });

    expect(id).toBe('container-id-abc');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, args, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];

    // Credentials appear as value-less `-e KEY`; their VALUES never in argv.
    const joined = args.join(' ');
    expect(joined).not.toContain('super-secret-value');
    expect(joined).not.toContain('sess-tok');
    expect(joined).not.toContain('AKIA-xxx');
    expect(args).toContain('AWS_SECRET_ACCESS_KEY');
    // Non-sensitive config keeps the inline form.
    expect(args).toContain('TABLE_NAME=my-table');

    // The values are supplied to docker through the spawned process env so
    // docker resolves the value-less `-e KEY` flags.
    expect(options.env).toBeDefined();
    expect(options.env!['AWS_SECRET_ACCESS_KEY']).toBe('super-secret-value');
    expect(options.env!['AWS_SESSION_TOKEN']).toBe('sess-tok');
    // Inherits the parent environment (docker keeps PATH/etc.).
    expect(options.env!['PATH']).toBe(process.env['PATH']);
  });

  it('uses no env option when the container has no sensitive env', async () => {
    await runDetached({
      image: 'public.ecr.aws/lambda/nodejs:20',
      mounts: [],
      env: { TABLE_NAME: 'my-table' },
      cmd: ['index.handler'],
      hostPort: 9002,
    });
    const [, args, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(args).toContain('TABLE_NAME=my-table');
    // No sensitive keys → default inherited-environment behavior (no env opt).
    expect(options.env).toBeUndefined();
  });
});
