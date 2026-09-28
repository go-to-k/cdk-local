import { spawn } from 'node:child_process';
import { spinner as createSpinner } from '@clack/prompts';
import { displayUntrustedValue } from './assembly-path.js';
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

/**
 * Is the container client finch running its Lima VM (macOS / Windows)? There
 * the value-less `-e KEY` form (`appendEnvFlags` in `local/docker-runner.ts`)
 * does NOT keep a value off the process command line (issue #749): finch's
 * `handleEnv` resolves each bare `KEY` against its own environment and
 * re-emits `-e KEY=<value>` on the argv of the `limactl shell finch sudo -E
 * nerdctl ...` child it starts, and `--env-file` is read on the host and
 * re-emitted the same way (runfinch/finch `cmd/finch/nerdctl_remote.go`,
 * `handleEnv` / `handleEnvFile`). Its `passedEnvs` list also puts
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` from its
 * environment on that argv for every command. finch on Linux passes the argv
 * to nerdctl unchanged and is NOT matched.
 *
 * Detection is by the BASENAME of the resolved binary (`finch`, `finch.exe`,
 * any case): a wrapper script or a symlink under another name is not
 * recognised, and neither is Lima's own `nerdctl.lima`.
 */
export function isFinchVmClient(
  cmd: string = getDockerCmd(),
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'darwin' && platform !== 'win32') return false;
  const base = (cmd.split(/[\\/]/).pop() ?? '').toLowerCase();
  return base === 'finch' || base === 'finch.exe';
}

/**
 * The env var that accepts, while it is set, that a container client puts
 * secret VALUES on a process command line ({@link finchSecretArgvRefusal}):
 * `<envPrefix>_ALLOW_SECRETS_ON_ARGV`, so `CDKL_ALLOW_SECRETS_ON_ARGV` for
 * `cdkl` and the embedding host's own prefix otherwise. Only `1` or `true`
 * (any case) opts in.
 */
export function allowSecretsOnArgvEnvName(): string {
  return `${getEmbedConfig().envPrefix}_ALLOW_SECRETS_ON_ARGV`;
}

function secretsOnArgvAllowed(): boolean {
  const v = process.env[allowSecretsOnArgvEnvName()];
  return v !== undefined && ['1', 'true'].includes(v.trim().toLowerCase());
}

/**
 * The refusal text when template-sourced secrets (ECS `Secrets`, decrypted
 * `SecureString` values) would be forwarded under {@link isFinchVmClient}, or
 * `undefined` when they may be forwarded: another client, no such secret, or
 * {@link allowSecretsOnArgvEnvName} set. The caller throws it in its own error
 * class BEFORE any `docker run`. The AWS credential set is not refused here
 * but warned about by {@link warnFinchArgvExposure}: forwarding it is what puts
 * credentials that are not in this process's own environment (`--assume-role`,
 * `--profile`, the metadata sidecar's) on that argv, and the warning makes that
 * visible while keeping finch usable for containers that need AWS access. Names
 * only, never a value.
 *
 * `subject` names what is refused: a fixed `label` of ours (`Container`,
 * `Container for image`) and the template- or asset-chosen `name` (a container
 * name, an image URI). The name and every secret name render through
 * {@link displayUntrustedValue} (issue #774): control characters flattened to
 * a space, a name that is not plain put inside a quoted boundary, and the
 * length capped, so a crafted name can neither
 * drive the terminal, forge a clause of this message, nor make it unbounded.
 */
export function finchSecretArgvRefusal(
  secretNames: readonly string[],
  subject: { label: string; name: string }
): string | undefined {
  if (secretNames.length === 0 || !isFinchVmClient() || secretsOnArgvAllowed()) return undefined;
  const names = [...new Set(secretNames)];
  return (
    `${subject.label} ${displayUntrustedValue(subject.name)}: refusing to forward secret(s) ` +
    `${names.map(displayUntrustedValue).join(', ')} ` +
    `under CDK_DOCKER=finch on macOS / Windows. finch turns each value-less '-e KEY' into ` +
    `'-e KEY=<value>' on the command line of the limactl process it starts, where other local ` +
    `processes can read the plaintext. Use a container client that keeps the value off the command ` +
    `line (for example the default 'docker', by unsetting CDK_DOCKER), or set ` +
    `${allowSecretsOnArgvEnvName()}=1 to accept that exposure while it stays set.`
  );
}

