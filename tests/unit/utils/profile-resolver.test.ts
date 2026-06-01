import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';

// Issue #245: the shared profile resolver replaces the per-command copies.
// These tests pin the cred-AND-region contract the resolver returns + the
// STSClient config-builder helper every STS-touching site now consumes.

const credsProviderMock = vi.fn();
const regionProviderMock = vi.fn();
const stsDestroyMock = vi.fn();
const stsCtorMock = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation((config: unknown) => {
    stsCtorMock(config);
    return {
      config: { credentials: credsProviderMock, region: regionProviderMock },
      destroy: stsDestroyMock,
    };
  }),
}));

import {
  resolveProfileCredentials,
  buildStsClientConfig,
} from '../../../src/utils/profile-resolver.js';

describe('resolveProfileCredentials (shared)', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    regionProviderMock.mockReset();
    stsDestroyMock.mockReset();
    stsCtorMock.mockReset();
  });

  it('passes `{ profile }` to STSClient and returns the resolved triple + region', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-X',
      secretAccessKey: 'SECRET-X',
      sessionToken: 'TOKEN-X',
    });
    regionProviderMock.mockResolvedValue('ap-northeast-1');
    const result = await resolveProfileCredentials('dev');
    expect(stsCtorMock).toHaveBeenCalledWith({ profile: 'dev' });
    expect(result).toEqual({
      accessKeyId: 'AKIA-X',
      secretAccessKey: 'SECRET-X',
      sessionToken: 'TOKEN-X',
      region: 'ap-northeast-1',
    });
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('omits sessionToken when the credential provider returns none', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-LONGTERM',
      secretAccessKey: 'SECRET-LONGTERM',
    });
    regionProviderMock.mockResolvedValue('us-east-1');
    const result = await resolveProfileCredentials('long-term');
    expect(result).not.toHaveProperty('sessionToken');
    expect(result.region).toBe('us-east-1');
  });

  it('omits region when the profile has no region configured (provider throws)', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-Y',
      secretAccessKey: 'SECRET-Y',
    });
    regionProviderMock.mockRejectedValue(new Error('Region is missing'));
    const result = await resolveProfileCredentials('agnostic');
    expect(result).not.toHaveProperty('region');
  });

  it('omits region when the provider resolves an empty string', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-Z',
      secretAccessKey: 'SECRET-Z',
    });
    regionProviderMock.mockResolvedValue('');
    const result = await resolveProfileCredentials('empty-region');
    expect(result).not.toHaveProperty('region');
  });

  it('throws an actionable error when credentials cannot be resolved', async () => {
    credsProviderMock.mockResolvedValue({});
    await expect(resolveProfileCredentials('bogus')).rejects.toThrow(
      /resolved without usable credentials/
    );
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('destroys the STSClient even when the credential provider throws', async () => {
    credsProviderMock.mockRejectedValue(new Error('SSO token expired'));
    await expect(resolveProfileCredentials('expired')).rejects.toThrow(/SSO token expired/);
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });
});

describe('buildStsClientConfig', () => {
  // Issue #245: every STSClient site in the codebase MUST go through this
  // helper so a future site can never silently drop the `--profile`
  // plumbing — the historical pattern `{ ...(region && { region }) }`
  // omitted `profile` and silently used the env-shadowed default chain.

  it('emits both region and profile when both are set', () => {
    expect(buildStsClientConfig({ region: 'us-east-1', profile: 'dev' })).toEqual({
      region: 'us-east-1',
      profile: 'dev',
    });
  });

  it('omits region when undefined', () => {
    expect(buildStsClientConfig({ profile: 'dev' })).toEqual({ profile: 'dev' });
  });

  it('omits profile when undefined', () => {
    expect(buildStsClientConfig({ region: 'us-east-1' })).toEqual({ region: 'us-east-1' });
  });

  it('omits region when empty string (matches the `region && ...` shape callers used to write inline)', () => {
    expect(buildStsClientConfig({ region: '', profile: 'dev' })).toEqual({ profile: 'dev' });
  });

  it('omits profile when empty string (same falsy-skip shape)', () => {
    expect(buildStsClientConfig({ region: 'us-east-1', profile: '' })).toEqual({
      region: 'us-east-1',
    });
  });

  it('returns an empty object when both args are absent', () => {
    expect(buildStsClientConfig({})).toEqual({});
  });
});
