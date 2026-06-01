import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { Command } from 'commander';
import {
  addCommonEcsServiceOptions,
  addEcsAssumeRoleOptions,
  ecsClusterOption,
  resolveEcsAssumeRoleOption,
} from '../../../src/cli/commands/ecs-service-emulator.js';
import { addRunTaskSpecificOptions } from '../../../src/cli/commands/local-run-task.js';
import { addStartApiSpecificOptions } from '../../../src/cli/commands/local-start-api.js';
import { addInvokeSpecificOptions } from '../../../src/cli/commands/local-invoke.js';
import { addInvokeAgentCoreSpecificOptions } from '../../../src/cli/commands/local-invoke-agentcore.js';
import { addAlbSpecificOptions } from '../../../src/cli/commands/local-start-alb.js';
import { getEmbedConfig } from '../../../src/local/embed-config.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * Issue #249 — non-breaking CLI surface consistency fixes. One focused
 * test file so the cross-command behavior is locked in one place: a
 * future regression on any of C6 / C7 / C8 / C9 / C10 / C11 / C12 /
 * C14 fails a single suite.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Return the (long-flag) Option matching `longFlag` from `cmd.options`,
 * or `undefined`. Mirrors the `longFlagsOf` pattern used elsewhere; we
 * need the full Option to assert on `description` / `defaultValue`.
 */
function optionByLong(cmd: Command, longFlag: string) {
  return cmd.options.find((o) => o.long === longFlag);
}

describe('issue #249 / C12 — `--cluster` default sourced from one helper', () => {
  it('ecsClusterOption() default equals the active embed-config resourceNamePrefix', () => {
    const opt = ecsClusterOption();
    expect(opt.long).toBe('--cluster');
    expect(opt.defaultValue).toBe(getEmbedConfig().resourceNamePrefix);
  });

  it('run-task and start-service / start-alb common helper register the SAME --cluster default', () => {
    // Drift guard: the value must come from one helper, not two
    // independent inline defaults. A future PR that hardcodes the
    // prefix in either place fails this assertion.
    const runTaskCluster = optionByLong(
      addRunTaskSpecificOptions(new Command()),
      '--cluster'
    );
    const ecsCommonCluster = optionByLong(
      addCommonEcsServiceOptions(new Command()),
      '--cluster'
    );
    expect(runTaskCluster).toBeDefined();
    expect(ecsCommonCluster).toBeDefined();
    expect(runTaskCluster!.defaultValue).toBe(ecsCommonCluster!.defaultValue);
    expect(runTaskCluster!.defaultValue).toBe(getEmbedConfig().resourceNamePrefix);
  });
});

