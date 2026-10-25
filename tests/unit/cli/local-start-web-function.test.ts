import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

// Boots `cdkl start-web-function` against a REAL cdk.out (asset manifest + a
// staged .zip bundle) with every Docker seam mocked, so the target -> artifact
// -> runtime -> env -> container -> lifecycle wiring is asserted end to end
// without a daemon.

const h = vi.hoisted(() => ({
  runDetached: vi.fn(async (_opts: Record<string, unknown>) => 'cid-web'),
  pullImage: vi.fn(async (..._a: unknown[]) => undefined),
  removeContainer: vi.fn(async (_id: string) => undefined),
  streamLogs: vi.fn((..._a: unknown[]) => () => undefined),
  failureCodes: [] as unknown[],
  ready: vi.fn(async (_args: Record<string, unknown>) => undefined),
  exited: new Promise<number | undefined>(() => undefined),
  envCalls: [] as unknown[][],
  artifacts: [] as { kind: string; tmpDir?: string }[],
}));

vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
  pickFreePort: vi.fn(async () => 40123),
  pullImage: h.pullImage,
  runDetached: h.runDetached,
  streamLogs: h.streamLogs,
  removeContainer: h.removeContainer,
}));
vi.mock('../../../src/local/web-function-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  waitForWebFunctionReady: h.ready,
  watchContainerExit: vi.fn(() => ({ exited: h.exited, stop: () => undefined })),
  containerFailure: vi.fn(async (message: string, ...rest: unknown[]) => {
    h.failureCodes.push(rest[3]);
    return new Error(`${message} [last lines]`);
  }),
}));
vi.mock('../../../src/local/web-function-artifact.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/local/web-function-artifact.js')>();
  return {
    ...actual,
    resolveWebFunctionArtifact: vi.fn(async (...a: Parameters<typeof actual.resolveWebFunctionArtifact>) => {
      const art = await actual.resolveWebFunctionArtifact(...a);
      h.artifacts.push(art as never);
      return art;
    }),
  };
});
vi.mock('../../../src/cli/commands/local-invoke.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/cli/commands/local-invoke.js')>();
  return {
    ...actual,
    resolveLambdaContainerEnv: vi.fn(async (...a: Parameters<typeof actual.resolveLambdaContainerEnv>) => {
      h.envCalls.push(a);
      return actual.resolveLambdaContainerEnv(...a);
    }),
  };
});

const { createLocalStartWebFunctionCommand } = await import(
  '../../../src/cli/commands/local-start-web-function.js'
);
const { addStartWebFunctionSpecificOptions } = await import('../../../src/internal.js');
const { createLocalStartWebFunctionCommand: publicFactory } = await import('../../../src/index.js');
const { Command } = await import('commander');

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

let outdir: string;
let savedEnv: NodeJS.ProcessEnv;
let lines: string[];

