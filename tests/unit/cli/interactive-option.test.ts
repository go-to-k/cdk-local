import { describe, expect, it } from 'vite-plus/test';
import type { Command } from 'commander';
import { createLocalInvokeCommand } from '../../../src/cli/commands/local-invoke.js';
import { createLocalRunTaskCommand } from '../../../src/cli/commands/local-run-task.js';
import { createLocalStartServiceCommand } from '../../../src/cli/commands/local-start-service.js';
import { createLocalStartApiCommand } from '../../../src/cli/commands/local-start-api.js';
import { createLocalListCommand } from '../../../src/cli/commands/local-list.js';

function hasInteractive(cmd: Command): boolean {
  return cmd.options.some((o) => o.short === '-i' && o.long === '--interactive');
}

/** Commander marks a variadic / optional positional arg as not required. */
function requiredArgNames(cmd: Command): string[] {
  return (cmd as unknown as { registeredArguments: { name(): string; required: boolean }[] })
    .registeredArguments.filter((a) => a.required)
    .map((a) => a.name());
}

describe('-i/--interactive option', () => {
  it('is registered on the four run commands', () => {
    expect(hasInteractive(createLocalInvokeCommand())).toBe(true);
    expect(hasInteractive(createLocalRunTaskCommand())).toBe(true);
    expect(hasInteractive(createLocalStartServiceCommand())).toBe(true);
    expect(hasInteractive(createLocalStartApiCommand())).toBe(true);
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
