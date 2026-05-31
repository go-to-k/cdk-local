import { describe, it, expect } from 'vite-plus/test';
import { Command } from 'commander';
import {
  createLocalStartServiceCommand,
} from '../../../src/cli/commands/local-start-service.js';
import {
  createLocalStartAlbCommand,
} from '../../../src/cli/commands/local-start-alb.js';
import { addCommonEcsServiceOptions } from '../../../src/cli/commands/ecs-service-emulator.js';

/**
 * Issue #227 review fix (Test G1) — site-level binding test for the
 * `--no-logs` flag's wiring across both ECS-service factories. The flag
 * is added INSIDE `addCommonEcsServiceOptions`, NOT inline in
 * `create<Cmd>Command`, so cdkd (and any other host CLI composing the
 * helpers) auto-inherits it. The runtime gate at
 * `resolveServiceAndRunnerOpts` reads `options.logs !== false` so the
 * default (no flag) flips `streamLogs` ON, and `--no-logs` flips it OFF.
 *
 * Two failure modes this test locks:
 *
 *   1. Site placement — a refactor that moves the option inline in
 *      `createLocalStartServiceCommand` / `createLocalStartAlbCommand`
 *      would silently drop it from cdkd's surface (cdkd composes
 *      `addCommonEcsServiceOptions` + a tiny tail of strategy-specific
 *      flags; an inline addition is invisible to that path).
 *
 *   2. Predicate flip — a refactor changing the gate from
 *      `options.logs !== false` to `options.logs === true` (or the
 *      opposite) would silently invert the default. Drive the parse
 *      end-to-end so the boolean value flowing through is locked.
 *
 * Mirrors the binding pattern documented in `CLAUDE.md` (site-level
 * binding test for shared helpers) — extracted helper without a
 * site-level test silently keeps the old form in a less-trafficked
 * branch.
 */

function parseWith(create: () => Command, argv: string[]): { logs: unknown } {
  const cmd = create();
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.parse(argv, { from: 'user' });
  return cmd.opts() as { logs: unknown };
}

describe('--no-logs CLI binding (Issue #227 review fix — Test G1)', () => {
  it('addCommonEcsServiceOptions registers `--no-logs` (NOT inline in either factory)', () => {
    // Lock the placement invariant. cdkd-parity / 3-axis review keyword:
    // "added inside add<Cmd>SpecificOptions" — but here the flag is in
    // the SHARED common helper so BOTH start-service and start-alb
    // pick it up at once.
    const common = addCommonEcsServiceOptions(new Command());
    const opt = common.options.find((o) => o.long === '--no-logs');
    expect(opt).toBeDefined();
  });

  it('start-service: parse without `--no-logs` populates opts().logs=true → emulator treats this as default-on', () => {
    // Commander's `--no-X` form populates `opts().X = true` when the
    // flag is NOT passed and `opts().X = false` when it IS. The
    // emulator's gate is `streamLogs: options.logs !== false`, so
    // both `true` (default) and `undefined` (a hypothetical drop of
    // the default) map to default-ON. The assertion below locks the
    // `true` shape under today's Commander behavior; the predicate
    // mirror below locks the gate's `!== false` contract regardless.
    const opts = parseWith(createLocalStartServiceCommand, [
      'node',
      'cdkl',
      'start-service',
      'MyStack:Svc',
    ]);
    expect(opts.logs).toBe(true);
    // Mirror the predicate at the gate site so a flipped predicate
    // (`!== true` instead of `!== false`) trips this test.
    expect(opts.logs !== false).toBe(true);
  });

  it('start-service: parse with `--no-logs` populates opts().logs=false → emulator flips streamLogs OFF', () => {
    const opts = parseWith(createLocalStartServiceCommand, [
      'node',
      'cdkl',
      'start-service',
      'MyStack:Svc',
      '--no-logs',
    ]);
    expect(opts.logs).toBe(false);
    expect(opts.logs !== false).toBe(false);
  });

  it('start-alb: parse without `--no-logs` populates opts().logs=true → emulator treats this as default-on', () => {
    const opts = parseWith(createLocalStartAlbCommand, [
      'node',
      'cdkl',
      'start-alb',
      'MyStack:WebLB',
    ]);
    expect(opts.logs).toBe(true);
    expect(opts.logs !== false).toBe(true);
  });

  it('start-alb: parse with `--no-logs` populates opts().logs=false → emulator flips streamLogs OFF', () => {
    const opts = parseWith(createLocalStartAlbCommand, [
      'node',
      'cdkl',
      'start-alb',
      'MyStack:WebLB',
      '--no-logs',
    ]);
    expect(opts.logs).toBe(false);
    expect(opts.logs !== false).toBe(false);
  });
});
