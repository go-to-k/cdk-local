import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock the docker boundary so we can assert the published-host-port lookup
// without real Docker. `promisify(execFile)` appends the callback last; mirror
// the ecs-network.test.ts mock shape (return canned stdout, throw to simulate
// a failed inspect).
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: (...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const cmd = rest[0] as string;
    const args = rest[1] as string[];
    // A mocked return of an Error simulates a failed `docker inspect`
    // (promisify rejects). Returning an Error rather than throwing inside the
    // mock avoids a Node 24 + vitest cleanup-hook quirk that surfaces the
    // thrown value as a test failure even though the code catches it.
    const result = execFileMock(cmd, args);
    if (result instanceof Error) {
      cb(result, { stdout: '', stderr: '' });
    } else {
      cb(null, { stdout: (result as string) ?? '', stderr: '' });
    }
  },
  spawn: vi.fn(),
}));

const { getPublishedHostPort } = await import('../../../src/local/docker-inspect.js');

/** The `args` of the most recent docker inspect call. */
function lastArgs(): string[] {
  const calls = execFileMock.mock.calls;
  return (calls[calls.length - 1]?.[1] as string[]) ?? [];
}

describe('getPublishedHostPort', () => {
  beforeEach(() => execFileMock.mockReset());

  it('returns the docker-assigned host port and targets the <port>/tcp key', async () => {
    execFileMock.mockReturnValue('54321\n');
    expect(await getPublishedHostPort('cid', 80)).toBe(54321);
    expect(lastArgs()[0]).toBe('inspect');
    expect(lastArgs().join(' ')).toContain('80/tcp');
  });

  it('returns undefined when the port is not published (empty template output)', async () => {
    execFileMock.mockReturnValue('');
    expect(await getPublishedHostPort('cid', 80)).toBeUndefined();
  });

  it('returns undefined when the value is not a valid port', async () => {
    execFileMock.mockReturnValue('not-a-port\n');
    expect(await getPublishedHostPort('cid', 80)).toBeUndefined();
  });

  it('returns undefined when docker inspect errors (container vanished)', async () => {
    execFileMock.mockReturnValue(new Error('No such object: cid'));
    expect(await getPublishedHostPort('cid', 80)).toBeUndefined();
  });

  it('targets the <port>/udp key when protocol is udp', async () => {
    execFileMock.mockReturnValue('60000\n');
    expect(await getPublishedHostPort('cid', 53, 'udp')).toBe(60000);
    expect(lastArgs().join(' ')).toContain('53/udp');
  });
});