describe('issue #249 / C6 — `--assume-role` non-breaking alias on ECS commands', () => {
  it('addEcsAssumeRoleOptions registers BOTH --assume-task-role and --assume-role', () => {
    const cmd = addEcsAssumeRoleOptions(new Command());
    const longs = cmd.options.map((o) => o.long).sort();
    expect(longs).toContain('--assume-role');
    expect(longs).toContain('--assume-task-role');
  });

  it('run-task surface exposes both forms', () => {
    const longs = addRunTaskSpecificOptions(new Command())
      .options.map((o) => o.long)
      .sort();
    expect(longs).toContain('--assume-role');
    expect(longs).toContain('--assume-task-role');
  });

  it('start-service / start-alb common helper exposes both forms', () => {
    const longs = addCommonEcsServiceOptions(new Command())
      .options.map((o) => o.long)
      .sort();
    expect(longs).toContain('--assume-role');
    expect(longs).toContain('--assume-task-role');
  });

  it('resolveEcsAssumeRoleOption: new --assume-role wins when both are set', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const effective = resolveEcsAssumeRoleOption({
      assumeRole: 'arn:aws:iam::111111111111:role/New',
      assumeTaskRole: 'arn:aws:iam::222222222222:role/Old',
    });
    expect(effective).toBe('arn:aws:iam::111111111111:role/New');
    // No deprecation warn when `--assume-role` is set (regardless of the
    // legacy flag also being passed) — both forms are valid; only sole
    // use of the legacy form gets the warn.
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolveEcsAssumeRoleOption: only --assume-task-role => deprecation warn fires + value returned', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const effective = resolveEcsAssumeRoleOption({
      assumeTaskRole: 'arn:aws:iam::222222222222:role/Old',
    });
    expect(effective).toBe('arn:aws:iam::222222222222:role/Old');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain('--assume-task-role is deprecated');
    expect(msg).toContain('--assume-role');
  });

  it('resolveEcsAssumeRoleOption: bare --assume-role (boolean true) wins, no warn', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const effective = resolveEcsAssumeRoleOption({ assumeRole: true });
    expect(effective).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolveEcsAssumeRoleOption: neither flag => undefined, no warn', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const effective = resolveEcsAssumeRoleOption({});
    expect(effective).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('Commander parse: --assume-role arn populates options.assumeRole on run-task', () => {
    const cmd = new Command();
    addRunTaskSpecificOptions(cmd);
    cmd.action(() => undefined);
    cmd.parse([
      'node',
      'cdkl',
      '--assume-role',
      'arn:aws:iam::111111111111:role/New',
    ]);
    const opts = cmd.opts() as { assumeRole?: string };
    expect(opts.assumeRole).toBe('arn:aws:iam::111111111111:role/New');
  });

  it('Commander parse: legacy --assume-task-role still works on run-task', () => {
    const cmd = new Command();
    addRunTaskSpecificOptions(cmd);
    cmd.action(() => undefined);
    cmd.parse([
      'node',
      'cdkl',
      '--assume-task-role',
      'arn:aws:iam::222222222222:role/Old',
    ]);
    const opts = cmd.opts() as { assumeTaskRole?: string };
    expect(opts.assumeTaskRole).toBe('arn:aws:iam::222222222222:role/Old');
  });
});

describe('issue #249 / C7 — `--ecr-role-arn` added to start-api', () => {
  it('addStartApiSpecificOptions registers --ecr-role-arn', () => {
    const longs = addStartApiSpecificOptions(new Command())
      .options.map((o) => o.long)
      .sort();
    expect(longs).toContain('--ecr-role-arn');
  });

  it('Commander parse: --ecr-role-arn arn populates options.ecrRoleArn', () => {
    const cmd = new Command();
    addStartApiSpecificOptions(cmd);
    cmd.action(() => undefined);
    cmd.parse([
      'node',
      'cdkl',
      '--ecr-role-arn',
      'arn:aws:iam::999999999999:role/EcrPuller',
    ]);
    const opts = cmd.opts() as { ecrRoleArn?: string };
    expect(opts.ecrRoleArn).toBe('arn:aws:iam::999999999999:role/EcrPuller');
  });
});

describe('issue #249 / C8 — `--no-build` parity across every command that builds images', () => {
  it.each([
    ['start-api', () => addStartApiSpecificOptions(new Command())],
    ['run-task', () => addRunTaskSpecificOptions(new Command())],
    ['ecs-service-emulator (start-service / start-alb common)', () =>
      addCommonEcsServiceOptions(new Command())],
  ])('--no-build is registered on %s', (_label, build) => {
    const cmd = build();
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--no-build');
  });

  it('Commander parse: --no-build flips options.build to false on run-task', () => {
    const cmd = new Command();
    addRunTaskSpecificOptions(cmd);
    cmd.action(() => undefined);
    cmd.parse(['node', 'cdkl', '--no-build']);
    const opts = cmd.opts() as { build?: boolean };
    expect(opts.build).toBe(false);
  });

  it('Commander parse: --no-build flips options.build to false on start-api', () => {
    const cmd = new Command();
    addStartApiSpecificOptions(cmd);
    cmd.action(() => undefined);
    cmd.parse(['node', 'cdkl', '--no-build']);
    const opts = cmd.opts() as { build?: boolean };
    expect(opts.build).toBe(false);
  });
});

