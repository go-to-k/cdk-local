import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const {
  loadManifestMock,
  getDockerImageBySourceHashMock,
  buildContainerImageMock,
  parseEcrUriMock,
  pullEcrImageMock,
  pullImageMock,
  createLocalStateProviderMock,
  verifyJwtViaDiscoveryMock,
} = vi.hoisted(() => ({
  loadManifestMock: vi.fn(),
  getDockerImageBySourceHashMock: vi.fn(),
  buildContainerImageMock: vi.fn(),
  parseEcrUriMock: vi.fn(),
  pullEcrImageMock: vi.fn(),
  pullImageMock: vi.fn(),
  createLocalStateProviderMock: vi.fn(),
  verifyJwtViaDiscoveryMock: vi.fn(),
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
    },
    getDockerImageBySourceHash: getDockerImageBySourceHashMock,
  };
});

vi.mock('../../../src/local/docker-image-builder.js', async (importActual) => ({
  ...(await importActual<object>()),
  buildContainerImage: buildContainerImageMock,
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
  buildMcpRequest,
  buildContainerEnv,
  readEvent,
  readEnvOverridesFile,
  platformToArchitecture,
  resolveInboundAuthorization,
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

  it('substitutes a Ref env var against the deployed state and injects it', async () => {
    const fakeProvider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({
        resources: {
          MyTable: { physicalId: 'tbl-123', resourceType: 'AWS::DynamoDB::Table', properties: {} },
        },
        region: 'us-east-1',
        outputs: {},
      }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };
    createLocalStateProviderMock.mockReturnValue(fakeProvider);

    const resolved = runtime('repo:tag', {
      environmentVariables: { TABLE_NAME: { Ref: 'MyTable' } },
    });

    const dockerEnv = await buildContainerEnv(
      resolved,
      { fromCfnStack: 'App', platform: 'linux/arm64', pull: true, build: true } as never,
      undefined,
      undefined,
      undefined
    );

    expect(fakeProvider.load).toHaveBeenCalled();
    expect(fakeProvider.dispose).toHaveBeenCalled();
    expect(dockerEnv['TABLE_NAME']).toBe('tbl-123');
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
