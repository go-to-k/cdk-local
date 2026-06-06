import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const { runDockerStreamingMock, isImageInLocalCacheMock, warnMock } = vi.hoisted(() => ({
  runDockerStreamingMock: vi.fn(),
  isImageInLocalCacheMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../../../src/utils/docker-cmd.js', async (importActual) => ({
  ...(await importActual<object>()),
  runDockerStreaming: runDockerStreamingMock,
}));
vi.mock('../../../src/local/ecr-puller.js', async (importActual) => ({
  ...(await importActual<object>()),
  isImageInLocalCache: isImageInLocalCacheMock,
}));
vi.mock('../../../src/utils/logger.js', async (importActual) => ({
  ...(await importActual<object>()),
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  }),
}));

const {
  buildAgentCoreCodeImage,
  renderCodeDockerfile,
  toCmdArgv,
  computeCodeImageTag,
} = await import('../../../src/local/agentcore-code-build.js');

afterEach(() => {
  vi.clearAllMocks();
});

describe('toCmdArgv', () => {
  it('prepends the python interpreter for a bare .py entrypoint', () => {
    expect(toCmdArgv(['app.py'], false)).toEqual(['python', 'app.py']);
  });

  it('prepends node for a bare .js/.mjs entrypoint', () => {
    expect(toCmdArgv(['server.js'], true)).toEqual(['node', 'server.js']);
    expect(toCmdArgv(['server.mjs'], true)).toEqual(['node', 'server.mjs']);
  });

  it('runs an explicit launcher (e.g. opentelemetry-instrument) verbatim', () => {
    expect(toCmdArgv(['opentelemetry-instrument', 'main.py'], false)).toEqual([
      'opentelemetry-instrument',
      'main.py',
    ]);
  });
});

describe('renderCodeDockerfile', () => {
  it('generates a Python Dockerfile that runs the bundle as-is (NO install)', () => {
    const df = renderCodeDockerfile('python:3.12-slim', ['app.py'], false);
    expect(df).toContain('FROM python:3.12-slim');
    expect(df).toContain('COPY . /app');
    expect(df).toContain('EXPOSE 8080');
    expect(df).toContain('CMD ["python","app.py"]');
    // The managed runtime resolves vendored deps; we must NOT pip-install
    // (doing so would mask a missing-vendored-deps bundle — local pass /
    // deployed fail).
    expect(df).not.toContain('pip install');
    expect(df).not.toMatch(/\bRUN\b/);
  });

  it('generates a Node Dockerfile that runs the bundle as-is (NO install)', () => {
    const df = renderCodeDockerfile('node:22-slim', ['server.js'], true);
    expect(df).toContain('FROM node:22-slim');
    expect(df).toContain('CMD ["node","server.js"]');
    expect(df).not.toContain('npm install');
    expect(df).not.toMatch(/\bRUN\b/);
  });
});

describe('computeCodeImageTag', () => {
  it('is deterministic and carries the cdkl-agentcore-code prefix', () => {
    const a = computeCodeImageTag('/src', 'PYTHON_3_12', ['app.py'], 'FROM x');
    const b = computeCodeImageTag('/src', 'PYTHON_3_12', ['app.py'], 'FROM x');
    expect(a).toBe(b);
    expect(a).toMatch(/^cdkl-agentcore-code-[0-9a-f]{16}$/);
  });

  it('changes when the runtime / entrypoint / dockerfile changes', () => {
    const base = computeCodeImageTag('/src', 'PYTHON_3_12', ['app.py'], 'FROM x');
    expect(computeCodeImageTag('/src', 'PYTHON_3_13', ['app.py'], 'FROM x')).not.toBe(base);
    expect(computeCodeImageTag('/src', 'PYTHON_3_12', ['main.py'], 'FROM x')).not.toBe(base);
  });
});

