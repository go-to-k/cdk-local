import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Hoisted mock of `node:child_process` — `attachContainerLogStreamer`
// spawns `docker logs -f <id>` and pipes stdout/stderr lines (prefixed)
// to host stdout/stderr. The test substitutes a fake `ChildProcess`
// shape so we can drive the streamer's data handlers + assert the
// process is SIGTERM'd on stop.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

const { attachContainerLogStreamer, writePrefixedLines } = await import(
  '../../../src/local/container-log-streamer.js'
);

/**
 * Build a fake `ChildProcess` shape with `stdout` / `stderr` PassThrough
 * streams, an injectable `killed` flag flipped by `kill`, and the
 * `EventEmitter` surface `attachContainerLogStreamer` relies on.
 */
function makeFakeProc(): {
  proc: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: (signal: string) => void;
  };
  killSpy: ReturnType<typeof vi.fn>;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: (signal: string) => void;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  const killSpy = vi.fn((_signal: string) => {
    proc.killed = true;
  });
  proc.kill = killSpy;
  return { proc, killSpy };
}

describe('attachContainerLogStreamer', () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockReset();
    stdoutWrites = [];
    stderrWrites = [];
    // Capture writes to process.stdout / process.stderr without
    // touching the host terminal. Cast to any to satisfy the
    // multi-overload write signature.
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stdoutWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      }) as unknown as (typeof process.stdout)['write']);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      }) as unknown as (typeof process.stderr)['write']);
  });

  function restoreStdSpies(): void {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  it('spawns `docker logs -f <id>` and prefixes each emitted stdout line', async () => {
    const { proc } = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const stop = attachContainerLogStreamer('[svc=BackendApi r=0 c=AppContainer] ', 'cid-xyz');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0]! as [string, string[], unknown];
    expect(args).toEqual(['logs', '-f', 'cid-xyz']);

    proc.stdout.write('hello world\nready on :3000\n');
    // PassThrough is sync but the listener may schedule on nextTick;
    // a microtask flush is enough.
    await Promise.resolve();

    stop();
    restoreStdSpies();

    expect(stdoutWrites).toEqual([
      '[svc=BackendApi r=0 c=AppContainer] hello world\n',
      '[svc=BackendApi r=0 c=AppContainer] ready on :3000\n',
    ]);
  });

  it('buffers a partial stdout line until the trailing `\\n` arrives', async () => {
    const { proc } = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const stop = attachContainerLogStreamer('[p] ', 'cid');

    proc.stdout.write('part-');
    await Promise.resolve();
    expect(stdoutWrites).toEqual([]);

    proc.stdout.write('one\npart-two\n');
    await Promise.resolve();

    stop();
    restoreStdSpies();

    expect(stdoutWrites).toEqual(['[p] part-one\n', '[p] part-two\n']);
  });

  it('routes stderr lines to process.stderr (not stdout)', async () => {
    const { proc } = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const stop = attachContainerLogStreamer('[p] ', 'cid');

    proc.stderr.write('warning: deprecated\n');
    await Promise.resolve();

    stop();
    restoreStdSpies();

    expect(stderrWrites).toEqual(['[p] warning: deprecated\n']);
    expect(stdoutWrites).toEqual([]);
  });

  it('stop() drains the tail and SIGTERMs the process', async () => {
    const { proc, killSpy } = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const stop = attachContainerLogStreamer('[p] ', 'cid');

    // Tail with no terminator (the container's last output before
    // shutdown often lacks the trailing newline).
    proc.stdout.write('no-newline');
    proc.stderr.write('partial-err');
    await Promise.resolve();

    stop();
    restoreStdSpies();

    expect(stdoutWrites).toEqual(['[p] no-newline\n']);
    expect(stderrWrites).toEqual(['[p] partial-err\n']);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop() is safe to call twice (no second kill on an already-killed proc)', async () => {
    const { proc, killSpy } = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const stop = attachContainerLogStreamer('[p] ', 'cid');

    stop();
    stop();
    restoreStdSpies();

    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows a `proc.error` event so a docker-cli foot-gun never throws into the caller', () => {
    const { proc } = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const stop = attachContainerLogStreamer('[p] ', 'cid');
    // Emitting `error` on an EventEmitter without a listener throws.
    // attachContainerLogStreamer must register a no-op listener — assert
    // by checking the emit does not throw.
    expect(() => proc.emit('error', new Error('docker not found'))).not.toThrow();

    stop();
    restoreStdSpies();
  });

  it('re-attaches `docker logs -f --since 0s` when the child exits unsolicited (soft-reload `docker restart` case)', async () => {
    // Issue #227 + #214 — the docker daemon terminates `docker logs -f`
    // on the container PID-1 exit. `docker restart` (the Phase-4
    // soft-reload primitive) cycles PID-1 even though the container ID
    // is preserved, so the streamer must respawn against the SAME id
    // to capture the post-restart output. Use `--since 0s` so the
    // pre-restart history is not re-emitted to the foreground.
    vi.useFakeTimers();
    const { proc: first } = makeFakeProc();
    const { proc: second } = makeFakeProc();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const stop = attachContainerLogStreamer('[p] ', 'cid');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, firstArgs] = spawnMock.mock.calls[0]! as [string, string[]];
    expect(firstArgs).toEqual(['logs', '-f', 'cid']);

    // Simulate `docker restart` — daemon closes the follow stream.
    first.emit('exit', 0);
    // Re-attach is gated behind a short backoff so the daemon's log
    // writer is back. Advance fake timers past it.
    await vi.advanceTimersByTimeAsync(300);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [, secondArgs] = spawnMock.mock.calls[1]! as [string, string[]];
    expect(secondArgs).toEqual(['logs', '-f', '--since', '0s', 'cid']);

    // The new child carries the new PID-1's output; the prefix is the
    // same so the foreground reader sees an uninterrupted stream.
    second.stdout.write('post-restart-line\n');
    await Promise.resolve();
    stop();
    restoreStdSpies();
    expect(stdoutWrites).toContain('[p] post-restart-line\n');
    vi.useRealTimers();
  });

  it('does NOT respawn after stop() (intentional teardown is honored)', async () => {
    vi.useFakeTimers();
    const { proc: first } = makeFakeProc();
    spawnMock.mockReturnValueOnce(first);

    const stop = attachContainerLogStreamer('[p] ', 'cid');
    stop();
    // Even if the daemon delivers the exit event AFTER stop() flips the
    // intent flag, no respawn must happen.
    first.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(300);

    restoreStdSpies();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('writePrefixedLines (helper)', () => {
  it('writes every complete line prefixed and returns the trailing partial', () => {
    const writes: string[] = [];
    const out = {
      write: (chunk: string): boolean => {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const remainder = writePrefixedLines('[p] ', 'one\ntwo\nthr', out);

    expect(writes).toEqual(['[p] one\n', '[p] two\n']);
    expect(remainder).toBe('thr');
  });

  it('returns the original buffer unchanged when no `\\n` is present', () => {
    const out = { write: vi.fn() } as unknown as NodeJS.WritableStream;
    const remainder = writePrefixedLines('[p] ', 'no-newline', out);
    expect(remainder).toBe('no-newline');
    expect(out.write).not.toHaveBeenCalled();
  });
});
