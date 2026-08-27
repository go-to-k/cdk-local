import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';
import {
  StudioEventBus,
  type StudioLogEvent,
  type StudioServeEvent,
  type StudioTargetKind,
} from '../../../src/local/studio-events.js';
import {
  classifyChildLine,
  createStudioServeManager,
  parsePublishedHostEndpoint,
  type StudioServeState,
} from '../../../src/local/studio-serve-manager.js';

/** A minimal stand-in for a long-running spawned serve child. */
function makeFakeChild(pid = 4242): EventEmitter & {
  stdout: EventEmitter & { setEncoding: () => void };
  stderr: EventEmitter & { setEncoding: () => void };
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
} {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(),
    pid,
    exitCode: null as number | null,
    signalCode: null as string | null,
  });
}

function collect(bus: StudioEventBus): { serves: StudioServeEvent[]; logs: StudioLogEvent[] } {
  const serves: StudioServeEvent[] = [];
  const logs: StudioLogEvent[] = [];
  bus.on('serve', (e) => serves.push(e));
  bus.on('log', (e) => logs.push(e));
  return { serves, logs };
}

const fixedClock = (): (() => number) => {
  let t = 1000;
  return () => (t += 10);
};

/**
 * A controllable timer pair: `setTimeoutFn` records callbacks instead of
 * scheduling them; `fireLast` / `fireAll` invoke them on demand so tests
 * can drive the ready-timeout + SIGKILL-escalation timers deterministically.
 */
