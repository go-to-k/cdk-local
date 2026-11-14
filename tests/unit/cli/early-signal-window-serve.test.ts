import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';

// go-to-k/cdk-local#973 (the serve-command sibling of #972): `start-api --warm`
// pre-warmed its pools, `start-alb` booted its Lambda targets (and the shared
// network's sidecar), and `start-cloudfront` booted its Function URL /
// Lambda@Edge origins, all before a SIGINT / SIGTERM handler that could see
// those containers existed. A signal in that window took the default action
// and left the containers running. These boot each command with every Docker /
// network seam mocked and fire the signal at the point under test.

const h = vi.hoisted(() => ({
  stacks: [] as unknown[],
  synth: undefined as undefined | (() => Promise<unknown>),
  run: undefined as undefined | ((opts: { name?: string }) => Promise<string>),
  removed: [] as string[],
  networks: [] as string[],
  destroyedNetworks: [] as string[],
  net: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock('../../../src/synthesis/synthesizer.js', async (importActual) => ({
  ...(await importActual<object>()),
  Synthesizer: class {
    synthesize(): Promise<unknown> {
      return h.synth ? h.synth() : Promise.resolve({ stacks: h.stacks });
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
vi.mock('../../../src/local/rie-client.js', async (importActual) => ({
  ...(await importActual<object>()),
  waitForRieReady: vi.fn(async () => undefined),
}));
vi.mock('../../../src/local/ecs-network.js', async (importActual) => ({
  ...(await importActual<object>()),
  createSharedSvcNetwork: vi.fn(() =>
    h.net
      ? h.net()
      : Promise.resolve({
          networkName: 'cdkl-svc-test',
          sidecarContainerId: 'sidecar',
          sidecarIp: '169.254.171.2',
          ownedByCaller: true,
        })
  ),
  destroyTaskNetwork: vi.fn(async (n: { networkName: string }) => {
    h.destroyedNetworks.push(n.networkName);
  }),
}));

const { createLocalStartApiCommand } = await import('../../../src/cli/commands/local-start-api.js');
const { createLocalStartAlbCommand } = await import('../../../src/cli/commands/local-start-alb.js');
const { createLocalStartCloudFrontCommand } = await import(
  '../../../src/cli/commands/local-start-cloudfront.js'
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

const ZIP = { ZipFile: 'exports.handler = async () => ({ statusCode: 200 });' };
const FN = {
  Type: 'AWS::Lambda::Function',
  Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler', Code: ZIP },
};

let outDir: string;
function stack(resources: Record<string, unknown>): unknown {
  return {
    stackName: 'App',
    displayName: 'App',
    artifactId: 'App',
    template: { Resources: resources },
    outputDir: outDir,
  };
}

/** A Function URL Lambda: one `start-api` server, one pooled Lambda. */
const apiStack = (): unknown =>
  stack({
    EchoFn: FN,
    EchoUrl: {
      Type: 'AWS::Lambda::Url',
      Properties: { TargetFunctionArn: { 'Fn::GetAtt': ['EchoFn', 'Arn'] }, AuthType: 'NONE' },
    },
  });

/** A Lambda-only ALB: no ECS service, one front-door Lambda target. */
const albStack = (): unknown =>
  stack({
    WebLB: {
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      Properties: { Type: 'application' },
    },
    WebTargetGroup: {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: { TargetType: 'lambda', Targets: [{ Id: { 'Fn::GetAtt': ['EchoFn', 'Arn'] } }] },
    },
    WebListener: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'WebLB' },
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'WebTargetGroup' } }],
      },
    },
    EchoFn: FN,
  });

/** A distribution whose only origin is a Lambda Function URL (no web function). */
const cloudFrontStack = (): unknown =>
  stack({
    Handler: FN,
    HandlerUrl: {
      Type: 'AWS::Lambda::Url',
      Properties: { TargetFunctionArn: { Ref: 'Handler' }, AuthType: 'NONE' },
    },
    Dist: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Origins: [
            {
              Id: 'lambda',
              DomainName: {
                'Fn::Select': [
                  2,
                  { 'Fn::Split': ['/', { 'Fn::GetAtt': ['HandlerUrl', 'FunctionUrl'] }] },
                ],
              },
              CustomOriginConfig: { OriginProtocolPolicy: 'https-only' },
            },
          ],
          DefaultCacheBehavior: { TargetOriginId: 'lambda' },
        },
      },
    },
  });

const synthesizer = {
  synthesize: () => (h.synth ? h.synth() : Promise.resolve({ stacks: h.stacks })),
} as never;

const COMMANDS = {
  'start-api --warm': {
    stack: apiStack,
    argv: ['--app', 'x', '--warm', '--port', '0', '--no-pull'],
    make: () => createLocalStartApiCommand(),
    namePattern: /^cdkl-EchoFn-\d+-\d+$/,
  },
  'start-alb': {
    stack: albStack,
    // `--lb-port` takes 1-65535: a port the OS just handed out and released.
    argv: ['App:WebLB', '--app', 'x', '--lb-port', '80=<free>', '--no-pull'],
    make: () => createLocalStartAlbCommand({ synthesizer }),
    namePattern: /^cdkl-alblambda-EchoFn-\d+-\d+$/,
  },
  'start-cloudfront': {
    stack: cloudFrontStack,
    argv: ['App:Dist', '--app', 'x', '--port', '0', '--no-pull'],
    make: () => createLocalStartCloudFrontCommand({ synthesizer }),
    namePattern: /^cdkl-alblambda-Handler-\d+-\d+$/,
  },
} as const;

