import { describe, expect, it } from 'vite-plus/test';
import type { Command } from 'commander';
import { createLocalInvokeCommand } from '../../../src/cli/commands/local-invoke.js';
import { createLocalRunTaskCommand } from '../../../src/cli/commands/local-run-task.js';
import { createLocalStartServiceCommand } from '../../../src/cli/commands/local-start-service.js';
import { createLocalStartApiCommand } from '../../../src/cli/commands/local-start-api.js';
import { createLocalListCommand } from '../../../src/cli/commands/local-list.js';

function hasInteractive(cmd: Command): boolean {
  return cmd.options.some((o) => o.short === '-i' || o.long === '--interactive');
}

/** Commander marks a variadic / optional positional arg as not required. */
function requiredArgNames(cmd: Command): string[] {
  return (cmd as unknown as { registeredArguments: { name(): string; required: boolean }[] })
    .registeredArguments.filter((a) => a.required)
    .map((a) => a.name());
}

/** Whether the (single) positional argument is variadic. */
function positionalIsVariadic(cmd: Command): boolean {
  const args = (cmd as unknown as { registeredArguments: { variadic: boolean }[] })
    .registeredArguments;
  return args.length > 0 && args.every((a) => a.variadic);
}

describe('-i/--interactive option is removed everywhere', () => {
  it('is NOT registered on any run command (bare-in-TTY opens the picker instead)', () => {
    expect(hasInteractive(createLocalInvokeCommand())).toBe(false);
    expect(hasInteractive(createLocalRunTaskCommand())).toBe(false);
    expect(hasInteractive(createLocalStartServiceCommand())).toBe(false);
    expect(hasInteractive(createLocalStartApiCommand())).toBe(false);
  });

  it('is NOT registered on `list` (which always lists everything)', () => {
    expect(hasInteractive(createLocalListCommand())).toBe(false);
  });
});

describe('target arguments are optional (so the picker can supply them)', () => {
  it('invoke / run-task / start-service / start-api have no required positional', () => {
    expect(requiredArgNames(createLocalInvokeCommand())).toEqual([]);
    expect(requiredArgNames(createLocalRunTaskCommand())).toEqual([]);
    expect(requiredArgNames(createLocalStartServiceCommand())).toEqual([]);
    expect(requiredArgNames(createLocalStartApiCommand())).toEqual([]);
  });
});

describe('start-api accepts a variadic target subset', () => {
  it('start-api positional is variadic ([targets...]) so a subset can be served', () => {
    expect(positionalIsVariadic(createLocalStartApiCommand())).toBe(true);
  });

  it('start-service positional is variadic ([targets...])', () => {
    expect(positionalIsVariadic(createLocalStartServiceCommand())).toBe(true);
  });

  it('invoke / run-task keep a single optional positional ([target])', () => {
    expect(positionalIsVariadic(createLocalInvokeCommand())).toBe(false);
    expect(positionalIsVariadic(createLocalRunTaskCommand())).toBe(false);
  });
});
