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

  it('boot path calls `resolveAndBuildImageOverrides` before threading per-target tags into `bootOneTarget`', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // Anchor on (a) the boot-time helper call site and (b) the
    // bootOneTarget invocation downstream of it that consumes the
    // per-target tag. The text between them isn't pinned (avoids the
    // brittle `for (const pt of perTarget)` literal that recurs four
    // times in the source); ordering is the load-bearing constraint —
    // the tags must be resolved BEFORE the first runner boot so a
    // covered target's representative container starts with the
    // local-built image, not the deployed pin.
    const resolveIdx = source.indexOf('resolveAndBuildImageOverrides(');
    const bootCallIdx = source.indexOf('imageOverrideTags.get(pt.boot.target)');
    expect(resolveIdx, 'resolveAndBuildImageOverrides call missing').toBeGreaterThan(-1);
    expect(bootCallIdx, 'bootOneTarget thread of imageOverrideTags missing').toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(bootCallIdx);
    // The downstream consumer must be the `bootOneTarget` call, not
    // some other use of the tag map.
    expect(
      source.slice(resolveIdx, bootCallIdx + 'imageOverrideTags.get(pt.boot.target)'.length)
    ).toMatch(/await bootOneTarget\(/);
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

  it('reload-skip guard carves out overridden targets (regression: #241-B1)', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The reload-skip guard that pre-empts the rolling primitive for
    // deployed-registry pins MUST also bypass-skip overridden targets,
    // because the override is injected at runner level and
    // controller.service still holds the deployed pin. Without the
    // carve-out, every overridden target gets silently skipped on
    // every reload and the feature is broken for its main use case.
    const reloadFnRegion = source.match(
      /async function reloadAllServices\(args:[\s\S]*?logger\.info\('Reload complete\.'\);/
    );
    expect(reloadFnRegion, 'reloadAllServices body missing').toBeTruthy();
    const body = reloadFnRegion![0];
    // The guard's three load-bearing clauses must all be present AND
    // co-located inside the same if-condition with the carve-out.
    const guardRegion = body.match(
      /if \(\s*verdict\.kind === 'rebuild'[\s\S]*?!isLocalCdkAssetImage\(controller\.service\)[\s\S]*?!imageOverrideTags\.has\(newBoot\.target\)[\s\S]*?\) \{[\s\S]*?Reload skipped/
    );
    expect(
      guardRegion,
      'reload-skip guard missing the !imageOverrideTags.has(newBoot.target) carve-out'
    ).toBeTruthy();
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
});

describe('reload-time --image-override rebuild (issue #262)', () => {
  // Issue #262 — the boot-time tag map is stale on every `--watch`
  // reload because `runImageOverrideBuilds` only ran once at boot.
  // Source edits under a covered Dockerfile therefore never reached
  // the running container — the rolling primitive booted a shadow
  // from the SAME local tag, which still pointed at the boot-time
  // image bytes.
  //
  // The fix retains the post-Stage-3 `ImageOverrideMap` (alongside
  // the boot-time tag map), threads it through to
  // `reloadAllServices`, and re-runs `runImageOverrideBuilds`
  // per-target on every reload so a content-addressed tag flip
  // boots the shadow against the freshly-built image. Stage 1
  // (picker) and Stage 3 (boot prompt) interactive paths AND the
  // orphan validator are intentionally NOT re-run — they were
  // resolved at boot and don't change.
  //
  // These source-grep bindings pin the four load-bearing pieces a
  // future refactor could silently drop:
  //   1. The boot-time helper returns BOTH `tags` and `overrides`,
  //      and the caller destructures both.
  //   2. The watcher's `onChange` forwards the retained
  //      `imageOverrideMap` to `reloadAllServices` next to the tag
  //      map.
  //   3. `reloadAllServices` re-invokes `runImageOverrideBuilds` on
  //      `imageOverrideMap` BEFORE the per-target classifier /
  //      skip / roll loop fires.
  //   4. The re-build is wrapped in a per-target try/catch so a
  //      single failure logs a warn + keeps the OLD replica
  //      serving + lets sibling targets continue rolling.

  it('resolveAndBuildImageOverrides returns BOTH `tags` and `overrides`, caller destructures both', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // Return type names both fields.
    expect(source).toMatch(
      /Promise<\{\s*tags:\s*Map<string,\s*string>;\s*overrides:\s*ImageOverrideMap\s*\}>/
    );
    // Boot path destructures both — anchored on the destructure
    // line containing `tags: imageOverrideTags` AND
    // `overrides: imageOverrideMap`.
    expect(source).toMatch(
      /\{\s*tags:\s*imageOverrideTags,\s*overrides:\s*imageOverrideMap\s*\}\s*=\s*await\s+resolveAndBuildImageOverrides\(/
    );
  });

  it('watcher onChange forwards `imageOverrideMap` to reloadAllServices alongside `imageOverrideTags`', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The watcher block must thread the retained map to the reload
    // function — without it, the reload pathway has no input to
    // re-feed `runImageOverrideBuilds`.
    const watcherCall = source.match(
      /onChange:\s*\(changedPaths\)\s*=>\s*\{[\s\S]*?reloadAllServices\(\{[\s\S]*?imageOverrideMap[\s\S]*?\}\)/
    );
    expect(
      watcherCall,
      'watcher onChange missing the imageOverrideMap thread (issue #262)'
    ).toBeTruthy();
  });

  it('reloadAllServices accepts the `imageOverrideMap` param of type ImageOverrideMap', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    const reloadFnRegion = source.match(
      /async function reloadAllServices\(args:[\s\S]*?logger\.info\('Reload complete\.'\);/
    );
    expect(reloadFnRegion, 'reloadAllServices body missing').toBeTruthy();
    const body = reloadFnRegion![0];
    expect(body).toMatch(/imageOverrideMap:\s*ImageOverrideMap/);
  });

  it('reloadAllServices re-invokes runImageOverrideBuilds BEFORE the per-target roll loop', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    const reloadFnRegion = source.match(
      /async function reloadAllServices\(args:[\s\S]*?logger\.info\('Reload complete\.'\);/
    );
    expect(reloadFnRegion, 'reloadAllServices body missing').toBeTruthy();
    const body = reloadFnRegion![0];
    // The re-build call must exist AND walk `imageOverrideMap`
    // entries (per-target so one failure doesn't abort siblings).
    expect(body).toMatch(/for\s*\(\s*const\s+\[target,\s*entry\]\s+of\s+imageOverrideMap\.entries/);
    expect(body).toMatch(/await\s+runImageOverrideBuilds\(\s*new\s+Map\(\[\[target,\s*entry\]\]\)\s*\)/);
    // It must precede the per-target classifier / skip / roll loop.
    const rebuildIdx = body.search(/await\s+runImageOverrideBuilds\(/);
    const rollLoopIdx = body.indexOf('for (const pt of perTarget)');
    expect(rebuildIdx, 'reload-time runImageOverrideBuilds call missing').toBeGreaterThan(-1);
    expect(rollLoopIdx, 'per-target roll loop missing').toBeGreaterThan(-1);
    expect(rebuildIdx).toBeLessThan(rollLoopIdx);
  });

  it('reload-time rebuild is wrapped in try/catch so one target failure does not abort siblings', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    const reloadFnRegion = source.match(
      /async function reloadAllServices\(args:[\s\S]*?logger\.info\('Reload complete\.'\);/
    );
    expect(reloadFnRegion, 'reloadAllServices body missing').toBeTruthy();
    const body = reloadFnRegion![0];
    // The per-target rebuild block must have a try { runImageOverrideBuilds(...) }
    // catch shape that logs a warn naming the target + error head,
    // and the catch must NOT throw so the loop continues.
    const tryCatchRegion = body.match(
      /for\s*\(\s*const\s+\[target,\s*entry\]\s+of\s+imageOverrideMap\.entries[\s\S]*?try\s*\{[\s\S]*?runImageOverrideBuilds[\s\S]*?\}\s*catch\s*\(err\)\s*\{[\s\S]*?logger\.warn\(/
    );
    expect(
      tryCatchRegion,
      'reload-time rebuild try/catch + logger.warn missing'
    ).toBeTruthy();
  });

  it('reload-time rebuild does NOT re-fire interactive stages or orphan validator', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    const reloadFnRegion = source.match(
      /async function reloadAllServices\(args:[\s\S]*?logger\.info\('Reload complete\.'\);/
    );
    expect(reloadFnRegion, 'reloadAllServices body missing').toBeTruthy();
    const body = reloadFnRegion![0];
    // Stage 1 (picker) + Stage 3 (boot prompt) live inside
    // `resolveImageOverrides`; the orphan check lives in
    // `enforceImageOverrideOrphans`. None of the three should appear
    // inside the reload function body — they were all resolved at
    // boot, and re-firing the interactive prompts mid-watch would
    // be a UX foot-gun.
    expect(body).not.toMatch(/resolveImageOverrides\(/);
    expect(body).not.toMatch(/enforceImageOverrideOrphans\(/);
    expect(body).not.toMatch(/parseImageOverrideFlags\(/);
  });

  it('seeds the per-reload tags map from the boot-time map so a per-target rebuild failure preserves the old tag', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    const reloadFnRegion = source.match(
      /async function reloadAllServices\(args:[\s\S]*?logger\.info\('Reload complete\.'\);/
    );
    expect(reloadFnRegion, 'reloadAllServices body missing').toBeTruthy();
    const body = reloadFnRegion![0];
    // The destructure renames the incoming param to
    // `boottimeImageOverrideTags`, then a fresh `imageOverrideTags`
    // Map is seeded from it. A per-target rebuild failure leaves
    // the boot-time tag in place for that target, so the rolling
    // primitive still has a valid local image to consult (and the
    // OLD replica keeps serving until a healthy shadow comes up).
    expect(body).toMatch(/imageOverrideTags:\s*boottimeImageOverrideTags/);
    expect(body).toMatch(
      /const\s+imageOverrideTags\s*=\s*new\s+Map<string,\s*string>\(\s*boottimeImageOverrideTags\s*\)/
    );
  });
});

describe('enforceStrictOverrides (issue #238 strict-overrides guard, behavioral)', () => {
  // Behavioral test for the strict-overrides guard. Pulled out of the
  // boot path into a small pure helper so we don't need to mock the
  // entire emulator (synth + resolvers + docker) just to exercise the
  // one if-statement. The boot path's call site is locked via the
  // source-grep test below.
  it('throws LocalStartServiceError naming every uncovered target when strict=true', async () => {
    const { enforceStrictOverrides } = await import(
      '../../../src/cli/commands/ecs-service-emulator.js'
    );
    const { LocalStartServiceError } = await import('../../../src/utils/error-handler.js');
    expect(() => enforceStrictOverrides(true, ['AppService', 'AuthService'])).toThrow(
      LocalStartServiceError
    );
    try {
      enforceStrictOverrides(true, ['AppService', 'AuthService']);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LocalStartServiceError);
      const msg = (err as Error).message;
      expect(msg).toContain('AppService');
      expect(msg).toContain('AuthService');
      expect(msg).toMatch(/2 pinned target\(s\)/);
      expect(msg).toMatch(/--image-override/);
    }
  });

  it('is a no-op when strict=false (even with uncovered targets)', async () => {
    const { enforceStrictOverrides } = await import(
      '../../../src/cli/commands/ecs-service-emulator.js'
    );
    expect(() => enforceStrictOverrides(false, ['AppService'])).not.toThrow();
  });

  it('is a no-op when strict=true but no targets are uncovered', async () => {
    const { enforceStrictOverrides } = await import(
      '../../../src/cli/commands/ecs-service-emulator.js'
    );
    expect(() => enforceStrictOverrides(true, [])).not.toThrow();
  });

  it('boot path calls enforceStrictOverrides AFTER the per-target uncovered scan', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The boot path's strict-overrides binding: the per-target scan
    // builds up `uncoveredPinnedTargets`, then the helper is invoked
    // with `options.strictOverrides === true` + the populated array.
    // Pin both ends so an inlining refactor or a reordering that
    // would fire the guard before the scan populates the array
    // surfaces here.
    const scanIdx = source.indexOf('uncoveredPinnedTargets.push');
    const enforceIdx = source.indexOf('enforceStrictOverrides(');
    expect(scanIdx, 'uncoveredPinnedTargets.push missing').toBeGreaterThan(-1);
    expect(enforceIdx, 'enforceStrictOverrides call missing').toBeGreaterThan(-1);
    expect(scanIdx).toBeLessThan(enforceIdx);
    // The call site MUST forward options.strictOverrides AND the
    // populated array — anything else is a wiring bug.
    expect(source).toMatch(
      /enforceStrictOverrides\(\s*options\.strictOverrides === true\s*,\s*uncoveredPinnedTargets\s*\)/
    );
  });
});

describe('enforceImageOverrideOrphans (issue #240 orphan validator, wiring)', () => {
  // Behavioral coverage for the helper itself lives in
  // tests/unit/local/image-override-engine.test.ts. This block pins
  // the boot-path wiring so a refactor that drops, reorders, or
  // short-circuits past the call site surfaces here.

  it('boot path calls enforceImageOverrideOrphans AFTER resolveImageOverrides (post-Stage 3 prompt)', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The Stage 3 boot prompt fires inside resolveImageOverrides;
    // the orphan validator MUST run AFTER so prompt-injected mappings
    // count as "covered" and the check fires only on genuine typos /
    // forgotten --image-override mappings.
    const resolveIdx = source.indexOf('await resolveImageOverrides(');
    const enforceIdx = source.indexOf('enforceImageOverrideOrphans(');
    expect(resolveIdx, 'resolveImageOverrides call missing').toBeGreaterThan(-1);
    expect(enforceIdx, 'enforceImageOverrideOrphans call missing').toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(enforceIdx);
    // The call MUST forward rawFlags + the resolved overrides map.
    expect(source).toMatch(
      /enforceImageOverrideOrphans\(\s*rawFlags\s*,\s*overrides\s*\)/
    );
  });

  it('boot-path short-circuit gates on rawFlags.perService.size === 0 (per-service typos must reach the orphan validator)', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    // The short-circuit condition that returns an empty override map
    // when there's nothing to do MUST include `rawFlags.perService.size
    // === 0`. A user who passes only `--image-build-arg <svc>:KEY=val`
    // (per-service form, no `--image-override`) would otherwise have
    // their typo silently dropped instead of surfaced as a
    // LocalStartServiceError by enforceImageOverrideOrphans.
    expect(source).toMatch(
      /pinnedTargets\.length === 0[\s\S]{0,400}rawFlags\.perService\.size === 0/
    );
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
