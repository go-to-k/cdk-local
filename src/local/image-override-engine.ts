import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { isCancel, multiselect, text } from '@clack/prompts';
import { CdkLocalError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import { runDockerStreaming } from '../utils/docker-cmd.js';
import { getEmbedConfig } from './embed-config.js';
import { isInteractive } from './target-picker.js';

/**
 * Issue #238 — `--image-override` family for `cdkl start-service` /
 * `cdkl start-alb`. Turns "image pinned to a deployed registry" into
 * "image built locally from a supplied Dockerfile" on a per-service-
 * target basis, so a `--from-cfn-stack` boot can still iterate on
 * local source for the application container while real DynamoDB /
 * Secrets / SSM stay wired in.
 *
 * This module is pure orchestration: it parses the flag forms
 * (`<svc>=<dockerfile>` explicit, `<dockerfile>` picker-form, mixed),
 * fires `@clack/prompts` multi-selects to resolve picker-form entries
 * against uncovered pinned targets, optionally walks an interactive
 * boot prompt against the still-uncovered targets, runs `docker build`
 * once per covered target tagging a deterministic local-only tag, and
 * surfaces the resolved map back to the emulator. The emulator then
 * mutates the resolved ECS service's representative container image
 * to that tag (via the runner's `imageOverrideByContainer` hook) so
 * `docker run` boots the locally-built image instead of pulling the
 * deployed registry pin.
 *
 * The override goes through the rebuild rolling primitive on `--watch`
 * reload (Phase 2/3 of issue #214) — the classifier sees a CDK-asset-
 * like image (kind injected as `cdk-asset`-equivalent), so source-only
 * edits trigger the rolling rebuild rather than the no-op-reload skip
 * (#234's guard). The boot WARN that #237 introduced still fires for
 * uncovered pinned targets, but its `--watch` gate is dropped here so
 * the warning surfaces on any cold start when an ECR pin is detected
 * (per #238's "WARN broadening" line in the behavior matrix).
 *
 * Host-side use case: cdkd and other shim hosts that wrap
 * `runEcsServiceEmulator` re-export {@link resolveImageOverrides} +
 * {@link buildImageOverrideTag} via `cdk-local/internal` so their
 * `local start-service` / `local start-alb` ports inherit the override
 * pipeline 1:1 (and the deterministic local-tag naming) without a
 * byte-identical copy.
 *
 * @internal — not part of the semver-covered public surface; exposed
 * via `cdk-local/internal` only.
 */

/**
 * Per-target build inputs the engine collects from the CLI flags + boot
 * prompt + picker, then hands off to {@link runImageOverrideBuilds}.
 */
export interface ImageOverrideEntry {
  /** Absolute path to the Dockerfile to build from. */
  dockerfile: string;
  /** Absolute path to the build context directory (Dockerfile's parent for v1). */
  contextDir: string;
  /** `--image-build-arg KEY=VAL` pairs, applied globally to every override. */
  buildArgs: Map<string, string>;
  /** `--image-build-secret id=src` entries, applied globally to every override. */
  buildSecrets: Map<string, string>;
  /** Optional `--image-target <stage>` multi-stage build target. */
  targetStage?: string;
}

/** The fully resolved override map: service target string -> build inputs. */
export type ImageOverrideMap = Map<string, ImageOverrideEntry>;

/**
 * Errors surfaced by the engine. Used so the emulator can render a
 * consistent error class to the user (the global error handler maps
 * `CdkLocalError` subclasses to a clean stack-trace-free message).
 */
export class ImageOverrideError extends CdkLocalError {
  constructor(message: string, cause?: Error) {
    super(message, 'IMAGE_OVERRIDE_ERROR', cause);
    this.name = 'ImageOverrideError';
    Object.setPrototypeOf(this, ImageOverrideError.prototype);
  }
}

/**
 * Global build options that apply to every overridden target. v1 spec
 * keeps these flat (no per-service variants — tracked separately in
 * issue #240). Used inside {@link parseImageOverrideFlags} when promoting
 * each per-target raw entry into a full {@link ImageOverrideEntry}.
 */
export interface ImageOverrideGlobals {
  buildArgs: Map<string, string>;
  buildSecrets: Map<string, string>;
  targetStage?: string;
}

/**
 * Raw flag-parse outcome. Per-target dockerfile assignments split into
 * two buckets: explicit `<svc>=<dockerfile>` and picker-form
 * `<dockerfile>` (a bare path with no `=`, resolved against uncovered
 * pinned targets via a multi-select prompt). Both forms may appear in
 * one invocation; the emulator's resolver collapses them into a single
 * {@link ImageOverrideMap}.
 */
export interface RawImageOverrideFlags {
  /** Service target -> Dockerfile path (explicit mapping). */
  explicit: Map<string, string>;
  /**
   * Picker-form Dockerfile paths, in CLI argv order. Each fires its
   * own multi-select against the un-picked-so-far pinned targets;
   * earlier-occurrence picks are excluded from later pickers so one
   * service is never bound to two Dockerfiles.
   */
  pickerPaths: string[];
  globals: ImageOverrideGlobals;
}

/**
 * Parse the raw `--image-override` / `--image-build-arg` /
 * `--image-build-secret` / `--image-target` flag arrays Commander
 * surfaces into the structured {@link RawImageOverrideFlags} shape.
 * Pure (no docker / filesystem calls); throws
 * {@link ImageOverrideError} on a malformed token so the emulator can
 * surface a clean error before any container is touched.
 *
 * - `--image-override <svc>=<dockerfile>` -> `explicit.set(svc, dockerfile)`
 * - `--image-override <dockerfile>` (no `=`) -> `pickerPaths.push(...)`
 * - `--image-build-arg KEY=VAL` -> `globals.buildArgs.set('KEY', 'VAL')`
 * - `--image-build-secret id=src` -> `globals.buildSecrets.set('id', 'src')`
 * - `--image-target <stage>` -> `globals.targetStage = '<stage>'`
 *
 * Collision detection: a service target named more than once in
 * `--image-override <svc>=...` is an error (last-write-wins would
 * silently drop the earlier mapping; explicit error is clearer).
 */
export function parseImageOverrideFlags(input: {
  imageOverride?: string[];
  imageBuildArg?: string[];
  imageBuildSecret?: string[];
  imageTarget?: string;
}): RawImageOverrideFlags {
  const explicit = new Map<string, string>();
  const pickerPaths: string[] = [];
  for (const raw of input.imageOverride ?? []) {
    const eq = raw.indexOf('=');
    // No `=` -> picker form. An absolute path or a relative one both
    // pass through verbatim; existence is checked downstream when the
    // engine resolves which target this path binds to.
    if (eq < 0) {
      if (!raw) {
        throw new ImageOverrideError(
          'Invalid --image-override value: empty string. Pass <service>=<dockerfile> or just <dockerfile>.'
        );
      }
      pickerPaths.push(raw);
      continue;
    }
    const svc = raw.slice(0, eq).trim();
    const dockerfile = raw.slice(eq + 1).trim();
    if (!svc) {
      throw new ImageOverrideError(
        `Invalid --image-override value "${raw}": left side (service target) is empty.`
      );
    }
    if (!dockerfile) {
      throw new ImageOverrideError(
        `Invalid --image-override value "${raw}": right side (Dockerfile path) is empty.`
      );
    }
    if (explicit.has(svc)) {
      throw new ImageOverrideError(
        `Duplicate --image-override for service '${svc}': already mapped to '${explicit.get(svc)}'. ` +
          'Pass each service target at most once in explicit form.'
      );
    }
    explicit.set(svc, dockerfile);
  }

  const buildArgs = new Map<string, string>();
  for (const raw of input.imageBuildArg ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new ImageOverrideError(`Invalid --image-build-arg value "${raw}": expected KEY=VAL.`);
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    if (!key) {
      throw new ImageOverrideError(`Invalid --image-build-arg value "${raw}": empty key.`);
    }
    buildArgs.set(key, value);
  }

  const buildSecrets = new Map<string, string>();
  for (const raw of input.imageBuildSecret ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new ImageOverrideError(
        `Invalid --image-build-secret value "${raw}": expected id=src (e.g. npmrc=./.npmrc).`
      );
    }
    const id = raw.slice(0, eq).trim();
    const src = raw.slice(eq + 1).trim();
    if (!id || !src) {
      throw new ImageOverrideError(
        `Invalid --image-build-secret value "${raw}": id and src must both be non-empty.`
      );
    }
    buildSecrets.set(id, src);
  }

  const globals: ImageOverrideGlobals = { buildArgs, buildSecrets };
  if (input.imageTarget !== undefined) {
    if (!input.imageTarget) {
      throw new ImageOverrideError('Invalid --image-target value: empty string.');
    }
    globals.targetStage = input.imageTarget;
  }

  return { explicit, pickerPaths, globals };
}

