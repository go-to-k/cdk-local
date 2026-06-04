import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  StudioEventBus,
  type StudioLogEvent,
  type StudioServeEvent,
} from '../../../src/local/studio-events.js';
import { createStudioServeManager } from '../../../src/local/studio-serve-manager.js';

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

  it('threads one --image-override <service>=<dockerfile> per backing service for an alb serve (issue #382)', async () => {
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
    // The capture proxy must be torn down when the serve crashes.
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
});
