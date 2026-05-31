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

  it('boot-time WARN fires `isLocalCdkAssetImage` AND `describePinnedImageUri` inside the `--watch` gate', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The boot-time WARN block is bracketed by the `--watch` gate
    // (`options.watch === true && strategy.supportsWatch === true`)
    // and BOTH helpers MUST appear before the `Phase 1 + Phase 2 +
    // Phase 3` watcher-wiring comment. A refactor that drops either
    // call would silently ship the no-op-disguised-as-success bug
    // back into the boot stream.
    const bootWarnRegion = source.match(
      /options\.watch === true && strategy\.supportsWatch === true\)\s*\{[\s\S]*?Phase 1 \+ Phase 2 \+ Phase 3/
    );
    expect(bootWarnRegion, 'boot-time WARN region missing').toBeTruthy();
    expect(bootWarnRegion![0]).toMatch(/isLocalCdkAssetImage\s*\(/);
    expect(bootWarnRegion![0]).toMatch(/describePinnedImageUri\s*\(/);
    expect(bootWarnRegion![0]).toMatch(/logger\.warn\(/);
  });

  it('reload-time skip guard checks `verdict.reason` BEFORE the `rollOneTarget` call site', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The skip guard MUST live between the classifier's verdict assignment
    // and the `await rollOneTarget(...)` call in `reloadAllServices`.
    // The "Reload skipped" log line is the user-facing surface; the
    // `continue` keyword is the load-bearing semantic.
    const reloadRegion = source.match(
      /async function reloadAllServices\(args:[\s\S]*?logger\.info\('Reload complete\.'\);/
    );
    expect(reloadRegion, 'reloadAllServices body missing').toBeTruthy();
    const body = reloadRegion![0];
    expect(body).toMatch(/target image is not a CDK docker-image asset/);
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