/**
 * Resolve `--image-override` flag inputs (raw) + a list of pinned
 * service targets into the final {@link ImageOverrideMap}. Walks four
 * stages:
 *
 *   1. Apply every explicit `<svc>=<dockerfile>` mapping. A service in
 *      `explicit` but NOT in `pinnedTargets` is a no-op warning
 *      (logged at warn) — the user named a non-pinned target, which
 *      probably indicates a typo or a CDK app change; we don't fail.
 *   2. For each picker-form Dockerfile path, fire a multi-select against
 *      the still-uncovered pinned targets. A single picker-form path
 *      may bind to multiple targets (one Dockerfile shared across N
 *      services); already-bound targets are excluded from later pickers.
 *      Skipped when not in a TTY OR `noInteractive` is true — those
 *      contexts emit a warning and skip the picker path (treated as
 *      "no override for any target").
 *   3. Optional boot prompt: when `interactiveBootPrompt` is true AND
 *      we're in a TTY, walk each remaining uncovered pinned target
 *      and ask "Override with a local build? [path / N]" via clack's
 *      `text` prompt. A non-empty answer is treated as an additional
 *      explicit mapping; `N` / empty / Esc skips the target.
 *
 * Returns the resolved override map. Throws
 * {@link ImageOverrideError} on a malformed picker response or a
 * Dockerfile path that doesn't exist (caught up-front before any
 * docker build runs).
 */
