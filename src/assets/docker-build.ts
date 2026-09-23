import type { DockerCacheOption, DockerImageAssetSource } from '../types/assets.js';
import { getDockerCmd, runDockerStreaming, spawnStreaming } from '../utils/docker-cmd.js';
import { sanitizeServiceExceptionMessage } from '../local/credential-error.js';
import { getLogger } from '../utils/logger.js';

/**
 * Shared `docker build` invocation used by both
 * `src/assets/docker-asset-publisher.ts` (publish to ECR) and
 * `src/local/docker-image-builder.ts` (run a container Lambda locally via
 * `cdkl invoke`).
 *
 * Parity with CDK CLI's `@aws-cdk/cdk-assets-lib`:
 *   - Streaming spawn via `runDockerStreaming` (no `execFile` `maxBuffer`
 *     ceiling — BuildKit progress on a `# syntax=docker/dockerfile:1`
 *     frontend pull + multi-stage build can run into the tens of MB and
 *     used to silently die at the 50 MB cap cdk-local previously set).
 *   - Sets `BUILDX_NO_DEFAULT_ATTESTATIONS=1` so the resulting image stays
 *     a single-arch image suitable for ECR pull (Docker Buildx otherwise
 *     attaches provenance attestation manifests that confuse the publish
 *     path).
 *   - Resolves the docker binary via `getDockerCmd()` so users can swap to
 *     `podman` / `finch` / `nerdctl` via the `CDK_DOCKER` env var.
 *   - Full BuildKit flag set: `--build-context`, `--secret`, `--ssh`,
 *     `--network`, `--cache-from`, `--cache-to`, `--no-cache`,
 *     `--platform`, `--output`. Each is emitted only when the
 *     corresponding asset-source field is set, so legacy builds without
 *     these features still work unchanged.
 *
 * Build-arg iteration order is preserved per `Object.entries(...)` — this
 * is load-bearing for layer-cache reproducibility across both callers.
 *
 * The caller-supplied `wrapError` lets each consumer wrap the failure
 * with its own typed error class (`LocalInvokeBuildError` for local
 * invoke; a host's asset-publish path supplies its own).
 */

export interface BuildDockerImageOptions {
  /**
   * Local image tag (`--tag`) for `directory` mode. The caller chooses a
   * deterministic tag so subsequent runs hit Docker's layer cache
   * (local-invoke uses `cdkl-invoke-<hash>`). Ignored in `executable`
   * mode — there
   * the executable returns its own tag on stdout.
   */
  tag?: string;
  /**
   * Optional `--platform` override. When set, takes precedence over
   * `asset.source.platform` from the manifest. Used by `cdkl invoke`
   * to thread Lambda's `Architectures: [x86_64|arm64]` through to docker
   * build / run.
   */
  platform?: string;
  /**
   * Wrap the underlying docker / build-script failure in a typed error
   * specific to the call site.
   */
  wrapError: (stderr: string) => Error;
  /**
   * When set, forward to `runDockerStreaming` so an interactive spinner
   * renders for the duration of the `docker build`. Callers like
   * `docker-image-builder.ts` (Lambda container builds) and
   * `ecs-task-runner.ts` (ECS asset builds) set this to "Building
   * container image '<tag>'..." so real-world multi-minute builds don't
   * look like cdk-local hung. No-op in `executable` source mode and
   * when stdout is non-TTY.
   */
  progressLabel?: string;
}

/**
 * Announce that a Docker asset's `source.executable` is about to run.
 *
 * The command line comes from the asset manifest, which is chosen by whoever
 * wrote the assembly, and cdk-local SPAWNS it — so a `cdkl` command against a
 * pre-synthesized assembly executes code the CloudFormation template does not
 * show. It is RUN, never refused: CDK CLI's `buildExternalAsset` does the same,
 * and an assembly is trusted input. What was missing is the line saying so.
 *
 * **It names `executable[0]` and an argument COUNT, deliberately, and the full
 * argv must stay at `debug`.** Rendering every argument at warn level is a new
 * leak introduced by a warning about leaks: a build script is not `docker
 * build`, so its own `--token ghp_…` or `--password=…` matches no argv masker's
 * flag shapes, and the warning would promote it from `--verbose`-only to a line
 * in every CI log of every run. That was a live defect in the host's copy of
 * this warning (go-to-k/cdkd#3497); do not "improve" this by expanding it.
 *
 * Placed in `buildDockerImage` rather than at a call site because this is the
 * ONE spawn point: `docker-image-builder.ts` (`invoke` / `start-api` /
 * `invoke-agentcore` / `start-agentcore`, the last two through
 * `resolveAgentCoreImage`) and `ecs-task-runner.ts` (`run-task` /
 * `start-service` / `start-alb`) both reach it, and `studio` inherits it by
 * spawning those as children. The two ECS server commands were the gap
 * (go-to-k/cdkd#3540) — the host cannot warn for them, since it re-exports
 * `runEcsServiceEmulator` as a bare passthrough and the asset build happens
 * several layers inside this engine.
 *
 * **Announced ONCE per distinct command line per process, not once per
 * spawn.** The spawn genuinely repeats — `ecs-service-runner.ts` boots every
 * replica through `bootReplica` and restarts a crashed one the same way, and
 * the agentcore commands re-resolve on reload — so a `DesiredCount: 3` service
 * would print this ~450-character paragraph three times at boot and again per
 * crash-loop restart. That is a storm, and a storm is not read. Repeats drop
 * to `debug`, where the argv already is. Deduping the LINE must never dedupe
 * the WORK: the spawn happens every time regardless.
 *
 * `sanitizeServiceExceptionMessage` for the same reason `assembly-path.ts`
 * uses it: the value is manifest-chosen, it keeps control characters, and an
 * unsanitized one lets the command forge its own log line. It is applied to
 * the DISPLAYED command only — the dedupe key is built from the raw argv and
 * cwd, so two commands differing only in control characters stay distinct
 * keys.
 */
