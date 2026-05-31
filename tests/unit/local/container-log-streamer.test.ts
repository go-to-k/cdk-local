import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Hoisted mock of `node:child_process` — `attachContainerLogStreamer`
// spawns `docker logs -f <id>` and pipes stdout/stderr lines (prefixed)
// to host stdout/stderr. The test substitutes a fake `ChildProcess`
// shape so we can drive the streamer's data handlers + assert the
// process is SIGTERM'd on stop.
//
// Issue #227 review fix (Code #4): the streamer also calls `execFile`
// for a `docker inspect --format='{{.State.Status}}' <id>` probe
// BEFORE respawning. The default `execFileMock` returns `running` so
// the existing soft-reload re-attach tests keep their behavior; a per-
// test override returns `exited` to lock the natural-exit skip path.
const { spawnMock, execFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
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

/**
 * Default `execFile` impl — returns `running` so the existing
 * soft-reload re-attach tests keep their pre-Code-#4 behavior. The
 * status-aware path is exercised by the dedicated test below.
 */
function defaultExecFileImpl(
  _cmd: string,
  _args: readonly string[],
  cb: (err: Error | null, stdout: string, stderr: string) => void
): void {
  cb(null, 'running\n', '');
}

describe('attachContainerLogStreamer', () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockReset();
    execFileMock.mockReset();
    execFileMock.mockImplementation(defaultExecFileImpl);
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
    const [, args, spawnOpts] = spawnMock.mock.calls[0]! as [string, string[], unknown];
    expect(args).toEqual(['logs', '-f', 'cid-xyz']);
    // Issue #227 review fix (Test A1) — `stdio: ['ignore', 'pipe',
    // 'pipe']` is load-bearing. A regression flipping to `'inherit'`
    // would route docker's raw output to the host terminal,
    // bypassing the per-line prefix entirely; this assertion makes
    // that fail loudly.
    expect(spawnOpts).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });

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
    // Issue #227 review fix (Test A2) — emit with `(exitCode, signal)`
    // shape to match Node's real `child_process` exit-event signature.
    first.emit('exit', 0, null);
    // Re-attach is gated behind a short backoff so the daemon's log
    // writer is back. Advance fake timers past it. The status-probe
    // execFile is invoked inside that gap; the default mock returns
    // `running` so the respawn proceeds.
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
    // intent flag, no respawn must happen. Use the real exit-event
    // shape `(exitCode, signal)`.
    first.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(300);

    restoreStdSpies();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  /**
   * Issue #227 review fix — Code #2 + Test G3: at the cap transition
   * (`reattachCount === maxReattaches`), the streamer surfaces ONE
   * warning on stderr naming the prefix + the manual recovery command,
   * and does NOT spawn a 51st `docker logs -f`. Drives 50 unsolicited
   * exit events on the mocked spawn and asserts both invariants.
   */
  it('emits ONE cap-reached warning and stops respawning after 50 re-attaches', async () => {
    vi.useFakeTimers();
    // 51 mocked procs: the initial spawn + 50 respawns. The 51st
    // spawn must NEVER fire — the assertion below catches it as
    // `spawnMock.mock.calls.length`.
    const procs = Array.from({ length: 51 }, () => makeFakeProc().proc);
    procs.forEach((p) => spawnMock.mockReturnValueOnce(p));

    const stop = attachContainerLogStreamer('[svc=Demo r=0 c=app] ', 'cid');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Drive 50 unsolicited exits. Each one ticks `reattachCount` and
    // schedules a respawn through the status-probe + 200ms timer.
    // The status mock returns `running` so the gate falls open.
    for (let i = 0; i < 50; i++) {
      procs[i]!.emit('exit', 0, null);
      // Each exit fires execFile (status probe) → setTimeout(200ms) →
      // spawn. Flush both layers.
      await vi.advanceTimersByTimeAsync(300);
    }

    // After 50 respawns we have 51 spawns total (initial + 50
    // respawns). The 51st child is `procs[50]`. Now drive its exit:
    // the cap is hit, the streamer must emit the warning and NOT
    // spawn a 52nd child.
    const spawnCountAtCap = spawnMock.mock.calls.length;
    expect(spawnCountAtCap).toBe(51);
    const stderrWritesBefore = stderrWrites.length;
    procs[50]!.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(300);
    // No 52nd spawn — cap held.
    expect(spawnMock).toHaveBeenCalledTimes(spawnCountAtCap);
    // Exactly ONE cap-reached warning landed on stderr, with the
    // streamer's prefix verbatim + the manual recovery command.
    const newStderr = stderrWrites.slice(stderrWritesBefore);
    expect(newStderr).toHaveLength(1);
    expect(newStderr[0]).toBe(
      '[svc=Demo r=0 c=app] cdkl: docker logs -f re-attached 50 times; giving up. ' +
        'Run `docker logs -f cid` manually to keep watching.\n'
    );

    stop();
    restoreStdSpies();
    vi.useRealTimers();
  });

  /**
   * Issue #227 review fix — Code #3: `stop()` clears the pending
   * respawn timer so a library host that re-enters the event loop
   * after teardown does not see a 200ms tail. The test queues a
   * respawn (mocked exit → status probe `running` → 200ms timer
   * scheduled), calls `stop()` IMMEDIATELY, then advances 300ms and
   * asserts no second spawn fires.
   */
  it('stop() clears a pending respawn timer (event-loop is not held by a queued setTimeout)', async () => {
    vi.useFakeTimers();
    const { proc: first } = makeFakeProc();
    const { proc: second } = makeFakeProc();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const stop = attachContainerLogStreamer('[p] ', 'cid');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    first.emit('exit', 0, null);
    // Drain execFile's microtask so the status-probe callback runs +
    // queues the setTimeout, but do NOT advance to 200ms yet — that's
    // the window stop() must clear.
    await Promise.resolve();
    await Promise.resolve();

    stop();

    // Even after 300ms (well past the 200ms respawn), no second spawn
    // fires — the cleared timer never queued the new child.
    await vi.advanceTimersByTimeAsync(300);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    restoreStdSpies();
    vi.useRealTimers();
  });

  /**
   * Issue #227 review fix — Code #4: when the container's
   * `State.Status` is in a terminal value (`exited` / `dead` /
   * `removing`), the streamer does NOT respawn — the natural-exit
   * path is the service-runner's cleanup ~1s later, so respawning
   * is wasted work + a spurious cap-reached tick. The test sets the
   * status mock to `exited` and asserts no second spawn fires.
   */
  it('does NOT respawn when docker inspect reports the container is `exited` (natural-exit skip)', async () => {
    vi.useFakeTimers();
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: readonly string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => cb(null, 'exited\n', '')
    );
    const { proc: first } = makeFakeProc();
    spawnMock.mockReturnValueOnce(first);

    const stop = attachContainerLogStreamer('[p] ', 'cid');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    first.emit('exit', 0, null);
    // Even after 300ms (past the 200ms respawn budget) the streamer
    // skipped the respawn because the container is terminal.
    await vi.advanceTimersByTimeAsync(300);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    stop();
    restoreStdSpies();
    vi.useRealTimers();
  });

  /**
   * Issue #227 review fix — Code #4 (cont.): `dead` and `removing`
   * are also terminal states. Verify the gate covers both.
   */
  it('does NOT respawn when docker inspect reports `dead` or `removing` (terminal-state coverage)', async () => {
    for (const status of ['dead', 'removing']) {
      vi.useFakeTimers();
      spawnMock.mockReset();
      execFileMock.mockReset();
      execFileMock.mockImplementation(
        (
          _cmd: string,
          _args: readonly string[],
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => cb(null, `${status}\n`, '')
      );
      const { proc: first } = makeFakeProc();
      spawnMock.mockReturnValueOnce(first);

      const stop = attachContainerLogStreamer('[p] ', 'cid');
      first.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(300);
      expect(spawnMock, `${status} status must skip respawn`).toHaveBeenCalledTimes(1);

      stop();
      vi.useRealTimers();
    }
    restoreStdSpies();
  });

  /**
   * Issue #227 review fix — Code #4 (fall-open): an inspect failure
   * treats the container as still alive (best-effort). Locks the
   * fail-open so a flaky docker daemon does NOT silently kill the
   * soft-reload re-attach path.
   */
  it('falls open and respawns when docker inspect errors (status unknown → assume alive)', async () => {
    vi.useFakeTimers();
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: readonly string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => cb(new Error('docker daemon unavailable'), '', '')
    );
    const { proc: first } = makeFakeProc();
    const { proc: second } = makeFakeProc();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const stop = attachContainerLogStreamer('[p] ', 'cid');
    first.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(300);
    // Inspect errored, so the streamer fell open and respawned.
    expect(spawnMock).toHaveBeenCalledTimes(2);

    stop();
    restoreStdSpies();
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