function assembly(
  opts: { endpoint?: Record<string, unknown>; v2Env?: Record<string, string>; runtime?: string } = {}
): { stacks: unknown[] } {
  writeFileSync(
    join(outdir, 'asset.abc123.zip'),
    zipSync({ 'index.js': strToU8('// server'), 'alt.js': strToU8('// alt') })
  );
  writeFileSync(
    join(outdir, 'App.assets.json'),
    JSON.stringify({
      version: '52.0.0',
      files: {
        abc123: {
          displayName: 'Code',
          source: { path: 'asset.abc123.zip', packaging: 'file' },
          destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
        },
      },
      dockerImages: {},
    })
  );
  const revision = (env: Record<string, string>) => ({
    Type: 'AWS::Lambda::WebFunctionRevision',
    Properties: {
      FunctionName: { Ref: 'WebFn' },
      BuildConfig: {
        CodeConfig: {
          S3Object: {
            Bucket: { 'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}' },
            Key: 'abc123.zip',
          },
        },
        RuntimeConfig: { Runtime: opts.runtime ?? 'nodejs24.x' },
      },
      ServiceConfig: {
        ExecutionRoleArn: { 'Fn::GetAtt': ['Role', 'Arn'] },
        EnvironmentVariables: env,
      },
    },
  });
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
            Role: { Type: 'AWS::IAM::Role', Properties: {} },
            WebFn: { Type: 'AWS::Lambda::WebFunction', Properties: { FunctionName: 'my-web' } },
            RevV1: revision({ GREETING: 'from-v1', AWS_LAMBDA_NODEJS_ENTRYPOINT: 'alt.js' }),
            RevV2: revision({ GREETING: 'from-v2', ...opts.v2Env }),
            Ep: {
              Type: 'AWS::Lambda::WebFunctionEndpoint',
              Properties: {
                FunctionName: { Ref: 'WebFn' },
                EndpointName: 'main',
                EndpointType: 'HomeRegion',
                AuthType: 'ApplicationManaged',
                RevisionWeights: [
                  { RevisionId: { 'Fn::GetAtt': ['RevV1', 'RevisionId'] }, Weight: 20 },
                  { RevisionId: { 'Fn::GetAtt': ['RevV2', 'RevisionId'] }, Weight: 80 },
                ],
                ...opts.endpoint,
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

function command(asm: { stacks: unknown[] }) {
  const cmd = createLocalStartWebFunctionCommand({
    synthesizer: { synthesize: async () => asm } as never,
  });
  cmd.exitOverride();
  return cmd;
}

/** Boot to the ready banner (the command then blocks, by design). */
async function boot(argv: string[], asm = assembly()): Promise<string[]> {
  captureConsole();
  void command(asm)
    .parseAsync([...argv, '--app', 'x'], { from: 'user' })
    .catch((err: unknown) => lines.push(`THREW: ${err instanceof Error ? err.message : String(err)}`));
  for (
    let i = 0;
    i < 400 && !lines.includes('Press ^C to shut down.') && !lines.some((l) => l.startsWith('THREW'));
    i++
  ) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return lines;
}

/** Run to completion (a failure path): the error handler's exit is stubbed. */
async function runToFailure(argv: string[], asm = assembly()): Promise<number | undefined> {
  captureConsole();
  let code: number | undefined;
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
  }) as never);
  await command(asm).parseAsync([...argv, '--app', 'x'], { from: 'user' });
  return code;
}

const runOpts = () =>
  h.runDetached.mock.calls[0]![0] as {
    env: Record<string, string>;
    cmd: string[];
    entryPoint: string[];
    mounts: { hostPath: string }[];
    platform: string;
    name: string;
    host: string;
    hostPort: number;
    containerPort: number;
    autoRemove: boolean;
  };

