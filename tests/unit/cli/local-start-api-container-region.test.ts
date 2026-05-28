import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import {
  resolveContainerFallbackRegion,
  resolveProfileCredentials,
} from '../../../src/cli/commands/local-start-api.js';

// A `--profile`-fronted Lambda container used to boot with the profile's
// credentials but NO region: the synthesized credentials file we mount
// carries only the credential triple (no `region =`), and the
// synth-derived stack region was only ever used host-side for the
// --from-cfn-stack CFn client. The result was a handler's ambient-region
// SDK call (`new XxxClient({})`) failing with "Region is missing" locally
// while succeeding when deployed. These tests pin the two pieces that
// close that gap: the region precedence helper and the profile-region
// resolution added to `resolveProfileCredentials`.

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

describe('resolveContainerFallbackRegion', () => {
  it('prefers --stack-region over the synth and profile regions', () => {
    expect(
      resolveContainerFallbackRegion({
        stackRegionOverride: 'eu-west-1',
        synthRegion: 'us-east-1',
        profileRegion: 'ap-northeast-1',
      })
    ).toBe('eu-west-1');
  });

  it('falls back to the synth-derived stack region when --stack-region is unset', () => {
    expect(
      resolveContainerFallbackRegion({
        synthRegion: 'us-east-1',
        profileRegion: 'ap-northeast-1',
      })
    ).toBe('us-east-1');
  });

  it('falls back to the profile region for a region-agnostic stack with no --stack-region', () => {
    expect(resolveContainerFallbackRegion({ profileRegion: 'ap-northeast-1' })).toBe(
      'ap-northeast-1'
    );
  });

  it('returns undefined when no region source is known', () => {
    expect(resolveContainerFallbackRegion({})).toBeUndefined();
  });
});

describe('resolveProfileCredentials region resolution', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    regionProviderMock.mockReset();
    stsDestroyMock.mockReset();
    stsCtorMock.mockReset();
  });

  it('returns the profile-configured region alongside the credentials', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
    });
    regionProviderMock.mockResolvedValue('ap-northeast-1');
    const result = await resolveProfileCredentials('dev');
    expect(result).toEqual({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      region: 'ap-northeast-1',
    });
    expect(stsCtorMock).toHaveBeenCalledWith({ profile: 'dev' });
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('omits region when the profile has none (region provider throws "Region is missing")', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    regionProviderMock.mockRejectedValue(new Error('Region is missing'));
    const result = await resolveProfileCredentials('dev');
    expect(result).toEqual({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    expect(result).not.toHaveProperty('region');
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('omits region when the region provider resolves an empty string', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
    });
    regionProviderMock.mockResolvedValue('');
    const result = await resolveProfileCredentials('dev');
    expect(result).not.toHaveProperty('region');
  });

  it('still throws when credentials cannot be resolved (the region path does not mask it)', async () => {
    credsProviderMock.mockResolvedValue({});
    await expect(resolveProfileCredentials('dev')).rejects.toThrow(
      /resolved without usable credentials/
    );
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });
});
