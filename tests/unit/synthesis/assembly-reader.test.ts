import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const {
  MockToolkit,
  mockFromCdkApp,
  mockFromAssemblyDirectory,
  mockSynth,
  mockDispose,
  mockAwsCliCompatible,
  MockCdkAppMultiContext,
  baseCredsSentinel,
} = vi.hoisted(() => {
  const baseCredsSentinel = { __baseCreds: true };
  const mockAwsCliCompatible = vi.fn(() => baseCredsSentinel);
  const mockDispose = vi.fn().mockResolvedValue(undefined);
  const mockSynth = vi.fn().mockResolvedValue({
    cloudAssembly: { directory: '/app/cdk.out', stacks: [], stacksRecursively: [] },
    dispose: mockDispose,
  });
  const mockFromCdkApp = vi.fn().mockResolvedValue({ __source: true });
  const mockFromAssemblyDirectory = vi.fn().mockResolvedValue({ __source: 'dir' });
  const MockToolkit = vi.fn().mockImplementation(() => ({
    fromCdkApp: mockFromCdkApp,
    fromAssemblyDirectory: mockFromAssemblyDirectory,
    synth: mockSynth,
  }));
  const MockCdkAppMultiContext = vi.fn();
  return {
    MockToolkit,
    mockFromCdkApp,
    mockFromAssemblyDirectory,
    mockSynth,
    mockDispose,
    mockAwsCliCompatible,
    MockCdkAppMultiContext,
    baseCredsSentinel,
  };
});

vi.mock('@aws-cdk/toolkit-lib', () => ({
  Toolkit: MockToolkit,
  CdkAppMultiContext: MockCdkAppMultiContext,
  BaseCredentials: { awsCliCompatible: mockAwsCliCompatible },
  // CdklIoHost extends NonInteractiveIoHost; provide a stub so the
  // subclass `extends` clause resolves under the mocked module.
  NonInteractiveIoHost: class {
    async notify(): Promise<void> {}
  },
}));

vi.mock('@aws-cdk/cloud-assembly-api', () => ({
  AssetManifestArtifact: class {},
}));

import { AssetManifestArtifact } from '@aws-cdk/cloud-assembly-api';

import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';

describe('AssemblyReader.read — toolkit SDK credential wiring', () => {
  beforeEach(() => {
    MockToolkit.mockClear();
    mockFromCdkApp.mockClear();
    mockSynth.mockClear();
    mockDispose.mockClear();
    mockAwsCliCompatible.mockClear();
  });

  it('passes profile + region into BaseCredentials.awsCliCompatible', async () => {
    await new AssemblyReader().read('node app.ts', {
      profile: 'myprof',
      region: 'ap-northeast-1',
    });

    expect(mockAwsCliCompatible).toHaveBeenCalledWith({
      profile: 'myprof',
      defaultRegion: 'ap-northeast-1',
    });
  });

  it('seeds the Toolkit sdkConfig.baseCredentials with the awsCliCompatible result', async () => {
    await new AssemblyReader().read('node app.ts', { profile: 'p' });

    expect(MockToolkit).toHaveBeenCalledTimes(1);
    const toolkitArgs = MockToolkit.mock.calls[0][0];
    expect(toolkitArgs.sdkConfig.baseCredentials).toBe(baseCredsSentinel);
  });

  it('omits defaultRegion when only profile is set', async () => {
    await new AssemblyReader().read('x', { profile: 'p' });

    expect(mockAwsCliCompatible).toHaveBeenCalledWith({ profile: 'p' });
  });

  it('omits profile when only region is set', async () => {
    await new AssemblyReader().read('x', { region: 'us-east-1' });

    expect(mockAwsCliCompatible).toHaveBeenCalledWith({ defaultRegion: 'us-east-1' });
  });

  it('calls awsCliCompatible with no profile/region keys when neither is supplied', async () => {
    await new AssemblyReader().read('x');

    expect(mockAwsCliCompatible).toHaveBeenCalledWith({});
  });

  it('still drives fromCdkApp + synth + dispose for the happy path', async () => {
    const stacks = await new AssemblyReader().read('node app.ts');

    expect(mockFromCdkApp).toHaveBeenCalledTimes(1);
    expect(mockFromCdkApp.mock.calls[0][0]).toBe('node app.ts');
    expect(mockSynth).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(stacks).toEqual([]);
  });
});

describe('AssemblyReader.readFromDirectory — pre-synth assembly', () => {
  beforeEach(() => {
    MockToolkit.mockClear();
    mockFromAssemblyDirectory.mockClear();
    mockSynth.mockClear();
    mockDispose.mockClear();
  });

  it('passes failOnMissingContext: false so an assembly with unresolved context lookups is accepted', async () => {
    await new AssemblyReader().readFromDirectory('/path/to/cdk.out');

    expect(mockFromAssemblyDirectory).toHaveBeenCalledTimes(1);
    expect(mockFromAssemblyDirectory).toHaveBeenCalledWith('/path/to/cdk.out', {
      failOnMissingContext: false,
    });
  });

  it('drives fromAssemblyDirectory + synth + dispose for the happy path', async () => {
    const stacks = await new AssemblyReader().readFromDirectory('/path/to/cdk.out');

    expect(mockSynth).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(stacks).toEqual([]);
  });
});

