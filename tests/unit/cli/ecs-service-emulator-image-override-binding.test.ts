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
 * Issue #238 site-level binding test (mirrors the
 * `feedback_site_level_binding_test.md` pattern used by
 * `ecs-service-emulator-image-pin-binding.test.ts`).
 *
 * `parseImageOverrideFlags` / `resolveImageOverrides` /
 * `runImageOverrideBuilds` (in `src/local/image-override-engine.ts`)
 * are consumed at TWO sites inside `ecs-service-emulator.ts`:
 *
 *   1. The boot-time `resolveAndBuildImageOverrides` helper — runs
 *      after `boots` is resolved but BEFORE `bootOneTarget` is called,
 *      and produces a `serviceTarget -> localTag` map the boot loop
 *      threads into each runner.
 *   2. The reload-time `rollOneTarget` call — passes the same map
 *      through to the rolling primitive so a `--watch` rebuild on an
 *      overridden target rolls against the new local Dockerfile build
 *      instead of the deployed pin (and so the #234 reload-skip guard
 *      doesn't fire for overridden targets, which now ARE locally
 *      rebuildable).
 *
 * The engine has its own unit coverage in
 * `tests/unit/local/image-override-engine.test.ts`, but the wiring is
 * load-bearing and can't be exercised end-to-end without docker + a
 * real ECS template. This source-grep test pins the bindings so a
 * refactor that silently re-inlines the engine on one side (or drops
 * the reload-side threading) surfaces here instead of shipping a
 * regressed `--watch` no-op for overridden targets.
 */
describe('ecs-service-emulator image-override engine binding (issue #238)', () => {
  it('imports `parseImageOverrideFlags` + `resolveImageOverrides` + `runImageOverrideBuilds` from the engine module', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    expect(source).toMatch(
      /from\s+['"]\.\.\/\.\.\/local\/image-override-engine\.js['"]/
    );
    expect(source).toMatch(/parseImageOverrideFlags/);
    expect(source).toMatch(/resolveImageOverrides/);
    expect(source).toMatch(/runImageOverrideBuilds/);
  });

  it('boot path calls `resolveAndBuildImageOverrides` BEFORE the bootOneTarget loop', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // Anchor on the boot-time block's rationale comment + the resolver
    // helper call + the boot loop downstream of it.
    const bootRegion = source.match(
      /resolveAndBuildImageOverrides\([\s\S]*?for \(const pt of perTarget\) \{[\s\S]*?await bootOneTarget\(/
    );
    expect(bootRegion, 'boot path missing the engine call').toBeTruthy();
  });

  it('bootOneTarget receives the per-target override tag', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    const bootCall = source.match(
      /await bootOneTarget\([\s\S]*?imageOverrideTags\.get\(pt\.boot\.target\)[\s\S]*?\);/
    );
    expect(bootCall, 'bootOneTarget call missing the imageOverrideTags.get(...) thread').toBeTruthy();
  });

  it('reloadAllServices accepts and threads `imageOverrideTags` into rollOneTarget', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The reload function must declare the `imageOverrideTags` param
    // (so the watcher's `onChange` passes it through) AND consult it
    // inside the per-target rollOneTarget call.
    const reloadFnRegion = source.match(
      /async function reloadAllServices\(args:[\s\S]*?logger\.info\('Reload complete\.'\);/
    );
    expect(reloadFnRegion, 'reloadAllServices body missing').toBeTruthy();
    const body = reloadFnRegion![0];
    expect(body).toMatch(/imageOverrideTags:\s*ReadonlyMap<string,\s*string>/);
    expect(body).toMatch(/imageOverrideTags\.get\(newBoot\.target\)/);
  });

  it('watcher onChange forwards `imageOverrideTags` to reloadAllServices', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The watcher block lives downstream of the boot WARN loop; it
    // composes the `reloadAllServices` arg object. `imageOverrideTags`
    // must be in that arg list verbatim, otherwise the reload-side
    // wouldn't have an override map to consult.
    const watcherCall = source.match(
      /onChange:\s*\(changedPaths\)\s*=>\s*\{[\s\S]*?reloadAllServices\(\{[\s\S]*?imageOverrideTags[\s\S]*?\}\)/
    );
    expect(watcherCall, 'watcher onChange missing the imageOverrideTags thread').toBeTruthy();
  });

  it('strict-overrides guard fails fast when uncovered pinned targets remain', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The guard sits in the boot path after the per-target WARN loop;
    // it MUST consult `options.strictOverrides` + `uncoveredPinnedTargets`
    // and throw `LocalStartServiceError` so the user sees a clear exit
    // code rather than a half-booted emulator.
    expect(source).toMatch(/options\.strictOverrides === true/);
    expect(source).toMatch(/uncoveredPinnedTargets/);
  });
});

describe('addImageOverrideOptions wiring (issue #238)', () => {
  const SERVICE_SOURCE = path.join(
    __dirname,
    '../../../src/cli/commands/local-start-service.ts'
  );
  const ALB_SOURCE = path.join(__dirname, '../../../src/cli/commands/local-start-alb.ts');

  it('start-service composes addImageOverrideOptions inside its specific-options helper', () => {
    const source = readFileSync(SERVICE_SOURCE, 'utf-8');
    expect(source).toMatch(/addImageOverrideOptions/);
    // The helper is called from inside addStartServiceSpecificOptions —
    // a refactor that moves it to the factory body (bypassing the
    // shared helper) would break host-CLI parity per the cdkd-parity
    // convention. Pin the binding site.
    const block = source.match(
      /export function addStartServiceSpecificOptions\(cmd: Command\): Command \{[\s\S]*?\}/
    );
    expect(block, 'addStartServiceSpecificOptions block missing').toBeTruthy();
    expect(block![0]).toMatch(/addImageOverrideOptions\(cmd\)/);
  });

  it('start-alb composes addImageOverrideOptions inside its specific-options helper', () => {
    const source = readFileSync(ALB_SOURCE, 'utf-8');
    expect(source).toMatch(/addImageOverrideOptions/);
    const block = source.match(
      /export function addAlbSpecificOptions\(cmd: Command\): Command \{[\s\S]*?\}/
    );
    expect(block, 'addAlbSpecificOptions block missing').toBeTruthy();
    expect(block![0]).toMatch(/addImageOverrideOptions\(cmd\)/);
  });
});