describe('issue #249 / C9 — `--env-vars` help text mentions Parameters on every command', () => {
  it.each([
    ['invoke', () => addInvokeSpecificOptions(new Command())],
    ['invoke-agentcore', () => addInvokeAgentCoreSpecificOptions(new Command())],
    ['start-api', () => addStartApiSpecificOptions(new Command())],
    ['run-task', () => addRunTaskSpecificOptions(new Command())],
    ['ecs-service-emulator (start-service / start-alb)', () =>
      addCommonEcsServiceOptions(new Command())],
  ])('%s --env-vars description mentions Parameters', (_label, build) => {
    const cmd = build();
    const opt = optionByLong(cmd, '--env-vars');
    expect(opt).toBeDefined();
    expect(opt!.description).toContain('Parameters');
  });
});

describe('issue #249 / C10 — `--container-host` warns "must be a numeric IP" on every command', () => {
  it.each([
    ['invoke', () => addInvokeSpecificOptions(new Command())],
    ['invoke-agentcore', () => addInvokeAgentCoreSpecificOptions(new Command())],
    ['start-api', () => addStartApiSpecificOptions(new Command())],
    ['run-task', () => addRunTaskSpecificOptions(new Command())],
    ['ecs-service-emulator (start-service / start-alb)', () =>
      addCommonEcsServiceOptions(new Command())],
  ])('%s --container-host description names the numeric-IP requirement', (_label, build) => {
    const cmd = build();
    const opt = optionByLong(cmd, '--container-host');
    expect(opt).toBeDefined();
    // Match the shared phrase "numeric IP" so all four descriptions
    // assert the same safety contract.
    expect(opt!.description.toLowerCase()).toContain('numeric ip');
  });
});

describe('issue #249 / C11 — `--bearer-token` description spells out supplier vs default-when-missing', () => {
  it('invoke-agentcore --bearer-token names the SUPPLIER role + contrasts with start-alb', () => {
    const opt = optionByLong(
      addInvokeAgentCoreSpecificOptions(new Command()),
      '--bearer-token'
    );
    expect(opt).toBeDefined();
    expect(opt!.description.toLowerCase()).toContain('supplier');
    expect(opt!.description).toContain('start-alb');
  });

  it('start-alb --bearer-token names the DEFAULT-WHEN-MISSING role + contrasts with invoke-agentcore', () => {
    const opt = optionByLong(addAlbSpecificOptions(new Command()), '--bearer-token');
    expect(opt).toBeDefined();
    expect(opt!.description.toLowerCase()).toContain('default-when-missing');
    expect(opt!.description).toContain('invoke-agentcore');
  });
});

describe('issue #249 / C14 — `--debug-port` alias on start-api matches `cdkl invoke`', () => {
  it('addStartApiSpecificOptions registers BOTH --debug-port and --debug-port-base', () => {
    const longs = addStartApiSpecificOptions(new Command())
      .options.map((o) => o.long);
    expect(longs).toContain('--debug-port');
    expect(longs).toContain('--debug-port-base');
  });

  it('--debug-port description names it as an alias of --debug-port-base', () => {
    const opt = optionByLong(addStartApiSpecificOptions(new Command()), '--debug-port');
    expect(opt).toBeDefined();
    expect(opt!.description).toContain('--debug-port-base');
  });

  it('Commander parse: --debug-port 9000 populates options.debugPort', () => {
    const cmd = new Command();
    addStartApiSpecificOptions(cmd);
    cmd.action(() => undefined);
    cmd.parse(['node', 'cdkl', '--debug-port', '9000']);
    const opts = cmd.opts() as { debugPort?: string; debugPortBase?: string };
    expect(opts.debugPort).toBe('9000');
    expect(opts.debugPortBase).toBeUndefined();
  });

  it('Commander parse: --debug-port-base 9000 still populates options.debugPortBase (canonical)', () => {
    const cmd = new Command();
    addStartApiSpecificOptions(cmd);
    cmd.action(() => undefined);
    cmd.parse(['node', 'cdkl', '--debug-port-base', '9000']);
    const opts = cmd.opts() as { debugPort?: string; debugPortBase?: string };
    expect(opts.debugPortBase).toBe('9000');
    expect(opts.debugPort).toBeUndefined();
  });
});
