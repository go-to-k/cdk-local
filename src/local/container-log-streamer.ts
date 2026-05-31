import { spawn, type ChildProcess } from 'node:child_process';
import { getDockerCmd } from '../utils/docker-cmd.js';

/**
 * Spawn `docker logs -f <containerId>` and pipe its stdout / stderr to
 * the host's `process.stdout` / `process.stderr`, prefixing every emitted
 * line with the caller-supplied `prefix`. Returns a stop function that
 * drains any unterminated tail line and SIGTERMs the streamer process —
 * idempotent + safe to call from a `finally` or shutdown handler.
 *
 * Used by `cdkl run-task` (per-container prefix `[<container-name>]`) and
 * by `cdkl start-service` / `cdkl start-alb` (per-replica prefix
 * `[svc=<service> r=<i> c=<container>]`) so application `console.log`
 * output inside a replica is visible in the foreground terminal without
 * having to attach `docker logs -f` in a separate shell. The prefix shape
 * is the caller's concern: this helper only cares about line-buffered
 * pass-through.
 *
 * **Auto re-attach on `docker restart`** (Issue #227 + #214 soft-reload):
 * the docker daemon terminates `docker logs -f` when the container's
 * PID 1 exits — so a `docker restart` (the soft-reload primitive) ends
 * the follow stream even though the container ID is preserved across the
 * restart. The streamer detects an unsolicited child-exit and re-spawns
 * `docker logs -f` with `--since 0s` so only NEW output (from the
 * post-restart PID-1) is forwarded; the v1 prelude is not re-emitted.
 * `stop()` flips an internal "stopping" flag so the re-attach loop sees
 * the intentional teardown and does not respawn.
 *
 * The streamer is best-effort. A spawn / pipe error is silently swallowed
 * (the parent's `docker wait` already surfaces the underlying container
 * failure with full context); the loud surface stays on the runner's exit
 * path.
 */
export function attachContainerLogStreamer(prefix: string, containerId: string): () => void {
  let stopping = false;
  let current: ChildProcess | undefined;
  let stdoutBuf = '';
  let stderrBuf = '';
  // Reset budget so a permanently-broken `docker logs -f` (e.g. the
  // container was removed out from under us) does not respawn forever.
  // 50 reattaches covers a typical `--watch` session's reload count
  // many times over while bounding the worst case.
  const maxReattaches = 50;
  let reattachCount = 0;

  const spawnOnce = (sinceArg: string | undefined): void => {
    const args = [
      'logs',
      '-f',
      ...(sinceArg !== undefined ? ['--since', sinceArg] : []),
      containerId,
    ];
    const proc = spawn(getDockerCmd(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current = proc;
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf = writePrefixedLines(prefix, stdoutBuf + chunk.toString('utf-8'), process.stdout);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = writePrefixedLines(prefix, stderrBuf + chunk.toString('utf-8'), process.stderr);
    });
    proc.on('error', () => {
      /* surfaced through the parent's docker-wait result */
    });
    proc.on('exit', () => {
      if (stopping) return;
      if (reattachCount >= maxReattaches) return;
      reattachCount += 1;
      // Brief backoff so the docker daemon has a moment to re-establish
      // the container's log writer post-restart. 200ms is well under
      // the soft-reload's typical sub-second restart and well above the
      // immediate-retry foot-gun.
      setTimeout(() => {
        if (stopping) return;
        // `--since 0s` requests only new log entries from this moment
        // forward — avoids re-emitting the pre-restart history that
        // the user already saw in the FIRST streamer's window.
        spawnOnce('0s');
      }, 200);
    });
  };

  spawnOnce(undefined);

  return () => {
    stopping = true;
    if (stdoutBuf) {
      process.stdout.write(prefix + stdoutBuf + '\n');
      stdoutBuf = '';
    }
    if (stderrBuf) {
      process.stderr.write(prefix + stderrBuf + '\n');
      stderrBuf = '';
    }
    if (current && !current.killed) current.kill('SIGTERM');
  };
}

/**
 * Write every complete line in `buffer` to `out`, prefixed with `prefix`.
 * Returns the trailing partial line (no `\n` yet) so the caller can
 * accumulate it with the next `data` chunk. Exported for unit tests; the
 * production callers should use {@link attachContainerLogStreamer}.
 */
export function writePrefixedLines(
  prefix: string,
  buffer: string,
  out: NodeJS.WritableStream
): string {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    out.write(prefix + line + '\n');
  }
  return remainder;
}
