import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

// Boots `cdkl start-microvm` against a REAL cdk.out (asset manifest + a staged
// .zip bundle) with Docker and the hook HTTP calls mocked; the front doors are
// real, so the control endpoint is driven over HTTP.

const h = vi.hoisted(() => ({
  runDetached: vi.fn(async (_opts: Record<string, unknown>) => 'cid'),
  removeContainer: vi.fn(async (_id: string) => undefined),
  streamLogs: vi.fn((..._a: unknown[]) => () => undefined),
  build: vi.fn(async (_opts: Record<string, unknown>) => 'cdkl-microvm-abc'),
  hookCalls: [] as string[],
  pollBuildHook: vi.fn(async (hook: string, ep: { port: number }) => {
    h.hookCalls.push(`${hook}@${ep.port}`);
    return 1;
  }),
  callRuntimeHook: vi.fn(async (hook: string, ep: { port: number }, _t: number, body?: string) => {
    h.hookCalls.push(`${hook}@${ep.port}${body ? ` ${body}` : ''}`);
    h.order.push(`${hook}@${ep.port}`);
  }),
  order: [] as string[],
  fdOpts: [] as Record<string, unknown>[],
  logStopCalls: 0,
  exited: [] as ((code: number) => void)[],
  artifacts: [] as { tmpDir?: string }[],
  nextPort: 41000,
}));

vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
  pickFreePort: vi.fn(async () => h.nextPort++),
  runDetached: h.runDetached,
  streamLogs: h.streamLogs,
  removeContainer: h.removeContainer,
}));
vi.mock('../../../src/local/microvm-hooks.js', async (importActual) => ({
  ...(await importActual<object>()),
  pollBuildHook: h.pollBuildHook,
  callRuntimeHook: h.callRuntimeHook,
  waitForAppAnswer: vi.fn(async () => undefined),
}));
vi.mock('../../../src/local/microvm-front-door.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/local/microvm-front-door.js')>();
  return {
    ...actual,
    startMicrovmFrontDoor: vi.fn((o: Parameters<typeof actual.startMicrovmFrontDoor>[0]) => {
      h.fdOpts.push(o as never);
      return actual.startMicrovmFrontDoor(o);
    }),
  };
});
vi.mock('../../../src/local/microvm-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  buildMicrovmImage: h.build,
  readExposedPorts: vi.fn(async () => [9000, 8080]),
}));
vi.mock('../../../src/local/web-function-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  watchContainerExit: vi.fn(() => ({
    exited: new Promise<number>((r) => h.exited.push(r)),
    stop: () => undefined,
  })),
  containerFailure: vi.fn(async (message: string) => new Error(`${message} [last lines]`)),
}));
vi.mock('../../../src/local/microvm-image.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/local/microvm-image.js')>();
  return {
    ...actual,
    resolveMicrovmCodeArtifact: vi.fn(async (...a: Parameters<typeof actual.resolveMicrovmCodeArtifact>) => {
      const art = await actual.resolveMicrovmCodeArtifact(...a);
      h.artifacts.push(art);
      return art;
    }),
  };
});

const { createLocalStartMicrovmCommand, readRunHookPayload, finalizeMicrovmEnv } = await import(
  '../../../src/cli/commands/local-start-microvm.js'
);
const { addStartMicrovmSpecificOptions } = await import('../../../src/internal.js');
const { createLocalStartMicrovmCommand: publicFactory } = await import('../../../src/index.js');
const { Command } = await import('commander');

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

let outdir: string;
let savedEnv: NodeJS.ProcessEnv;
let lines: string[];

function assembly(props: Record<string, unknown> = {}): { stacks: unknown[] } {
  writeFileSync(
    join(outdir, 'asset.abc123.zip'),
    zipSync({ Dockerfile: strToU8('FROM node:24-slim'), 'app.js': strToU8('//') })
  );
  writeFileSync(
    join(outdir, 'App.assets.json'),
    JSON.stringify({
      version: '52.0.0',
      files: {
        abc123: {
          source: { path: 'asset.abc123.zip', packaging: 'file' },
          destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
        },
      },
      dockerImages: {},
    })
  );
  return {
    stacks: [
      {
        stackName: 'App',
        displayName: 'App',
        artifactId: 'App',
        region: 'us-east-1',
        assetManifestPath: join(outdir, 'App.assets.json'),
        assetOutdir: outdir,
        dependencyNames: [],
        template: {
          Resources: {
            Img: {
              Type: 'AWS::Lambda::MicrovmImage',
              Properties: {
                Name: 'my-image',
                CodeArtifact: {
                  Uri: { 'Fn::Sub': 's3://cdk-assets-${AWS::AccountId}/abc123.zip' },
                },
                CpuConfigurations: [{ Architecture: 'ARM_64' }],
                EnvironmentVariables: [{ Key: 'GREETING', Value: 'hi' }],
                Hooks: {
                  Port: 9001,
                  MicrovmImageHooks: { Ready: 'ENABLED', Validate: 'ENABLED' },
                  MicrovmHooks: { Run: 'ENABLED', Terminate: 'ENABLED' },
                },
                ...props,
              },
            },
          },
        },
      },
    ],
  };
}

