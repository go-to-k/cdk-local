import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const {
  loadManifestMock,
  getFileAssetsMock,
  getAssetSourcePathMock,
  getDockerImageBySourceHashMock,
  buildContainerImageMock,
  buildAgentCoreCodeImageMock,
  downloadAndExtractS3BundleMock,
  parseEcrUriMock,
  pullEcrImageMock,
  pullImageMock,
  createLocalStateProviderMock,
  verifyJwtViaDiscoveryMock,
  stsSendMock,
} = vi.hoisted(() => ({
  loadManifestMock: vi.fn(),
  getFileAssetsMock: vi.fn(),
  getAssetSourcePathMock: vi.fn(),
  getDockerImageBySourceHashMock: vi.fn(),
  buildContainerImageMock: vi.fn(),
  buildAgentCoreCodeImageMock: vi.fn(),
  downloadAndExtractS3BundleMock: vi.fn(),
  parseEcrUriMock: vi.fn(),
  pullEcrImageMock: vi.fn(),
  pullImageMock: vi.fn(),
  createLocalStateProviderMock: vi.fn(),
  verifyJwtViaDiscoveryMock: vi.fn(),
  stsSendMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSendMock;
    destroy(): void {}
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
  GetCallerIdentityCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../../src/local/cognito-jwt.js', async (importActual) => ({
  ...(await importActual<object>()),
  createJwksCache: vi.fn(() => ({ fetchAndCache: vi.fn(), peek: vi.fn(), clear: vi.fn() })),
  verifyJwtViaDiscovery: verifyJwtViaDiscoveryMock,
}));

vi.mock('../../../src/cli/commands/local-state-source.js', async (importActual) => ({
  ...(await importActual<object>()),
  createLocalStateProvider: createLocalStateProviderMock,
  resolveCfnFallbackRegion: vi.fn().mockResolvedValue('us-east-1'),
}));

vi.mock('../../../src/assets/asset-manifest-loader.js', async (importActual) => {
  const actual = await importActual<object>();
  return {
    ...actual,
    AssetManifestLoader: class {
      async loadManifest(): Promise<unknown> {
        return loadManifestMock();
      }
      getFileAssets(manifest: unknown): unknown {
        return getFileAssetsMock(manifest);
      }
      getAssetSourcePath(dir: string, asset: unknown): unknown {
        return getAssetSourcePathMock(dir, asset);
      }
    },
    getDockerImageBySourceHash: getDockerImageBySourceHashMock,
  };
});

vi.mock('../../../src/local/docker-image-builder.js', async (importActual) => ({
  ...(await importActual<object>()),
  buildContainerImage: buildContainerImageMock,
}));

vi.mock('../../../src/local/agentcore-code-build.js', async (importActual) => ({
  ...(await importActual<object>()),
  buildAgentCoreCodeImage: buildAgentCoreCodeImageMock,
}));

vi.mock('../../../src/local/agentcore-s3-bundle.js', async (importActual) => ({
  ...(await importActual<object>()),
  downloadAndExtractS3Bundle: downloadAndExtractS3BundleMock,
}));

vi.mock('../../../src/local/ecr-puller.js', async (importActual) => ({
  ...(await importActual<object>()),
  parseEcrUri: parseEcrUriMock,
  pullEcrImage: pullEcrImageMock,
}));

vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  pullImage: pullImageMock,
}));

const {
  resolveAgentCoreImage,
  emitResult,
  emitMcpResult,
  emitWsResult,
  buildMcpRequest,
  buildContainerEnv,
  readEvent,
  readEnvOverridesFile,
  platformToArchitecture,
  resolveInboundAuthorization,
  resolveAssumeRoleArn,
  resolveFromS3BucketIntrinsic,
  buildSigV4HeadersIfRequested,
  parseTimeoutMs,
} = await import('../../../src/cli/commands/local-invoke-agentcore.js');
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';

function runtime(
  containerUri: string,
  overrides: Partial<ResolvedAgentCoreRuntime> = {}
): ResolvedAgentCoreRuntime {
  return {
    stack: { stackName: 'App' } as ResolvedAgentCoreRuntime['stack'],
    logicalId: 'ChatAgent',
    resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    containerUri,
    environmentVariables: {},
    protocol: 'HTTP',
    ...overrides,
  };
}

const imageOpts = (over: Record<string, unknown> = {}) =>
  ({ platform: 'linux/arm64', pull: true, build: true, ...over }) as unknown as Parameters<
    typeof resolveAgentCoreImage
  >[1];

