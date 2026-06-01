import { describe, expect, it, beforeEach, vi } from 'vite-plus/test';

// Issue #245: behavioral pins that each command's STS-touching code path
// instantiates `STSClient` with `{ profile: '<value>' }` when --profile
// is plumbed. Distinct from the regression-grep audit
// (`sts-client-profile-audit.test.ts`) which checks the static shape;
// these tests exercise the runtime call to confirm the argument is
// actually threaded all the way through.
//
// Strategy: mock `@aws-sdk/client-sts` so every STSClient instantiation
// is recorded, then call each command's STS-touching helper directly
// with a profile + region. The instantiation config is asserted to
// contain `{ profile, region }` (or `{ profile }` when region is
// omitted).

const stsCtorMock = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation((config: unknown) => {
    stsCtorMock(config);
    return {
      send: vi.fn().mockResolvedValue({
        Credentials: {
          AccessKeyId: 'AKIA-PROFILE',
          SecretAccessKey: 'SECRET-PROFILE',
          SessionToken: 'TOKEN-PROFILE',
        },
        Account: '123456789012',
      }),
      config: {
        credentials: () => ({
          accessKeyId: 'AKIA-PROFILE',
          secretAccessKey: 'SECRET-PROFILE',
        }),
        region: () => 'ap-northeast-1',
      },
      destroy: vi.fn(),
    };
  }),
  AssumeRoleCommand: vi.fn().mockImplementation((args: unknown) => ({ kind: 'AssumeRole', args })),
  GetCallerIdentityCommand: vi.fn().mockImplementation(() => ({ kind: 'GetCallerIdentity' })),
}));

import { applyAgentCoreCredentialEnv } from '../../../src/cli/commands/local-invoke-agentcore.js';

describe('applyAgentCoreCredentialEnv threads --profile into STSClient (issue #245)', () => {
  beforeEach(() => {
    stsCtorMock.mockReset();
  });

  it('passes { region, profile } to STSClient when --assume-role + --profile are both set', async () => {
    const dockerEnv: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(dockerEnv, {
      assumeRoleArn: 'arn:aws:iam::123456789012:role/MyRole',
      region: 'us-east-1',
      profile: 'dev',
    });
    // The AssumeRole STSClient should carry BOTH region and profile.
    const assumeRoleCalls = stsCtorMock.mock.calls.filter(
      (c) => c[0] && typeof c[0] === 'object' && 'profile' in (c[0] as object)
    );
    expect(assumeRoleCalls.length).toBeGreaterThanOrEqual(1);
    expect(assumeRoleCalls[0]![0]).toEqual({ region: 'us-east-1', profile: 'dev' });
  });

  it('passes { region } only (no profile key) when --profile is unset', async () => {
    const dockerEnv: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(dockerEnv, {
      assumeRoleArn: 'arn:aws:iam::123456789012:role/MyRole',
      region: 'us-east-1',
    });
    expect(stsCtorMock).toHaveBeenCalledWith({ region: 'us-east-1' });
    // Defensive: no `profile` key on the config.
    const call = stsCtorMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('profile');
  });

  it('passes { profile } only (no region key) when --region is unset', async () => {
    // Capture the env-fallback path (no AWS_REGION present) so the helper
    // is forced through the profile-only branch.
    const prevRegion = process.env['AWS_REGION'];
    const prevDefault = process.env['AWS_DEFAULT_REGION'];
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    try {
      const dockerEnv: Record<string, string> = {};
      await applyAgentCoreCredentialEnv(dockerEnv, {
        assumeRoleArn: 'arn:aws:iam::123456789012:role/MyRole',
        profile: 'dev',
      });
      expect(stsCtorMock).toHaveBeenCalledWith({ profile: 'dev' });
    } finally {
      if (prevRegion !== undefined) process.env['AWS_REGION'] = prevRegion;
      if (prevDefault !== undefined) process.env['AWS_DEFAULT_REGION'] = prevDefault;
    }
  });
});
