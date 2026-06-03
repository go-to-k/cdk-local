import { EventEmitter } from 'node:events';
import { readdirSync, writeFileSync } from 'node:fs';
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

  it('forwards --app <assemblyDir> (not the app command) for a single-shot invoke (issue #324)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      app: 'node bin/app.ts',
      assemblyDir: '/abs/cdk.out',
      idFactory: () => 'inv-asm',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    child.stdout.emit('data', '{}');
    child.emit('close', 0);
    await p;

    // An invoke never re-synths, so it reuses the once-synthesized assembly
    // dir rather than re-running the app command.
    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const i = argv.indexOf('--app');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('/abs/cdk.out');
    expect(argv).not.toContain('node bin/app.ts');
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

  it('materializes the env-vars per-run option into a --env-vars file arg', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      idFactory: () => 'inv-env',
    });

    const p = dispatcher.run({
      targetId: 'T',
      kind: 'lambda',
      event: {},
      options: { '--env-vars': [{ left: 'LOG_LEVEL', right: 'debug' }] },
    });
    child.stdout.emit('data', '{}');
    child.emit('close', 0);
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    const i = argv.indexOf('--env-vars');
    expect(i).toBeGreaterThan(-1);
    // The next token is a temp file path the dispatch wrote (content is
    // covered by resolveEnvVars unit tests).
    expect(argv[i + 1]).toMatch(/env-vars\.json$/);
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

  it('prefers the --response-file payload over a trailing console.log(JSON) line (issue #291)', async () => {
    const bus = new StudioEventBus();
    const { invocations, logs } = collect(bus);
    const child = makeFakeChild();

    // Capture the --response-file path the dispatcher passes and write the
    // authoritative response there, simulating what `cdkl invoke` does.
    let responsePath: string | undefined;
    const spawnFn = vi.fn((_bin: string, argv: string[]) => {
      const i = argv.indexOf('--response-file');
      responsePath = i >= 0 ? argv[i + 1] : undefined;
      return child as never;
    });

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      idFactory: () => 'inv-rf',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    // The child wrote the REAL response to the file.
    expect(responsePath).toBeDefined();
    writeFileSync(responsePath!, '{"statusCode":200,"body":"real"}');
    // stdout echoes the response AND ends with a handler's own console.log of a
    // JSON value — the exact case the last-JSON-line heuristic would mis-pick.
    child.stdout.emit(
      'data',
      'START RequestId: abc\n' +
        '{"statusCode":200,"body":"real"}\n' +
        '{"debug":"trailing handler log that is also JSON"}\n'
    );
    child.emit('close', 0);
    const result = await p;

    // The file payload wins — NOT the trailing JSON log line.
    expect(result.response).toEqual({ statusCode: 200, body: 'real' });
    expect(result.raw).toBe('{"statusCode":200,"body":"real"}');
    expect(invocations[1].response).toEqual({ statusCode: 200, body: 'real' });
    // The echoed response line is dropped from the logs; the trailing JSON log
    // line is kept (it is a real log, not the response).
    const stdoutLogs = logs.filter((l) => l.stream === 'stdout').map((l) => l.line);
    expect(stdoutLogs).toContain('{"debug":"trailing handler log that is also JSON"}');
    expect(stdoutLogs).not.toContain('{"statusCode":200,"body":"real"}');
    expect(stdoutLogs).toContain('START RequestId: abc');
  });

  it('passes --response-file for a lambda invoke but not for agentcore (issue #291)', async () => {
    const bus = new StudioEventBus();
    const lambdaChild = makeFakeChild();
    const lambdaSpawn = vi.fn(() => lambdaChild as never);
    const lambdaDispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: lambdaSpawn as never,
      clock: fixedClock(),
      idFactory: () => 'inv-l',
    });
    const lp = lambdaDispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    lambdaChild.stdout.emit('data', '{"ok":true}');
    lambdaChild.emit('close', 0);
    await lp;
    const lambdaArgv = (lambdaSpawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(lambdaArgv).toContain('--response-file');

    const agentChild = makeFakeChild();
    const agentSpawn = vi.fn(() => agentChild as never);
    const agentDispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: agentSpawn as never,
      clock: fixedClock(),
      idFactory: () => 'inv-a',
    });
    const ap = agentDispatcher.run({ targetId: 'T', kind: 'agentcore', event: {} });
    agentChild.stdout.emit('data', '{"ok":true}');
    agentChild.emit('close', 0);
    await ap;
    const agentArgv = (agentSpawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(agentArgv).not.toContain('--response-file');
  });

  it('falls back to the stdout heuristic when the response file is absent (issue #291)', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      // spawnFn does NOT write the response file — older `cdkl invoke` / a crash
      // before the write. The dispatcher must fall back to last-JSON-line.
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      idFactory: () => 'inv-fb',
    });
    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    child.stdout.emit('data', 'START RequestId: abc\n{"statusCode":200,"body":"fallback"}\n');
    child.emit('close', 0);
    const result = await p;
    expect(result.response).toEqual({ statusCode: 200, body: 'fallback' });
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

  // --- AgentCore (kind: 'agentcore') single-shot invoke (issue #301 / #303) ---

  it('spawns `cdkl invoke-agentcore <target>` and returns the parsed JSON response', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);

    const dispatcher = createStudioDispatcher({
      cliEntry: '/path/to/cli.js',
      bus,
      nodeBin: '/usr/bin/node',
      spawnFn: spawnFn as never,
      clock: fixedClock(),
      idFactory: () => 'inv-ac-1',
    });

    const p = dispatcher.run({ targetId: 'Stack/Agent', kind: 'agentcore', event: { prompt: 'hi' } });
    // A single-JSON response (e.g. an MCP / A2A JSON-RPC result) parses whole.
    child.stdout.emit('data', '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n');
    child.emit('close', 0);
    const result = await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv.slice(1, 3)).toEqual(['invoke-agentcore', 'Stack/Agent']);
    expect(argv).toContain('--event');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.response).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });

  it('keeps a multi-line streamed (SSE) AgentCore response as raw text with no stdout logs', async () => {
    const bus = new StudioEventBus();
    const { invocations, logs } = collect(bus);
    const child = makeFakeChild();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      idFactory: () => 'inv-ac-sse',
    });

    const p = dispatcher.run({ targetId: 'Agent', kind: 'agentcore', event: {} });
    // Realistic HTTP-protocol streamed output: several SSE frames on stdout.
    const sse = 'event: message\ndata: {"delta":"Hel"}\n\nevent: message\ndata: {"delta":"lo"}\n\n';
    child.stdout.emit('data', sse);
    child.emit('close', 0);
    const result = await p;

    // The whole stdout IS the response (it does not parse as one JSON value).
    expect(result.response).toBe(sse.trim());
    expect(invocations[1].response).toBe(sse.trim());
    // AgentCore stdout is the response, never split into stdout log lines.
    expect(logs.filter((l) => l.stream === 'stdout')).toHaveLength(0);
  });

  it('threads --ws / --sigv4 / --bearer-token / --session-id options into the AgentCore argv', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      idFactory: () => 'inv-ac-opts',
    });

    const p = dispatcher.run({
      targetId: 'Agent',
      kind: 'agentcore',
      event: {},
      options: {
        '--ws': true,
        '--sigv4': false,
        '--bearer-token': 'eyJabc',
        '--session-id': 'sess-42',
      },
    });
    child.stdout.emit('data', '"ok"');
    child.emit('close', 0);
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(argv).toContain('--ws'); // boolean true -> bare flag
    expect(argv).not.toContain('--sigv4'); // boolean false -> omitted
    const b = argv.indexOf('--bearer-token');
    expect(argv[b + 1]).toBe('eyJabc');
    const s = argv.indexOf('--session-id');
    expect(argv[s + 1]).toBe('sess-42');
  });

  it('surfaces a failed Lambda run\'s stdout lines as log events (failure path)', async () => {
    const bus = new StudioEventBus();
    const { logs } = collect(bus);
    const child = makeFakeChild();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      clock: fixedClock(),
      idFactory: () => 'inv-fail-stdout',
    });

    const p = dispatcher.run({ targetId: 'T', kind: 'lambda', event: {} });
    // A failing invoke can still flush container logs to stdout before exit;
    // on the failure path every stdout line is a log (none is the response).
    child.stdout.emit('data', 'START RequestId: x\nhandler threw\n');
    child.stderr.emit('data', 'Error: boom\n');
    child.emit('close', 1);
    const result = await p;

    expect(result.ok).toBe(false);
    const stdoutLogs = logs.filter((l) => l.stream === 'stdout').map((l) => l.line);
    expect(stdoutLogs).toEqual(['START RequestId: x', 'handler threw']);
  });

  it('marks a failed AgentCore invoke (non-zero exit) as 500 with the stderr error', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: (() => child) as never,
      idFactory: () => 'inv-ac-fail',
    });

    const p = dispatcher.run({ targetId: 'Agent', kind: 'agentcore', event: {} });
    child.stderr.emit('data', 'agent container exited early\n');
    child.emit('close', 1);
    const result = await p;

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain('agent container exited early');
  });

  it('tokenizes raw extra args and appends them LAST to the spawned argv', async () => {
    const bus = new StudioEventBus();
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child as never);

    const dispatcher = createStudioDispatcher({
      cliEntry: 'cli.js',
      bus,
      spawnFn: spawnFn as never,
      idFactory: () => 'inv-raw',
    });

    const p = dispatcher.run({
      targetId: 'Stack/Fn',
      kind: 'lambda',
      event: {},
      rawArgs: '--timeout 30 --memory "512 mb"',
    });
    child.stdout.emit('data', '{"ok":true}');
    child.emit('close', 0);
    await p;

    const argv = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    // Quote-aware tokenization: "512 mb" stays one argv element.
    expect(argv).toContain('--timeout');
    expect(argv).toContain('30');
    expect(argv).toContain('--memory');
    expect(argv).toContain('512 mb');
    // Raw args land at the very end of the argv (override semantics).
    expect(argv.slice(-4)).toEqual(['--timeout', '30', '--memory', '512 mb']);
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