describe('resolveAgentCoreImage — acquisition fallback order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds from a local cdk.out asset when the URI matches the manifest', async () => {
    const resolved = runtime('123.dkr.ecr.us-east-1.amazonaws.com/assets:abc123', {
      stack: { stackName: 'App', assetManifestPath: '/cdk.out/App.assets.json' } as never,
    });
    loadManifestMock.mockResolvedValue({ dockerImages: {} });
    getDockerImageBySourceHashMock.mockReturnValue({ hash: 'abc123', asset: { source: {} } });
    buildContainerImageMock.mockResolvedValue('cdkl-agent-build:abc123');

    const image = await resolveAgentCoreImage(resolved, imageOpts());
    expect(image).toBe('cdkl-agent-build:abc123');
    expect(buildContainerImageMock).toHaveBeenCalledWith({ source: {} }, '/cdk.out', {
      architecture: 'arm64',
      noBuild: false,
    });
    expect(pullEcrImageMock).not.toHaveBeenCalled();
    expect(pullImageMock).not.toHaveBeenCalled();
  });

  it('pulls from ECR when there is no asset match and the URI is an ECR URI', async () => {
    const uri = '111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/agent:latest';
    const resolved = runtime(uri, { stack: { stackName: 'App' } as never });
    parseEcrUriMock.mockReturnValue({ registry: 'r', accountId: '1', region: 'ap-northeast-1' });
    pullEcrImageMock.mockResolvedValue(uri);

    const image = await resolveAgentCoreImage(resolved, imageOpts({ profile: 'dev' }));
    expect(image).toBe(uri);
    expect(pullEcrImageMock).toHaveBeenCalledWith(uri, { skipPull: false, profile: 'dev' });
    expect(buildContainerImageMock).not.toHaveBeenCalled();
    expect(pullImageMock).not.toHaveBeenCalled();
  });

  it('falls back to a plain registry pull for a non-ECR URI', async () => {
    const uri = 'public.ecr.aws/my/agent:v1';
    const resolved = runtime(uri, { stack: { stackName: 'App' } as never });
    parseEcrUriMock.mockReturnValue(undefined);
    pullImageMock.mockResolvedValue(undefined);

    const image = await resolveAgentCoreImage(resolved, imageOpts({ pull: false }));
    expect(image).toBe(uri);
    expect(pullImageMock).toHaveBeenCalledWith(uri, true);
    expect(pullEcrImageMock).not.toHaveBeenCalled();
  });
});

describe('resolveAgentCoreImage — CodeConfiguration (from source)', () => {
  // A real dir so the command's existsSync/isDirectory source check passes.
  let realSourceDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    realSourceDir = mkdtempSync(join(tmpdir(), 'cdkl-code-src-'));
    getAssetSourcePathMock.mockReturnValue(realSourceDir);
  });

  function codeRuntime(): ResolvedAgentCoreRuntime {
    return {
      stack: { stackName: 'App', assetManifestPath: '/cdk.out/App.assets.json' } as never,
      logicalId: 'CodeAgent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      environmentVariables: {},
      protocol: 'HTTP',
      codeArtifact: { runtime: 'PYTHON_3_13', entryPoint: ['app.py'], codeAssetHash: 'h123' },
    };
  }

  it('locates the fromCodeAsset source dir by hash and builds from source', async () => {
    loadManifestMock.mockResolvedValue({ files: {} });
    getFileAssetsMock.mockReturnValue(new Map([['h123', { source: { path: 'asset.h123' } }]]));
    buildAgentCoreCodeImageMock.mockResolvedValue('cdkl-agentcore-code-deadbeef');

    const image = await resolveAgentCoreImage(codeRuntime(), imageOpts());
    expect(image).toBe('cdkl-agentcore-code-deadbeef');
    expect(buildAgentCoreCodeImageMock).toHaveBeenCalledWith({
      sourceDir: realSourceDir,
      runtime: 'PYTHON_3_13',
      entryPoint: ['app.py'],
      architecture: 'arm64',
      noBuild: false,
    });
    // The container path must NOT run for a code artifact.
    expect(buildContainerImageMock).not.toHaveBeenCalled();
    expect(pullEcrImageMock).not.toHaveBeenCalled();
  });

  it('falls back to a destination objectKey match when the source-hash key misses', async () => {
    loadManifestMock.mockResolvedValue({ files: {} });
    // Keyed by a DIFFERENT source hash, but the destination objectKey is h123.zip.
    getFileAssetsMock.mockReturnValue(
      new Map([
        ['srcHashXYZ', { source: { path: 'asset.x' }, destinations: { current: { objectKey: 'h123.zip' } } }],
      ])
    );
    buildAgentCoreCodeImageMock.mockResolvedValue('tag');
    await resolveAgentCoreImage(codeRuntime(), imageOpts());
    expect(buildAgentCoreCodeImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDir: realSourceDir })
    );
  });

  it('errors (re-synthesize) when a fromCodeAsset bundle is not in the manifest', async () => {
    loadManifestMock.mockResolvedValue({ files: {} });
    getFileAssetsMock.mockReturnValue(new Map()); // no asset by hash or objectKey
    await expect(resolveAgentCoreImage(codeRuntime(), imageOpts())).rejects.toThrow(/re-synthesize/);
    expect(buildAgentCoreCodeImageMock).not.toHaveBeenCalled();
  });

  it('errors when the resolved source dir does not exist (stale cdk.out)', async () => {
    loadManifestMock.mockResolvedValue({ files: {} });
    getFileAssetsMock.mockReturnValue(new Map([['h123', { source: { path: 'asset.h123' } }]]));
    getAssetSourcePathMock.mockReturnValue('/cdk.out/does-not-exist-xyz');
    await expect(resolveAgentCoreImage(codeRuntime(), imageOpts())).rejects.toThrow(
      /does not exist or is not a directory/
    );
    expect(buildAgentCoreCodeImageMock).not.toHaveBeenCalled();
  });

  it('errors when the stack has no asset manifest', async () => {
    const noManifest = { ...codeRuntime(), stack: { stackName: 'App' } as never };
    await expect(resolveAgentCoreImage(noManifest, imageOpts())).rejects.toThrow(/no asset/);
    expect(buildAgentCoreCodeImageMock).not.toHaveBeenCalled();
  });

  it('threads --no-build through to the code builder', async () => {
    loadManifestMock.mockResolvedValue({ files: {} });
    getFileAssetsMock.mockReturnValue(new Map([['h123', { source: { path: 'asset.h123' } }]]));
    buildAgentCoreCodeImageMock.mockResolvedValue('tag');
    await resolveAgentCoreImage(codeRuntime(), imageOpts({ build: false }));
    expect(buildAgentCoreCodeImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ noBuild: true })
    );
  });
});

