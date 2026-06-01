import { describe, expect, it } from 'vite-plus/test';
import { Command } from 'commander';
import { createLocalStartApiCommand } from '../../../src/cli/commands/local-start-api.js';
import type { AssumeRoleOption } from '../../../src/cli/options.js';

const ARN = 'arn:aws:iam::123456789012:role/MyRole';
const ARN_2 = 'arn:aws:iam::123456789012:role/OtherRole';

/**
 * Site-level binding tests for issue #256 Option 1 — verify the
 * `--assume-role` option is registered with the four-form grammar
 * on the `start-api` command factory. We exercise Commander's
 * argument parsing directly (no synth, no docker) so the binding
 * between the option flag and the accumulator is locked in.
 *
 * Note: when Commander's `[arn-or-pair]` runs the argParser only
 * for VALUE forms; for the bare flag it directly stores the
 * default-value placeholder. Both branches end up in the
 * `options.assumeRole` accumulator we check.
 */
function parseStartApiArgs(args: string[]): {
  assumeRole: AssumeRoleOption | boolean | undefined;
} {
  const cmd = createLocalStartApiCommand();
  // Stub the action so parseAsync doesn't try to boot the server.
  cmd.action(() => {});
  // Some sub-options on `start-api` are global-only side effects; we
  // only want the `--assume-role` argParser to fire. Use the
  // exitOverride so Commander doesn't process.exit on unknown args.
  cmd.exitOverride();
  cmd.parse(['node', 'cdkl', ...args]);
  return cmd.opts() as { assumeRole: AssumeRoleOption | boolean | undefined };
}

describe('createLocalStartApiCommand — --assume-role binding (issue #256 Option 1)', () => {
  describe('Commander accumulator from the four flag forms', () => {
    it('flag absent -> options.assumeRole is undefined', () => {
      const opts = parseStartApiArgs([]);
      expect(opts.assumeRole).toBeUndefined();
    });

    it('bare --assume-role (no value) -> options.assumeRole is true', () => {
      // Commander stores `true` for the bare optional-value form;
      // the in-process normalization step then collapses it to
      // `{ perLambda: {}, bareAutoResolve: true }`.
      const opts = parseStartApiArgs(['--assume-role']);
      expect(opts.assumeRole).toBe(true);
    });

    it('--assume-role <arn> (global default) -> AssumeRoleOption.globalArn', () => {
      const opts = parseStartApiArgs(['--assume-role', ARN]);
      expect(opts.assumeRole).toEqual({ globalArn: ARN, perLambda: {} });
    });

    it('--assume-role MyFn=<arn> (per-Lambda override) -> AssumeRoleOption.perLambda', () => {
      const opts = parseStartApiArgs(['--assume-role', `MyFn=${ARN}`]);
      expect(opts.assumeRole).toEqual({ perLambda: { MyFn: ARN } });
    });

    it('repeatable --assume-role <Id>=<arn> accumulates per-Lambda entries', () => {
      const opts = parseStartApiArgs([
        '--assume-role',
        `MyFn=${ARN}`,
        '--assume-role',
        `OtherFn=${ARN_2}`,
      ]);
      expect(opts.assumeRole).toEqual({
        perLambda: { MyFn: ARN, OtherFn: ARN_2 },
      });
    });

    it('bare --assume-role followed by --assume-role MyFn=<arn> mixes bareAutoResolve with per-Lambda override', () => {
      // After the bare flag stores `true`, the next value-form
      // invocation of the argParser sees previous=true and preserves
      // bareAutoResolve while adding the per-Lambda entry.
      const opts = parseStartApiArgs([
        '--assume-role',
        '--assume-role',
        `MyFn=${ARN}`,
      ]);
      expect(opts.assumeRole).toEqual({
        bareAutoResolve: true,
        perLambda: { MyFn: ARN },
      });
    });
  });

  describe('option description advertises the three forms + the mutual-exclusion guard', () => {
    it('description names bare-auto-resolve, global default, per-Lambda, and the boot-time guard', () => {
      const cmd = createLocalStartApiCommand();
      const opt = cmd.options.find((o) => o.long === '--assume-role');
      expect(opt).toBeDefined();
      const desc = opt!.description ?? '';
      // Bare-auto-resolve language (form 3 in the docstring).
      expect(desc).toMatch(/bare.*no value.*auto-resolve|auto-resolve.*per-Lambda/i);
      // Per-Lambda override language (form 2).
      expect(desc).toMatch(/<LogicalId>=<arn>/);
      // Global default language (form 1).
      expect(desc).toMatch(/global default/i);
      // Mutual exclusion guard.
      expect(desc).toMatch(/mutually exclusive/i);
    });
  });

  describe('option is registered with optional-value syntax [arn-or-pair]', () => {
    it('the --assume-role option declares the value as optional ([arn-or-pair])', () => {
      const cmd = createLocalStartApiCommand();
      const opt = cmd.options.find((o) => o.long === '--assume-role');
      expect(opt).toBeDefined();
      // Commander's `Option.optional` is true for `[arn]` (optional value).
      expect(opt!.optional).toBe(true);
      expect(opt!.required).toBe(false);
    });
  });
});

describe('createLocalStartApiCommand — addStartApiSpecificOptions placement', () => {
  it('--assume-role is added via addStartApiSpecificOptions (not inline in create<Cmd>Command)', async () => {
    // Sanity check: the option-surface contract test compares
    // `createLocalStartApiCommand()` vs `addStartApiSpecificOptions(new Command())`.
    // We re-assert the binding via the cdkd-parity rule directly:
    // adding the option here ensures it shows up on the helper-only
    // surface, NOT only on the factory.
    const { addStartApiSpecificOptions } = await import(
      '../../../src/cli/commands/local-start-api.js'
    );
    const cmd = addStartApiSpecificOptions(new Command());
    const opt = cmd.options.find((o) => o.long === '--assume-role');
    expect(opt).toBeDefined();
    expect(opt!.optional).toBe(true);
  });
});
