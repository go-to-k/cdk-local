import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMULATOR_SOURCE = path.join(
  __dirname,
  '../../../src/cli/commands/ecs-service-emulator.ts'
);

/**
 * Issue #234 site-level binding test (per
 * `feedback_site_level_binding_test.md`).
 *
 * `isLocalCdkAssetImage` / `describePinnedImageUri` (in
 * `src/local/image-pin-detector.ts`) are consumed at TWO sites inside
 * `ecs-service-emulator.ts`:
 *
 *   1. The boot-time `--watch` warn loop (runs once after every target
 *      has booted, before the file watcher is wired) — surfaces a per-
 *      target WARN naming the deployed-registry URI when the image is
 *      pinned.
 *   2. The reload-time skip guard inside `reloadAllServices` — emits
 *      `Reload skipped for '<target>' (no-op)...` and `continue`s past
 *      `rollOneTarget` when the classifier verdict says
 *      `'target image is not a CDK docker-image asset'`.
 *
 * The helper has its own unit coverage in
 * `tests/unit/local/image-pin-detector.test.ts`, but neither caller is
 * exercised by an emulator-level vitest (booting `runEcsServiceEmulator`
 * end-to-end would require docker + a real ECS template). This source-
 * grep test pins the bindings so a refactor that silently re-inlines
 * the image-kind check on one side (or drops one) surfaces here instead
 * of shipping a regressed `--watch` no-op symptom that issue #234
 * documented.
 */
