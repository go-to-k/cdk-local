import { describe, it, expect } from 'vite-plus/test';
import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  regionOption,
} from '../../../src/cli/options.js';
import {
  addListSpecificOptions,
  createLocalListCommand,
} from '../../../src/cli/commands/local-list.js';
import {
  addRunTaskSpecificOptions,
  createLocalRunTaskCommand,
} from '../../../src/cli/commands/local-run-task.js';
import {
  addInvokeSpecificOptions,
  createLocalInvokeCommand,
} from '../../../src/cli/commands/local-invoke.js';
import {
  addInvokeAgentCoreSpecificOptions,
  createLocalInvokeAgentCoreCommand,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import {
  addStartApiSpecificOptions,
  createLocalStartApiCommand,
} from '../../../src/cli/commands/local-start-api.js';
import {
  addStudioSpecificOptions,
  createLocalStudioCommand,
} from '../../../src/cli/commands/local-studio.js';

/**
 * Return the sorted long-flag set for a Commander command. Mirrors the
 * helper in `tests/unit/local/start-alb-binding.test.ts` so a host CLI's
 * matching binding test stays a copy-paste away.
 */
function longFlagsOf(cmd: Command): string[] {
  return cmd.options
    .map((o) => o.long)
    .filter((l): l is string => typeof l === 'string')
    .sort();
}

/**
 * Long-flag set of the shared `commonOptions` / `appOptions` /
 * `contextOptions` / `regionOption` block every per-command
 * `create<Cmd>Command` factory composes around its `add<Cmd>SpecificOptions`
 * helper. Built fresh per call so the helpers' inner per-call freshness
 * (e.g. `commonOptions()` rebuilds with the active embed config) is
 * preserved.
 */
function commonAppContextRegionFlags(): string[] {
  const cmd = new Command();
  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(regionOption);
  return longFlagsOf(cmd);
}

/**
 * Drift guards for the `add<Cmd>SpecificOptions` extractions. The
 * decomposition exists so cdkd (and any other host CLI wrapping the same
 * factories) auto-inherits per-command flags without a duplicate
 * `.addOption(...)` block. These tests fail the moment someone adds a
 * command-specific flag inline in `create<Cmd>Command` instead of inside
 * the matching `add<Cmd>SpecificOptions` helper — which would silently
 * break the inheritance the helpers are supposed to guarantee.
 *
 * Mirrors the `start-alb` pattern in
 * `tests/unit/local/start-alb-binding.test.ts` (the "start-alb option
 * surface contract" describe block).
 */
describe('list option surface contract (addListSpecificOptions)', () => {
  it('addListSpecificOptions registers exactly the known list-only flags', () => {
    // Lock the helper's contract: cdkd imports it expecting THIS set of long
    // flags. Adding or removing one without updating the list below is a
    // semver-relevant surface change.
    const flags = longFlagsOf(addListSpecificOptions(new Command()));
    expect(flags).toEqual(['--long']);
  });

  it('createLocalListCommand surface equals common + list-specific (no inline drift)', () => {
    // The full CLI surface MUST be the union of the two helpers — never a
    // proper superset. A proper superset would mean someone added an option
    // inline in `createLocalListCommand`, which a host CLI (cdkd) calling
    // the helpers directly would silently miss.
    const full = longFlagsOf(createLocalListCommand());
    const expected = Array.from(
      new Set([
        ...commonAppContextRegionFlags(),
        ...longFlagsOf(addListSpecificOptions(new Command())),
      ])
    ).sort();
    expect(full).toEqual(expected);
  });
});

describe('run-task option surface contract (addRunTaskSpecificOptions)', () => {
  it('addRunTaskSpecificOptions registers exactly the known run-task-only flags', () => {
    const flags = longFlagsOf(addRunTaskSpecificOptions(new Command()));
    // Issue #249 / C6 — `--assume-role` is the non-breaking alias of
    // `--assume-task-role` so both forms are present.
    // Issue #249 / C8 — `--no-build` parity with `cdkl invoke`.
    expect(flags).toEqual([
      '--assume-role',
      '--assume-task-role',
      '--cluster',
      '--container-host',
      '--detach',
      '--ecr-role-arn',
      '--env-vars',
      '--from-cfn-stack',
      '--host-port',
      '--keep-running',
      '--no-build',
      '--no-pull',
      '--platform',
      '--stack-region',
    ]);
  });

  it('createLocalRunTaskCommand surface equals common + run-task-specific (no inline drift)', () => {
    const full = longFlagsOf(createLocalRunTaskCommand());
    const expected = Array.from(
      new Set([
        ...commonAppContextRegionFlags(),
        ...longFlagsOf(addRunTaskSpecificOptions(new Command())),
      ])
    ).sort();
    expect(full).toEqual(expected);
  });
});

describe('studio option surface contract (addStudioSpecificOptions)', () => {
  it('addStudioSpecificOptions registers exactly the known studio-only flags', () => {
    const flags = longFlagsOf(addStudioSpecificOptions(new Command()));
    expect(flags).toEqual(['--no-open', '--studio-port']);
  });

  it('createLocalStudioCommand surface equals common + studio-specific (no inline drift)', () => {
    const full = longFlagsOf(createLocalStudioCommand());
    const expected = Array.from(
      new Set([
        ...commonAppContextRegionFlags(),
        ...longFlagsOf(addStudioSpecificOptions(new Command())),
      ])
    ).sort();
    expect(full).toEqual(expected);
  });
});

describe('invoke option surface contract (addInvokeSpecificOptions)', () => {
  it('addInvokeSpecificOptions registers exactly the known invoke-only flags', () => {
    const flags = longFlagsOf(addInvokeSpecificOptions(new Command()));
    expect(flags).toEqual([
      '--assume-role',
      '--container-host',
      '--debug-port',
      '--ecr-role-arn',
      '--env-vars',
      '--event',
      '--event-stdin',
      '--from-cfn-stack',
      '--layer-role-arn',
      '--no-build',
      '--no-pull',
      '--stack-region',
    ]);
  });

  it('createLocalInvokeCommand surface equals common + invoke-specific (no inline drift)', () => {
    const full = longFlagsOf(createLocalInvokeCommand());
    const expected = Array.from(
      new Set([
        ...commonAppContextRegionFlags(),
        ...longFlagsOf(addInvokeSpecificOptions(new Command())),
      ])
    ).sort();
    expect(full).toEqual(expected);
  });
});

describe('invoke-agentcore option surface contract (addInvokeAgentCoreSpecificOptions)', () => {
  it('addInvokeAgentCoreSpecificOptions registers exactly the known invoke-agentcore-only flags', () => {
    const flags = longFlagsOf(addInvokeAgentCoreSpecificOptions(new Command()));
    expect(flags).toEqual([
      '--assume-role',
      '--bearer-token',
      '--container-host',
      '--ecr-role-arn',
      '--env-vars',
      '--event',
      '--event-stdin',
      '--from-cfn-stack',
      '--no-build',
      '--no-pull',
      '--no-verify-auth',
      '--platform',
      '--session-id',
      '--sigv4',
      '--stack-region',
      '--timeout',
      // Issue #255 — `--watch` mirrors the long-running session flag on
      // start-api / start-service / start-alb. Only meaningful on the
      // `/ws` paths; the single-shot HTTP / MCP / A2A invocations log a
      // WARN and proceed single-shot.
      '--watch',
      '--ws',
    ]);
  });

  it('createLocalInvokeAgentCoreCommand surface equals common + invoke-agentcore-specific (no inline drift)', () => {
    const full = longFlagsOf(createLocalInvokeAgentCoreCommand());
    const expected = Array.from(
      new Set([
        ...commonAppContextRegionFlags(),
        ...longFlagsOf(addInvokeAgentCoreSpecificOptions(new Command())),
      ])
    ).sort();
    expect(full).toEqual(expected);
  });
});

describe('start-api option surface contract (addStartApiSpecificOptions)', () => {
  it('addStartApiSpecificOptions registers exactly the known start-api-only flags', () => {
    const flags = longFlagsOf(addStartApiSpecificOptions(new Command()));
    // Issue #249 / C7 — `--ecr-role-arn` parity with `cdkl invoke`.
    // Issue #249 / C8 — `--no-build` parity with `cdkl invoke`.
    // Issue #249 / C14 — `--debug-port` alias matching `cdkl invoke`'s
    // flag name; `--debug-port-base` stays the canonical name.
    expect(flags).toEqual([
      '--all-stacks',
      '--api',
      '--assume-role',
      '--assume-role-auto',
      '--container-host',
      '--debug-port',
      '--debug-port-base',
      '--ecr-role-arn',
      '--env-vars',
      '--from-cfn-stack',
      '--host',
      '--layer-role-arn',
      '--mtls-cert',
      '--mtls-key',
      '--mtls-truststore',
      '--no-build',
      '--no-pull',
      '--per-lambda-concurrency',
      '--port',
      '--stack',
      '--stack-region',
      '--stage',
      '--strict-sigv4',
      '--warm',
      '--watch',
    ]);
  });

  it('createLocalStartApiCommand surface equals common + start-api-specific (no inline drift)', () => {
    const full = longFlagsOf(createLocalStartApiCommand());
    const expected = Array.from(
      new Set([
        ...commonAppContextRegionFlags(),
        ...longFlagsOf(addStartApiSpecificOptions(new Command())),
      ])
    ).sort();
    expect(full).toEqual(expected);
  });
});
