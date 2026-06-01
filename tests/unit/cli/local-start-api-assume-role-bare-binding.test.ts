import { describe, expect, it } from 'vite-plus/test';
import { Command } from 'commander';
import { createLocalStartApiCommand } from '../../../src/cli/commands/local-start-api.js';
import type { AssumeRoleOption } from '../../../src/cli/options.js';

const ARN = 'arn:aws:iam::123456789012:role/MyRole';
const ARN_2 = 'arn:aws:iam::123456789012:role/OtherRole';

/**
 * Site-level binding tests for issue #256 Option 1 — verify the
 * `--assume-role` value-form option and the separate
 * `--assume-role-auto` boolean flag are both registered on the
 * `start-api` command factory with the right argument shapes. We
 * exercise Commander's argument parsing directly (no synth, no
 * docker) so the binding between each flag and its accumulator is
 * locked in.
 *
 * Why two flags: an earlier draft used `--assume-role [arn]`
 * (optional value), but Commander's optional-value handling silently
 * overwrites the value-form accumulator with `true` when the bare
 * form is parsed AFTER value forms, dropping the per-Lambda map. The
 * separate boolean flag eliminates the ordering quirk.
 */
function parseStartApiArgs(args: string[]): {
  assumeRole: AssumeRoleOption | undefined;
  assumeRoleAuto: boolean;
} {
  const cmd = createLocalStartApiCommand();
  // Stub the action so parseAsync doesn't try to boot the server.
  cmd.action(() => {});
  cmd.exitOverride();
  cmd.parse(['node', 'cdkl', ...args]);
  return cmd.opts() as {
    assumeRole: AssumeRoleOption | undefined;
    assumeRoleAuto: boolean;
  };
}

describe('createLocalStartApiCommand — --assume-role / --assume-role-auto binding (issue #256 Option 1)', () => {
  describe('Commander accumulator from the flag forms', () => {
    it('both flags absent -> options.assumeRole undefined, options.assumeRoleAuto false', () => {
      const opts = parseStartApiArgs([]);
      expect(opts.assumeRole).toBeUndefined();
      expect(opts.assumeRoleAuto).toBe(false);
    });

    it('--assume-role-auto -> options.assumeRoleAuto is true, options.assumeRole undefined', () => {
      const opts = parseStartApiArgs(['--assume-role-auto']);
      expect(opts.assumeRoleAuto).toBe(true);
      expect(opts.assumeRole).toBeUndefined();
    });

    it('--assume-role <arn> (global default) -> AssumeRoleOption.globalArn', () => {
      const opts = parseStartApiArgs(['--assume-role', ARN]);
      expect(opts.assumeRole).toEqual({ globalArn: ARN, perLambda: {} });
      expect(opts.assumeRoleAuto).toBe(false);
    });

    it('--assume-role MyFn=<arn> (per-Lambda override) -> AssumeRoleOption.perLambda', () => {
      const opts = parseStartApiArgs(['--assume-role', `MyFn=${ARN}`]);
      expect(opts.assumeRole).toEqual({ perLambda: { MyFn: ARN } });
      expect(opts.assumeRoleAuto).toBe(false);
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

    it('--assume-role-auto + --assume-role MyFn=<arn> (auto first) keeps the per-Lambda accumulator intact', () => {
      // The whole reason we split into two flags: bare-then-value
      // must NOT clobber the value-form accumulator. With separate
      // flags, the boolean lives on a different option entirely.
      const opts = parseStartApiArgs([
        '--assume-role-auto',
        '--assume-role',
        `MyFn=${ARN}`,
      ]);
      expect(opts.assumeRoleAuto).toBe(true);
      expect(opts.assumeRole).toEqual({ perLambda: { MyFn: ARN } });
    });

    it('--assume-role MyFn=<arn> + --assume-role-auto (auto last) keeps both intact', () => {
      // The reverse ordering. With the old `[arn]` shape this case
      // worked, but the bare-then-value ordering was the silent
      // data-loss path. With separate flags, BOTH orderings are
      // equivalent — the two accumulators live on different options.
      const opts = parseStartApiArgs([
        '--assume-role',
        `MyFn=${ARN}`,
        '--assume-role-auto',
      ]);
      expect(opts.assumeRoleAuto).toBe(true);
      expect(opts.assumeRole).toEqual({ perLambda: { MyFn: ARN } });
    });
  });

  describe('option descriptions advertise the two forms + the mutual-exclusion guard', () => {
    it('--assume-role description names global default + per-Lambda override + the auto pairing', () => {
      const cmd = createLocalStartApiCommand();
      const opt = cmd.options.find((o) => o.long === '--assume-role');
      expect(opt).toBeDefined();
      const desc = opt!.description ?? '';
      expect(desc).toMatch(/global default/i);
      expect(desc).toMatch(/<LogicalId>=<arn>/);
      expect(desc).toMatch(/--assume-role-auto/);
    });

    it('--assume-role-auto description names per-Lambda auto-resolve + the mutual-exclusion guard', () => {
      const cmd = createLocalStartApiCommand();
      const opt = cmd.options.find((o) => o.long === '--assume-role-auto');
      expect(opt).toBeDefined();
      const desc = opt!.description ?? '';
      expect(desc).toMatch(/auto-resolve.*per-Lambda|per-Lambda.*auto-resolve/i);
      expect(desc).toMatch(/mutually exclusive/i);
    });
  });

  describe('option is registered with required-value syntax <arn-or-pair>', () => {
    it('the --assume-role option declares the value as required (<arn-or-pair>)', () => {
      const cmd = createLocalStartApiCommand();
      const opt = cmd.options.find((o) => o.long === '--assume-role');
      expect(opt).toBeDefined();
      expect(opt!.required).toBe(true);
      expect(opt!.optional).toBe(false);
    });

    it('the --assume-role-auto option is a boolean flag (no value)', () => {
      const cmd = createLocalStartApiCommand();
      const opt = cmd.options.find((o) => o.long === '--assume-role-auto');
      expect(opt).toBeDefined();
      expect(opt!.required).toBe(false);
      expect(opt!.optional).toBe(false);
    });
  });
});

describe('createLocalStartApiCommand — addStartApiSpecificOptions placement', () => {
  it('both --assume-role and --assume-role-auto are added via addStartApiSpecificOptions (not inline in create<Cmd>Command)', async () => {
    const { addStartApiSpecificOptions } = await import(
      '../../../src/cli/commands/local-start-api.js'
    );
    const cmd = addStartApiSpecificOptions(new Command());
    const assumeRole = cmd.options.find((o) => o.long === '--assume-role');
    const assumeRoleAuto = cmd.options.find((o) => o.long === '--assume-role-auto');
    expect(assumeRole).toBeDefined();
    expect(assumeRole!.required).toBe(true);
    expect(assumeRoleAuto).toBeDefined();
  });
});
