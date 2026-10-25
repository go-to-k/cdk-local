import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Boots `cdkl start-web-function` to its ready banner against a REAL cdk.out
// (asset manifest + staged bundle) with every Docker seam mocked, so the
// target -> artifact -> runtime -> env -> container wiring is asserted end to
// end without a daemon.

const docker = vi.hoisted(() => ({
  runDetached: vi.fn(async (_opts: Record<string, unknown>) => 'cid-web'),
  pullImage: vi.fn(async () => undefined),
  removeContainer: vi.fn(async () => undefined),
  ready: vi.fn(async () => undefined),
}));

vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
  pickFreePort: vi.fn(async () => 40123),
  pullImage: docker.pullImage,
  runDetached: docker.runDetached,
  streamLogs: vi.fn(() => () => undefined),
  removeContainer: docker.removeContainer,
}));
vi.mock('../../../src/local/web-function-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  waitForWebFunctionReady: docker.ready,
}));

const { createLocalStartWebFunctionCommand } = await import(
  '../../../src/cli/commands/local-start-web-function.js'
);
const { addStartWebFunctionSpecificOptions } = await import('../../../src/internal.js');
const { createLocalStartWebFunctionCommand: publicFactory } = await import(
  '../../../src/index.js'
);
const { Command } = await import('commander');

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

let outdir: string;
let savedEnv: NodeJS.ProcessEnv;

function writeAssembly(endpointExtra: Record<string, unknown> = {}): { stacks: unknown[] } {
  mkdirSync(join(outdir, 'asset.abc123'), { recursive: true });
  writeFileSync(join(outdir, 'asset.abc123', 'index.js'), '// server');
  writeFileSync(join(outdir, 'asset.abc123', 'alt.js'), '// alt server');
  writeFileSync(
    join(outdir, 'App.assets.json'),
    JSON.stringify({
      version: '52.0.0',
      files: {
        abc123: {
          displayName: 'Code',
          source: { path: 'asset.abc123', packaging: 'zip' },
          destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
        },
      },
      dockerImages: {},
    })
  );
  const revision = (greeting: string, extraEnv: Record<string, string> = {}) => ({
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
        RuntimeConfig: { Runtime: 'nodejs24.x' },
      },
      ServiceConfig: {
        ExecutionRoleArn: { 'Fn::GetAtt': ['Role', 'Arn'] },
        EnvironmentVariables: { GREETING: greeting, ...extraEnv },
      },
    },
  });
  const stack = {
    stackName: 'App',
    displayName: 'App',
    artifactId: 'App',
    region: 'us-east-1',
    assetManifestPath: join(outdir, 'App.assets.json'),
    assetOutdir: outdir,
    dependencyNames: [],
    template: {
      Resources: {
        WebFn: { Type: 'AWS::Lambda::WebFunction', Properties: { FunctionName: 'my-web' } },
        RevV1: revision('from-v1', { AWS_LAMBDA_NODEJS_ENTRYPOINT: 'alt.js' }),
        RevV2: revision('from-v2'),
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
            ...endpointExtra,
          },
        },
      },
    },
  };
  return { stacks: [stack] };
}

