import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Covers the `actualTag !== tag` re-tag branch of `buildContainerImage`
// (the `invoke` local container-Lambda build). In `executable` source mode
// the user script returns its own image tag on stdout; the builder then
// re-tags it to the deterministic `<resourceNamePrefix>-invoke-<hash>` tag so
// downstream `docker run` / `--no-build` cache reuse keep working unchanged.
// Ported from the consuming host (cdkd) alongside the docker-image-builder
// shim; the host's copy was deleted (cdk-local owns the impl, owns the test).

const { mockBuildDockerImage, mockRunDocker } = vi.hoisted(() => ({
  mockBuildDockerImage: vi.fn(),
  mockRunDocker: vi.fn(),
}));

// Mock the build path so we can control `actualTag` per-test.
vi.mock('../../../src/assets/docker-build.js', () => ({
  buildDockerImage: mockBuildDockerImage,
}));

// Mock the docker-cmd helper so the re-tag `docker tag <actualTag> <tag>`
// call lands in a captured mock instead of real docker.
vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    runDockerStreaming: mockRunDocker,
  };
});

// Silence the logger so tests don't dump WARN lines.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLevel: () => 'info',
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      getLevel: () => 'info',
    }),
  }),
}));

beforeEach(() => {
  mockBuildDockerImage.mockReset();
  mockRunDocker.mockReset();
  mockRunDocker.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('docker-image-builder: executable source re-tag', () => {
  it('re-tags the executable-built image to the deterministic local tag', async () => {
    // Executable mode: script returned its own tag on stdout.
    mockBuildDockerImage.mockResolvedValueOnce('user-script-image:v1');
    const { buildContainerImage } = await import('../../../src/local/docker-image-builder.js');
    const tag = await buildContainerImage(
      { source: { executable: ['./build.sh'] } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    expect(tag).toMatch(/^cdkl-invoke-/);
    // Exactly one docker tag call with the right argv.
    const tagCall = mockRunDocker.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'tag'
    );
    expect(tagCall).toBeDefined();
    expect(tagCall![0]).toEqual(['tag', 'user-script-image:v1', tag]);
  });

  it('skips the re-tag when actualTag matches the requested tag (directory mode)', async () => {
    // The build returns the input tag verbatim — re-tag is a no-op.
    mockBuildDockerImage.mockImplementationOnce(async (_asset, _ctx, opts) => opts.tag!);
    const { buildContainerImage } = await import('../../../src/local/docker-image-builder.js');
    await buildContainerImage({ source: { directory: 'asset.x' } }, '/cdk.out', {
      architecture: 'x86_64',
    });
    const tagCall = mockRunDocker.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'tag'
    );
    expect(tagCall).toBeUndefined();
  });

  it('wraps the docker tag failure with actualTag + requested tag in the message', async () => {
    mockBuildDockerImage.mockResolvedValueOnce('user-script-image:v1');
    mockRunDocker.mockImplementationOnce(async (args: string[]) => {
      if (args[0] === 'tag') {
        const err = Object.assign(new Error('tag failed'), { stderr: 'permission denied' });
        throw err;
      }
      return { stdout: '', stderr: '' };
    });
    const { buildContainerImage } = await import('../../../src/local/docker-image-builder.js');
    await expect(
      buildContainerImage({ source: { executable: ['./build.sh'] } }, '/cdk.out', {
        architecture: 'x86_64',
      })
    ).rejects.toThrow(/re-tagging 'user-script-image:v1' → 'cdkl-invoke-/);
  });
});
