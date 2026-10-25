import { describe, expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import {
  buildWebFunctionStartCommand,
  resolveWebFunctionRuntime,
  supportedWebFunctionRuntimes,
} from '../../../src/local/web-function-runtime.js';

describe('web function runtime table', () => {
  it('maps nodejs24.x to the Lambda Node 24 base image, arm64 first', () => {
    const spec = resolveWebFunctionRuntime('nodejs24.x');
    expect(spec.baseImage).toBe('public.ecr.aws/lambda/nodejs:24');
    expect(spec.interpreter).toBe('/var/lang/bin/node');
    expect(spec.codeMountPath).toBe('/var/task');
    expect(spec.entrypointEnv).toBe('AWS_LAMBDA_NODEJS_ENTRYPOINT');
    expect(spec.defaultEntrypoint).toBe('index.js');
    expect(spec.architectures[0]).toBe('arm64');
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
});

describe('buildWebFunctionStartCommand', () => {
  const spec = resolveWebFunctionRuntime('nodejs24.x');
  const codeDir = '/work/cdk.out/asset.abc';
  const exists = (want: string) => (p: string) => p === join(codeDir, want);

  it('runs index.js from the package root by default, bypassing the RIE entrypoint', () => {
    const start = buildWebFunctionStartCommand(spec, codeDir, {}, exists('index.js'));
    expect(start).toEqual({
      entryPoint: ['/var/lang/bin/node'],
      cmd: ['/var/task/index.js'],
      entryFile: 'index.js',
    });
  });

  it('honours AWS_LAMBDA_NODEJS_ENTRYPOINT from the container env', () => {
    const start = buildWebFunctionStartCommand(
      spec,
      codeDir,
      { AWS_LAMBDA_NODEJS_ENTRYPOINT: 'dist/server.js' },
      exists('dist/server.js')
    );
    expect(start.cmd).toEqual(['/var/task/dist/server.js']);
    expect(start.entryFile).toBe('dist/server.js');
  });

  it('fails before boot when the entry file is missing, naming the env var', () => {
    expect(() => buildWebFunctionStartCommand(spec, codeDir, {}, () => false)).toThrow(
      /entry file index\.js was not found.*unless AWS_LAMBDA_NODEJS_ENTRYPOINT names another file/
    );
  });

  it('refuses an entry outside the bundle', () => {
    for (const entry of ['../secret.js', '/etc/passwd', '.']) {
      expect(() =>
        buildWebFunctionStartCommand(
          spec,
          codeDir,
          { AWS_LAMBDA_NODEJS_ENTRYPOINT: entry },
          () => true
        )
      ).toThrow(/must name a file inside the code bundle/);
    }
  });
});