describe('buildAgentCoreCodeImage', () => {
  it('rejects an unsupported runtime before any docker work', async () => {
    await expect(
      buildAgentCoreCodeImage({
        sourceDir: '/src',
        runtime: 'RUBY_3_3',
        entryPoint: ['app.rb'],
        architecture: 'arm64',
      })
    ).rejects.toThrow(/runtime 'RUBY_3_3' is not supported/);
    expect(runDockerStreamingMock).not.toHaveBeenCalled();
  });

  it('builds with the generated Dockerfile (-f temp) + the source dir as context', async () => {
    runDockerStreamingMock.mockResolvedValue({ stdout: '', stderr: '' });
    const tag = await buildAgentCoreCodeImage({
      sourceDir: '/abs/src',
      runtime: 'PYTHON_3_12',
      entryPoint: ['app.py'],
      architecture: 'arm64',
    });
    expect(tag).toMatch(/^cdkl-agentcore-code-[0-9a-f]{16}$/);
    expect(runDockerStreamingMock).toHaveBeenCalledTimes(1);
    const args = runDockerStreamingMock.mock.calls[0]?.[0] as string[];
    expect(args[0]).toBe('build');
    expect(args).toContain('--platform');
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/arm64');
    expect(args).toContain('--tag');
    expect(args[args.indexOf('--tag') + 1]).toBe(tag);
    expect(args).toContain('--file'); // generated Dockerfile path
    expect(args[args.length - 1]).toBe('/abs/src'); // build context = source dir
  });

  it('maps --platform linux/amd64 for x86_64', async () => {
    runDockerStreamingMock.mockResolvedValue({ stdout: '', stderr: '' });
    await buildAgentCoreCodeImage({
      sourceDir: '/s',
      runtime: 'NODE_22',
      entryPoint: ['server.js'],
      architecture: 'x86_64',
    });
    const args = runDockerStreamingMock.mock.calls[0]?.[0] as string[];
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/amd64');
  });

  it('wraps a docker build failure with the captured stderr', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: 'build error' });
    runDockerStreamingMock.mockRejectedValue(err);
    await expect(
      buildAgentCoreCodeImage({
        sourceDir: '/s',
        runtime: 'PYTHON_3_12',
        entryPoint: ['app.py'],
        architecture: 'arm64',
      })
    ).rejects.toThrow(/docker build failed.*build error/);
  });

  it('with noBuild verifies the cached tag instead of building', async () => {
    isImageInLocalCacheMock.mockResolvedValue(true);
    const tag = await buildAgentCoreCodeImage({
      sourceDir: '/s',
      runtime: 'PYTHON_3_12',
      entryPoint: ['app.py'],
      architecture: 'arm64',
      noBuild: true,
    });
    expect(runDockerStreamingMock).not.toHaveBeenCalled();
    expect(isImageInLocalCacheMock).toHaveBeenCalledWith(tag);
  });

  it('with noBuild throws when the tag is not cached', async () => {
    isImageInLocalCacheMock.mockResolvedValue(false);
    await expect(
      buildAgentCoreCodeImage({
        sourceDir: '/s',
        runtime: 'PYTHON_3_12',
        entryPoint: ['app.py'],
        architecture: 'arm64',
        noBuild: true,
      })
    ).rejects.toThrow(/not in local registry/);
  });
});

describe('warnIfDependenciesNotVendored (via buildAgentCoreCodeImage)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('warns when a Python bundle declares requirements.txt without vendored deps', async () => {
    runDockerStreamingMock.mockResolvedValue({ stdout: '', stderr: '' });
    dir = await mkdtemp(join(tmpdir(), 'cdkl-codebuild-test-'));
    await writeFile(join(dir, 'main.py'), 'print(1)');
    await writeFile(join(dir, 'requirements.txt'), 'bedrock-agentcore');
    await buildAgentCoreCodeImage({
      sourceDir: dir,
      runtime: 'PYTHON_3_12',
      entryPoint: ['main.py'],
      architecture: 'arm64',
    });
    expect(warnMock).toHaveBeenCalledTimes(1);
    const msg = warnMock.mock.calls[0]?.[0] as string;
    expect(msg).toMatch(/does not vendor/);
    expect(msg).toMatch(/ModuleNotFoundError/);
    expect(msg).toMatch(/uv pip install .*--target/);
    expect(msg).toContain('3.12'); // python-version derived from the runtime
  });

  it('does NOT warn when the Python bundle vendors its deps (a *.dist-info dir)', async () => {
    runDockerStreamingMock.mockResolvedValue({ stdout: '', stderr: '' });
    dir = await mkdtemp(join(tmpdir(), 'cdkl-codebuild-test-'));
    await writeFile(join(dir, 'main.py'), 'print(1)');
    await writeFile(join(dir, 'requirements.txt'), 'bedrock-agentcore');
    await mkdir(join(dir, 'bedrock_agentcore-1.0.0.dist-info'));
    await buildAgentCoreCodeImage({
      sourceDir: dir,
      runtime: 'PYTHON_3_12',
      entryPoint: ['main.py'],
      architecture: 'arm64',
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('does NOT warn when a Python bundle ships no dependency manifest', async () => {
    runDockerStreamingMock.mockResolvedValue({ stdout: '', stderr: '' });
    dir = await mkdtemp(join(tmpdir(), 'cdkl-codebuild-test-'));
    await writeFile(join(dir, 'main.py'), 'print(1)'); // stdlib-only, no requirements.txt
    await buildAgentCoreCodeImage({
      sourceDir: dir,
      runtime: 'PYTHON_3_12',
      entryPoint: ['main.py'],
      architecture: 'arm64',
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('does NOT warn for a comment-only requirements.txt (stdlib-only agent)', async () => {
    runDockerStreamingMock.mockResolvedValue({ stdout: '', stderr: '' });
    dir = await mkdtemp(join(tmpdir(), 'cdkl-codebuild-test-'));
    await writeFile(join(dir, 'main.py'), 'print(1)');
    await writeFile(
      join(dir, 'requirements.txt'),
      '# No third-party dependencies — stdlib only.\n# kept for documentation\n'
    );
    await buildAgentCoreCodeImage({
      sourceDir: dir,
      runtime: 'PYTHON_3_12',
      entryPoint: ['main.py'],
      architecture: 'arm64',
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('warns when a Node bundle declares package.json without node_modules', async () => {
    runDockerStreamingMock.mockResolvedValue({ stdout: '', stderr: '' });
    dir = await mkdtemp(join(tmpdir(), 'cdkl-codebuild-test-'));
    await writeFile(join(dir, 'server.js'), 'console.log(1)');
    await writeFile(join(dir, 'package.json'), '{}');
    await buildAgentCoreCodeImage({
      sourceDir: dir,
      runtime: 'NODE_22',
      entryPoint: ['server.js'],
      architecture: 'arm64',
    });
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[0] as string).toMatch(/node_modules/);
  });
});