function captureConsole(): void {
  const sink = (...a: unknown[]): void => {
    lines.push(a.map(String).join(' ').replace(ANSI, ''));
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation(sink);
  }
}

const command = (asm: { stacks: unknown[] }) => {
  const cmd = createLocalStartMicrovmCommand({ synthesizer: { synthesize: async () => asm } as never });
  cmd.exitOverride();
  return cmd;
};

const READY = 'Press ^C to terminate the MicroVM(s).';

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

/** Boot to the ready banner, capturing exits; returns the run promise. */
async function boot(argv: string[], asm = assembly()) {
  captureConsole();
  const exits: number[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void exits.push(c ?? 0)) as never);
  let settled = false;
  const run = command(asm)
    .parseAsync([...argv, '--app', 'x'], { from: 'user' })
    .finally(() => (settled = true));
  await until(() => lines.includes(READY) || settled || exits.length > 0);
  return { run, exits, isSettled: () => settled };
}

const urls = () =>
  lines
    .map((l) => /listening on (http:\/\/[^ ]+)/.exec(l)?.[1])
    .filter((u): u is string => u !== undefined);

const post = (url: string): Promise<{ status: number; body: string }> =>
  new Promise((resolvePost, rejectPost) => {
    const req = request(url, { method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolvePost({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', rejectPost);
    req.end();
  });

describe('cdkl start-microvm', () => {
  let sigint: NodeJS.SignalsListener[];
  let sigterm: NodeJS.SignalsListener[];

  beforeEach(() => {
    outdir = mkdtempSync(join(tmpdir(), 'microvm-cmd-'));
    savedEnv = { ...process.env };
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) {
      delete process.env[k];
    }
    sigint = process.listeners('SIGINT');
    sigterm = process.listeners('SIGTERM');
    lines = [];
    let n = 0;
    h.runDetached.mockReset().mockImplementation(async () => `cid-${n++}`);
    h.removeContainer.mockReset().mockImplementation(async (id: string) => {
      h.order.push(`remove ${id}`);
    });
    h.streamLogs.mockReset().mockImplementation(() => () => void h.logStopCalls++);
    h.order = [];
    h.fdOpts = [];
    h.logStopCalls = 0;
    h.build.mockClear();
    h.pollBuildHook.mockClear();
    h.callRuntimeHook.mockClear();
    h.hookCalls = [];
    h.exited = [];
    h.artifacts = [];
    h.nextPort = 41000;
  });
  afterEach(async () => {
    // Close any front door still listening by terminating through teardown paths.
    for (const l of process.listeners('SIGINT')) if (!sigint.includes(l)) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.off('SIGTERM', l);
    vi.restoreAllMocks();
    process.env = savedEnv;
    for (const a of h.artifacts) if (a.tmpDir) rmSync(a.tmpDir, { recursive: true, force: true });
    rmSync(outdir, { recursive: true, force: true });
  });

  const fireSignal = (sig: 'SIGINT' | 'SIGTERM') => {
    const fresh = process.listeners(sig).filter((l) => !(sig === 'SIGINT' ? sigint : sigterm).includes(l));
    (fresh[fresh.length - 1] as () => void)();
  };

  it('--count 2 runs two containers, each driven ready -> validate -> run with its own id and URL', async () => {
    await boot(['Img', '--count', '2', '--run-hook-payload', 'tenant-a']);
    expect(lines).toContain(READY);
    expect(h.build).toHaveBeenCalledTimes(1);
    expect(h.build.mock.calls[0]![0]).toMatchObject({ platform: 'linux/arm64', noCache: false });
    expect(h.runDetached).toHaveBeenCalledTimes(2);
    const first = h.runDetached.mock.calls[0]![0] as Record<string, unknown>;
    expect(first).toMatchObject({
      image: 'cdkl-microvm-abc',
      containerPort: 8080,
      hostPort: 41000,
      extraPorts: [
        { hostPort: 41001, containerPort: 9001 },
        { hostPort: 41002, containerPort: 9000 },
      ],
      host: '127.0.0.1',
      platform: 'linux/arm64',
      autoRemove: false,
      cmd: [],
      mounts: [],
    });
    expect(first['name']).toMatch(new RegExp(`^cdkl-microvm-${process.pid}-0-[a-z0-9]+$`));
    const env = first['env'] as Record<string, string>;
    expect(env['GREETING']).toBe('hi');
    expect(env['AWS_REGION']).toBe('us-east-1');
    expect(env['AWS_LAMBDA_FUNCTION_NAME']).toBeUndefined();

    const ids = lines.map((l) => /MicroVM (mvm-[0-9a-f-]+) listening/.exec(l)?.[1]).filter(Boolean);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(urls()).toHaveLength(2);
    expect(urls()[0]).not.toBe(urls()[1]);
    // Hooks go to each container's published hooks port, in the cloud's order.
    expect(h.hookCalls).toEqual([
      'ready@41001',
      'validate@41001',
      `run@41001 {"microvmId":"${ids[0]}","runHookPayload":"tenant-a"}`,
      'ready@41004',
      'validate@41004',
      `run@41004 {"microvmId":"${ids[1]}","runHookPayload":"tenant-a"}`,
    ]);
    // Each MicroVM's output lines are tagged with its id.
    expect(h.streamLogs.mock.calls[0]![1]).toMatchObject({ prefix: `[${ids[0]!.slice(0, 12)}] ` });
    fireSignal('SIGTERM');
    await until(() => h.removeContainer.mock.calls.length === 2);
  });

  it('SIGTERM calls /terminate on every MicroVM before removing it, then exits 0', async () => {
    const { exits } = await boot(['Img', '--count', '2']);
    h.hookCalls = [];
    fireSignal('SIGTERM');
    await until(() => exits.length > 0);
    expect(exits).toEqual([0]);
    // Each MicroVM's /terminate runs before its container is removed.
    const tail = h.order.slice(-4);
    expect(tail.indexOf('terminate@41001')).toBeLessThan(tail.indexOf('remove cid-0'));
    expect(tail.indexOf('terminate@41004')).toBeLessThan(tail.indexOf('remove cid-1'));
    expect([...tail].sort()).toEqual(['remove cid-0', 'remove cid-1', 'terminate@41001', 'terminate@41004']);
    expect(existsSync(h.artifacts[0]!.tmpDir!)).toBe(false);
  });

  it('the control endpoint terminating the last MicroVM ends the command cleanly', async () => {
    const { run, exits } = await boot(['Img']);
    const res = await post(`${urls()[0]}/_cdkl/microvm/terminate`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ state: 'terminated' });
    await run;
    expect(exits).toEqual([]);
    expect(lines).toContain('Every MicroVM is terminated; shutting down.');
    expect(h.removeContainer).toHaveBeenCalledWith('cid-0');
  });

  it('a hook failure tears down and fails non-zero with the container output', async () => {
    h.pollBuildHook.mockRejectedValueOnce(
      new (await import('../../../src/local/microvm-hooks.js')).MicrovmHookError('ready never 200')
    );
    const { exits, isSettled } = await boot(['Img']);
    await until(() => isSettled());
    expect(exits).toEqual([1]);
    expect(lines.join('\n')).toMatch(/ready never 200 \[last lines\]/);
    expect(h.removeContainer).toHaveBeenCalledWith('cid-0');
    // It never reached RUNNING, so its /terminate hook is not called.
    expect(h.hookCalls).not.toContain('terminate@41001');
    expect(existsSync(h.artifacts[0]!.tmpDir!)).toBe(false);
  });

  it('a container that exits while running fails the command non-zero', async () => {
    const { exits, isSettled } = await boot(['Img']);
    h.exited[0]!(137);
    await until(() => isSettled());
    expect(exits).toEqual([1]);
    expect(lines.join('\n')).toMatch(/container exited \(exit code 137\) while running/);
    expect(h.removeContainer).toHaveBeenCalledWith('cid-0');
  });

  it('--platform wins over the image architecture; --no-build-cache builds with no cache', async () => {
    await boot(['Img', '--platform', 'linux/amd64', '--no-build-cache']);
    expect(h.build.mock.calls[0]![0]).toMatchObject({ platform: 'linux/amd64', noCache: true });
    expect(h.runDetached.mock.calls[0]![0]).toMatchObject({ platform: 'linux/amd64' });
    fireSignal('SIGTERM');
    await until(() => h.removeContainer.mock.calls.length === 1);
  });

  it('--port gives MicroVM i the port base+i', async () => {
    const base = 47613;
    await boot(['Img', '--count', '2', '--port', String(base)]);
    expect(urls()).toEqual([`http://127.0.0.1:${base}`, `http://127.0.0.1:${base + 1}`]);
    fireSignal('SIGTERM');
    await until(() => h.removeContainer.mock.calls.length === 2);
  });

  it('warns once about every behavior it does not emulate', async () => {
    await boot(['Img'], assembly({ EgressNetworkConnectors: ['arn:x'] }));
    const warns = lines.filter((l) => l.startsWith('WARN'));
    expect(warns.filter((l) => l.includes('is NOT shared across MicroVMs'))).toHaveLength(1);
    expect(warns.some((l) => l.includes('without X-aws-proxy-auth'))).toBe(true);
    expect(warns.some((l) => l.includes('idle policy is not emulated'))).toBe(true);
    expect(warns.some((l) => l.includes('/validate is called on the same container'))).toBe(true);
    expect(warns.some((l) => l.includes('EgressNetworkConnectors'))).toBe(true);
    // BaseImageArn is always warned: the build never runs on the managed base OS.
    expect(warns.some((l) => l.includes('(BaseImageArn)'))).toBe(true);
    fireSignal('SIGTERM');
    await until(() => h.removeContainer.mock.calls.length === 1);
  });

  it('refuses an oversized run payload before touching Docker', async () => {
    const { exits, isSettled } = await boot(['Img', '--run-hook-payload', 'x'.repeat(16 * 1024 + 1)]);
    await until(() => isSettled());
    expect(exits).toEqual([1]);
    expect(lines.join('\n')).toMatch(/run hook payload is 16385 bytes; run-microvm accepts at most 16384/);
    expect(h.runDetached).not.toHaveBeenCalled();
  });

  it('wires --auto-resume into every front door (off by default)', async () => {
    await boot(['Img', '--count', '2', '--auto-resume']);
    expect(h.fdOpts.map((o) => o['autoResume'])).toEqual([true, true]);
    fireSignal('SIGTERM');
    await until(() => h.removeContainer.mock.calls.length === 2);
    h.fdOpts = [];
    lines = [];
    await boot(['Img']);
    expect(h.fdOpts.map((o) => o['autoResume'])).toEqual([false]);
    fireSignal('SIGTERM');
    await until(() => h.removeContainer.mock.calls.length === 3);
  });

  it('--count 2: terminating ONE through control keeps the command (and the other) running', async () => {
    const { exits, isSettled } = await boot(['Img', '--count', '2']);
    expect((await post(`${urls()[0]}/_cdkl/microvm/terminate`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(isSettled()).toBe(false);
    expect(exits).toEqual([]);
    expect(h.removeContainer.mock.calls.map((c) => c[0])).toEqual(['cid-0']);
    fireSignal('SIGTERM');
    await until(() => exits.length > 0);
  });

  it('terminating the first MicroVM while the second is still in docker run does not end the command', async () => {
    let releaseRun: (id: string) => void = () => undefined;
    h.runDetached.mockReset()
      .mockImplementationOnce(async () => 'cid-0')
      .mockImplementationOnce(() => new Promise<string>((r) => (releaseRun = r)));
    captureConsole();
    const exits: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void exits.push(c ?? 0)) as never);
    let settled = false;
    void command(assembly())
      .parseAsync(['Img', '--count', '2', '--app', 'x'], { from: 'user' })
      .finally(() => (settled = true));
    await until(() => h.runDetached.mock.calls.length === 2);
    expect((await post(`${urls()[0]}/_cdkl/microvm/terminate`)).status).toBe(200);
    releaseRun('cid-1');
    await until(() => lines.includes(READY));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(h.removeContainer.mock.calls.map((c) => c[0])).toEqual(['cid-0']);
    fireSignal('SIGTERM');
    await until(() => exits.length > 0);
  });

  it('a SIGTERM during docker run removes the container that run then creates', async () => {
    let releaseRun: (id: string) => void = () => undefined;
    h.runDetached.mockReset().mockImplementation(() => new Promise<string>((r) => (releaseRun = r)));
    captureConsole();
    const exits: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void exits.push(c ?? 0)) as never);
    void command(assembly()).parseAsync(['Img', '--app', 'x'], { from: 'user' });
    await until(() => h.runDetached.mock.calls.length > 0);
    fireSignal('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([]); // waits for the in-flight run
    releaseRun('cid-late');
    await until(() => exits.length > 0);
    expect(exits).toEqual([0]);
    expect(h.removeContainer).toHaveBeenCalledWith('cid-late');
    expect(h.pollBuildHook).not.toHaveBeenCalled();
  });

  it('a second signal while teardown waits on docker run exits at once, naming the container', async () => {
    h.runDetached.mockReset().mockImplementation(() => new Promise<string>(() => undefined));
    captureConsole();
    const exits: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void exits.push(c ?? 0)) as never);
    void command(assembly()).parseAsync(['Img', '--app', 'x'], { from: 'user' });
    await until(() => h.runDetached.mock.calls.length > 0);
    fireSignal('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([]);
    fireSignal('SIGINT');
    await until(() => exits.length > 0);
    expect(exits).toEqual([130]);
    const name = (h.runDetached.mock.calls[0]![0] as { name: string }).name;
    expect(lines.some((l) => l.includes(`docker rm -f ${name}`))).toBe(true);
  });

  it('a second signal while containers are being removed is ignored until removal finishes', async () => {
    let finishRemove: () => void = () => undefined;
    const { exits } = await boot(['Img']);
    h.removeContainer.mockImplementation(() => new Promise<undefined>((r) => (finishRemove = () => r(undefined))));
    fireSignal('SIGINT');
    await until(() => h.removeContainer.mock.calls.length > 0);
    fireSignal('SIGINT');
    fireSignal('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([]);
    expect(lines.some((l) => l.includes('still terminating the MicroVMs'))).toBe(true);
    finishRemove();
    await until(() => exits.length > 0);
    expect(exits).toEqual([130]);
  });

  it('a ^C during a failure teardown joins the SAME teardown (log streams stopped once)', async () => {
    h.pollBuildHook.mockRejectedValueOnce(new Error('ready broke'));
    let finishRemove: () => void = () => undefined;
    h.removeContainer.mockImplementation(() => new Promise<undefined>((r) => (finishRemove = () => r(undefined))));
    captureConsole();
    const exits: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void exits.push(c ?? 0)) as never);
    void command(assembly()).parseAsync(['Img', '--app', 'x'], { from: 'user' });
    await until(() => h.removeContainer.mock.calls.length > 0);
    fireSignal('SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([]);
    finishRemove();
    await until(() => exits.includes(130));
    expect(h.logStopCalls).toBe(1);
  });

  it('is exported from the public entry, with its option helper on the internal one', () => {
    expect(publicFactory).toBe(createLocalStartMicrovmCommand);
    const cmd = addStartMicrovmSpecificOptions(new Command('host'));
    expect(cmd.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        '--count',
        '--run-hook-payload',
        '--run-hook-payload-file',
        '--port',
        '--host',
        '--platform',
        '--proxy-port',
        '--auto-resume',
        '--no-build-cache',
        '--env-vars',
        '--timeout',
        '--assume-role',
        '--from-cfn-stack',
        '--stack-region',
      ])
    );
  });
});