const warnedExecutables = new Set<string>();

/** Test seam; a process serves one assembly, so the set is per invocation. */
export function resetManifestExecutableWarnings(): void {
  warnedExecutables.clear();
}

function warnManifestExecutable(cmd: string, executable: readonly string[], cwd: string): void {
  const logger = getLogger().child('docker-build');
  // `JSON.stringify`, not a NUL join: a NUL-joined composite is the record-key
  // shape this repo fences, and it is not one — this key never leaves the
  // process and is never persisted. The array form is also unambiguous about
  // where one argument ends, which a joined string is not.
  //
  // **`cwd` is part of the key, not decoration.** The command's meaning
  // depends on where it runs — an asset's `source.directory` decides that, and
  // `./build.sh` under two asset directories is two different scripts. Keying
  // on the argv alone silently suppresses the second one, which is the very
  // failure the per-command key exists to prevent, one level down. Two
  // asset-backed containers in one `run-task` / `start-service` / `start-api`
  // run reach it.
  const key = JSON.stringify([cwd, executable]);
  if (warnedExecutables.has(key)) {
    logger.debug(
      `source.executable already announced this process: ` +
        `${sanitizeServiceExceptionMessage(cmd)} (cwd=${cwd})`
    );
    return;
  }
  warnedExecutables.add(key);
  const argCount = executable.length - 1;
  logger.warn(
    `Docker asset source.executable runs a command this asset manifest chose, on ` +
      `this machine: '${sanitizeServiceExceptionMessage(cmd)}'` +
      (argCount > 0 ? ` (with ${argCount} argument(s); --verbose shows them)` : '') +
      `. cdk-local runs it, matching the CDK CLI — a pre-synthesized assembly is ` +
      `trusted input. Note that this means running a local command against a ` +
      `pre-synthesized assembly DOES execute code from it, which the ` +
      `CloudFormation template does not show.`
  );
}

/**
 * Build a Docker image from a CDK asset source. Returns the local image
 * tag the caller should use for `docker tag` / `docker push` (publisher)
 * or `docker run` (local-invoke).
 *
 * Two source modes (mirrors CDK CLI):
 *   - `executable`: run the user-supplied command, capture stdout, return
 *     it as the local tag. The script is responsible for building AND
 *     tagging; cdk-local just reads the tag from stdout. Used for Bazel /
 *     custom build pipelines that produce images outside `docker build`.
 *   - `directory`: standard `docker build <dir>` with the full BuildKit
 *     flag set described above. Caller must pass `options.tag`.
 *
 * `executable` takes precedence when both fields are set (matches CDK CLI).
 */
