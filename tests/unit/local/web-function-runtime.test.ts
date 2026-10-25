import { describe, expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import {
  buildNodeEntryFileStart,
  defaultWebFunctionPlatform,
  resolveWebFunctionRuntime,
  supportedWebFunctionRuntimes,
  type WebFunctionRuntimeSpec,
} from '../../../src/local/web-function-runtime.js';

describe('web function runtime table', () => {
  it('maps nodejs24.x to the Lambda Node 24 base image, arm64 first', () => {
    const spec = resolveWebFunctionRuntime('nodejs24.x');
    expect(spec.baseImage).toBe('public.ecr.aws/lambda/nodejs:24');
    expect(spec.codeMountPath).toBe('/var/task');
    expect(spec.architectures[0]).toBe('arm64');
    expect(defaultWebFunctionPlatform(spec)).toBe('linux/arm64');
  });

  it('derives the default --platform from the row, not a constant', () => {
    const x86 = { ...resolveWebFunctionRuntime('nodejs24.x'), architectures: ['x86_64'] as const };
    expect(defaultWebFunctionPlatform(x86)).toBe('linux/amd64');
  });

  it('fails on an unknown runtime naming it and the supported set', () => {
    expect(() => resolveWebFunctionRuntime('python3.13')).toThrow(
      /runtime python3\.13 is not supported by cdkl start-web-function yet\. Supported: nodejs24\.x\./
    );
  });

  it('does not resolve an inherited property name as a runtime', () => {
    expect(() => resolveWebFunctionRuntime('constructor')).toThrow(/not supported/);
  });

  it('lists the supported runtimes', () => {
    expect(supportedWebFunctionRuntimes()).toEqual(['nodejs24.x']);
  });

  it('accepts a command-style row (module / ASGI server) through buildStart alone', () => {
    // A test-only Python-shaped row: no entry FILE, a module command line.
    const python: WebFunctionRuntimeSpec = {
      runtime: 'python3.13',
      baseImage: 'public.ecr.aws/lambda/python:3.13',
      codeMountPath: '/var/task',
      architectures: ['arm64'],
      buildStart: (env) => {
        const port = (env['AWS_LAMBDA_HTTP_ENDPOINT'] ?? '').split(':')[1] ?? '8080';
        return {
          entryPoint: ['/var/lang/bin/python3', '-m'],
          cmd: ['uvicorn', 'app:app', '--host', '0.0.0.0', '--port', port],
          label: 'uvicorn app:app',
        };
      },
    };
    const table = { 'python3.13': python };
    const spec = resolveWebFunctionRuntime('python3.13', table);
    expect(supportedWebFunctionRuntimes(table)).toEqual(['python3.13']);
    expect(spec.buildStart({ AWS_LAMBDA_HTTP_ENDPOINT: '0.0.0.0:8080' }, '/code')).toEqual({
      entryPoint: ['/var/lang/bin/python3', '-m'],
      cmd: ['uvicorn', 'app:app', '--host', '0.0.0.0', '--port', '8080'],
      label: 'uvicorn app:app',
    });
  });
});

describe('the nodejs24.x row start command', () => {
  const spec = resolveWebFunctionRuntime('nodejs24.x');
  const codeDir = '/work/cdk.out/asset.abc';
  const exists = (want: string) => (p: string) => p === join(codeDir, want);

  it('runs index.js from the package root by default, bypassing the RIE entrypoint', () => {
    expect(spec.buildStart({}, codeDir, { fileExists: exists('index.js') })).toEqual({
      entryPoint: ['/var/lang/bin/node'],
      cmd: ['/var/task/index.js'],
      label: 'index.js',
    });
  });

  it('falls back to index.js when AWS_LAMBDA_NODEJS_ENTRYPOINT is empty', () => {
    const start = buildNodeEntryFileStart(
      'nodejs24.x',
      { AWS_LAMBDA_NODEJS_ENTRYPOINT: '' },
      codeDir,
      exists('index.js')
    );
    expect(start.cmd).toEqual(['/var/task/index.js']);
  });

  it('honours AWS_LAMBDA_NODEJS_ENTRYPOINT from the container env', () => {
    const start = spec.buildStart({ AWS_LAMBDA_NODEJS_ENTRYPOINT: 'dist/server.js' }, codeDir, {
      fileExists: exists('dist/server.js'),
    });
    expect(start.cmd).toEqual(['/var/task/dist/server.js']);
    expect(start.label).toBe('dist/server.js');
  });

  it('accepts a file whose name merely starts with two dots', () => {
    const start = buildNodeEntryFileStart(
      'nodejs24.x',
      { AWS_LAMBDA_NODEJS_ENTRYPOINT: '..env.js' },
      codeDir,
      exists('..env.js')
    );
    expect(start.cmd).toEqual(['/var/task/..env.js']);
  });

  it('fails before boot when the entry file is missing, naming the env var', () => {
    expect(() => spec.buildStart({}, codeDir, { fileExists: () => false })).toThrow(
      /entry file index\.js was not found.*unless AWS_LAMBDA_NODEJS_ENTRYPOINT names another file/
    );
  });

  it('refuses an entry outside the bundle', () => {
    for (const entry of ['../secret.js', '..', '/etc/passwd', '.']) {
      expect(() =>
        spec.buildStart({ AWS_LAMBDA_NODEJS_ENTRYPOINT: entry }, codeDir, {
          fileExists: () => true,
        })
      ).toThrow(/must name a file inside the code bundle/);
    }
  });
});
