import path from 'node:path';

/**
 * Phase 4 of issue #214 — bind-mount source fast path for ECS service
 * `--watch` hot reload. This module classifies each watcher firing as
 * either {@link ReloadVerdict.kind} `'rebuild'` (the Phase 1-3 path —
 * `docker build` + shadow boot + atomic Cloud Map / front-door pool
 * swap) or `'soft-reload'` (`docker cp` the new source into the
 * existing replica's WORKDIR + `docker restart` it; no `docker build`,
 * no shadow boot, no registry swap because the container's docker
 * network IP and host port are unchanged across the restart).
 *
 * Verdict policy:
 *   - DEFAULT to `'rebuild'` whenever classification is ambiguous. A
 *     slow-but-correct reload is strictly better than a fast-but-stale
 *     one — a missed Dockerfile / dependency-manifest change would
 *     leave the running container on the previous image while the
 *     source files said otherwise.
 *   - Return `'soft-reload'` ONLY when EVERY changed path is a plain
 *     source-tree edit that the running container will pick up by
 *     restarting against its already-built filesystem layer + the
 *     freshly-copied source.
 *
 * Out-of-scope (always `'rebuild'`):
 *   - Compiled-language source files (`.go` / `.rs` / `.java` / etc.).
 *     A copy of `main.go` without a recompile step leaves the running
 *     binary unchanged. The user's intent is a rebuild.
 *   - Dependency manifests (`package.json` / `pnpm-lock.yaml` /
 *     `requirements.txt` / `go.mod` / `Cargo.toml` / etc.). The
 *     running container's `node_modules/` / `site-packages/` /
 *     vendored deps were laid down during `docker build`; soft-reload
 *     would not pick up a new dependency.
 *   - The Dockerfile itself, or any Dockerfile.* sibling.
 *   - Non-CDK-asset images (ECR / public registry pins) — there is no
 *     local source to copy.
 *
 * The classifier is intentionally PURE and synchronous so the
 * emulator's reload pathway can call it in a tight loop (one verdict
 * per target per watcher firing) without any docker / fs hop.
 */

/**
 * Per-target context passed alongside chokidar's changed-paths set. The
 * emulator builds this once per reload from the post-synth asset
 * manifest of the new stacks; `undefined` when the target's image is
 * not a CDK docker-image asset (ECR / public registry pin) — those
 * fall through to `'rebuild'` because soft-reload has no local source
 * tree to copy.
 */
export interface ReloadAssetContext {
  /**
   * Asset hash of the OLD (pre-reload) image — the one currently
   * running inside the live replicas. Load-bearing: when this is
   * missing OR equals {@link newAssetHash}, the classifier forces
   * `'rebuild'` so a CDK construct edit (`lib/stack.ts` etc.) that
   * left the asset content untouched but flipped the task spec still
   * gets picked up by the rolling primitive's fresh `docker create`.
   */
  oldAssetHash?: string;
  /**
   * Asset hash of the NEW (post-synth) image. Same load-bearing role
   * as {@link oldAssetHash} — the classifier compares the two and
   * forces `'rebuild'` when they match.
   */
  newAssetHash: string;
  /**
   * Absolute path to the NEW synthesized asset source directory
   * (`<cdkout>/asset.<newAssetHash>/`). The soft-reload primitive
   * `docker cp <newAssetSourceDir>/. <container>:<workdir>/` to land
   * the fresh source inside the running container. The classifier
   * does not read this directory itself; it surfaces it as part of
   * the verdict so the runner does not have to re-derive it.
   */
  newAssetSourceDir: string;
  /**
   * Dockerfile basename inside {@link newAssetSourceDir}. Defaults
   * to `Dockerfile` when the asset manifest's `source.dockerFile` is
   * absent. Used by the classifier to flag a Dockerfile edit as a
   * rebuild trigger; chokidar reports paths relative to the watch
   * root (the cdk.json directory), not the cdk.out-staged asset
   * tree, so the classifier matches by basename rather than absolute
   * path identity.
   */
  dockerFile: string;
}

export type ReloadVerdict =
  | {
      kind: 'rebuild';
      /** Short reason string surfaced in the emulator's reload-banner log. */
      reason: string;
    }
  | {
      kind: 'soft-reload';
      /** Short reason string surfaced in the emulator's reload-banner log. */
      reason: string;
      /** Mirror of {@link ReloadAssetContext.newAssetSourceDir} for the runner's `docker cp`. */
      newAssetSourceDir: string;
    };

/**
 * Dependency-manifest basenames recognized by the classifier. A change
 * to any of these forces a rebuild because the running container's
 * pre-built dependency layer is no longer in sync with the source.
 *
 * Coverage: the package managers commonly used inside a Lambda /
 * container image — Node (pnpm / npm / yarn), Python (pip / poetry /
 * pipenv), Ruby (bundler), Go (modules), Rust (cargo), Java / Kotlin
 * (Maven, Gradle). Adding a new ecosystem? Append its lockfile +
 * manifest here and add a classifier test row.
 */