export async function resolveImageOverrides(args: {
  rawFlags: RawImageOverrideFlags;
  /**
   * Service target strings whose representative image is pinned to a
   * deployed registry (the engine only needs the names, not the full
   * resolved services).
   */
  pinnedTargets: ReadonlyArray<string>;
  /**
   * Display label per pinned target (typically the deployed-registry
   * URI from {@link describePinnedImageUri}). Surfaced in the boot
   * prompt + picker hint so the user knows which image they're
   * overriding. Optional — falls back to the target name.
   */
  pinnedLabels?: ReadonlyMap<string, string>;
  /**
   * When true and a TTY is present AND a picker-form Dockerfile or a
   * boot-prompt path was supplied, the engine prompts. When false /
   * non-TTY, prompts are skipped and the resolver returns whatever
   * the explicit map covers (possibly empty).
   */
  interactiveBootPrompt?: boolean;
  /**
   * When true, every interactive prompt is suppressed (boot prompt
   * AND picker-form). Mirrors `--no-interactive-overrides`.
   */
  noInteractive?: boolean;
  /**
   * Working directory used to resolve relative `--image-override`
   * paths. Defaults to `process.cwd()`. Passed in so tests can inject
   * a tmp dir.
   */
  cwd?: string;
}): Promise<ImageOverrideMap> {
  const logger = getLogger();
  const { rawFlags, pinnedTargets, noInteractive } = args;
  const cwd = args.cwd ?? process.cwd();
  const pinnedSet = new Set(pinnedTargets);
  const labels = args.pinnedLabels ?? new Map();

  // Stage 1: explicit mappings.
  const out = new Map<string, ImageOverrideEntry>();
  for (const [svc, dockerfileRaw] of rawFlags.explicit.entries()) {
    if (!pinnedSet.has(svc)) {
      logger.warn(
        `--image-override: service '${svc}' is not in the pinned-target set ` +
          '(no deployed-registry pin detected for it). Mapping ignored.'
      );
      continue;
    }
    out.set(svc, makeEntryFromPath(dockerfileRaw, rawFlags.globals, cwd));
  }

  // Stage 2: picker-form Dockerfile paths.
  if (rawFlags.pickerPaths.length > 0) {
    const canPrompt = isInteractive() && noInteractive !== true;
    if (!canPrompt) {
      logger.warn(
        `--image-override <dockerfile> (picker form) requires an interactive TTY ` +
          'and --no-interactive-overrides not to be set. Skipping picker-form mapping(s).'
      );
    } else {
      for (const dockerfileRaw of rawFlags.pickerPaths) {
        const uncovered = pinnedTargets.filter((t) => !out.has(t));
        if (uncovered.length === 0) {
          logger.warn(
            `--image-override ${dockerfileRaw}: no uncovered pinned targets left to bind to. Skipped.`
          );
          continue;
        }
        const options = uncovered.map((t) => ({
          value: t,
          label: t,
          ...(labels.get(t) ? { hint: labels.get(t) as string } : {}),
        }));
        const picked = await multiselect({
          message:
            `Pick the pinned target(s) to bind to ` +
            `'${dockerfileRaw}' (space to toggle, enter to confirm; empty cancels):`,
          options,
          required: false,
        });
        if (isCancel(picked)) {
          throw new ImageOverrideError(
            'Image-override picker cancelled. Re-run without picker-form or with --no-interactive-overrides.'
          );
        }
        const chosen = (picked as string[] | undefined) ?? [];
        if (chosen.length === 0) {
          logger.warn(`--image-override ${dockerfileRaw}: empty selection. Skipped.`);
          continue;
        }
        const entry = makeEntryFromPath(dockerfileRaw, rawFlags.globals, cwd);
        for (const t of chosen) out.set(t, entry);
      }
    }
  }

  // Stage 3: interactive boot prompt for the still-uncovered pinned
  // targets. Gated on TTY + the caller's opt-in flag + the user not
  // having passed --no-interactive-overrides.
  if (args.interactiveBootPrompt === true && isInteractive() && noInteractive !== true) {
    for (const target of pinnedTargets) {
      if (out.has(target)) continue;
      const label = labels.get(target);
      const message =
        `Detected pinned image on '${target}'` +
        (label ? ` (${label})` : '') +
        '. Override with a local build? Enter a Dockerfile path, or leave blank to skip.';
      const answer = await text({
        message,
        placeholder: '',
      });
      if (isCancel(answer)) {
        throw new ImageOverrideError(
          'Image-override boot prompt cancelled. Re-run with --no-interactive-overrides to suppress, or pass --image-override explicitly.'
        );
      }
      const value = ((answer as string | undefined) ?? '').trim();
      if (!value || value.toUpperCase() === 'N') continue;
      out.set(target, makeEntryFromPath(value, rawFlags.globals, cwd));
    }
  }

  return out;
}

