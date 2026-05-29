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
import { resolveRestV1Authorizer } from '../../../src/local/authorizer-resolver.js';
import { computeLocalTag } from '../../../src/local/docker-image-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

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
      sigV4StrictByDefault: false,
      sigV4OptFlag: '--strict-sigv4',
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
      sigV4StrictByDefault: true,
      sigV4OptFlag: '--allow-unverified-sigv4',
    });
    expect(getEmbedConfig()).toEqual({
      cliName: 'cdkd local',
      binaryName: 'cdkd',
      productName: 'cdkd',
      resourceNamePrefix: 'cdkd-local',
      awsBindMountPath: '/cdkd-aws',
      envPrefix: 'CDKD',
      sigV4StrictByDefault: true,
      sigV4OptFlag: '--allow-unverified-sigv4',
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
      sigV4StrictByDefault: false,
      sigV4OptFlag: '--strict-sigv4',
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

  it('resourceNamePrefix flows into generated Docker image tags', () => {
    const source = { directory: '/some/asset/dir' };
    const def = computeLocalTag(source);
    expect(def).toMatch(/^cdkl-invoke-[0-9a-f]{16}$/);

    setEmbedConfig({ resourceNamePrefix: 'cdkd-local' });
    const cdkd = computeLocalTag(source);
    expect(cdkd).toMatch(/^cdkd-local-invoke-[0-9a-f]{16}$/);
    // Same source ⇒ same hash suffix; only the prefix changes.
    expect(cdkd.slice('cdkd-local-invoke-'.length)).toBe(def.slice('cdkl-invoke-'.length));
  });

  it('binaryName flows into the synthesized Cognito user-pool placeholder ARN', () => {
    const template = {
      Resources: {
        MyAuth: {
          Type: 'AWS::ApiGateway::Authorizer',
          Properties: {
            Type: 'COGNITO_USER_POOLS',
            // Fn::GetAtt is unresolvable at synth time, so the resolver
            // synthesizes an unreachable placeholder user-pool ARN.
            ProviderARNs: [{ 'Fn::GetAtt': ['MyPool', 'Arn'] }],
          },
        },
      },
    } as unknown as CloudFormationTemplate;

    const def = resolveRestV1Authorizer('MyAuth', template, 'MyStack', 'MyStack/api');
    expect(def.userPoolArn).toContain('us-east-1_cdklplaceholder');

    setEmbedConfig({ binaryName: 'cdkd' });
    const cdkd = resolveRestV1Authorizer('MyAuth', template, 'MyStack', 'MyStack/api');
    expect(cdkd.userPoolArn).toContain('us-east-1_cdkdplaceholder');
    expect(cdkd.userPoolArn).not.toContain('cdklplaceholder');
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
