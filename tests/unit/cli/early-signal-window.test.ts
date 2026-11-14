import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdk-local#972: `invoke` / `invoke-agentcore` / `start-agentcore`
// armed their SIGINT / SIGTERM handler only after `docker run` returned, so a
// signal during synth, the image step, or the `docker run` itself took the
// default action and left the container the daemon created behind. These boot
// each command with every Docker / network seam mocked and fire the signal at
// the point under test.

const h = vi.hoisted(() => ({
  synth: undefined as undefined | (() => Promise<unknown>),
  run: undefined as undefined | ((opts: { name?: string }) => Promise<string>),
  removed: [] as string[],
}));

vi.mock('../../../src/synthesis/synthesizer.js', async (importActual) => ({
  ...(await importActual<object>()),
  Synthesizer: class {
    synthesize(): Promise<unknown> {
      return h.synth ? h.synth() : Promise.resolve({ stacks: [] });
    }
  },
}));
vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
  pickFreePort: vi.fn(async () => 40001),
  pullImage: vi.fn(async () => undefined),
  runDetached: vi.fn((opts: { name?: string }) => h.run!(opts)),
  streamLogs: vi.fn(() => () => undefined),
  removeContainer: vi.fn(async (id: string) => {
    h.removed.push(id);
  }),
}));
vi.mock('../../../src/local/docker-version.js', async (importActual) => ({
  ...(await importActual<object>()),
  resolveHostGatewayExtraHosts: vi.fn(async () => []),
}));
vi.mock('../../../src/local/target-lister.js', async (importActual) => ({
  ...(await importActual<object>()),
  listTargets: vi.fn(() => ({ lambdas: [], agentCoreRuntimes: [] })),
}));
vi.mock('../../../src/local/target-picker.js', async (importActual) => ({
  ...(await importActual<object>()),
  resolveSingleTarget: vi.fn(async (t: string) => t),
}));
// A container Lambda with no cdk.out asset and an ECR URI: the image step is
// the (mocked) ECR pull, with no RIE wrap.
vi.mock('../../../src/local/lambda-resolver.js', async (importActual) => ({
  ...(await importActual<object>()),
  resolveLambdaTarget: vi.fn(() => ({
    logicalId: 'Fn',
    kind: 'image',
    architecture: 'x86_64',
    imageUri: '111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:latest',
    imageConfig: {},
    environment: {},
    layers: [],
    timeoutSec: 3,
    stack: { stackName: 'S', assetManifestPath: undefined, template: { Resources: {} } },
    resource: { Type: 'AWS::Lambda::Function', Properties: {} },
  })),
}));
vi.mock('../../../src/local/ecr-puller.js', async (importActual) => ({
  ...(await importActual<object>()),
  parseEcrUri: vi.fn(() => ({ accountId: '111122223333', region: 'us-east-1' })),
  pullEcrImage: vi.fn(async (uri: string) => uri),
}));
vi.mock('../../../src/local/rie-mount.js', () => ({ resolveRieWrap: vi.fn(async () => undefined) }));
vi.mock('../../../src/local/rie-client.js', async (importActual) => ({
  ...(await importActual<object>()),
  waitForRieReady: vi.fn(async () => undefined),
  invokeRie: vi.fn(async () => ({ raw: '{}' })),
}));
vi.mock('../../../src/local/agentcore-client.js', async (importActual) => ({
  ...(await importActual<object>()),
  waitForAgentCorePing: vi.fn(async () => undefined),
  waitForAgentCoreHttpReady: vi.fn(async () => undefined),
  invokeAgentCore: vi.fn(async () => ({ status: 200, body: '{}' })),
}));
vi.mock('../../../src/local/agentcore-http-server.js', async (importActual) => ({
  ...(await importActual<object>()),
  startAgentCoreHttpServer: vi.fn(async () => ({
    httpUrl: 'http://127.0.0.1:5555',
    close: async () => undefined,
    setContainerPort: () => undefined,
  })),
}));
vi.mock('../../../src/local/agentcore-resolver.js', async (importActual) => ({
  ...(await importActual<object>()),
  pickAgentCoreCandidateStack: vi.fn(() => undefined),
  resolveAgentCoreTarget: vi.fn(() => ({
    stack: { stackName: 'App' },
    logicalId: 'Agent',
    protocol: 'HTTP',
    // Not an ECR URI and no asset: the image step is the (mocked) plain pull.
    containerUri: 'public.ecr.aws/x/agent:1',
    resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    environmentVariables: {},
  })),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importActual) => ({
  ...(await importActual<object>()),
  createLocalStateProvider: vi.fn(() => undefined),
  resolveCfnFallbackRegion: vi.fn(async () => 'us-east-1'),
}));

const rieClient = await import('../../../src/local/rie-client.js');
const agentCoreClient = await import('../../../src/local/agentcore-client.js');
const agentCoreServer = await import('../../../src/local/agentcore-http-server.js');
const { createLocalInvokeCommand } = await import('../../../src/cli/commands/local-invoke.js');
const { createLocalInvokeAgentCoreCommand } = await import(
  '../../../src/cli/commands/local-invoke-agentcore.js'
);
const { createLocalStartAgentCoreCommand } = await import(
  '../../../src/cli/commands/local-start-agentcore.js'
);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

/** The step that USES the container once `docker run` returned it. */
const USES_CONTAINER = {
  invoke: () => vi.mocked(rieClient.invokeRie),
  'invoke-agentcore': () => vi.mocked(agentCoreClient.invokeAgentCore),
  'start-agentcore': () => vi.mocked(agentCoreServer.startAgentCoreHttpServer),
} as const;

const COMMANDS = {
  invoke: () => createLocalInvokeCommand(),
  'invoke-agentcore': () => createLocalInvokeAgentCoreCommand(),
  // start-agentcore takes a host synthesizer; route it to the same seam.
  'start-agentcore': () =>
    createLocalStartAgentCoreCommand({
      synthesizer: { synthesize: () => (h.synth ? h.synth() : Promise.resolve({ stacks: [] })) } as never,
    }),
} as const;

describe('a stop signal before the container id is known (#972)', () => {
  let sigint: NodeJS.SignalsListener[];
  let sigterm: NodeJS.SignalsListener[];
  let exits: number[];
  let ran: string[];

  beforeEach(() => {
    sigint = process.listeners('SIGINT');
    sigterm = process.listeners('SIGTERM');
    exits = [];
    ran = [];
    h.removed = [];
    h.synth = undefined;
    h.run = async (opts) => {
      ran.push(opts.name ?? '<unnamed>');
      return 'cid';
    };
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void exits.push(c ?? 0)) as never);
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(() => undefined);
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const use of Object.values(USES_CONTAINER)) use().mockClear();
  });
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) if (!sigint.includes(l)) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.off('SIGTERM', l);
    vi.restoreAllMocks();
  });

  const fresh = (sig: 'SIGINT' | 'SIGTERM'): NodeJS.SignalsListener[] =>
    process.listeners(sig).filter((l) => !(sig === 'SIGINT' ? sigint : sigterm).includes(l));
  const fire = (sig: 'SIGINT' | 'SIGTERM'): void => {
    const ls = fresh(sig);
    expect(ls.length, `a ${sig} listener is armed`).toBeGreaterThan(0);
    for (const l of ls) (l as (s: NodeJS.Signals) => void)(sig);
  };

  function start(name: keyof typeof COMMANDS): void {
    const cmd = COMMANDS[name]();
    cmd.exitOverride();
    void cmd.parseAsync(['Target', '--app', 'x'], { from: 'user' }).catch(() => undefined);
  }

  for (const name of Object.keys(COMMANDS) as (keyof typeof COMMANDS)[]) {
    describe(name, () => {
      it('a signal during synth exits 130 and starts no container', async () => {
        const synth = deferred<unknown>();
        let synthStarted = false;
        h.synth = () => {
          synthStarted = true;
          return synth.promise;
        };
        start(name);
        await until(() => synthStarted);
        fire('SIGINT');
        await until(() => exits.length > 0);
        expect(exits).toEqual([130]);
        // The boot carries on after the exit is requested (it is mocked here):
        // it must not start a container once the shutdown has looked.
        synth.resolve({ stacks: [] });
        await new Promise((r) => setTimeout(r, 50));
        expect(ran).toEqual([]);
      });

      it('a signal while `docker run` is in flight removes the container it returns, exit 143', async () => {
        const run = deferred<string>();
        h.run = (opts) => {
          ran.push(opts.name ?? '<unnamed>');
          return run.promise;
        };
        start(name);
        await until(() => ran.length > 0);
        fire('SIGTERM');
        await new Promise((r) => setTimeout(r, 20));
        // The cleanup waits for the run instead of exiting with no id.
        expect(exits).toEqual([]);
        run.resolve('cid-late');
        await until(() => exits.length > 0);
        expect(h.removed).toContain('cid-late');
        await new Promise((r) => setTimeout(r, 50));
        // The run resolved after the ^C: the command must not go on to use
        // the container (an invoke would run the handler after the ^C).
        expect(USES_CONTAINER[name]()).not.toHaveBeenCalled();
        // First: the refused run's own error exit (1) after it is only
        // reachable because `process.exit` is mocked.
        expect(exits[0]).toBe(143);
      });

      it('a `docker run` that fails after the signal is removed by its name', async () => {
        const run = deferred<string>();
        h.run = (opts) => {
          ran.push(opts.name ?? '<unnamed>');
          return run.promise;
        };
        start(name);
        await until(() => ran.length > 0);
        fire('SIGINT');
        // A terminal ^C reaches the `docker` child too: it can die after the
        // daemon created the container but before the id was printed.
        run.reject(new Error('docker run failed: exit signal SIGINT'));
        await until(() => exits.length > 0);
        expect(ran[0]).toMatch(/^cdkl-(invoke|agentcore)-\d+-[a-z0-9]+$/);
        expect(h.removed).toEqual([ran[0]]);
        // The signal's exit comes first; the failed run's own error exit (1)
        // after it is only reachable because `process.exit` is mocked.
        expect(exits[0]).toBe(130);
        if (name === 'start-agentcore') {
          // Its boot failure waits for the signal's exit instead of racing it.
          await new Promise((r) => setTimeout(r, 50));
          expect(exits).toEqual([130]);
        }
      });
    });
  }
});

describe('start-agentcore boot failure with no signal (#972)', () => {
  let sigint: NodeJS.SignalsListener[];
  let sigterm: NodeJS.SignalsListener[];
  beforeEach(() => {
    sigint = process.listeners('SIGINT');
    sigterm = process.listeners('SIGTERM');
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(() => undefined);
    }
  });
  afterEach(() => {
    h.synth = undefined;
    vi.restoreAllMocks();
  });

  it('removes its signal listeners, so an embedding host is left with none', async () => {
    h.synth = () => Promise.reject(new Error('synth failed'));
    const cmd = createLocalStartAgentCoreCommand({
      synthesizer: { synthesize: () => h.synth!() } as never,
    });
    cmd.exitOverride();
    const exits: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void exits.push(c ?? 0)) as never);
    await cmd.parseAsync(['Target', '--app', 'x'], { from: 'user' }).catch(() => undefined);
    expect(exits).toEqual([1]);
    expect(process.listeners('SIGINT')).toEqual(sigint);
    expect(process.listeners('SIGTERM')).toEqual(sigterm);
  });
});