async function boot(argv: string[], endpointExtra?: Record<string, unknown>): Promise<string[]> {
  const lines: string[] = [];
  const sink = (...a: unknown[]): void => {
    lines.push(a.map(String).join(' ').replace(ANSI, ''));
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation(sink);
  }
  const assembly = writeAssembly(endpointExtra);
  const cmd = createLocalStartWebFunctionCommand({
    synthesizer: { synthesize: async () => assembly } as never,
  });
  cmd.exitOverride();
  void cmd.parseAsync([...argv, '--app', 'x'], { from: 'user' }).catch((err: unknown) => {
    lines.push(`THREW: ${err instanceof Error ? err.message : String(err)}`);
  });
  for (
    let i = 0;
    i < 400 && !lines.includes('Press ^C to shut down.') && !lines.some((l) => l.startsWith('THREW'));
    i++
  ) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return lines;
}

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
    docker.runDetached.mockClear();
    docker.pullImage.mockClear();
  });
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) if (!sigint.includes(l)) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) if (!sigterm.includes(l)) process.off('SIGTERM', l);
    vi.restoreAllMocks();
    process.env = savedEnv;
    rmSync(outdir, { recursive: true, force: true });
  });

  it('serves the highest-weight revision of an endpoint, with its ServiceConfig env', async () => {
    const lines = await boot(['App:Ep']);
    expect(lines).toContain('Server listening on http://127.0.0.1:40123  (my-web (Lambda web function))');
    expect(lines.some((l) => l.includes('Target: App/RevV2 (nodejs24.x; revision chosen by highest weight on endpoint Ep)'))).toBe(true);
    const opts = docker.runDetached.mock.calls[0]![0] as {
      env: Record<string, string>;
      cmd: string[];
      entryPoint: string[];
      mounts: unknown[];
      platform: string;
      name: string;
      hostPort: number;
      containerPort: number;
    };
    expect(opts.env['GREETING']).toBe('from-v2');
    expect(opts.env['AWS_LAMBDA_HTTP_ENDPOINT']).toBe('0.0.0.0:8080');
    expect(opts.env['AWS_LAMBDA_FUNCTION_NAME']).toBe('my-web');
    expect(opts.env['AWS_REGION']).toBe('us-east-1');
    expect(opts.entryPoint).toEqual(['/var/lang/bin/node']);
    expect(opts.cmd).toEqual(['/var/task/index.js']);
    expect(opts.mounts).toEqual([
      { hostPath: join(outdir, 'asset.abc123'), containerPath: '/var/task', readOnly: true },
    ]);
    expect(opts.platform).toBe('linux/arm64');
    expect(opts.name).toMatch(/^cdkl-webfn-/);
    expect(opts.hostPort).toBe(40123);
    expect(opts.containerPort).toBe(8080);
    expect(docker.pullImage).toHaveBeenCalledWith('public.ecr.aws/lambda/nodejs:24', false, 'linux/arm64');
    // A 20/80 split is warned once, naming the served revision.
    expect(lines.filter((l) => l.includes('weighted routing is not emulated'))).toHaveLength(1);
  });

  it('--revision overrides the weights and honours that revision\'s entrypoint env', async () => {
    const lines = await boot(['App:Ep', '--revision', 'RevV1', '--port', '18460', '--no-pull']);
    expect(lines).toContain('Server listening on http://127.0.0.1:18460  (my-web (Lambda web function))');
    const opts = docker.runDetached.mock.calls[0]![0] as { env: Record<string, string>; cmd: string[] };
    expect(opts.env['GREETING']).toBe('from-v1');
    expect(opts.cmd).toEqual(['/var/task/alt.js']);
    expect(docker.pullImage).toHaveBeenCalledWith('public.ecr.aws/lambda/nodejs:24', true, 'linux/arm64');
  });

  it('warns once that a non-ApplicationManaged auth type is not enforced, and still serves', async () => {
    const lines = await boot(['App:Ep'], { AuthType: 'AwsIam' });
    expect(lines.filter((l) => l.includes('AuthType AwsIam; it is not enforced locally'))).toHaveLength(1);
    expect(lines).toContain('Press ^C to shut down.');
  });

  it('fails on an unknown runtime before touching Docker', async () => {
    const assembly = writeAssembly();
    const stack = assembly.stacks[0] as { template: { Resources: Record<string, any> } };
    stack.template.Resources['RevV2'].Properties.BuildConfig.RuntimeConfig.Runtime = 'python3.13';
    const cmd = createLocalStartWebFunctionCommand({
      synthesizer: { synthesize: async () => assembly } as never,
    });
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await cmd.parseAsync(['App:Ep', '--app', 'x'], { from: 'user' });
    expect(errors.join('\n')).toMatch(/python3\.13 is not supported.*Supported: nodejs24\.x/);
    expect(docker.runDetached).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('is exported from the public entry, with its option helper on the internal one', () => {
    expect(publicFactory).toBe(createLocalStartWebFunctionCommand);
    const cmd = addStartWebFunctionSpecificOptions(new Command('host'));
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toEqual(
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
