import { spawn } from 'node:child_process';
import { spinner as createSpinner } from '@clack/prompts';
import { getLogger } from './logger.js';
import { getEmbedConfig } from '../local/embed-config.js';

/**
 * Shared helpers for invoking the docker-compatible CLI binary across cdk-local.
 *
 * Two parity decisions with `aws-cdk-cli`'s `cdk-assets-lib`:
 *   1. `CDK_DOCKER` env var swaps the binary so podman / finch users can
 *      run cdk-local without code changes (`CDK_DOCKER=podman cdkl invoke`).
 *   2. `runDockerStreaming` uses streaming spawn rather than `execFile`'s
 *      buffered `maxBuffer` ceiling. BuildKit's progress output can run to
 *      tens of MB on multi-stage builds with `# syntax=docker/dockerfile:1`
 *      frontend downloads + heredoc / `RUN --mount=...` features; the 50 MB
 *      `execFile` ceiling cdk-local used to set silently killed those builds
 *      with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
 *
 * Output handling: stdout/stderr are collected in memory unconditionally so
 * `runDockerStreaming` can return them to the caller for error wrapping.
 * When the logger is at debug level (i.e. the user passed `--verbose`),
 * the chunks are ALSO mirrored to `process.stdout` / `process.stderr` so
 * the user sees live build progress.
 */

/**
 * Return the docker-compatible CLI binary to invoke. Matches CDK CLI:
 * `CDK_DOCKER` env var overrides the default `docker` so users on
 * podman / finch / nerdctl can swap without changing cdk-local code.
 */
export function getDockerCmd(): string {
  const override = process.env['CDK_DOCKER'];
  return override && override.length > 0 ? override : 'docker';
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
}

export interface SpawnError extends Error {
  /** Captured stderr at the time of failure. */
  stderr: string;
  /** Captured stdout at the time of failure. */
  stdout: string;
  /** Process exit code (null when the process was killed by signal). */
  exitCode: number | null;
}

export interface RunDockerOptions {
  /** Optional working directory for the subprocess. */
  cwd?: string;
  /**
   * Additional environment variables to set. Merged on top of `process.env`
   * (so the user's `DOCKER_BUILDKIT=1` and friends propagate through).
   */
  env?: Record<string, string | undefined>;
  /** When set, written to stdin (used by `docker login --password-stdin`). */
  input?: string;
  /**
   * When true, mirror stdout/stderr chunks to `process.stdout` / `process.stderr`
   * as they arrive. Useful for `docker pull` / `docker build` where live
   * progress is desirable. Defaults to "true when the logger is at debug
   * level" — matches the existing `--verbose` UX.
   */
  streamLive?: boolean;
  /**
   * When set, show an interactive {@link createSpinner | clack spinner}
   * with this label for the duration of the spawn — so a long-running
   * `docker build` / `docker pull` against a real-world image doesn't
   * look like cdk-local hung. The spinner only renders when:
   *
   *   - `streamLive` is false (live BuildKit output already shows motion;
   *     overlaying a spinner on top would visually clash and the line
   *     overwriting would mangle the build log), AND
   *   - `process.stdout` is a TTY (non-TTY callers such as integ-test
   *     fixtures or CI runs already log linearly; a spinner there would
   *     emit raw ANSI escapes into the captured log).
   *
   * In either skipped case the spawn proceeds as if `progressLabel` were
   * undefined — the caller's pre-spawn `logger.info(...)` "Building X..."
   * line continues to be the only progress signal, which is the
   * pre-spinner behavior and matches what scripts / CI expect.
   *
   * On exit code 0 the spinner stops with the same label and a check
   * mark; on non-zero exit it stops with an error mark before the
   * rejection propagates, so the caller's `try {} catch {}` wrap still
   * sees a clean spinner-less stderr.
   *
   * Concurrency: each `@clack/prompts` spinner instance registers its own
   * `SIGINT` / `SIGTERM` / `exit` / `uncaughtExceptionMonitor` /
   * `unhandledRejection` listeners against `process`. Callers must
   * serialize concurrent spinner-bearing `spawnStreaming` invocations on
   * the same `process.stdout` — two simultaneous spinners overwrite each
   * other's frame line AND accumulate listeners (Node trips its default
   * 10-listener warning at ~3 concurrent spinners). Every cdk-local call
   * site as of this PR is strictly sequential
   * (`runImageOverrideBuilds` for-of, `prepareImages` for-of, ECS
   * Lambda asset builds are one-per-invoke); the future parallel-build
   * path should either drop the label or memoize a single shared spinner.
   */
  progressLabel?: string;
}

/**
 * Spawn a docker-compatible CLI binary (resolved via `getDockerCmd`) with
 * streaming I/O. Collects stdout/stderr in memory and resolves with both
 * on exit code 0; rejects with a `SpawnError` carrying both streams on any
 * non-zero exit so the caller can wrap with its own error class without
 * losing the upstream output.
 *
 * No `maxBuffer` ceiling: BuildKit progress output frequently exceeds the
 * `child_process.execFile` default of 1 MB (cdk-local previously bumped to 50 MB
 * but BuildKit + frontend pulls can still exceed that on first-time builds).
 */