describe('resolveAgentCoreImage — CodeConfiguration fromS3 (download + build)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function s3CodeRuntime(): ResolvedAgentCoreRuntime {
    return {
      stack: { stackName: 'App', region: 'us-west-2' } as never,
      logicalId: 'S3Agent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      environmentVariables: {},
      protocol: 'HTTP',
      codeArtifact: {
        runtime: 'PYTHON_3_12',
        entryPoint: ['app.py'],
        codeAssetHash: 'agent',
        s3Source: { bucket: 'my-bundles', key: 'agents/agent.zip' },
      },
    };
  }

  it('downloads + extracts the fromS3 bundle, builds from the extracted dir, then cleans up', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    downloadAndExtractS3BundleMock.mockResolvedValue({ dir: '/tmp/extracted-xyz', cleanup });
    buildAgentCoreCodeImageMock.mockResolvedValue('cdkl-agentcore-code-froms3');

    const image = await resolveAgentCoreImage(s3CodeRuntime(), imageOpts({ profile: 'dev' }));

    expect(image).toBe('cdkl-agentcore-code-froms3');
    expect(downloadAndExtractS3BundleMock).toHaveBeenCalledWith(
      { bucket: 'my-bundles', key: 'agents/agent.zip' },
      expect.objectContaining({ profile: 'dev' })
    );
    expect(buildAgentCoreCodeImageMock).toHaveBeenCalledWith({
      sourceDir: '/tmp/extracted-xyz',
      runtime: 'PYTHON_3_12',
      entryPoint: ['app.py'],
      architecture: 'arm64',
      noBuild: false,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    // The fromCodeAsset cdk.out path must NOT run for a fromS3 bundle.
    expect(loadManifestMock).not.toHaveBeenCalled();
  });

  it('cleans up the temp dir even when the build fails', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    downloadAndExtractS3BundleMock.mockResolvedValue({ dir: '/tmp/extracted-zzz', cleanup });
    buildAgentCoreCodeImageMock.mockRejectedValue(new Error('docker build boom'));

    await expect(resolveAgentCoreImage(s3CodeRuntime(), imageOpts())).rejects.toThrow(
      /docker build boom/
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('prefers --stack-region for the download region', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    downloadAndExtractS3BundleMock.mockResolvedValue({ dir: '/tmp/x', cleanup });
    buildAgentCoreCodeImageMock.mockResolvedValue('tag');
    await resolveAgentCoreImage(s3CodeRuntime(), imageOpts({ stackRegion: 'eu-central-1' }));
    expect(downloadAndExtractS3BundleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ region: 'eu-central-1' })
    );
  });

  it('prefers --region over --stack-region for the download region', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    downloadAndExtractS3BundleMock.mockResolvedValue({ dir: '/tmp/x', cleanup });
    buildAgentCoreCodeImageMock.mockResolvedValue('tag');
    await resolveAgentCoreImage(
      s3CodeRuntime(),
      imageOpts({ region: 'ap-south-1', stackRegion: 'eu-central-1' })
    );
    expect(downloadAndExtractS3BundleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ region: 'ap-south-1' })
    );
  });

  it('threads --assume-role STS temp creds into the fromS3 download', async () => {
    stsSendMock.mockResolvedValue({
      Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' },
    });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    downloadAndExtractS3BundleMock.mockResolvedValue({ dir: '/tmp/x', cleanup });
    buildAgentCoreCodeImageMock.mockResolvedValue('tag');

    await resolveAgentCoreImage(
      s3CodeRuntime(),
      imageOpts({ assumeRole: 'arn:aws:iam::1:role/Agent' })
    );

    expect(downloadAndExtractS3BundleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' },
      })
    );
  });

  it('falls back to --profile creds when the fromS3 download AssumeRole fails', async () => {
    stsSendMock.mockRejectedValue(new Error('access denied'));
    const cleanup = vi.fn().mockResolvedValue(undefined);
    downloadAndExtractS3BundleMock.mockResolvedValue({ dir: '/tmp/x', cleanup });
    buildAgentCoreCodeImageMock.mockResolvedValue('tag');

    await resolveAgentCoreImage(
      s3CodeRuntime(),
      imageOpts({ assumeRole: 'arn:aws:iam::1:role/Agent', profile: 'dev' })
    );

    const passed = downloadAndExtractS3BundleMock.mock.calls[0]?.[1] as {
      credentials?: unknown;
      profile?: string;
    };
    expect(passed.credentials).toBeUndefined();
    expect(passed.profile).toBe('dev');
  });
});