/**
 * Promote a per-target Dockerfile path + globals into a full
 * {@link ImageOverrideEntry}. Resolves the path against `cwd`, asserts
 * the Dockerfile exists and is a regular file (so the user sees
 * "file not found" up-front rather than mid-`docker build`), and
 * derives the build context as the Dockerfile's parent directory
 * (the v1 simplification — custom contexts are tracked separately).
 */
function makeEntryFromPath(
  raw: string,
  globals: ImageOverrideGlobals,
  cwd: string
): ImageOverrideEntry {
  const abs = isAbsolute(raw) ? raw : resolvePath(cwd, raw);
  if (!existsSync(abs)) {
    throw new ImageOverrideError(
      `--image-override: Dockerfile '${raw}' does not exist (resolved to '${abs}').`
    );
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    throw new ImageOverrideError(
      `--image-override: '${raw}' is not a regular file (resolved to '${abs}').`
    );
  }
  return {
    dockerfile: abs,
    contextDir: dirname(abs),
    buildArgs: globals.buildArgs,
    buildSecrets: globals.buildSecrets,
    ...(globals.targetStage !== undefined && { targetStage: globals.targetStage }),
  };
}

/**
 * Deterministic local-only image tag for one override entry. Fingerprints
 * the Dockerfile path + service target + build args / secrets / stage so
 * a re-run with the same inputs hits docker's layer cache.
 *
 * Tag shape: `<resourceNamePrefix>-override-<svcSlug>-<hash>:local`.
 * `:local` is intentionally NOT `:latest` so a `docker pull` on it fails
 * fast (these images are local-build-only by design).
 */
