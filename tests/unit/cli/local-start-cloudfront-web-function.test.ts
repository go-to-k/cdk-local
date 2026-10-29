import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { ResolvedDistribution, ResolvedOrigin } from '../../../src/local/cloudfront-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// Drives `bootWebFunctionOrigins` against a REAL cdk.out (asset manifest + a
// staged .zip bundle) with every Docker seam mocked: the endpoint -> revision
// -> artifact -> env -> container wiring a Web Function endpoint origin shares
// with `start-web-function` (go-to-k/cdkd#5516).

const h = vi.hoisted(() => ({
  runDetached: vi.fn(async (_opts: Record<string, unknown>) => 'cid-web'),
  pullImage: vi.fn(async (..._a: unknown[]) => undefined),
  removeContainer: vi.fn(async (_id: string) => undefined),
  ensureDocker: vi.fn(async () => undefined),
  ready: vi.fn(async (_args: Record<string, unknown>) => undefined),
  ports: [40123, 40124],
  tmpDirs: [] as string[],
  /** When set, artifact extraction / pickFreePort wait on it (a teardown-race seam). */
  artifactGate: undefined as Promise<void> | undefined,
  portGate: undefined as Promise<void> | undefined,
  exited: undefined as Promise<number | undefined> | undefined,
}));

vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  ensureDockerAvailable: h.ensureDocker,
  pickFreePort: vi.fn(async () => {
    if (h.portGate) await h.portGate;
    return h.ports.shift() ?? 40199;
  }),
  pullImage: h.pullImage,
  runDetached: h.runDetached,
  streamLogs: vi.fn(() => () => undefined),
  removeContainer: h.removeContainer,
}));
vi.mock('../../../src/local/web-function-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  waitForWebFunctionReady: h.ready,
  watchContainerExit: vi.fn(() => ({
    exited: h.exited ?? new Promise<number | undefined>(() => undefined),
    stop: () => undefined,
  })),
}));
vi.mock('../../../src/local/web-function-artifact.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/local/web-function-artifact.js')>();
  return {
    ...actual,
    resolveWebFunctionArtifact: vi.fn(
      async (...a: Parameters<typeof actual.resolveWebFunctionArtifact>) => {
        const art = await actual.resolveWebFunctionArtifact(...a);
        if (art.kind === 'zip' && art.tmpDir) h.tmpDirs.push(art.tmpDir);
        if (h.artifactGate) await h.artifactGate;
        return art;
      }
    ),
  };
});

const { bootWebFunctionOrigins } = await import(
  '../../../src/cli/commands/local-start-cloudfront.js'
);
const { WebFunctionServe, prepareWebFunctionServe } = await import(
  '../../../src/cli/commands/web-function-serve.js'
);
const { resolveWebFunctionTarget } = await import('../../../src/local/web-function-resolver.js');

let outdir: string;
let savedEnv: NodeJS.ProcessEnv;

function stackWith(extra: Record<string, unknown> = {}): StackInfo {
  writeFileSync(join(outdir, 'asset.abc123.zip'), zipSync({ 'index.js': strToU8('// server') }));
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
        RuntimeConfig: { Runtime: 'nodejs24.x' },
      },
      ServiceConfig: { EnvironmentVariables: env },
    },
  });
  const endpoint = (weights: [string, number][]) => ({
    Type: 'AWS::Lambda::WebFunctionEndpoint',
    Properties: {
      FunctionName: { Ref: 'WebFn' },
      EndpointType: 'HomeRegion',
      AuthType: 'ApplicationManaged',
      RevisionWeights: weights.map(([rev, w]) => ({
        RevisionId: { 'Fn::GetAtt': [rev, 'RevisionId'] },
        Weight: w,
      })),
    },
  });
  return {
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
        RevV1: revision({ GREETING: 'from-v1' }),
        RevV2: revision({ GREETING: 'from-v2' }),
        Ep: endpoint([
          ['RevV1', 20],
          ['RevV2', 80],
        ]),
        EpV1: endpoint([['RevV1', 100]]),
        ...extra,
      },
    },
  } as StackInfo;
}

function distribution(origins: ResolvedOrigin[]): ResolvedDistribution {
  return {
    logicalId: 'Dist',
    stackName: 'App',
    behaviors: [],
    origins: new Map(origins.map((o) => [o.originId, o])),
    customErrorResponses: [],
  };
}

