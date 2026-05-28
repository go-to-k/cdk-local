import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { regionProviderMock, destroyMock, StsCtorMock } = vi.hoisted(() => {
  const regionProviderMock = vi.fn();
  const destroyMock = vi.fn();
  const StsCtorMock = vi.fn().mockImplementation(() => ({
    config: { region: regionProviderMock },
    destroy: destroyMock,
  }));
  return { regionProviderMock, destroyMock, StsCtorMock };
});

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: StsCtorMock,
}));

import { resolveProfileRegion } from '../../../src/utils/profile-region.js';

describe('resolveProfileRegion', () => {
  beforeEach(() => {
    regionProviderMock.mockReset();
    destroyMock.mockReset();
    StsCtorMock.mockClear();
  });

  it('returns the SDK-resolved region for the named profile and disposes the client', async () => {
    regionProviderMock.mockResolvedValue('ap-northeast-1');

    expect(await resolveProfileRegion('dev')).toBe('ap-northeast-1');
    expect(StsCtorMock).toHaveBeenCalledWith({ profile: 'dev' });
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when no profile is given (does not construct a client)', async () => {
    expect(await resolveProfileRegion(undefined)).toBeUndefined();
    expect(StsCtorMock).not.toHaveBeenCalled();
  });

  it('returns undefined for an empty-string profile (does not construct a client)', async () => {
    expect(await resolveProfileRegion('')).toBeUndefined();
    expect(StsCtorMock).not.toHaveBeenCalled();
  });

  it('returns undefined when the region provider resolves to an empty string', async () => {
    regionProviderMock.mockResolvedValue('');
    expect(await resolveProfileRegion('dev')).toBeUndefined();
  });

  it('returns undefined (and still disposes) when the region provider rejects', async () => {
    regionProviderMock.mockRejectedValue(new Error('Region is missing'));

    expect(await resolveProfileRegion('dev')).toBeUndefined();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
