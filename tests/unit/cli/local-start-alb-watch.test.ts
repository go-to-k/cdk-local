import { describe, it, expect } from 'vite-plus/test';
import { Command } from 'commander';
import {
  addAlbSpecificOptions,
  albStrategy,
} from '../../../src/cli/commands/local-start-alb.js';
import { type EcsServiceEmulatorOptions } from '../../../src/cli/commands/ecs-service-emulator.js';

/**
 * Phase 3 of issue #214 — locks the `cdkl start-alb --watch` wiring
 * specific to Phase 3 (the flag is OFF by default; the strategy opts
 * into the emulator's `--watch` reload pathway via `supportsWatch`).
 *
 * The full ALB surface contract (the exact set of long flags
 * `addAlbSpecificOptions` exports + the no-inline-drift invariant
 * between common + ALB-specific + `createLocalStartAlbCommand`) is
 * already locked in `tests/unit/local/start-alb-binding.test.ts`; this
 * file only owns the Phase-3 incremental assertions to keep the lock
 * single-sourced (a missing `--watch` would trip the binding test's
 * full-list lock too).
 *
 * Other Phase 3 coverage lives in:
 *
 *   - `tests/unit/local/front-door-pool.test.ts` (atomic register-new-
 *     before-unregister-old swap the rolling primitive relies on).
 *   - `tests/unit/local/ecs-service-runner-rolling.test.ts` (Phase 2
 *     `rollServiceReplica` primitive — same per-replica rolling loop
 *     the ALB strategy reuses).
 *   - `tests/integration/local-start-alb-watch/` (ALB-fronted multi-
 *     replica rolling deploy — zero connection refusal observed by a
 *     host-side curl loop against the listener port across the roll).
 */
describe('start-alb --watch (Phase 3 of #214)', () => {
  it('--watch defaults to false', () => {
    // Locks the boolean default (off by default per the issue + the
    // README copy). A flipped default would silently install a chokidar
    // watcher for every start-alb invocation.
    const cmd = addAlbSpecificOptions(new Command());
    const watch = cmd.options.find((o) => o.long === '--watch');
    expect(watch).toBeDefined();
    expect(watch?.defaultValue).toBe(false);
  });

  it('albStrategy opts into the emulator --watch reload pathway via supportsWatch=true', () => {
    // Phase 3 — flipping this off would silently disable
    // `cdkl start-alb --watch`. The emulator's watcher install is gated
    // on this exact field, and the host front-door's per-listener pool
    // already swaps atomically (register-new-before-unregister-old,
    // single-assignment Map mutation on a single JS thread) as part of
    // the Phase 2 rolling primitive — no additional pool wiring is
    // required.
    expect(albStrategy(emptyOptions()).supportsWatch).toBe(true);
  });
});

function emptyOptions(): EcsServiceEmulatorOptions {
  // The strategy factory reads `options.lbPort` (for
  // `parseLbPortOverrides`) and nothing else; the unit test only needs
  // to exercise the strategy descriptor, not run the emulator. The
  // other required fields are stubbed with sensible defaults.
  return {
    output: 'cdk.out',
    verbose: false,
    cluster: 'cdkl',
    containerHost: '127.0.0.1',
    pull: true,
    maxTasks: 3,
    restartPolicy: 'on-failure',
  };
}