const web = (originId: string, endpointLogicalId: string): ResolvedOrigin => ({
  kind: 'web-function',
  originId,
  endpointLogicalId,
});
const bootOpts = { containerHost: '127.0.0.1', skipPull: false, envOptions: {} };
const runEnv = (i: number) =>
  (h.runDetached.mock.calls[i]![0] as { env: Record<string, string> }).env;

beforeEach(() => {
  outdir = mkdtempSync(join(tmpdir(), 'cf-webfn-'));
  savedEnv = { ...process.env };
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) {
    delete process.env[k];
  }
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  h.runDetached.mockReset().mockResolvedValue('cid-web');
  h.ready.mockReset().mockResolvedValue(undefined);
  h.pullImage.mockReset().mockResolvedValue(undefined);
  h.removeContainer.mockReset().mockResolvedValue(undefined);
  h.ensureDocker.mockReset().mockResolvedValue(undefined);
  h.ports = [40123, 40124];
  h.tmpDirs = [];
  h.artifactGate = undefined;
  h.portGate = undefined;
  h.exited = undefined;
});

/** A gate the test opens by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  process.env = savedEnv;
  vi.restoreAllMocks();
  rmSync(outdir, { recursive: true, force: true });
});

describe('bootWebFunctionOrigins', () => {
  it('boots nothing (and never probes Docker) without a Web Function origin', async () => {
    const { targets, serves } = await bootWebFunctionOrigins(
      distribution([{ kind: 's3', originId: 's3', localDirs: [outdir] }]),
      [stackWith()],
      bootOpts
    );
    expect(targets.size).toBe(0);
    expect(serves).toHaveLength(0);
    expect(h.ensureDocker).not.toHaveBeenCalled();
    expect(h.runDetached).not.toHaveBeenCalled();
  });

  it("runs the revision the endpoint's weights pick, with its ServiceConfig env", async () => {
    const { targets } = await bootWebFunctionOrigins(
      distribution([web('o1', 'Ep')]),
      [stackWith()],
      bootOpts
    );
    expect(h.ensureDocker).toHaveBeenCalledTimes(1);
    expect(h.runDetached).toHaveBeenCalledTimes(1);
    const env = runEnv(0);
    expect(env['GREETING']).toBe('from-v2');
    expect(env['AWS_LAMBDA_HTTP_ENDPOINT']).toBe('0.0.0.0:8080');
    expect(env['AWS_LAMBDA_FUNCTION_NAME']).toBe('my-web');
    const opts = h.runDetached.mock.calls[0]![0] as { host: string; hostPort: number };
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.hostPort).toBe(40123);
    expect([...targets]).toEqual([['Ep', { host: '127.0.0.1', port: 40123 }]]);
  });

  it('boots one server per endpoint, shared by the origins that name it', async () => {
    const { targets, serves } = await bootWebFunctionOrigins(
      distribution([web('a', 'Ep'), web('b', 'Ep'), web('c', 'EpV1')]),
      [stackWith()],
      { ...bootOpts, containerHost: '0.0.0.0' }
    );
    expect(h.runDetached).toHaveBeenCalledTimes(2);
    expect(runEnv(0)['GREETING']).toBe('from-v2');
    expect(runEnv(1)['GREETING']).toBe('from-v1');
    // A wildcard publish is reached through loopback.
    expect(targets.get('Ep')).toEqual({ host: '127.0.0.1', port: 40123 });
    expect(targets.get('EpV1')).toEqual({ host: '127.0.0.1', port: 40124 });
    await Promise.all(serves.map((s) => s.teardown()));
    expect(h.removeContainer).toHaveBeenCalledTimes(2);
    for (const dir of h.tmpDirs) expect(existsSync(dir)).toBe(false);
  });

  it('a server that fails to come up tears down every booted one and fails start-up', async () => {
    h.runDetached.mockResolvedValueOnce('cid-1').mockResolvedValueOnce('cid-2');
    h.ready.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('never listened'));
    const err = await bootWebFunctionOrigins(
      distribution([web('a', 'Ep'), web('b', 'EpV1')]),
      [stackWith()],
      bootOpts
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('LOCAL_START_CLOUDFRONT_ERROR');
    expect((err as Error).message).toContain('EpV1');
    expect((err as Error).message).toContain('never listened');
    expect(h.removeContainer.mock.calls.map((c) => c[0]).sort()).toEqual(['cid-1', 'cid-2']);
    expect(h.tmpDirs).toHaveLength(2);
    for (const dir of h.tmpDirs) expect(existsSync(dir)).toBe(false);
  });

  it('fails start-up naming the endpoint when its revision cannot be resolved', async () => {
    const err = await bootWebFunctionOrigins(
      distribution([web('a', 'Missing')]),
      [stackWith()],
      bootOpts
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('LOCAL_START_CLOUDFRONT_ERROR');
    expect((err as Error).message).toContain('Missing');
    expect(h.runDetached).not.toHaveBeenCalled();
  });
});

describe('bootWebFunctionOrigins — start-up signal seams', () => {
  it('hands each serve to the sink before it starts, so a mid-boot teardown removes it', async () => {
    const g = gate();
    h.artifactGate = g.promise;
    const sink: InstanceType<typeof WebFunctionServe>[] = [];
    const boot = bootWebFunctionOrigins(distribution([web('a', 'Ep')]), [stackWith()], {
      ...bootOpts,
      sink,
    }).catch((e: unknown) => e);
    for (let i = 0; i < 100 && sink.length === 0; i++) await tick();
    expect(sink).toHaveLength(1);
    const teardown = sink[0]!.teardown();
    g.open();
    await teardown;
    const err = await boot;
    expect((err as { code?: string }).code).toBe('LOCAL_START_CLOUDFRONT_ERROR');
    expect(h.runDetached).not.toHaveBeenCalled();
    for (const dir of h.tmpDirs) expect(existsSync(dir)).toBe(false);
  });

  it('warns when a booted server exits on its own, but not after a teardown', async () => {
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(' '));
    });
    let exit!: (code: number) => void;
    h.exited = new Promise((r) => (exit = r));
    await bootWebFunctionOrigins(distribution([web('a', 'Ep')]), [stackWith()], bootOpts);
    exit(3);
    await tick();
    expect(warns.some((w) => w.includes('exited (exit code 3)') && w.includes('return 502'))).toBe(
      true
    );

    warns.length = 0;
    let exit2!: (code: number) => void;
    h.exited = new Promise((r) => (exit2 = r));
    const { serves } = await bootWebFunctionOrigins(
      distribution([web('a', 'Ep')]),
      [stackWith()],
      bootOpts
    );
    await serves[0]!.teardown();
    exit2(0);
    await tick();
    expect(warns.some((w) => w.includes('exited (exit code'))).toBe(false);
  });
});

describe('WebFunctionServe — teardown racing start()', () => {
  const serveOf = () => {
    const stack = stackWith();
    return new WebFunctionServe(
      prepareWebFunctionServe(resolveWebFunctionTarget('App:Ep', [stack])),
      { envOptions: {}, host: '127.0.0.1', port: 0, skipPull: false, timeoutMs: 1000 }
    );
  };

  it('during the artifact extraction: no pull or run, the bundle is removed', async () => {
    const g = gate();
    h.artifactGate = g.promise;
    const serve = serveOf();
    const started = serve.start();
    for (let i = 0; i < 100 && h.tmpDirs.length === 0; i++) await tick();
    const teardown = serve.teardown();
    g.open();
    await teardown;
    expect(await started).toBeUndefined();
    expect(h.pullImage).not.toHaveBeenCalled();
    expect(h.runDetached).not.toHaveBeenCalled();
    expect(h.tmpDirs).toHaveLength(1);
    expect(existsSync(h.tmpDirs[0]!)).toBe(false);
  });

  it('while picking the port: no docker run is issued', async () => {
    const g = gate();
    h.portGate = g.promise;
    const serve = serveOf();
    const started = serve.start();
    for (let i = 0; i < 100 && h.pullImage.mock.calls.length === 0; i++) await tick();
    await tick();
    await serve.teardown();
    g.open();
    expect(await started).toBeUndefined();
    expect(h.runDetached).not.toHaveBeenCalled();
  });

  it('while docker run is in flight: the container it returns is removed', async () => {
    let finishRun!: (id: string) => void;
    h.runDetached.mockImplementationOnce(() => new Promise<string>((r) => (finishRun = r)));
    const serve = serveOf();
    const started = serve.start();
    for (let i = 0; i < 100 && h.runDetached.mock.calls.length === 0; i++) await tick();
    const teardown = serve.teardown();
    await tick();
    expect(serve.waitingOnRun).toBe(true);
    finishRun('cid-late');
    await teardown;
    expect(await started).toBeUndefined();
    expect(h.removeContainer).toHaveBeenCalledWith('cid-late');
    expect(h.ready).not.toHaveBeenCalled();
  });
});