export async function runDockerStreaming(
  args: string[],
  options: RunDockerOptions = {}
): Promise<SpawnResult> {
  return spawnStreaming(getDockerCmd(), args, options);
}

/**
 * Generic streaming spawn — used by `runDockerStreaming` AND by the
 * `executable` source mode in `docker-build.ts` (which runs an arbitrary
 * user-supplied build command, not docker).
 */
export async function spawnStreaming(
  cmd: string,
  args: string[],
  options: RunDockerOptions = {}
): Promise<SpawnResult> {
  const streamLive = options.streamLive ?? getLogger().getLevel() === 'debug';
  const env = options.env ? mergeEnv(options.env) : undefined;
  const spin = startProgressSpinner(options.progressLabel, streamLive);

  return new Promise<SpawnResult>((resolve, reject) => {
    // Defensive: a synchronous throw from `spawn` (e.g. Node's
    // `ERR_INVALID_ARG_TYPE` on a non-string `cmd`) bypasses the close /
    // error handlers below — without this try/catch the spinner would be
    // left animating until process exit. Today unreachable
    // (`getDockerCmd()` always returns a string + all call-site `args`
    // are `string[]`), but the wrap is free defense-in-depth on a
    // process-launch helper.
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env,
        stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      stopProgressSpinner(spin, options.progressLabel);
      reject(err as Error);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (streamLive) process.stdout.write(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (streamLive) process.stderr.write(chunk);
    });

    child.once('error', (err: NodeJS.ErrnoException) => {
      stopProgressSpinner(spin, options.progressLabel);
      if (err.code === 'ENOENT') {
        const usingOverride = process.env['CDK_DOCKER'] === cmd && cmd !== 'docker';
        reject(
          new Error(
            usingOverride
              ? `Failed to find and execute '${cmd}' (resolved via CDK_DOCKER). ` +
                  `Install '${cmd}' or unset CDK_DOCKER to fall back to 'docker'.`
              : `Failed to find and execute '${cmd}'. Install Docker (or set the ` +
                  `'CDK_DOCKER' environment variable to a compatible binary such as podman / finch).`
          )
        );
      } else {
        reject(err);
      }
    });

    child.once('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code === 0) {
        stopProgressSpinner(spin, options.progressLabel);
        resolve({ stdout, stderr });
      } else {
        stopProgressSpinner(spin, options.progressLabel);
        const message =
          stderr.trim() || stdout.trim() || `${cmd} ${args[0] ?? ''} exited with code ${code}`;
        const err = new Error(message) as SpawnError;
        err.stderr = stderr;
        err.stdout = stdout;
        err.exitCode = code;
        reject(err);
      }
    });

    if (options.input !== undefined) {
      // Defensive: when spawn() fails (e.g. ENOENT race), the synchronous
      // write below could emit a stream 'error' event before the close /
      // error handlers above fire. Without a listener, Node escalates that
      // to "Unhandled 'error' event" on some versions. cdk-local's only `input`
      // call site is `docker login --password-stdin` with short payloads
      // that complete well within the syscall, so this is unlikely to fire
      // in practice — but the no-op listener is free.
      child.stdin!.on('error', () => {
        /* surfaced via the outer error/close handlers above */
      });
      child.stdin!.write(options.input);
      child.stdin!.end();
    }
  });
}

type ClackSpinner = ReturnType<typeof createSpinner>;

/**
 * Start an interactive clack spinner for the spawn, but only when the
 * current shell would actually render it (TTY) and the caller isn't
 * already streaming live output. Returns `undefined` when either
 * precondition fails — `stopProgressSpinner` then is a no-op.
 *
 * Test seam: the integration with `@clack/prompts` is mocked in
 * `tests/unit/utils/docker-cmd-progress-spinner.test.ts`.
 */
function startProgressSpinner(
  label: string | undefined,
  streamLive: boolean
): ClackSpinner | undefined {
  if (label === undefined || streamLive || process.stdout.isTTY !== true) return undefined;
  const spin = createSpinner();
  spin.start(label);
  return spin;
}

function stopProgressSpinner(spin: ClackSpinner | undefined, label: string | undefined): void {
  // `@clack/prompts`' `spinner().stop(message?)` only takes the message at
  // the TS-level signature (the runtime impl ignores the optional `code`
  // second arg, hard-coding success), so we mirror its public API. The
  // upstream caller's wrapped error / rejection still surfaces the
  // failure detail; the spinner's only job here is to stop animating
  // cleanly so the error stderr renders on its own fresh line.
  if (spin === undefined) return;
  spin.stop(label ?? '');
}

