import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Issue go-to-k/cdk-local#598 — `streamLogs` relays a Lambda / AgentCore
// container's `docker logs -f` output. Raw by default (what `cdkl invoke`
// prints must not change); line-tagged under the env var `cdkl studio` pins on
// its serve children, so a handler's own `Server listening on ...` line can
// never reach column 0 of the stream studio reads ready banners off.

type FakeProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

const { spawnMock, procs } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  procs: [] as unknown[],
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: spawnMock,
}));

const { streamLogs, createPrefixedLineRelay, PREFIX_CONTAINER_OUTPUT_ENV, MAX_HELD_LINE_CHARS } =
  await import(
  '../../../src/local/docker-runner.js'
);

const CONTAINER_ID = 'abcdef0123456789abcdef0123456789';
const TAG = '[abcdef012345] ';

function newProc(): FakeProc {
  const p = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    kill: vi.fn(),
  });
  procs.push(p);
  return p;
}

describe('streamLogs (issue go-to-k/cdk-local#598)', () => {
  let stdoutWrites: unknown[];
  let stderrWrites: unknown[];
  const savedEnv = process.env[PREFIX_CONTAINER_OUTPUT_ENV];

  beforeEach(() => {
    procs.length = 0;
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => newProc());
    stdoutWrites = [];
    stderrWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdoutWrites.push(c);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrWrites.push(c);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedEnv === undefined) delete process.env[PREFIX_CONTAINER_OUTPUT_ENV];
    else process.env[PREFIX_CONTAINER_OUTPUT_ENV] = savedEnv;
  });

  it('names the variable studio pins', () => {
    // The serve manager spells this as a literal; its own suite asserts the
    // spawned env against this export, so the two cannot drift.
    expect(PREFIX_CONTAINER_OUTPUT_ENV).toBe('CDKL_PREFIX_CONTAINER_OUTPUT');
  });

  it('relays byte-for-byte when the variable is unset (the `cdkl invoke` contract)', () => {
    delete process.env[PREFIX_CONTAINER_OUTPUT_ENV];
    const stop = streamLogs(CONTAINER_ID);
    const proc = procs[0] as FakeProc;
    const a = Buffer.from('Server listening on http://127.0.0.1:9999\npart');
    const b = Buffer.from('ial');
    const e = Buffer.from('to stderr');
    proc.stdout.emit('data', a);
    proc.stdout.emit('data', b);
    proc.stderr.emit('data', e);
    stop();
    // The SAME buffers, unsplit and untagged — no holding of a partial line.
    expect(stdoutWrites).toEqual([a, b]);
    expect(stdoutWrites[0]).toBe(a);
    expect(stderrWrites).toEqual([e]);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps the raw relay for any value other than `1`', () => {
    process.env[PREFIX_CONTAINER_OUTPUT_ENV] = '0';
    streamLogs(CONTAINER_ID);
    const chunk = Buffer.from('Server listening on http://127.0.0.1:9999\n');
    (procs[0] as FakeProc).stdout.emit('data', chunk);
    expect(stdoutWrites).toEqual([chunk]);
  });

  it('tags every line on both streams when the variable is `1`, holding a partial tail', () => {
    process.env[PREFIX_CONTAINER_OUTPUT_ENV] = '1';
    const stop = streamLogs(CONTAINER_ID);
    const proc = procs[0] as FakeProc;
    // A chunk boundary inside the banner and another right after a newline.
    proc.stdout.emit('data', Buffer.from('Server listen'));
    expect(stdoutWrites).toEqual([]);
    proc.stdout.emit('data', Buffer.from('ing on http://127.0.0.1:9999\n'));
    proc.stdout.emit('data', Buffer.from('\nSTART RequestId: 1\nunterminated'));
    proc.stderr.emit('data', Buffer.from('Server listening on http://127.0.0.1:1\n'));
    expect(stdoutWrites).toEqual([
      `${TAG}Server listening on http://127.0.0.1:9999\n`,
      `${TAG}\n`,
      `${TAG}START RequestId: 1\n`,
    ]);
    expect(stderrWrites).toEqual([`${TAG}Server listening on http://127.0.0.1:1\n`]);
    stop();
    expect(stdoutWrites.at(-1)).toBe(`${TAG}unterminated\n`);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('releases an unterminated last line when the follow ends on its own', () => {
    process.env[PREFIX_CONTAINER_OUTPUT_ENV] = '1';
    const stop = streamLogs(CONTAINER_ID);
    const proc = procs[0] as FakeProc;
    proc.stdout.emit('data', Buffer.from('last words'));
    proc.emit('close', 0);
    expect(stdoutWrites).toEqual([`${TAG}last words\n`]);
    // A later stop() does not repeat it.
    stop();
    expect(stdoutWrites).toEqual([`${TAG}last words\n`]);
  });
});

