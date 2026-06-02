import { EventEmitter } from 'node:events';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vite-plus/test';
import { StudioEventBus, type StudioInvocationEvent, type StudioLogEvent } from '../../../src/local/studio-events.js';
import { createStudioDispatcher } from '../../../src/local/studio-dispatch.js';

/** A minimal stand-in for a spawned child process. */
function makeFakeChild(): EventEmitter & {
  stdout: EventEmitter & { setEncoding: () => void };
  stderr: EventEmitter & { setEncoding: () => void };
} {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  return Object.assign(new EventEmitter(), { stdout, stderr });
}

function collect(bus: StudioEventBus): {
  invocations: StudioInvocationEvent[];
  logs: StudioLogEvent[];
} {
  const invocations: StudioInvocationEvent[] = [];
  const logs: StudioLogEvent[] = [];
  bus.on('invocation', (e) => invocations.push(e));
  bus.on('log', (e) => logs.push(e));
  return { invocations, logs };
}

const fixedClock = (): (() => number) => {
  let t = 1000;
  return () => (t += 10);
};

describe('createStudioDispatcher', () => {
  it('spawns `cdkl invoke <target>` and returns the parsed response', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);

    const dispatcher = createStudioDispatcher({
      cliEntry: '/path/to/cli.js',
      bus,
      nodeBin: '/usr/bin/node',
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      idFactory: () => 'inv-1',
    });

    const p = dispatcher.run({ targetId: 'Stack/Fn', kind: 'lambda', event: { a: 1 } });
    // Listeners are attached synchronously inside run() before the await.
    child.stdout.emit('data', '{"statusCode":200,"body":"ok"}');
    child.emit('close', 0);
    const result = await p;

    // The CLI binary is invoked with the right argv shape.
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv },
    ];
    expect(bin).toBe('/usr/bin/node');
    expect(argv[0]).toBe('/path/to/cli.js');
    expect(argv.slice(1, 3)).toEqual(['invoke', 'Stack/Fn']);
    expect(argv).toContain('--event');
    // The child runs with CDKL_LOG_LEVEL=warn so cdk-local's own synth /
    // orchestration progress is silenced — the studio LOGS panel must show
    // only the Lambda container's runtime logs, never "Successfully
    // synthesized to ..." noise.
    expect(opts.env['CDKL_LOG_LEVEL']).toBe('warn');

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.response).toEqual({ statusCode: 200, body: 'ok' });
    expect(result.invocationId).toBe('inv-1');
  });

  it('emits an invocation start then end event keyed by the same id', async () => {
    const bus = new StudioEventBus();
    const { invocations } = collect(bus);
    const child = makeFakeChild();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      idFactory: () => 'inv-x',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    child.stdout.emit('data', '"done"');
    child.emit('close', 0);
    await p;

    expect(invocations).toHaveLength(2);
    expect(invocations[0].id).toBe('inv-x');
    expect(invocations[0].status).toBeUndefined(); // start: no status yet
    expect(invocations[1].id).toBe('inv-x');
    expect(invocations[1].status).toBe(200); // end: filled in
    expect(invocations[1].response).toBe('done');
    expect(invocations[1].durationMs).toBeGreaterThan(0);
  });

  it('streams child stderr lines onto the bus as log events', async () => {
    const bus = new StudioEventBus();
    const { logs } = collect(bus);
    const child = makeFakeChild();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      idFactory: () => 'inv-l',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    child.stderr.emit('data', 'line one\nline two\n');
    child.stderr.emit('data', 'partial');
    child.emit('close', 0);
    await p;

    expect(logs.map((l) => l.line)).toEqual(['line one', 'line two', 'partial']);
    expect(logs.every((l) => l.containerId === 'inv-l' && l.target === 'T')).toBe(true);
  });

  it('marks a non-zero exit as failed (status 500) with the stderr as the error', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      idFactory: () => 'inv-e',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    child.stderr.emit('data', 'boom: it failed\n');
    child.emit('close', 1);
    const result = await p;

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain('boom: it failed');
  });

  it('rejects a non-lambda kind with 501 without spawning', async () => {
    const bus = new StudioEventBus();
    const { invocations } = collect(bus);
    const spawnFn = vi.fn();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      idFactory: () => 'inv-501',
    });

    const result = await dispatcher.run({ targetId: 'MyApi', kind: 'api', event: {} });

    expect(spawnFn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(501);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe(501);
  });

  it('threads --app / --profile / --region / -c context into the child argv', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      app: 'node bin/app.ts',
      profile: 'dev',
      region: 'us-east-1',
      context: { env: 'prod' },
      idFactory: () => 'inv-cfg',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    child.stdout.emit('data', '{}');
    child.emit('close', 0);
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv).toContain('--app');
    expect(argv).toContain('node bin/app.ts');
    expect(argv).toContain('--profile');
    expect(argv).toContain('dev');
    expect(argv).toContain('--region');
    expect(argv).toContain('us-east-1');
    expect(argv).toContain('-c');
    expect(argv).toContain('env=prod');
  });

  it('threads --from-cfn-stack <name> + --assume-role <arn> into the child argv', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      fromCfnStack: 'MyStack',
      assumeRole: 'arn:aws:iam::123456789012:role/app',
      idFactory: () => 'inv-cfn',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    child.stdout.emit('data', '{}');
    child.emit('close', 0);
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const i = argv.indexOf('--from-cfn-stack');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('MyStack');
    const j = argv.indexOf('--assume-role');
    expect(j).toBeGreaterThan(-1);
    expect(argv[j + 1]).toBe('arn:aws:iam::123456789012:role/app');
  });

  it('threads a bare --from-cfn-stack (true) with no value into the child argv', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      fromCfnStack: true,
      idFactory: () => 'inv-cfn-bare',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    child.stdout.emit('data', '{}');
    child.emit('close', 0);
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const i = argv.indexOf('--from-cfn-stack');
    expect(i).toBeGreaterThan(-1);
    // Bare flag: the next token must NOT be a stray value (it's the end or another flag).
    expect(argv[i + 1] === undefined || argv[i + 1]?.startsWith('--')).toBe(true);
    expect(argv).not.toContain('--assume-role');
  });

  it('extracts the LAST JSON line as the response even when a log line trails it', async () => {
    const bus = new StudioEventBus();
    const { invocations, logs } = collect(bus);
    const child = makeFakeChild();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      idFactory: () => 'inv-ml',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    // Realistic `cdkl invoke` stdout: synth progress + RIE START + the JSON
    // response + a trailing REPORT container-log line AFTER the response.
    child.stdout.emit(
      'data',
      'Synthesizing CDK app...\n' +
        'START RequestId: abc\n' +
        '{"statusCode":200,"body":"ok"}\n' +
        'REPORT RequestId: abc Duration: 1ms\n'
    );
    child.emit('close', 0);
    const result = await p;

    // The JSON line is the response, NOT the trailing REPORT log line.
    expect(result.response).toEqual({ statusCode: 200, body: 'ok' });
    expect(invocations[1].response).toEqual({ statusCode: 200, body: 'ok' });
    // The three non-response stdout lines are surfaced as stdout log events.
    const stdoutLogs = logs.filter((l) => l.stream === 'stdout').map((l) => l.line);
    expect(stdoutLogs).toEqual([
      'Synthesizing CDK app...',
      'START RequestId: abc',
      'REPORT RequestId: abc Duration: 1ms',
    ]);
  });

  it('rejects when spawn throws synchronously', async () => {
    const bus = new StudioEventBus();
    const spawnFn = vi.fn(() => {
      throw new Error('ENOENT: node not found');
    });
    const before = countRunDirs();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      idFactory: () => 'inv-throw',
    });

    await expect(dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} })).rejects.toThrow(
      /ENOENT/
    );
    // The temp dir created before the (failed) spawn must be cleaned up.
    expect(countRunDirs()).toBe(before);
  });

  it('rejects when the child emits an error event (failed to start)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      idFactory: () => 'inv-cerr',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    child.emit('error', new Error('spawn EACCES'));
    await expect(p).rejects.toThrow(/EACCES/);
  });

  it('removes the temp event dir after a successful run', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const before = countRunDirs();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      idFactory: () => 'inv-clean',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: { a: 1 } });
    child.stdout.emit('data', '{}');
    child.emit('close', 0);
    await p;

    expect(countRunDirs()).toBe(before);
  });
});

/** Count leftover `cdkl-studio-run-*` temp dirs (for cleanup assertions). */
function countRunDirs(): number {
  try {
    return readdirSync(tmpdir()).filter((n) => n.startsWith('cdkl-studio-run-')).length;
  } catch {
    return 0;
  }
}
