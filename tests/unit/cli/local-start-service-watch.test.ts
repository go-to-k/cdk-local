import { describe, it, expect } from 'vite-plus/test';
import { Command } from 'commander';
import {
  addStartServiceSpecificOptions,
  createLocalStartServiceCommand,
  serviceStrategy,
} from '../../../src/cli/commands/local-start-service.js';
import { addCommonEcsServiceOptions } from '../../../src/cli/commands/ecs-service-emulator.js';

/**
 * Phase 1 + Phase 2 of issue #214 — locks the `cdkl start-service --watch`
 * wiring at the option-surface level. The behavioral coverage lives in:
 *
 *   - `tests/unit/local/ecs-service-runner-rolling.test.ts` (Phase 2
 *     `rollServiceReplica` primitive — generation suffix, atomic swap
 *     ordering, shadow-boot failure path).
 *   - `tests/integration/local-start-service-watch/` (Phase 1 single-
 *     replica reload, kept as a Phase 2 regression test).
 *   - `tests/integration/local-start-service-watch-multi/` (Phase 2
 *     multi-replica rolling deploy — zero connection refusal across a
 *     roll under continuous curl load).
 */

function longFlagsOf(cmd: Command): string[] {
  return cmd.options
    .map((o) => o.long)
    .filter((l): l is string => typeof l === 'string')
    .sort();
}

describe('start-service option surface contract (addStartServiceSpecificOptions)', () => {
  it('addStartServiceSpecificOptions registers exactly the known start-service-only flags', () => {
    // Lock the helper's contract: cdkd imports it expecting THIS set of long
    // flags. Adding or removing one without updating the list below is a
    // semver-relevant surface change.
    const flags = longFlagsOf(addStartServiceSpecificOptions(new Command()));
    expect(flags).toEqual(['--host-port', '--watch']);
  });

  it('createLocalStartServiceCommand surface equals common + start-service-specific (no inline drift)', () => {
    // The full CLI surface MUST be the union of the two helpers — never a
    // proper superset. A proper superset would mean someone added an option
    // inline in `createLocalStartServiceCommand`, which a host CLI (cdkd)
    // calling the helpers directly would silently miss.
    const full = longFlagsOf(createLocalStartServiceCommand());
    const expected = Array.from(
      new Set([
        ...longFlagsOf(addCommonEcsServiceOptions(new Command())),
        ...longFlagsOf(addStartServiceSpecificOptions(new Command())),
      ])
    ).sort();
    expect(full).toEqual(expected);
  });

  it('--watch defaults to false', () => {
    // Locks the boolean default (off by default per the issue + the README
    // "off by default" copy). A flipped default would silently install a
    // chokidar watcher for every start-service invocation.
    const cmd = addStartServiceSpecificOptions(new Command());
    const watch = cmd.options.find((o) => o.long === '--watch');
    expect(watch?.defaultValue).toBe(false);
  });
});

describe('serviceStrategy', () => {
  it('opts into the emulator --watch reload pathway via supportsWatch=true', () => {
    // start-alb's strategy intentionally leaves `supportsWatch` falsy (its
    // own --watch is Phase 3 of issue #214). Flipping this off on
    // `serviceStrategy()` would silently disable `cdkl start-service --watch`
    // — the emulator's watcher install is gated on this exact field.
    expect(serviceStrategy().supportsWatch).toBe(true);
  });
});
