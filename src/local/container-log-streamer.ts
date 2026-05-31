import { execFile, spawn, type ChildProcess } from 'node:child_process';
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
 * **Cap-reached warning** (Issue #227 review fix — Code #2): the
 * re-attach budget is bounded at 50 to defend against a permanently-
 * broken `docker logs -f` (the container was removed out from under
 * us). When the cap is hit, the streamer surfaces ONE warning line via
 * `process.stderr` naming the prefix + the manual recovery so a long-
 * running `--watch` session does not lose its foreground log surface
 * silently.
 *
 * **Dying-container respawn skip** (Issue #227 review fix — Code #4):
 * when the child exits unsolicited and the container's `State.Status`
 * is `exited` / `dead` / `removing`, the streamer does NOT respawn —
 * the natural-exit path is the service-runner's `cleanupEcsRun(...)`
 * call (~1s after the wait resolves), and a respawn against a
 * dying container is just a wasted `docker logs -f` process + a
 * spurious cap-reached tick. A `docker restart` (the soft-reload
 * primitive) leaves the container in `restarting` / `running`, so
 * the soft-reload re-attach path is preserved. Falls open: an
 * inspect error treats the container as still alive (best-effort —
 * the cap+stop() invariants stay correct either way).
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
  // Issue #227 review fix (Code #3) — track the pending respawn timer
  // so `stop()` can `clearTimeout(...)` it. Without this, a `stop()`
  // call that lands BETWEEN a child `exit` event and the 200ms respawn
  // would still let the timer keep the event loop alive for up to
  // 200ms post-teardown. Not user-visible for the CLI process (which
  // exits anyway), but library hosts that re-enter the host event
  // loop after teardown saw the tail.
  let pendingRespawn: ReturnType<typeof setTimeout> | undefined;

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
      if (reattachCount >= maxReattaches) {
        // Issue #227 review fix (Code #2) — surface ONE warning so a
        // long-running `--watch` session that accumulates re-attaches
        // does not silently lose the foreground log surface. Manual
        // recovery is `docker logs -f <containerId>` in a second
        // terminal. Use the streamer's prefix verbatim so the line
        // aligns with the rest of that stream's output.
        process.stderr.write(
          `${prefix}cdkl: docker logs -f re-attached ${maxReattaches} times; giving up. ` +
            `Run \`docker logs -f ${containerId}\` manually to keep watching.\n`
        );
        return;
      }
      reattachCount += 1;
      // Issue #227 review fix (Code #4) — best-effort container
      // status probe before respawning. When the container is in a
      // terminal state (`exited` / `dead` / `removing`), the natural-
      // exit path is the service-runner's `cleanupEcsRun(...)` call
      // ~1s after `docker wait` resolves; respawning is wasted work
      // + ticks `reattachCount` toward the cap. A `docker restart`
      // (soft-reload primitive) leaves the container in `restarting`
      // / `running`, so the soft-reload re-attach path stays
      // intact. Inspect failure falls open (treats the container as
      // still alive) so the cap-bounded existing behavior remains
      // the worst case.
      execFile(
        getDockerCmd(),
        ['inspect', '--format', '{{.State.Status}}', containerId],
        (err, stdout) => {
          if (stopping) return;
          if (!err) {
            const status = stdout.trim().toLowerCase();
            if (status === 'exited' || status === 'dead' || status === 'removing') {
              // Container is gone; let the runner's cleanup own it.
              return;
            }
          }
          // Brief backoff so the docker daemon has a moment to re-establish
          // the container's log writer post-restart. 200ms is well under
          // the soft-reload's typical sub-second restart and well above the
          // immediate-retry foot-gun.
          pendingRespawn = setTimeout(() => {
            pendingRespawn = undefined;
            if (stopping) return;
            // `--since 0s` requests only new log entries from this moment
            // forward — avoids re-emitting the pre-restart history that
            // the user already saw in the FIRST streamer's window.
            spawnOnce('0s');
          }, 200);
        }
      );
    });
  };

  spawnOnce(undefined);

  return () => {
    stopping = true;
    // Issue #227 review fix (Code #3) — clear any pending respawn
    // timer so the event loop is not held open for up to 200ms
    // post-teardown by a timer queued in `proc.on('exit')`.
    if (pendingRespawn !== undefined) {
      clearTimeout(pendingRespawn);
      pendingRespawn = undefined;
    }
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
