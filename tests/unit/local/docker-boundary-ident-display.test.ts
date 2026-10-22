import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// #761: docker's own stderr is escaped (displayToolOutput) before it is folded
// into a thrown message, and an assembly-chosen image reference renders
// through displayIdent. Expected strings are written by hand.

const { execFailure, streamMock, foregroundMock } = vi.hoisted(() => ({
  execFailure: { verb: '', stderr: '' },
  streamMock: vi.fn(),
  foregroundMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    optsOrCb: unknown,
    maybeCb?: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void;
    if (execFailure.verb !== '' && args.join(' ').startsWith(execFailure.verb)) {
      cb(Object.assign(new Error('Command failed'), { code: 1, stderr: execFailure.stderr }));
      return;
    }
    cb(null, { stdout: 'id\n', stderr: '' });
  },
  spawn: vi.fn(),
}));
vi.mock('../../../src/utils/docker-cmd.js', async (importActual) => ({
  ...(await importActual<object>()),
  runDockerStreaming: streamMock,
  runDockerForeground: foregroundMock,
}));

const { pullImage, runDetached } = await import('../../../src/local/docker-runner.js');
const { createTaskNetwork } = await import('../../../src/local/ecs-network.js');
const { getLogger } = await import('../../../src/utils/logger.js');

// ESC [ 2 K, then CR: the sequence that erases and rewrites a terminal line.
const FORGED_STDERR = 'denied\u001b[2K\rINFO all good';
const ESCAPED_STDERR = 'denied\\u001b[2K\\u000dINFO all good';

beforeEach(() => {
  execFailure.verb = '';
  execFailure.stderr = '';
  streamMock.mockReset();
  foregroundMock.mockReset();
});

describe('docker pull failure messages (#761)', () => {
  const nonZero = (stderr: string) =>
    Object.assign(new Error('x'), { exitCode: 1, stderr, stdout: '' });

  it('exit-code form: plain image bare, stderr escaped', async () => {
    streamMock.mockRejectedValue(nonZero(FORGED_STDERR));
    await expect(pullImage('public.ecr.aws/lambda/nodejs:20', false)).rejects.toThrow(
      `docker pull public.ecr.aws/lambda/nodejs:20 exited with code 1: ${ESCAPED_STDERR}`
    );
  });

  it('exit-code form: forging image as one JSON literal', async () => {
    streamMock.mockRejectedValue(nonZero('boom'));
    await expect(pullImage("img' x", false)).rejects.toThrow(
      `docker pull "img' x" exited with code 1: boom`
    );
  });

  it('spawn-failure form (no exit code): message escaped', async () => {
    streamMock.mockRejectedValue(new Error(FORGED_STDERR));
    await expect(pullImage('img:1', false)).rejects.toThrow(
      `docker pull img:1 failed: ${ESCAPED_STDERR}`
    );
  });

  it('debug-level foreground form: plain bare, forging quoted', async () => {
    const logger = getLogger();
    const prev = logger.getLevel();
    logger.setLevel('debug');
    try {
      foregroundMock.mockRejectedValue(new Error('nope'));
      await expect(pullImage('img:1', false)).rejects.toThrow('docker pull img:1 failed: nope');
      await expect(pullImage("img' x", false)).rejects.toThrow(`docker pull "img' x" failed: nope`);
    } finally {
      logger.setLevel(prev);
    }
  });
});

describe('docker run failure stderr (#761)', () => {
  it('escapes control characters in docker run stderr', async () => {
    execFailure.verb = 'run';
    execFailure.stderr = FORGED_STDERR;
    await expect(
      runDetached({ image: 'img:1', mounts: [], env: {}, cmd: [], hostPort: 9001 })
    ).rejects.toThrow(`docker run failed: ${ESCAPED_STDERR}`);
  });

  it('leaves a plain stderr unchanged', async () => {
    execFailure.verb = 'run';
    execFailure.stderr = 'port is already allocated';
    await expect(
      runDetached({ image: 'img:1', mounts: [], env: {}, cmd: [], hostPort: 9001 })
    ).rejects.toThrow('docker run failed: port is already allocated');
  });
});

describe('docker network create failure stderr (#761)', () => {
  it('escapes control characters, keeps a plain message unchanged', async () => {
    execFailure.verb = 'network create';
    execFailure.stderr = FORGED_STDERR;
    await expect(createTaskNetwork()).rejects.toThrow(
      `docker network create failed: ${ESCAPED_STDERR}. Hint:`
    );
    execFailure.stderr = 'Pool overlaps';
    await expect(createTaskNetwork()).rejects.toThrow(
      'docker network create failed: Pool overlaps. Hint:'
    );
  });
});
