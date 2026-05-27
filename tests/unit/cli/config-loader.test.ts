import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApp } from '../../../src/cli/config-loader.js';

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