describe('cdkl start-web-function', () => {
  let sigint: NodeJS.SignalsListener[];
  let sigterm: NodeJS.SignalsListener[];

  beforeEach(() => {
    outdir = mkdtempSync(join(tmpdir(), 'webfn-cmd-'));
    savedEnv = { ...process.env };
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) {
      delete process.env[k];
    }
    sigint = process.listeners('SIGINT');
    sigterm = process.listeners('SIGTERM');
    lines = [];
    h.runDetached.mockReset().mockResolvedValue('cid-web');
    h.ready.mockReset().mockResolvedValue(undefined);
    h.pullImage.mockReset().mockResolvedValue(undefined);
    h.removeContainer.mockReset().mockResolvedValue(undefined);
    h.streamLogs.mockReset().mockReturnValue(() => undefined);
    h.failureCodes = [];
    h.exited = new Promise(() => undefined);
    h.envCalls = [];
    h.artifacts = [];
  });
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) if (!sigint.includes(l)) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.off('SIGTERM', l);
    vi.restoreAllMocks();
    process.env = savedEnv;
    for (const a of h.artifacts) if (a.tmpDir) rmSync(a.tmpDir, { recursive: true, force: true });
    rmSync(outdir, { recursive: true, force: true });
  });

  it('serves the highest-weight revision of an endpoint, with its ServiceConfig env', async () => {
    await boot(['App:Ep']);
    expect(lines).toContain('Server listening on http://127.0.0.1:40123  (my-web (Lambda web function))');
    expect(
      lines.some((l) =>
        l.includes('Target: App/RevV2 (nodejs24.x; revision chosen by highest weight on endpoint Ep)')
      )
    ).toBe(true);
    const opts = runOpts();
    expect(opts.env['GREETING']).toBe('from-v2');
    expect(opts.env['AWS_LAMBDA_HTTP_ENDPOINT']).toBe('0.0.0.0:8080');
    expect(opts.env['AWS_LAMBDA_FUNCTION_NAME']).toBe('my-web');
    expect(opts.env['AWS_REGION']).toBe('us-east-1');
    expect(opts.entryPoint).toEqual(['/var/lang/bin/node']);
    expect(opts.cmd).toEqual(['/var/task/index.js']);
    expect(opts.mounts[0]!.hostPath).toBe(h.artifacts[0]!.tmpDir);
    expect(opts.platform).toBe('linux/arm64');
    expect(opts.name).toMatch(/^cdkl-webfn-/);
    expect(opts.autoRemove).toBe(false);
    expect(opts.hostPort).toBe(40123);
    expect(opts.containerPort).toBe(8080);
    expect(h.pullImage).toHaveBeenCalledWith('public.ecr.aws/lambda/nodejs:24', false, 'linux/arm64');
    expect(lines.filter((l) => l.includes('weighted routing is not emulated'))).toHaveLength(1);
  });

  it('hands the readiness wait the picked port, the timeout and the label', async () => {
    await boot(['App:Ep', '--timeout', '1234']);
    expect(h.ready).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: 'cid-web',
        host: '127.0.0.1',
        port: 40123,
        timeoutMs: 1234,
        label: 'index.js',
      })
    );
  });

  it('probes a wildcard bind through its loopback address', async () => {
    await boot(['App:Ep', '--host', '0.0.0.0']);
    expect(runOpts().host).toBe('0.0.0.0');
    expect(h.ready.mock.calls[0]![0]).toMatchObject({ host: '127.0.0.1' });
    expect(lines).toContain('Server listening on http://127.0.0.1:40123  (my-web (Lambda web function))');
  });

  it('probes an IPv6 wildcard bind through ::1', async () => {
    await boot(['App:Ep', '--host', '::']);
    expect(h.ready.mock.calls[0]![0]).toMatchObject({ host: '::1' });
  });

  it('passes assumeRole and deployedFunctionLookups: false into the env resolver', async () => {
    await boot(['App:Ep', '--assume-role']);
    const [view, options] = h.envCalls[0] as [
      { resource: { Properties: Record<string, unknown> } },
      Record<string, unknown>,
    ];
    expect(options['assumeRole']).toBe(true);
    expect(options['deployedFunctionLookups']).toBe(false);
    expect(view.resource.Properties['Role']).toEqual({ 'Fn::GetAtt': ['Role', 'Arn'] });
  });

  it("--revision overrides the weights and honours that revision's entrypoint env", async () => {
    await boot(['App:Ep', '--revision', 'RevV1', '--port', '18460', '--no-pull']);
    expect(lines).toContain('Server listening on http://127.0.0.1:18460  (my-web (Lambda web function))');
    expect(runOpts().env['GREETING']).toBe('from-v1');
    expect(runOpts().cmd).toEqual(['/var/task/alt.js']);
    expect(h.pullImage).toHaveBeenCalledWith('public.ecr.aws/lambda/nodejs:24', true, 'linux/arm64');
  });

  it('warns that a declared AWS_LAMBDA_HTTP_ENDPOINT is replaced', async () => {
    await boot(['App:Ep'], assembly({ v2Env: { AWS_LAMBDA_HTTP_ENDPOINT: '127.0.0.1:9' } }));
    expect(runOpts().env['AWS_LAMBDA_HTTP_ENDPOINT']).toBe('0.0.0.0:8080');
    expect(
      lines.some((l) =>
        l.includes(
          "The revision's AWS_LAMBDA_HTTP_ENDPOINT is replaced with 0.0.0.0:8080: the runtime owns that variable"
        )
      )
    ).toBe(true);
  });

  it('warns once that a non-ApplicationManaged auth type is not enforced, and still serves', async () => {
    await boot(['App:Ep'], assembly({ endpoint: { AuthType: 'AwsIam' } }));
    expect(lines.filter((l) => l.includes('AuthType AwsIam; it is not enforced locally'))).toHaveLength(1);
    expect(lines).toContain('Press ^C to shut down.');
  });

  it('removes the container and the extracted bundle when readiness fails', async () => {
    h.ready.mockRejectedValue(new Error('server never answered'));
    const code = await runToFailure(['App:Ep']);
    expect(code).toBe(1);
    expect(h.removeContainer).toHaveBeenCalledWith('cid-web');
    expect(h.artifacts[0]!.tmpDir).toBeDefined();
    expect(existsSync(h.artifacts[0]!.tmpDir!)).toBe(false);
    expect(lines.join('\n')).toMatch(/server never answered/);
  });

  it('removes the extracted bundle when docker run fails (no container to remove)', async () => {
    h.runDetached.mockRejectedValue(new Error('docker run failed: boom'));
    const code = await runToFailure(['App:Ep']);
    expect(code).toBe(1);
    expect(h.removeContainer).not.toHaveBeenCalled();
    expect(existsSync(h.artifacts[0]!.tmpDir!)).toBe(false);
  });

  it('fails non-zero, tearing down, when the server exits while serving', async () => {
    h.exited = Promise.resolve(1);
    const code = await runToFailure(['App:Ep']);
    expect(code).toBe(1);
    expect(h.removeContainer).toHaveBeenCalledWith('cid-web');
    expect(existsSync(h.artifacts[0]!.tmpDir!)).toBe(false);
    expect(lines.join('\n')).toMatch(/container exited \(exit code 1\) while serving\. \[last lines\]/);
  });

  it('reports an exit while serving with its own error code', async () => {
    h.exited = Promise.resolve(3);
    await runToFailure(['App:Ep']);
    expect(h.failureCodes).toEqual(['LOCAL_START_WEB_FUNCTION_EXITED']);
  });

  it('tears down when streamLogs throws synchronously', async () => {
    h.streamLogs.mockImplementation(() => {
      throw new Error('spawn docker ENOENT');
    });
    const code = await runToFailure(['App:Ep']);
    expect(code).toBe(1);
    expect(h.removeContainer).toHaveBeenCalledWith('cid-web');
    expect(existsSync(h.artifacts[0]!.tmpDir!)).toBe(false);
  });

  it('lets --platform win over the runtime row default', async () => {
    await boot(['App:Ep', '--platform', 'linux/amd64']);
    expect(runOpts().platform).toBe('linux/amd64');
    expect(h.pullImage).toHaveBeenCalledWith('public.ecr.aws/lambda/nodejs:24', false, 'linux/amd64');
  });

  /** Drive the command with the signal handlers it registers captured, not emitted. */
  async function withSignals(argv: string[]) {
    captureConsole();
    const exits: { code: number | undefined; tmpGone: boolean }[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      const tmp = h.artifacts[0]?.tmpDir;
      exits.push({ code: c, tmpGone: tmp !== undefined && !existsSync(tmp) });
    }) as never);
    const run = command(assembly()).parseAsync([...argv, '--app', 'x'], { from: 'user' });
    const handler = async (sig: 'SIGINT' | 'SIGTERM') => {
      for (let i = 0; i < 400; i++) {
        const fresh = process.listeners(sig).filter((l) => !(sig === 'SIGINT' ? sigint : sigterm).includes(l));
        if (fresh.length > 0) return fresh[fresh.length - 1]!;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('no handler');
    };
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    };
    return { exits, run, handler, until };
  }

  it('a SIGTERM during docker run removes the container that run then creates', async () => {
    let finishRun: (id: string) => void = () => undefined;
    h.runDetached.mockImplementation(() => new Promise<string>((r) => (finishRun = r)));
    const { exits, handler, until } = await withSignals(['App:Ep']);
    await until(() => h.runDetached.mock.calls.length > 0);
    const onTerm = await handler('SIGTERM');
    (onTerm as () => void)();
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([]); // still waiting for the in-flight run
    finishRun('cid-late');
    await until(() => exits.length > 0);
    expect(h.removeContainer).toHaveBeenCalledWith('cid-late');
    expect(exits[0]).toEqual({ code: 0, tmpGone: true });
    // The main path must not go on to serve the container teardown removes.
    expect(h.streamLogs).not.toHaveBeenCalled();
    expect(h.ready).not.toHaveBeenCalled();
  });

  it('a signal during the image pull starts no container afterwards', async () => {
    let finishPull: () => void = () => undefined;
    h.pullImage.mockImplementation(() => new Promise<undefined>((r) => (finishPull = () => r(undefined))));
    const { exits, handler, until } = await withSignals(['App:Ep']);
    await until(() => h.pullImage.mock.calls.length > 0);
    ((await handler('SIGTERM')) as () => void)();
    await until(() => exits.length > 0);
    expect(exits[0]).toEqual({ code: 0, tmpGone: true });
    finishPull();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.runDetached).not.toHaveBeenCalled();
  });

  it('a second signal while teardown waits on docker run exits immediately', async () => {
    h.runDetached.mockImplementation(() => new Promise<string>(() => undefined));
    const { exits, handler, until } = await withSignals(['App:Ep']);
    await until(() => h.runDetached.mock.calls.length > 0);
    ((await handler('SIGTERM')) as () => void)();
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([]);
    ((await handler('SIGINT')) as () => void)();
    await until(() => exits.length > 0);
    expect(exits[0]!.code).toBe(130);
    const warn = lines.find((l) => l.includes('again; exiting without waiting for docker run'));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/may still be starting, and its environment holds the forwarded AWS credentials/);
    expect(warn).toContain('docker ps -a --filter name=cdkl-webfn- -q | xargs -r docker rm -f');
    expect(warn).toContain(`Also remove the extracted code bundle: ${h.artifacts[0]!.tmpDir}`);
  });

  it('a second SIGTERM on the abandoned path exits 143, never 0', async () => {
    h.runDetached.mockImplementation(() => new Promise<string>(() => undefined));
    const { exits, handler, until } = await withSignals(['App:Ep']);
    await until(() => h.runDetached.mock.calls.length > 0);
    const onTerm = (await handler('SIGTERM')) as () => void;
    onTerm();
    await new Promise((r) => setTimeout(r, 10));
    onTerm();
    await until(() => exits.length > 0);
    expect(exits[0]!.code).toBe(143);
  });

  it('a second signal while the container is being removed waits for removal and dispose', async () => {
    let finishRemove: () => void = () => undefined;
    h.removeContainer.mockImplementation(
      () => new Promise<undefined>((r) => (finishRemove = () => r(undefined)))
    );
    const { exits, handler, until } = await withSignals(['App:Ep']);
    await until(() => lines.includes('Press ^C to shut down.'));
    ((await handler('SIGINT')) as () => void)();
    await until(() => h.removeContainer.mock.calls.length > 0);
    ((await handler('SIGINT')) as () => void)();
    ((await handler('SIGTERM')) as () => void)();
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([]); // ignored: the docker rm -f must finish
    expect(lines.some((l) => l.includes('still removing the container'))).toBe(true);
    finishRemove();
    await until(() => exits.length > 0);
    expect(exits).toEqual([{ code: 130, tmpGone: true }]);
  });

  it('a ^C during a failure teardown waits for the SAME teardown before exiting', async () => {
    h.ready.mockRejectedValue(new Error('never ready'));
    let finishRemove: () => void = () => undefined;
    h.removeContainer.mockImplementation(() => new Promise<undefined>((r) => (finishRemove = () => r(undefined))));
    const { exits, handler, until } = await withSignals(['App:Ep']);
    await until(() => h.removeContainer.mock.calls.length > 0);
    const onInt = await handler('SIGINT');
    (onInt as () => void)();
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([]); // the ^C must not exit mid-teardown
    finishRemove();
    await until(() => exits.some((e) => e.code === 130));
    expect(h.removeContainer).toHaveBeenCalledTimes(1);
    expect(exits.every((e) => e.tmpGone)).toBe(true);
  });

  it('fails on an unknown runtime before touching Docker', async () => {
    const code = await runToFailure(['App:Ep'], assembly({ runtime: 'python3.13' }));
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/python3\.13 is not supported.*Supported: nodejs24\.x/);
    expect(h.runDetached).not.toHaveBeenCalled();
  });

  it('is exported from the public entry, with its option helper on the internal one', () => {
    expect(publicFactory).toBe(createLocalStartWebFunctionCommand);
    const cmd = addStartWebFunctionSpecificOptions(new Command('host'));
    expect(cmd.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        '--revision',
        '--port',
        '--host',
        '--platform',
        '--env-vars',
        '--no-pull',
        '--timeout',
        '--assume-role',
        '--from-cfn-stack',
        '--stack-region',
      ])
    );
  });
});
