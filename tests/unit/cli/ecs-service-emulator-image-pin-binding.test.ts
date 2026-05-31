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
  it('imports `isLocalCdkAssetImage` + `describePinnedImageUri` from the local helper module', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    expect(source).toMatch(
      /from\s+['"]\.\.\/\.\.\/local\/image-pin-detector\.js['"]/
    );
    expect(source).toMatch(/isLocalCdkAssetImage/);
    expect(source).toMatch(/describePinnedImageUri/);
  });

  it('boot-time WARN loop calls `isLocalCdkAssetImage` + `describePinnedImageUri` + `logger.warn` together', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // Anchor on the unique boot-WARN rationale comment ("Warn UP-FRONT")
    // and verify the per-target loop downstream of it calls both
    // helpers AND surfaces the warning via `logger.warn`. The outer
    // gate (a hoisted `watchActive` const today; could be inlined back
    // or renamed by a future refactor) intentionally isn't pinned here
    // — what matters for issue #234 is that the loop body has the
    // right shape. A refactor that drops either call would silently
    // ship the no-op-disguised-as-success bug back into the boot stream.
    const bootWarnLoop = source.match(
      /Warn UP-FRONT[\s\S]*?for \(const pt of perTarget\) \{[\s\S]*?isLocalCdkAssetImage[\s\S]*?describePinnedImageUri[\s\S]*?logger\.warn\(/
    );
    expect(bootWarnLoop, 'boot-time WARN loop missing').toBeTruthy();
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
