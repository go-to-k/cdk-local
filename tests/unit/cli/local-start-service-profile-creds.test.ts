import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import {
  resetWorkloadAwsWiringForTest,
  setActiveWorkloadAwsWiring,
} from '../../../src/local/workload-aws-wiring.js';
import { resolveSharedSidecarCredentials } from '../../../src/cli/commands/local-start-service.js';

// cdkd#658: `cdkl start-service --profile <p>` used to resolve the
// profile for cdk-local's OWN AWS calls but the AWS-published shared
// `amazon-ecs-local-container-endpoints` sidecar (one per CLI
// invocation) started with empty `AWS_*` env, so every replica's
// containers hit `169.254.171.2/role/<role>` and got credential-provider
// failures. This test exercises the small
// `resolveSharedSidecarCredentials` helper that drives the new
// precedence: the per-CLI sidecar has no concept of `--assume-task-role`
// (that flag is per-container via `buildMetadataEnv`), so this is the
// simpler of the two siblings — `--profile` set → resolve, else
// undefined.

const credsProviderMock = vi.fn();
const stsDestroyMock = vi.fn();
const stsCtorMock = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation((config: unknown) => {
    stsCtorMock(config);
    return {
      config: { credentials: credsProviderMock },
      destroy: stsDestroyMock,
    };
  }),
}));

const defaultChainMock = vi.fn();
vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: vi.fn(() => defaultChainMock),
}));


describe('resolveSharedSidecarCredentials (cdkd#658)', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    stsDestroyMock.mockReset();
    stsCtorMock.mockReset();
    defaultChainMock.mockReset();
    resetWorkloadAwsWiringForTest();
  });

  it('resolves --profile via the SDK default chain when set', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    const result = await resolveSharedSidecarCredentials({ profile: 'my-sso' });
    expect(result).toEqual({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    // STSClient instantiated with the profile so SSO / fromIni resolve.
    expect(stsCtorMock).toHaveBeenCalledWith({ profile: 'my-sso' });
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('omits sessionToken when the profile resolved to long-lived creds', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-LONG',
      secretAccessKey: 'SECRET-LONG',
    });
    const result = await resolveSharedSidecarCredentials({ profile: 'long-lived' });
    expect(result).toEqual({
      accessKeyId: 'AKIA-LONG',
      secretAccessKey: 'SECRET-LONG',
    });
    expect(result).not.toHaveProperty('sessionToken');
  });

  it('falls back to the host default credential chain when no credential flag is set (cdkd#6129)', async () => {
    defaultChainMock.mockResolvedValue({ accessKeyId: 'AKIA-CHAIN', secretAccessKey: 'SECRET-CHAIN' });
    const result = await resolveSharedSidecarCredentials({});
    expect(result).toEqual({ accessKeyId: 'AKIA-CHAIN', secretAccessKey: 'SECRET-CHAIN' });
    expect(stsCtorMock).not.toHaveBeenCalled();
  });

  it('returns undefined when the host default chain finds nothing', async () => {
    defaultChainMock.mockRejectedValue(new Error('Could not load credentials from any providers'));
    const result = await resolveSharedSidecarCredentials({});
    expect(result).toBeUndefined();
  });

  it('returns only the emulator credentials under --aws-emulator', async () => {
    const emulatorCredentials = { accessKeyId: 'EMULATOR0000', secretAccessKey: 'EMU-SECRET' };
    setActiveWorkloadAwsWiring({
      mode: 'emulator',
      env: {},
      scrubEnvKeys: [],
      mounts: [],
      loopbackPorts: [],
      probeHealth: false,
      emulatorCredentials,
      dispose: () => undefined,
    });
    const result = await resolveSharedSidecarCredentials({});
    expect(result).toBe(emulatorCredentials);
    expect(defaultChainMock).not.toHaveBeenCalled();
  });


  it('propagates resolveProfileCredentials errors (expired SSO etc.) — no silent fallback', async () => {
    credsProviderMock.mockRejectedValue(
      new Error('The SSO session associated with this profile has expired')
    );
    await expect(
      resolveSharedSidecarCredentials({ profile: 'expired-sso' })
    ).rejects.toThrow(/SSO session.*expired/);
  });
});
