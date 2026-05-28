import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';

const { resolveProfileRegionMock } = vi.hoisted(() => ({
  resolveProfileRegionMock: vi.fn(),
}));

vi.mock('../../../src/utils/profile-region.js', () => ({
  resolveProfileRegion: resolveProfileRegionMock,
}));

import {
  createLocalStateProvider,
  isCfnFlagPresent,
  resolveCfnStackName,
  resolveCfnRegion,
  resolveCfnFallbackRegion,
  rejectExplicitCfnStackWithMultipleStacks,
  LocalStateSourceError,
  type LocalStateSourceOptions,
  type ExtraStateProviders,
  type LocalStateProviderFactory,
} from '../../../src/cli/commands/local-state-source.js';
import { CfnLocalStateProvider } from '../../../src/local/cfn-local-state-provider.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';

const fakeExtraProvider: LocalStateProvider = {
  label: '--from-fake',
  load: vi.fn(async () => undefined),
  buildCrossStackResolver: vi.fn(async () => undefined),
  dispose: vi.fn(),
};

const fakeExtraProviders: ExtraStateProviders = {
  fromFake: (() => fakeExtraProvider) as LocalStateProviderFactory,
};

describe('resolveCfnStackName', () => {
  it('returns the explicit string value when --from-cfn-stack <name> was passed', () => {
    expect(resolveCfnStackName('explicit-cfn-name', 'MyStack')).toBe('explicit-cfn-name');
  });

  it('falls back to the cdkl stack name when --from-cfn-stack bare (boolean true) was passed', () => {
    expect(resolveCfnStackName(true, 'MyStack')).toBe('MyStack');
  });

  it('falls back to the cdkl stack name when fromCfnStack is false (defensive)', () => {
    // Commander never produces `false` from --from-cfn-stack but the helper
    // tolerates it (returns the cdkl name) so a future grammar change
    // doesn't crash.
    expect(resolveCfnStackName(false, 'MyStack')).toBe('MyStack');
  });
});

describe('resolveCfnRegion', () => {
  const ORIGINAL_AWS_REGION = process.env['AWS_REGION'];
  const ORIGINAL_AWS_DEFAULT_REGION = process.env['AWS_DEFAULT_REGION'];

  beforeEach(() => {
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });

  afterEach(() => {
    if (ORIGINAL_AWS_REGION !== undefined) process.env['AWS_REGION'] = ORIGINAL_AWS_REGION;
    else delete process.env['AWS_REGION'];
    if (ORIGINAL_AWS_DEFAULT_REGION !== undefined)
      process.env['AWS_DEFAULT_REGION'] = ORIGINAL_AWS_DEFAULT_REGION;
    else delete process.env['AWS_DEFAULT_REGION'];
  });

  it('prefers --stack-region above everything', () => {
    process.env['AWS_REGION'] = 'env-region';
    expect(
      resolveCfnRegion({ stackRegion: 'eu-west-1', region: 'us-east-1' }, 'synth-region')
    ).toBe('eu-west-1');
  });

  it('falls back to --region when --stack-region is unset', () => {
    process.env['AWS_REGION'] = 'env-region';
    expect(resolveCfnRegion({ region: 'us-east-1' }, 'synth-region')).toBe('us-east-1');
  });

  it('falls back to AWS_REGION when --stack-region and --region are unset', () => {
    process.env['AWS_REGION'] = 'env-region';
    expect(resolveCfnRegion({}, 'synth-region')).toBe('env-region');
  });

  it('falls back to AWS_DEFAULT_REGION when --stack-region / --region / AWS_REGION are unset', () => {
    process.env['AWS_DEFAULT_REGION'] = 'default-env-region';
    expect(resolveCfnRegion({}, 'synth-region')).toBe('default-env-region');
  });

  it('falls back to the synth-derived region when nothing else is set', () => {
    expect(resolveCfnRegion({}, 'synth-region')).toBe('synth-region');
  });

  it('throws LocalStateSourceError when no region signal is available at all', () => {
    expect(() => resolveCfnRegion({}, undefined)).toThrow(LocalStateSourceError);
    expect(() => resolveCfnRegion({}, undefined)).toThrow(
      /--from-cfn-stack requires a region/
    );
  });
});