describe('a stop signal while a serve command boots its containers (#973)', () => {
  let sigint: NodeJS.SignalsListener[];
  let sigterm: NodeJS.SignalsListener[];
  let exits: number[];
  let ran: string[];

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'cdkl-973-'));
    sigint = process.listeners('SIGINT');
    sigterm = process.listeners('SIGTERM');
    exits = [];
    ran = [];
    h.removed = [];
    h.destroyedNetworks = [];
    h.synth = undefined;
    h.net = undefined;
    h.run = async (opts) => {
      ran.push(opts.name ?? '<unnamed>');
      return 'cid';
    };
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void exits.push(c ?? 0)) as never);
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(() => undefined);
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) if (!sigint.includes(l)) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.off('SIGTERM', l);
    vi.restoreAllMocks();
    rmSync(outDir, { recursive: true, force: true });
  });

  const fresh = (sig: 'SIGINT' | 'SIGTERM'): NodeJS.SignalsListener[] =>
    process.listeners(sig).filter((l) => !(sig === 'SIGINT' ? sigint : sigterm).includes(l));
  const fire = (sig: 'SIGINT' | 'SIGTERM'): void => {
    const ls = fresh(sig);
    expect(ls.length, `a ${sig} listener is armed`).toBeGreaterThan(0);
    for (const l of ls) (l as (s: NodeJS.Signals) => void)(sig);
  };

  async function freePort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const { port } = srv.address() as { port: number };
    await new Promise((r) => srv.close(r));
    return port;
  }

  async function start(name: keyof typeof COMMANDS): Promise<void> {
    const c = COMMANDS[name];
    h.stacks = [c.stack()];
    const port = String(await freePort());
    const argv = c.argv.map((a) => a.replace('<free>', port));
    const cmd = c.make();
    cmd.exitOverride();
    void cmd.parseAsync(argv, { from: 'user' }).catch(() => undefined);
  }

  for (const name of Object.keys(COMMANDS) as (keyof typeof COMMANDS)[]) {
    describe(name, () => {
      it('a signal while `docker run` is in flight removes the container it returns, exit 143', async () => {
        const run = deferred<string>();
        h.run = (opts) => {
          ran.push(opts.name ?? '<unnamed>');
          return run.promise;
        };
        await start(name);
        await until(() => ran.length > 0);
        expect(ran[0]).toMatch(COMMANDS[name].namePattern);
        fire('SIGTERM');
        await new Promise((r) => setTimeout(r, 20));
        // The cleanup waits for the run instead of exiting with no id.
        expect(exits).toEqual([]);
        run.resolve('cid-late');
        await until(() => exits.length > 0);
        expect(h.removed).toContain('cid-late');
        await new Promise((r) => setTimeout(r, 50));
        // The boot does not go on to start anything after the signal, and its
        // refused run never races the signal's exit with an exit 1.
        expect(ran).toHaveLength(1);
        expect(exits).toEqual([143]);
      });

      it('a `docker run` that fails after the signal is removed by its name, exit 130', async () => {
        const run = deferred<string>();
        h.run = (opts) => {
          ran.push(opts.name ?? '<unnamed>');
          return run.promise;
        };
        await start(name);
        await until(() => ran.length > 0);
        fire('SIGINT');
        // A terminal ^C reaches the `docker` child too: it can die after the
        // daemon created the container but before the id was printed.
        run.reject(new Error('docker run failed: exit signal SIGINT'));
        await until(() => exits.length > 0);
        expect(h.removed).toContain(ran[0]);
        await new Promise((r) => setTimeout(r, 50));
        expect(exits).toEqual([130]);
      });
    });
  }

  it('start-api: a signal during synth exits 130 and starts no container', async () => {
    const synth = deferred<unknown>();
    let synthStarted = false;
    h.synth = () => {
      synthStarted = true;
      return synth.promise;
    };
    await start('start-api --warm');
    await until(() => synthStarted);
    fire('SIGINT');
    await until(() => exits.length > 0);
    expect(exits).toEqual([130]);
    // The boot carries on after the exit is requested (it is mocked here): it
    // must not build a pool and pre-warm it once the shutdown has looked.
    synth.resolve({ stacks: h.stacks });
    await new Promise((r) => setTimeout(r, 100));
    expect(ran).toEqual([]);
    expect(exits).toEqual([130]);
  });

  it('start-alb: a signal while the shared network is being created removes it, exit 130', async () => {
    const net = deferred<unknown>();
    let netStarted = false;
    h.net = () => {
      netStarted = true;
      return net.promise;
    };
    await start('start-alb');
    await until(() => netStarted);
    fire('SIGINT');
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([]);
    net.resolve({
      networkName: 'cdkl-svc-late',
      sidecarContainerId: 'sidecar',
      sidecarIp: '169.254.171.2',
      ownedByCaller: true,
    });
    await until(() => exits.length > 0);
    expect(h.destroyedNetworks).toEqual(['cdkl-svc-late']);
    await new Promise((r) => setTimeout(r, 50));
    expect(exits).toEqual([130]);
    expect(ran).toEqual([]);
  });
});