describe('ecs-service-emulator image-pin detector binding (issue #234)', () => {
  it('imports `isLocalCdkAssetImage` + `listPinnedTargets` from the local helper module', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    expect(source).toMatch(
      /from\s+['"]\.\.\/\.\.\/local\/image-pin-detector\.js['"]/
    );
    // `isLocalCdkAssetImage` is still consumed by the reload-time skip
    // guard in `reloadAllServices` (issue #234), and `listPinnedTargets`
    // is the issue #242 / N1 dedupe consumed by both the override
    // engine's pre-boot peek + the post-boot WARN loop. The detector
    // module also exports `describePinnedImageUri`, but the emulator no
    // longer imports it directly — every call site now flows through
    // `listPinnedTargets`.
    expect(source).toMatch(/isLocalCdkAssetImage/);
    expect(source).toMatch(/listPinnedTargets/);
  });

  it('boot-time WARN loop derives the pinned set via `listPinnedTargets` and surfaces it through `logger.warn`', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // Anchor on the unique boot-WARN rationale comment ("Warn UP-FRONT")
    // and verify the per-target block downstream of it derives the
    // pinned set through the `listPinnedTargets` helper (issue #242 N1
    // dedupe) AND surfaces the warning via `logger.warn`. The outer
    // gate (a hoisted `watchActive` const today; could be inlined back
    // or renamed by a future refactor) intentionally isn't pinned here
    // — what matters for issue #234 is that the loop body has the
    // right shape. A refactor that drops the helper call would silently
    // ship the no-op-disguised-as-success bug back into the boot stream.
    const bootWarnLoop = source.match(
      /Warn UP-FRONT[\s\S]*?listPinnedTargets\([\s\S]*?logger\.warn\(/
    );
    expect(bootWarnLoop, 'boot-time WARN loop missing').toBeTruthy();
  });

  it('boot-time WARN is NOT gated on --watch (broadened by issue #238)', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // After #238, the boot WARN fires on any cold start (not just under
    // `--watch`). Specifically, the WARN loop must NOT be wrapped inside
    // an `if (watchActive)` block. A regression that re-introduces such
    // a gate would silently swallow the WARN for non-watch runs, which
    // is precisely what #238 explicitly broadens.
    //
    // Anchor on the intrinsic "Warn UP-FRONT" rationale comment + the
    // helper call site (`listPinnedTargets` / `logger.warn`) that the
    // WARN block uniquely uses. Avoid keying on incidental landmarks
    // like `Phase 1 + Phase 2` (which a future section-comment rewrite
    // would silently invalidate). Take the 4-KiB window starting at
    // "Warn UP-FRONT" — large enough to contain the entire loop, small
    // enough that an unrelated future copy of the helpers downstream
    // won't accidentally bleed in.
    //
    // Issue #242 anti-pattern follow-up: drop the previous
    // `.split('for (const pt of perTarget)')` landmark — a rename of
    // `perTarget` would silently widen a split-based assertion to
    // cover the whole region, shadowing a regression. Instead bound
    // the WARN region with two semantic anchors:
    //
    //   - START: the intrinsic `Warn UP-FRONT` rationale comment
    //     (unique to the WARN block).
    //   - END: the `enforceStrictOverrides(` call site that
    //     immediately follows the WARN loop. Cutting at that call
    //     keeps the unrelated `--watch` watcher block (which legitly
    //     opens an `if (watchActive)` gate later) out of the region,
    //     so a `not.toMatch(/if \(watchActive\)/)` assertion stays
    //     scoped to the WARN gate question.
    //
    // A regression that re-hoists `if (watchActive)` over the boot
    // WARN must land BEFORE `enforceStrictOverrides(...)` runs (the
    // WARN populates the `uncoveredPinnedTargets` array that
    // `enforceStrictOverrides` consumes), so the boundary's
    // safe.
    const warnUpFrontIdx = source.indexOf('Warn UP-FRONT');
    expect(warnUpFrontIdx).toBeGreaterThan(-1);
    const strictIdx = source.indexOf('enforceStrictOverrides(', warnUpFrontIdx);
    expect(strictIdx).toBeGreaterThan(warnUpFrontIdx);
    const bootWarnRegion = source.slice(warnUpFrontIdx, strictIdx);
    expect(bootWarnRegion).toMatch(/listPinnedTargets/);
    expect(bootWarnRegion).toMatch(/logger\.warn\(/);
    expect(bootWarnRegion).not.toMatch(/if \(watchActive\)/);
  });

  it('both pinned-detection call sites consume the SAME `listPinnedTargets` helper (issue #242 / N1 dedupe)', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The N1 dedupe lifts the two independent walks (engine pre-boot
    // resolution + post-boot WARN loop) onto a single `listPinnedTargets`
    // helper. Site-level binding: both regions must call it. A future
    // refactor that re-inlines one side would surface a regression here
    // (and silently drift the two pinned-set verdicts apart).
    //
    // Engine pre-boot site: anchored on the comment that names the
    // dedupe rationale (the "Issue #242 / N1" tag inside
    // `resolveAndBuildImageOverrides`).
    const engineRegion = source.match(
      /Issue #242 \/ N1 — collect every target's resolved service[\s\S]{0,3072}listPinnedTargets\(/
    );
    expect(engineRegion, 'engine pre-boot listPinnedTargets call missing').toBeTruthy();
    // Post-boot WARN site: same helper, separately anchored on the
    // Warn UP-FRONT rationale comment so the two call-site checks
    // can't accidentally overlap into one region.
    const warnUpFrontIdx = source.indexOf('Warn UP-FRONT');
    const warnRegion = source.slice(warnUpFrontIdx, warnUpFrontIdx + 4096);
    expect(warnRegion).toMatch(/listPinnedTargets\(/);
    // Sanity: the engine pre-boot region anchor and the WARN region
    // anchor are distinct (the helper call appears in both).
    const engineIdx = source.indexOf("Issue #242 / N1 — collect every target's resolved service");
    expect(engineIdx).toBeGreaterThan(-1);
    expect(warnUpFrontIdx).toBeGreaterThan(-1);
    expect(engineIdx).not.toBe(warnUpFrontIdx);
  });

  it('reload-time skip guard AND-s `verdict.reason` with `isLocalCdkAssetImage(controller.service)` BEFORE `rollOneTarget`', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The skip guard MUST live between the classifier's verdict assignment
    // and the `await rollOneTarget(...)` call in `reloadAllServices`. As
    // refined by the #237 review (PR feedback), the guard ANDs the
    // verdict reason with `!isLocalCdkAssetImage(controller.service)` so
    // degradation / race cases where the classifier defaults to
    // `rebuild` but the booted controller's image IS a CDK asset
    // (manifest race, missing asset hash, executable-mode asset, etc.)
    // do NOT trip a misleading "image pinned to deployed registry" skip.
    const reloadRegion = source.match(
      /async function reloadAllServices\(args:[\s\S]*?logger\.info\('Reload complete\.'\);/
    );
    expect(reloadRegion, 'reloadAllServices body missing').toBeTruthy();
    const body = reloadRegion![0];
    expect(body).toMatch(/target image is not a CDK docker-image asset/);
    expect(body).toMatch(/!isLocalCdkAssetImage\(controller\.service\)/);
    expect(body).toMatch(/Reload skipped for '\$\{newBoot\.target\}'/);
    // Ordering: the skip log + `continue` MUST appear before the
    // `rollOneTarget` call so the no-op pre-empts the rolling primitive.
    const skipIdx = body.indexOf('Reload skipped for ');
    const rollIdx = body.indexOf('rollOneTarget({');
    expect(skipIdx).toBeGreaterThan(-1);
    expect(rollIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeLessThan(rollIdx);
  });
});
