import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApp, resolveWatchConfig } from '../../../src/cli/config-loader.js';

describe('resolveApp', () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cdk-local-config-loader-'));
    originalCwd = process.cwd();
    originalEnv = process.env['CDKL_APP'];
    delete process.env['CDKL_APP'];
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['CDKL_APP'];
    } else {
      process.env['CDKL_APP'] = originalEnv;
    }
  });

  it('returns the --app CLI option when provided (wins over env + cdk.json)', () => {
    process.env['CDKL_APP'] = 'env-app';
    writeFileSync('cdk.json', JSON.stringify({ app: 'cdk-json-app' }));
    expect(resolveApp('cli-app')).toBe('cli-app');
  });

  it('falls back to CDKL_APP env var when --app is not provided (wins over cdk.json)', () => {
    process.env['CDKL_APP'] = 'env-app';
    writeFileSync('cdk.json', JSON.stringify({ app: 'cdk-json-app' }));
    expect(resolveApp(undefined)).toBe('env-app');
  });

  it('falls back to cdk.json app field when --app and CDKL_APP are not set', () => {
    writeFileSync('cdk.json', JSON.stringify({ app: 'cdk-json-app' }));
    expect(resolveApp(undefined)).toBe('cdk-json-app');
  });

  it('returns undefined when no cdk.json, no env, and no --app are present', () => {
    expect(resolveApp(undefined)).toBeUndefined();
  });

  it('returns undefined when cdk.json exists but has no app field', () => {
    writeFileSync('cdk.json', JSON.stringify({ output: 'cdk.out' }));
    expect(resolveApp(undefined)).toBeUndefined();
  });

  it('returns undefined when cdk.json contains invalid JSON (logs a warning, does not throw)', () => {
    writeFileSync('cdk.json', '{invalid');
    expect(resolveApp(undefined)).toBeUndefined();
  });
});

describe('resolveWatchConfig', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cdk-local-watch-config-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to include `**` and empty exclude when no cdk.json', () => {
    expect(resolveWatchConfig()).toEqual({ include: ['**'], exclude: [] });
  });

  it('defaults when cdk.json has no watch block', () => {
    writeFileSync('cdk.json', JSON.stringify({ app: 'node bin/app.js' }));
    expect(resolveWatchConfig()).toEqual({ include: ['**'], exclude: [] });
  });

  it('reads include / exclude arrays from the watch block', () => {
    writeFileSync(
      'cdk.json',
      JSON.stringify({ watch: { include: ['src/**'], exclude: ['**/*.d.ts', 'node_modules'] } })
    );
    expect(resolveWatchConfig()).toEqual({
      include: ['src/**'],
      exclude: ['**/*.d.ts', 'node_modules'],
    });
  });

  it('normalizes a string include / exclude to a single-element array', () => {
    writeFileSync('cdk.json', JSON.stringify({ watch: { include: 'lib/**', exclude: '*.md' } }));
    expect(resolveWatchConfig()).toEqual({ include: ['lib/**'], exclude: ['*.md'] });
  });

  it('drops non-string entries from include / exclude', () => {
    writeFileSync(
      'cdk.json',
      JSON.stringify({ watch: { include: ['a', 1, null, 'b'], exclude: [true, 'x'] } })
    );
    expect(resolveWatchConfig()).toEqual({ include: ['a', 'b'], exclude: ['x'] });
  });

  it('falls back to defaults on invalid JSON (does not throw)', () => {
    writeFileSync('cdk.json', '{invalid');
    expect(resolveWatchConfig()).toEqual({ include: ['**'], exclude: [] });
  });
});