export async function buildDockerImage(
  asset: { source: DockerImageAssetSource },
  cdkOutDir: string,
  options: BuildDockerImageOptions
): Promise<string> {
  const source = asset.source;
  const logger = getLogger().child('docker-build');

  // Executable source: run the script and read stdout for the tag.
  //
  // We do NOT inject `BUILDX_NO_DEFAULT_ATTESTATIONS=1` into the
  // executable's env. The script may not be docker (Bazel, custom shell,
  // etc.) and even when it IS docker, the attestation suppression is the
  // SCRIPT's responsibility — CDK CLI's `cdk-assets-lib` `buildExternalAsset`
  // takes the same stance for parity. If the script invokes `docker build`
  // internally and the resulting image carries an attestation manifest
  // that breaks ECR pull, the user's script should set the env itself.
  if (source.executable && source.executable.length > 0) {
    const [cmd, ...args] = source.executable;
    if (!cmd) {
      throw options.wrapError('asset source.executable[] is empty');
    }
    // The executable runs from the asset directory when one is provided
    // (mirrors CDK CLI's `cwd: assetPath` in `buildExternalAsset`). When
    // `directory` is unset, the executable runs from `cdkOutDir`.
    const cwd = source.directory ? `${cdkOutDir}/${source.directory}` : cdkOutDir;

    logger.debug(
      `Building Docker image via executable: ${source.executable.join(' ')} (cwd=${cwd})`
    );
    warnManifestExecutable(cmd, source.executable, cwd);

    let result;
    try {
      result = await spawnStreaming(cmd, args, { cwd });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw options.wrapError(e.stderr || e.message || String(err));
    }
    const tag = result.stdout.trim();
    if (!tag) {
      throw options.wrapError(
        `docker build executable produced no output (expected the local image tag on stdout): ${cmd} ${args.join(' ')}`
      );
    }
    return tag;
  }

  // Directory source: standard docker build.
  if (!source.directory) {
    throw options.wrapError(
      `DockerImageAssetSource must set either 'directory' or 'executable' (got: ${JSON.stringify(source)})`
    );
  }
  if (!options.tag) {
    throw options.wrapError('buildDockerImage(directory mode) requires options.tag');
  }

  const buildArgs = buildDockerBuildCommand(source, options.tag, options.platform);
  // Use `.` as the context and set `cwd` to the asset directory. Mirrors
  // CDK CLI's `cdk-assets-lib` Docker.build — load-bearing because
  // BuildKit flags like `--secret id=X,src=relative.txt` /
  // `--build-context name=relative/path` resolve relative paths against
  // the build's cwd, NOT against the trailing context positional. Passing
  // an absolute context dir with no cwd silently breaks those flags.
  const contextDir = `${cdkOutDir}/${source.directory}`;
  buildArgs.push('.');

  logger.debug(`${getDockerCmd()} ${buildArgs.join(' ')} (cwd=${contextDir})`);

  try {
    await runDockerStreaming(buildArgs, {
      cwd: contextDir,
      // BUILDX_NO_DEFAULT_ATTESTATIONS=1 matches `cdk-assets-lib` — without
      // this, BuildKit/Buildx attaches provenance attestation manifests
      // that ECR's single-arch pull path rejects.
      env: { BUILDX_NO_DEFAULT_ATTESTATIONS: '1' },
      ...(options.progressLabel !== undefined && { progressLabel: options.progressLabel }),
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw options.wrapError(e.stderr || e.message || String(err));
  }

  return options.tag;
}

/**
 * Construct the `docker build` argv (without the trailing context directory).
 *
 * Exported for unit-test inspection — keeps the flag-ordering assertions
 * independent of the spawn machinery.
 */
export function buildDockerBuildCommand(
  source: DockerImageAssetSource,
  tag: string,
  platformOverride?: string
): string[] {
  // `--tag` (not `-t`) and `--file` (not `-f`) are the long-form names CDK
  // CLI's `cdk-assets-lib` emits. docker treats short / long aliases
  // identically, so this is cosmetic — but matching CDK CLI verbatim makes
  // a side-by-side comparison of the rendered argv (in --verbose logs)
  // grep-clean and removes one source of "why is this slightly different?"
  // confusion.
  const args: string[] = ['build', '--tag', tag];

  // Build args (Object.entries order preserved for layer-cache stability).
  if (source.dockerBuildArgs) {
    for (const [k, v] of Object.entries(source.dockerBuildArgs)) {
      args.push('--build-arg', `${k}=${v}`);
    }
  }

  // Build contexts (BuildKit 1.4+).
  if (source.dockerBuildContexts) {
    for (const [k, v] of Object.entries(source.dockerBuildContexts)) {
      args.push('--build-context', `${k}=${v}`);
    }
  }

  // Build secrets (BuildKit).
  if (source.dockerBuildSecrets) {
    for (const [k, v] of Object.entries(source.dockerBuildSecrets)) {
      args.push('--secret', `id=${k},${v}`);
    }
  }

  // SSH agent (BuildKit).
  if (source.dockerBuildSsh) {
    args.push('--ssh', source.dockerBuildSsh);
  }

  if (source.dockerBuildTarget) {
    args.push('--target', source.dockerBuildTarget);
  }

  if (source.dockerFile) {
    args.push('--file', source.dockerFile);
  }

  if (source.networkMode) {
    args.push('--network', source.networkMode);
  }

  // Platform: caller-provided override wins; otherwise source.platform from manifest.
  const platform = platformOverride ?? source.platform;
  if (platform) {
    args.push('--platform', platform);
  }

  // Outputs: CDK uses `--output=<value>` (single arg) which is what BuildKit
  // expects; the older `--output <value>` two-arg form works too but we
  // match CDK exactly for parity.
  if (source.dockerOutputs) {
    for (const output of source.dockerOutputs) {
      args.push(`--output=${output}`);
    }
  }

  if (source.cacheFrom) {
    for (const c of source.cacheFrom) {
      args.push('--cache-from', cacheOptionToFlag(c));
    }
  }
  if (source.cacheTo) {
    args.push('--cache-to', cacheOptionToFlag(source.cacheTo));
  }
  if (source.cacheDisabled) {
    args.push('--no-cache');
  }

  return args;
}

function cacheOptionToFlag(option: DockerCacheOption): string {
  let flag = `type=${option.type}`;
  if (option.params) {
    for (const [k, v] of Object.entries(option.params)) {
      flag += `,${k}=${v}`;
    }
  }
  return flag;
}
