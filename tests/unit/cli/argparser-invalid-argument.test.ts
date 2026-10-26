import { afterEach, describe, expect, it } from 'vite-plus/test';
import { CommanderError, type Command } from 'commander';
import { createLocalStartAgentCoreCommand } from '../../../src/cli/commands/local-start-agentcore.js';
import { createLocalStartWebFunctionCommand } from '../../../src/cli/commands/local-start-web-function.js';
import { createLocalStartMicrovmCommand } from '../../../src/cli/commands/local-start-microvm.js';
import { createLocalInvokeAgentCoreCommand } from '../../../src/cli/commands/local-invoke-agentcore.js';
import { createLocalStartServiceCommand } from '../../../src/cli/commands/local-start-service.js';
import { createLocalStartApiCommand } from '../../../src/cli/commands/local-start-api.js';
import { getEmbedConfig, setEmbedConfig } from '../../../src/local/embed-config.js';

// Issue #819: an option `argParser` must throw commander's `InvalidArgumentError`,
// the only class commander turns into a formatted usage error. Anything else
// (cdk-local's own error class, a bare `Error`) escapes as a raw stack. Each case
// drives the REAL command factory, so the wiring is covered, not just the helper.

const saved = getEmbedConfig();
afterEach(() => setEmbedConfig(saved));

interface Outcome {
  error?: CommanderError;
  stderr: string;
  parsed: boolean;
}

