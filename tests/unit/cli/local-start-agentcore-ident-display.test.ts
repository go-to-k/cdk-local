import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdk-local#761 (S3): an assembly-chosen identifier renders bare when
// plain and as ONE JSON string literal when it could forge a boundary. Expected
// strings are hand-written, never computed through the display helper. The
// command boots to its ready banner here with every Docker / network seam mocked.

const state = vi.hoisted(() => ({
  stackName: 'App',
  logicalId: 'ChatAgent',
  protocol: 'HTTP',
  wsUrl: undefined as string | undefined,
}));

vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
  pickFreePort: vi.fn(async () => 40001),
  runDetached: vi.fn(async () => 'cid'),
  streamLogs: vi.fn(() => () => undefined),
  removeContainer: vi.fn(async () => undefined),
}));
vi.mock('../../../src/local/agentcore-client.js', async (importActual) => ({
  ...(await importActual<object>()),
  waitForAgentCorePing: vi.fn(async () => undefined),
  waitForAgentCoreHttpReady: vi.fn(async () => undefined),
}));
vi.mock('../../../src/local/agentcore-http-server.js', async (importActual) => ({
  ...(await importActual<object>()),
  startAgentCoreHttpServer: vi.fn(async () => ({
    httpUrl: 'http://127.0.0.1:5555',
    ...(state.wsUrl && { wsUrl: state.wsUrl }),
    close: async () => undefined,
    setContainerPort: () => undefined,
  })),
}));
vi.mock('../../../src/local/target-lister.js', async (importActual) => ({
  ...(await importActual<object>()),
  listTargets: vi.fn(() => ({ agentCoreRuntimes: [] })),
}));
vi.mock('../../../src/local/target-picker.js', async (importActual) => ({
  ...(await importActual<object>()),
  resolveSingleTarget: vi.fn(async (t: string) => t),
}));
vi.mock('../../../src/local/agentcore-resolver.js', async (importActual) => ({
  ...(await importActual<object>()),
  pickAgentCoreCandidateStack: vi.fn(() => undefined),
  resolveAgentCoreTarget: vi.fn(() => ({
    stack: { stackName: state.stackName },
    logicalId: state.logicalId,
    protocol: state.protocol,
    resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    environmentVariables: {},
  })),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importActual) => ({
  ...(await importActual<object>()),
  createLocalStateProvider: vi.fn(() => undefined),
  resolveCfnFallbackRegion: vi.fn(async () => 'us-east-1'),
}));
vi.mock('../../../src/cli/commands/local-invoke-agentcore.js', async (importActual) => ({
  ...(await importActual<object>()),
  resolveAgentCoreSigV4Context: vi.fn(async () => undefined),
  resolveFromS3BucketIntrinsic: vi.fn(async () => undefined),
  resolveAgentCoreImage: vi.fn(async () => 'img:1'),
  buildContainerEnv: vi.fn(async () => ({ env: {}, sensitiveEnvKeys: new Set<string>() })),
}));

import { setEmbedConfig, getEmbedConfig } from '../../../src/local/embed-config.js';
const { createLocalStartAgentCoreCommand } = await import(
  '../../../src/cli/commands/local-start-agentcore.js'
);

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

async function boot(): Promise<string[]> {
  const lines: string[] = [];
  const sink = (...a: unknown[]): void => {
    lines.push(
      a
        .map(String)
        .join(' ')
        .replace(ANSI, '')
        .replace(/^(WARN|ERROR): /, '')
    );
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation(sink);
  }
  const cmd = createLocalStartAgentCoreCommand({
    synthesizer: { synthesize: async () => ({ stacks: [] }) } as never,
  });
  // The command blocks until ^C by design; wait for its last banner line.
  void cmd.parseAsync(['target', '--app', 'x'], { from: 'user' });
  for (let i = 0; i < 200 && !lines.includes('Press ^C to shut down.'); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return lines;
}

describe('start-agentcore renders Target and the ready banner (#761)', () => {
  const saved = getEmbedConfig();
  let sigint: NodeJS.SignalsListener[];
  let sigterm: NodeJS.SignalsListener[];

  beforeEach(() => {
    sigint = process.listeners('SIGINT');
    sigterm = process.listeners('SIGTERM');
    state.stackName = 'App';
    state.logicalId = 'ChatAgent';
    state.protocol = 'HTTP';
    state.wsUrl = undefined;
  });
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) if (!sigint.includes(l)) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.off('SIGTERM', l);
    vi.restoreAllMocks();
    setEmbedConfig(saved);
  });

  it('prints plain Target and banner bare, leaving the URL untouched', async () => {
    state.protocol = 'MCP';
    const lines = await boot();
    expect(lines).toContain('Target: App/ChatAgent (MCP)');
    expect(lines).toContain('Server listening on http://127.0.0.1:5555  (ChatAgent)');
  });

  it('prints forging Target and banner as JSON literals', async () => {
    state.protocol = 'MCP';
    state.stackName = 'S\u001b[2Kx';
    state.logicalId = "Chat' Agent";
    const lines = await boot();
    expect(lines).toContain(`Target: "S [2Kx/Chat' Agent" (MCP)`);
    expect(lines).toContain(`Server listening on http://127.0.0.1:5555  ("Chat' Agent")`);
  });

  it('renders the WebSocket banner suffix, keeping the verbatim ws:// ready prefix', async () => {
    state.wsUrl = 'ws://127.0.0.1:5555/ws';
    state.logicalId = "A' b";
    const lines = await boot();
    expect(lines).toContain(
      `Server listening on ws://127.0.0.1:5555/ws  ("A' b" (AgentCore WebSocket))`
    );
  });
});
