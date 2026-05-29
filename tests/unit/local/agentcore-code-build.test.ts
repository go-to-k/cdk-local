import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const { runDockerStreamingMock, isImageInLocalCacheMock } = vi.hoisted(() => ({
  runDockerStreamingMock: vi.fn(),
  isImageInLocalCacheMock: vi.fn(),
}));

vi.mock('../../../src/utils/docker-cmd.js', async (importActual) => ({
  ...(await importActual<object>()),
  runDockerStreaming: runDockerStreamingMock,
}));
vi.mock('../../../src/local/ecr-puller.js', async (importActual) => ({
  ...(await importActual<object>()),
  isImageInLocalCache: isImageInLocalCacheMock,
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
  it('generates a Python Dockerfile with conditional pip install + interpreter CMD', () => {
    const df = renderCodeDockerfile('python:3.12-slim', ['app.py'], false);
    expect(df).toContain('FROM python:3.12-slim');
    expect(df).toContain('COPY . /app');
    expect(df).toContain('pip install --no-cache-dir -r requirements.txt');
    expect(df).toContain('pyproject.toml');
    expect(df).toContain('EXPOSE 8080');
    expect(df).toContain('CMD ["python","app.py"]');
  });

  it('generates a Node Dockerfile with npm install + node CMD', () => {
    const df = renderCodeDockerfile('node:22-slim', ['server.js'], true);
    expect(df).toContain('FROM node:22-slim');
    expect(df).toContain('npm install --omit=dev');
    expect(df).toContain('CMD ["node","server.js"]');
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
    const err = Object.assign(new Error('exit 1'), { stderr: 'pip: not found' });
    runDockerStreamingMock.mockRejectedValue(err);
    await expect(
      buildAgentCoreCodeImage({
        sourceDir: '/s',
        runtime: 'PYTHON_3_12',
        entryPoint: ['app.py'],
        architecture: 'arm64',
      })
    ).rejects.toThrow(/docker build failed.*pip: not found/);
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