describe('emitResult — exit codes', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const savedExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  it('prints the body and leaves exit code unset on a 2xx', () => {
    emitResult({ status: 200, contentType: 'application/json', raw: '{"ok":true}', streamed: false });
    expect(writeSpy).toHaveBeenCalledWith('{"ok":true}\n');
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exit code 1 (but still prints the body) on a 4xx/5xx', () => {
    emitResult({
      status: 500,
      contentType: 'application/json',
      raw: '{"error":"boom"}',
      streamed: false,
    });
    expect(writeSpy).toHaveBeenCalledWith('{"error":"boom"}\n');
    expect(process.exitCode).toBe(1);
  });

  it('does not re-print a streamed body — only terminates with a newline', () => {
    // The SSE body was already written incrementally via onChunk; emitResult
    // must not echo `raw` again, just close the line.
    emitResult({ status: 200, contentType: 'text/event-stream', raw: '', streamed: true });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('\n');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('emitWsResult', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const savedExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  it('only terminates with a newline (frames were already streamed) and leaves exit code unset', () => {
    emitWsResult({ frames: 3 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('\n');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('buildMcpRequest', () => {
  it('defaults to tools/list when no --event was given (empty object)', () => {
    expect(buildMcpRequest({})).toEqual({ method: 'tools/list', params: {} });
  });

  it('passes a method + params through verbatim', () => {
    expect(
      buildMcpRequest({ method: 'tools/call', params: { name: 'add', arguments: { a: 1 } } })
    ).toEqual({ method: 'tools/call', params: { name: 'add', arguments: { a: 1 } } });
  });

  it('omits params when the event has only a method', () => {
    expect(buildMcpRequest({ method: 'tools/list' })).toEqual({ method: 'tools/list' });
  });

  it('rejects a non-object event', () => {
    expect(() => buildMcpRequest([1, 2])).toThrow(/JSON object/);
  });

  it('rejects an object that has keys but no string method', () => {
    expect(() => buildMcpRequest({ params: {} })).toThrow(/string "method"/);
  });
});

describe('emitMcpResult — exit codes', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const savedExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  it('prints the JSON-RPC response and leaves exit code unset when ok', () => {
    emitMcpResult({ ok: true, raw: '{"result":{"tools":[]}}' });
    expect(writeSpy).toHaveBeenCalledWith('{"result":{"tools":[]}}\n');
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exit code 1 (but still prints) on a JSON-RPC error', () => {
    emitMcpResult({ ok: false, raw: '{"error":{"message":"nope"}}' });
    expect(writeSpy).toHaveBeenCalledWith('{"error":{"message":"nope"}}\n');
    expect(process.exitCode).toBe(1);
  });
});

describe('buildContainerEnv — --from-cfn-stack env substitution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const provider = () => ({
    label: '--from-cfn-stack',
    buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  });
  const cfnOpts = { fromCfnStack: 'App', platform: 'linux/arm64', pull: true, build: true } as never;

  it('substitutes a Ref env var against the shared loaded state and injects it', async () => {
    const resolved = runtime('repo:tag', {
      environmentVariables: { TABLE_NAME: { Ref: 'MyTable' } },
    });
    const loaded = {
      resources: {
        MyTable: { physicalId: 'tbl-123', resourceType: 'AWS::DynamoDB::Table', properties: {} },
      },
      region: 'us-east-1',
      outputs: {},
    };

    const { env, sensitiveEnvKeys } = await buildContainerEnv(
      resolved,
      cfnOpts,
      undefined,
      undefined,
      provider() as never,
      loaded as never,
      { stateResources: loaded.resources } as never
    );

    expect(env['TABLE_NAME']).toBe('tbl-123');
    expect(sensitiveEnvKeys.size).toBe(0);
  });

  it('routes a decrypted SecureString SSM env value off the argv (sensitiveEnvKeys)', async () => {
    const resolved = runtime('repo:tag', {
      environmentVariables: { API_KEY: { Ref: 'SecretParam' } },
    });
    const loaded = { resources: {}, region: 'us-east-1', outputs: {} };
    const imageContext = {
      stateResources: {},
      stateParameters: { SecretParam: 's3cr3t-value' },
      stateSensitiveParameters: ['SecretParam'],
    };

    const { env, sensitiveEnvKeys } = await buildContainerEnv(
      resolved,
      cfnOpts,
      undefined,
      undefined,
      provider() as never,
      loaded as never,
      imageContext as never
    );

    expect(env['API_KEY']).toBe('s3cr3t-value');
    // The value resolved from a SecureString param, so the env key must be
    // flagged sensitive (kept off the docker run argv).
    expect(sensitiveEnvKeys.has('API_KEY')).toBe(true);
  });
});

describe('resolveAssumeRoleArn — bare --assume-role + state', () => {
  const resolved = (over: Record<string, unknown> = {}) =>
    ({
      logicalId: 'ChatAgent',
      stack: { stackName: 'App' },
      environmentVariables: {},
      protocol: 'HTTP',
      ...over,
    }) as never;

  it('returns the explicit ARN for --assume-role <arn>', () => {
    expect(resolveAssumeRoleArn({ assumeRole: 'arn:aws:iam::1:role/x' } as never, resolved(), undefined)).toBe(
      'arn:aws:iam::1:role/x'
    );
  });

  it('uses the literal RoleArn for bare --assume-role when present', () => {
    expect(
      resolveAssumeRoleArn(
        { assumeRole: true } as never,
        resolved({ roleArn: 'arn:aws:iam::1:role/lit' }),
        undefined
      )
    ).toBe('arn:aws:iam::1:role/lit');
  });

  it('resolves an intrinsic RoleArn from --from-cfn-stack state for bare --assume-role', () => {
    const loaded = {
      resources: {
        ChatAgent: { properties: { RoleArn: { 'Fn::GetAtt': ['AgentRole', 'Arn'] } } },
        AgentRole: { attributes: { Arn: 'arn:aws:iam::1:role/from-state' } },
      },
    };
    expect(resolveAssumeRoleArn({ assumeRole: true } as never, resolved(), loaded as never)).toBe(
      'arn:aws:iam::1:role/from-state'
    );
  });

  it('returns undefined (warn + dev-creds fallback) when bare --assume-role cannot resolve', () => {
    expect(resolveAssumeRoleArn({ assumeRole: true } as never, resolved(), undefined)).toBeUndefined();
  });

  it('returns undefined when --assume-role is not set', () => {
    expect(resolveAssumeRoleArn({} as never, resolved(), undefined)).toBeUndefined();
  });
});

const opts = (o: Record<string, unknown>) => o as unknown as Parameters<typeof readEvent>[0];

describe('readEvent', () => {
  it('defaults to {} when no event is given', async () => {
    expect(await readEvent(opts({}))).toEqual({});
  });

  it('rejects when --event and --event-stdin are both set', async () => {
    await expect(readEvent(opts({ event: 'e.json', eventStdin: true }))).rejects.toThrow(
      /mutually exclusive/
    );
  });

  it('reads + parses a JSON --event file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkl-agentcore-event-'));
    const file = join(dir, 'event.json');
    writeFileSync(file, '{"prompt":"hi","n":3}', 'utf-8');
    expect(await readEvent(opts({ event: file }))).toEqual({ prompt: 'hi', n: 3 });
  });

  it('throws a clear error for a malformed --event JSON file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkl-agentcore-event-'));
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{not json', 'utf-8');
    await expect(readEvent(opts({ event: file }))).rejects.toThrow(/Failed to parse event payload/);
  });

  it('throws a clear error when the --event file cannot be read', async () => {
    await expect(readEvent(opts({ event: '/no/such/cdkl-agentcore-event.json' }))).rejects.toThrow(
      /Failed to read --event file/
    );
  });
});

