import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  createLocalStartAgentCoreCommand,
  addStartAgentCoreSpecificOptions,
  resolveAgentCoreServePlan,
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
      '--sigv4',
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
    // The single-shot invoke-only `--ws` flag must NOT leak onto the serve
    // command. (`--sigv4` IS a serve flag as of issue #454 — asserted above.)
    expect(flags).not.toContain('--ws');
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

describe('resolveAgentCoreServePlan', () => {
  it('serves HTTP / AGUI on 8080 (POST /invocations + GET /ping) with the /ws bridge and /ping readiness', () => {
    for (const protocol of [AGENTCORE_HTTP_PROTOCOL, AGENTCORE_AGUI_PROTOCOL]) {
      const plan = resolveAgentCoreServePlan(protocol);
      expect(plan.containerPort).toBeUndefined(); // default 8080
      expect(plan.containerPortLabel).toBe('8080');
      expect(plan.attachWs).toBe(true);
      // No explicit readiness path -> GET /ping wait.
      expect(plan.readyPath).toBeUndefined();
      expect(plan.routes).toEqual([
        { method: 'POST', path: '/invocations' },
        { method: 'GET', path: '/ping' },
      ]);
    }
  });

  it('serves MCP on 8000 (POST /mcp), no /ws, with HTTP-response readiness on /mcp', () => {
    const plan = resolveAgentCoreServePlan(AGENTCORE_MCP_PROTOCOL);
    expect(plan.containerPort).toBe(8000);
    expect(plan.containerPortLabel).toBe('8000/mcp');
    expect(plan.attachWs).toBe(false);
    expect(plan.readyPath).toBe('/mcp');
    expect(plan.routes).toEqual([{ method: 'POST', path: '/mcp' }]);
  });

  it('serves A2A on 9000 (POST /), no /ws, with HTTP-response readiness on /', () => {
    const plan = resolveAgentCoreServePlan(AGENTCORE_A2A_PROTOCOL);
    expect(plan.containerPort).toBe(9000);
    expect(plan.containerPortLabel).toBe('9000/');
    expect(plan.attachWs).toBe(false);
    expect(plan.readyPath).toBe('/');
    expect(plan.routes).toEqual([{ method: 'POST', path: '/' }]);
  });
});