function run(cmd: Command, argv: string[]): Outcome {
  let stderr = '';
  let parsed = false;
  cmd.exitOverride();
  cmd.configureOutput({
    writeErr: (s) => {
      stderr += s;
    },
    writeOut: () => undefined,
  });
  // Replace the real action: only the option parsing is under test.
  cmd.action(() => {
    parsed = true;
  });
  try {
    cmd.parse(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return { error: e, stderr, parsed };
    throw e;
  }
  return { stderr, parsed };
}

const cases: Array<{
  name: string;
  make: () => Command;
  argv: string[];
  usage: string;
  messageFragment: string;
  valid: string[];
}> = [
  {
    name: 'start-agentcore --port',
    make: () => createLocalStartAgentCoreCommand(),
    argv: ['--port', 'abc'],
    usage: "error: option '--port <n>' argument 'abc' is invalid.",
    messageFragment: '--port must be an integer 0-65535',
    valid: ['--port', '8080'],
  },
  {
    name: 'start-web-function --port',
    make: () => createLocalStartWebFunctionCommand(),
    argv: ['--port', 'abc'],
    usage: "error: option '--port <n>' argument 'abc' is invalid.",
    messageFragment: '--port must be an integer 0-65535',
    valid: ['--port', '8080'],
  },
  {
    name: 'start-microvm --port',
    make: () => createLocalStartMicrovmCommand(),
    argv: ['--port', 'abc'],
    usage: "error: option '--port <n>' argument 'abc' is invalid.",
    messageFragment: '--port must be an integer 0-65535',
    valid: ['--port', '8080'],
  },
  {
    name: 'start-microvm --count',
    make: () => createLocalStartMicrovmCommand(),
    argv: ['--count', '0'],
    usage: "error: option '--count <n>' argument '0' is invalid.",
    messageFragment: '--count must be an integer 1-64',
    valid: ['--count', '2'],
  },
  {
    name: 'start-microvm --proxy-port',
    make: () => createLocalStartMicrovmCommand(),
    argv: ['--proxy-port', '70000'],
    usage: "error: option '--proxy-port <port>' argument '70000' is invalid.",
    messageFragment: '--proxy-port must be an integer 1-65535',
    valid: ['--proxy-port', '9000'],
  },
  {
    name: 'start-agentcore --timeout',
    make: () => createLocalStartAgentCoreCommand(),
    argv: ['--timeout', '0'],
    usage: "argument '0' is invalid.",
    messageFragment: '--timeout must be a positive integer',
    valid: ['--timeout', '1000'],
  },
  {
    name: 'invoke-agentcore --timeout',
    make: () => createLocalInvokeAgentCoreCommand(),
    argv: ['--timeout', 'abc'],
    usage: "argument 'abc' is invalid.",
    messageFragment: '--timeout must be a positive integer',
    valid: ['--timeout', '1000'],
  },
  {
    name: 'start-service --max-tasks (not an integer)',
    make: () => createLocalStartServiceCommand(),
    argv: ['--max-tasks', 'abc'],
    usage: "argument 'abc' is invalid.",
    messageFragment: '--max-tasks must be a positive integer',
    valid: ['--max-tasks', '2'],
  },
  {
    name: 'start-service --max-tasks (over the subnet cap)',
    make: () => createLocalStartServiceCommand(),
    argv: ['--max-tasks', '999'],
    usage: "argument '999' is invalid.",
    messageFragment: 'exceeds the per-replica link-local /24 subnet allocator',
    valid: ['--max-tasks', '83'],
  },
  {
    name: 'start-service --restart-policy',
    make: () => createLocalStartServiceCommand(),
    argv: ['--restart-policy', 'sometimes'],
    usage: "argument 'sometimes' is invalid.",
    messageFragment: "--restart-policy must be one of 'on-failure', 'always', or 'none'",
    valid: ['--restart-policy', 'always'],
  },
  {
    name: 'start-service --shadow-ready-timeout',
    make: () => createLocalStartServiceCommand(),
    argv: ['--shadow-ready-timeout', '-1'],
    usage: "argument '-1' is invalid.",
    messageFragment: '--shadow-ready-timeout must be a positive integer',
    valid: ['--shadow-ready-timeout', '45000'],
  },
  {
    name: 'start-api --assume-role',
    make: () => createLocalStartApiCommand(),
    argv: ['--assume-role', 'not-an-arn'],
    usage: "argument 'not-an-arn' is invalid.",
    messageFragment: 'Invalid --assume-role value',
    valid: ['--assume-role', 'arn:aws:iam::123456789012:role/MyRole'],
  },
  {
    name: 'start-api --assume-role (bad logical ID)',
    make: () => createLocalStartApiCommand(),
    argv: ['--assume-role', 'my-fn=arn:aws:iam::123456789012:role/MyRole'],
    usage: 'is invalid.',
    messageFragment: 'must be a CloudFormation logical ID',
    valid: ['--assume-role', 'MyFn=arn:aws:iam::123456789012:role/MyRole'],
  },
  {
    name: 'start-api --assume-role (bad ARN in pair form)',
    make: () => createLocalStartApiCommand(),
    argv: ['--assume-role', 'MyFn=not-an-arn'],
    usage: 'is invalid.',
    messageFragment: 'must be an IAM role ARN',
    valid: ['--assume-role', 'MyFn=arn:aws:iam::123456789012:role/MyRole'],
  },
];

describe('option argParsers surface commander usage errors (#819)', () => {
  for (const c of cases) {
    it(`${c.name}: a bad value is a formatted commander.invalidArgument, not a raw throw`, () => {
      const out = run(c.make(), c.argv);
      expect(out.error).toBeInstanceOf(CommanderError);
      expect(out.error?.code).toBe('commander.invalidArgument');
      expect(out.error?.exitCode).toBe(1);
      expect(out.stderr).toContain(c.usage);
      expect(out.stderr).toContain(c.messageFragment);
      expect(out.stderr).not.toMatch(/\n\s+at /); // no stack frames
      expect(out.parsed).toBe(false);
    });

    it(`${c.name}: a valid value still parses`, () => {
      const out = run(c.make(), c.valid);
      expect(out.error).toBeUndefined();
      expect(out.parsed).toBe(true);
    });
  }

  it('prints commander\'s full line for the issue repro (--port abc)', () => {
    const out = run(createLocalStartAgentCoreCommand(), ['--port', 'abc']);
    expect(out.stderr).toBe(
      "error: option '--port <n>' argument 'abc' is invalid. --port must be an integer 0-65535, got 'abc'.\n"
    );
  });
});
