import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  getEmbedConfig,
  resetEmbedConfig,
  setEmbedConfig,
} from '../../../src/local/embed-config.js';
import { resolveRuntimeImage } from '../../../src/local/runtime-image.js';
import {
  getContainerAwsCredentialsPath,
  writeProfileCredentialsFile,
} from '../../../src/cli/commands/local-profile-credentials-file.js';
import { resolveApp } from '../../../src/cli/config-loader.js';

// The embed config is a module-level singleton; reset after every test so
// one test's override never leaks into the next.
afterEach(() => {
  resetEmbedConfig();
});

describe('embed-config', () => {
  it('defaults to cdk-local branding before any setEmbedConfig call', () => {
    expect(getEmbedConfig()).toEqual({
      cliName: 'cdkl',
      binaryName: 'cdkl',
      productName: 'cdk-local',
      resourceNamePrefix: 'cdkl',
      awsBindMountPath: '/cdk-local-aws',
      envPrefix: 'CDKL',
    });
  });

  it('applies a full override', () => {
    setEmbedConfig({
      cliName: 'cdkd local',
      binaryName: 'cdkd',
      productName: 'cdkd',
      resourceNamePrefix: 'cdkd-local',
      awsBindMountPath: '/cdkd-aws',
      envPrefix: 'CDKD',
    });
    expect(getEmbedConfig()).toEqual({
      cliName: 'cdkd local',
      binaryName: 'cdkd',
      productName: 'cdkd',
      resourceNamePrefix: 'cdkd-local',
      awsBindMountPath: '/cdkd-aws',
      envPrefix: 'CDKD',
    });
  });

  it('fills unspecified fields with defaults on a partial override', () => {
    setEmbedConfig({ resourceNamePrefix: 'cdkd-local' });
    expect(getEmbedConfig()).toEqual({
      cliName: 'cdkl',
      binaryName: 'cdkl',
      productName: 'cdk-local',
      resourceNamePrefix: 'cdkd-local',
      awsBindMountPath: '/cdk-local-aws',
      envPrefix: 'CDKL',
    });
  });

  it('treats setEmbedConfig(undefined) as a reset to defaults', () => {
    setEmbedConfig({ cliName: 'cdkd local' });
    setEmbedConfig(undefined);
    expect(getEmbedConfig().cliName).toBe('cdkl');
  });

  it('is idempotent — re-setting the same override is a no-op', () => {
    const override = { binaryName: 'cdkd' };
    setEmbedConfig(override);
    const first = getEmbedConfig();
    setEmbedConfig(override);
    expect(getEmbedConfig()).toEqual(first);
  });

  it('resetEmbedConfig restores defaults', () => {
    setEmbedConfig({ productName: 'cdkd' });
    resetEmbedConfig();
    expect(getEmbedConfig().productName).toBe('cdk-local');
  });
});

describe('embed-config threading into branded sites', () => {
  it('cliName flows into runtime-image error messages', () => {
    expect(() => resolveRuntimeImage('bogus-runtime')).toThrow(/cdkl invoke supports/);
    setEmbedConfig({ cliName: 'cdkd local' });
    expect(() => resolveRuntimeImage('bogus-runtime')).toThrow(/cdkd local invoke supports/);
  });

  it('awsBindMountPath flows into the container credentials path', () => {
    expect(getContainerAwsCredentialsPath()).toBe('/cdk-local-aws/credentials');
    setEmbedConfig({ awsBindMountPath: '/cdkd-aws' });
    expect(getContainerAwsCredentialsPath()).toBe('/cdkd-aws/credentials');
  });

  it('productName flows into the profile-credentials tmpdir prefix', async () => {
    setEmbedConfig({ productName: 'cdkd' });
    const file = await writeProfileCredentialsFile('dev', {
      accessKeyId: 'AKIA-EXAMPLE',
      secretAccessKey: 'SECRET-EXAMPLE',
    });
    try {
      expect(file.hostPath).toContain('cdkd-profile-creds-');
      expect(file.hostPath).not.toContain('cdk-local-profile-creds-');
    } finally {
      await file.dispose();
    }
  });

  it('envPrefix flows into the --app env-var fallback that resolveApp reads', () => {
    const saved = { app: process.env['CDKL_APP'], cdkd: process.env['CDKD_APP'] };
    try {
      delete process.env['CDKL_APP'];
      process.env['CDKD_APP'] = 'node cdkd-app.ts';
      // Default prefix reads CDKL_APP (unset) — falls through to cdk.json.
      expect(resolveApp(undefined)).not.toBe('node cdkd-app.ts');
      // CDKD prefix reads CDKD_APP.
      setEmbedConfig({ envPrefix: 'CDKD' });
      expect(resolveApp(undefined)).toBe('node cdkd-app.ts');
    } finally {
      if (saved.app === undefined) delete process.env['CDKL_APP'];
      else process.env['CDKL_APP'] = saved.app;
      if (saved.cdkd === undefined) delete process.env['CDKD_APP'];
      else process.env['CDKD_APP'] = saved.cdkd;
    }
  });
});