describe('resolveCfnFallbackRegion', () => {
  beforeEach(() => {
    resolveProfileRegionMock.mockReset();
  });

  it('returns the synth-derived region as-is, without reading the profile', async () => {
    expect(await resolveCfnFallbackRegion({ fromCfnStack: true, profile: 'dev' }, 'us-east-1')).toBe(
      'us-east-1'
    );
    expect(resolveProfileRegionMock).not.toHaveBeenCalled();
  });

  it('returns undefined when no --from-cfn-stack flag is present (profile not read)', async () => {
    expect(await resolveCfnFallbackRegion({ profile: 'dev' }, undefined)).toBeUndefined();
    expect(resolveProfileRegionMock).not.toHaveBeenCalled();
  });

  it('falls back to the profile region when cfn flag is present and no synth region', async () => {
    resolveProfileRegionMock.mockResolvedValue('ap-northeast-1');
    expect(await resolveCfnFallbackRegion({ fromCfnStack: true, profile: 'dev' }, undefined)).toBe(
      'ap-northeast-1'
    );
    expect(resolveProfileRegionMock).toHaveBeenCalledWith('dev');
  });

  it('returns undefined when cfn flag is present but the profile has no region', async () => {
    resolveProfileRegionMock.mockResolvedValue(undefined);
    expect(
      await resolveCfnFallbackRegion({ fromCfnStack: true, profile: 'dev' }, undefined)
    ).toBeUndefined();
  });
});

describe('rejectExplicitCfnStackWithMultipleStacks', () => {
  it('throws when explicit --from-cfn-stack <name> + >1 routed stack', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: 'my-cfn-stack' }, 2)
    ).toThrow(LocalStateSourceError);
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: 'my-cfn-stack' }, 2)
    ).toThrow(/cannot be used with multiple routed stacks/);
  });

  it('permits explicit --from-cfn-stack <name> with exactly 1 routed stack', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: 'my-cfn-stack' }, 1)
    ).not.toThrow();
  });

  it('permits explicit --from-cfn-stack <name> with 0 routed stacks (no-op early exit)', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: 'my-cfn-stack' }, 0)
    ).not.toThrow();
  });

  it('permits bare --from-cfn-stack (boolean true) with multiple routed stacks', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: true }, 5)
    ).not.toThrow();
  });

  it('permits --from-cfn-stack absent (undefined) with multiple routed stacks', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: undefined }, 5)
    ).not.toThrow();
  });

  it('permits --from-cfn-stack false (defensive — commander never emits this) with multi-stack', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: false }, 5)
    ).not.toThrow();
  });
});

describe('createLocalStateProvider — mutual exclusion', () => {
  it('throws LocalStateSourceError when --from-cfn-stack and an extraStateProvider flag are both set', () => {
    const opts: LocalStateSourceOptions = {
      fromFake: true,
      fromCfnStack: 'X',
    };
    expect(() =>
      createLocalStateProvider(opts, 'X', 'us-east-1', fakeExtraProviders)
    ).toThrow(LocalStateSourceError);
    expect(() =>
      createLocalStateProvider(opts, 'X', 'us-east-1', fakeExtraProviders)
    ).toThrow(/mutually exclusive/);
  });

  it('throws when extraStateProvider + bare --from-cfn-stack (boolean true)', () => {
    const opts: LocalStateSourceOptions = {
      fromFake: true,
      fromCfnStack: true,
    };
    expect(() =>
      createLocalStateProvider(opts, 'X', 'us-east-1', fakeExtraProviders)
    ).toThrow(LocalStateSourceError);
  });

  it('throws when two extraStateProvider flags are both active', () => {
    const opts: LocalStateSourceOptions = {
      fromFake: true,
      fromAnother: true,
    };
    const providers: ExtraStateProviders = {
      fromFake: () => fakeExtraProvider,
      fromAnother: () => fakeExtraProvider,
    };
    expect(() => createLocalStateProvider(opts, 'X', 'us-east-1', providers)).toThrow(
      LocalStateSourceError
    );
    expect(() => createLocalStateProvider(opts, 'X', 'us-east-1', providers)).toThrow(
      /mutually exclusive/
    );
  });

  it('allows extraStateProvider alone (invokes its factory)', () => {
    const factory = vi.fn(() => fakeExtraProvider);
    const provider = createLocalStateProvider(
      { fromFake: true },
      'X',
      'us-east-1',
      { fromFake: factory }
    );
    expect(provider).toBe(fakeExtraProvider);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ fromFake: true }));
  });

  it('allows --from-cfn-stack alone (returns CfnLocalStateProvider)', () => {
    const provider = createLocalStateProvider(
      {
        fromCfnStack: 'MyCfnStack',
      },
      'MyStack',
      'us-east-1'
    );
    expect(provider).toBeInstanceOf(CfnLocalStateProvider);
    provider?.dispose();
  });
});

