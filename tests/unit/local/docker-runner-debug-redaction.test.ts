import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdk-local#794: the `docker run` debug line masks EVERY `-e` value
// (a literal template env value or an `--env-vars` override is where a local
// secret sits), and a failure with an empty stderr never falls back to
// execFile's `err.message`, which carries the whole argv.
const { behaviour } = vi.hoisted(() => ({
  behaviour: { fail: false },
}));

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _options: unknown,
    cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    if (behaviour.fail) {
      const err = Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
        code: 125,
        stderr: '',
      });
      cb(err);
      return;
    }
    cb(null, { stdout: 'container-id\n', stderr: '' });
  },
  spawn: vi.fn(),
}));

const { runDetached } = await import('../../../src/local/docker-runner.js');
const { getLogger } = await import('../../../src/utils/logger.js');
const { describeExitWithoutArgv } = await import('../../../src/utils/docker-argv-redaction.js');

const SECRET = 'local-db-password-SENTINEL';
const opts = {
  image: 'public.ecr.aws/lambda/nodejs:20',
  mounts: [],
  env: { DB_PASSWORD: SECRET, TABLE_NAME: 'my-table' },
  cmd: ['index.handler'],
  hostPort: 9001,
};

afterEach(() => {
  behaviour.fail = false;
  vi.restoreAllMocks();
});

describe('docker run debug line', () => {
  it('masks a non-credential -e value and keeps its key', async () => {
    const lines: string[] = [];
    vi.spyOn(getLogger(), 'child').mockReturnValue({
      debug: (m: string) => lines.push(m),
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never);
    await runDetached(opts as never);
    const line = lines.find((l) => l.includes(' run '));
    expect(line, 'the docker run debug line was not logged').toBeDefined();
    expect(line).toContain('DB_PASSWORD=***');
    expect(line).toContain('TABLE_NAME=***');
    expect(line).not.toContain(SECRET);
  });

  it('does not put the argv into the error when stderr is empty', async () => {
    behaviour.fail = true;
    const err = await runDetached(opts as never).catch((e: unknown) => e);
    expect((err as Error).message).toContain('docker run failed: exited with code 125');
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe('describeExitWithoutArgv', () => {
  it.each([
    [{ code: 1 }, 'exited with code 1'],
    [{ signal: 'SIGKILL' }, 'killed by SIGKILL'],
    [{ code: 'ENOENT' }, 'failed (ENOENT)'],
    [new Error('Command failed: docker run -e K=V'), 'failed with no output'],
  ])('%o -> %s', (input, expected) => {
    expect(describeExitWithoutArgv(input)).toBe(expected);
  });
});
