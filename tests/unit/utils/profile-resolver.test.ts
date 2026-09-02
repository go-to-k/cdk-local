import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';

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

// Reached only through the proxy fragment's `credentials` provider (issue
// go-to-k/cdk-local#648), which the proxy describe below invokes; nothing
// else in this file resolves a credential chain.
const { defaultProviderMock, chainMock } = vi.hoisted(() => {
  const chainMock = vi.fn();
  return { chainMock, defaultProviderMock: vi.fn(() => chainMock) };
});

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: defaultProviderMock,
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

describe('buildStsClientConfig — proxy environment threading (issue #634)', () => {
  // The proxy-client audit (`tests/unit/utils/aws-proxy-client-audit.test.ts`)
  // accepts `buildStsClientConfig(` in a construction's argument list AS the
  // proxy seam, so this contract — the helper spreads
  // `buildProxyClientConfig` — is what makes that acceptance sound.
  const PROXY_KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of PROXY_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    defaultProviderMock.mockClear();
    chainMock.mockReset();
  });

  afterEach(() => {
    for (const key of PROXY_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('adds requestHandler + credentials when HTTPS_PROXY is set, keeping region/profile', () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
    const config = buildStsClientConfig({ region: 'us-east-1', profile: 'dev' });
    expect(config.region).toBe('us-east-1');
    expect(config.profile).toBe('dev');
    expect(config.requestHandler).toBeDefined();
    expect(typeof config.credentials).toBe('function');
  });

  it('threads the profile INTO the fragment, so the chain resolves the named profile (issue #648)', async () => {
    // The `profile` key asserted above is INERT under a proxy: the fragment
    // supplies explicit `credentials`, and explicit credentials beat a
    // profile key in the AWS SDK. So `buildStsClientConfig({ profile })`
    // silently authenticating as the DEFAULT account is a shape the
    // key-shaped assertion cannot see — every STS site in cdk-local goes
    // through this helper, so it is the single widest instance of it.
    process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
    chainMock.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 's' });
    const config = buildStsClientConfig({ region: 'us-east-1', profile: 'dev' });
    await config.credentials!();
    expect(defaultProviderMock).toHaveBeenCalledTimes(1);
    expect(defaultProviderMock.mock.calls[0]![0]).toMatchObject({ profile: 'dev' });
  });

  it('leaves the chain profile-less when no profile is given', async () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
    chainMock.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 's' });
    const config = buildStsClientConfig({ region: 'us-east-1' });
    await config.credentials!();
    // Without the call-count assertion this passes when `defaultProvider` was
    // called with NO argument at all — `expect(undefined).not.toHaveProperty`
    // is satisfied by the absence of the whole init bag, not by the absence
    // of the key.
    expect(defaultProviderMock).toHaveBeenCalledTimes(1);
    expect(defaultProviderMock.mock.calls[0]![0]).toBeDefined();
    expect(defaultProviderMock.mock.calls[0]![0]).not.toHaveProperty('profile');
  });

  it('stays the plain { region, profile } shape when no proxy variable is set', () => {
    expect(buildStsClientConfig({ region: 'us-east-1', profile: 'dev' })).toEqual({
      region: 'us-east-1',
      profile: 'dev',
    });
  });
});