function manualTimers(): {
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  fireLast: () => void;
  fireAll: () => void;
} {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  const setTimeoutFn = ((cb: () => void) => {
    const id = nextId++;
    pending.set(id, cb);
    return { __id: id, unref: () => undefined };
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((t: { __id?: number }) => {
    if (t && t.__id != null) pending.delete(t.__id);
  }) as unknown as typeof clearTimeout;
  const fireLast = (): void => {
    const ids = [...pending.keys()];
    const id = ids[ids.length - 1];
    if (id != null) {
      const cb = pending.get(id);
      pending.delete(id);
      cb?.();
    }
  };
  const fireAll = (): void => {
    for (const [id, cb] of [...pending]) {
      pending.delete(id);
      cb();
    }
  };
  return { setTimeoutFn, clearTimeoutFn, fireLast, fireAll };
}

/**
 * A fake capture-proxy factory: maps each HTTP upstream to a deterministic
 * distinct proxy URL (`:512xx` -> `:612xx`) without binding a real socket,
 * and records every `close` + `upstream` so tests can assert proxy
 * lifecycle. Injected so the serve manager's default real proxy never runs.
 */
function fakeProxies(): {
  factory: (config: { upstream: string }) => Promise<{
    url: string;
    port: number;
    close: ReturnType<typeof vi.fn>;
  }>;
  closes: Array<ReturnType<typeof vi.fn>>;
  upstreams: string[];
} {
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const upstreams: string[] = [];
  const factory = (config: { upstream: string }) => {
    upstreams.push(config.upstream);
    const u = new URL(config.upstream);
    const proxyPort = Number('6' + u.port.slice(1));
    const close = vi.fn(() => Promise.resolve());
    closes.push(close);
    return Promise.resolve({ url: `http://${u.hostname}:${proxyPort}`, port: proxyPort, close });
  };
  return { factory, closes, upstreams };
}

const LISTENING = 'Server listening on http://127.0.0.1:51234  (MyApi)\n';
/** The proxy URL `fakeProxies` maps the LISTENING upstream to. */
const PROXIED = 'http://127.0.0.1:61234';

describe('createStudioServeManager', () => {
  it('spawns `cdkl start-api <target> --port 0` and resolves running on the listening line', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      nodeBin: '/usr/bin/node',
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    const state = await p;

    const [bin, argv] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe('/usr/bin/node');
    expect(argv[0]).toBe('/path/to/cli.js');
    expect(argv.slice(1, 6)).toEqual(['start-api', 'MyApi', '--port', '0', '--host']);

    expect(state.status).toBe('running');
    // The endpoint handed to the UI is the CAPTURE PROXY, fronting the child.
    expect(state.endpoints).toEqual([PROXIED]);
    expect(fp.upstreams).toEqual(['http://127.0.0.1:51234']);
    expect(state.pid).toBe(4242);

    // serve events: starting then running.
    expect(serves.map((s) => s.status)).toEqual(['starting', 'running']);
    expect(serves[1].endpoints).toEqual([PROXIED]);
  });

  it('serves an HTTP/AGUI agentcore runtime: ws:// un-proxied + http:// contract proxied (issue #454)', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      nodeBin: '/usr/bin/node',
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyAgent', kind: 'agentcore-ws' });
    // start-agentcore prints BOTH lines for HTTP / AGUI: the ws:// listen line
    // (readiness + WebSocket-console endpoint) and the http:// contract line.
    child.stdout.emit(
      'data',
      'Server listening on ws://127.0.0.1:49160/ws  (MyAgent (AgentCore WebSocket))\n'
    );
    const state = await p;
    // The http:// contract endpoint arrives on a second line; let its async
    // proxy startup settle before asserting endpoints.
    child.stdout.emit(
      'data',
      'HTTP contract served on http://127.0.0.1:51234 — POST http://127.0.0.1:51234/invocations, GET http://127.0.0.1:51234/ping\n'
    );
    await new Promise((r) => setTimeout(r, 0));

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv.slice(1, 6)).toEqual(['start-agentcore', 'MyAgent', '--port', '0', '--host']);

    expect(state.status).toBe('running');
    // ws:// passes straight through (the capture-proxy gate is /^https?:/) so the
    // browser connects directly to the bridge; http:// is fronted by the capture
    // proxy so /invocations requests land on the timeline.
    const live = mgr.list().find((s) => s.targetId === 'MyAgent');
    expect(live?.endpoints).toEqual(['ws://127.0.0.1:49160/ws', PROXIED]);
    expect(fp.upstreams).toEqual(['http://127.0.0.1:51234']);
    expect(serves.map((s) => s.status)).toEqual(['starting', 'running', 'running']);
  });

  it('serves an MCP/A2A agentcore runtime: the http:// listen line is proxied, no ws:// (issue #454)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'McpAgent', kind: 'agentcore-ws' });
    // MCP / A2A have no /ws: the listen line is http:// (proxied), and the
    // protocol contract line (`MCP contract served on http://...<path>`) is NOT
    // an extra endpoint (it carries a path — the listen line is the base).
    child.stdout.emit('data', 'Server listening on http://127.0.0.1:51234  (McpAgent)\n');
    child.stdout.emit(
      'data',
      'MCP contract served on http://127.0.0.1:51234/mcp — POST http://127.0.0.1:51234/mcp\n'
    );
    const state = await p;
    await new Promise((r) => setTimeout(r, 0));

    expect(state.status).toBe('running');
    // Exactly one endpoint — the proxied http:// base. No ws://, no double-proxy
    // from the contract-path line.
    const live = mgr.list().find((s) => s.targetId === 'McpAgent');
    expect(live?.endpoints).toEqual([PROXIED]);
    expect(fp.upstreams).toEqual(['http://127.0.0.1:51234']);
  });

  it('spawns the serve child with CDKL_LOG_STREAM=stdout so its logs are single-stream (issue #403)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      nodeBin: '/usr/bin/node',
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;

    const opts = (spawnFn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2];
    // The serve child's warn/error are unified onto stdout so the studio LOG
    // panel does not race them across two OS pipes. The rest of the parent env
    // is preserved (PATH etc.) so the child still resolves node / docker.
    expect(opts.env['CDKL_LOG_STREAM']).toBe('stdout');
    expect(opts.env['PATH']).toBe(process.env['PATH']);
  });

  it('threads --from-cfn-stack <name> + --assume-role <arn> into the serve child argv', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
      fromCfnStack: 'MyStack',
      assumeRole: 'arn:aws:iam::123456789012:role/svc',
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const i = argv.indexOf('--from-cfn-stack');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('MyStack');
    const j = argv.indexOf('--assume-role');
    expect(j).toBeGreaterThan(-1);
    expect(argv[j + 1]).toBe('arn:aws:iam::123456789012:role/svc');
  });

  it('threads one --image-override <service>=<dockerfile> per backing service for an alb serve (issue #384)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({
      targetId: 'S/Alb',
      kind: 'alb',
      imageOverrides: { 'S:SvcA': '/app/a/Dockerfile', 'S:SvcB': '/app/b/Dockerfile' },
    });
    child.stdout.emit('data', 'ALB front-door: http://127.0.0.1:51234\n');
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const pairs = argv.reduce<string[]>((acc, a, idx) => {
      if (a === '--image-override') acc.push(argv[idx + 1]);
      return acc;
    }, []);
    expect(pairs).toContain('S:SvcA=/app/a/Dockerfile');
    expect(pairs).toContain('S:SvcB=/app/b/Dockerfile');
    expect(pairs).toHaveLength(2);
  });

  it('appends --watch to the serve child argv only when config.watch is set', async () => {
    const bus = new StudioEventBus();
    const fp = fakeProxies();

    // watch ON -> --watch appended.
    const childOn = makeFakeChild();
    const spawnOn = vi.fn(() => childOn as never);
    const mgrOn = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnOn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
      watch: true,
    });
    const pOn = mgrOn.start({ targetId: 'MyApi', kind: 'api' });
    childOn.stdout.emit('data', LISTENING);
    await pOn;
    expect((spawnOn.mock.calls[0] as unknown as [string, string[]])[1]).toContain('--watch');

    // watch OFF (default) -> no --watch.
    const childOff = makeFakeChild();
    const spawnOff = vi.fn(() => childOff as never);
    const mgrOff = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnOff as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });
    const pOff = mgrOff.start({ targetId: 'MyApi2', kind: 'api' });
    childOff.stdout.emit('data', LISTENING);
    await pOff;
    expect((spawnOff.mock.calls[0] as unknown as [string, string[]])[1]).not.toContain('--watch');
  });

  it('reflects a runtime watch toggle (mutated config) on the NEXT serve start', async () => {
    const bus = new StudioEventBus();
    const fp = fakeProxies();
    // Mutable config object the manager reads per start (mirrors the studio
    // childConfig that PATCH /api/config edits in place).
    const config: { cliEntry: string; bus: StudioEventBus; watch?: boolean } & Record<string, unknown> =
      {
        cliEntry: '/path/to/cli.js',
        bus,
        spawnFn: vi.fn(),
        clock: fixedClock(),
        proxyFactory: fp.factory,
      };
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(child1 as never).mockReturnValueOnce(child2 as never);
    config['spawnFn'] = spawnFn;
    const mgr = createStudioServeManager(config as never);

    const p1 = mgr.start({ targetId: 'A', kind: 'api' });
    child1.stdout.emit('data', LISTENING);
    await p1;
    expect((spawnFn.mock.calls[0] as unknown as [string, string[]])[1]).not.toContain('--watch');

    config.watch = true; // toggle on (as a PATCH /api/config would)
    const p2 = mgr.start({ targetId: 'B', kind: 'api' });
    child2.stdout.emit('data', LISTENING);
    await p2;
    expect((spawnFn.mock.calls[1] as unknown as [string, string[]])[1]).toContain('--watch');
  });

  it('forwards --app <assemblyDir> for a non-watch serve but --app <app> when watching (issue #324)', async () => {
    const bus = new StudioEventBus();
    const fp = fakeProxies();

    // Mutable config the manager reads per start: same object the studio
    // childConfig PATCH /api/config edits in place.
    const config: {
      cliEntry: string;
      bus: StudioEventBus;
      app?: string;
      assemblyDir?: string;
      watch?: boolean;
    } & Record<string, unknown> = {
      cliEntry: '/path/to/cli.js',
      bus,
      app: 'node app.ts',
      assemblyDir: '/abs/cdk.out',
      clock: fixedClock(),
      proxyFactory: fp.factory,
    };
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce(child1 as never)
      .mockReturnValueOnce(child2 as never);
    config['spawnFn'] = spawnFn;
    const mgr = createStudioServeManager(config as never);

    // Non-watch (default): reuse the boot-synthesized assembly dir.
    const p1 = mgr.start({ targetId: 'A', kind: 'api' });
    child1.stdout.emit('data', LISTENING);
    await p1;
    const argv1 = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const i1 = argv1.indexOf('--app');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(argv1[i1 + 1]).toBe('/abs/cdk.out');

    // Watch ON: keep the app command so the serve re-synths on change.
    config.watch = true;
    const p2 = mgr.start({ targetId: 'B', kind: 'api' });
    child2.stdout.emit('data', LISTENING);
    await p2;
    const argv2 = (spawnFn.mock.calls[1] as unknown as [string, string[]])[1];
    const i2 = argv2.indexOf('--app');
    expect(i2).toBeGreaterThanOrEqual(0);
    expect(argv2[i2 + 1]).toBe('node app.ts');
  });

  it('threads per-run options (boolean + repeat-pair) into the serve child argv', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({
      targetId: 'MyAlb',
      kind: 'alb',
      options: { '--tls': true, '--lb-port': [{ left: '443', right: '8443' }] },
    });
    child.stdout.emit('data', 'ALB front-door: http://127.0.0.1:51234\n');
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv).toContain('--tls');
    const i = argv.indexOf('--lb-port');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('443=8443');
  });

  it('surfaces a hostUrl for an ecs serve published via --host-port (issue #322)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({
      targetId: 'Stack/MyService',
      kind: 'ecs',
      options: { '--host-port': [{ left: '80', right: '8080' }] },
    });
    child.stdout.emit('data', 'Service(s) running:\n');
    await p;

    // ecs has no capture-proxy endpoint, but the published host port is the
    // composer's reachable target.
    expect(mgr.list()[0].endpoints).toEqual([]);
    expect(mgr.list()[0].hostUrl).toBe('http://127.0.0.1:8080');
  });

  it('does not set hostUrl for an ecs serve without --host-port', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: '/p/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });
    const p = mgr.start({ targetId: 'Stack/MyService', kind: 'ecs' });
    child.stdout.emit('data', 'Service(s) running:\n');
    await p;
    expect(mgr.list()[0].hostUrl).toBeUndefined();
  });

  it('spawns `cdkl run-task <taskdef>` and resolves running on the Task running banner (issue #366)', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: '/p/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });
    const p = mgr.start({ targetId: 'Stack/MyTask', kind: 'ecs-task' });
    // run-task's onReady banner is the ready marker (a streaming run has no
    // listening-port line).
    child.stdout.emit(
      'data',
      'Task running (family=cdkl-fixture-task); streaming container logs. Stop with Ctrl-C.\n'
    );
    const state = await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv.slice(1, 3)).toEqual(['run-task', 'Stack/MyTask']);
    expect(state.status).toBe('running');
    // Pure compute — no host endpoint, no capture proxy.
    expect(state.endpoints).toEqual([]);
    expect(fp.upstreams).toEqual([]);
    expect(serves.map((s) => s.status)).toEqual(['starting', 'running']);
  });

  it('spawns `cdkl start-cloudfront <dist> --port 0` and resolves running on its banner (issue #367)', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: '/p/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });
    const p = mgr.start({
      targetId: 'Stack/SiteDist',
      kind: 'cloudfront',
      options: { '--tls': true, '--origin': [{ left: 'O1', right: './dist' }] },
    });
    child.stdout.emit('data', 'CloudFront distribution serving on http://127.0.0.1:51234  (SiteDist)\n');
    const state = await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv.slice(1, 6)).toEqual(['start-cloudfront', 'Stack/SiteDist', '--port', '0', '--host']);
    expect(argv).toContain('--tls');
    const oi = argv.indexOf('--origin');
    expect(oi).toBeGreaterThan(-1);
    expect(argv[oi + 1]).toBe('O1=./dist');
    // It exposes a host HTTP endpoint, so it is fronted by a capture proxy.
    expect(state.status).toBe('running');
    expect(state.endpoints).toEqual([PROXIED]);
    expect(fp.upstreams).toEqual(['http://127.0.0.1:51234']);
    expect(serves.map((s) => s.status)).toEqual(['starting', 'running']);
  });

  it('DOES forward --from-cfn-stack / --assume-role to a cloudfront serve (issue #380)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: '/p/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
      // Session bindings set — start-cloudfront declares both flags as of #380
      // (a Function URL origin Lambda gets `cdkl invoke`-parity env / state /
      // role), so they MUST reach the child.
      fromCfnStack: 'MyStack',
      assumeRole: 'arn:aws:iam::123456789012:role/app',
    });
    const p = mgr.start({ targetId: 'Stack/SiteDist', kind: 'cloudfront' });
    child.stdout.emit('data', 'CloudFront distribution serving on http://127.0.0.1:51234  (SiteDist)\n');
    await p;
    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const fi = argv.indexOf('--from-cfn-stack');
    expect(fi).toBeGreaterThan(-1);
    expect(argv[fi + 1]).toBe('MyStack');
    const ai = argv.indexOf('--assume-role');
    expect(ai).toBeGreaterThan(-1);
    expect(argv[ai + 1]).toBe('arn:aws:iam::123456789012:role/app');
  });

  it('DOES forward --from-cfn-stack to an api serve (issue #367)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: '/p/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
      fromCfnStack: 'MyStack',
    });
    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;
    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv).toContain('--from-cfn-stack');
  });

  it('threads imageOverride as an explicit --image-override <target>=<dockerfile>', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({
      targetId: 'Stack/MyService',
      kind: 'ecs',
      imageOverride: './Dockerfile.local',
    });
    child.stdout.emit('data', 'Service(s) running:\n');
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const i = argv.indexOf('--image-override');
    expect(i).toBeGreaterThan(-1);
    // Explicit form keyed by the SAME target id passed as the start-service
    // target arg (the bare picker form would be skipped non-interactively).
    expect(argv[i + 1]).toBe('Stack/MyService=./Dockerfile.local');
  });

  it('threads imageOverride for an ecs-task run-task too (issue #388)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({
      targetId: 'Stack/MyTask',
      kind: 'ecs-task',
      imageOverride: './Dockerfile.local',
    });
    child.stdout.emit('data', 'Task running (family=fam)\n');
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    // The ecs-task kind spawns run-task, and the override threads kind-agnostically.
    expect(argv).toContain('run-task');
    const i = argv.indexOf('--image-override');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('Stack/MyTask=./Dockerfile.local');
  });

  it('materializes --env-vars into a SAM-shape temp file and removes it on stop (issue #355)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({
      targetId: 'Stack/MyService',
      kind: 'ecs',
      options: {
        '--env-vars': [
          { left: 'STAGE', right: 'local' },
          { left: 'DEBUG', right: '1' },
        ],
      },
    });
    child.stdout.emit('data', 'Service(s) running:\n');
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const ei = argv.indexOf('--env-vars');
    expect(ei).toBeGreaterThan(-1);
    const envFile = argv[ei + 1];
    expect(existsSync(envFile)).toBe(true);
    expect(JSON.parse(readFileSync(envFile, 'utf8'))).toEqual({
      Parameters: { STAGE: 'local', DEBUG: '1' },
    });

    // Stop tears the serve down -> the env temp dir is removed (no leak). The
    // fake child must emit `close` so stopChild's grace wait resolves.
    const stopP = mgr.stop({ targetId: 'Stack/MyService' });
    child.emit('close', 0, null);
    await stopP;
    expect(existsSync(envFile)).toBe(false);
  });

  it('passes NO --env-vars when the ecs serve has no env values', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: '/p/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });
    const p = mgr.start({ targetId: 'Stack/MyService', kind: 'ecs', options: { '--max-tasks': '2' } });
    child.stdout.emit('data', 'Service(s) running:\n');
    await p;
    expect((spawnFn.mock.calls[0] as unknown as [string, string[]])[1]).not.toContain('--env-vars');
  });

  it('omits --image-override when imageOverride is blank', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'Stack/MyService', kind: 'ecs', imageOverride: '   ' });
    child.stdout.emit('data', 'Service(s) running:\n');
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv).not.toContain('--image-override');
  });

  it('tokenizes raw extra args and appends them to the spawned serve argv', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({
      targetId: 'MyApi',
      kind: 'api',
      rawArgs: '--warm --container-host "my host"',
    });
    child.stdout.emit('data', 'Server listening on http://127.0.0.1:51999\n');
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv).toContain('--warm');
    const i = argv.indexOf('--container-host');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('my host');
  });

  it('builds the auto-rendered "All options" catalog controls into the serve argv', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: '/path/to/cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({
      targetId: 'Stack/SiteDist',
      kind: 'cloudfront',
      catalogArgs: { '--no-pull': true, '--stack-region': 'us-west-2' },
    });
    child.stdout.emit('data', 'CloudFront distribution serving on http://127.0.0.1:51999\n');
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv).toContain('--no-pull');
    const i = argv.indexOf('--stack-region');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('us-west-2');
  });

  it('streams child stdout AND stderr lines onto the bus as log events keyed by the target', async () => {
    const bus = new StudioEventBus();
    const { logs } = collect(bus);
    const child = makeFakeChild();
    const fp = fakeProxies();

    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stderr.emit('data', 'warming container\n');
    child.stdout.emit('data', LISTENING);
    await p;
    child.stdout.emit('data', 'GET /health 200\n');

    const lines = logs.map((l) => l.line);
    expect(lines).toContain('warming container');
    expect(lines).toContain('GET /health 200');
    // The listening line itself is also surfaced as a log line.
    expect(lines.some((l) => l.startsWith('Server listening on'))).toBe(true);
    expect(logs.every((l) => l.containerId === 'MyApi' && l.target === 'MyApi')).toBe(true);
  });

  it('rejects a non-serve kind without spawning', async () => {
    const bus = new StudioEventBus();
    const spawnFn = vi.fn();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
    });

    // `agentcore` is not a serve kind (it is a single-shot invoke target).
    await expect(mgr.start({ targetId: 'MyAgent', kind: 'agentcore' })).rejects.toThrow(
      /not supported/i
    );
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns the right headless command per serve kind (api / alb / ecs)', async () => {
    const cases: Array<{ kind: 'api' | 'alb' | 'ecs'; command: string; hasPort: boolean }> = [
      { kind: 'api', command: 'start-api', hasPort: true },
      { kind: 'alb', command: 'start-alb', hasPort: false },
      { kind: 'ecs', command: 'start-service', hasPort: false },
    ];
    for (const c of cases) {
      const bus = new StudioEventBus();
      const child = makeFakeChild();
      const spawnFn = vi.fn(() => child as never);
      const fp = fakeProxies();
      const mgr = createStudioServeManager({
        cliEntry: 'cli.js',
        bus,
        spawnFn: spawnFn as never,
        proxyFactory: fp.factory,
      });
      const p = mgr.start({ targetId: 'T', kind: c.kind });
      // Emit the kind's ready line (alb / ecs differ from api).
      const readyLine =
        c.kind === 'api'
          ? LISTENING
          : c.kind === 'alb'
            ? 'ALB front-door: http://127.0.0.1:8080 (listener port 8080)\n'
            : 'Service(s) running: MyService (1 replica).\n';
      child.stdout.emit('data', readyLine);
      await p;
      const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
      expect(argv[1]).toBe(c.command);
      expect(argv.includes('--port')).toBe(c.hasPort);
    }
  });

  it('an alb serve fronts the front-door URL with a capture proxy', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyAlb', kind: 'alb' });
    child.stdout.emit('data', 'ALB front-door: http://127.0.0.1:51234 (listener port 8080)\n');
    const state = await p;

    expect(state.status).toBe('running');
    expect(state.endpoints).toEqual([PROXIED]);
    expect(fp.upstreams).toEqual(['http://127.0.0.1:51234']);
  });

  it('defaults the stop grace to 45s so an ECS teardown is not SIGKILLed early', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const fp = fakeProxies();
    const delays: number[] = [];
    const setTimeoutFn = ((cb: () => void, ms: number) => {
      delays.push(ms);
      return { unref: () => undefined };
    }) as unknown as typeof setTimeout;
    const clearTimeoutFn = (() => undefined) as unknown as typeof clearTimeout;
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
      setTimeoutFn,
      clearTimeoutFn,
    });

    const p = mgr.start({ targetId: 'A', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;
    const stopP = mgr.stop({ targetId: 'A' });
    child.emit('close', 0);
    await stopP;

    // The SIGTERM->SIGKILL grace timer was scheduled at the 45s default.
    expect(delays).toContain(45_000);
  });

  it('an ecs service serve has NO endpoint and NO capture proxy (pure compute)', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MySvc', kind: 'ecs' });
    child.stdout.emit('data', 'Service(s) running: MySvc (1 replica).\n');
    const state = await p;

    expect(state.status).toBe('running');
    expect(state.endpoints).toEqual([]); // no host port to capture
    expect(fp.upstreams).toEqual([]); // no proxy created
    expect(serves.map((s) => s.status)).toEqual(['starting', 'running']);
  });

  it('rejects starting a target that is already running', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;

    await expect(mgr.start({ targetId: 'MyApi', kind: 'api' })).rejects.toThrow(/already running/i);
  });

  it('rejects + emits error when the child exits before ever listening', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.emit('close', 1);

    await expect(p).rejects.toThrow(/exited before listening/i);
    expect(serves.map((s) => s.status)).toEqual(['starting', 'error']);
    // A failed boot is not tracked as running.
    expect(mgr.list()).toEqual([]);
  });

  it('rejects when spawn throws synchronously', async () => {
    const bus = new StudioEventBus();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => {
        throw new Error('ENOENT: node not found');
      }) as never,
    });

    await expect(mgr.start({ targetId: 'MyApi', kind: 'api' })).rejects.toThrow(/ENOENT/);
    expect(mgr.list()).toEqual([]);
  });

  it('rejects when the child emits an error event before ready', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.emit('error', new Error('spawn EACCES'));
    await expect(p).rejects.toThrow(/EACCES/);
  });

  it('gracefully stops (SIGTERM->SIGKILL) the child + rejects on the ready timeout', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const { setTimeoutFn, clearTimeoutFn, fireLast, fireAll } = manualTimers();

    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      readyTimeoutMs: 5,
      setTimeoutFn,
      clearTimeoutFn,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    fireLast(); // fire the ready-timeout timer
    await expect(p).rejects.toThrow(/did not start/i);
    // The timeout must SIGTERM (graceful) first — NOT an immediate SIGKILL,
    // so start-api can tear down its RIE containers (#3).
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    fireAll(); // fire the SIGKILL-escalation grace timer
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(serves.some((s) => s.status === 'error')).toBe(true);
  });

  it('reports a crash WHILE running (close not via stop) as stopped + evicts it + closes the proxy', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;
    child.emit('close', 1); // the server process crashed on its own

    expect(serves.at(-1)?.status).toBe('stopped');
    expect(serves.at(-1)?.message).toMatch(/exited/i);
    expect(mgr.list()).toEqual([]);
    // The capture proxy must be torn down when the serve crashes. One
    // microtask, because the entry now holds the PENDING proxy promise (so a
    // repeated ready line can join a startup already in flight instead of
    // beginning a second one) and teardown awaits it before closing.
    await new Promise((r) => setTimeout(r, 0));
    expect(fp.closes[0]).toHaveBeenCalled();
  });

  it('marks a post-ready child error as errored + evicts it', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;
    child.emit('error', new Error('post-ready boom'));

    expect(serves.at(-1)?.status).toBe('error');
    expect(serves.at(-1)?.message).toContain('post-ready boom');
    expect(mgr.list()).toEqual([]);
  });

  it('stopping a still-STARTING serve is a clean stop, not a boot failure (#1)', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const { setTimeoutFn, clearTimeoutFn } = manualTimers();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      setTimeoutFn,
      clearTimeoutFn,
    });

    // Start but never emit a listening line — the serve stays `starting`.
    const startP = mgr.start({ targetId: 'MyApi', kind: 'api' });
    const stopP = mgr.stop({ targetId: 'MyApi' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0); // child exits in response to the stop's SIGTERM

    await expect(startP).rejects.toThrow(/stopped before it finished starting/i);
    await stopP;

    // Exactly starting -> stopped; NO `error` event for a user-initiated stop.
    expect(serves.map((s) => s.status)).toEqual(['starting', 'stopped']);
  });

  it('proxies an HTTP endpoint but passes a ws:// endpoint through, re-emitting running', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;
    child.stdout.emit('data', 'Server listening on ws://127.0.0.1:51235/ws  (MyWs)\n');
    // The ws path has no await, but yield once so the async onListening runs.
    await Promise.resolve();

    const running = serves.filter((s) => s.status === 'running');
    expect(running).toHaveLength(2);
    // The HTTP endpoint is fronted by the proxy; the ws:// endpoint passes
    // through unproxied (an http capture proxy can't front a raw ws listener).
    expect(running[1].endpoints).toEqual([PROXIED, 'ws://127.0.0.1:51235/ws']);
    expect(fp.upstreams).toEqual(['http://127.0.0.1:51234']);
    expect(mgr.list()[0].endpoints).toHaveLength(2);
  });

  it('stop() closes the proxy, SIGTERMs the child, emits stopped, and drops it from the running list', async () => {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;
    expect(mgr.list().map((s) => s.targetId)).toEqual(['MyApi']);

    const stopP = mgr.stop({ targetId: 'MyApi' });
    child.emit('close', 0); // child exits in response to SIGTERM
    await stopP;

    expect(fp.closes[0]).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mgr.list()).toEqual([]);
    expect(serves.at(-1)?.status).toBe('stopped');
  });

  it('captureRequests:false hands the child URL through unproxied', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
      captureRequests: false,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    const state = await p;

    expect(state.endpoints).toEqual(['http://127.0.0.1:51234']);
    expect(fp.upstreams).toEqual([]); // no proxy created
  });

  it('falls back to the direct child URL when the proxy fails to bind', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const failingFactory = (): Promise<never> => Promise.reject(new Error('EADDRINUSE'));
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: failingFactory as never,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    const state = await p;

    // The serve is still usable on the child URL, just uncaptured.
    expect(state.status).toBe('running');
    expect(state.endpoints).toEqual(['http://127.0.0.1:51234']);
  });

  it('stop() escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const fp = fakeProxies();
    const { setTimeoutFn, clearTimeoutFn, fireAll } = manualTimers();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      proxyFactory: fp.factory,
      setTimeoutFn,
      clearTimeoutFn,
    });

    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    child.stdout.emit('data', LISTENING);
    await p;

    const stopP = mgr.stop({ targetId: 'MyApi' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    fireAll(); // child ignored SIGTERM -> the grace timer escalates
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null); // finally dies from the SIGKILL
    await stopP;
    expect(mgr.list()).toEqual([]);
  });

  it('stop() rejects for a target that is not running', async () => {
    const bus = new StudioEventBus();
    const mgr = createStudioServeManager({ cliEntry: 'cli.js', bus, spawnFn: (() => makeFakeChild()) as never });
    await expect(mgr.stop({ targetId: 'Nope' })).rejects.toThrow(/not running/i);
  });

  it('stopAll() stops every running serve', async () => {
    const bus = new StudioEventBus();
    const children = [makeFakeChild(1), makeFakeChild(2)];
    const fp = fakeProxies();
    let i = 0;
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => children[i++]) as never,
      proxyFactory: fp.factory,
    });

    const p1 = mgr.start({ targetId: 'ApiA', kind: 'api' });
    children[0].stdout.emit('data', LISTENING);
    await p1;
    const p2 = mgr.start({ targetId: 'ApiB', kind: 'api' });
    children[1].stdout.emit('data', LISTENING);
    await p2;
    expect(mgr.list()).toHaveLength(2);

    const allP = mgr.stopAll();
    children[0].emit('close', 0);
    children[1].emit('close', 0);
    await allP;

    expect(mgr.list()).toEqual([]);
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
  });

  // Issue #392 — an ecs serve auto-publishes its replica host port; studio
  // surfaces it as hostUrl so the request composer fires.
  const ECS_READY = 'Service(s) running: 1 replica.\n';
  const PUBLISH_LINE =
    "Container 'web' container port 80 published on 127.0.0.1:54321. Reach it at 127.0.0.1:54321.\n";

  it('sets hostUrl from an auto-published port that arrives before the ready line (#392)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'Stack/Svc', kind: 'ecs' });
    child.stdout.emit('data', PUBLISH_LINE);
    child.stdout.emit('data', ECS_READY);
    const state = await p;
    expect(state.hostUrl).toBe('http://127.0.0.1:54321');
  });

  it('sets hostUrl + re-emits when the published port arrives AFTER running (#392)', async () => {
    const bus = new StudioEventBus();
    const evs = collect(bus);
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({ targetId: 'Stack/Svc', kind: 'ecs' });
    child.stdout.emit('data', ECS_READY);
    const state = await p;
    expect(state.hostUrl).toBeUndefined(); // not known yet at ready time
    // The publish line lands later -> hostUrl is set + a fresh serve event fires.
    child.stdout.emit('data', PUBLISH_LINE);
    const last = evs.serves.at(-1);
    expect(last?.status).toBe('running');
    expect(last?.hostUrl).toBe('http://127.0.0.1:54321');
    expect(mgr.list()[0]?.hostUrl).toBe('http://127.0.0.1:54321');
  });

  it('does NOT override an explicit --host-port with the auto-published port (#392)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });

    const p = mgr.start({
      targetId: 'Stack/Svc',
      kind: 'ecs',
      options: { '--host-port': [{ left: '80', right: '9000' }] },
    });
    // Runner publishes on a DIFFERENT (auto-remapped) port — must NOT win over
    // the explicit --host-port value.
    child.stdout.emit('data', PUBLISH_LINE);
    child.stdout.emit('data', ECS_READY);
    const state = await p;
    expect(state.hostUrl).toBe('http://127.0.0.1:9000');
  });
});