describe('createLocalStateProvider — undefined when no flag is set', () => {
  it('returns undefined when no state-source flag is set and no extraStateProviders registered', () => {
    const provider = createLocalStateProvider({}, 'X', 'us-east-1');
    expect(provider).toBeUndefined();
  });

  it('returns undefined when no flag is set even with extraStateProviders available', () => {
    const provider = createLocalStateProvider(
      { fromFake: false },
      'X',
      'us-east-1',
      fakeExtraProviders
    );
    expect(provider).toBeUndefined();
  });

  it('returns undefined when fromCfnStack=false (defensive — Commander never emits this)', () => {
    const provider = createLocalStateProvider(
      {
        fromCfnStack: false,
      },
      'X',
      undefined
    );
    expect(provider).toBeUndefined();
  });
});

describe('createLocalStateProvider — bare --from-cfn-stack uses cdkl stack name', () => {
  it('bare flag (true) → CfnLocalStateProvider labelled --from-cfn-stack', () => {
    const provider = createLocalStateProvider(
      {
        fromCfnStack: true,
      },
      'MyStack',
      'us-east-1'
    );
    expect(provider).toBeInstanceOf(CfnLocalStateProvider);
    expect(provider!.label).toBe('--from-cfn-stack');
    provider!.dispose();
  });

  it('explicit string value → CfnLocalStateProvider with the supplied name', () => {
    const provider = createLocalStateProvider(
      {
        fromCfnStack: 'explicit-cfn-name',
      },
      'MyStack',
      'us-east-1'
    );
    expect(provider).toBeInstanceOf(CfnLocalStateProvider);
    expect(provider!.label).toBe('--from-cfn-stack');
    provider!.dispose();
  });
});

describe('isCfnFlagPresent helper', () => {
  it('returns false when fromCfnStack is undefined (flag absent)', () => {
    expect(isCfnFlagPresent({ fromCfnStack: undefined })).toBe(false);
  });

  it('returns true when fromCfnStack === true (bare flag)', () => {
    expect(isCfnFlagPresent({ fromCfnStack: true })).toBe(true);
  });

  it('returns false when fromCfnStack === false (defensive; commander never emits)', () => {
    expect(isCfnFlagPresent({ fromCfnStack: false })).toBe(false);
  });

  it('returns true when fromCfnStack is a string (explicit value)', () => {
    expect(isCfnFlagPresent({ fromCfnStack: 'my-cfn-stack' })).toBe(true);
  });

  it('returns true even when fromCfnStack is the empty string', () => {
    // Empty-string is still "present" — the createLocalStateProvider
    // path rejects it explicitly with a clearer message. The helper
    // itself does not double-validate.
    expect(isCfnFlagPresent({ fromCfnStack: '' })).toBe(true);
  });
});

describe('createLocalStateProvider — empty --from-cfn-stack rejection', () => {
  it('throws LocalStateSourceError when fromCfnStack is the empty string', () => {
    expect(() =>
      createLocalStateProvider({ fromCfnStack: '' }, 'MyStack', 'us-east-1')
    ).toThrow(LocalStateSourceError);
  });

  it('surfaces a remediation message naming the drop-the-value alternative', () => {
    expect(() =>
      createLocalStateProvider({ fromCfnStack: '' }, 'MyStack', 'us-east-1')
    ).toThrow(/non-empty stack name/);
    expect(() =>
      createLocalStateProvider({ fromCfnStack: '' }, 'MyStack', 'us-east-1')
    ).toThrow(/Drop the value to use the resolved stack name/);
  });
});

describe('createLocalStateProvider — extraStateProviders dispatcher', () => {
  it('passes the full options bag through to the factory so it can read host-specific fields', () => {
    const factory = vi.fn(() => fakeExtraProvider);
    const opts: LocalStateSourceOptions = {
      fromFake: true,
      statePrefix: 'host-prefix',
      region: 'us-east-1',
      profile: 'dev',
    };
    createLocalStateProvider(opts, 'X', 'us-east-1', { fromFake: factory });
    expect(factory).toHaveBeenCalledWith(opts);
  });

  it('mutex error mentions both --from-cfn-stack and the extra flag in kebab-case', () => {
    const opts: LocalStateSourceOptions = {
      fromFake: true,
      fromCfnStack: true,
    };
    expect(() =>
      createLocalStateProvider(opts, 'X', 'us-east-1', fakeExtraProviders)
    ).toThrow(/--from-fake/);
  });

  it('ignores extraStateProviders factories whose flag is unset', () => {
    const cfnProvider = createLocalStateProvider(
      { fromCfnStack: true, fromFake: false },
      'MyStack',
      'us-east-1',
      fakeExtraProviders
    );
    expect(cfnProvider).toBeInstanceOf(CfnLocalStateProvider);
    cfnProvider?.dispose();
  });
});