describe('readEnvOverridesFile', () => {
  it('returns undefined when no path is given', () => {
    expect(readEnvOverridesFile(undefined)).toBeUndefined();
  });

  it('throws when the file cannot be read', () => {
    expect(() => readEnvOverridesFile('/no/such/cdkl-agentcore-env.json')).toThrow(
      /Failed to read --env-vars file/
    );
  });

  it('throws on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkl-agentcore-env-'));
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{nope', 'utf-8');
    expect(() => readEnvOverridesFile(file)).toThrow(/Failed to parse --env-vars file/);
  });

  it('throws when the top level is not a JSON object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkl-agentcore-env-'));
    const file = join(dir, 'arr.json');
    writeFileSync(file, '["a","b"]', 'utf-8');
    expect(() => readEnvOverridesFile(file)).toThrow(/must contain a JSON object/);
  });

  it('parses a valid SAM-shape override object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkl-agentcore-env-'));
    const file = join(dir, 'ok.json');
    writeFileSync(file, '{"Parameters":{"GREETING":"hi"}}', 'utf-8');
    expect(readEnvOverridesFile(file)).toEqual({ Parameters: { GREETING: 'hi' } });
  });
});

describe('platformToArchitecture', () => {
  it('maps linux/amd64 to x86_64', () => {
    expect(platformToArchitecture('linux/amd64')).toBe('x86_64');
  });

  it('maps linux/arm64 to arm64', () => {
    expect(platformToArchitecture('linux/arm64')).toBe('arm64');
  });

  it('defaults any other value to arm64 (AgentCore-required arch)', () => {
    expect(platformToArchitecture('something-else')).toBe('arm64');
  });
});

