import { describe, it, expect, vi, beforeEach, afterAll } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Issue #660 — the soft-reload / rolling readiness check runs INSIDE the
 * container (`docker exec <id> sh -c <script> sh <port>`), because on
 * Docker Desktop the host cannot route to a container's docker-network
 * IP. Two halves are locked here:
 *
 *   - `LISTEN_PROBE_SCRIPT` itself, run by a real `sh` against fixture
 *     `/proc/net/tcp{,6}` files (the paths are swapped for temp files).
 *   - `dockerExecListenProbe`'s exit-code mapping, with `execFile` mocked
 *     so no docker is needed.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    calls: [] as Array<{ cmd: string; args: string[] }>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outcome: null as any,
    onCall: undefined as ((opts: unknown) => void) | undefined,
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], opts: unknown, cb: (...a: unknown[]) => void) => {
      hoisted.calls.push({ cmd, args });
      hoisted.onCall?.(opts);
      if (hoisted.outcome === null) cb(null, { stdout: '', stderr: '' });
      else cb(hoisted.outcome);
    },
  };
});

const { LISTEN_PROBE_SCRIPT, dockerExecListenProbe } = await import(
  '../../../src/local/ecs-service-runner.js'
);

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
function row(local: string, st: string): string {
  return `   0: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000     0        0 1 1 0 100 0 0 10 0`;
}

const dir = mkdtempSync(join(tmpdir(), 'cdkl-listen-probe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run the script with `/proc/net/tcp{,6}` swapped for fixture files; returns the exit code. */
function runScript(port: number, tcp: string[] | undefined, tcp6: string[] | undefined): number {
  const f4 = join(dir, `tcp-${Math.random().toString(36).slice(2)}`);
  const f6 = `${f4}-6`;
  if (tcp) writeFileSync(f4, [HEADER, ...tcp].join('\n') + '\n');
  if (tcp6) writeFileSync(f6, [HEADER, ...tcp6].join('\n') + '\n');
  // Replace tcp6 FIRST: '/proc/net/tcp' is a prefix of it.
  const script = LISTEN_PROBE_SCRIPT.replaceAll('/proc/net/tcp6', f6).replaceAll('/proc/net/tcp', f4);
  try {
    execFileSync('sh', ['-c', script, 'sh', String(port)], { stdio: 'ignore' });
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

describe('LISTEN_PROBE_SCRIPT (issue #660)', () => {
  it('exits 0 for a wildcard IPv4 listener on the port (8080 = 1F90)', () => {
    expect(runScript(8080, [row('00000000:1F90', '0A')], undefined)).toBe(0);
  });

  it('exits 0 for a listener bound to the container address', () => {
    // 169.254.171.3 in host byte order
    expect(runScript(8080, [row('03ABFEA9:1F90', '0A')], undefined)).toBe(0);
  });

  it('exits 0 for a dual-stack IPv6 wildcard listener (tcp6 only)', () => {
    expect(runScript(8080, [], [row('00000000000000000000000000000000:1F90', '0A')])).toBe(0);
  });

  it('exits 3 while nothing listens on the port: another port, or a non-LISTEN state', () => {
    expect(
      runScript(
        8080,
        [row('00000000:0050', '0A'), row('03ABFEA9:1F90', '01'), row('03ABFEA9:1F90', '06')],
        [row('00000000000000000000000000000000:1F91', '0A')]
      )
    ).toBe(3);
  });

  it('exits 3 for an IPv4-mapped loopback bind (::ffff:127.0.0.1) in tcp6', () => {
    expect(runScript(8080, [], [row('0000000000000000FFFF00000100007F:1F90', '0A')])).toBe(3);
    // ...while an IPv4-mapped NON-loopback address is reachable.
    expect(runScript(8080, [], [row('0000000000000000FFFF000003ABFEA9:1F90', '0A')])).toBe(0);
  });

  it('exits 3 for a loopback-only bind (no peer can reach it), IPv4 and IPv6', () => {
    expect(runScript(8080, [row('0100007F:1F90', '0A'), row('0200007F:1F90', '0A')], undefined)).toBe(
      3
    );
    expect(runScript(8080, [], [row('00000000000000000000000001000000:1F90', '0A')])).toBe(3);
  });

  it('pads the port to 4 hex digits (port 80 = 0050), never matching a longer one', () => {
    expect(runScript(80, [row('00000000:0050', '0A')], undefined)).toBe(0);
    expect(runScript(80, [row('00000000:1050', '0A')], undefined)).toBe(3);
  });

  it('exits 4 when neither proc file is readable', () => {
    expect(runScript(8080, undefined, undefined)).toBe(4);
  });
});

describe('dockerExecListenProbe exit-code mapping (issue #660)', () => {
  beforeEach(() => {
    hoisted.calls = [];
    hoisted.outcome = null;
    hoisted.onCall = undefined;
  });

  it('runs the script via `docker exec`, passing the port as a positional argument', async () => {
    await expect(dockerExecListenProbe('cid-1', 8080)).resolves.toEqual({ kind: 'listening' });
    expect(hoisted.calls).toHaveLength(1);
    expect(hoisted.calls[0]!.args).toEqual([
      'exec',
      'cid-1',
      'sh',
      '-c',
      LISTEN_PROBE_SCRIPT,
      'sh',
      '8080',
    ]);
  });

  const NO_SH = 'OCI runtime exec failed: exec: "sh": executable file not found in $PATH';
  it.each([
    [3, '', 'not-listening'],
    [4, '', 'unsupported'],
    [126, NO_SH, 'unsupported'],
    [127, 'sh: no such file or directory', 'unsupported'],
    // 126 is also "cannot exec in a stopped container" -- an app that
    // crashed on start, not an image without a shell (issue #812).
    [126, 'cannot exec in a stopped state: unknown', 'exited'],
    [1, 'Error response from daemon: Container cid-1 is not running', 'exited'],
    [1, 'boom\nline2', 'error'],
  ])('maps exit %i (stderr %j) to %s', async (code, stderr, kind) => {
    hoisted.outcome = Object.assign(new Error(`exit ${code}`), { code, stderr });
    const result = await dockerExecListenProbe('cid-1', 8080);
    expect(result.kind).toBe(kind);
    if (code === 1 && result.kind === 'error') expect(result.detail).toBe('boom line2');
  });

  it('names the signal, never the argv-echoing message, for a killed exec', async () => {
    hoisted.outcome = Object.assign(
      new Error(`Command failed: docker exec cid-1 sh -c ${LISTEN_PROBE_SCRIPT}`),
      { code: null, signal: 'SIGTERM', killed: true, stderr: '' }
    );
    await expect(dockerExecListenProbe('cid-1', 8080)).resolves.toEqual({
      kind: 'error',
      detail: 'exit SIGTERM',
    });
  });

  it('caps the exec timeout at the remaining probe budget', async () => {
    const seen: unknown[] = [];
    hoisted.onCall = (opts: unknown) => seen.push(opts);
    await dockerExecListenProbe('cid-1', 8080, 250);
    await dockerExecListenProbe('cid-1', 8080, 60_000);
    expect(seen).toEqual([{ timeout: 250 }, { timeout: 10_000 }]);
  });
});