describe('readRunHookPayload', () => {
  it('reads the inline value or the file, and refuses both at once', () => {
    expect(readRunHookPayload({ runHookPayload: 'a' })).toBe('a');
    expect(readRunHookPayload({ runHookPayloadFile: 'p' }, () => 'from-file')).toBe('from-file');
    expect(readRunHookPayload({})).toBeUndefined();
    expect(() => readRunHookPayload({ runHookPayload: 'a', runHookPayloadFile: 'p' })).toThrow(
      /mutually exclusive/
    );
    expect(() =>
      readRunHookPayload({ runHookPayloadFile: 'p' }, () => {
        throw new Error('ENOENT');
      })
    ).toThrow(/Cannot read --run-hook-payload-file p: ENOENT/);
  });
});

describe('finalizeMicrovmEnv', () => {
  it('drops the Lambda-function runtime variables unless the image declares them', () => {
    expect(
      finalizeMicrovmEnv(
        { AWS_LAMBDA_FUNCTION_NAME: 'Img', AWS_LAMBDA_LOG_STREAM_NAME: 'local', AWS_REGION: 'r', A: '1' },
        { A: '1', AWS_LAMBDA_LOG_STREAM_NAME: 'mine' }
      )
    ).toEqual({ AWS_LAMBDA_LOG_STREAM_NAME: 'local', AWS_REGION: 'r', A: '1' });
  });
});