describe('resolveInboundAuthorization — JWT gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const withAuthorizer = (over: Partial<ResolvedAgentCoreRuntime> = {}) =>
    runtime('repo:tag', {
      jwtAuthorizer: {
        discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
        allowedAudience: ['aud-1'],
      },
      ...over,
    });

  it('forwards a token unchanged when no authorizer is configured (no verify)', async () => {
    const header = await resolveInboundAuthorization(runtime('repo:tag'), {
      bearerToken: 'tok',
      verifyAuth: true,
    });
    expect(header).toBe('Bearer tok');
    expect(verifyJwtViaDiscoveryMock).not.toHaveBeenCalled();
  });

  it('returns undefined when no authorizer and no token', async () => {
    expect(
      await resolveInboundAuthorization(runtime('repo:tag'), { verifyAuth: true })
    ).toBeUndefined();
  });

  it('skips verification with --no-verify-auth (forwards token, no verify)', async () => {
    const header = await resolveInboundAuthorization(withAuthorizer(), {
      bearerToken: 'tok',
      verifyAuth: false,
    });
    expect(header).toBe('Bearer tok');
    expect(verifyJwtViaDiscoveryMock).not.toHaveBeenCalled();
  });

  it('rejects (pre-container) when the authorizer is set but no token is given', async () => {
    await expect(
      resolveInboundAuthorization(withAuthorizer(), { verifyAuth: true })
    ).rejects.toThrow(/requires an inbound JWT/);
    expect(verifyJwtViaDiscoveryMock).not.toHaveBeenCalled();
  });

  it('verifies + forwards when the token is accepted', async () => {
    verifyJwtViaDiscoveryMock.mockResolvedValue({ allow: true, identityHash: 'h', ttlSeconds: 0 });
    const header = await resolveInboundAuthorization(withAuthorizer(), {
      bearerToken: 'tok',
      verifyAuth: true,
    });
    expect(header).toBe('Bearer tok');
    expect(verifyJwtViaDiscoveryMock).toHaveBeenCalledWith(
      {
        discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
        allowedAudience: ['aud-1'],
      },
      'Bearer tok',
      expect.anything(),
      expect.objectContaining({ warned: expect.any(Set) })
    );
  });

  it('rejects when the token is denied by the authorizer', async () => {
    verifyJwtViaDiscoveryMock.mockResolvedValue({ allow: false, identityHash: undefined, ttlSeconds: 0 });
    await expect(
      resolveInboundAuthorization(withAuthorizer(), { bearerToken: 'bad', verifyAuth: true })
    ).rejects.toThrow(/rejected by the runtime's customJwtAuthorizer/);
  });
});