describe('AssemblyReader — assetOutdir is the ROOT assembly directory', () => {
  // `assetOutdir` is the CONTAINMENT BOUND every `Metadata['aws:asset:path']`
  // is judged against. It must be the APP's outdir, not the directory the
  // stack's own asset manifest sits in: `cdk synth` stages a `cdk.Stage`'s
  // assets into the app outdir while the Stage's manifest lives in
  // `cdk.out/assembly-<Stage>/`, so a Stage Lambda legitimately carries
  // `../asset.<hash>`. Bound to the manifest directory, every Stage asset is
  // refused as hand-modified — and the resolver suite cannot see that, because
  // it builds its own `StackInfo`. This is the only case that fences the
  // THREADING.
  beforeEach(() => {
    MockToolkit.mockClear();
    mockFromCdkApp.mockClear();
    mockFromAssemblyDirectory.mockClear();
    mockSynth.mockClear();
    mockDispose.mockClear();
  });

  /**
   * An app carrying a `cdk.Stage`. The Stage's stack is NOT in `stacks` — a
   * Stage is a `NestedCloudAssemblyArtifact` — so only `stacksRecursively`
   * reaches it, and its manifest sits one level below the app outdir while its
   * asset is staged INTO that outdir.
   */
  function stageAssembly(): unknown {
    const assetManifest = new AssetManifestArtifact();
    (assetManifest as unknown as { file: string }).file =
      '/app/cdk.out/assembly-MyStage/Stk.assets.json';
    const top = {
      stackName: 'TopStack',
      displayName: 'TopStack',
      id: 'TopStack',
      template: { Resources: {} },
      dependencies: [assetManifest],
      environment: {},
      // **The property real cx-api always carries, and without it the case
      // below fences nothing.** `collectStacks` maps `assembly.stacks`, which
      // here is `[top]` alone, so root and artifact directory would be the
      // same value; the mutation `stack.assembly.directory` then redded only
      // by `TypeError` on a missing key, not by producing the wrong bound.
      // Pointing it at the Stage's manifest directory is what makes the
      // mutant return `cdk.out/assembly-MyStage` — the one value the bound
      // must never be.
      assembly: { directory: '/app/cdk.out/assembly-MyStage' },
    };
    const staged = {
      stackName: 'MyStage-Stk',
      displayName: 'MyStage/Stk',
      id: 'MyStageStk',
      template: { Resources: {} },
      dependencies: [assetManifest],
      environment: {},
      assembly: { directory: '/app/cdk.out/assembly-MyStage' },
    };
    return {
      cloudAssembly: {
        directory: '/app/cdk.out',
        stacks: [top],
        stacksRecursively: [top, staged],
      },
      dispose: mockDispose,
    };
  }

  it('read() bounds every stack by the assembly root', async () => {
    mockSynth.mockResolvedValueOnce(stageAssembly());

    const stacks = await new AssemblyReader().read('node app.ts');

    expect(stacks.map((s) => s.artifactId)).toEqual(['TopStack']);
    expect(stacks[0]?.assetOutdir).toBe('/app/cdk.out');
  });

  it('readFromDirectory() does the same', async () => {
    mockSynth.mockResolvedValueOnce(stageAssembly());

    const stacks = await new AssemblyReader().readFromDirectory('/app/cdk.out');

    expect(stacks[0]?.assetOutdir).toBe('/app/cdk.out');
  });

  it('takes the ROOT directory, never the artifact\'s own assembly', async () => {
    // Reds if `collectStacks` ever reads `stack.assembly.directory`, which the
    // fixture deliberately sets to `cdk.out/assembly-MyStage` — the manifest
    // directory the bound must never be. Without that property the case was a
    // duplicate of the one above: root and artifact directory coincided, and
    // the mutation redded by `TypeError` rather than by the wrong bound.
    mockSynth.mockResolvedValueOnce(stageAssembly());

    const stacks = await new AssemblyReader().readFromDirectory('/app/cdk.out');

    expect(stacks).not.toHaveLength(0);
    for (const s of stacks) {
      expect(s.assetOutdir).toBe('/app/cdk.out');
      expect(s.assetOutdir).not.toContain('assembly-MyStage');
    }
  });

  it('bounds by the ROOT while the asset MANIFEST stays in the Stage directory', async () => {
    // The seam the whole Stage bound rests on, asserted through the real
    // reader: `assetManifestPath` is the Stage's, `assetOutdir` is the root,
    // and they must DIFFER. The fixture built that manifest path and then
    // never asserted it, so nothing made bound-vs-manifest-dir visible here.
    mockSynth.mockResolvedValueOnce(stageAssembly());

    const stacks = await new AssemblyReader().readFromDirectory('/app/cdk.out');

    expect(stacks[0]?.assetManifestPath).toBe('/app/cdk.out/assembly-MyStage/Stk.assets.json');
    expect(stacks[0]?.assetOutdir).toBe('/app/cdk.out');
  });

  it('does NOT enumerate a Stage (nested assembly) — see #746', async () => {
    // A deliberate omission rather than an oversight: `stacksRecursively`
    // would close it and would change stack enumeration for every command,
    // which `collectStacks` records. Pinned so the omission stays a decision.
    mockSynth.mockResolvedValueOnce(stageAssembly());

    const stacks = await new AssemblyReader().readFromDirectory('/app/cdk.out');

    expect(stacks.map((s) => s.artifactId)).not.toContain('MyStageStk');
  });
});
