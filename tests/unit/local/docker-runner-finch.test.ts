import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Issue #749: under finch on macOS / Windows the value-less `-e KEY` is
// rewritten to `-e KEY=<value>` on the limactl argv. A caller-marked secret is
// refused (unless opted in); the AWS credential set is forwarded with a warning.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
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
const { resetFinchArgvWarningsForTest } = await import('../../../src/utils/docker-cmd.js');
const { getLogger } = await import('../../../src/utils/logger.js');

describe('runDetached under finch on macOS (issue #749)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let savedDocker: string | undefined;
  let savedOptIn: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileMock.mockReset();
    resetFinchArgvWarningsForTest();
    savedDocker = process.env['CDK_DOCKER'];
    savedOptIn = process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    delete process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    process.env['CDK_DOCKER'] = '/opt/homebrew/bin/finch';
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = savedDocker;
    if (savedOptIn === undefined) delete process.env['CDKL_ALLOW_SECRETS_ON_ARGV'];
    else process.env['CDKL_ALLOW_SECRETS_ON_ARGV'] = savedOptIn;
    vi.restoreAllMocks();
  });

  const credsEnv = {
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret-key-value',
    AWS_SESSION_TOKEN: 'session-token-value',
  };

  const withSecret = {
    image: 'public.ecr.aws/lambda/nodejs:20',
    mounts: [],
    env: { ...credsEnv, DB_PASSWORD: 'real-secret', TABLE: 't' },
    sensitiveEnvKeys: new Set(['DB_PASSWORD']),
    cmd: ['index.handler'],
    hostPort: 9000,
  };

  function warnings(): string {
    return warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('refuses a caller-marked secret before spawning anything, naming no value', async () => {
    const err = await runDetached(withSecret).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DockerRunnerError');
    expect(err.message).toMatch(/refusing to forward secret\(s\) DB_PASSWORD under CDK_DOCKER=finch/);
    expect(err.message).toContain('CDKL_ALLOW_SECRETS_ON_ARGV=1');
    for (const v of ['real-secret', 'secret-key-value', 'session-token-value', 'AKIAEXAMPLE']) {
      expect(err.message).not.toContain(v);
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('forwards the secret when opted in, and warns naming keys but not values', async () => {
    process.env['CDKL_ALLOW_SECRETS_ON_ARGV'] = '1';
    await runDetached(withSecret);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const msg = warnings();
    expect(msg).toContain('CDK_DOCKER=finch on macOS / Windows puts the values of');
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'DB_PASSWORD']) {
      expect(msg).toContain(k);
    }
    // A non-sensitive key is not named.
    expect(msg).not.toContain('TABLE');
    for (const v of ['AKIAEXAMPLE', 'secret-key-value', 'session-token-value', 'real-secret']) {
      expect(msg).not.toContain(v);
    }
  });

  it('forwards the AWS credential set with a warning, once per process per key set', async () => {
    const opts = { ...withSecret, env: credsEnv, sensitiveEnvKeys: undefined };
    await runDetached(opts);
    await runDetached(opts);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    const finchWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('CDK_DOCKER=finch'));
    expect(finchWarnings).toHaveLength(1);
    expect(String(finchWarnings[0]![0])).toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('does not refuse for a marked key that is absent from the env', async () => {
    await runDetached({ ...withSecret, env: { ...credsEnv, TABLE: 't' }, sensitiveEnvKeys: new Set(['DB_PASSWORD']) });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('refuses under finch on Windows too', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    process.env['CDK_DOCKER'] = 'C:\\Program Files\\Finch\\bin\\finch.exe';
    await expect(runDetached(withSecret)).rejects.toThrow(/refusing to forward secret/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ['finch on Linux', 'finch', 'linux'],
    ['docker on macOS', 'docker', 'darwin'],
    ['podman on macOS', 'podman', 'darwin'],
    ['a finch wrapper on macOS', '/usr/local/bin/finch-wrapper', 'darwin'],
  ] as const)('neither refuses nor warns for %s', async (_label, docker, platform) => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    process.env['CDK_DOCKER'] = docker;
    await runDetached(withSecret);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(warnings()).not.toContain('CDK_DOCKER=finch');
    // The value-less form is still what is emitted.
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args.join(' ')).not.toContain('real-secret');
  });
});