describe('resolveFromS3BucketIntrinsic — fromS3 Code.S3.Bucket intrinsic resolution', () => {
  function runtimeWithIntrinsic(intrinsic: unknown): ResolvedAgentCoreRuntime {
    return {
      stack: { stackName: 'App', region: 'us-east-1' } as never,
      logicalId: 'S3Agent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      environmentVariables: {},
      protocol: 'HTTP',
      codeArtifact: {
        runtime: 'PYTHON_3_12',
        entryPoint: ['app.py'],
        codeAssetHash: 'agent',
        s3Source: { bucketIntrinsic: intrinsic, key: 'agent.zip' },
      },
    };
  }

  it('is a no-op when there is no s3Source / no bucketIntrinsic', async () => {
    const r: ResolvedAgentCoreRuntime = {
      stack: { stackName: 'App' } as never,
      logicalId: 'ChatAgent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      containerUri: 'r:t',
      environmentVariables: {},
      protocol: 'HTTP',
    };
    await expect(
      resolveFromS3BucketIntrinsic(r, undefined, undefined, undefined)
    ).resolves.toBeUndefined();
  });

  it('resolves a Ref bucket against loaded state', async () => {
    const r = runtimeWithIntrinsic({ Ref: 'MyBucketABCD' });
    const stateProvider = {
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
    } as never;
    const loaded = {
      stackName: 'App',
      region: 'us-east-1',
      resources: {
        MyBucketABCD: { physicalId: 'my-real-bucket-name', resourceType: 'AWS::S3::Bucket' },
      },
    } as never;
    await resolveFromS3BucketIntrinsic(r, stateProvider, loaded, undefined);
    expect(r.codeArtifact?.s3Source?.bucket).toBe('my-real-bucket-name');
  });

  it('resolves a Fn::ImportValue bucket via the cross-stack resolver', async () => {
    const r = runtimeWithIntrinsic({ 'Fn::ImportValue': 'SharedBundleBucket' });
    const crossStackResolver = {
      resolveImport: vi.fn().mockResolvedValue('imported-bucket-name'),
    };
    const stateProvider = {
      buildCrossStackResolver: vi.fn().mockResolvedValue(crossStackResolver),
    } as never;
    const loaded = { stackName: 'App', region: 'us-east-1', resources: {} } as never;
    await resolveFromS3BucketIntrinsic(r, stateProvider, loaded, undefined);
    expect(r.codeArtifact?.s3Source?.bucket).toBe('imported-bucket-name');
    expect(crossStackResolver.resolveImport).toHaveBeenCalledWith('SharedBundleBucket');
  });

  it('resolves a Fn::GetStackOutput bucket via the cross-stack resolver', async () => {
    const r = runtimeWithIntrinsic({
      'Fn::GetStackOutput': { StackName: 'SharedStack', OutputName: 'BundleBucketName' },
    });
    const resolveGetStackOutput = vi.fn().mockResolvedValue('output-bucket-name');
    const crossStackResolver = {
      resolveImport: vi.fn(),
      resolveGetStackOutput,
    };
    const stateProvider = {
      buildCrossStackResolver: vi.fn().mockResolvedValue(crossStackResolver),
    } as never;
    const loaded = { stackName: 'App', region: 'us-east-1', resources: {} } as never;
    await resolveFromS3BucketIntrinsic(r, stateProvider, loaded, undefined);
    expect(r.codeArtifact?.s3Source?.bucket).toBe('output-bucket-name');
    expect(resolveGetStackOutput).toHaveBeenCalledWith(
      'SharedStack',
      'us-east-1',
      'BundleBucketName'
    );
  });

  it('errors when --from-cfn-stack state is not available', async () => {
    const r = runtimeWithIntrinsic({ Ref: 'BucketX' });
    await expect(
      resolveFromS3BucketIntrinsic(r, undefined, undefined, undefined)
    ).rejects.toThrow(/Pass --from-cfn-stack/);
  });

  it('errors when the substitution returns unresolved (e.g. missing resource)', async () => {
    const r = runtimeWithIntrinsic({ Ref: 'MissingBucket' });
    const stateProvider = {
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
    } as never;
    const loaded = { stackName: 'App', region: 'us-east-1', resources: {} } as never;
    await expect(
      resolveFromS3BucketIntrinsic(r, stateProvider, loaded, undefined)
    ).rejects.toThrow(/Could not resolve/);
  });
});