export function buildImageOverrideTag(serviceTarget: string, entry: ImageOverrideEntry): string {
  const hash = createHash('sha256');
  hash.update('dockerfile=');
  hash.update(entry.dockerfile);
  hash.update('\0target=');
  hash.update(serviceTarget);
  hash.update('\0stage=');
  hash.update(entry.targetStage ?? '');
  hash.update('\0args={');
  for (const [k, v] of entry.buildArgs.entries()) {
    hash.update(k);
    hash.update('=');
    hash.update(v);
    hash.update(';');
  }
  hash.update('}\0secrets={');
  for (const [k, v] of entry.buildSecrets.entries()) {
    hash.update(k);
    hash.update('=');
    hash.update(v);
    hash.update(';');
  }
  hash.update('}');
  const svcSlug = serviceTarget
    .replace(/[^A-Za-z0-9]+/g, '-')
    .slice(0, 24)
    .toLowerCase();
  return `${getEmbedConfig().resourceNamePrefix}-override-${svcSlug}-${hash
    .digest('hex')
    .slice(0, 16)}:local`;
}

/**
 * Build every overridden image via `docker build`. Returns a per-target
 * `serviceTarget -> localTag` map the emulator threads into each
 * runner's `imageOverrideByContainer` (mutating the resolved service's
 * representative container's image to this tag).
 *
 * Each build runs sequentially (parallelism is left to docker's own
 * BuildKit cache — most overrides share a base image, so a sequential
 * order maximizes cache reuse). On any failure the function rejects
 * with {@link ImageOverrideError}; the emulator surfaces this before
 * any container is started.
 */
export async function runImageOverrideBuilds(
  overrides: ImageOverrideMap
): Promise<Map<string, string>> {
  const logger = getLogger();
  const out = new Map<string, string>();
  for (const [target, entry] of overrides.entries()) {
    const tag = buildImageOverrideTag(target, entry);
    const args: string[] = ['build', '--tag', tag, '--file', entry.dockerfile];
    for (const [k, v] of entry.buildArgs.entries()) {
      args.push('--build-arg', `${k}=${v}`);
    }
    for (const [id, src] of entry.buildSecrets.entries()) {
      args.push('--secret', `id=${id},src=${src}`);
    }
    if (entry.targetStage !== undefined) {
      args.push('--target', entry.targetStage);
    }
    args.push('.');
    logger.info(
      `Building override image for '${target}' from '${entry.dockerfile}' (tag=${tag})...`
    );
    try {
      await runDockerStreaming(args, {
        cwd: entry.contextDir,
        env: { BUILDX_NO_DEFAULT_ATTESTATIONS: '1' },
      });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new ImageOverrideError(
        `docker build failed for --image-override '${target}' (Dockerfile=${entry.dockerfile}): ` +
          (e.stderr?.trim() || e.message || String(err))
      );
    }
    out.set(target, tag);
  }
  return out;
}