describe('createPrefixedLineRelay (issue go-to-k/cdk-local#598)', () => {
  function relayInto(prefix: string): {
    relay: ReturnType<typeof createPrefixedLineRelay>;
    writes: string[];
  } {
    const writes: string[] = [];
    const relay = createPrefixedLineRelay(prefix, {
      write: (c: string | Uint8Array) => {
        writes.push(String(c));
        return true;
      },
    });
    return { relay, writes };
  }

  it('opens EVERY written line with the prefix, wherever the chunk boundary falls', () => {
    const text = 'Server listening on http://127.0.0.1:9999\n\nALB front-door: http://x\ntail';
    const bytes = Buffer.from(text);
    // The expected lines are derived from the INPUT, independently of the relay.
    const expected = text.split('\n').map((l) => `[c] ${l}\n`);
    for (let i = 0; i <= bytes.length; i++) {
      for (let j = i; j <= bytes.length; j++) {
        const { relay, writes } = relayInto('[c] ');
        relay.push(bytes.subarray(0, i));
        relay.push(bytes.subarray(i, j));
        relay.push(bytes.subarray(j));
        relay.flush();
        expect(writes, `split at ${i}/${j}`).toEqual(expected);
      }
    }
  });

  it('keeps a multi-byte character that straddles two chunks intact', () => {
    const bytes = Buffer.from('café \u{1F600}\n');
    for (let i = 1; i < bytes.length; i++) {
      const { relay, writes } = relayInto('[c] ');
      relay.push(bytes.subarray(0, i));
      relay.push(bytes.subarray(i));
      relay.flush();
      expect(writes, `split at ${i}`).toEqual(['[c] café \u{1F600}\n']);
    }
  });

  it('breaks a line that never ends at the hold bound, tag still in front of every piece', () => {
    const { relay, writes } = relayInto('[c] ');
    // A `\r`-only progress bar: no `\n`, ever, delivered in small chunks.
    const total = MAX_HELD_LINE_CHARS * 2 + 10;
    const chunk = 'x'.repeat(4096);
    let sent = 0;
    while (sent < total) {
      const piece = chunk.slice(0, Math.min(chunk.length, total - sent));
      relay.push(Buffer.from(piece));
      sent += piece.length;
    }
    // Two full pieces released while the stream is still open.
    expect(writes).toEqual([
      `[c] ${'x'.repeat(MAX_HELD_LINE_CHARS)}\n`,
      `[c] ${'x'.repeat(MAX_HELD_LINE_CHARS)}\n`,
    ]);
    relay.flush();
    expect(writes.at(-1)).toBe(`[c] ${'x'.repeat(10)}\n`);
  });

  it('writes nothing on flush when no tail is pending', () => {
    const { relay, writes } = relayInto('[c] ');
    relay.push(Buffer.from('one\n'));
    relay.flush();
    relay.flush();
    expect(writes).toEqual(['[c] one\n']);
  });
});