describe('buildSigV4HeadersIfRequested — --sigv4 gate', () => {
  const ENV_BACKUP = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    stsSendMock.mockReset();
    // Start each test with a clean credential env so we're not at the mercy of
    // the host's AWS_* env vars.
    delete process.env['AWS_ACCESS_KEY_ID'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
    delete process.env['AWS_SESSION_TOKEN'];
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ENV_BACKUP);
  });

  function runtime(jwtAuthorizer?: ResolvedAgentCoreRuntime['jwtAuthorizer']): ResolvedAgentCoreRuntime {
    return {
      stack: { stackName: 'App', region: 'us-east-1' } as never,
      logicalId: 'Agent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      containerUri: 'r:t',
      environmentVariables: {},
      protocol: 'HTTP',
      ...(jwtAuthorizer && { jwtAuthorizer }),
    };
  }

  type Opts = Parameters<typeof buildSigV4HeadersIfRequested>[0];
  const opts = (over: Partial<Opts> = {}): Opts =>
    ({ sigv4: true, region: 'us-east-1', ...over }) as unknown as Opts;

  it('returns undefined when --sigv4 is not set (default behavior is unsigned)', async () => {
    const result = await buildSigV4HeadersIfRequested(
      opts({ sigv4: false }),
      runtime(),
      undefined,
      '127.0.0.1',
      9000,
      {},
      's'
    );
    expect(result).toBeUndefined();
  });

  it('warns + returns undefined when the runtime declares a customJwtAuthorizer (JWT path wins)', async () => {
    const result = await buildSigV4HeadersIfRequested(
      opts(),
      runtime({ discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration' }),
      undefined,
      '127.0.0.1',
      9000,
      {},
      's'
    );
    expect(result).toBeUndefined();
  });

  it('rejects --sigv4 + --bearer-token together (mutually exclusive)', async () => {
    await expect(
      buildSigV4HeadersIfRequested(
        opts({ bearerToken: 'tok' }),
        runtime(),
        undefined,
        '127.0.0.1',
        9000,
        {},
        's'
      )
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('errors with an actionable hint when no AWS credentials are available', async () => {
    await expect(
      buildSigV4HeadersIfRequested(opts(), runtime(), undefined, '127.0.0.1', 9000, {}, 's')
    ).rejects.toThrow(/no AWS credentials available/);
  });

  it('signs using shell env credentials when present', async () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIDEXAMPLE';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const headers = await buildSigV4HeadersIfRequested(
      opts(),
      runtime(),
      undefined,
      '127.0.0.1',
      9000,
      { prompt: 'hi' },
      'sess-1'
    );
    expect(headers).toBeDefined();
    expect(headers?.['Authorization']?.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')).toBe(
      true
    );
    expect(headers?.['Authorization']).toContain('/us-east-1/bedrock-agentcore/aws4_request');
    expect(headers?.['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers?.['X-Amz-Content-Sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers?.['X-Amz-Security-Token']).toBeUndefined();
  });

  it('threads --assume-role STS temp creds (incl. X-Amz-Security-Token) into the signed headers', async () => {
    stsSendMock.mockResolvedValue({
      Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' },
    });
    const headers = await buildSigV4HeadersIfRequested(
      opts({ assumeRole: 'arn:aws:iam::1:role/Agent' }),
      runtime(),
      undefined,
      '127.0.0.1',
      9000,
      {},
      'sess-sts'
    );
    expect(headers?.['Authorization']).toContain('Credential=AK/');
    expect(headers?.['X-Amz-Security-Token']).toBe('ST');
  });

  it('falls back to env credentials when --assume-role STS assume fails', async () => {
    stsSendMock.mockRejectedValue(new Error('access denied'));
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIDFALLBACK';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const headers = await buildSigV4HeadersIfRequested(
      opts({ assumeRole: 'arn:aws:iam::1:role/Agent' }),
      runtime(),
      undefined,
      '127.0.0.1',
      9000,
      {},
      'sess-fb'
    );
    expect(headers?.['Authorization']).toContain('Credential=AKIDFALLBACK/');
    expect(headers?.['X-Amz-Security-Token']).toBeUndefined();
  });

  it('errors when no region can be resolved (no --region / env / stack region)', async () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIDREGIONLESS';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const r: ResolvedAgentCoreRuntime = {
      stack: { stackName: 'App' } as never, // no region on the stack
      logicalId: 'Agent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      containerUri: 'r:t',
      environmentVariables: {},
      protocol: 'HTTP',
    };
    await expect(
      buildSigV4HeadersIfRequested(opts({ region: undefined }), r, undefined, '127.0.0.1', 9000, {}, 's')
    ).rejects.toThrow(/no region resolved/);
  });

  it('prefers --region over --stack-region in the SigV4 credential scope', async () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIDPRIO';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const headers = await buildSigV4HeadersIfRequested(
      opts({ region: 'ap-northeast-1', stackRegion: 'eu-central-1' }),
      runtime(),
      undefined,
      '127.0.0.1',
      9000,
      {},
      'sess'
    );
    expect(headers?.['Authorization']).toContain('/ap-northeast-1/bedrock-agentcore/aws4_request');
  });
});

describe('parseTimeoutMs', () => {
  it('accepts a positive integer string', () => {
    expect(parseTimeoutMs('1')).toBe(1);
    expect(parseTimeoutMs('120000')).toBe(120000);
    expect(parseTimeoutMs('600000')).toBe(600000);
  });

  it('rejects zero', () => {
    expect(() => parseTimeoutMs('0')).toThrowError(
      /--timeout must be a positive integer/
    );
  });

  it('rejects a negative integer', () => {
    expect(() => parseTimeoutMs('-1')).toThrowError(
      /--timeout must be a positive integer/
    );
  });

  it('rejects a non-integer numeric', () => {
    expect(() => parseTimeoutMs('1.5')).toThrowError(
      /--timeout must be a positive integer/
    );
  });

  it('rejects a non-numeric string', () => {
    expect(() => parseTimeoutMs('abc')).toThrowError(
      /--timeout must be a positive integer/
    );
  });

  it('rejects an empty string', () => {
    expect(() => parseTimeoutMs('')).toThrowError(
      /--timeout must be a positive integer/
    );
  });
});
