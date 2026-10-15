import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#4967 security review: `buildDockerImage`'s `--verbose` lines
// printed the docker argv verbatim, so a CDK app's
// `DockerImageCode.fromImageAsset(dir, { buildArgs: { NPM_TOKEN: ... } })`
// put the token on the terminal under `invoke --verbose` (and under a host
// CLI whose `--verbose` now reaches cdk-local's debug level). Both debug
// lines now mask value-bearing flags; the spawned argv is unchanged.

const { mockSpawnStreaming, mockRunDockerStreaming } = vi.hoisted(() => ({
  mockSpawnStreaming: vi.fn(),
  mockRunDockerStreaming: vi.fn(),
}));

// Both docker entry points are mocked so no case spawns a real build.
vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    spawnStreaming: mockSpawnStreaming,
    runDockerStreaming: mockRunDockerStreaming,
  };
});

const { debugLines, warnLines } = vi.hoisted(() => ({
  debugLines: [] as string[],
  warnLines: [] as string[],
}));

vi.mock('../../../src/utils/logger.js', () => {
  const sink = {
    debug: (m: string) => debugLines.push(m),
    info: vi.fn(),
    warn: (m: string) => warnLines.push(m),
    error: vi.fn(),
    getLevel: () => 'debug',
    child: () => sink,
  };
  return { getLogger: () => sink };
});

const { buildDockerImage, resetManifestExecutableWarnings } = await import(
  '../../../src/assets/docker-build.js'
);

const SECRET = 'npm_SENTINEL_9f3c';
const wrapError = (m: string) => new Error(m);

beforeEach(() => {
  mockSpawnStreaming.mockReset();
  mockRunDockerStreaming.mockReset();
  mockRunDockerStreaming.mockResolvedValue({ stdout: '', stderr: '' });
  mockSpawnStreaming.mockResolvedValue({ stdout: 'built:tag\n', stderr: '' });
  resetManifestExecutableWarnings();
  debugLines.length = 0;
  warnLines.length = 0;
});

describe('buildDockerImage --verbose argv redaction', () => {
  it('masks --build-arg values and cache credential params on the docker build line', async () => {
    await buildDockerImage(
      {
        source: {
          directory: '.',
          dockerBuildArgs: { NPM_TOKEN: SECRET },
          cacheTo: { type: 's3', params: { region: 'us-east-1', secret_access_key: SECRET } },
        },
      },
      '/tmp/cdk.out',
      { wrapError, tag: 't' }
    );

    // The spawned argv still carries the real value: masking is display-only.
    const spawned = mockRunDockerStreaming.mock.calls[0]?.[0] as string[];
    expect(spawned.join(' ')).toContain(`NPM_TOKEN=${SECRET}`);

    const line = debugLines.find((l) => l.includes(' build '));
    expect(line, 'the docker build debug line was not logged').toBeDefined();
    expect(line).not.toContain(SECRET);
    // The KEY survives: "which build arg" is the diagnostic.
    expect(line).toContain('--build-arg NPM_TOKEN=***');
    expect(line).toContain('type=s3');
  });

  it('masks value-bearing docker flags on the source.executable line', async () => {
    await buildDockerImage(
      { source: { executable: ['./build.sh', '--build-arg', `NPM_TOKEN=${SECRET}`] } },
      '/tmp/cdk.out',
      { wrapError }
    );

    expect(mockSpawnStreaming.mock.calls[0]?.[1]).toContain(`NPM_TOKEN=${SECRET}`);
    const line = debugLines.find((l) => l.includes('Building Docker image via executable'));
    expect(line, 'the executable debug line was not logged').toBeDefined();
    expect(line).not.toContain(SECRET);
    expect(line).toContain('NPM_TOKEN=***');
    expect([...debugLines, ...warnLines].join('\n')).not.toContain(SECRET);
  });
});
