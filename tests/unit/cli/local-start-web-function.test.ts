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
  streamLogs: vi.fn(() => () => undefined),
  removeContainer: h.removeContainer,
}));
vi.mock('../../../src/local/web-function-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  waitForWebFunctionReady: h.ready,
  watchContainerExit: vi.fn(() => ({ exited: h.exited, stop: () => undefined })),
  containerFailure: vi.fn(async (message: string) => new Error(`${message} [last lines]`)),
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
    h.pullImage.mockClear();
    h.removeContainer.mockClear();
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
