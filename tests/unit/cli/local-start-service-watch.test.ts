import { describe, it, expect } from 'vite-plus/test';
import { Command } from 'commander';
import {
  addStartServiceSpecificOptions,
  createLocalStartServiceCommand,
  serviceStrategy,
} from '../../../src/cli/commands/local-start-service.js';
import {
  addCommonEcsServiceOptions,
  assertSingleReplicaForWatch,
  type EcsServiceEmulatorOptions,
} from '../../../src/cli/commands/ecs-service-emulator.js';
import { LocalStartServiceError } from '../../../src/utils/error-handler.js';

/**
 * Phase 1 of issue #214 — locks the `cdkl start-service --watch` wiring.
 * The integ fixture (`tests/integration/local-start-service-watch/`) covers
 * the live reload behavior end-to-end; these unit tests just guard the
 * option-surface contract + the synchronous single-replica gate.
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

describe('assertSingleReplicaForWatch (Phase 1 of issue #214)', () => {
  // The synthetic shape only needs the two fields the helper reads — the
  // resolver's full `ResolvedEcsService` is much larger but irrelevant for
  // this gate's logic.
  function fakeService(
    desiredCount: number,
    serviceName = 'WebSvc'
  ): { serviceName: string; desiredCount: number } {
    return { serviceName, desiredCount };
  }

  function baseOptions(
    over: Partial<Pick<EcsServiceEmulatorOptions, 'watch' | 'maxTasks'>> = {}
  ): Pick<EcsServiceEmulatorOptions, 'watch' | 'maxTasks'> {
    return { maxTasks: 3, ...over };
  }

  it('passes when --watch is off (multi-replica + no watch is fine)', () => {
    expect(() => assertSingleReplicaForWatch(fakeService(2), baseOptions())).not.toThrow();
    expect(() =>
      assertSingleReplicaForWatch(fakeService(10), baseOptions({ watch: false }))
    ).not.toThrow();
  });

  it('passes when --watch is on AND the effective replica count is 1', () => {
    expect(() =>
      assertSingleReplicaForWatch(fakeService(1), baseOptions({ watch: true }))
    ).not.toThrow();
    // Effective count is clamped by --max-tasks; a DesiredCount=5 capped to
    // --max-tasks=1 also resolves to 1 → pass.
    expect(() =>
      assertSingleReplicaForWatch(fakeService(5), baseOptions({ watch: true, maxTasks: 1 }))
    ).not.toThrow();
  });

  it('throws LocalStartServiceError when --watch is on AND effective replica count > 1', () => {
    expect(() =>
      assertSingleReplicaForWatch(fakeService(2), baseOptions({ watch: true }))
    ).toThrow(LocalStartServiceError);
    expect(() =>
      assertSingleReplicaForWatch(fakeService(2), baseOptions({ watch: true }))
    ).toThrow(/single-replica only/);
  });

  it('the thrown error names the service + counts + points to Phase 2 of issue #214', () => {
    // The error message is part of the user-facing contract — a developer
    // hitting it needs to know WHICH service tripped the gate, the effective
    // count, AND where the multi-replica story is going (Phase 2). Locking
    // the message prevents an accidental message regression that strips the
    // actionable hint.
    try {
      assertSingleReplicaForWatch(
        fakeService(4, 'OrdersSvc'),
        baseOptions({ watch: true, maxTasks: 3 })
      );
      throw new Error('expected assertSingleReplicaForWatch to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/OrdersSvc/);
      expect(msg).toMatch(/3 replica\(s\)/);
      expect(msg).toMatch(/DesiredCount=4/);
      expect(msg).toMatch(/--max-tasks=3/);
      expect(msg).toMatch(/Phase 2 of issue #214/);
    }
  });
});