const REBUILD_TRIGGER_BASENAMES: ReadonlySet<string> = new Set([
  // Node
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  // Python
  'requirements.txt',
  'requirements-dev.txt',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile',
  'Pipfile.lock',
  'uv.lock',
  // Ruby
  'Gemfile',
  'Gemfile.lock',
  // Go
  'go.mod',
  'go.sum',
  // Rust
  'Cargo.toml',
  'Cargo.lock',
  // Java / Kotlin
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  // Native / system
  'Makefile',
  'CMakeLists.txt',
]);

/**
 * Compiled-language source extensions that require a build step
 * inside `docker build` (typically a `RUN go build` / `cargo build` /
 * `mvn package` etc.). A copy of the source alone would leave the
 * running binary stale, so the user's intent must be a rebuild.
 *
 * TypeScript source (`.ts` / `.tsx` / `.mts` / `.cts`) is treated as
 * compiled because the dominant production-container pattern is to
 * pre-compile the source via a Dockerfile `RUN tsc` / `RUN yarn build`
 * step, with the runtime executing the emitted `dist/*.js`. Soft-reload
 * would `docker cp` the new `.ts` into the container's WORKDIR while
 * the running process keeps reading the OLD `dist/` — a silent
 * stale-code failure that violates the file's "slow-but-correct beats
 * fast-but-stale" default policy (lines 14-22). Setups that transpile
 * at runtime lose the soft-reload fast path under this default; an
 * opt-in flag to restore it is a possible follow-up but is not in
 * scope here.
 *
 * Interpreted-language runtimes (Node — `.js` / `.mjs` / `.cjs`,
 * Python — `.py`, Ruby — `.rb`, shell — `.sh`) read source at process
 * start, so a `docker cp` + `docker restart` cycle picks them up.
 * Those extensions are NOT in this set.
 */
const COMPILED_LANGUAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.cs',
  '.swift',
  '.fs',
  '.fsx',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
  '.zig',
  '.ml',
  '.mli',
  '.elm',
  '.hs',
  '.dart',
  // TypeScript — pre-compiled to `dist/*.js` inside `docker build`
  // by the dominant production pattern; see the JSDoc above.
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);

/**
 * Classify a single watcher firing into rebuild vs soft-reload. Pure
 * + synchronous. The caller (emulator's reload pathway) invokes this
 * once per target per firing AFTER `cdk synth` has run and the new
 * asset manifest is on disk.
 *
 * Branching:
 *   1. No asset context (image isn't a CDK asset, or asset lookup
 *      failed) → `rebuild`.
 *   2. The asset hash didn't change between old and new synths
 *      (`oldAssetHash === newAssetHash`, or `oldAssetHash` missing)
 *      → `rebuild`. Load-bearing guard for "user edited a CDK
 *      construct file (e.g. `lib/stack.ts`) that flipped the task
 *      spec but didn't touch the asset content". Soft-reload would
 *      `docker cp` identical files and `docker restart` the
 *      container with the OLD task spec (env / memory / mounts /
 *      added sidecars are set at `docker create` time, not on
 *      restart) — the user's intent would silently NOT apply.
 *      Forcing rebuild keeps Phase 1-3 semantics exactly for this
 *      case: the rolling primitive boots a shadow with the new task
 *      spec, the user sees their construct edit take effect.
 *   3. No changed paths (the watcher fired on a debounce flush with
 *      an empty pending set — shouldn't happen in practice, but
 *      defensive) → `rebuild`.
 *   4. Any changed path's basename matches the Dockerfile or a
 *      dependency manifest → `rebuild`.
 *   5. Any changed path's extension is a compiled-language source →
 *      `rebuild`.
 *   6. Else → `soft-reload`.
 */
export function classifySourceChange(
  changedPaths: readonly string[],
  ctx: ReloadAssetContext | undefined
): ReloadVerdict {
  if (!ctx) {
    return { kind: 'rebuild', reason: 'target image is not a CDK docker-image asset' };
  }
  if (!ctx.oldAssetHash || ctx.oldAssetHash === ctx.newAssetHash) {
    return {
      kind: 'rebuild',
      reason:
        'asset hash unchanged across the synth (CDK construct edit or unrelated file) — ' +
        'task-spec changes need a fresh `docker create`, which only the rebuild path runs',
    };
  }
  if (changedPaths.length === 0) {
    return { kind: 'rebuild', reason: 'no changed paths reported (defensive default)' };
  }
  for (const p of changedPaths) {
    const basename = path.basename(p);
    if (basename === ctx.dockerFile) {
      return { kind: 'rebuild', reason: `Dockerfile edit (${basename})` };
    }
    if (basename.startsWith('Dockerfile.')) {
      return { kind: 'rebuild', reason: `Dockerfile.* edit (${basename})` };
    }
    if (REBUILD_TRIGGER_BASENAMES.has(basename)) {
      return { kind: 'rebuild', reason: `dependency manifest edit (${basename})` };
    }
    const ext = path.extname(p).toLowerCase();
    if (COMPILED_LANGUAGE_EXTENSIONS.has(ext)) {
      return {
        kind: 'rebuild',
        reason: `compiled-language source edit (${basename}) — soft-reload would leave the built binary stale`,
      };
    }
  }
  return {
    kind: 'soft-reload',
    reason: `${changedPaths.length} source-only path(s) — skipping rebuild`,
    newAssetSourceDir: ctx.newAssetSourceDir,
  };
}
