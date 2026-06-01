import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { isCancel, multiselect, text } from '@clack/prompts';
import { CdkLocalError, LocalStartServiceError } from '../utils/error-handler.js';
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
 *
 * `buildArgs` / `buildSecrets` / `targetStage` are the EFFECTIVE inputs
 * for THIS target's `docker build` — already a merge of the global
 * (`--image-build-arg KEY=VAL` etc.) AND the per-service
 * (`<svc>:KEY=VAL` etc.) flag forms (issue #240). The per-service form
 * overrides the global per key when both match the target.
 */
export interface ImageOverrideEntry {
  /** Absolute path to the Dockerfile to build from. */
  dockerfile: string;
  /** Absolute path to the build context directory (Dockerfile's parent for v1). */
  contextDir: string;
  /**
   * Effective build args for this target — global + per-service merged
   * (per-service wins on key collision). Order: globals first, then
   * per-service entries (Map iteration order = insertion order, so a
   * per-service override on a globally-set key keeps its own position
   * because the merge re-assigns the key in place).
   */
  buildArgs: Map<string, string>;
  /**
   * Effective build secrets for this target — global + per-service
   * merged (per-service wins on id collision).
   */
  buildSecrets: Map<string, string>;
  /**
   * Effective `--target <stage>` value. Per-service `<svc>=<stage>`
   * wins over the global `--image-target <stage>` when both are set.
   */
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
 * Global build options that apply to EVERY overridden target. Issue
 * #240 added per-service variants (see {@link PerServiceBuildInputs}
 * on {@link RawImageOverrideFlags}); the global form remains the
 * baseline that per-service entries layer on top of (per-service wins
 * on key collision).
 */
export interface ImageOverrideGlobals {
  buildArgs: Map<string, string>;
  buildSecrets: Map<string, string>;
  targetStage?: string;
}

/**
 * Issue #240 — per-service build inputs collected from the prefixed
 * flag forms (`<svc>:KEY=VAL` for build-arg / build-secret;
 * `<svc>=stage` for target). One entry per named service; missing
 * fields fall through to the corresponding {@link ImageOverrideGlobals}
 * value at merge time.
 *
 * Service-name validation happens in {@link enforceImageOverrideOrphans}
 * AFTER picker + boot-prompt resolve — a per-service flag that names a
 * service with no `--image-override` mapping (and no boot-prompt-
 * injected mapping) is a hard error so the user can't silently get
 * "my AppService:KEY=val flag was ignored because I forgot to add
 * --image-override AppService".
 */
export interface PerServiceBuildInputs {
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
 *
 * Issue #240 added the `perService` bucket: prefixed forms of the
 * build-input flags (`<svc>:KEY=VAL`, `<svc>:id=src`, `<svc>=stage`)
 * land here keyed by service name. The global counterparts stay in
 * {@link ImageOverrideGlobals}; the resolver merges global + per-service
 * per-target when promoting into {@link ImageOverrideEntry}.
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
  /**
   * Issue #240 — per-service overlay on top of {@link globals}. Keyed
   * by service name (the part LEFT of the leading `:` for build-arg /
   * build-secret; LEFT of `=` for target). Empty when no per-service
   * flag form appears in the invocation.
   */
  perService: Map<string, PerServiceBuildInputs>;
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
 * - `--image-build-arg <svc>:KEY=VAL` -> `perService(svc).buildArgs.set('KEY', 'VAL')` (issue #240)
 * - `--image-build-secret id=src` -> `globals.buildSecrets.set('id', 'src')`
 * - `--image-build-secret <svc>:id=src` -> `perService(svc).buildSecrets.set('id', 'src')` (issue #240)
 * - `--image-target <stage>` -> `globals.targetStage = '<stage>'`
 * - `--image-target <svc>=<stage>` -> `perService(svc).targetStage = '<stage>'` (issue #240)
 *
 * Per-service syntax convention (issue #240):
 * - Flags whose payload already contains `=` (build-arg, build-secret)
 *   use `:` to separate the service prefix from the `<key>=<value>`
 *   payload — `<svc>:KEY=VAL`. The FIRST `:` before the FIRST `=` (if
 *   any) is treated as the prefix delimiter.
 * - Flags whose payload is a single token (target) use `=` to separate
 *   the service prefix from the stage — `<svc>=stage`. Matches the
 *   `--image-override <svc>=<dockerfile>` convention.
 * - Per-service entries override the global entry per-key when both
 *   forms set the same key on the same target. Globals still apply to
 *   every OTHER overridden target.
 *
 * Collision detection: a service target named more than once in
 * `--image-override <svc>=...` is an error (last-write-wins would
 * silently drop the earlier mapping; explicit error is clearer).
 * Repeated per-service `--image-build-arg <svc>:KEY=...` entries on
 * the same `<svc>:KEY` pair are last-write-wins (the same shape the
 * global form already uses for repeated `KEY=...` entries — both
 * forms behave identically inside their respective bucket).
 *
 * Empty-value semantics:
 * - `--image-build-arg KEY=` (empty value) is ACCEPTED. The empty
 *   string is forwarded verbatim to `docker build --build-arg KEY=`,
 *   which docker itself accepts (the canonical way to unset a
 *   Dockerfile `ARG`'s default). `KEY=` (empty key) is rejected.
 *   Per-service form `<svc>:KEY=` is similarly accepted (same empty-
 *   value semantics applied to the per-service entry).
 * - `--image-target ""` (empty value) is REJECTED — an empty
 *   `--target` is meaningless to `docker build` (`--target` is a
 *   single stage name, not a list). Per-service `<svc>=` is similarly
 *   rejected (empty stage).
 * - `--image-override <svc>=` and `--image-override =<dockerfile>`
 *   are REJECTED — both halves must be non-empty.
 * - `--image-build-secret id=` and `--image-build-secret =src` are
 *   REJECTED — both halves must be non-empty. Per-service form
 *   `<svc>:id=` and `<svc>:=src` are similarly rejected.
 */
export function parseImageOverrideFlags(input: {
  imageOverride?: string[];
  imageBuildArg?: string[];
  imageBuildSecret?: string[];
  /**
   * `--image-target` may now be repeated to support per-service forms
   * alongside a global. Accepts the legacy single-string shape too,
   * so existing call sites that pass a scalar don't break.
   */
  imageTarget?: string | string[];
}): RawImageOverrideFlags {
  const explicit = new Map<string, string>();
  const pickerPaths: string[] = [];
  const perService = new Map<string, PerServiceBuildInputs>();
  // Lazily fetch / create a per-service bucket. Centralized so we don't
  // forget to initialize a new `PerServiceBuildInputs` on the first
  // touch of a service name.
  const getPerSvc = (svc: string): PerServiceBuildInputs => {
    let entry = perService.get(svc);
    if (!entry) {
      entry = { buildArgs: new Map(), buildSecrets: new Map() };
      perService.set(svc, entry);
    }
    return entry;
  };
  // Split a `<svc>:<rest>` raw token at the FIRST `:` BEFORE the FIRST
  // `=` (if any). Returns null when the raw value carries no leading
  // service prefix (i.e. the value is the legacy global form).
  // The `:` MUST precede the `=` to count as a per-service prefix —
  // otherwise a `KEY=val:with:colons` value would be misparsed.
  const splitPerServicePrefix = (raw: string): { svc: string; rest: string } | null => {
    const colon = raw.indexOf(':');
    const eq = raw.indexOf('=');
    if (colon < 0) return null;
    if (eq >= 0 && eq < colon) return null;
    const svc = raw.slice(0, colon).trim();
    if (!svc) return null;
    return { svc, rest: raw.slice(colon + 1) };
  };
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
    const prefix = splitPerServicePrefix(raw);
    if (prefix) {
      // Per-service form `<svc>:KEY=VAL`. Validate KEY=VAL inside the
      // post-prefix `rest` portion under the same rules the global
      // form uses (empty VAL OK, empty KEY rejected).
      const eq = prefix.rest.indexOf('=');
      if (eq <= 0) {
        throw new ImageOverrideError(
          `Invalid --image-build-arg value "${raw}": expected <service>:KEY=VAL.`
        );
      }
      const key = prefix.rest.slice(0, eq).trim();
      const value = prefix.rest.slice(eq + 1);
      if (!key) {
        throw new ImageOverrideError(
          `Invalid --image-build-arg value "${raw}": empty key (after service prefix).`
        );
      }
      getPerSvc(prefix.svc).buildArgs.set(key, value);
      continue;
    }
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
    const prefix = splitPerServicePrefix(raw);
    if (prefix) {
      // Per-service form `<svc>:id=src`. Validate id=src inside `rest`
      // under the same rules as global (both halves non-empty).
      const eq = prefix.rest.indexOf('=');
      if (eq <= 0) {
        throw new ImageOverrideError(
          `Invalid --image-build-secret value "${raw}": expected <service>:id=src (e.g. AppService:npmrc=./.npmrc).`
        );
      }
      const id = prefix.rest.slice(0, eq).trim();
      const src = prefix.rest.slice(eq + 1).trim();
      if (!id || !src) {
        throw new ImageOverrideError(
          `Invalid --image-build-secret value "${raw}": id and src must both be non-empty (after service prefix).`
        );
      }
      const absSrcPS = isAbsolute(src) ? src : resolvePath(process.cwd(), src);
      getPerSvc(prefix.svc).buildSecrets.set(id, absSrcPS);
      continue;
    }
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
    // Resolve `src` against `process.cwd()` (not the build context
    // dir = Dockerfile parent, which is where `docker build`
    // resolves a relative `--secret src=...` against). Users type
    // these from the repo root (e.g. `--image-build-secret
    // npmrc=./.npmrc`), expecting the path to mean what every other
    // CLI flag means — relative to where they ran the command.
    // Mirrors the absolute-resolution behavior of
    // `--image-override <path>` in {@link makeEntryFromPath}.
    const absSrc = isAbsolute(src) ? src : resolvePath(process.cwd(), src);
    buildSecrets.set(id, absSrc);
  }

  const globals: ImageOverrideGlobals = { buildArgs, buildSecrets };
  // `--image-target` accepts either a single scalar (legacy / global)
  // or an array (per-service variants + an optional global). Coerce
  // to an array up-front so the loop body handles both shapes.
  const imageTargetList: string[] =
    input.imageTarget === undefined
      ? []
      : Array.isArray(input.imageTarget)
        ? input.imageTarget
        : [input.imageTarget];
  for (const raw of imageTargetList) {
    if (raw === undefined || raw === null) continue;
    if (!raw) {
      throw new ImageOverrideError('Invalid --image-target value: empty string.');
    }
    const eq = raw.indexOf('=');
    if (eq < 0) {
      // Global form: a bare stage name. Last write wins when the user
      // repeated the flag with multiple bare values (parser is liberal
      // so an accidental `--image-target a --image-target b` doesn't
      // hard-error; the latter overrides).
      globals.targetStage = raw;
      continue;
    }
    // Per-service form: `<svc>=<stage>`. Both halves must be non-empty.
    const svc = raw.slice(0, eq).trim();
    const stage = raw.slice(eq + 1).trim();
    if (!svc) {
      throw new ImageOverrideError(
        `Invalid --image-target value "${raw}": left side (service target) is empty.`
      );
    }
    if (!stage) {
      throw new ImageOverrideError(
        `Invalid --image-target value "${raw}": right side (stage) is empty.`
      );
    }
    getPerSvc(svc).targetStage = stage;
  }

  return { explicit, pickerPaths, globals, perService };
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
    out.set(svc, makeEntryFromPath(dockerfileRaw, svc, rawFlags, cwd));
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
        // Picker form may bind one Dockerfile to MULTIPLE targets. Each
        // target merges its own per-service overlay (no cross-talk),
        // so the entries differ per target whenever a per-service flag
        // touches one of the picked services.
        for (const t of chosen) out.set(t, makeEntryFromPath(dockerfileRaw, t, rawFlags, cwd));
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
        '. Override with a local build? [path / N]:';
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
      // Accept any case variant of `n` / `no` as a skip sentinel
      // (matches the `[path / N]` hint shown to the user). Empty
      // input also skips.
      if (!value) continue;
      const lower = value.toLowerCase();
      if (lower === 'n' || lower === 'no') continue;
      out.set(target, makeEntryFromPath(value, target, rawFlags, cwd));
    }
  }

  return out;
}

/**
 * Issue #240 — produce the EFFECTIVE per-target build inputs by layering
 * a per-service overlay on top of the global baseline. Per-service
 * entries override the global per-key (and per-service `targetStage`
 * overrides the global `targetStage`).
 *
 * The returned Maps are fresh copies — the caller may mutate the
 * resulting {@link ImageOverrideEntry}'s Maps without bleeding back
 * into the shared global Maps inside {@link RawImageOverrideFlags}.
 * Per-service entries are merged AFTER globals so a key shared between
 * the two ends up with the per-service value (Map's `set` overwrites
 * on duplicate key).
 */
export function mergeForService(
  serviceTarget: string,
  globals: ImageOverrideGlobals,
  perService: ReadonlyMap<string, PerServiceBuildInputs>
): { buildArgs: Map<string, string>; buildSecrets: Map<string, string>; targetStage?: string } {
  const buildArgs = new Map<string, string>(globals.buildArgs);
  const buildSecrets = new Map<string, string>(globals.buildSecrets);
  let targetStage = globals.targetStage;
  const overlay = perService.get(serviceTarget);
  if (overlay) {
    for (const [k, v] of overlay.buildArgs.entries()) buildArgs.set(k, v);
    for (const [k, v] of overlay.buildSecrets.entries()) buildSecrets.set(k, v);
    if (overlay.targetStage !== undefined) targetStage = overlay.targetStage;
  }
  return {
    buildArgs,
    buildSecrets,
    ...(targetStage !== undefined && { targetStage }),
  };
}

/**
 * Promote a per-target Dockerfile path + raw flags into a full
 * {@link ImageOverrideEntry}. Resolves the path against `cwd`, asserts
 * the Dockerfile exists and is a regular file (so the user sees
 * "file not found" up-front rather than mid-`docker build`), and
 * derives the build context as the Dockerfile's parent directory
 * (the v1 simplification — custom contexts are tracked separately).
 *
 * Issue #240 — `serviceTarget` is now part of the entry-construction
 * input so the global + per-service merge runs per target.
 */
function makeEntryFromPath(
  raw: string,
  serviceTarget: string,
  rawFlags: RawImageOverrideFlags,
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
  const merged = mergeForService(serviceTarget, rawFlags.globals, rawFlags.perService);
  return {
    dockerfile: abs,
    contextDir: dirname(abs),
    buildArgs: merged.buildArgs,
    buildSecrets: merged.buildSecrets,
    ...(merged.targetStage !== undefined && { targetStage: merged.targetStage }),
  };
}

/**
 * Deterministic local-only image tag for one override entry. Fingerprints
 * the Dockerfile path + its CONTENTS (sha256 of the bytes) + service
 * target + build args / secrets / stage. Including the Dockerfile bytes
 * means an edit to the Dockerfile flips the tag — the rebuild rolling
 * primitive then boots a new container under the bumped tag instead of
 * reusing the old build's cached layers under a stale tag. Two
 * back-to-back runs against an unchanged Dockerfile + flags still hit
 * the same tag so docker's layer cache works.
 *
 * Tag shape: `<resourceNamePrefix>-override-<svcSlug>-<hash>:local`.
 * `:local` is intentionally NOT `:latest` so a `docker pull` on it fails
 * fast (these images are local-build-only by design).
 *
 * Throws on a missing Dockerfile — the caller has already asserted
 * existence in {@link makeEntryFromPath}, so a throw here is a
 * programming error (or the Dockerfile vanished between resolve and
 * build, which is a race the user wants to know about).
 */
export function buildImageOverrideTag(serviceTarget: string, entry: ImageOverrideEntry): string {
  const hash = createHash('sha256');
  hash.update('dockerfile=');
  hash.update(entry.dockerfile);
  hash.update('\0dockerfile-bytes-sha256=');
  // Hash the Dockerfile contents so an edit to the file flips the tag.
  // sha256 the file (small text, sync read is fine) and feed the digest
  // into the outer hash. existsSync was already asserted up-front by
  // `makeEntryFromPath`; a vanished-since-resolve race surfaces here
  // as an exception with a clear path in the message.
  const dockerfileBytesDigest = createHash('sha256')
    .update(readFileSync(entry.dockerfile))
    .digest('hex');
  hash.update(dockerfileBytesDigest);
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
 *
 * Partial-failure rollback (issue #242 / N3): when build N (1-indexed)
 * fails, the 1..(N-1) successfully built local-only tags from THIS run
 * are best-effort `docker image rm`'d before re-throwing. Not a leak
 * (the tags are deterministic per
 * {@link buildImageOverrideTag} so a re-run collides safely with any
 * leftover), but the cleanup keeps the local Docker daemon tidy after
 * a failed boot — disk-pressure scenarios that occasionally surface
 * on dev laptops never accumulate orphan override images across a
 * day of iterations. Cleanup failures are logged at `debug` (another
 * container could be using the image, the image could already have
 * been removed by a parallel `docker system prune`, etc.) and the
 * loop continues so one un-removable tag doesn't shadow the others.
 * The originating {@link ImageOverrideError} is always the thrown
 * value — a cleanup-step error never replaces it.
 */
export async function runImageOverrideBuilds(
  overrides: ImageOverrideMap
): Promise<Map<string, string>> {
  const logger = getLogger();
  const out = new Map<string, string>();
  // Track every successfully built tag from THIS invocation so a
  // mid-run failure can `docker image rm` them (N3). Distinct from
  // `out` for clarity — `out` is the success-path return value;
  // `builtTags` is the rollback bookkeeping.
  const builtTags: string[] = [];
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
      const wrapped = new ImageOverrideError(
        `docker build failed for --image-override '${target}' (Dockerfile=${entry.dockerfile}): ` +
          (e.stderr?.trim() || e.message || String(err))
      );
      // Best-effort rollback: remove every tag built earlier in this
      // run. Per-tag failures are logged at debug + swallowed so the
      // originating build error stays the surfaced one.
      for (const priorTag of builtTags) {
        try {
          await runDockerStreaming(['image', 'rm', priorTag], {});
        } catch (rmErr) {
          logger.debug(
            `Image-override rollback: \`docker image rm ${priorTag}\` failed: ` +
              `${rmErr instanceof Error ? rmErr.message : String(rmErr)}.`
          );
        }
      }
      throw wrapped;
    }
    out.set(target, tag);
    builtTags.push(tag);
  }
  return out;
}

/**
 * Issue #240 — orphan validation. A per-service build-input flag
 * (`--image-build-arg <svc>:KEY=VAL`, `--image-build-secret
 * <svc>:id=src`, or `--image-target <svc>=stage`) names a service that
 * MUST appear in the resolved override map — otherwise the per-service
 * value silently gets discarded because no `docker build` runs for
 * that service.
 *
 * Called AFTER {@link resolveImageOverrides} (Stage 3 boot prompt
 * complete) so a service the user added via the prompt counts as
 * covered. A still-orphan per-service flag at this point means the
 * user typo'd the service name OR forgot a corresponding
 * `--image-override <svc>=<dockerfile>` mapping (and either chose `N`
 * in the boot prompt or ran with `--no-interactive-overrides`).
 *
 * Throws {@link LocalStartServiceError} naming every offending
 * `<flag>` + `<service>` pair so the user can fix all in one go
 * (matches the `enforceStrictOverrides` pattern). Mutates nothing.
 *
 * Host-side use case: cdkd and other shim hosts that wrap the engine
 * re-export this via `cdk-local/internal` and call it right after
 * their own `resolveImageOverrides` invocation to inherit the same
 * orphan-detection semantics.
 *
 * @param rawFlags Output of {@link parseImageOverrideFlags}.
 * @param resolvedOverrides Output of {@link resolveImageOverrides}
 *   (after the boot prompt has run).
 */
export function enforceImageOverrideOrphans(
  rawFlags: RawImageOverrideFlags,
  resolvedOverrides: ImageOverrideMap
): void {
  if (rawFlags.perService.size === 0) return;
  const offenders: string[] = [];
  for (const [svc, overlay] of rawFlags.perService.entries()) {
    if (resolvedOverrides.has(svc)) continue;
    // Surface one line per offending FLAG kind so the user sees every
    // piece they need to fix, not just the first.
    if (overlay.buildArgs.size > 0) {
      const keys = Array.from(overlay.buildArgs.keys()).join(', ');
      offenders.push(
        `--image-build-arg ${svc}:${keys} references a service with no --image-override mapping.`
      );
    }
    if (overlay.buildSecrets.size > 0) {
      const ids = Array.from(overlay.buildSecrets.keys()).join(', ');
      offenders.push(
        `--image-build-secret ${svc}:${ids} references a service with no --image-override mapping.`
      );
    }
    if (overlay.targetStage !== undefined) {
      offenders.push(
        `--image-target ${svc}=${overlay.targetStage} references a service with no --image-override mapping.`
      );
    }
  }
  if (offenders.length === 0) return;
  throw new LocalStartServiceError(
    `Per-service image-override flag(s) target a service with no --image-override ` +
      `coverage. Add the matching --image-override <service>=<dockerfile>, drop the ` +
      `per-service flag, or fix the service name:\n  ${offenders.join('\n  ')}`
  );
}