/**
 * Spawn a docker-compatible CLI binary (resolved via `getDockerCmd`) attached
 * to the parent process's stdio so the user sees live output (`docker pull`
 * layer progress, `docker login` interactive prompts that should never fire
 * with `--password-stdin` but still safe to inherit, etc.). Resolves on exit
 * code 0; rejects with a plain `Error` carrying the exit code on any non-zero
 * exit, so the caller can wrap with its own error class.
 *
 * Differs from {@link runDockerStreaming} in two ways:
 *   1. `stdio: 'inherit'` — output is NOT captured, so terminal control codes
 *      (color, progress bar overwrites) flow through unchanged. This is the
 *      load-bearing reason for the split: `docker pull`'s progress bars only
 *      animate properly when stdout is a real TTY connected to the parent.
 *   2. No `input` / `streamLive` options — inherit-mode has nothing to
 *      capture and nothing to mirror.
 *
 * Used by the `--verbose`-mode `docker pull` plumbing in `docker-runner.ts`
 * and `ecr-puller.ts` (visible layer progress). Non-verbose pulls go through
 * {@link runDockerStreaming} so stderr can be folded into the error message.
 */
export async function runDockerForeground(
  args: string[],
  options: ForegroundOptions = {}
): Promise<void> {
  return spawnForeground(getDockerCmd(), args, options);
}

export interface ForegroundOptions {
  /** Optional working directory for the subprocess. */
  cwd?: string;
  /**
   * Additional environment variables to set. Merged on top of `process.env`
   * (same semantics as {@link RunDockerOptions.env}).
   */
  env?: Record<string, string | undefined>;
}

/**
 * Foreground (stdio-inherit) spawn — the inherit-mode counterpart to
 * {@link spawnStreaming}. Used by {@link runDockerForeground} for docker-CLI
 * subprocesses.
 *
 * The ENOENT branch crafts a docker-specific install hint ("Install Docker
 * (or set CDK_DOCKER ...)"), so non-docker callers reusing this helper
 * would see a misleading error on missing-binary failures. Keep the binary
 * docker-shaped, or update the ENOENT message before adding a non-docker
 * call site.
 */
export async function spawnForeground(
  cmd: string,
  args: string[],
  options: ForegroundOptions = {}
): Promise<void> {
  const env = options.env ? mergeEnv(options.env) : undefined;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env,
      stdio: 'inherit',
    });
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        const usingOverride = process.env['CDK_DOCKER'] === cmd && cmd !== 'docker';
        reject(
          new Error(
            usingOverride
              ? `Failed to find and execute '${cmd}' (resolved via CDK_DOCKER). ` +
                  `Install '${cmd}' or unset CDK_DOCKER to fall back to 'docker'.`
              : `Failed to find and execute '${cmd}'. Install Docker (or set the ` +
                  `'CDK_DOCKER' environment variable to a compatible binary such as podman / finch).`
          )
        );
      } else {
        reject(new Error(`${cmd} failed: ${err.message}`));
      }
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}

/**
 * Format the stderr from a failed `docker login` so the surfaced cdk-local
 * error gives the user an actionable workaround when the underlying
 * failure is a credential-helper persistence bug (which has nothing to
 * do with cdk-local, AWS, or IAM perms — the docker CLI itself fails to
 * save the auth token to the platform's credential store). The most
 * common shape is `osxkeychain` on macOS rejecting an overwrite for
 * an existing entry, but `wincred` (Windows), `pass` (Linux), and
 * `secretservice` (Linux) hit the same class of `Error saving
 * credentials` failure, so the rewritten message stays platform-
 * agnostic — `docker logout <endpoint>` is the correct recovery on
 * every backend.
 *
 * Detected docker / docker-credential-* output patterns:
 *   - `error storing credentials - err: exit status 1, out: \`The
 *     specified item already exists in the keychain.\`` (osxkeychain)
 *   - `Error saving credentials: ...` (any backend)
 *
 * Non-matching failures (genuine IAM / network / endpoint problems)
 * pass through with just the stderr trimmed — the original message
 * stays load-bearing for diagnosis.
 */
export function formatDockerLoginError(stderr: string, endpoint: string): string {
  const trimmed = stderr.trim();
  const isCredentialHelperFailure =
    trimmed.includes('already exists in the keychain') ||
    trimmed.includes('Error saving credentials');
  if (isCredentialHelperFailure) {
    return (
      `docker's credential helper (osxkeychain on macOS / wincred on Windows / pass / secretservice on Linux) ` +
      `failed to persist the ECR auth token. The "already exists in the keychain" / "Error saving credentials" ` +
      `output is a known docker-credential-helpers issue — unrelated to ${getEmbedConfig().productName}, AWS credentials, or IAM perms. ` +
      `Quick fix: run \`docker logout ${endpoint}\` to clear the stale entry, then retry the ${getEmbedConfig().productName} command. ` +
      `Permanent fix: edit ~/.docker/config.json and remove (or empty) the platform-specific "credsStore" entry ` +
      `(e.g. "osxkeychain" → "" or "desktop" on macOS Docker Desktop). ` +
      `Original docker stderr: ${trimmed}`
    );
  }
  return trimmed;
}

function mergeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete merged[k];
    } else {
      merged[k] = v;
    }
  }
  return merged;
}