/** Key sets already warned about by {@link warnFinchArgvExposure} in this process. */
const finchArgvWarned = new Set<string>();

/** Test-only: forget which key sets {@link warnFinchArgvExposure} warned about. */
export function resetFinchArgvWarningsForTest(): void {
  finchArgvWarned.clear();
}

/**
 * Warn, once per process per distinct key set, that under
 * {@link isFinchVmClient} the values of `keys` (the sensitive env about to be
 * forwarded as value-less `-e KEY`) reach the `limactl` command line. Names
 * only, never a value, each rendered through {@link displayUntrustedValue}.
 */
export function warnFinchArgvExposure(keys: readonly string[]): void {
  if (keys.length === 0 || !isFinchVmClient()) return;
  const names = [...new Set(keys)].sort();
  const latch = JSON.stringify(names);
  if (finchArgvWarned.has(latch)) return;
  finchArgvWarned.add(latch);
  getLogger().warn(
    `CDK_DOCKER=finch on macOS / Windows puts the values of ${names.map(displayUntrustedValue).join(', ')} ` +
      `on the command line of the limactl process it starts (finch turns a value-less '-e KEY' into ` +
      `'-e KEY=<value>'), where other local processes can read them. The default 'docker' client ` +
      `keeps them off the command line.`
  );
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
        const shownCmd = displayUntrustedValue(cmd);
        reject(
          new Error(
            usingOverride
              ? `Failed to find and execute ${shownCmd} (resolved via CDK_DOCKER). ` +
                  `Install ${shownCmd} or unset CDK_DOCKER to fall back to 'docker'.`
              : `Failed to find and execute ${shownCmd}. Install Docker (or set the ` +
                  `'CDK_DOCKER' environment variable to a compatible binary such as podman / finch).`
          )
        );
      } else {
        // Node's own message is `spawn <cmd> <CODE>` with the command RAW, and
        // `cmd` is an asset's `source.executable[0]` when docker-build.ts runs
        // one (go-to-k/cdk-local#764). No `cause`: the error handler prints a
        // cause's message, which would carry the raw command back in.
        const wrapped = new Error(
          `Failed to execute ${displayUntrustedValue(cmd)} (${err.code ?? 'spawn error'})`
        ) as NodeJS.ErrnoException;
        if (err.code !== undefined) wrapped.code = err.code;
        reject(wrapped);
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
        // `cmd` is an asset's `source.executable[0]` when docker-build.ts runs
        // one, so it renders display-safe (go-to-k/cdk-local#764). Its
        // ARGUMENTS stay out: a build script's own `--token=...` matches no
        // argv masker, and the full argv is a `--verbose` detail (see
        // `warnManifestExecutable`).
        const message =
          stderr.trim() ||
          stdout.trim() ||
          `${displayUntrustedValue(cmd)} exited with code ${code}`;
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
        const shownCmd = displayUntrustedValue(cmd);
        reject(
          new Error(
            usingOverride
              ? `Failed to find and execute ${shownCmd} (resolved via CDK_DOCKER). ` +
                  `Install ${shownCmd} or unset CDK_DOCKER to fall back to 'docker'.`
              : `Failed to find and execute ${shownCmd}. Install Docker (or set the ` +
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

/**
 * Env vars the container CLI itself reads to decide how / where to run — the
 * binary {@link getDockerCmd} resolves, i.e. `docker` or whatever `CDK_DOCKER`
 * names (podman / nerdctl / finch). A resolved ECS secret (or SecureString)
 * whose NAME collides with one of these must NOT override it in the client's
 * own process environment: a secret named `DOCKER_HOST` (or podman's
 * `CONTAINER_HOST`) would redirect the client to a different daemon, and `PATH`
 * would break locating the binary. See issues
 * go-to-k/cdkd#2183 and go-to-k/cdkd#2188.
 *
 * Ported from cdkd's `src/utils/docker-cmd.ts` (go-to-k/cdk-local#772) with its
 * lists, prefix families and rationale intact; issue references in these
 * comments point at cdkd, where each entry was decided. Keep the two copies
 * in sync.
 *
 * RULE for additions: anything a supported container CLIENT (or a credential /
 * connection helper it execs) reads to decide WHAT CODE IT LOADS, WHAT IT
 * TRUSTS, or WHERE / HOW IT CONNECTS. The docker CLI's documented set is kept
 * whole, behaviour toggles included; beyond it, a var that only tunes
 * behaviour (a storage driver, a snapshotter, a temp dir, an experimental
 * toggle) is OUT, because dropping a colliding secret costs the user that
 * secret. The operator's OWN value is never touched — the spawn
 * env starts from `process.env` — so adding a key costs only a secret of that
 * name.
 */
export const DOCKER_CLIENT_ENV_KEYS: ReadonlySet<string> = new Set([
  // Process-level vars the client needs to run at all (incl. Windows HOME).
  // `PATHEXT` is here for the same code-execution reason as `PATH`: on Windows
  // Go's executable lookup reads it to choose which extension of an adjacent
  // helper (credential helper, `ssh`) to run, so a colliding secret can pick a
  // different program.
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  // Connection / transport (docs.docker.com/reference/cli/docker) — a colliding
  // secret here could redirect the client to a different daemon or downgrade TLS.
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
  'DOCKER_AUTH_CONFIG',
  // Execution / behavior.
  'DOCKER_DEFAULT_PLATFORM',
  'DOCKER_CUSTOM_HEADERS',
  'DOCKER_CONTENT_TRUST',
  'DOCKER_CONTENT_TRUST_SERVER',
  'DOCKER_HIDE_LEGACY_COMMANDS',
  'BUILDKIT_PROGRESS',
  // Loader — a colliding secret injects code into the client process (and the
  // credential / connection helpers it execs, which inherit its env). The docker
  // CLI here is dynamically linked, so the loader vars are live. The WHOLE `LD_*`
  // / `DYLD_*` family is caught by PREFIX in `isDockerClientEnvKey` rather than
  // enumerated here — an exact list of loader vars is always one release behind
  // (glibc `LD_*`, macOS `DYLD_ROOT_PATH` / `DYLD_IMAGE_SUFFIX` / ...); the
  // non-prefixed loader vars are named individually: `GLIBC_TUNABLES` (glibc
  // tuning) and `GCONV_PATH` (glibc loads gconv shared objects from it — a
  // code-load vector of the same class, ignored only for setuid binaries,
  // which the docker CLI is not).
  'GLIBC_TUNABLES',
  'GCONV_PATH',
  // `BASH_ENV` is sourced by bash in NON-interactive shells, so it bites when
  // a `docker-credential-*` helper is a shell-script wrapper (common for
  // `aws ecr get-login-password` wrappers). `ENV` is interactive-only and is
  // deliberately absent.
  'BASH_ENV',
  // bash imports `SHELLOPTS` at startup, even as `/bin/sh`, and `xtrace`
  // expands `PS4` before every command, so the pair runs a command
  // substitution in any helper written as a shell script (`docker-credential-
  // gcloud` is one) (go-to-k/cdkd#3599). Exported functions (`BASH_FUNC_<name>%%`) are
  // caught by PREFIX in `isDockerClientEnvKey`: one named after a command
  // the script calls replaces it. `BASHOPTS` is absent, because no shopt
  // option runs code by itself.
  'SHELLOPTS',
  'PS4',
  // Interpreter variables of a credential helper written in a scripting
  // language (go-to-k/cdkd#3599). The template chooses the image, so it chooses the
  // registry, and so which `credHelpers` entry docker execs. Exact names, not
  // `PYTHON` / `NODE_` / `RUBY` / `PERL` prefixes: those families carry
  // realistic secrets (`NODE_AUTH_TOKEN`, `RUBYGEMS_API_KEY`), and each
  // runtime's code-loading set is small and documented. Interactive-only vars
  // (`PYTHONSTARTUP`, `PYTHONINSPECT`) stay off, as `ENV` does: a helper's
  // stdin is docker's pipe, not a terminal.
  // Python: the module search path and prefixes it loads code from.
  // `PYTHONWARNINGS` imports the module a warning category names, and
  // `antigravity` then opens `BROWSER`, which runs a command even under `-S`.
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONUSERBASE',
  'PYTHONPYCACHEPREFIX',
  'PYTHONPLATLIBDIR',
  'PYTHONWARNINGS',
  'BROWSER',
  // CA bundles that Python's `requests` (gcloud keeps `trust_env` on) and
  // gcloud's bundled httplib2 read: WHAT IT TRUSTS. `SSLKEYLOGFILE` is where
  // urllib3 (gcloud's TLS context) and curl write the session keys, so the
  // TLS of gcloud's refresh-token exchange becomes decryptable: the
  // `AWS_ECR_CACHE_DIR` class.
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTPLIB2_CA_CERTS',
  'SSLKEYLOGFILE',
  // Where gcloud fetches the operator's credentials on GCE: the metadata-server
  // twin of `AWS_EC2_METADATA_SERVICE_ENDPOINT` below. The rest of gcloud's
  // env surface is the `CLOUDSDK_` prefix family.
  'GCE_METADATA_HOST',
  'GCE_METADATA_ROOT',
  'GCE_METADATA_IP',
  // Node: `NODE_OPTIONS` takes `--import=data:...`, which runs code with no file
  // on disk; the rest decide which code it loads (`NODE_COMPILE_CACHE` is
  // V8 code cache it loads unverified, the `PYTHONPYCACHEPREFIX` class) and
  // which CAs it trusts.
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_COMPILE_CACHE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  // Ruby and Perl: `PERL5OPT=-d` plus `PERL5DB` runs code with no file on disk.
  // `GEM_PATH` / `GEM_HOME` are where RubyGems resolves a `require`, the
  // `NODE_PATH` class. `RUBYGEMS_GEMDEPS=-` makes older RubyGems evaluate a
  // `Gemfile` found by walking up from the cwd, which is the CDK app's.
  'RUBYOPT',
  'RUBYLIB',
  'GEM_PATH',
  'GEM_HOME',
  'RUBYGEMS_GEMDEPS',
  'PERL5OPT',
  'PERL5LIB',
  'PERLLIB',
  'PERL5DB',
  // OpenSSL 3 as linked by Python (and so gcloud) reads `OPENSSL_CONF` when
  // it builds a TLS context, and a config there can activate a provider
  // module, a shared object it dlopens: the `GCONV_PATH` class.
  // `OPENSSL_MODULES` / `OPENSSL_ENGINES` are the directories it loads those
  // from.
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'OPENSSL_ENGINES',
  // SSH — the `ssh://`-context connection helper's exec/trust-bearing vars,
  // enumerated EXACTLY rather than by an `SSH_` prefix (go-to-k/cdkd#2186 review round 3):
  // the client-side exec/trust set is CLOSED (last addition
  // `SSH_ASKPASS_REQUIRE`, OpenSSH 8.4, 2020), while an `SSH_` prefix breaks
  // realistic secrets — `SSH_PRIVATE_KEY` is GitLab CI's canonical deploy-key
  // spelling. `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` /
  // `SSH_ORIGINAL_COMMAND` are sshd-SET, never client-read, and stay off the
  // list. The attack also needs the operator to already be on ssh transport
  // (`DOCKER_HOST` / `DOCKER_CONTEXT` are exact-denylisted above), so unlike
  // `LD_PRELOAD` it is not self-bootstrapping.
  'SSH_AUTH_SOCK', // agent hijack
  'SSH_ASKPASS', // OpenSSH execs the named program
  'SSH_ASKPASS_REQUIRE',
  'SSH_SK_HELPER', // security-key helper — OpenSSH execs it
  'SSH_SK_PROVIDER', // FIDO provider LIBRARY path — OpenSSH dlopens it (Codex review)
  'SSH_PKCS11_HELPER', // PKCS#11 helper — OpenSSH execs it
  'SSH_AGENT_PID', // not load-bearing, kept for completeness of the closed set
  // Credential-helper reach (go-to-k/cdkd#2186 review rounds 3-4): `docker run` on a
  // missing image pulls, the pull auths, and the auth execs
  // `docker-credential-ecr-login` — whose AWS SDK reads these to decide WHERE
  // to send a request signed with the OPERATOR's real credentials
  // (`execEnvForSecrets` starts from `{ ...process.env }`, so those
  // credentials are in the client's env unless a same-named container secret —
  // they are in `SENSITIVE_ENV_KEYS` — overrides them). A secret named
  // `AWS_ENDPOINT_URL` would make the helper sign with them and send the
  // result to an attacker-chosen host — the `DOCKER_HOST` class, one helper
  // over. The file/profile vars repoint which credentials it loads;
  // `AWS_ROLE_ARN` is `AWS_WEB_IDENTITY_TOKEN_FILE`'s mandatory partner (an
  // attacker-set role ARN plus the operator's own token file assumes a
  // different identity), and `AWS_EC2_METADATA_SERVICE_ENDPOINT` redirects the
  // IMDS credential source. The per-service `AWS_ENDPOINT_URL_<SERVICE>` forms
  // (aws-sdk-go-v2 honours them) are caught by PREFIX in
  // `isDockerClientEnvKey`, since an exact list per service cannot keep up.
  'AWS_ENDPOINT_URL',
  'AWS_CA_BUNDLE',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_ROLE_ARN',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  // `docker-credential-ecr-login` WRITES the ECR auth token it mints with the
  // operator's credentials into this directory (and reads a cached one back),
  // so a colliding secret chooses where that token lands (go-to-k/cdkd#2188).
  'AWS_ECR_CACHE_DIR',
  // podman / containers tooling (go-to-k/cdkd#2188; podman(1) "Environment Variables",
  // containers.conf(5), containers/common `pkg/auth`). Connection:
  // `CONTAINER_HOST` is podman's `DOCKER_HOST` (it also switches the client to
  // remote mode), `CONTAINER_CONNECTION` picks a named remote from
  // `PODMAN_CONNECTIONS_CONF`, `CONTAINER_SSHKEY` is the ssh identity for it.
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
  'CONTAINER_SSHKEY',
  'PODMAN_CONNECTIONS_CONF',
  // `CONTAINER_PROXY` routes podman-remote's API traffic (registry auth
  // headers included) through a proxy — the `HTTP_PROXY` class.
  // `CONTAINERS_SSH_CONF` becomes `ssh -F <file>` for native-ssh remotes, and
  // an ssh config's `ProxyCommand` / `LocalCommand` executes code.
  'CONTAINER_PROXY',
  'CONTAINERS_SSH_CONF',
  // Config files that name executables (`conmon_path`, `runtime`,
  // `helper_binaries_dir`, `hooks_dir`, storage `mount_program`) or registry
  // routing (mirrors, insecure registries): `CONTAINERS_CONF` REPLACES the
  // whole config hierarchy and `CONTAINERS_CONF_OVERRIDE` is loaded last on
  // top of it; the shared config-file loader reads the same `<NAME>_OVERRIDE`
  // for registries.conf and storage.conf, so each override is listed beside
  // its base name. `REGISTRIES_CONFIG_PATH` is the legacy spelling of
  // `CONTAINERS_REGISTRIES_CONF`. `CONTAINERS_POLICY_JSON` picks the
  // signature-verification policy (WHAT IT TRUSTS; that loader reads no
  // override for it). `STORAGE_OPTS` takes the same options as
  // storage.conf, `overlay.mount_program` (an executable) included.
  // `CONTAINERS_HELPER_BINARY_DIR` is searched FIRST for conmon / netavark /
  // pasta and the other helper binaries.
  'CONTAINERS_CONF',
  'CONTAINERS_CONF_OVERRIDE',
  'CONTAINERS_REGISTRIES_CONF',
  'CONTAINERS_REGISTRIES_CONF_OVERRIDE',
  'REGISTRIES_CONFIG_PATH',
  'CONTAINERS_STORAGE_CONF',
  'CONTAINERS_STORAGE_CONF_OVERRIDE',
  'CONTAINERS_POLICY_JSON',
  'STORAGE_OPTS',
  'CONTAINERS_HELPER_BINARY_DIR',
  // Which registry credentials are sent (and which `credHelpers` entry is
  // exec'd): podman reads this before `DOCKER_CONFIG`.
  'REGISTRY_AUTH_FILE',
  // Rootless podman connects to the session bus to place the container in a
  // systemd scope, and passes the host's `NOTIFY_SOCKET` on so conmon writes
  // the container's sd_notify datagrams to that path.
  'DBUS_SESSION_BUS_ADDRESS',
  'NOTIFY_SOCKET',
  // Base directories BOTH podman and nerdctl derive the above from when the
  // specific var is unset: rootless config files (containers.conf,
  // registries.conf, storage.conf, nerdctl.toml, CNI net.d) under
  // `XDG_CONFIG_HOME`, and the rootless auth file, podman API socket
  // and nerdctl RootlessKit state dir under `XDG_RUNTIME_DIR`. `APPDATA` /
  // `PROGRAMDATA` are where containers/common reads the user / system
  // containers.conf on Windows, `PROGRAMFILES` is where nerdctl on Windows
  // looks for the CNI plugin binaries it execs, and `LOCALAPPDATA` is finch's
  // root directory on Windows (its `finch.yaml` configures the credential
  // helpers).
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'APPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'LOCALAPPDATA',
  // finch on macOS / Windows runs `limactl shell finch sudo -E nerdctl ...`
  // with the client's environment, and Lima splits `SSH` into shell words
  // and EXECS the result in place of `ssh` — code execution with no ssh
  // transport configured first, unlike the `SSH_*` entries above.
  'SSH',
  // nerdctl / containerd (go-to-k/cdkd#2188; nerdctl docs/config.md). `CONTAINERD_ADDRESS`
  // is nerdctl's `DOCKER_HOST`; `CONTAINERD_NAMESPACE` decides whose containers
  // and images it acts on; `NERDCTL_TOML` repoints the whole config
  // (address, namespace, CNI paths); nerdctl EXECS the CNI plugins found under
  // `CNI_PATH` (as root when rootful), which the net.d configs under
  // `NETCONFPATH` name. `ROOTLESSKIT_STATE_DIR` is where rootless nerdctl reads
  // the `child_pid` it `nsenter`s into. `NERDCTL_LOG_FILE` makes nerdctl
  // APPEND its log to the named path, as root when rootful.
  'CONTAINERD_ADDRESS',
  'CONTAINERD_NAMESPACE',
  'NERDCTL_TOML',
  'CNI_PATH',
  'NETCONFPATH',
  'ROOTLESSKIT_STATE_DIR',
  'NERDCTL_LOG_FILE',
  // Trust — a colliding secret repoints the client's trusted CA bundle for the
  // daemon / registry TLS handshake (Go's x509 honours these on Linux) or tunes
  // the Go runtime.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GODEBUG',
  // Proxy vars the client honors for registry connections — a colliding secret
  // could route the client's traffic (incl. image pulls) through an attacker.
  // Only the upper-case spellings are listed: matching is case-insensitive
  // (`DOCKER_CLIENT_ENV_KEYS_UPPER`), so lower-case duplicates were unreachable.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'FTP_PROXY',
  'ALL_PROXY',
]);

const DOCKER_CLIENT_ENV_KEYS_UPPER: ReadonlySet<string> = new Set(
  [...DOCKER_CLIENT_ENV_KEYS].map((k) => k.toUpperCase())
);

/**
 * Env-var prefixes whose WHOLE family the docker client (or a helper it execs)
 * reads, so a NAMED list is always one release behind and a colliding secret in
 * ANY member is a hazard. `LD_*` / `DYLD_*` are the dynamic loader (code
 * injection, glibc + macOS); `AWS_ENDPOINT_URL_*` is the per-service endpoint
 * family aws-sdk-go-v2 (and so `docker-credential-ecr-login`) honours — a
 * secret named `AWS_ENDPOINT_URL_ECR` walks around the exact
 * `AWS_ENDPOINT_URL` entry and redirects a request signed with the operator's
 * real credentials (go-to-k/cdkd#2186 round 4). `CLOUDSDK_` is gcloud's (go-to-k/cdkd#3599): every
 * gcloud property is settable as `CLOUDSDK_<SECTION>_<NAME>`, which covers
 * its token host, API endpoint overrides, proxy, CA bundle and account, and
 * the `docker-credential-gcloud` wrapper execs `$CLOUDSDK_PYTHON
 * $CLOUDSDK_PYTHON_ARGS`. `BASH_FUNC_` is bash's exported-function family.
 * No plausible secret name collides with these, apart from the one listed in
 * {@link DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS}. Matched by prefix rather than
 * enumerated (issue go-to-k/cdkd#2183 review). `SSH_` was a prefix here and was demoted to
 * an EXACT enumeration in {@link DOCKER_CLIENT_ENV_KEYS} (go-to-k/cdkd#2186 review round
 * 3): the family is not
 * uniformly dangerous and is not growing, while the prefix broke realistic,
 * currently-working secrets (`SSH_PRIVATE_KEY`, GitLab CI's canonical
 * deploy-key spelling). Exported so the test fence can assert the EXACT
 * contents — a hardcoded copy in the test made the anti-shadowing fence
 * one-directional (go-to-k/cdkd#2186 round 4 finding 2).
 */
export const DOCKER_CLIENT_ENV_PREFIXES: readonly string[] = [
  'LD_',
  'DYLD_',
  'AWS_ENDPOINT_URL_',
  'CLOUDSDK_',
  'BASH_FUNC_',
];

/**
 * Exact names inside a {@link DOCKER_CLIENT_ENV_PREFIXES} family that are still
 * delivered. An entry must be a realistic secret name AND harmless to the
 * helper that reads it. `CLOUDSDK_AUTH_ACCESS_TOKEN` is gcloud's own variable
 * for a caller-supplied access token (go-to-k/cdkd#3599). Given to `docker-credential-gcloud`,
 * it only changes which token gcloud hands docker, with no network call of its
 * own. gcloud's `auth docker-helper` answers only for a registry in its own
 * supported list unless `artifacts/allow_unrecognized_registry` is set, and
 * that property, the token host, the universe domain and every other variable
 * that could redirect or weaken the exchange stay refused by the `CLOUDSDK_`
 * prefix. Stored upper-case and matched case-insensitively. Never exempt an
 * exact {@link DOCKER_CLIENT_ENV_KEYS} member: the exact list wins.
 */
export const DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS: ReadonlySet<string> = new Set([
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
]);

/**
 * Is `key` the name of a var the docker client reads? Case-INSENSITIVE, because
 * Windows environment lookups are, so a lowercase `docker_host` must be caught
 * too (issue go-to-k/cdkd#2183). Matches the exact denylist OR a prefixed family — the
 * prefix families are fail-closed on the whole prefix, so an unlisted `LD_*` /
 * `DYLD_*` / `AWS_ENDPOINT_URL_*` / `CLOUDSDK_*` / `BASH_FUNC_*` secret is
 * dropped (with a rename warning) rather than reaching the client, except for
 * a name in {@link DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS}.
 */
export function isDockerClientEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (DOCKER_CLIENT_ENV_KEYS_UPPER.has(upper)) return true;
  if (DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS.has(upper)) return false;
  return DOCKER_CLIENT_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * A well-formed `docker run -e` variable NAME: non-empty, and containing
 * neither `=` (the OS parses the environ entry's name as everything before the
 * first one) nor NUL (Node refuses to spawn). A newline IS accepted, because it
 * is inside the class — not because of the anchor: JS `$` without the `m` flag
 * matches only at end of input (`/^abc$/.test('abc\n') === false`). That
 * matches the clause list this replaced, i.e. deliberately not stricter.
 */
// eslint-disable-next-line no-control-regex -- NUL is exactly the character refused.
const WELL_FORMED_ENV_KEY = /^[^=\u0000]+$/;

/**
 * Is `key` a shape that cannot be a well-formed `docker run -e` variable NAME?
 * Defined POSITIVELY as {@link WELL_FORMED_ENV_KEY}'s complement (go-to-k/cdkd#2186 rounds
 * 5-6). Enumerating the bad spellings one at a time closed `=` in round 4 and
 * left the empty key (`-e ''` — docker rejects it with an opaque error naming
 * no secret) and a NUL-bearing key still open; the complement closes any
 * further bad shape without another clause. A sensitive key matching this
 * takes the same fail-closed
 * collision path as a docker-client-var name: no `-e` flag, no spawn-env entry,
 * reported in `collisions`. (This is the NAME only.)
 */
export function isMalformedEnvKey(key: string): boolean {
  return !WELL_FORMED_ENV_KEY.test(key);
}
