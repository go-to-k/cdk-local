import { afterEach, describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import {
  resetWorkloadAwsWiringForTest,
  setActiveWorkloadAwsWiring,
} from '../../../src/local/workload-aws-wiring.js';
import {
  containerCredentialDelivery,
  resolveSidecarCredentials,
} from '../../../src/cli/commands/local-run-task.js';

// cdkd#658: `cdkl run-task --profile <p>` (without
// `--assume-task-role`) used to resolve the profile for cdk-local's OWN
// AWS calls but the AWS-published `amazon-ecs-local-container-endpoints`
// sidecar started with empty `AWS_*` env, so every user container that
// hit `169.254.170.2/role/<role>` got a credential-provider failure.
// This test exercises the small `resolveSidecarCredentials` helper that
// drives the new precedence: assumed-creds win when set; otherwise the
// profile chain is resolved; otherwise the host's default chain
// (cdkd#6129), undefined when it finds nothing.
//
// Same gap class as cdkd#654/#655 (which shipped for `cdkl start-api`'s
// Lambda container env overlay); the helper-extraction pattern mirrors
// cdkd PR #655's `resolveProfileCredentials` test surface.

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


describe('resolveSidecarCredentials (cdkd#658)', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    stsDestroyMock.mockReset();
    stsCtorMock.mockReset();
    defaultChainMock.mockReset();
    resetWorkloadAwsWiringForTest();
  });

  it('returns the assumed credentials verbatim when --assume-task-role is effective (assume wins over --profile)', async () => {
    const assumed = {
      accessKeyId: 'AKIA-ASSUMED',
      secretAccessKey: 'SECRET-ASSUMED',
      sessionToken: 'SESSION-ASSUMED',
    };
    // Both `--profile` AND `--assume-task-role` set; assume must win.
    const result = await resolveSidecarCredentials({ profile: 'my-sso' }, assumed);
    expect(result).toBe(assumed);
    // The SDK STS client must NOT be touched on this path — the assumed
    // creds came from an earlier STS hop, the sidecar resolver is a no-op.
    expect(stsCtorMock).not.toHaveBeenCalled();
    expect(credsProviderMock).not.toHaveBeenCalled();
  });

  it('resolves --profile via the SDK default chain when --assume-task-role is NOT effective', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    const result = await resolveSidecarCredentials({ profile: 'my-sso' }, undefined);
    expect(result).toEqual({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    // STSClient instantiated with the profile so SSO / fromIni resolve.
    expect(stsCtorMock).toHaveBeenCalledWith({ profile: 'my-sso' });
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('falls back to the host default credential chain when no credential flag is set (cdkd#6129)', async () => {
    defaultChainMock.mockResolvedValue({ accessKeyId: 'AKIA-CHAIN', secretAccessKey: 'SECRET-CHAIN' });
    const result = await resolveSidecarCredentials({}, undefined);
    expect(result).toEqual({ accessKeyId: 'AKIA-CHAIN', secretAccessKey: 'SECRET-CHAIN' });
    expect(stsCtorMock).not.toHaveBeenCalled();
  });

  it('returns undefined when the host default chain finds nothing', async () => {
    defaultChainMock.mockRejectedValue(new Error('Could not load credentials from any providers'));
    const result = await resolveSidecarCredentials({}, undefined);
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
    const result = await resolveSidecarCredentials({}, undefined);
    expect(result).toBe(emulatorCredentials);
    expect(defaultChainMock).not.toHaveBeenCalled();
  });


  it('propagates resolveProfileCredentials errors (expired SSO etc.) — no silent fallback', async () => {
    credsProviderMock.mockRejectedValue(
      new Error('The SSO session associated with this profile has expired')
    );
    await expect(
      resolveSidecarCredentials({ profile: 'expired-sso' }, undefined)
    ).rejects.toThrow(/SSO session.*expired/);
  });
});

// Issue #883: without a task role, nothing advertises the sidecar's `/creds`
// route to the containers (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` is set only
// for a role, and a no-role run is not on 169.254.170.0/24), so the
// credentials reach them through the `--profile` file or, with no flag, their
// env. This pins which, or that they get none.
describe('containerCredentialDelivery (#883)', () => {
  const chain = { accessKeyId: 'AKIA-CHAIN', secretAccessKey: 'SECRET-CHAIN' };
  const assumed = { accessKeyId: 'AKIA-ASSUMED', secretAccessKey: 'SECRET-ASSUMED' };

  beforeEach(() => {
    resetWorkloadAwsWiringForTest();
  });
  afterEach(() => {
    resetWorkloadAwsWiringForTest();
  });

  it('passes the host default chain as env when no credential flag is set', () => {
    expect(containerCredentialDelivery({}, chain, undefined)).toBe('env');
  });

  it('mounts --profile credentials under the profile name', () => {
    expect(containerCredentialDelivery({ profile: 'my-sso' }, chain, undefined)).toBe(
      'profile-file'
    );
  });

  it('delivers nothing extra when a task role was assumed (the sidecar serves it)', () => {
    expect(containerCredentialDelivery({}, assumed, assumed)).toBeUndefined();
    expect(containerCredentialDelivery({ profile: 'my-sso' }, assumed, assumed)).toBeUndefined();
  });

  it('delivers nothing when no credentials were resolved', () => {
    expect(containerCredentialDelivery({}, undefined, undefined)).toBeUndefined();
  });

  it('delivers no real credentials under --aws-emulator full mode, with or without --profile', () => {
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
    expect(containerCredentialDelivery({}, emulatorCredentials, undefined)).toBeUndefined();
    expect(
      containerCredentialDelivery({ profile: 'my-sso' }, emulatorCredentials, undefined)
    ).toBeUndefined();
  });

  it('keeps the real default chain in forward (mixed-mode) wiring', () => {
    setActiveWorkloadAwsWiring({
      mode: 'forward',
      env: {},
      scrubEnvKeys: [],
      mounts: [],
      loopbackPorts: [],
      probeHealth: false,
      dispose: () => undefined,
    });
    expect(containerCredentialDelivery({}, chain, undefined)).toBe('env');
  });
});