describe('parsePublishedHostEndpoint (issue #392)', () => {
  it('extracts http://<ip>:<port> from a publish line', () => {
    expect(
      parsePublishedHostEndpoint(
        "Container 'web' container port 80 published on 127.0.0.1:54321. Reach it at 127.0.0.1:54321."
      )
    ).toBe('http://127.0.0.1:54321');
  });

  // Issue #578 — the phrase alone is no longer enough: `hostUrl` is a
  // destination the request composer posts to DIRECTLY, so only the whole
  // publish banner (which only `ecs-task-runner` emits) can name it. A relayed
  // error message, or a replica's own application output, that happens to
  // contain the words is not a publish line.
  it('ignores the `published on` phrase outside the publish banner (issue #578)', () => {
    expect(parsePublishedHostEndpoint('published on 192.168.0.5:8080')).toBeUndefined();
    expect(
      parsePublishedHostEndpoint('AccessDenied: token published on 10.1.2.3:9999 by the relay')
    ).toBeUndefined();
    expect(
      parsePublishedHostEndpoint(
        "  Container 'web' container port 80 published on 127.0.0.1:54321."
      )
    ).toBeUndefined();
  });

  // Non-loopback is still PARSED here — this stays a pure reader of the
  // banner, and the loopback bound is the caller's (see the refusal tests).
  it('parses a non-loopback container-host IP out of the banner (the caller refuses it)', () => {
    expect(
      parsePublishedHostEndpoint(
        "Container 'web' container port 80 published on 192.168.0.5:8080. Reach it at 192.168.0.5:8080."
      )
    ).toBe('http://192.168.0.5:8080');
  });

  it('returns undefined for a line with no published endpoint', () => {
    expect(parsePublishedHostEndpoint('Service(s) running: 1 replica.')).toBeUndefined();
    expect(parsePublishedHostEndpoint('Starting container web')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #578 - an ordinary child log line must not be able to name the serve
// endpoint studio proxies to (or the hostUrl the composer posts to directly).
// ---------------------------------------------------------------------------

/** Let a pending `onReady` (its proxy startup is async) settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Start a serve WITHOUT awaiting readiness, so a line that must NOT be taken
 * for a ready banner is observable: the entry stays `starting`, no proxy is
 * created, and `start()`'s promise simply stays pending (it would reject only
 * when the ready timeout fires, which these tests never trigger).
 */
function startPending(
  kind: StudioTargetKind,
  targetId = 'MyApi'
): {
  child: ReturnType<typeof makeFakeChild>;
  fp: ReturnType<typeof fakeProxies>;
  serves: StudioServeEvent[];
  logs: StudioLogEvent[];
  list: () => StudioServeState[];
  /** The pending `start()` promise. Pre-attached `catch` so it never leaks. */
  ready: Promise<StudioServeState>;
  /** `stop()` for this target, so a teardown-window race is drivable. */
  stop: () => Promise<void>;
} {
  const bus = new StudioEventBus();
  const { serves, logs } = collect(bus);
  const child = makeFakeChild();
  const fp = fakeProxies();
  const mgr = createStudioServeManager({
    cliEntry: '/p/cli.js',
    bus,
    spawnFn: (() => child) as never,
    clock: fixedClock(),
    proxyFactory: fp.factory,
  });
  const ready = mgr.start({ targetId, kind });
  ready.catch(() => undefined);
  return {
    child,
    fp,
    serves,
    logs,
    list: () => mgr.list(),
    ready,
    stop: () => mgr.stop({ targetId }),
  };
}

describe('classifyChildLine (issue #578)', () => {
  it('reads the compact WARN / ERROR prefix the logger emits', () => {
    expect(classifyChildLine('WARN: pinned image')).toEqual({
      diagnostic: true,
      text: 'pinned image',
      untagged: 'pinned image',
    });
    expect(classifyChildLine('ERROR: boom')).toEqual({
      diagnostic: true,
      text: 'boom',
      untagged: 'boom',
    });
  });

  it('sees through the ANSI colour the logger wraps a warn line in', () => {
    expect(classifyChildLine('\u001b[33mWARN: pinned image\u001b[0m')).toEqual({
      diagnostic: true,
      text: 'pinned image',
      untagged: 'pinned image',
    });
  });

  it('reads the verbose `<timestamp> <LEVEL>` preamble (--verbose / CDKL_LOG_LEVEL=debug)', () => {
    expect(classifyChildLine('2026-08-27T12:00:00.000Z WARN  pinned image')).toEqual({
      diagnostic: true,
      text: 'pinned image',
      untagged: 'pinned image',
    });
    expect(classifyChildLine('2026-08-27T12:00:00.000Z ERROR [ecs] boom')).toEqual({
      diagnostic: true,
      // The tag stays on `text` and comes off only on `untagged`.
      text: '[ecs] boom',
      untagged: 'boom',
    });
  });

  it('peels a `[module]` tag into `untagged` ONLY behind a verbose preamble', () => {
    // The one shape a cdk-local child logger emits: `ChildLogger` prefixes
    // info / warn / error only at debug level, which is also the level that
    // renders the preamble.
    expect(
      classifyChildLine('2026-08-27T12:00:00.000Z INFO  [ecs] Service(s) running: 1.')
    ).toEqual({
      diagnostic: false,
      text: '[ecs] Service(s) running: 1.',
      untagged: 'Service(s) running: 1.',
    });
  });

  it('leaves a BARE `[tag]` in place on BOTH fields - it is relayed container output', () => {
    // `[<container>] ` (ecs-task-runner) and `[svc=... c=...] ` (
    // ecs-service-runner) are how a third party's own stdout reaches this
    // stream. Stripping either would re-anchor an application log line to `^`.
    for (const line of [
      '[ecs] Service(s) running: 1.',
      '[web] Server listening on http://127.0.0.1:9999',
      '[svc=Api r=0 c=web] Server listening on http://127.0.0.1:9999',
    ]) {
      expect(classifyChildLine(line), line).toEqual({
        diagnostic: false,
        text: line,
        untagged: line,
      });
    }
  });

  it('leaves an ordinary line - and its leading whitespace - alone', () => {
    expect(classifyChildLine('Server listening on http://127.0.0.1:51234')).toEqual({
      diagnostic: false,
      text: 'Server listening on http://127.0.0.1:51234',
      untagged: 'Server listening on http://127.0.0.1:51234',
    });
    // NOT trimmed: the banners start at column 0, so an indented line must
    // stay unable to impersonate one.
    expect(classifyChildLine('  Server listening on http://10.0.0.5:3000').text).toBe(
      '  Server listening on http://10.0.0.5:3000'
    );
  });
});

describe("serve readiness ignores cdk-local's own diagnostics (issue #578)", () => {
  // Every spelling the logger can render a warn / error in. The URL is
  // LOOPBACK on purpose: it would sail past the loopback bound, so these
  // assertions isolate the diagnostic-skip rule.
  const DIAGNOSTIC_SPELLINGS = [
    'WARN: AccessDenied: Server listening on http://127.0.0.1:51234  (relayed)',
    'ERROR: ExpiredTokenException: Server listening on http://127.0.0.1:51234  (relayed)',
    '[ecs] WARN: Server listening on http://127.0.0.1:51234  (relayed)',
    '\u001b[33mWARN: Server listening on http://127.0.0.1:51234  (relayed)\u001b[0m',
    '2026-08-27T12:00:00.000Z WARN  Server listening on http://127.0.0.1:51234',
    '2026-08-27T12:00:00.000Z ERROR [agentcore] Server listening on http://127.0.0.1:51234',
  ];

  it('does not flip to running and starts no proxy for any WARN / ERROR spelling', async () => {
    for (const line of DIAGNOSTIC_SPELLINGS) {
      const h = startPending('api');
      h.child.stdout.emit('data', `${line}\n`);
      await tick();
      expect(h.list()[0]?.status, line).toBe('starting');
      expect(h.list()[0]?.endpoints, line).toEqual([]);
      expect(h.fp.upstreams, line).toEqual([]);
      expect(
        h.serves.map((e) => e.status),
        line
      ).toEqual(['starting']);
      // The line is still surfaced to the LOGS panel verbatim.
      expect(h.logs.at(-1)?.line, line).toBe(line);
    }
  });

  it('still flips to running on the genuine banner that follows a diagnostic', async () => {
    const h = startPending('api');
    h.child.stdout.emit('data', 'WARN: Server listening on http://127.0.0.1:9999  (relayed)\n');
    await tick();
    expect(h.list()[0]?.status).toBe('starting');
    h.child.stdout.emit('data', LISTENING);
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    expect(h.list()[0]?.endpoints).toEqual([PROXIED]);
    expect(h.fp.upstreams).toEqual(['http://127.0.0.1:51234']);
  });

  it('ignores a diagnostic carrying the agentcore extra-endpoint phrase', async () => {
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://127.0.0.1:49160/ws  (MyAgent)\n');
    await tick();
    h.child.stdout.emit(
      'data',
      'WARN: relay said: HTTP contract served on http://127.0.0.1:51234\n'
    );
    await tick();
    expect(h.list()[0]?.endpoints).toEqual(['ws://127.0.0.1:49160/ws']);
    expect(h.fp.upstreams).toEqual([]);
  });
});

describe('serve readiness anchors its banners to the start of the line (issue #578)', () => {
  // Mid-line occurrences with a LOOPBACK URL: only the anchor stops these.
  const EMBEDDED = [
    'my-framework 1.2.3: Server listening on http://127.0.0.1:3000',
    'Reload complete. Server listening on http://127.0.0.1:3000',
    '  Server listening on http://127.0.0.1:3000',
  ];

  it('does not treat an embedded phrase as the api ready banner', async () => {
    for (const line of EMBEDDED) {
      const h = startPending('api');
      h.child.stdout.emit('data', `${line}\n`);
      await tick();
      expect(h.list()[0]?.status, line).toBe('starting');
      expect(h.fp.upstreams, line).toEqual([]);
    }
  });

  it('does not treat an embedded phrase as the alb / cloudfront / ecs / ecs-task banner', async () => {
    const cases: Array<[StudioTargetKind, string]> = [
      ['alb', 'Failed to start ALB front-door: http://127.0.0.1:51234'],
      ['cloudfront', 'note: CloudFront distribution serving on http://127.0.0.1:51234'],
      ['ecs', 'Waiting until Service(s) running: MySvc'],
      ['ecs-task', 'Not yet: Task running (family=fixture)'],
    ];
    for (const [kind, line] of cases) {
      const h = startPending(kind, `T-${kind}`);
      h.child.stdout.emit('data', `${line}\n`);
      await tick();
      expect(h.list()[0]?.status, line).toBe('starting');
      expect(h.fp.upstreams, line).toEqual([]);
    }
  });

  // The anchor must not cost a real serve its readiness under the verbose
  // renderer, which every logger-emitted banner (alb / ecs / ecs-task /
  // agentcore-ws) picks up from `--verbose` or an inherited
  // CDKL_LOG_LEVEL=debug.
  it('still matches a logger-rendered banner under --verbose', async () => {
    const h = startPending('alb', 'MyAlb');
    h.child.stdout.emit(
      'data',
      '2026-08-27T12:00:00.000Z INFO  ALB front-door: http://127.0.0.1:51234 (listener port 80)\n'
    );
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    expect(h.fp.upstreams).toEqual(['http://127.0.0.1:51234']);
  });

  it('does not treat an embedded phrase as the agentcore extra-endpoint line', async () => {
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://127.0.0.1:49160/ws  (MyAgent)\n');
    await tick();
    // Loopback URL, no diagnostic prefix: only the anchor rejects it.
    h.child.stdout.emit('data', 'agent boot: HTTP contract served on http://127.0.0.1:51234\n');
    await tick();
    expect(h.list()[0]?.endpoints).toEqual(['ws://127.0.0.1:49160/ws']);
    expect(h.fp.upstreams).toEqual([]);
  });

  it('does NOT treat a bare [module]-tagged line as a ready banner', async () => {
    // No ready banner is tag-prefixed: `start-api` / `start-cloudfront` write
    // straight to stdout, and `start-alb` / `run-task` / `start-agentcore` use
    // the ROOT logger. A bare `[tag] ` at column 0 is relayed CONTAINER output
    // (`[<container>] ` / `[svc=... c=...] `), so it must not be re-anchored.
    const h = startPending('ecs', 'Stack/Svc');
    h.child.stdout.emit('data', '[ecs] Service(s) running: 1 replica.\n');
    await tick();
    expect(h.list()[0]?.status).toBe('starting');

    const a = startPending('api');
    a.child.stdout.emit('data', '[web] Server listening on http://127.0.0.1:9999\n');
    await tick();
    expect(a.list()[0]?.status).toBe('starting');
    expect(a.fp.upstreams).toEqual([]);
  });

  it('still matches a child-logger banner behind the verbose preamble it really carries', async () => {
    // The publish banner is the one banner written through
    // `getLogger().child('ecs')`, and the tag only appears at debug level -
    // i.e. always after the `<timestamp> <LEVEL>` preamble.
    const h = startPending('ecs', 'Stack/Svc');
    h.child.stdout.emit(
      'data',
      "2026-08-27T12:00:00.000Z INFO  [ecs] Container 'web' container port 80 published on 127.0.0.1:54321. Reach it at 127.0.0.1:54321.\n"
    );
    h.child.stdout.emit('data', 'Service(s) running: 1 replica.\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    expect(h.list()[0]?.hostUrl).toBe('http://127.0.0.1:54321');
  });
});

describe('serve readiness refuses a non-loopback endpoint (issue #578)', () => {
  // Not diagnostics, and anchored at column 0 - indistinguishable from the
  // real banner by shape. The loopback bound is what stops them. (A `0.0.0.0`
  // bind is NOT here: a wildcard is a bind address, reachable on loopback, so
  // it is normalized rather than refused - see the wildcard describe below.)
  // Paired with the WORD the refusal must use, so the two faults that reach
  // one refusal stay distinguishable: a value that parses and names another
  // host, versus one that is not a URL at all (issue #578 review).
  const FOREIGN: Array<[string, string]> = [
    ['Server listening on http://attacker.example/  (MyApi)', 'non-loopback'],
    ['Server listening on http://169.254.169.254:80  (MyApi)', 'non-loopback'],
    ['Server listening on http://localhost.attacker.example:8080  (MyApi)', 'non-loopback'],
    ['Server listening on http://127.0.0.1.attacker.example:8080  (MyApi)', 'non-loopback'],
    ['Server listening on http://[2001:db8::1]:3000  (MyApi)', 'non-loopback'],
    ['Server listening on http://192.168.0.5:3000  (MyApi)', 'non-loopback'],
    ['Server listening on not-a-url  (MyApi)', 'unparseable'],
  ];

  it('adopts no endpoint, starts no proxy, and fails the serve immediately', async () => {
    for (const [line, reason] of FOREIGN) {
      const h = startPending('api');
      h.child.stdout.emit('data', `${line}\n`);
      await tick();
      // Settled NOW, not after the 120 s ready timeout: the child named the
      // only endpoint it is going to name and studio will not use it, so the
      // serve is dropped and the UI is told why (issue #578 review).
      expect(h.list(), line).toEqual([]);
      expect(h.fp.upstreams, line).toEqual([]);
      const last = h.serves.at(-1);
      expect(last?.status, line).toBe('error');
      // The failure REASON carries the refusal text - not a bare
      // "did not start within 120000ms" with the cause buried in the logs.
      expect(last?.message, line).toContain(reason);
      expect(last?.endpoints, line).toEqual([]);
      // The refusal is also loud on the LOGS panel.
      const warn = h.logs.map((l) => l.line).find((l) => l.startsWith('WARN: refused'));
      expect(warn, line).toBeDefined();
      expect(warn, line).toContain(reason);
      // The child is torn down gracefully so it can stop its own containers.
      expect(h.child.kill, line).toHaveBeenCalledWith('SIGTERM');
    }
  });

  it('rejects the pending start() with the refusal, not with a timeout message', async () => {
    const h = startPending('api');
    h.child.stdout.emit('data', 'Server listening on http://attacker.example/  (MyApi)\n');
    await expect(h.ready).rejects.toThrow(/non-loopback/);
  });

  it('accepts every loopback spelling', async () => {
    const LOCAL = [
      'http://127.0.0.1:51234',
      'http://127.5.5.5:51234',
      'http://localhost:51234',
      'http://[::1]:51234',
    ];
    for (const url of LOCAL) {
      const h = startPending('api');
      h.child.stdout.emit('data', `Server listening on ${url}  (MyApi)\n`);
      await tick();
      expect(h.list()[0]?.status, url).toBe('running');
      expect(h.fp.upstreams, url).toEqual([url]);
    }
  });

  it('refuses a non-loopback agentcore extra endpoint while keeping the ws:// one', async () => {
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://127.0.0.1:49160/ws  (MyAgent)\n');
    await tick();
    h.child.stdout.emit('data', 'HTTP contract served on http://attacker.example:80\n');
    await tick();
    expect(h.list()[0]?.endpoints).toEqual(['ws://127.0.0.1:49160/ws']);
    expect(h.fp.upstreams).toEqual([]);
    expect(h.logs.map((l) => l.line).some((l) => l.startsWith('WARN: refused'))).toBe(true);
  });

  it('refuses a non-loopback ws:// ready endpoint outright', async () => {
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://attacker.example/ws  (MyAgent)\n');
    await tick();
    expect(h.list()).toEqual([]);
    expect(h.serves.at(-1)?.status).toBe('error');
    expect(h.serves.at(-1)?.message).toContain('non-loopback');
  });
});

describe('ecs hostUrl carries the same bounds (issue #578)', () => {
  const ECS_READY_LINE = 'Service(s) running: 1 replica.\n';
  const banner = (endpoint: string): string =>
    `Container 'web' container port 80 published on ${endpoint}. Reach it at ${endpoint}.\n`;

  it('ignores a publish banner relayed inside a WARN / ERROR line', async () => {
    for (const prefix of ['WARN: ', 'ERROR: ', '[ecs] WARN: ']) {
      const h = startPending('ecs', 'Stack/Svc');
      h.child.stdout.emit('data', prefix + banner('127.0.0.1:54321'));
      h.child.stdout.emit('data', ECS_READY_LINE);
      await tick();
      expect(h.list()[0]?.status, prefix).toBe('running');
      expect(h.list()[0]?.hostUrl, prefix).toBeUndefined();
    }
  });

  it('ignores the `published on` phrase embedded mid-line', async () => {
    const h = startPending('ecs', 'Stack/Svc');
    h.child.stdout.emit('data', 'relay error: token published on 10.1.2.3:9999\n');
    h.child.stdout.emit('data', ECS_READY_LINE);
    await tick();
    expect(h.list()[0]?.hostUrl).toBeUndefined();
  });

  it('refuses a non-loopback published endpoint, loudly', async () => {
    for (const endpoint of ['192.168.0.5:8080', '169.254.169.254:80', '10.1.2.3:80']) {
      const h = startPending('ecs', 'Stack/Svc');
      h.child.stdout.emit('data', banner(endpoint));
      h.child.stdout.emit('data', ECS_READY_LINE);
      await tick();
      expect(h.list()[0]?.hostUrl, endpoint).toBeUndefined();
      expect(
        h.logs.map((l) => l.line).some((l) => l.startsWith('WARN: refused')),
        endpoint
      ).toBe(true);
    }
  });

  it('still adopts the genuine loopback publish banner', async () => {
    const h = startPending('ecs', 'Stack/Svc');
    h.child.stdout.emit('data', banner('127.0.0.1:54321'));
    h.child.stdout.emit('data', ECS_READY_LINE);
    await tick();
    expect(h.list()[0]?.hostUrl).toBe('http://127.0.0.1:54321');
  });
});

describe('a wildcard bind address is normalized to loopback, not refused (issue #578)', () => {
  // `0.0.0.0` / `::` is a BIND address, not a destination: a server bound to
  // it IS reachable on loopback, and `--container-host 0.0.0.0` is an ordinary
  // value that `cdkl studio` auto-renders in "All options". Refusing it would
  // silently break the request composer for that serve.
  const WILDCARD_READY = [
    'http://0.0.0.0:51234',
    'http://[::]:51234',
    'http://[0:0:0:0:0:0:0:0]:51234',
    'http://[::ffff:0.0.0.0]:51234',
  ];

  it('flips to running and adopts the REWRITTEN loopback endpoint', async () => {
    for (const url of WILDCARD_READY) {
      const h = startPending('api');
      h.child.stdout.emit('data', `Server listening on ${url}  (MyApi)\n`);
      await tick();
      expect(h.list()[0]?.status, url).toBe('running');
      // Not merely "not refused": the endpoint handed to the UI is the proxy
      // in front of the LOOPBACK-rewritten upstream.
      expect(h.list()[0]?.endpoints, url).toEqual([PROXIED]);
      expect(
        h.logs.map((l) => l.line).some((l) => l.startsWith('WARN: refused')),
        url
      ).toBe(false);
    }
  });

  it('hands the capture proxy 127.0.0.1, never the bind address', async () => {
    for (const url of WILDCARD_READY) {
      const h = startPending('api');
      h.child.stdout.emit('data', `Server listening on ${url}  (MyApi)\n`);
      await tick();
      // The rewrite happens at the DESTINATION: the proxy forwards to
      // 127.0.0.1:51234, not to the wildcard the child printed.
      expect(h.fp.upstreams, url).toEqual(['http://127.0.0.1:51234']);
    }
  });

  it('treats an https:// ready line (--tls) exactly like http://', async () => {
    // `start-api` flips the banner's scheme to https under mTLS
    // (local-start-api.ts:1149, `${server.scheme}://...`), and start-cloudfront
    // does the same via `server.url` (cloudfront-server.ts:144). The guard
    // reads the HOSTNAME, so the scheme changes nothing.
    const h = startPending('api');
    h.child.stdout.emit('data', 'Server listening on https://127.0.0.1:51234  (MyApi)\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    expect(h.fp.upstreams).toEqual(['https://127.0.0.1:51234']);

    const w = startPending('api', 'MyApi2');
    w.child.stdout.emit('data', 'Server listening on https://0.0.0.0:51234  (MyApi)\n');
    await tick();
    expect(w.fp.upstreams).toEqual(['https://127.0.0.1:51234']);

    const f = startPending('api', 'MyApi3');
    f.child.stdout.emit('data', 'Server listening on https://attacker.example/  (MyApi)\n');
    await tick();
    expect(f.list()).toEqual([]);
    expect(f.serves.at(-1)?.status).toBe('error');
    expect(f.fp.upstreams).toEqual([]);
  });

  it('rewrites the host only - port and path survive (agentcore ws:// endpoint)', async () => {
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://[::]:49160/ws  (MyAgent)\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    // ws:// passes through un-proxied, so this is the exact adopted string.
    expect(h.list()[0]?.endpoints).toEqual(['ws://127.0.0.1:49160/ws']);
  });

  it('normalizes the agentcore http:// contract endpoint too', async () => {
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://127.0.0.1:49160/ws  (MyAgent)\n');
    await tick();
    h.child.stdout.emit('data', 'HTTP contract served on http://0.0.0.0:51234\n');
    await tick();
    expect(h.list()[0]?.endpoints).toEqual(['ws://127.0.0.1:49160/ws', PROXIED]);
    expect(h.fp.upstreams).toEqual(['http://127.0.0.1:51234']);
  });

  it('normalizes a wildcard --container-host publish banner into hostUrl', async () => {
    // Only the dotted IPv4 wildcard can reach this path: `--container-host`
    // must be a numeric IP (Docker rejects hostnames), and the publish banner
    // prints exactly what was bound.
    const h = startPending('ecs', 'Stack/Svc');
    h.child.stdout.emit(
      'data',
      "Container 'web' container port 80 published on 0.0.0.0:54321. Reach it at 0.0.0.0:54321.\n"
    );
    h.child.stdout.emit('data', 'Service(s) running: 1 replica.\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    expect(h.list()[0]?.hostUrl).toBe('http://127.0.0.1:54321');
    expect(h.logs.map((l) => l.line).some((l) => l.startsWith('WARN: refused'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #578 review round - the bounds the first pass left partly open.
// ---------------------------------------------------------------------------

describe('the agentcore-ws ready anchor is fenced too (issue #578)', () => {
  // `agentcore-ws` carries its OWN `readyRe` literal, distinct from `api`'s.
  // Without this case, reverting the `^` on that one literal alone left the
  // whole suite green - so "all six anchors are fenced" was 5/6.
  it('does not treat an embedded phrase as the agentcore ready banner', async () => {
    for (const line of [
      'agent boot: Server listening on ws://127.0.0.1:3000/ws',
      'Reload complete. Server listening on ws://127.0.0.1:3000/ws',
      '  Server listening on ws://127.0.0.1:3000/ws',
      'agent boot: Server listening on http://127.0.0.1:3000',
    ]) {
      const h = startPending('agentcore-ws', 'MyAgent');
      h.child.stdout.emit('data', `${line}\n`);
      await tick();
      expect(h.list()[0]?.status, line).toBe('starting');
      expect(h.list()[0]?.endpoints, line).toEqual([]);
      expect(h.fp.upstreams, line).toEqual([]);
    }
  });
});

describe('a relayed container log cannot impersonate a ready banner (issue #578)', () => {
  // Bound 2's real target: `[<container>] ` (ecs-task-runner) and
  // `[svc=... c=...] ` (ecs-service-runner) are how a third party's stdout
  // reaches this stream, and stripping the tag re-anchored it to `^`.
  it('leaves an ecs container-prefixed banner unmatched for every kind', async () => {
    const CASES: Array<[StudioTargetKind, string]> = [
      ['api', '[web] Server listening on http://127.0.0.1:9999'],
      ['api', '[svc=Api r=0 c=web] Server listening on http://127.0.0.1:9999'],
      ['cloudfront', '[web] CloudFront distribution serving on http://127.0.0.1:9999'],
      ['alb', '[web] ALB front-door: http://127.0.0.1:9999'],
      ['agentcore-ws', '[agent] Server listening on ws://127.0.0.1:9999/ws'],
      ['ecs', '[web] Service(s) running: 1'],
      ['ecs-task', '[web] Task running (family=evil)'],
    ];
    for (const [kind, line] of CASES) {
      const h = startPending(kind, `T-${kind}-${line.length}`);
      h.child.stdout.emit('data', `${line}\n`);
      await tick();
      expect(h.list()[0]?.status, line).toBe('starting');
      expect(h.list()[0]?.endpoints, line).toEqual([]);
      expect(h.fp.upstreams, line).toEqual([]);
    }
  });

  it('stops reading readyRe once a single-banner serve is running', async () => {
    // `cloudfront` prints its banner exactly once, so a later line carrying it
    // is not a banner. (`api` / `alb` are exempt - they legitimately print
    // several - see ServeKindSpec.readyRepeats.)
    const h = startPending('cloudfront', 'MyDist');
    h.child.stdout.emit('data', 'CloudFront distribution serving on http://127.0.0.1:51234\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    expect(h.fp.upstreams).toEqual(['http://127.0.0.1:51234']);

    // A handler's own log line, post-boot, at column 0 and unprefixed.
    h.child.stdout.emit('data', 'CloudFront distribution serving on http://127.0.0.1:9999\n');
    await tick();
    expect(h.fp.upstreams).toEqual(['http://127.0.0.1:51234']);
    expect(h.list()[0]?.endpoints).toEqual([PROXIED]);
  });

  it('keeps reading the agentcore extra-endpoint line AFTER the serve is running', async () => {
    // The stop is scoped to readyRe: agentcore's http:// contract line arrives
    // by design after the ws:// listen line settled the serve.
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://127.0.0.1:49160/ws  (MyAgent)\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    h.child.stdout.emit('data', 'HTTP contract served on http://127.0.0.1:51234\n');
    await tick();
    expect(h.list()[0]?.endpoints).toEqual(['ws://127.0.0.1:49160/ws', PROXIED]);
  });

  it('keeps reading the ecs publish banner AFTER the serve is running', async () => {
    const h = startPending('ecs', 'Stack/Svc');
    h.child.stdout.emit('data', 'Service(s) running: 1 replica.\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    h.child.stdout.emit(
      'data',
      "Container 'web' container port 80 published on 127.0.0.1:54321. Reach it at 127.0.0.1:54321.\n"
    );
    await tick();
    expect(h.list()[0]?.hostUrl).toBe('http://127.0.0.1:54321');
  });
});

describe('a refused ready line fails the serve immediately (issue #578)', () => {
  it('does not leave an alb bound to a non-loopback --container-host hanging', async () => {
    // `cdkl start-alb --container-host <non-loopback>` puts that host in the
    // front-door banner, so this is a live configuration rather than an
    // attack. It used to sit `starting` for the full 120 s ready timeout and
    // then report a timeout, with the real cause only in the LOGS panel.
    const h = startPending('alb', 'MyAlb');
    h.child.stdout.emit('data', 'ALB front-door: http://10.1.2.3:8080 (listener port 80)\n');
    await tick();
    expect(h.list()).toEqual([]);
    expect(h.serves.at(-1)?.status).toBe('error');
    expect(h.serves.at(-1)?.message).toContain('non-loopback');
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(h.ready).rejects.toThrow(/non-loopback/);
  });

  it('refuses an UNBRACKETED IPv6 bind address rather than guessing at it', async () => {
    // `--container-host ::` makes the banner `http://:::8080`, which is not a
    // URL: `new URL` rejects it, so the wildcard rewrite never runs. Repairing
    // the spelling would mean re-deriving an authority the parser refused, so
    // the answer is the honest one - refuse, fast, with the reason.
    const h = startPending('alb', 'MyAlb');
    h.child.stdout.emit('data', 'ALB front-door: http://:::8080 (listener port 80)\n');
    await tick();
    expect(h.list()).toEqual([]);
    expect(h.serves.at(-1)?.status).toBe('error');
    // And the reason is the one that actually applies. `:::8080` does not
    // PARSE; calling it non-loopback would name a judgement never reached,
    // which now costs more than a wrong word since this tears the serve down.
    expect(h.serves.at(-1)?.message).toContain('unparseable');
    expect(h.serves.at(-1)?.message).not.toContain('non-loopback');
  });

  it('does NOT fail an already-running serve when a later endpoint line is refused', async () => {
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://127.0.0.1:49160/ws  (MyAgent)\n');
    await tick();
    h.child.stdout.emit('data', 'HTTP contract served on http://attacker.example:80\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    expect(h.list()[0]?.endpoints).toEqual(['ws://127.0.0.1:49160/ws']);
  });

  it('warns on the studio process logger, not only on the bus', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      const h = startPending('api');
      h.child.stdout.emit('data', 'Server listening on http://attacker.example/  (MyApi)\n');
      await tick();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('non-loopback');
      expect(warn.mock.calls[0]?.[0]).toContain('MyApi');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the proxy-failure fallback keeps the loopback bound (issue #578)', () => {
  /** A serve manager whose capture-proxy factory always fails to bind. */
  function startWithFailingProxy(ready: string): {
    child: ReturnType<typeof makeFakeChild>;
    serves: StudioServeEvent[];
    list: () => StudioServeState[];
  } {
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const mgr = createStudioServeManager({
      cliEntry: '/p/cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      proxyFactory: () => Promise.reject(new Error('EADDRINUSE')),
    });
    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    p.catch(() => undefined);
    child.stdout.emit('data', `${ready}\n`);
    return { child, serves, list: () => mgr.list() };
  }

  it('publishes the NORMALIZED url, never the raw one the child printed', async () => {
    // The fallback runs when the proxy cannot bind. It must hand the UI the
    // resolved destination (127.0.0.1), not the wildcard bind address the
    // child named - the composer posts to this string with no proxy in front.
    const h = startWithFailingProxy('Server listening on http://0.0.0.0:51234  (MyApi)');
    await tick();
    expect(h.list()[0]?.status).toBe('running');
    expect(h.list()[0]?.endpoints).toEqual(['http://127.0.0.1:51234']);
  });

  it('adopts nothing when the REAL proxy refuses a foreign upstream', async () => {
    // Defence in depth, with no injected factory at all: the serve manager
    // falls back to the real `startStudioProxy`, which enforces the same
    // loopback bound by throwing. Green while EITHER guard stands, red only
    // when both are gone - which is the point of having two.
    const bus = new StudioEventBus();
    const { serves } = collect(bus);
    const child = makeFakeChild();
    const mgr = createStudioServeManager({
      cliEntry: '/p/cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
    });
    const p = mgr.start({ targetId: 'MyApi', kind: 'api' });
    p.catch(() => undefined);
    child.stdout.emit('data', 'Server listening on http://attacker.example/  (MyApi)\n');
    await tick();
    expect(mgr.list().flatMap((e) => e.endpoints)).toEqual([]);
    expect(serves.some((e) => e.endpoints.includes('http://attacker.example/'))).toBe(false);
    expect(serves.at(-1)?.status).toBe('error');
  });
});

describe('a stdout line split across chunks is reassembled first (issue #578)', () => {
  it('classifies the REASSEMBLED line, not either half', async () => {
    const h = startPending('api');
    // The `WARN: ` prefix and the banner phrase land in different chunks, and
    // the split is mid-token. Only reassembly makes the diagnostic bound see
    // the prefix; the URL is LOOPBACK so nothing else would stop it.
    h.child.stdout.emit('data', 'WARN: Serv');
    h.child.stdout.emit('data', 'er listening on http://127.0.0.1:51234\n');
    await tick();
    expect(h.list()[0]?.status).toBe('starting');
    expect(h.list()[0]?.endpoints).toEqual([]);
    expect(h.fp.upstreams).toEqual([]);
    // And the LOGS panel gets one whole line, not two fragments.
    expect(h.logs.map((l) => l.line)).toEqual([
      'WARN: Server listening on http://127.0.0.1:51234',
    ]);
  });
});

describe('the serve manager delegates host judgement to normalizeLocalUpstream (issue #578)', () => {
  // Locks the delegation that was only implicit: these are `URL`'s
  // normalisations, and the serve manager must inherit every one of them
  // rather than re-deciding with a regex of its own.
  const CASES: Array<[string, string | undefined]> = [
    // userinfo `@` does not make the credential the host
    ['http://127.0.0.1@attacker.example/', undefined],
    // decimal integer form of 169.254.169.254
    ['http://2852039166/', undefined],
    // OCTAL 0177 == 127
    ['http://0177.0.0.1/', 'http://0177.0.0.1/'],
    // a rooted IPv4 literal is still the literal
    ['http://127.0.0.1.:51234/', 'http://127.0.0.1.:51234/'],
    // a rooted NAME is a name
    ['http://localhost./', undefined],
    // hostnames are case-insensitive
    ['http://LOCALHOST:51234/', 'http://LOCALHOST:51234/'],
  ];

  it('adopts exactly what normalizeLocalUpstream accepts', async () => {
    for (const [url, expected] of CASES) {
      const h = startPending('api', `T-${url}`);
      h.child.stdout.emit('data', `Server listening on ${url}  (MyApi)\n`);
      await tick();
      if (expected === undefined) {
        expect(h.list(), url).toEqual([]);
        expect(h.fp.upstreams, url).toEqual([]);
      } else {
        expect(h.list()[0]?.status, url).toBe('running');
        expect(h.fp.upstreams, url).toEqual([expected]);
      }
    }
  });
});

describe('the --host-port hostUrl carries the loopback bound too (issue #578)', () => {
  function startEcsWithHostPort(right: string): {
    child: ReturnType<typeof makeFakeChild>;
    logs: StudioLogEvent[];
    list: () => StudioServeState[];
    ready: Promise<StudioServeState>;
  } {
    const bus = new StudioEventBus();
    const { logs } = collect(bus);
    const child = makeFakeChild();
    const fp = fakeProxies();
    const mgr = createStudioServeManager({
      cliEntry: '/p/cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      proxyFactory: fp.factory,
    });
    const ready = mgr.start({
      targetId: 'Stack/Svc',
      kind: 'ecs',
      options: { '--host-port': [{ left: '80', right }] },
    });
    ready.catch(() => undefined);
    return { child, logs, list: () => mgr.list(), ready };
  }

  it('refuses a --host-port value that smuggles a foreign host past the interpolation', async () => {
    // The port half is interpolated verbatim into `http://127.0.0.1:<right>`,
    // so `1@evil.example` makes `evil.example` the HOST. The composer posts to
    // hostUrl DIRECTLY, with no proxy in front.
    const h = startEcsWithHostPort('1@evil.example');
    h.child.stdout.emit('data', 'Service(s) running: 1 replica.\n');
    await h.ready;
    expect(h.list()[0]?.hostUrl).toBeUndefined();
    const warn = h.logs.map((l) => l.line).find((l) => l.startsWith('WARN: refused'));
    expect(warn).toBeDefined();
    expect(warn).toContain('--host-port');
  });

  it('still adopts an ordinary --host-port value', async () => {
    const h = startEcsWithHostPort('8080');
    h.child.stdout.emit('data', 'Service(s) running: 1 replica.\n');
    await h.ready;
    expect(h.list()[0]?.hostUrl).toBe('http://127.0.0.1:8080');
  });

  it('says UNPARSEABLE, not non-loopback, for a port half that is not a port', async () => {
    // `80=abc` interpolates to `http://127.0.0.1:abc`, which `new URL` rejects
    // for its port. The host it names IS loopback, so telling the user studio
    // "refused a non-loopback --host-port mapping" describes a judgement that
    // was never reached and points them at the wrong half of their flag.
    const h = startEcsWithHostPort('abc');
    h.child.stdout.emit('data', 'Service(s) running: 1 replica.\n');
    await h.ready;
    expect(h.list()[0]?.hostUrl).toBeUndefined();
    const warn = h.logs.map((l) => l.line).find((l) => l.startsWith('WARN: refused'));
    expect(warn).toBeDefined();
    expect(warn).toContain('unparseable');
    expect(warn).toContain('--host-port');
    expect(warn).not.toContain('non-loopback');
  });

  it('still says NON-LOOPBACK for a value that parses and names another host', async () => {
    // The other branch: `1@evil.example` parses fine, and `evil.example` is
    // the host. Both branches are pinned so the split cannot collapse back
    // into one wording in either direction.
    const h = startEcsWithHostPort('1@evil.example');
    h.child.stdout.emit('data', 'Service(s) running: 1 replica.\n');
    await h.ready;
    const warn = h.logs.map((l) => l.line).find((l) => l.startsWith('WARN: refused'));
    expect(warn).toContain('non-loopback');
    expect(warn).not.toContain('unparseable');
  });
});

// ---------------------------------------------------------------------------
// Issue #578 test-gap round - each block below kills a mutant the suite let
// through. The comment on each names the mutation it fences.
// ---------------------------------------------------------------------------

describe('an alb adopts EVERY listener banner (issue #578)', () => {
  // Mutant: delete `readyRepeats: true` from the `alb` spec. `buildFrontDoor`
  // logs one banner per LISTENER and awaits `startFrontDoorServer` between
  // them, so those land in different stdout chunks and therefore after the
  // serve has settled. Without the exemption every listener but the first is
  // silently dropped - and the whole suite stayed green, because only `api`'s
  // exemption was covered.
  it('reads a second ALB front-door banner arriving after the serve settled', async () => {
    const h = startPending('alb', 'MyAlb');
    h.child.stdout.emit('data', 'ALB front-door: http://127.0.0.1:51234 (listener port 80)\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');

    h.child.stdout.emit('data', 'ALB front-door: http://127.0.0.1:51235 (listener port 443)\n');
    await tick();

    // BOTH listeners are fronted, and both proxy URLs reach the UI.
    expect(h.fp.upstreams).toEqual(['http://127.0.0.1:51234', 'http://127.0.0.1:51235']);
    expect(h.list()[0]?.endpoints).toEqual([PROXIED, 'http://127.0.0.1:61235']);
  });
});

describe('a ready banner is matched on the TAG-BEARING text (issue #578)', () => {
  // Mutants: `spec.readyRe.exec(parsed.text)` -> `parsed.untagged`, and the
  // same on the `extraEndpointRe` line. `untagged` peels a `[module]` tag, and
  // peeling it before matching is exactly what re-anchored relayed container
  // output (`[web] `, `[svc=... c=...] `) to column 0. The existing module-tag
  // cases could not see the difference: they use BARE `[tag]` lines, where no
  // verbose preamble precedes the tag and so `text === untagged`. These lines
  // carry a preamble AND a tag, which is the one shape that separates them.
  it('does not read a banner sitting behind a [module] tag on a verbose line', async () => {
    const h = startPending('api', 'MyApi');
    h.child.stdout.emit(
      'data',
      '2026-08-27T12:00:00.000Z INFO  [web] Server listening on http://127.0.0.1:9999\n'
    );
    await tick();
    expect(h.list()[0]?.status).toBe('starting');
    expect(h.list()[0]?.endpoints).toEqual([]);
    expect(h.fp.upstreams).toEqual([]);
  });

  it('applies the same to the agentcore extra-endpoint line', async () => {
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://127.0.0.1:49160/ws  (MyAgent)\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');

    h.child.stdout.emit(
      'data',
      '2026-08-27T12:00:00.000Z INFO  [web] HTTP contract served on http://127.0.0.1:9999\n'
    );
    await tick();
    expect(h.list()[0]?.endpoints).toEqual(['ws://127.0.0.1:49160/ws']);
    expect(h.fp.upstreams).toEqual([]);
  });
});

describe('every single-banner kind stops reading readyRe once settled (issue #578)', () => {
  // Mutant: add `readyRepeats: true` to `agentcore-ws` / `ecs-task`. Only the
  // `cloudfront` case covered the post-settle stop, so the exemption could be
  // handed to a kind that does not need it with the suite still green.
  it('does not attach a SECOND capture proxy for an agentcore-ws serve', async () => {
    // This kind matters most of the three: it is `capturesHttp`, so a
    // post-boot line naming an http:// endpoint would start a real proxy and
    // publish it to the UI as this serve's endpoint.
    const h = startPending('agentcore-ws', 'MyAgent');
    h.child.stdout.emit('data', 'Server listening on ws://127.0.0.1:49160/ws  (MyAgent)\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');

    h.child.stdout.emit('data', 'Server listening on http://127.0.0.1:9999\n');
    await tick();
    expect(h.fp.upstreams).toEqual([]);
    expect(h.list()[0]?.endpoints).toEqual(['ws://127.0.0.1:49160/ws']);
  });

  it('does not re-announce an ecs-task run on a repeated Task running banner', async () => {
    // `ecs-task`'s banner carries no capture group, so the damage is smaller:
    // a duplicate `running` event rather than a duplicate destination. Pinned
    // anyway, so the exemption stays a property of the two kinds that need it.
    const h = startPending('ecs-task', 'Stack/TaskDef');
    h.child.stdout.emit('data', 'Task running (family=Stack-TaskDef).\n');
    await tick();
    expect(h.list()[0]?.status).toBe('running');

    h.child.stdout.emit('data', 'Task running (family=Stack-TaskDef).\n');
    await tick();
    expect(h.serves.filter((e) => e.status === 'running')).toHaveLength(1);
  });
});

describe('the ready pipeline reads STDOUT only (issue #578)', () => {
  // Mutant: run `child.stderr` through the same classify + readyRe pipeline.
  // Nothing pinned the split, and it matters because a Lambda container's
  // stderr is relayed raw and unprefixed (`docker-runner`'s `streamLogs`), so
  // a handler writing to stderr would otherwise get the `^` anchor for free.
  it('names no endpoint from a ready banner arriving on stderr', async () => {
    const h = startPending('api', 'MyApi');
    h.child.stderr.emit('data', LISTENING);
    await tick();
    expect(h.list()[0]?.status).toBe('starting');
    expect(h.list()[0]?.endpoints).toEqual([]);
    expect(h.fp.upstreams).toEqual([]);
    // The line still reaches the LOGS panel - it is dropped as a SIGNAL, not
    // hidden from the user.
    expect(h.logs.map((l) => l.line)).toContain(LISTENING.trimEnd());
  });
});

describe('a repeated ready line reuses its capture proxy (issue #578 review)', () => {
  // Mutant: start a fresh proxy on every readyRe match. `api` / `alb` are
  // exempt from the post-settle stop, so the socket count was bounded by the
  // CHILD'S OUTPUT: a handler logging `Server listening on ...` once per
  // invocation gave N listening sockets and N UI endpoints until serve stop.
  // The endpoint dedup downstream cannot catch it - each proxy has a fresh
  // port, so `proxy.url` differs every time.
  it('starts ONE proxy for two identical api ready lines', async () => {
    const h = startPending('api', 'MyApi');
    h.child.stdout.emit('data', LISTENING);
    await tick();
    h.child.stdout.emit('data', LISTENING);
    await tick();
    expect(h.fp.upstreams).toEqual(['http://127.0.0.1:51234']);
    expect(h.list()[0]?.endpoints).toEqual([PROXIED]);
  });

  it('starts ONE proxy when both lines arrive in the SAME chunk', async () => {
    // The racing shape: both matches reach the registry before either
    // `proxyFactory` call resolves, so a map of SETTLED proxies would still
    // start two. The pending promise is what makes the second one a reuse.
    const h = startPending('api', 'MyApi');
    h.child.stdout.emit('data', LISTENING + LISTENING);
    await tick();
    expect(h.fp.upstreams).toEqual(['http://127.0.0.1:51234']);
    expect(h.list()[0]?.endpoints).toEqual([PROXIED]);
  });

  // The other direction - two DISTINCT upstreams must still get a proxy each -
  // is the multi-listener alb case above, which asserts exactly that.

  it('closes the reused proxy exactly once on stop', async () => {
    const h = startPending('api', 'MyApi');
    h.child.stdout.emit('data', LISTENING);
    await tick();
    h.child.stdout.emit('data', LISTENING);
    await tick();

    const stopP = h.stop();
    h.child.emit('close', 0);
    await stopP;
    expect(h.fp.closes).toHaveLength(1);
    expect(h.fp.closes[0]).toHaveBeenCalledTimes(1);
  });
});

describe('a refusal during teardown is not an error banner (issue #578 review)', () => {
  // Mutant: guard `failServe` on `settled` alone. `stop()` marks the entry,
  // drops it from the map and then awaits `stopChild` for up to `stopGraceMs`
  // (45 s - a real ALB teardown takes that long). A refused ready line landing
  // in that window emitted an `error` serve event and rejected `start()` with
  // the refusal, so the UI showed a failure banner for a serve the user had
  // deliberately stopped, immediately followed by `stopped`.
  it('emits no error event for a serve the user already stopped', async () => {
    const h = startPending('alb', 'MyAlb');
    const stopP = h.stop();
    h.child.stdout.emit('data', 'ALB front-door: http://10.1.2.3:8080 (listener port 80)\n');
    await tick();

    expect(h.serves.map((e) => e.status)).not.toContain('error');
    h.child.emit('close', 0);
    await stopP;

    expect(h.serves.map((e) => e.status)).toEqual(['starting', 'stopped']);
    // And `start()` still rejects for the reason it really failed for.
    await expect(h.ready).rejects.toThrow(/stopped before it finished starting/i);
  });
});
