import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdk-local#761 (S3): an assembly-chosen identifier renders bare when
// plain and as ONE JSON string literal when it could forge a boundary. Expected
// strings are hand-written, never computed through the display helper.

const { loadManifestMock, getFileAssetsMock } = vi.hoisted(() => ({
  loadManifestMock: vi.fn(),
  getFileAssetsMock: vi.fn(),
}));

vi.mock('../../../src/assets/asset-manifest-loader.js', async (importActual) => ({
  ...(await importActual<object>()),
  AssetManifestLoader: class {
    async loadStackManifest(): Promise<unknown> {
      return loadManifestMock();
    }
    getFileAssets(manifest: unknown): unknown {
      return getFileAssetsMock(manifest);
    }
  },
}));

const { resolveAgentCoreImage, resolveInboundAuthorization } = await import(
  '../../../src/cli/commands/local-invoke-agentcore.js'
);
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';

function runtime(logicalId: string, over: Partial<ResolvedAgentCoreRuntime> = {}) {
  return {
    stack: { stackName: 'App', assetManifestPath: '/cdk.out/App.assets.json' } as never,
    logicalId,
    resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    environmentVariables: {},
    protocol: 'HTTP',
    ...over,
  } as ResolvedAgentCoreRuntime;
}

const imageOpts = { platform: 'linux/arm64', pull: true, build: true } as never;

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a rejection');
}

describe('invoke-agentcore renders runtime logical id and asset hash (#761)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadManifestMock.mockResolvedValue({ files: {} });
    getFileAssetsMock.mockReturnValue(new Map());
  });

  it('code bundle not found: plain values bare', async () => {
    const msg = await messageOf(
      resolveAgentCoreImage(
        runtime('ChatAgent', {
          codeArtifact: { runtime: 'PYTHON_3_13', entryPoint: ['a.py'], codeAssetHash: 'h123' },
        }),
        imageOpts
      )
    );
    expect(msg).toContain('AgentCore Runtime ChatAgent code bundle (asset h123) was not found ');
  });

  it('code bundle not found: forging values as JSON literals', async () => {
    const msg = await messageOf(
      resolveAgentCoreImage(
        runtime("Chat' Agent\u001b[2K", {
          codeArtifact: { runtime: 'PYTHON_3_13', entryPoint: ['a.py'], codeAssetHash: "h' 1\nx" },
        }),
        imageOpts
      )
    );
    expect(msg).toContain(`AgentCore Runtime "Chat' Agent [2K" code bundle (asset "h' 1 x") was not found `);
  });

  it('neither artifact: plain and forging', async () => {
    const plain = await messageOf(resolveAgentCoreImage(runtime('ChatAgent'), imageOpts));
    expect(plain).toBe('AgentCore Runtime ChatAgent has neither a container image nor a code artifact to run.');
    const forged = await messageOf(resolveAgentCoreImage(runtime("A' b"), imageOpts));
    expect(forged).toBe(`AgentCore Runtime "A' b" has neither a container image nor a code artifact to run.`);
  });

  it('inbound JWT required: plain and forging', async () => {
    const jwt = { discoveryUrl: 'https://x/.well-known/openid-configuration' };
    const plain = await messageOf(
      resolveInboundAuthorization(runtime('ChatAgent', { jwtAuthorizer: jwt } as never), {
        verifyAuth: true,
      })
    );
    expect(plain).toContain('Runtime ChatAgent requires an inbound JWT (customJwtAuthorizer). ');
    const forged = await messageOf(
      resolveInboundAuthorization(runtime("A' b", { jwtAuthorizer: jwt } as never), { verifyAuth: true })
    );
    expect(forged).toContain(`Runtime "A' b" requires an inbound JWT (customJwtAuthorizer). `);
  });
});
