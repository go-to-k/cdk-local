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
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      hoisted.calls.push({ cmd, args });
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

  it.each([
    [3, 'not-listening'],
    [4, 'unsupported'],
    [126, 'unsupported'],
    [127, 'unsupported'],
    [1, 'error'],
  ])('maps exit %i to %s', async (code, kind) => {
    hoisted.outcome = Object.assign(new Error(`exit ${code}`), { code, stderr: 'boom\nline2' });
    const result = await dockerExecListenProbe('cid-1', 8080);
    expect(result.kind).toBe(kind);
    if (result.kind === 'error') expect(result.detail).toBe('boom line2');
  });
});
