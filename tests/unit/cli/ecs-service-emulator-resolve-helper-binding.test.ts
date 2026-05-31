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
 * Phase 2 of issue #214 site-level binding test (per
 * `feedback_site_level_binding_test.md`).
 *
 * `resolveServiceAndRunnerOpts` was extracted from `runOneTarget` so the
 * Phase 2 rolling-reload path (`rollOneTarget`) could reuse it without
 * a second copy of the cross-stack / assume-task-role / env-overrides /
 * front-door composition. Both call sites have to keep funneling
 * through the helper — a refactor that silently re-inlines either side
 * would break the rolling reload's "use the new image's task descriptor"
 * guarantee (initial boot would resolve via the helper but reload
 * wouldn't, or vice versa).
 *
 * The rolling primitive's own unit tests
 * (`ecs-service-runner-rolling.test.ts`) mock the runner boundary and
 * never observe the resolution step, so the binding has no functional
 * coverage there. This test pins the binding at the source level — the
 * file MUST reference `resolveServiceAndRunnerOpts` from BOTH callers.
 */
describe('ecs-service-emulator resolveServiceAndRunnerOpts binding (Phase 2 of issue #214)', () => {
  it('runOneTarget and rollOneTarget both call resolveServiceAndRunnerOpts', () => {
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    const callCount = (source.match(/resolveServiceAndRunnerOpts\s*\(/g) ?? []).length;
    // One declaration (`function resolveServiceAndRunnerOpts(`) +
    // two call sites (`runOneTarget` and `rollOneTarget`'s
    // `resolveServiceAndRunnerOpts(...)`). If either caller silently
    // gets re-inlined, this drops to 2 and the test fails.
    expect(callCount).toBeGreaterThanOrEqual(3);

    // Lock the call from runOneTarget — initial boot path.
    expect(source).toMatch(
      /async\s+function\s+runOneTarget[\s\S]*?await\s+resolveServiceAndRunnerOpts\(/
    );

    // Lock the call from rollOneTarget — Phase 2 rolling reload path.
    expect(source).toMatch(
      /async\s+function\s+rollOneTarget[\s\S]*?await\s+resolveServiceAndRunnerOpts\(/
    );
  });

  it('the rolling reload path passes quiet:true to resolveServiceAndRunnerOpts', () => {
    // The helper's signature ends with `opts: { quiet?: boolean } = {}`.
    // The initial-boot caller leaves it default (logs the target banner
    // + Service Connect line + Cloud Map ServiceRegistries line). The
    // reload caller MUST pass `{ quiet: true }` so the same banners
    // don't spam the console on every save — a regression that flipped
    // this would make `--watch` noisy in a noticeable but easy-to-miss
    // way (every save reprints the boot banner).
    const source = readFileSync(EMULATOR_SOURCE, 'utf-8');
    expect(source).toMatch(
      /async\s+function\s+rollOneTarget[\s\S]*?resolveServiceAndRunnerOpts\([\s\S]*?\{\s*quiet:\s*true\s*\}/
    );
  });
});
