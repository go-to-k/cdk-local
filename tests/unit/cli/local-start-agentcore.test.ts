import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  createLocalStartAgentCoreCommand,
  addStartAgentCoreSpecificOptions,
  assertAgentCoreWsServable,
} from '../../../src/cli/commands/local-start-agentcore.js';
import { Command } from 'commander';
import { getEmbedConfig, setEmbedConfig } from '../../../src/local/embed-config.js';
import {
  AGENTCORE_HTTP_PROTOCOL,
  AGENTCORE_AGUI_PROTOCOL,
  AGENTCORE_MCP_PROTOCOL,
  AGENTCORE_A2A_PROTOCOL,
} from '../../../src/local/agentcore-resolver.js';

// Instantiating a command factory mutates the global embed config as a side
// effect; snapshot + restore so introspecting it here cannot wipe host branding.
const saved = getEmbedConfig();
afterEach(() => setEmbedConfig(saved));

describe('createLocalStartAgentCoreCommand', () => {
  it('builds a "start-agentcore" command with a [target] argument', () => {
    const cmd = createLocalStartAgentCoreCommand();
    expect(cmd.name()).toBe('start-agentcore');
    expect(cmd.description()).toMatch(/AgentCore/i);
    // [target] is optional (interactive picker in a TTY when omitted).
    expect(cmd.registeredArguments.map((a) => a.required)).toEqual([false]);
  });

  it('registers the bridge + boot flags via addStartAgentCoreSpecificOptions', () => {
    const cmd = new Command('start-agentcore');
    addStartAgentCoreSpecificOptions(cmd);
    const flags = cmd.options.map((o) => o.long);
    for (const f of [
      '--port',
      '--host',
      '--session-id',
      '--bearer-token',
      '--no-verify-auth',
      '--env-vars',
      '--platform',
      '--no-pull',
      '--no-build',
      '--container-host',
      '--timeout',
      '--assume-role',
      '--ecr-role-arn',
      '--from-cfn-stack',
      '--stack-region',
    ]) {
      expect(flags, `missing ${f}`).toContain(f);
    }
    // Invoke-only flags must NOT leak onto the serve command.
    expect(flags).not.toContain('--ws');
    expect(flags).not.toContain('--sigv4');
  });

  it('defaults --port to 0 and --host to 127.0.0.1', () => {
    const cmd = new Command('start-agentcore');
    addStartAgentCoreSpecificOptions(cmd);
    const port = cmd.options.find((o) => o.long === '--port');
    const host = cmd.options.find((o) => o.long === '--host');
    expect(port?.defaultValue).toBe(0);
    expect(host?.defaultValue).toBe('127.0.0.1');
  });

  it('defaults --timeout to 120000', () => {
    const cmd = new Command('start-agentcore');
    addStartAgentCoreSpecificOptions(cmd);
    const timeout = cmd.options.find((o) => o.long === '--timeout');
    expect(timeout?.defaultValue).toBe(120000);
  });

  it('--port parser rejects out-of-range values', () => {
    const cmd = new Command('start-agentcore').exitOverride();
    addStartAgentCoreSpecificOptions(cmd);
    cmd.action(() => {});
    expect(() => cmd.parse(['--port', '70000'], { from: 'user' })).toThrow(/0-65535/);
  });
});

describe('assertAgentCoreWsServable', () => {
  it('accepts HTTP and AGUI runtimes', () => {
    expect(() =>
      assertAgentCoreWsServable({ protocol: AGENTCORE_HTTP_PROTOCOL, logicalId: 'A' })
    ).not.toThrow();
    expect(() =>
      assertAgentCoreWsServable({ protocol: AGENTCORE_AGUI_PROTOCOL, logicalId: 'A' })
    ).not.toThrow();
  });

  it('rejects MCP and A2A runtimes with an actionable error', () => {
    expect(() =>
      assertAgentCoreWsServable({ protocol: AGENTCORE_MCP_PROTOCOL, logicalId: 'McpAgent' })
    ).toThrow(/McpAgent.*no \/ws|no \/ws.*McpAgent|MCP runtime/);
    expect(() =>
      assertAgentCoreWsServable({ protocol: AGENTCORE_A2A_PROTOCOL, logicalId: 'A2aAgent' })
    ).toThrow(/A2A/);
  });
});
